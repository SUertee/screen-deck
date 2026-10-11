import Foundation
import Darwin

struct ProjectHistoryMigrationResult {
    let projectID: String
    let backupURL: URL
    let taskCount: Int
    let runCount: Int
    let artifactCount: Int
    let alreadyMigrated: Bool
    let cleanupPendingURL: URL?
}

enum ProjectHistoryMigrationFailure: LocalizedError {
    case invalidSource, unsafePath, destinationExists, sourceChanged, tooLarge
    case recoveryRequired(backup: String, retired: String)
    var errorDescription: String? {
        switch self {
        case .invalidSource: return "项目不是完整且可校验的 v1 历史，未开始迁移。"
        case .unsafePath: return "历史迁移位置含链接、非普通文件或越界路径，未覆盖该位置。"
        case .destinationExists: return "项目私有历史位置已存在，未覆盖现有记录。"
        case .sourceChanged: return "迁移期间项目历史发生变化，请停止写入后重试。"
        case .tooLarge: return "项目历史超过迁移安全上限，原数据保留。"
        case let .recoveryRequired(backup, retired): return "无法自动回退外部修改；原件备份：\(backup)，暂存原目录：\(retired)。请核对后恢复，未覆盖变化内容。"
        }
    }
}

/// Explicit project-history migration. It does not change Application Support or app migration markers.
/// Call with all project-record writers stopped. v2 project identity is the final activation point.
struct ProjectHistoryMigrator {
    struct Hooks {
        var beforeSourceCommit: (() throws -> Void)?
        var afterIdentityCommit: (() throws -> Void)?
    }
    let privateRoot: URL
    var maximumFiles = 5000
    var maximumFileBytes = 64 * 1024 * 1024
    var maximumTotalBytes = 256 * 1024 * 1024
    var hooks = Hooks()

    init(privateRoot: URL = ScreenDeckPaths().root, hooks: Hooks = Hooks()) {
        self.privateRoot = privateRoot
        self.hooks = hooks
    }

    func migrate(root: URL) throws -> ProjectHistoryMigrationResult {
        // URL standardization is used only for manifest binding. Physical I/O never follows arbitrary links.
        let sourceRoot = root.standardizedFileURL
        let physicalRoot = try physicalURL(root)
        let privateRoot = try physicalURL(self.privateRoot)
        guard physicalRoot.path != "/", privateRoot.path != "/",
              physicalRoot.path != privateRoot.path,
              !privateRoot.path.hasPrefix(physicalRoot.path + "/"),
              !physicalRoot.path.hasPrefix(privateRoot.path + "/") else { throw ProjectHistoryMigrationFailure.unsafePath }
        let projectDirectory = physicalRoot.appendingPathComponent(".screendeck", isDirectory: true)
        let identityURL = projectDirectory.appendingPathComponent("project.json")
        let originalIdentity = try MigrationIO.read(identityURL, maximum: 2 * 1024 * 1024)
        guard let originalObject = try JSONSerialization.jsonObject(with: originalIdentity) as? [String: Any],
              let schema = originalObject["schema_version"] as? Int else { throw ProjectHistoryMigrationFailure.invalidSource }
        let reader = ProjectRecordReader(privateRoot: privateRoot)
        if schema == 2 {
            let identity = try ProjectIdentityStore().read(root: sourceRoot)
            let snapshot = try reader.read(root: sourceRoot)
            let namespace = try physicalURL(ProjectHistoryLocation(privateRoot: privateRoot).namespace(projectID: identity.projectID))
            let manifest = try JSONDecoder().decode(ProjectHistoryManifest.self,
                from: MigrationIO.read(namespace.appendingPathComponent("history.json"), maximum: 2 * 1024 * 1024))
            let backupURL = try physicalURL(URL(fileURLWithPath: manifest.migration.backupPath, isDirectory: true))
            try validateBackupLocation(backupURL, projectID: identity.projectID, privateRoot: privateRoot)
            try verifyBackupManifest(backupURL, projectID: identity.projectID, sourceRoot: sourceRoot.path)
            for directory in ["tasks", "runs", "artifacts"] {
                if try MigrationIO.exists(projectDirectory.appendingPathComponent(directory)) {
                    throw ProjectHistoryMigrationFailure.destinationExists
                }
            }
            let pending = projectDirectory.appendingPathComponent(".history-migration-\(backupURL.lastPathComponent)", isDirectory: true)
            return .init(projectID: identity.projectID, backupURL: backupURL,
                         taskCount: snapshot.tasks.count, runCount: snapshot.runs.count,
                         artifactCount: try artifactCount(namespace), alreadyMigrated: true,
                         cleanupPendingURL: try MigrationIO.exists(pending) ? pending : nil)
        }
        guard schema == 1 else { throw ProjectHistoryMigrationFailure.invalidSource }
        let sourceSnapshot = try reader.read(root: sourceRoot)
        let identity = ProjectIdentity(schemaVersion: 2, kind: "project", projectID: sourceSnapshot.project.projectID,
            name: sourceSnapshot.project.name, createdAt: sourceSnapshot.project.createdAt)
        let namespace = try physicalURL(ProjectHistoryLocation(privateRoot: privateRoot).namespace(projectID: identity.projectID))
        guard !(try MigrationIO.exists(namespace)) else { throw ProjectHistoryMigrationFailure.destinationExists }
        let rootSignature = try fingerprint(physicalRoot, directory: true)
        let projectSignature = try fingerprint(projectDirectory, directory: true)
        let inventory = try sourceInventory(projectDirectory)
        guard inventory.files["project.json"] == originalIdentity else { throw ProjectHistoryMigrationFailure.sourceChanged }

        let transactionID = UUID().uuidString.lowercased()
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let backupURL = privateRoot.appendingPathComponent("backups/\(identity.projectID)/\(transactionID)", isDirectory: true)
        let stage = privateRoot.appendingPathComponent(".project-history-staging-\(transactionID)", isDirectory: true)
        let stagedBackup = stage.appendingPathComponent("backup", isDirectory: true)
        let stagedNamespace = stage.appendingPathComponent("namespace", isDirectory: true)
        let retired = projectDirectory.appendingPathComponent(".history-migration-\(transactionID)", isDirectory: true)
        let lock = projectDirectory.appendingPathComponent(".project-history-migration.lock")
        guard !(try MigrationIO.exists(lock)), !(try MigrationIO.exists(retired)), !(try MigrationIO.exists(backupURL)) else {
            throw ProjectHistoryMigrationFailure.destinationExists
        }
        let lockBytes = Data(transactionID.utf8)
        try MigrationIO.writeNew(lockBytes, to: lock)
        defer { try? MigrationIO.removeFile(lock, expected: lockBytes) }
        try MigrationIO.createDirectory(stagedBackup)
        try MigrationIO.createDirectory(stagedNamespace)
        var stageFiles: [String: Data] = [:]
        var stageDirectories: Set<String> = ["backup", "namespace"]
        var namespaceFiles: [String: Data] = [:]
        let namespaceDirectories = inventory.directories.union(["tasks", "runs", "artifacts"])
        var namespacePublished = false
        var identityCommitted = false
        var retiredDirectories: [String] = []
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let v2Bytes = try encoder.encode(identity)
        var backupPublished = false
        defer {
            // Staging contains only known copies. Do not remove unexpected or changed content.
            try? removeExpectedTree(stage, expected: stageFiles, directories: stageDirectories)
        }
        do {
            for directory in inventory.directories.sorted() {
                try MigrationIO.createDirectory(stagedBackup.appendingPathComponent(directory, isDirectory: true))
                stageDirectories.insert("backup/" + directory)
            }
            for (path, data) in inventory.files.sorted(by: { $0.key < $1.key }) {
                try MigrationIO.writeNew(data, to: stagedBackup.appendingPathComponent(path))
                stageFiles["backup/" + path] = data
            }
            let backupManifest: [String: Any] = [
                "schema_version": 1, "kind": "project_history_backup", "project_id": identity.projectID,
                "source_root": sourceRoot.path, "created_at": timestamp,
                "directories": inventory.directories.sorted(),
                "files": inventory.files.sorted(by: { $0.key < $1.key }).map { path, data in
                    ["path": path, "sha256": MigrationIO.digest(data), "bytes": data.count] as [String: Any]
                }
            ]
            let backupManifestBytes = try json(backupManifest)
            try MigrationIO.writeNew(backupManifestBytes, to: stagedBackup.appendingPathComponent("backup.json"))
            stageFiles["backup/backup.json"] = backupManifestBytes
            try verifyFiles(stagedBackup, expected: inventory.files.merging(["backup.json": backupManifestBytes]) { _, new in new }, directories: inventory.directories)

            for directory in ["tasks", "runs", "artifacts"] {
                try MigrationIO.createDirectory(stagedNamespace.appendingPathComponent(directory, isDirectory: true))
                stageDirectories.insert("namespace/" + directory)
            }
            for directory in inventory.directories.sorted() {
                try MigrationIO.createDirectory(stagedNamespace.appendingPathComponent(directory, isDirectory: true))
                stageDirectories.insert("namespace/" + directory)
            }
            for (path, data) in inventory.files.sorted(by: { $0.key < $1.key }) where path != "project.json" {
                let converted: Data
                if path.hasPrefix("tasks/") || path.hasPrefix("runs/") {
                    converted = try rewrittenRecord(data, projectID: identity.projectID)
                } else { converted = data }
                try MigrationIO.writeNew(converted, to: stagedNamespace.appendingPathComponent(path))
                namespaceFiles[path] = converted
                stageFiles["namespace/" + path] = converted
            }
            let projectObject = try rewrittenObject(originalObject, projectID: identity.projectID)
            let history: [String: Any] = [
                "schema_version": 1, "kind": "project_history", "project_id": identity.projectID,
                "source_root": sourceRoot.path, "created_at": timestamp, "project": projectObject,
                "migration": ["backup_path": backupURL.standardizedFileURL.path, "migrated_at": timestamp]
            ]
            let historyBytes = try json(history)
            try MigrationIO.writeNew(historyBytes, to: stagedNamespace.appendingPathComponent("history.json"))
            namespaceFiles["history.json"] = historyBytes
            stageFiles["namespace/history.json"] = historyBytes
            _ = try reader.readPrivateNamespace(root: sourceRoot, project: identity, namespaceRoot: stagedNamespace)
            try hooks.beforeSourceCommit?()
            try verifySource(inventory, directory: projectDirectory, root: physicalRoot,
                             rootSignature: rootSignature, projectSignature: projectSignature)
            // Publish the verified original-byte backup first; it survives any later rollback.
            try publishDirectory(stagedBackup, to: backupURL)
            backupPublished = true
            stageFiles = stageFiles.filter { !$0.key.hasPrefix("backup/") }
            stageDirectories = stageDirectories.filter { $0 != "backup" && !$0.hasPrefix("backup/") }
            try verifyBackupManifest(backupURL, projectID: identity.projectID, sourceRoot: sourceRoot.path)
            try publishDirectory(stagedNamespace, to: namespace)
            namespacePublished = true
            stageFiles = stageFiles.filter { !$0.key.hasPrefix("namespace/") }
            stageDirectories = stageDirectories.filter { $0 != "namespace" && !$0.hasPrefix("namespace/") }
            try verifySource(inventory, directory: projectDirectory, root: physicalRoot,
                             rootSignature: rootSignature, projectSignature: projectSignature)
            try MigrationIO.createDirectory(retired)
            for directory in ["tasks", "runs", "artifacts"] where inventory.directories.contains(directory) {
                try moveDirectory(projectDirectory.appendingPathComponent(directory, isDirectory: true),
                                  to: retired.appendingPathComponent(directory, isDirectory: true))
                retiredDirectories.append(directory)
            }
            let retiredFiles = inventory.files.filter { $0.key != "project.json" }
            try verifyFiles(retired, expected: retiredFiles, directories: inventory.directories)
            try verifyFiles(namespace, expected: namespaceFiles, directories: namespaceDirectories)
            for directory in retiredDirectories {
                guard !(try MigrationIO.exists(projectDirectory.appendingPathComponent(directory))) else {
                    throw ProjectHistoryMigrationFailure.sourceChanged
                }
            }
            guard try sameLocation(rootSignature, at: physicalRoot), try sameLocation(projectSignature, at: projectDirectory) else {
                throw ProjectHistoryMigrationFailure.sourceChanged
            }
            try SafePrivateStorageIO.write(v2Bytes, to: identityURL, expected: originalIdentity, maximumBytes: 2 * 1024 * 1024)
            identityCommitted = true
            try hooks.afterIdentityCommit?()
            _ = try reader.read(root: sourceRoot)
            var cleanupPending: URL?
            do { try removeExpectedTree(retired, expected: retiredFiles, directories: inventory.directories) }
            catch { cleanupPending = retired }
            return .init(projectID: identity.projectID, backupURL: backupURL,
                         taskCount: sourceSnapshot.tasks.count, runCount: sourceSnapshot.runs.count,
                         artifactCount: inventory.files.keys.filter { $0.hasPrefix("artifacts/") }.count,
                         alreadyMigrated: false, cleanupPendingURL: cleanupPending)
        } catch {
            let originalError = error
            var restored = true
            if identityCommitted {
                do { try SafePrivateStorageIO.write(originalIdentity, to: identityURL, expected: v2Bytes, maximumBytes: 2 * 1024 * 1024) }
                catch { restored = false }
            }
            // Preserve an externally changed source instead of restoring over it.
            for directory in retiredDirectories.reversed() {
                do {
                    let expected = inventory.files.filter { $0.key.hasPrefix(directory + "/") }
                        .reduce(into: [String: Data]()) { result, item in result[String(item.key.dropFirst(directory.count + 1))] = item.value }
                    let expectedDirectories = Set(inventory.directories.filter { $0.hasPrefix(directory + "/") }
                        .map { String($0.dropFirst(directory.count + 1)) })
                    try verifyFiles(retired.appendingPathComponent(directory), expected: expected, directories: expectedDirectories)
                    try moveDirectory(retired.appendingPathComponent(directory, isDirectory: true),
                                      to: projectDirectory.appendingPathComponent(directory, isDirectory: true))
                } catch { restored = false }
            }
            if restored, namespacePublished {
                do { try removeExpectedTree(namespace, expected: namespaceFiles, directories: namespaceDirectories) }
                catch { restored = false }
            }
            if restored { try? MigrationIO.removeEmptyDirectory(retired) }
            if !restored {
                throw ProjectHistoryMigrationFailure.recoveryRequired(backup: backupPublished ? backupURL.path : stagedBackup.path, retired: retired.path)
            }
            throw originalError
        }
    }

    private struct Inventory {
        let files: [String: Data]
        let directories: Set<String>
        let signatures: [String: Fingerprint]
    }
    private struct Fingerprint: Equatable {
        let device: UInt64, inode: UInt64, size: Int64
        let modifiedSeconds: Int, modifiedNanos: Int, changedSeconds: Int, changedNanos: Int
    }
    private func fingerprint(_ url: URL, directory: Bool = false) throws -> Fingerprint {
        let parent = try MigrationIO.parent(url); defer { close(parent) }
        var info = stat()
        guard fstatat(parent, url.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0,
              info.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else { throw ProjectHistoryMigrationFailure.unsafePath }
        return .init(device: UInt64(info.st_dev), inode: UInt64(info.st_ino), size: info.st_size,
                     modifiedSeconds: info.st_mtimespec.tv_sec, modifiedNanos: info.st_mtimespec.tv_nsec,
                     changedSeconds: info.st_ctimespec.tv_sec, changedNanos: info.st_ctimespec.tv_nsec)
    }
    private func sameLocation(_ expected: Fingerprint, at url: URL) throws -> Bool {
        let current = try fingerprint(url, directory: true)
        return current.device == expected.device && current.inode == expected.inode
    }
    private func sourceInventory(_ directory: URL) throws -> Inventory {
        var files: [String: Data] = [:], signatures: [String: Fingerprint] = [:]
        var directories = Set<String>(), totalBytes = 0
        func collect(_ url: URL, relative: String, depth: Int) throws {
            guard depth <= 32 else { throw ProjectHistoryMigrationFailure.tooLarge }
            let signature = try fingerprint(url)
            guard signature.size >= 0, signature.size <= maximumFileBytes, files.count < maximumFiles else {
                throw ProjectHistoryMigrationFailure.tooLarge
            }
            let data = try MigrationIO.read(url, maximum: maximumFileBytes)
            guard signature == (try fingerprint(url)) else { throw ProjectHistoryMigrationFailure.sourceChanged }
            totalBytes += data.count
            guard totalBytes <= maximumTotalBytes else { throw ProjectHistoryMigrationFailure.tooLarge }
            files[relative] = data; signatures[relative] = signature
        }
        func walk(_ url: URL, relative: String, depth: Int) throws {
            guard depth <= 32, directories.count < maximumFiles else { throw ProjectHistoryMigrationFailure.tooLarge }
            _ = try fingerprint(url, directory: true); directories.insert(relative)
            for name in try MigrationIO.names(in: url) {
                let child = url.appendingPathComponent(name)
                let path = relative + "/" + name
                if try isDirectory(child) { try walk(child, relative: path, depth: depth + 1) }
                else { try collect(child, relative: path, depth: depth + 1) }
            }
        }
        try collect(directory.appendingPathComponent("project.json"), relative: "project.json", depth: 0)
        for name in ["tasks", "runs", "artifacts"] {
            let url = directory.appendingPathComponent(name, isDirectory: true)
            if try MigrationIO.exists(url) { try walk(url, relative: name, depth: 0) }
        }
        return .init(files: files, directories: directories, signatures: signatures)
    }
    private func verifySource(_ expected: Inventory, directory: URL, root: URL,
                              rootSignature: Fingerprint, projectSignature: Fingerprint) throws {
        guard try sameLocation(rootSignature, at: root), try sameLocation(projectSignature, at: directory) else {
            throw ProjectHistoryMigrationFailure.sourceChanged
        }
        let current = try sourceInventory(directory)
        guard current.directories == expected.directories, current.signatures == expected.signatures,
              current.files == expected.files else { throw ProjectHistoryMigrationFailure.sourceChanged }
    }
    private func rewrittenRecord(_ data: Data, projectID: String) throws -> Data {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ProjectHistoryMigrationFailure.invalidSource }
        return try json(rewrittenObject(object, projectID: projectID))
    }
    private func rewrittenObject(_ object: [String: Any], projectID: String) throws -> [String: Any] {
        var result = object
        if let references = object["references"] as? [[String: Any]] {
            result["references"] = try references.map { reference -> [String: Any] in
                var reference = reference
                guard let path = reference["path"] as? String else { throw ProjectHistoryMigrationFailure.invalidSource }
                if path == ".screendeck/schema/record.schema.json" {
                    reference["path"] = "Resources/Schemas/record.schema.json"
                } else {
                    for directory in ["tasks", "runs", "artifacts"] where path.hasPrefix(".screendeck/\(directory)/") {
                        let relative = String(path.dropFirst(".screendeck/".count))
                        reference["path"] = try ProjectHistoryLocation.privateReference(projectID: projectID, relativePath: relative)
                    }
                }
                return reference
            }
        }
        return result
    }
    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }
    private func verifyFiles(_ root: URL, expected: [String: Data], directories: Set<String>? = nil) throws {
        guard try filesUnder(root) == Set(expected.keys) else { throw ProjectHistoryMigrationFailure.sourceChanged }
        if let directories, try directoryPaths(root) != directories { throw ProjectHistoryMigrationFailure.sourceChanged }
        for (path, data) in expected {
            guard try MigrationIO.read(root.appendingPathComponent(path), maximum: maximumFileBytes) == data else {
                throw ProjectHistoryMigrationFailure.sourceChanged
            }
        }
    }
    private func filesUnder(_ root: URL) throws -> Set<String> {
        var result = Set<String>()
        func walk(_ directory: URL, prefix: String, depth: Int) throws {
            guard depth <= 32, result.count <= maximumFiles + 2 else { throw ProjectHistoryMigrationFailure.tooLarge }
            for name in try MigrationIO.names(in: directory) {
                let child = directory.appendingPathComponent(name)
                let relative = prefix.isEmpty ? name : prefix + "/" + name
                if try isDirectory(child) { try walk(child, prefix: relative, depth: depth + 1) }
                else { _ = try fingerprint(child); result.insert(relative) }
            }
        }
        try walk(root, prefix: "", depth: 0)
        return result
    }
    private func directoryPaths(_ root: URL) throws -> Set<String> {
        var result = Set<String>()
        func walk(_ directory: URL, prefix: String, depth: Int) throws {
            guard depth <= 32, result.count <= maximumFiles + 4 else { throw ProjectHistoryMigrationFailure.tooLarge }
            for name in try MigrationIO.names(in: directory) {
                let child = directory.appendingPathComponent(name)
                if try isDirectory(child) {
                    let relative = prefix.isEmpty ? name : prefix + "/" + name
                    result.insert(relative); try walk(child, prefix: relative, depth: depth + 1)
                }
            }
        }
        try walk(root, prefix: "", depth: 0)
        return result
    }
    private func isDirectory(_ url: URL) throws -> Bool {
        let parent = try MigrationIO.parent(url); defer { close(parent) }
        var info = stat()
        guard fstatat(parent, url.lastPathComponent, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ProjectHistoryMigrationFailure.unsafePath }
        if info.st_mode & S_IFMT == S_IFDIR { return true }
        guard info.st_mode & S_IFMT == S_IFREG else { throw ProjectHistoryMigrationFailure.unsafePath }
        return false
    }
    private func publishDirectory(_ source: URL, to destination: URL) throws {
        try MigrationIO.createDirectory(destination.deletingLastPathComponent())
        try moveDirectory(source, to: destination)
    }
    private func moveDirectory(_ source: URL, to destination: URL) throws {
        _ = try fingerprint(source, directory: true)
        let sourceParent = try MigrationIO.parent(source); defer { close(sourceParent) }
        let destinationParent = try MigrationIO.parent(destination); defer { close(destinationParent) }
        guard renameatx_np(sourceParent, source.lastPathComponent, destinationParent, destination.lastPathComponent, UInt32(RENAME_EXCL)) == 0 else {
            if errno == EEXIST { throw ProjectHistoryMigrationFailure.destinationExists }
            throw CocoaError(.fileWriteUnknown)
        }
        _ = fsync(sourceParent); _ = fsync(destinationParent)
    }
    private func removeExpectedTree(_ root: URL, expected: [String: Data], directories: Set<String>) throws {
        guard try MigrationIO.exists(root) else { return }
        try verifyFiles(root, expected: expected, directories: directories)
        for (path, data) in expected.sorted(by: { $0.key > $1.key }) {
            try MigrationIO.removeFile(root.appendingPathComponent(path), expected: data)
        }
        // Only remove the inventory's directories. Concurrent new entries make rmdir fail;
        // they must never become implicit cleanup targets after the initial verification.
        for path in directories.sorted(by: {
            let leftDepth = $0.split(separator: "/").count
            let rightDepth = $1.split(separator: "/").count
            return leftDepth == rightDepth ? $0 > $1 : leftDepth > rightDepth
        }) {
            try MigrationIO.removeEmptyDirectory(root.appendingPathComponent(path, isDirectory: true))
        }
        try MigrationIO.removeEmptyDirectory(root)
    }
    private func validateBackupLocation(_ backup: URL, projectID: String, privateRoot: URL) throws {
        let expectedParent = privateRoot.appendingPathComponent("backups/\(projectID)").path
        guard backup.deletingLastPathComponent().path == expectedParent,
              UUID(uuidString: backup.lastPathComponent) != nil else { throw ProjectHistoryMigrationFailure.unsafePath }
    }
    private func verifyBackupManifest(_ backup: URL, projectID: String, sourceRoot: String) throws {
        let bytes = try MigrationIO.read(backup.appendingPathComponent("backup.json"), maximum: 2 * 1024 * 1024)
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(object.keys) == ["schema_version", "kind", "project_id", "source_root", "created_at", "files", "directories"],
              object["schema_version"] as? Int == 1, object["kind"] as? String == "project_history_backup",
              object["project_id"] as? String == projectID, object["source_root"] as? String == sourceRoot,
              let entries = object["files"] as? [[String: Any]], !entries.isEmpty, entries.count <= maximumFiles,
              let directories = object["directories"] as? [String], directories.count <= maximumFiles,
              Set(directories).count == directories.count else {
            throw ProjectHistoryMigrationFailure.invalidSource
        }
        for directory in directories {
            let parts = directory.split(separator: "/", omittingEmptySubsequences: false)
            guard ["tasks", "runs", "artifacts"].contains(String(parts.first ?? "")),
                  !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  !directory.contains("\\"), !directory.contains("\0") else { throw ProjectHistoryMigrationFailure.invalidSource }
        }
        var paths = Set<String>()
        for entry in entries {
            guard Set(entry.keys) == ["path", "sha256", "bytes"], let path = entry["path"] as? String,
                  path == "project.json" || path.hasPrefix("tasks/") || path.hasPrefix("runs/") || path.hasPrefix("artifacts/"),
                  !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  !path.contains("\\"), !path.contains("\0"),
                  let hash = entry["sha256"] as? String, hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                  let count = entry["bytes"] as? Int, count >= 0, count <= maximumFileBytes,
                  paths.insert(path).inserted else { throw ProjectHistoryMigrationFailure.invalidSource }
            let data = try MigrationIO.read(backup.appendingPathComponent(path), maximum: maximumFileBytes)
            guard data.count == count, MigrationIO.digest(data) == hash else { throw ProjectHistoryMigrationFailure.sourceChanged }
        }
        guard paths.contains("project.json"), try filesUnder(backup) == paths.union(["backup.json"]),
              try directoryPaths(backup) == Set(directories) else {
            throw ProjectHistoryMigrationFailure.invalidSource
        }
    }
    private func artifactCount(_ namespace: URL) throws -> Int {
        try filesUnder(namespace.appendingPathComponent("artifacts", isDirectory: true)).count
    }
    private func physicalURL(_ url: URL) throws -> URL {
        guard url.isFileURL, !url.path.contains("\0"), url.path.hasPrefix("/"),
              url.host == nil || url.host == "" || url.host == "localhost" else { throw ProjectHistoryMigrationFailure.unsafePath }
        var path = url.path
        // Only the two verified macOS system aliases are canonicalized; project/user aliases remain rejected.
        for alias in ["var", "tmp"] where path == "/\(alias)" || path.hasPrefix("/\(alias)/") {
            var target = [CChar](repeating: 0, count: 128)
            guard readlink("/\(alias)", &target, target.count - 1) > 0,
                  String(cString: target) == "private/\(alias)" || String(cString: target) == "/private/\(alias)" else {
                throw ProjectHistoryMigrationFailure.unsafePath
            }
            path = "/private" + path
        }
        return URL(fileURLWithPath: path, isDirectory: true)
    }
}
