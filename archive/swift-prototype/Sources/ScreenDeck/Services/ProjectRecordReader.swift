import Foundation
import CoreFoundation
import Darwin

struct ProjectRecordReadError: LocalizedError, Equatable {
    let path: String
    let reason: String
    var errorDescription: String? { "\(path)：\(reason)" }
}

/// Bounded, native, read-only v1 import. It does not load the supplied schema,
/// interpret record text, read attachment contents, or restore recorded executions.
struct ProjectRecordReader: Sendable {
    struct Limits: Sendable {
        let jsonBytes: Int
        let tasks: Int
        let runs: Int
        let totalBytes: Int
        static let standard = Limits(jsonBytes: 2 * 1024 * 1024, tasks: 1000,
                                     runs: 1000, totalBytes: 32 * 1024 * 1024)
    }
    private let limits: Limits
    private let historyLocation: ProjectHistoryLocation
    // Injected roots and smaller limits keep migration/boundary tests isolated from user data.
    init(privateRoot: URL = ScreenDeckPaths().root, limits: Limits = .standard) {
        self.limits = limits
        historyLocation = ProjectHistoryLocation(privateRoot: privateRoot)
    }

    func read(root: URL) throws -> ProjectRecordSnapshot {
        try read(root: root, staging: nil)
    }

    /// Validate a complete staging namespace before publishing it or changing the source identity.
    func readPrivateNamespace(root: URL, project: ProjectIdentity, namespaceRoot: URL) throws -> ProjectRecordSnapshot {
        try read(root: root, staging: (project, namespaceRoot))
    }

    private func read(root: URL, staging: (identity: ProjectIdentity, namespace: URL)?) throws -> ProjectRecordSnapshot {
        let rootURL = try checkedRoot(root)
        let rootFD = try openRoot(rootURL)
        defer { close(rootFD) }
        let rootIdentity = try signature(rootFD, path: "项目目录", directory: true)
        var totalBytes = 0
        var sourceSignatures: [(root: Int32, path: String, signature: FileSignature)] = []
        func record<T: Decodable>(_ relative: String, _ kind: String, as: T.Type, from sourceFD: Int32) throws -> T {
            let fd = try openRelative(relative, rootFD: sourceFD, directory: false)
            defer { close(fd) }
            let before = try signature(fd, path: relative)
            guard before.size <= limits.jsonBytes else {
                throw issue(relative, "JSON 超过单文件 2 MiB 上限")
            }
            let bytes = try readBounded(fd, path: relative, maximum: limits.jsonBytes)
            totalBytes += bytes.count
            guard totalBytes <= limits.totalBytes else {
                throw issue(relative, "记录总量超过 32 MiB 上限")
            }
            guard before == (try signature(fd, path: relative)) else {
                throw issue(relative, "读取期间文件发生变化，请刷新重试")
            }
            sourceSignatures.append((sourceFD, relative, before))
            let object: [String: Any]
            do {
                guard let dictionary = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                    throw issue(relative, "记录必须是 JSON 对象")
                }
                object = dictionary
            } catch let error as ProjectRecordReadError { throw error }
            catch { throw issue(relative, "JSON 损坏，无法读取") }
            try validate(object, kind: kind, path: relative)
            do { return try JSONDecoder().decode(T.self, from: bytes) }
            catch { throw issue(relative, "记录字段无法解码") }
        }

        let original: ProjectRecord = try record(".screendeck/project.json", "project", as: ProjectRecord.self, from: rootFD)
        var identity = original
        if let staging {
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(staging.identity)) as! [String: Any]
            try validate(object, kind: "project", path: "暂存项目身份")
            guard staging.identity.projectID == original.projectID,
                  staging.identity.name == original.name, staging.identity.createdAt == original.createdAt else {
                throw issue("暂存项目身份", "身份与来源项目不一致")
            }
            identity = ProjectRecord(projectID: original.projectID, name: original.name, createdAt: original.createdAt,
                                     timezone: "", mode: "managed", references: [])
        }
        let binding = identity.mode == "managed"
            ? try boundHistory(identity: identity, root: rootURL, namespaceOverride: staging?.namespace) : nil
        if staging != nil, binding == nil { throw issue("history.json", "暂存历史缺少绑定清单") }
        if let binding {
            totalBytes += binding.bytes.count
            guard totalBytes <= limits.totalBytes else { throw issue("history.json", "记录总量超过 32 MiB 上限") }
        }
        let project = binding?.manifest.project.record ?? identity
        let namespaceFD = try binding.map { try openRoot($0.namespace) }
        defer { if let namespaceFD { close(namespaceFD) } }
        let namespaceIdentity = try namespaceFD.map { try signature($0, path: "私人项目目录", directory: true) }
        let recordsFD = namespaceFD ?? rootFD
        let recordPrefix = namespaceFD == nil ? ".screendeck/" : ""
        let taskDirectory = recordPrefix + "tasks"
        let runDirectory = recordPrefix + "runs"
        if let namespaceFD {
            let artifacts = try openRelative("artifacts", rootFD: namespaceFD, directory: true)
            close(artifacts)
        }
        func recordEntries(_ path: String, maximum: Int) throws -> [String] {
            // Unmigrated v2 identities never inherit local or unbound private history.
            if identity.mode == "managed", binding == nil {
                var attributes = stat()
                if fstatat(rootFD, path, &attributes, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT { return [] }
                let names = try entries(path, rootFD: rootFD, maximum: maximum)
                guard names.isEmpty else { throw issue(path, "v2 身份不能读取未迁移的项目内历史") }
                return []
            }
            return try entries(path, rootFD: recordsFD, maximum: maximum)
        }
        let taskNames = try recordEntries(taskDirectory, maximum: limits.tasks)
        let runNames = try recordEntries(runDirectory, maximum: limits.runs)
        var tasks: [ProjectTaskRecord] = []
        var runs: [ProjectRunRecord] = []
        var taskIDs = Set<String>()
        var runIDs = Set<String>()
        for name in taskNames {
            let path = "\(taskDirectory)/\(name)"
            let task: ProjectTaskRecord = try record(path, "task", as: ProjectTaskRecord.self, from: recordsFD)
            guard taskIDs.insert(task.taskID).inserted else { throw issue(path, "task_id 重复") }
            guard name == "\(task.taskID).json" else { throw issue(path, "文件名必须与 task_id 一致") }
            tasks.append(task)
        }
        for name in runNames {
            let path = "\(runDirectory)/\(name)"
            let run: ProjectRunRecord = try record(path, "run", as: ProjectRunRecord.self, from: recordsFD)
            guard runIDs.insert(run.runID).inserted else { throw issue(path, "run_id 重复") }
            guard name == "\(run.runID).json" else { throw issue(path, "文件名必须与 run_id 一致") }
            runs.append(run)
        }
        let taskMap = Dictionary(uniqueKeysWithValues: tasks.map { ($0.taskID, $0) })
        let runMap = Dictionary(uniqueKeysWithValues: runs.map { ($0.runID, $0) })
        for task in tasks {
            let path = "\(taskDirectory)/\(task.taskID).json"
            guard task.projectID == project.projectID else { throw issue(path, "project_id 与项目不一致") }
            guard Set(task.acceptance.map(\.id)).count == task.acceptance.count else {
                throw issue(path, "验收项 id 重复")
            }
            if task.status == "completed" && task.acceptance.contains(where: { $0.verification != "verified" }) {
                throw issue(path, "completed 任务的所有验收项必须 verified")
            }
            guard try date(task.updatedAt, path: path) >= date(task.createdAt, path: path) else {
                throw issue(path, "updated_at 早于 created_at")
            }
            for id in task.runIDs {
                guard let run = runMap[id] else { throw issue(path, "缺少执行记录 \(id)") }
                guard run.taskID == task.taskID else { throw issue(path, "执行记录 \(id) 属于其他任务") }
            }
        }
        for run in runs {
            let path = "\(runDirectory)/\(run.runID).json"
            guard run.projectID == project.projectID else { throw issue(path, "project_id 与项目不一致") }
            guard let task = taskMap[run.taskID] else { throw issue(path, "缺少任务 \(run.taskID)") }
            guard task.runIDs.contains(run.runID) else { throw issue(path, "执行记录未列入任务 run_ids") }
            guard run.planVersion <= task.planVersion else { throw issue(path, "执行 plan_version 超过任务版本") }
            if run.status == "completed" && run.endedAt == nil { throw issue(path, "completed 执行必须有 ended_at") }
            if run.status == "running" && run.endedAt != nil { throw issue(path, "running 执行不能有 ended_at") }
            if let start = run.startedAt, let end = run.endedAt,
               try date(end, path: path) < date(start, path: path) {
                throw issue(path, "ended_at 早于 started_at")
            }
            if run.git.commitStatus == "committed" && run.git.commitIDs.isEmpty {
                throw issue(path, "committed 状态必须提供 commit_id")
            }
            if run.git.commitStatus != "committed" && !run.git.commitIDs.isEmpty {
                throw issue(path, "none/unknown 提交状态不能提供 commit_id")
            }
            if run.git.pushStatus == "pushed" && run.git.commitStatus != "committed" {
                throw issue(path, "pushed 状态必须已经 committed")
            }
        }
        let referenceGroups = [(".screendeck/project.json", project.references)]
            + tasks.map { ("\(taskDirectory)/\($0.taskID).json", $0.references) }
            + runs.map { ("\(runDirectory)/\($0.runID).json", $0.references) }
        for (recordPath, references) in referenceGroups {
            for reference in references {
                do {
                    let relative = reference.path.hasPrefix("screendeck:")
                        ? try ProjectHistoryLocation.parsePrivateReference(reference.path, projectID: project.projectID) : reference.path
                    if reference.path.hasPrefix("screendeck:"), namespaceFD == nil {
                        throw issue(reference.path, "私人引用缺少项目绑定清单")
                    }
                    let fd = try openRelative(relative, rootFD: reference.path.hasPrefix("screendeck:") ? namespaceFD! : rootFD,
                                              directory: false)
                    defer { close(fd) }
                    _ = try signature(fd, path: reference.path)
                } catch { throw issue(recordPath, "引用 \(reference.path) 无效：\(error.localizedDescription)") }
            }
        }
        // Never publish a partial or obviously mixed refresh when a serial writer changes files.
        guard taskNames == (try recordEntries(taskDirectory, maximum: limits.tasks)),
              runNames == (try recordEntries(runDirectory, maximum: limits.runs)) else {
            throw issue(".screendeck", "读取期间记录目录发生变化，请刷新重试")
        }
        for (source, path, expected) in sourceSignatures {
            let fd = try openRelative(path, rootFD: source, directory: false)
            defer { close(fd) }
            guard expected == (try signature(fd, path: path)) else {
                throw issue(path, "读取期间记录发生变化，请刷新重试")
            }
        }
        let currentRoot = try openRoot(rootURL)
        defer { close(currentRoot) }
        let currentIdentity = try signature(currentRoot, path: "项目目录", directory: true)
        guard rootIdentity.device == currentIdentity.device && rootIdentity.inode == currentIdentity.inode else {
            throw issue("项目目录", "读取期间项目位置发生变化，请重新关联")
        }
        if let binding, let namespaceIdentity {
            let current = try openRoot(binding.namespace)
            defer { close(current) }
            let identity = try signature(current, path: "私人项目目录", directory: true)
            guard namespaceIdentity.device == identity.device, namespaceIdentity.inode == identity.inode,
                  try SafePrivateStorageIO.read(binding.manifestURL, maximumBytes: limits.jsonBytes) == binding.bytes else {
                throw issue("history.json", "读取期间私人历史或绑定清单发生变化，请刷新重试")
            }
        }
        return ProjectRecordSnapshot(rootURL: rootURL, project: project, tasks: tasks,
                                     runs: runs, loadedAt: Date(), historyRootURL: binding?.namespace)
    }

    func validatedReference(_ reference: ProjectFileReference, root: URL) throws -> URL {
        let resolved = try resolveReference(reference, root: root)
        let fd = try openRoot(resolved.root)
        defer { close(fd) }
        let leaf = try openRelative(resolved.relative, rootFD: fd, directory: false)
        defer { close(leaf) }
        _ = try signature(leaf, path: reference.path)
        try recheckReference(resolved)
        return resolved.root.appendingPathComponent(resolved.relative)
    }

    /// Reads an already-selected reference without following any relative symlink.
    /// Registration and snapshot freshness are checked by the workspace controller.
    func readReferenceData(_ reference: ProjectFileReference, root: URL, maximumBytes: Int) throws -> Data {
        try readReference(reference, root: root, maximumBytes: maximumBytes).data
    }

    /// Return bytes and their actual resolved location from the same binding-aware read.
    func readReference(_ reference: ProjectFileReference, root: URL, maximumBytes: Int) throws -> (data: Data, url: URL) {
        guard maximumBytes > 0, maximumBytes <= 16 * 1024 * 1024 else {
            throw issue(reference.path, "读取上限必须介于 1 字节和 16 MiB 之间")
        }
        let resolved = try resolveReference(reference, root: root)
        let rootURL = resolved.root
        let rootFD = try openRoot(rootURL)
        defer { close(rootFD) }
        let rootIdentity = try signature(rootFD, path: "项目目录", directory: true)
        let leafFD = try openRelative(resolved.relative, rootFD: rootFD, directory: false)
        defer { close(leafFD) }
        let before = try signature(leafFD, path: reference.path)
        let oversized = "文件超过本次预览的 \(maximumBytes) 字节上限"
        guard before.size >= 0, before.size <= maximumBytes else {
            throw issue(reference.path, oversized)
        }
        let bytes = try readBounded(leafFD, path: reference.path, maximum: maximumBytes,
                                    oversizedReason: oversized)
        guard before == (try signature(leafFD, path: reference.path)),
              Int64(bytes.count) == before.size else {
            throw issue(reference.path, "读取期间文件发生变化，请重新打开")
        }

        // Reopen both paths: an unchanged descriptor alone cannot detect a replaced
        // file entry or project directory while the original object remains open.
        let currentRootFD = try openRoot(rootURL)
        defer { close(currentRootFD) }
        let currentRootIdentity = try signature(currentRootFD, path: "项目目录", directory: true)
        guard rootIdentity.device == currentRootIdentity.device,
              rootIdentity.inode == currentRootIdentity.inode else {
            throw issue("项目目录", "读取期间项目位置发生变化，请重新关联")
        }
        let currentLeafFD = try openRelative(resolved.relative, rootFD: currentRootFD, directory: false)
        defer { close(currentLeafFD) }
        guard before == (try signature(currentLeafFD, path: reference.path)) else {
            throw issue(reference.path, "读取期间文件位置或内容发生变化，请重新打开")
        }
        try recheckReference(resolved)
        return (bytes, rootURL.appendingPathComponent(resolved.relative))
    }

    private struct BoundHistory {
        let namespace: URL
        let manifestURL: URL
        let manifest: ProjectHistoryManifest
        let bytes: Data
    }

    private struct ResolvedReference {
        let root: URL
        let relative: String
        let binding: BoundHistory?
        let identity: (url: URL, bytes: Data)?
    }

    private func resolveReference(_ reference: ProjectFileReference, root: URL) throws -> ResolvedReference {
        let rootURL = try checkedRoot(root)
        guard reference.path.hasPrefix("screendeck:") else {
            _ = try parts(reference.path)
            return ResolvedReference(root: rootURL, relative: reference.path, binding: nil, identity: nil)
        }
        let fd = try openRoot(rootURL)
        close(fd)
        let identityURL = rootURL.appendingPathComponent(".screendeck/project.json")
        guard let bytes = try SafePrivateStorageIO.read(identityURL, maximumBytes: limits.jsonBytes),
              let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw issue(reference.path, "私人引用缺少有效项目身份")
        }
        try validate(object, kind: "project", path: ".screendeck/project.json")
        let identity = try JSONDecoder().decode(ProjectRecord.self, from: bytes)
        guard identity.mode == "managed",
              let binding = try boundHistory(identity: identity, root: rootURL) else {
            throw issue(reference.path, "私人引用缺少已迁移的项目绑定清单")
        }
        let relative = try ProjectHistoryLocation.parsePrivateReference(reference.path, projectID: identity.projectID)
        return ResolvedReference(root: binding.namespace, relative: relative, binding: binding, identity: (identityURL, bytes))
    }

    private func boundHistory(identity: ProjectRecord, root: URL, namespaceOverride: URL? = nil) throws -> BoundHistory? {
        let namespace = try namespaceOverride.map(checkedRoot) ?? historyLocation.namespace(projectID: identity.projectID)
        let manifestURL = namespace.appendingPathComponent("history.json")
        guard let bytes = try SafePrivateStorageIO.read(manifestURL, maximumBytes: limits.jsonBytes) else {
            // Absence is safe only for a genuinely empty namespace, never unbound records.
            var attributes = stat()
            var path = namespace.path
            while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            if lstat(path, &attributes) != 0 {
                if errno == ENOENT { return nil }
                throw issue("history.json", "无法检查私人历史位置")
            }
            let rootFD = try openRoot(namespace)
            defer { close(rootFD) }
            for name in ["tasks", "runs", "artifacts"] {
                var info = stat()
                if fstatat(rootFD, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
                    if errno == ENOENT { continue }
                    throw issue(name, "无法检查未绑定历史目录")
                }
                let directory = try openRelative(name, rootFD: rootFD, directory: true)
                guard !hasEntries(directory) else { close(directory); throw issue(name, "私人历史已有内容但缺少 history.json 绑定清单") }
                close(directory)
            }
            return nil
        }
        guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw issue("history.json", "清单必须是 JSON 对象")
        }
        try keys(object, required: ["schema_version", "kind", "project_id", "source_root", "created_at", "project", "migration"], path: "history.json")
        guard try integer(object["schema_version"], path: "history.json.schema_version") == 1 else {
            throw issue("history.json", "不支持此历史清单版本")
        }
        try constant(object["kind"], expected: "project_history", path: "history.json.kind")
        try constant(object["project_id"], expected: identity.projectID, path: "history.json.project_id")
        let source = try string(object["source_root"], maximum: 4096, path: "history.json.source_root")
        guard source == (try ProjectHistoryLocation.normalizedRootPath(root)),
              source == (try ProjectHistoryLocation.normalizedRootPath(URL(fileURLWithPath: source))) else {
            throw issue("history.json.source_root", "私人历史属于其他项目位置，不能仅凭相同 ID 读取")
        }
        try timestamp(object["created_at"], path: "history.json.created_at")
        let original = try dictionary(object["project"], path: "history.json.project")
        guard try integer(original["schema_version"], path: "history.json.project.schema_version") == 1 else {
            throw issue("history.json.project", "必须保留完整原 v1 项目")
        }
        try validate(original, kind: "project", path: "history.json.project")
        try constant(original["project_id"], expected: identity.projectID, path: "history.json.project.project_id")
        try constant(original["created_at"], expected: identity.createdAt, path: "history.json.project.created_at")
        let migration = try dictionary(object["migration"], path: "history.json.migration")
        try keys(migration, required: ["backup_path", "migrated_at"], path: "history.json.migration")
        let backup = try string(migration["backup_path"], maximum: 4096, path: "history.json.migration.backup_path")
        // This is provenance, not a lookup authority. Preserve the recorded system alias
        // spelling; Foundation may rewrite it after the backup directory is published.
        guard backup.hasPrefix("/"), backup != "/", !backup.contains("\0"),
              !backup.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
            throw issue("history.json.migration.backup_path", "备份位置必须是无越界组件的绝对路径")
        }
        try timestamp(migration["migrated_at"], path: "history.json.migration.migrated_at")
        let manifest = try JSONDecoder().decode(ProjectHistoryManifest.self, from: bytes)
        return BoundHistory(namespace: namespace, manifestURL: manifestURL, manifest: manifest, bytes: bytes)
    }

    private func recheckReference(_ reference: ResolvedReference) throws {
        if let binding = reference.binding,
           try SafePrivateStorageIO.read(binding.manifestURL, maximumBytes: limits.jsonBytes) != binding.bytes {
            throw issue("history.json", "读取期间项目绑定清单发生变化，请重新打开")
        }
        if let identity = reference.identity,
           try SafePrivateStorageIO.read(identity.url, maximumBytes: limits.jsonBytes) != identity.bytes {
            throw issue(".screendeck/project.json", "读取期间项目身份发生变化，请重新打开")
        }
    }

    private func hasEntries(_ descriptor: Int32) -> Bool {
        guard let directory = fdopendir(dup(descriptor)) else { return true }
        defer { closedir(directory) }
        while true {
            errno = 0
            guard let entry = readdir(directory) else { return errno != 0 }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) }
            }
            if name != "." && name != ".." { return true }
        }
    }

    private func issue(_ path: String, _ reason: String) -> ProjectRecordReadError {
        ProjectRecordReadError(path: path, reason: reason)
    }

    private func checkedRoot(_ root: URL) throws -> URL {
        guard root.isFileURL, !root.path.contains("\0"),
              root.host == nil || root.host == "" || root.host == "localhost" else {
            throw issue("项目目录", "请选择本机项目文件夹")
        }
        return root.standardizedFileURL
    }

    private func openRoot(_ root: URL) throws -> Int32 {
        var path = root.path
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        // macOS exposes only these known system aliases; arbitrary ancestors stay no-follow.
        for alias in ["var", "tmp"] where path == "/\(alias)" || path.hasPrefix("/\(alias)/") {
            var bytes = [CChar](repeating: 0, count: 128)
            guard readlink("/\(alias)", &bytes, bytes.count - 1) >= 0,
                  ["private/\(alias)", "/private/\(alias)"].contains(String(cString: bytes)) else {
                throw issue("项目目录", "系统目录别名无效")
            }
            path = "/private" + path
        }
        var fd = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw issue("项目目录", "文件夹不可读") }
        for component in path.split(separator: "/") {
            let next = String(component).withCString { openat(fd, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            close(fd)
            guard next >= 0 else { throw issue("项目目录", "文件夹不可读、不存在或包含符号链接") }
            fd = next
        }
        return fd
    }

    private func parts(_ path: String) throws -> [String] {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0"),
              !path.contains("#"), !path.contains("?"),
              path.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) == nil else {
            throw issue(path, "引用必须是项目内相对路径，不支持 URL 或锚点")
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            throw issue(path, "拒绝非规范路径或越界路径")
        }
        return components
    }

    private func openRelative(_ path: String, rootFD: Int32, directory: Bool) throws -> Int32 {
        let components = try parts(path)
        var parent = dup(rootFD)
        guard parent >= 0 else { throw issue(path, "无法读取文件夹") }
        for (index, component) in components.enumerated() {
            let isDirectory = index < components.count - 1 || directory
            let flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (isDirectory ? O_DIRECTORY : 0)
            let next = component.withCString { Darwin.openat(parent, $0, flags) }
            close(parent)
            guard next >= 0 else { throw issue(path, "路径不可读、不存在或含符号链接") }
            parent = next
        }
        if !directory {
            do { _ = try signature(parent, path: path) }
            catch { close(parent); throw error }
        }
        return parent
    }

    private struct FileSignature: Equatable {
        let device: dev_t
        let inode: ino_t
        let size: Int64
        let modifiedSeconds: Int
        let modifiedNanos: Int
        let changedSeconds: Int
        let changedNanos: Int
    }

    private func signature(_ fd: Int32, path: String, directory: Bool = false) throws -> FileSignature {
        var value = stat()
        guard fstat(fd, &value) == 0 else { throw issue(path, "无法检查文件类型") }
        let expectedType = directory ? S_IFDIR : S_IFREG
        guard (value.st_mode & S_IFMT) == expectedType else {
            throw issue(path, directory ? "项目目录必须是普通文件夹" : "引用或记录必须是普通文件")
        }
        return FileSignature(device: value.st_dev, inode: value.st_ino, size: Int64(value.st_size),
                             modifiedSeconds: value.st_mtimespec.tv_sec, modifiedNanos: value.st_mtimespec.tv_nsec,
                             changedSeconds: value.st_ctimespec.tv_sec, changedNanos: value.st_ctimespec.tv_nsec)
    }

    private func readBounded(_ fd: Int32, path: String, maximum: Int,
                             oversizedReason: String = "JSON 超过单文件 2 MiB 上限") throws -> Data {
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw issue(path, "文件读取失败")
            }
            if count == 0 { return bytes }
            guard bytes.count <= maximum - count else { throw issue(path, oversizedReason) }
            bytes.append(contentsOf: buffer.prefix(count))
        }
    }

    private func entries(_ path: String, rootFD: Int32, maximum: Int) throws -> [String] {
        let fd = try openRelative(path, rootFD: rootFD, directory: true)
        guard let directory = fdopendir(fd) else {
            close(fd)
            throw issue(path, "无法读取记录目录")
        }
        defer { closedir(directory) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(directory) else {
                guard errno == 0 else { throw issue(path, "记录目录读取失败") }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: 1024) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            guard names.count < maximum else { throw issue(path, "记录数量超过 \(maximum) 条上限") }
            guard name.hasSuffix(".json") else { throw issue("\(path)/\(name)", "记录目录只允许普通 .json 文件") }
            names.append(name)
        }
        return names.sorted()
    }

    private func validate(_ value: [String: Any], kind: String, path: String) throws {
        if kind == "project", try integer(value["schema_version"], path: "\(path).schema_version") == 2 {
            try keys(value, required: ["schema_version", "kind", "project_id", "name", "created_at"], path: path)
            try constant(value["kind"], expected: "project", path: "\(path).kind")
            _ = try string(value["project_id"], maximum: 100,
                           pattern: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", path: "\(path).project_id")
            _ = try string(value["name"], maximum: 150, path: "\(path).name")
            try timestamp(value["created_at"], path: "\(path).created_at")
            return
        }
        let common = ["schema_version", "project_id", "kind", "references"]
        let fields: [String]
        switch kind {
        case "project": fields = ["name", "created_at", "timezone", "mode"]
        case "task": fields = ["task_id", "title", "goal", "status", "plan_version", "assignee", "created_at", "updated_at", "run_ids", "acceptance"]
        default: fields = ["task_id", "run_id", "plan_version", "status", "started_at", "ended_at", "recorded_at", "executor", "skills", "summary", "git"]
        }
        try keys(value, required: common + fields, path: path)
        guard try integer(value["schema_version"], path: "\(path).schema_version") == 1 else {
            throw issue(path, "暂不支持此 schema_version，只支持 v1")
        }
        try constant(value["kind"], expected: kind, path: "\(path).kind")
        _ = try string(value["project_id"], maximum: 100, pattern: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", path: "\(path).project_id")
        try references(value["references"], path: "\(path).references")
        if kind == "project" {
            _ = try string(value["name"], maximum: 150, path: "\(path).name")
            try timestamp(value["created_at"], path: "\(path).created_at")
            try constant(value["timezone"], expected: "Asia/Shanghai", path: "\(path).timezone")
            try constant(value["mode"], expected: "manual_pilot", path: "\(path).mode")
            return
        }
        _ = try string(value["task_id"], maximum: 2 * 1024 * 1024, pattern: "^task-[0-9]{3,}$", path: "\(path).task_id")
        guard try integer(value["plan_version"], path: "\(path).plan_version") >= 1 else {
            throw issue(path, "plan_version 必须为正整数")
        }
        if kind == "task" {
            _ = try string(value["title"], maximum: 200, path: "\(path).title")
            _ = try string(value["goal"], maximum: 2000, path: "\(path).goal")
            try choice(value["status"], options: ["draft", "ready", "running", "awaiting_approval", "verifying", "awaiting_review", "completed", "failed", "cancelled"], path: "\(path).status")
            try choice(value["assignee"], options: ["human", "agent", "shared"], path: "\(path).assignee")
            try timestamp(value["created_at"], path: "\(path).created_at")
            try timestamp(value["updated_at"], path: "\(path).updated_at")
            try stringArray(value["run_ids"], maximum: 1000, stringMaximum: 2 * 1024 * 1024,
                            pattern: "^run-[0-9]{8}-[0-9]{3,}$", path: "\(path).run_ids")
            let items = try array(value["acceptance"], minimum: 1, maximum: 32, path: "\(path).acceptance")
            for (index, item) in items.enumerated() {
                let location = "\(path).acceptance[\(index)]"
                let object = try dictionary(item, path: location)
                try keys(object, required: ["id", "description", "verification", "requires_human"], path: location)
                _ = try string(object["id"], maximum: 64, pattern: "^[a-z][a-z0-9-]{0,63}$", path: "\(location).id")
                _ = try string(object["description"], maximum: 1000, path: "\(location).description")
                try choice(object["verification"], options: ["not_checked", "verified", "failed"], path: "\(location).verification")
                guard let number = object["requires_human"] as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                    throw issue("\(location).requires_human", "必须为布尔值")
                }
            }
        } else {
            _ = try string(value["run_id"], maximum: 2 * 1024 * 1024, pattern: "^run-[0-9]{8}-[0-9]{3,}$", path: "\(path).run_id")
            try choice(value["status"], options: ["running", "completed", "failed", "interrupted"], path: "\(path).status")
            try timestamp(value["started_at"], nullable: true, path: "\(path).started_at")
            try timestamp(value["ended_at"], nullable: true, path: "\(path).ended_at")
            try timestamp(value["recorded_at"], path: "\(path).recorded_at")
            _ = try string(value["summary"], maximum: 2000, path: "\(path).summary")
            try stringArray(value["skills"], maximum: 64, stringMaximum: 150, path: "\(path).skills")
            let executor = try dictionary(value["executor"], path: "\(path).executor")
            try keys(executor, required: ["agent", "model", "effort", "metadata_source"], path: "\(path).executor")
            _ = try string(executor["agent"], maximum: 100, path: "\(path).executor.agent")
            if !(executor["model"] is NSNull) { _ = try string(executor["model"], maximum: 150, path: "\(path).executor.model") }
            if !(executor["effort"] is NSNull) { _ = try string(executor["effort"], maximum: 100, path: "\(path).executor.effort") }
            _ = try string(executor["metadata_source"], maximum: 300, path: "\(path).executor.metadata_source")
            let git = try dictionary(value["git"], path: "\(path).git")
            try keys(git, required: ["commit_status", "commit_ids", "push_status"], path: "\(path).git")
            try choice(git["commit_status"], options: ["none", "committed", "unknown"], path: "\(path).git.commit_status")
            try choice(git["push_status"], options: ["not_pushed", "pushed", "unknown"], path: "\(path).git.push_status")
            try stringArray(git["commit_ids"], maximum: 32, stringMaximum: 64,
                            pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$", path: "\(path).git.commit_ids")
        }
    }

    private func dictionary(_ value: Any?, path: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw issue(path, "必须为对象") }
        return object
    }

    private func keys(_ object: [String: Any], required: [String], path: String) throws {
        let expected = Set(required)
        if let missing = expected.subtracting(object.keys).sorted().first { throw issue("\(path).\(missing)", "缺少必填字段") }
        if let extra = Set(object.keys).subtracting(expected).sorted().first { throw issue("\(path).\(extra)", "不支持额外字段") }
    }

    private func integer(_ value: Any?, path: String) throws -> Int {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              abs(number.doubleValue) <= 9_007_199_254_740_991 else { throw issue(path, "必须为安全整数") }
        return number.intValue
    }

    @discardableResult
    private func string(_ value: Any?, maximum: Int, pattern: String? = nil, path: String) throws -> String {
        guard let text = value as? String else { throw issue(path, "必须为字符串") }
        guard !text.isEmpty, text.unicodeScalars.count <= maximum else { throw issue(path, "字符串长度超出范围") }
        if let pattern = pattern {
            let regex = try NSRegularExpression(pattern: pattern)
            let entire = NSRange(text.startIndex..., in: text)
            guard regex.firstMatch(in: text, range: entire)?.range == entire else {
                throw issue(path, "字段格式不匹配")
            }
        }
        return text
    }

    private func constant(_ value: Any?, expected: String, path: String) throws {
        guard let text = value as? String, text == expected else { throw issue(path, "不支持此字段值") }
    }

    private func choice(_ value: Any?, options: [String], path: String) throws {
        guard let text = value as? String, options.contains(text) else { throw issue(path, "不支持此状态或类型") }
    }

    private func array(_ value: Any?, minimum: Int = 0, maximum: Int, path: String) throws -> [Any] {
        guard let items = value as? [Any], items.count >= minimum, items.count <= maximum else { throw issue(path, "数组类型或数量超出范围") }
        return items
    }

    private func stringArray(_ value: Any?, maximum: Int, stringMaximum: Int, pattern: String? = nil, path: String) throws {
        let items = try array(value, maximum: maximum, path: path)
        var unique = Set<String>()
        for (index, value) in items.enumerated() {
            let item = try string(value, maximum: stringMaximum, pattern: pattern, path: "\(path)[\(index)]")
            guard unique.insert(item).inserted else { throw issue(path, "数组含重复记录") }
        }
    }

    private func references(_ value: Any?, path: String) throws {
        for (index, value) in try array(value, maximum: 64, path: path).enumerated() {
            let location = "\(path)[\(index)]"
            let object = try dictionary(value, path: location)
            try keys(object, required: ["path", "label"], path: location)
            _ = try string(object["path"], maximum: 600, path: "\(location).path")
            _ = try string(object["label"], maximum: 150, path: "\(location).label")
        }
    }

    private func timestamp(_ value: Any?, nullable: Bool = false, path: String) throws {
        if nullable && value is NSNull { return }
        guard let text = value as? String else { throw issue(path, "时间必须为带时区的字符串或允许的 null") }
        _ = try date(text, path: path)
    }

    private func date(_ text: String, path: String) throws -> Date {
        let pattern = "^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$"
        let regex = try NSRegularExpression(pattern: pattern)
        guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.range.length == text.utf16.count else { throw issue(path, "无效时间，需真实日期和明确时区") }
        func capture(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: text) else { return nil }
            return String(text[range])
        }
        let values = (1...6).map { Int(capture($0)!)! }
        let (year, month, day, hour, minute, second) = (values[0], values[1], values[2], values[3], values[4], values[5])
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), (1...days[month - 1]).contains(day), hour <= 23, minute <= 59, second <= 59 else {
            throw issue(path, "无效日历日期或时间")
        }
        let zone = capture(8)!
        var offset = 0
        if zone != "Z" {
            let parts = zone.dropFirst().split(separator: ":").map { Int($0)! }
            guard parts[0] <= 23 && parts[1] <= 59 else { throw issue(path, "无效时区偏移") }
            offset = (parts[0] * 3600 + parts[1] * 60) * (zone.hasPrefix("-") ? -1 : 1)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let components = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
        guard let base = calendar.date(from: components) else { throw issue(path, "无效日历日期") }
        let fraction = capture(7).flatMap { Double("0." + $0.prefix(9)) } ?? 0
        return base.addingTimeInterval(fraction - Double(offset))
    }
}
