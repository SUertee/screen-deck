import Foundation
import CryptoKit
import CoreFoundation
import Darwin

struct StorageMigrationInspection {
    let isNeeded: Bool
    let isComplete: Bool
    let fileCount: Int
    let byteCount: Int
    let legacyRoot: URL
    let destinationRoot: URL
}

struct StorageMigrationResult {
    let fileCount: Int
    let byteCount: Int
    let legacyBackupURL: URL
    let destinationRoot: URL
    let alreadyComplete: Bool
}

enum StorageMigrationFailure: LocalizedError {
    case unsafePath, invalidData, tooLarge, destinationConflict, sourceChanged, inProgress, needsConfiguration
    var errorDescription: String? {
        switch self {
        case .unsafePath: return "迁移路径含链接或非普通文件，未切换存储位置。"
        case .invalidData: return "旧记录或迁移凭据损坏 / 版本不受支持，未切换存储位置。"
        case .tooLarge: return "迁移数据超过安全上限，旧数据保留。"
        case .destinationConflict: return "新位置已有记录或配置，未覆盖任何既有文件。"
        case .sourceChanged: return "旧数据在迁移期间发生变化，请停止写入后重试。"
        case .inProgress: return "发现未完成的迁移锁，请检查后再迁移。"
        case .needsConfiguration: return "旧采集偏好需要先转换为 TOML，未切换存储位置。"
        }
    }
}

private struct MigrationFile {
    let source: String
    let destination: String
    let data: Data
    var digest: String { MigrationIO.digest(data) }
}

struct StorageMigrationMarker: Codable {
    struct Entry: Codable {
        let source: String
        let destination: String
        let sha256: String
        let bytes: Int
    }
    let version: Int
    let transactionID: String
    let legacyRootPath: String
    let createdAt: String
    let files: [Entry]
}

/// Explicit copy, validate, and commit. Legacy originals are retained as the rollback backup.
/// Call only after all controllers using the legacy stores have stopped writing.
struct StorageMigration {
    private static let legacyLockNames: Set<String> = [".workspace.json.lock", ".project-associations.json.lock", ".project-conversations.json.lock"]
    let paths: ScreenDeckPaths
    var maximumJSONBytes = 2 * 1024 * 1024
    var maximumImageBytes = 16 * 1024 * 1024
    var maximumTotalBytes = 256 * 1024 * 1024
    var maximumFiles = 5000

    func inspect() throws -> StorageMigrationInspection {
        try checkRoots()
        if let marker = try Self.readMarker(paths: paths) {
            return .init(isNeeded: false, isComplete: true, fileCount: marker.files.count,
                         byteCount: marker.files.reduce(0) { $0 + $1.bytes }, legacyRoot: paths.legacyRoot, destinationRoot: paths.root)
        }
        guard try Self.hasLegacyData(paths: paths) else {
            return .init(isNeeded: false, isComplete: false, fileCount: 0, byteCount: 0,
                         legacyRoot: paths.legacyRoot, destinationRoot: paths.root)
        }
        let snapshot = try collect(transactionID: UUID().uuidString)
        return .init(isNeeded: true, isComplete: false, fileCount: snapshot.files.count,
                     byteCount: snapshot.files.reduce(0) { $0 + $1.data.count }, legacyRoot: paths.legacyRoot, destinationRoot: paths.root)
    }

    /// Configuration conversion is supplied by the TOML layer, not reimplemented here.
    /// Its URL is a private staging file. Throwing prevents all activation and legacy data remains intact.
    func migrate(prepareConfiguration: ((CapturePreferences?, URL) throws -> Void)? = nil) throws -> StorageMigrationResult {
        try checkRoots()
        if let marker = try Self.readMarker(paths: paths) {
            return .init(fileCount: marker.files.count, byteCount: marker.files.reduce(0) { $0 + $1.bytes },
                         legacyBackupURL: paths.legacyRoot, destinationRoot: paths.root, alreadyComplete: true)
        }
        guard try Self.hasLegacyData(paths: paths) else {
            return .init(fileCount: 0, byteCount: 0, legacyBackupURL: paths.legacyRoot,
                         destinationRoot: paths.root, alreadyComplete: false)
        }
        let transactionID = UUID().uuidString
        // Serialize with cooperating private-store writers without creating or changing legacy locks.
        let sourceLocks = try MigrationIO.holdExistingLocks(Self.legacyLockNames.sorted().map { paths.legacyRoot.appendingPathComponent($0) })
        defer { MigrationIO.release(sourceLocks) }
        let snapshot = try collect(transactionID: transactionID)
        let legacyWorkspace = try snapshot.files.first(where: { $0.source == "workspace.json" }).map {
            try JSONDecoder().decode(LocalWorkspace.self, from: $0.data)
        }
        if (snapshot.preferences != nil || legacyWorkspace?.defaultPinned == true) && prepareConfiguration == nil {
            throw StorageMigrationFailure.needsConfiguration
        }
        var destinations = snapshot.files.map(\.destination)
        if prepareConfiguration != nil { destinations.append("config.toml") }
        for destination in destinations {
            if try MigrationIO.exists(paths.root.appendingPathComponent(destination)) { throw StorageMigrationFailure.destinationConflict }
        }
        // These directories are store boundaries, so even empty or unknown preexisting content is a conflict.
        if snapshot.hasSessions, try MigrationIO.exists(paths.sessions) { throw StorageMigrationFailure.destinationConflict }
        try MigrationIO.createDirectory(paths.root)
        let lock = paths.root.appendingPathComponent(".storage-migration-lock")
        do { try MigrationIO.writeNew(Data(transactionID.utf8), to: lock) }
        catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST) {
            throw StorageMigrationFailure.inProgress
        }
        defer { try? MigrationIO.removeFile(lock, expected: Data(transactionID.utf8)) }
        let stage = paths.root.appendingPathComponent(".storage-migration-\(transactionID)", isDirectory: true)
        try MigrationIO.createDirectory(stage)
        var committed: [(URL, Data)] = []
        var createdDirectories: [URL] = []
        var activated = false
        defer {
            if !activated {
                // Remove only our byte-identical files. Never delete externally changed content or broad roots.
                for (url, data) in committed.reversed() { try? MigrationIO.removeFile(url, expected: data) }
                for url in createdDirectories.reversed() { try? MigrationIO.removeEmptyDirectory(url) }
            }
            try? MigrationIO.removeOwnedTree(stage)
        }
        for file in snapshot.files {
            try MigrationIO.writeNew(file.data, to: stage.appendingPathComponent(file.destination))
        }
        var files = snapshot.files
        if let prepareConfiguration {
            let stagedConfiguration = stage.appendingPathComponent("config.toml")
            try prepareConfiguration(snapshot.preferences, stagedConfiguration)
            let data = try MigrationIO.read(stagedConfiguration, maximum: ConfigurationParser.maximumBytes)
            let configuration = try ConfigurationParser.user(data)
            if let old = snapshot.preferences, configuration.capturePreferences != old {
                throw StorageMigrationFailure.needsConfiguration
            }
            if let old = legacyWorkspace, configuration.general.defaultPinned != old.defaultPinned {
                throw StorageMigrationFailure.needsConfiguration
            }
            try MigrationIO.secureFile(stagedConfiguration)
            files.append(.init(source: "configuration-conversion", destination: "config.toml", data: data))
        }
        try validateLimits(files)
        try MigrationIO.verify(sourceLocks)
        try verifySources(snapshot.files)
        // Inventory recheck detects newly created/deleted sessions or JSON files as well as modified bytes.
        let refreshed = try collect(transactionID: transactionID)
        guard refreshed.files.map(\.source) == snapshot.files.map(\.source), refreshed.preferences == snapshot.preferences else {
            throw StorageMigrationFailure.sourceChanged
        }
        for file in files {
            let destination = paths.root.appendingPathComponent(file.destination)
            try MigrationIO.createDirectory(destination.deletingLastPathComponent(), created: &createdDirectories)
            try MigrationIO.linkNew(stage.appendingPathComponent(file.destination), to: destination)
            committed.append((destination, file.data))
            guard try MigrationIO.read(destination, maximum: max(maximumImageBytes, maximumJSONBytes)) == file.data else {
                throw StorageMigrationFailure.sourceChanged
            }
        }
        try MigrationIO.verify(sourceLocks)
        try verifySources(snapshot.files)
        let marker = StorageMigrationMarker(version: 1, transactionID: transactionID,
            legacyRootPath: paths.legacyRoot.path, createdAt: ISO8601DateFormatter().string(from: Date()),
            files: files.map { .init(source: $0.source, destination: $0.destination, sha256: $0.digest, bytes: $0.data.count) })
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(marker)
        let stagedMarker = stage.appendingPathComponent("storage-migration.json")
        try MigrationIO.writeNew(data, to: stagedMarker)
        // Atomic no-replace commit is last: absence of this file keeps every store on legacy.
        try MigrationIO.linkNew(stagedMarker, to: paths.migrationMarker)
        activated = true
        return .init(fileCount: files.count, byteCount: files.reduce(0) { $0 + $1.data.count },
                     legacyBackupURL: paths.legacyRoot, destinationRoot: paths.root, alreadyComplete: false)
    }

    static func hasLegacyData(paths: ScreenDeckPaths) throws -> Bool {
        guard try MigrationIO.exists(paths.legacyRoot) else { return false }
        for name in try MigrationIO.names(in: paths.legacyRoot) where name != ".DS_Store" {
            if legacyLockNames.contains(name), try MigrationIO.read(paths.legacyRoot.appendingPathComponent(name), maximum: 1).isEmpty {
                continue
            }
            if name == "WorkSessions" {
                if !(try MigrationIO.names(in: paths.sessions(in: .legacy))).filter({ $0 != ".DS_Store" }).isEmpty { return true }
            } else { return true }
        }
        return false
    }

    static func readMarker(paths: ScreenDeckPaths) throws -> StorageMigrationMarker? {
        guard try MigrationIO.exists(paths.migrationMarker) else { return nil }
        do {
            let data = try MigrationIO.read(paths.migrationMarker, maximum: 2 * 1024 * 1024)
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["version", "transactionID", "legacyRootPath", "createdAt", "files"],
                  let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.intValue == 1 else {
                throw StorageMigrationFailure.invalidData
            }
            let marker = try JSONDecoder().decode(StorageMigrationMarker.self, from: data)
            guard marker.version == 1, UUID(uuidString: marker.transactionID) != nil,
                  marker.legacyRootPath == paths.legacyRoot.path, ISO8601DateFormatter().date(from: marker.createdAt) != nil,
                  !marker.files.isEmpty, marker.files.count <= 5000,
                  marker.files.allSatisfy({ $0.bytes >= 0 && $0.bytes <= 16 * 1024 * 1024 }),
                  marker.files.reduce(0, { $0 + max(0, $1.bytes) }) <= 256 * 1024 * 1024 else { throw StorageMigrationFailure.invalidData }
            var destinations = Set<String>()
            var sources = Set<String>()
            for file in marker.files {
                guard validRelative(file.source), validRelative(file.destination), file.bytes >= 0,
                      file.bytes <= 16 * 1024 * 1024,
                      file.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
                      sources.insert(file.source).inserted, destinations.insert(file.destination).inserted,
                      allowedMapping(file, transactionID: marker.transactionID) else { throw StorageMigrationFailure.invalidData }
                let destination = paths.root.appendingPathComponent(file.destination)
                let canonicalStores: Set<String> = ["tasks/local-workspace.json", "projects.json", "conversations/project-drafts.json", "config.toml"]
                if try canonicalStores.contains(file.destination) || MigrationIO.exists(destination) {
                    try MigrationIO.requireRegular(destination)
                }
            }
            return marker
        } catch let error as StorageMigrationFailure { throw error }
        catch { throw StorageMigrationFailure.invalidData }
    }

    private func checkRoots() throws {
        guard paths.root.path != paths.legacyRoot.path,
              !paths.root.path.hasPrefix(paths.legacyRoot.path + "/"), !paths.legacyRoot.path.hasPrefix(paths.root.path + "/") else {
            throw StorageMigrationFailure.unsafePath
        }
        _ = try MigrationIO.exists(paths.root)
        _ = try MigrationIO.exists(paths.legacyRoot)
    }

    private func collect(transactionID: String) throws -> (files: [MigrationFile], preferences: CapturePreferences?, hasSessions: Bool) {
        var files: [MigrationFile] = []
        var preferences: CapturePreferences?
        let rootNames = try MigrationIO.names(in: paths.legacyRoot)
        let known = Set(["workspace.json", "project-associations.json", "project-conversations.json", "capture-preferences.json", "WorkSessions", ".DS_Store"])
            .union(Self.legacyLockNames)
        guard Set(rootNames).isSubset(of: known) else { throw StorageMigrationFailure.invalidData }
        // Cooperating store writes retain these empty advisory lock files. They are not records or evidence.
        // Keep them in the legacy backup; arbitrary names or nonempty content remain unsupported.
        for lock in rootNames where Self.legacyLockNames.contains(lock) {
            guard try MigrationIO.read(paths.legacyRoot.appendingPathComponent(lock), maximum: 1).isEmpty else {
                throw StorageMigrationFailure.invalidData
            }
        }
        let mappings = [("workspace.json", "tasks/local-workspace.json"), ("project-associations.json", "projects.json"),
                        ("project-conversations.json", "conversations/project-drafts.json")]
        for (source, destination) in mappings where rootNames.contains(source) {
            let sourceURL = paths.legacyRoot.appendingPathComponent(source)
            let data = try MigrationIO.read(sourceURL, maximum: maximumJSONBytes)
            do {
                switch source {
                case "workspace.json": _ = try LocalWorkspaceStore(url: sourceURL).load()
                case "project-associations.json": _ = try ProjectAssociationStore(url: sourceURL).load()
                default: _ = try ProjectConversationStore(url: sourceURL).load()
                }
            } catch { throw StorageMigrationFailure.invalidData }
            guard try MigrationIO.read(sourceURL, maximum: maximumJSONBytes) == data else { throw StorageMigrationFailure.sourceChanged }
            files.append(.init(source: source, destination: destination, data: data))
        }
        let sessionRoot = paths.sessions(in: .legacy)
        let hasSessions = rootNames.contains("WorkSessions")
        let sessionNames = hasSessions ? try MigrationIO.names(in: sessionRoot) : []
        guard sessionNames.count <= 1002 else { throw StorageMigrationFailure.tooLarge }
        let preferenceLocations = ["capture-preferences.json", "WorkSessions/capture-preferences.json"].filter {
            $0.contains("/") ? sessionNames.contains("capture-preferences.json") : rootNames.contains($0)
        }
        guard preferenceLocations.count <= 1 else { throw StorageMigrationFailure.invalidData }
        if let source = preferenceLocations.first {
            let data = try MigrationIO.read(paths.legacyRoot.appendingPathComponent(source), maximum: maximumJSONBytes)
            do { preferences = try JSONDecoder().decode(CapturePreferences.self, from: data).validated() }
            catch { throw StorageMigrationFailure.invalidData }
            files.append(.init(source: source, destination: "backups/\(transactionID)/capture-preferences.json", data: data))
        }
        for name in sessionNames.sorted() where name != "capture-preferences.json" && name != ".DS_Store" {
            guard let id = UUID(uuidString: name), id.uuidString == name else { throw StorageMigrationFailure.invalidData }
            let directory = sessionRoot.appendingPathComponent(name, isDirectory: true)
            let data = try MigrationIO.read(directory.appendingPathComponent("session.json"), maximum: maximumJSONBytes)
            let session: WorkSession
            do { session = try JSONDecoder().decode(WorkSession.self, from: data); try session.validate() }
            catch { throw StorageMigrationFailure.invalidData }
            guard session.id == id else { throw StorageMigrationFailure.invalidData }
            let imageNames = Set(session.evidence.map(\.imageName))
            let names = Set(try MigrationIO.names(in: directory))
            guard names.subtracting([".DS_Store"]) == imageNames.union(["session.json"]) else { throw StorageMigrationFailure.invalidData }
            files.append(.init(source: "WorkSessions/\(name)/session.json", destination: "artifacts/WorkSessions/\(name)/session.json", data: data))
            try validateLimits(files)
            for image in imageNames.sorted() {
                let bytes = try MigrationIO.read(directory.appendingPathComponent(image), maximum: maximumImageBytes)
                files.append(.init(source: "WorkSessions/\(name)/\(image)", destination: "artifacts/WorkSessions/\(name)/\(image)", data: bytes))
                try validateLimits(files)
            }
        }
        files.sort { $0.source < $1.source }
        try validateLimits(files)
        return (files, preferences, hasSessions)
    }

    private func validateLimits(_ files: [MigrationFile]) throws {
        guard files.count <= maximumFiles, files.reduce(0, { $0 + $1.data.count }) <= maximumTotalBytes else {
            throw StorageMigrationFailure.tooLarge
        }
    }
    private func verifySources(_ files: [MigrationFile]) throws {
        for file in files {
            let data = try MigrationIO.read(paths.legacyRoot.appendingPathComponent(file.source), maximum: max(maximumImageBytes, maximumJSONBytes))
            guard MigrationIO.digest(data) == file.digest else { throw StorageMigrationFailure.sourceChanged }
        }
    }
    private static func validRelative(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return !path.isEmpty && !path.contains("\0") && parts.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }
    private static func allowedMapping(_ entry: StorageMigrationMarker.Entry, transactionID: String) -> Bool {
        switch entry.source {
        case "workspace.json": return entry.destination == "tasks/local-workspace.json"
        case "project-associations.json": return entry.destination == "projects.json"
        case "project-conversations.json": return entry.destination == "conversations/project-drafts.json"
        case "capture-preferences.json", "WorkSessions/capture-preferences.json":
            return entry.destination == "backups/\(transactionID)/capture-preferences.json"
        case "configuration-conversion": return entry.destination == "config.toml"
        default:
            let parts = entry.source.split(separator: "/").map(String.init)
            guard parts.count == 3, parts[0] == "WorkSessions", let id = UUID(uuidString: parts[1]),
                  id.uuidString == parts[1], entry.destination == "artifacts/" + entry.source else { return false }
            if parts[2] == "session.json" { return true }
            guard parts[2].hasSuffix(".jpg"), let imageID = UUID(uuidString: String(parts[2].dropLast(4))) else { return false }
            return imageID.uuidString + ".jpg" == parts[2]
        }
    }
}

/// Descriptor-relative operations refuse symlinks at every ancestor, not just at the final file.
enum MigrationIO {
    struct HeldLock {
        let url: URL
        let descriptor: Int32?
    }
    static func holdExistingLocks(_ urls: [URL]) throws -> [HeldLock] {
        var locks: [HeldLock] = []
        do {
            for url in urls {
                guard try exists(url) else { locks.append(.init(url: url, descriptor: nil)); continue }
                let directory = try parent(url)
                let descriptor = openat(directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                close(directory)
                guard descriptor >= 0 else { throw StorageMigrationFailure.unsafePath }
                var attributes = stat()
                guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG,
                      attributes.st_nlink == 1, attributes.st_size == 0 else {
                    close(descriptor); throw StorageMigrationFailure.invalidData
                }
                guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                    close(descriptor); throw StorageMigrationFailure.inProgress
                }
                locks.append(.init(url: url, descriptor: descriptor))
            }
            return locks
        } catch { release(locks); throw error }
    }
    static func release(_ locks: [HeldLock]) {
        for lock in locks {
            if let descriptor = lock.descriptor { flock(descriptor, LOCK_UN); close(descriptor) }
        }
    }
    static func verify(_ locks: [HeldLock]) throws {
        for lock in locks {
            guard let descriptor = lock.descriptor else {
                if try exists(lock.url) { throw StorageMigrationFailure.sourceChanged }
                continue
            }
            let directory = try parent(lock.url); defer { close(directory) }
            var held = stat(), current = stat()
            guard fstat(descriptor, &held) == 0,
                  fstatat(directory, lock.url.lastPathComponent, &current, AT_SYMLINK_NOFOLLOW) == 0,
                  current.st_mode & S_IFMT == S_IFREG, current.st_size == 0, current.st_nlink == 1,
                  held.st_dev == current.st_dev, held.st_ino == current.st_ino else { throw StorageMigrationFailure.sourceChanged }
        }
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func parent(_ url: URL, create: Bool = false, created: inout [URL]) throws -> Int32 {
        guard url.isFileURL, url.path.hasPrefix("/"), url.path != "/", !url.path.contains("\0") else {
            throw StorageMigrationFailure.unsafePath
        }
        let components = url.deletingLastPathComponent().pathComponents.dropFirst()
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
              url.lastPathComponent != ".", url.lastPathComponent != ".." else { throw StorageMigrationFailure.unsafePath }
        var descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw posix() }
        var current = URL(fileURLWithPath: "/", isDirectory: true)
        do {
            for component in components {
                current.appendPathComponent(component, isDirectory: true)
                var next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                if next < 0, errno == ENOENT, create {
                    guard mkdirat(descriptor, component, 0o700) == 0 else { throw posix() }
                    created.append(current)
                    next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                }
                guard next >= 0 else {
                    if errno == ELOOP || errno == ENOTDIR { throw StorageMigrationFailure.unsafePath }
                    throw posix()
                }
                close(descriptor); descriptor = next
            }
            return descriptor
        } catch { close(descriptor); throw error }
    }
    static func parent(_ url: URL) throws -> Int32 { var created: [URL] = []; return try parent(url, created: &created) }
    static func exists(_ url: URL) throws -> Bool {
        let directory: Int32
        do { directory = try parent(url) }
        catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) { return false }
        defer { close(directory) }
        var attributes = stat()
        if fstatat(directory, url.lastPathComponent, &attributes, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return false }; throw posix()
        }
        guard attributes.st_mode & S_IFMT == S_IFREG || attributes.st_mode & S_IFMT == S_IFDIR else { throw StorageMigrationFailure.unsafePath }
        return true
    }
    static func read(_ url: URL, maximum: Int) throws -> Data {
        let directory = try parent(url); defer { close(directory) }
        let descriptor = openat(directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { if errno == ELOOP { throw StorageMigrationFailure.unsafePath }; throw posix() }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
        var before = stat(); guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG else { throw StorageMigrationFailure.unsafePath }
        guard before.st_size <= maximum else { throw StorageMigrationFailure.tooLarge }
        let data = try handle.read(upToCount: maximum + 1) ?? Data()
        var after = stat()
        guard fstat(descriptor, &after) == 0, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
            throw StorageMigrationFailure.sourceChanged
        }
        guard data.count <= maximum else { throw StorageMigrationFailure.tooLarge }
        return data
    }
    static func requireRegular(_ url: URL) throws {
        let directory = try parent(url); defer { close(directory) }
        var attributes = stat()
        guard fstatat(directory, url.lastPathComponent, &attributes, AT_SYMLINK_NOFOLLOW) == 0,
              attributes.st_mode & S_IFMT == S_IFREG else { throw StorageMigrationFailure.invalidData }
    }
    static func secureFile(_ url: URL) throws {
        let directory = try parent(url); defer { close(directory) }
        let descriptor = openat(directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else { throw StorageMigrationFailure.unsafePath }
        defer { close(descriptor) }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG,
              fchmod(descriptor, 0o600) == 0 else { throw StorageMigrationFailure.unsafePath }
    }
    static func names(in url: URL) throws -> [String] {
        // fdopendir owns its descriptor after success and keeps enumeration on the checked directory.
        let parentFD = try parent(url); defer { close(parentFD) }
        let descriptor = openat(parentFD, url.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw StorageMigrationFailure.unsafePath }
        guard let directory = fdopendir(descriptor) else { close(descriptor); throw posix() }
        defer { closedir(directory) }
        var names: [String] = []
        errno = 0
        while let item = readdir(directory) {
            let name = withUnsafePointer(to: &item.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(item.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard names.count < 5001 else { throw StorageMigrationFailure.tooLarge }
            var attributes = stat()
            guard fstatat(descriptor, name, &attributes, AT_SYMLINK_NOFOLLOW) == 0 else { throw posix() }
            guard attributes.st_mode & S_IFMT == S_IFREG || attributes.st_mode & S_IFMT == S_IFDIR else { throw StorageMigrationFailure.unsafePath }
            names.append(name)
        }
        guard errno == 0 else { throw posix() }
        return names.sorted()
    }
    static func createDirectory(_ url: URL, created: inout [URL]) throws {
        let child = url.appendingPathComponent(".path-check")
        let descriptor = try parent(child, create: true, created: &created); close(descriptor)
    }
    static func createDirectory(_ url: URL) throws { var created: [URL] = []; try createDirectory(url, created: &created) }
    static func writeNew(_ data: Data, to url: URL) throws {
        var created: [URL] = []
        let directory = try parent(url, create: true, created: &created); defer { close(directory) }
        let descriptor = openat(directory, url.lastPathComponent, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw posix() }
        defer { close(descriptor) }
        try data.withUnsafeBytes { buffer in
            guard let bytes = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(descriptor, bytes.advanced(by: offset), buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw posix() }; offset += written
            }
        }
        guard fsync(descriptor) == 0 else { throw posix() }
        _ = fsync(directory)
    }
    static func linkNew(_ source: URL, to destination: URL) throws {
        let sourceParent = try parent(source); defer { close(sourceParent) }
        let destinationParent = try parent(destination); defer { close(destinationParent) }
        if linkat(sourceParent, source.lastPathComponent, destinationParent, destination.lastPathComponent, 0) != 0 {
            if errno == EEXIST { throw StorageMigrationFailure.destinationConflict }; throw posix()
        }
        _ = fsync(destinationParent)
    }
    static func removeFile(_ url: URL, expected: Data) throws {
        guard try read(url, maximum: expected.count + 1) == expected else { throw StorageMigrationFailure.sourceChanged }
        let directory = try parent(url); defer { close(directory) }
        guard unlinkat(directory, url.lastPathComponent, 0) == 0 else { throw posix() }
    }
    static func removeEmptyDirectory(_ url: URL) throws {
        let directory = try parent(url); defer { close(directory) }
        guard unlinkat(directory, url.lastPathComponent, AT_REMOVEDIR) == 0 else { throw posix() }
    }
    static func removeOwnedTree(_ url: URL) throws {
        for name in try names(in: url) {
            let child = url.appendingPathComponent(name)
            let directory = try parent(child); var attributes = stat()
            let status = fstatat(directory, name, &attributes, AT_SYMLINK_NOFOLLOW); close(directory)
            guard status == 0 else { throw posix() }
            if attributes.st_mode & S_IFMT == S_IFDIR { try removeOwnedTree(child) }
            else { let data = try read(child, maximum: 16 * 1024 * 1024); try removeFile(child, expected: data) }
        }
        try removeEmptyDirectory(url)
    }
    static func posix() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
