import Foundation
import Combine
import CoreFoundation

struct ProjectConversationKey: Hashable, Sendable {
    let projectID: String
    let taskID: String?

    func validated() throws -> ProjectConversationKey {
        guard projectID.range(of: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
            throw ProjectConversationFailure.invalidData
        }
        if let taskID, taskID.range(of: "^task-[0-9]{3,}$", options: .regularExpression) == nil {
            throw ProjectConversationFailure.invalidData
        }
        return self
    }
}

struct ProjectConversationDraft: Codable, Equatable, Sendable {
    let projectID: String
    let taskID: String?
    var text: String
    var key: ProjectConversationKey { .init(projectID: projectID, taskID: taskID) }
}

struct ProjectConversationState: Codable, Equatable, Sendable {
    var version = 1
    var drafts: [ProjectConversationDraft] = []

    func validated() throws -> ProjectConversationState {
        guard version == 1, drafts.count <= 1000 else { throw ProjectConversationFailure.invalidData }
        var keys = Set<ProjectConversationKey>()
        for draft in drafts {
            let key = try draft.key.validated()
            guard keys.insert(key).inserted else { throw ProjectConversationFailure.invalidData }
            guard draft.text.utf8.count <= 64 * 1024 else { throw ProjectConversationFailure.tooLarge }
        }
        return self
    }

    mutating func set(_ text: String, for key: ProjectConversationKey) {
        if let index = drafts.firstIndex(where: { $0.key == key }) {
            drafts[index].text = text
        } else {
            drafts.append(.init(projectID: key.projectID, taskID: key.taskID, text: text))
        }
    }
}

enum ProjectConversationFailure: LocalizedError {
    case invalidData, tooLarge, unsafeFile, revisionChanged, missingFile

    var errorDescription: String? {
        switch self {
        case .invalidData: return "项目对话草稿损坏或版本不受支持，原文件未覆盖。"
        case .tooLarge: return "单份草稿超过 64 KiB 或草稿文件超过 2 MiB，输入仍保留在本次会话中。"
        case .unsafeFile: return "项目对话草稿位置不是普通文件，原位置未覆盖。"
        case .revisionChanged: return "项目对话草稿已被其他窗口或程序修改；请重新读取后重试，当前输入仍保留。"
        case .missingFile: return "已读取的项目对话草稿文件已丢失或移动，请恢复原文件后重试；当前输入仍保留，不会创建空草稿文件。"
        }
    }
}

protocol ProjectConversationStoring {
    var url: URL { get }
    func load() throws -> ProjectConversationState
    func save(_ state: ProjectConversationState, replacing expected: ProjectConversationState) throws
}

/// Local unsent drafts only. Source .screendeck records and legacy workspace.json are never modified.
final class ProjectConversationStore: ProjectConversationStoring {
    let url: URL
    private let pathFailure: Error?
    private let maximumBytes = 2 * 1024 * 1024
    private var hasObservedExistingFile: Bool

    init(url: URL? = nil, requireExistingFile: Bool = false) {
        hasObservedExistingFile = requireExistingFile
        do { self.url = try url ?? ScreenDeckPaths().activeProjectConversations(); pathFailure = nil }
        catch { self.url = ScreenDeckPaths().projectConversations; pathFailure = error }
    }

    func load() throws -> ProjectConversationState {
        if let pathFailure { throw pathFailure }
        guard let data = try existingData() else { return ProjectConversationState() }
        return try decode(data)
    }

    private func decode(_ data: Data) throws -> ProjectConversationState {
        do {
            try validateKeys(data)
            return try JSONDecoder().decode(ProjectConversationState.self, from: data).validated()
        } catch let error as ProjectConversationFailure { throw error }
        catch { throw ProjectConversationFailure.invalidData }
    }

    func save(_ state: ProjectConversationState, replacing expected: ProjectConversationState) throws {
        let state = try state.validated()
        // Refuse damaged, unknown or changed revisions even after an earlier successful load.
        if let pathFailure { throw pathFailure }
        let previous = try existingData()
        guard try previous.map(decode) ?? ProjectConversationState() == expected else { throw ProjectConversationFailure.revisionChanged }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        guard data.count <= maximumBytes else { throw ProjectConversationFailure.tooLarge }
        try SafePrivateStorageIO.write(data, to: url, expected: previous, maximumBytes: maximumBytes)
        hasObservedExistingFile = true
    }

    private func existingData() throws -> Data? {
        let data = try SafePrivateStorageIO.read(url, maximumBytes: maximumBytes)
        if data != nil {
            hasObservedExistingFile = true
        } else if hasObservedExistingFile {
            throw ProjectConversationFailure.missingFile
        }
        return data
    }

    private func validateKeys(_ data: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["version", "drafts"],
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let drafts = object["drafts"] as? [[String: Any]], drafts.count <= 1000 else {
            throw ProjectConversationFailure.invalidData
        }
        for draft in drafts {
            guard Set(draft.keys).isSubset(of: ["projectID", "taskID", "text"]),
                  draft["projectID"] is String, draft["text"] is String else {
                throw ProjectConversationFailure.invalidData
            }
            if let taskID = draft["taskID"], !(taskID is NSNull), !(taskID is String) {
                throw ProjectConversationFailure.invalidData
            }
        }
    }
}

@MainActor
final class ProjectConversationController: ObservableObject {
    @Published private(set) var error: String?
    @Published private(set) var isLoaded = false
    @Published private var pending: [ProjectConversationKey: String] = [:]
    @Published private var persisted = ProjectConversationState()
    let store: any ProjectConversationStoring

    /// Construction and rendering do no I/O. The owner explicitly loads at startup or on retry.
    init(store: (any ProjectConversationStoring)? = nil) {
        self.store = store ?? ProjectConversationStore()
    }

    var hasUnsavedDrafts: Bool { !pending.isEmpty }

    @discardableResult
    func load() async -> Bool {
        do {
            persisted = try store.load().validated()
            isLoaded = true
            error = nil
            return true
        } catch {
            isLoaded = false
            self.error = "项目对话草稿读取失败：\(error.localizedDescription)"
            return false
        }
    }

    func draft(projectID: String, taskID: String?) -> String {
        let key = ProjectConversationKey(projectID: projectID, taskID: taskID)
        if let text = pending[key] { return text }
        return persisted.drafts.first(where: { $0.key == key })?.text ?? ""
    }

    func isDraftUnsaved(projectID: String, taskID: String?) -> Bool {
        pending[ProjectConversationKey(projectID: projectID, taskID: taskID)] != nil
    }

    @discardableResult
    func saveDraft(projectID: String, taskID: String?, text: String) -> Bool {
        let key = ProjectConversationKey(projectID: projectID, taskID: taskID)
        do { _ = try key.validated() }
        catch { self.error = error.localizedDescription; return false }
        pending[key] = text
        guard isLoaded else {
            error = "项目对话草稿尚未正常读取，当前输入仅保留在本次会话中。"
            return false
        }
        var proposed = persisted
        proposed.set(text, for: key)
        do {
            if proposed != persisted { try store.save(proposed, replacing: persisted) }
            persisted = proposed
            pending[key] = nil
            error = nil
            return true
        } catch {
            invalidateLoadedRevisionIfNeeded(error)
            self.error = "项目对话草稿未保存：\(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    func retryDrafts() -> Bool {
        guard hasUnsavedDrafts else { return true }
        guard isLoaded else {
            error = "请先重新读取项目对话草稿，当前输入仍保留。"
            return false
        }
        var proposed = persisted
        for (key, text) in pending { proposed.set(text, for: key) }
        do {
            try store.save(proposed, replacing: persisted)
            persisted = proposed
            pending.removeAll()
            error = nil
            return true
        } catch {
            invalidateLoadedRevisionIfNeeded(error)
            self.error = "项目对话草稿未保存：\(error.localizedDescription)"
            return false
        }
    }

    private func invalidateLoadedRevisionIfNeeded(_ error: Error) {
        guard let failure = error as? ProjectConversationFailure else { return }
        switch failure {
        case .invalidData, .unsafeFile, .revisionChanged, .missingFile: isLoaded = false
        case .tooLarge: break
        }
    }

    func discardUnsavedDrafts() {
        pending.removeAll()
        if isLoaded { error = nil }
    }
}
