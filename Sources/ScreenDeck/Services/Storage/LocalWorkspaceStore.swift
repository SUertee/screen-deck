import Foundation

struct LocalTask: Codable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var completed = false
    var resumeRecords: [ResumeRecord]?
    var subtasks: [Subtask]?
    var executionPlan: ExecutionPlan?
    var conversationDraft: String?
    var latestResume: ResumeRecord? { resumeRecords?.last }
}

struct LocalWorkspace: Codable, Equatable {
    var schemaVersion = 1
    var tasks: [LocalTask] = []
    var currentTaskID: UUID?
    var defaultPinned = false
    var panelSize: CGSize?
    var conversations: [LocalConversation]?

    func validate() throws {
        guard schemaVersion == 1 else { throw WorkspaceError.unsupportedVersion }
        if let size = panelSize {
            guard size.width.isFinite, size.height.isFinite,
                  size.width >= 340, size.width <= 800,
                  size.height >= 160, size.height <= 640 else { throw WorkspaceError.invalidData }
        }
        guard Set(tasks.map(\.id)).count == tasks.count,
              tasks.allSatisfy({ !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
              currentTaskID == nil || tasks.contains(where: { $0.id == currentTaskID && !$0.completed })
        else { throw WorkspaceError.invalidData }
        let chats = conversations ?? []
        guard Set(chats.map(\.id)).count == chats.count,
              chats.allSatisfy({ !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.createdAt.timeIntervalSince1970.isFinite })
        else { throw WorkspaceError.invalidData }
        for task in tasks {
            try task.executionPlan?.validate()
            let subtasks = task.subtasks ?? []
            guard Set(subtasks.map(\.id)).count == subtasks.count,
                  subtasks.allSatisfy({ !$0.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            else { throw WorkspaceError.invalidData }
            let records = task.resumeRecords ?? []
            guard Set(records.map(\.id)).count == records.count else { throw WorkspaceError.invalidData }
            for record in records {
                _ = try record.content.validated()
                guard record.savedAt.timeIntervalSince1970.isFinite else { throw WorkspaceError.invalidData }
            }
        }
    }
}

enum WorkspaceError: LocalizedError {
    case unsupportedVersion, invalidData, emptyTitle, missingFile, revisionChanged
    var errorDescription: String? {
        switch self {
        case .unsupportedVersion: return "数据版本暂不支持，原文件未被覆盖。"
        case .invalidData: return "任务数据不完整，请保留原文件后检查。"
        case .emptyTitle: return "任务名称不能为空。"
        case .missingFile: return "已读取的任务文件已丢失或移动，请恢复原文件后重试；不会创建空文件覆盖已有任务。"
        case .revisionChanged: return "任务文件已被其他窗口或程序修改，请重新读取后重试；本次修改未覆盖外部数据。"
        }
    }
}

protocol WorkspaceStore {
    var url: URL { get }
    func load() throws -> LocalWorkspace
    func save(_ workspace: LocalWorkspace) throws
}

final class LocalWorkspaceStore: WorkspaceStore {
    let url: URL
    private let pathFailure: Error?
    private let maximumBytes = SafePrivateStorageIO.defaultMaximumBytes
    private var hasObservedExistingFile: Bool
    private var hasRememberedRevision = false
    private var rememberedRevision: Data?

    init(url: URL? = nil, requireExistingFile: Bool = false) {
        hasObservedExistingFile = requireExistingFile
        do { self.url = try url ?? ScreenDeckPaths().activeWorkspace(); pathFailure = nil }
        catch { self.url = ScreenDeckPaths().workspace; pathFailure = error }
    }
    func load() throws -> LocalWorkspace {
        if let pathFailure { throw pathFailure }
        let data = try existingData()
        let workspace = try data.map(decoded) ?? LocalWorkspace()
        rememberedRevision = data
        hasRememberedRevision = true
        return workspace
    }
    func save(_ workspace: LocalWorkspace) throws {
        if let pathFailure { throw pathFailure }
        try workspace.validate()
        let previous = try existingData()
        if let previous { _ = try decoded(previous) }
        guard !hasRememberedRevision || previous == rememberedRevision else { throw WorkspaceError.revisionChanged }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(workspace)
        try SafePrivateStorageIO.write(data, to: url, expected: previous, maximumBytes: maximumBytes)
        hasObservedExistingFile = true
        rememberedRevision = data
        hasRememberedRevision = true
    }

    private func existingData() throws -> Data? {
        let data = try SafePrivateStorageIO.read(url, maximumBytes: maximumBytes)
        if data != nil {
            hasObservedExistingFile = true
        } else if hasObservedExistingFile {
            throw WorkspaceError.missingFile
        }
        return data
    }

    private func decoded(_ data: Data) throws -> LocalWorkspace {
        try validateKeys(data)
        let value = try JSONDecoder().decode(LocalWorkspace.self, from: data)
        try value.validate()
        return value
    }

    /// Codable ignores unknown fields. Reject them before rewriting so a newer
    /// or externally extended record cannot silently lose data in this version.
    private func validateKeys(_ data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw WorkspaceError.invalidData }
        func object(_ value: Any, allowed: Set<String>) throws -> [String: Any] {
            guard let object = value as? [String: Any], Set(object.keys).isSubset(of: allowed) else { throw WorkspaceError.invalidData }
            return object
        }
        func objects(_ value: Any?) throws -> [[String: Any]] {
            guard let value, !(value is NSNull) else { return [] }
            guard let array = value as? [[String: Any]] else { throw WorkspaceError.invalidData }
            return array
        }
        _ = try object(root, allowed: ["schemaVersion", "tasks", "currentTaskID", "defaultPinned", "panelSize", "conversations"])
        for chat in try objects(root["conversations"]) {
            _ = try object(chat, allowed: ["id", "title", "createdAt", "draft"])
        }
        for task in try objects(root["tasks"]) {
            _ = try object(task, allowed: ["id", "title", "completed", "resumeRecords", "subtasks", "executionPlan", "conversationDraft"])
            for subtask in try objects(task["subtasks"]) {
                _ = try object(subtask, allowed: ["id", "title", "completed"])
            }
            for record in try objects(task["resumeRecords"]) {
                _ = try object(record, allowed: ["id", "savedAt", "content", "evidenceIDs", "sessionID", "origin"])
                if let content = record["content"] {
                    _ = try object(content, allowed: ["progress", "nextStep", "materials"])
                }
            }
            if let rawPlan = task["executionPlan"], !(rawPlan is NSNull) {
                let plan = try object(rawPlan, allowed: ["version", "steps"])
                for step in try objects(plan["steps"]) {
                    _ = try object(step, allowed: ["id", "title", "executor", "acceptance", "dependencies"])
                }
            }
        }
    }
}
