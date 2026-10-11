import Foundation
import Combine

enum DeckState: Equatable { case collapsed, peeked, expanded }

@MainActor
final class AppState: ObservableObject {
    var requestedSettingsSection: SettingsSection = .general
    @Published private(set) var tasks: [LocalTask] = []
    @Published private(set) var conversations: [LocalConversation] = []
    @Published private(set) var currentTaskID: UUID?
    @Published private(set) var defaultPinned = false
    @Published private(set) var dataAvailable = false
    @Published private(set) var statusMessage = "正在读取本地任务…"
    @Published private(set) var operationError: String?
    @Published var deckState: DeckState = .collapsed
    @Published private(set) var deckTaskRequest: DeckTaskRequest?
    @Published private(set) var isEditingTask = false
    @Published var isPanelPinned = false
    @Published private(set) var panelSize: CGSize?
    // Failed draft writes stay separate from the last successfully persisted workspace.
    @Published private var unsavedConversationDrafts: [WorkbenchRoute: String] = [:]
    private let store: any WorkspaceStore
    private let configurationStore: ConfigurationStore?
    private var workspace = LocalWorkspace()
    var storageURL: URL { store.url }
    var currentTask: LocalTask? { tasks.first { $0.id == currentTaskID } }
    var hasUnsavedConversationDrafts: Bool { !unsavedConversationDrafts.isEmpty }

    init(store: any WorkspaceStore = LocalWorkspaceStore(), configurationStore: ConfigurationStore? = nil) {
        self.store = store; self.configurationStore = configurationStore
    }

    func refresh() {
        guard !isEditingTask else { return }
        do {
            let loaded = try store.load()
            apply(loaded)
            if let configurationStore { defaultPinned = try configurationStore.loadUser().configuration.general.defaultPinned }
            isPanelPinned = defaultPinned
            dataAvailable = true
            operationError = nil
            statusMessage = loaded.tasks.isEmpty ? "创建一个任务，开始记录你的工作。" : "本地任务已读取"
        } catch {
            dataAvailable = false
            statusMessage = "读取失败：\(error.localizedDescription)"
        }
    }

    private func apply(_ value: LocalWorkspace) {
        workspace = value
        tasks = value.tasks
        conversations = value.conversations ?? []
        currentTaskID = value.currentTaskID
        if configurationStore == nil { defaultPinned = value.defaultPinned }
        panelSize = value.panelSize
    }

    @discardableResult
    private func commit(_ value: LocalWorkspace) -> Bool {
        guard dataAvailable else { return false }
        do {
            try store.save(value)
            apply(value)
            operationError = nil
            return true
        } catch {
            operationError = "保存失败：\(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    func createTask(title: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { operationError = WorkspaceError.emptyTitle.localizedDescription; return false }
        var next = workspace
        let task = LocalTask(title: title)
        next.tasks.append(task)
        if next.tasks.count == 1 { next.currentTaskID = task.id }
        return commit(next)
    }

    @discardableResult
    func createConversation(draft: String = "") -> UUID? {
        let chat = LocalConversation(draft: draft)
        var next = workspace
        next.conversations = (next.conversations ?? []) + [chat]
        return commit(next) ? chat.id : nil
    }

    /// The welcome page is transient. Persist a chat only when it actually has input.
    @discardableResult
    func startConversationDraft(text: String) -> UUID? {
        guard !text.isEmpty else {
            unsavedConversationDrafts.removeValue(forKey: .newChat)
            return nil
        }
        unsavedConversationDrafts[.newChat] = text
        guard let id = createConversation(draft: text) else { return nil }
        unsavedConversationDrafts.removeValue(forKey: .newChat)
        return id
    }

    @discardableResult
    func saveConversationDraft(route: WorkbenchRoute, text: String) -> Bool {
        switch route {
        case .task, .chat: break
        default: return false
        }
        unsavedConversationDrafts[route] = text
        var next = workspace
        guard updateConversationDraft(text, for: route, in: &next), commit(next) else { return false }
        unsavedConversationDrafts.removeValue(forKey: route)
        return true
    }

    func conversationDraft(for route: WorkbenchRoute) -> String {
        if let draft = unsavedConversationDrafts[route] { return draft }
        switch route {
        case .task(let id): return tasks.first { $0.id == id }?.conversationDraft ?? ""
        case .chat(let id): return conversations.first { $0.id == id }?.draft ?? ""
        default: return ""
        }
    }

    func isConversationDraftUnsaved(_ route: WorkbenchRoute) -> Bool {
        unsavedConversationDrafts[route] != nil
    }

    func discardUnsavedConversationDrafts() {
        unsavedConversationDrafts.removeAll()
    }

    @discardableResult
    func retryConversationDrafts() -> Bool {
        guard hasUnsavedConversationDrafts else { return true }
        var next = workspace
        for (route, text) in unsavedConversationDrafts {
            if route == .newChat {
                if !text.isEmpty { next.conversations = (next.conversations ?? []) + [LocalConversation(draft: text)] }
                continue
            }
            guard updateConversationDraft(text, for: route, in: &next) else { return false }
        }
        guard commit(next) else { return false }
        unsavedConversationDrafts.removeAll()
        return true
    }

    private func updateConversationDraft(_ text: String, for route: WorkbenchRoute, in next: inout LocalWorkspace) -> Bool {
        switch route {
        case .task(let id):
            guard let index = next.tasks.firstIndex(where: { $0.id == id }) else {
                operationError = "草稿尚未保存：对应任务已不可用。"
                return false
            }
            next.tasks[index].conversationDraft = text
        case .chat(let id):
            guard let index = next.conversations?.firstIndex(where: { $0.id == id }) else {
                operationError = "草稿尚未保存：对应聊天已不可用。"
                return false
            }
            next.conversations?[index].draft = text
        default: return false
        }
        return true
    }

    @discardableResult
    func renameTask(id: UUID, title: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { operationError = WorkspaceError.emptyTitle.localizedDescription; return false }
        var next = workspace
        guard let index = next.tasks.firstIndex(where: { $0.id == id }) else { return false }
        next.tasks[index].title = title
        return commit(next)
    }

    func selectTask(_ task: LocalTask) {
        guard !isEditingTask, !task.completed else { return }
        var next = workspace
        next.currentTaskID = task.id
        commit(next)
    }

    func toggle(_ task: LocalTask) {
        guard !isEditingTask else { return }
        var next = workspace
        guard let index = next.tasks.firstIndex(where: { $0.id == task.id }) else { return }
        next.tasks[index].completed.toggle()
        if next.tasks[index].completed && next.currentTaskID == task.id { next.currentTaskID = nil }
        commit(next)
    }

    func setDefaultPinned(_ value: Bool) {
        if let configurationStore {
            guard dataAvailable else { return }
            do {
                let snapshot = try configurationStore.loadUser()
                var proposed = snapshot.configuration
                proposed.general.defaultPinned = value
                _ = try configurationStore.saveUser(proposed, expectedDigest: snapshot.digest)
                defaultPinned = value; isPanelPinned = value; operationError = nil
            } catch { operationError = "设置未保存：\(error.localizedDescription)" }
            return
        }
        var next = workspace
        next.defaultPinned = value
        if commit(next) { isPanelPinned = value }
    }

    func setEditingTask(_ value: Bool) {
        isEditingTask = value
        if value { operationError = nil }
    }

    @discardableResult
    func focusTaskInDeck(_ id: UUID) -> Bool {
        guard !isEditingTask, let task = tasks.first(where: { $0.id == id && !$0.completed }) else { return false }
        var next = workspace
        next.currentTaskID = task.id
        guard commit(next) else { return false }
        deckTaskRequest = DeckTaskRequest(taskID: id)
        deckState = .expanded
        return true
    }

    func setPanelSize(_ size: CGSize?) {
        var next = workspace
        next.panelSize = size
        commit(next)
    }

    @discardableResult
    func addSubtask(taskID: UUID, title: String) -> Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { operationError = WorkspaceError.emptyTitle.localizedDescription; return false }
        var next = workspace
        guard let index = next.tasks.firstIndex(where: { $0.id == taskID && !$0.completed }) else { return false }
        next.tasks[index].subtasks = (next.tasks[index].subtasks ?? []) + [Subtask(title: title)]
        return commit(next)
    }

    func toggleSubtask(taskID: UUID, subtaskID: UUID) {
        var next = workspace
        guard let index = next.tasks.firstIndex(where: { $0.id == taskID && !$0.completed }),
              let child = next.tasks[index].subtasks?.firstIndex(where: { $0.id == subtaskID }) else { return }
        next.tasks[index].subtasks?[child].completed.toggle()
        commit(next)
    }

    @discardableResult
    func saveResume(taskID: UUID, content: ResumeContent, requestID: UUID, now: Date = Date(), evidenceIDs: [UUID]? = nil, sessionID: UUID? = nil, origin: String? = nil) -> Bool {
        do {
            guard currentTaskID == taskID,
                  let index = workspace.tasks.firstIndex(where: { $0.id == taskID && !$0.completed })
            else { throw ResumeError.unavailableTask }
            if workspace.tasks[index].resumeRecords?.contains(where: { $0.id == requestID }) == true { return true }
            let clean = try content.validated()
            var next = workspace
            let record = ResumeRecord(id: requestID, savedAt: now, content: clean, evidenceIDs: evidenceIDs, sessionID: sessionID, origin: origin)
            next.tasks[index].resumeRecords = (next.tasks[index].resumeRecords ?? []) + [record]
            return commit(next)
        } catch {
            operationError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func resumeTask(id: UUID) -> Bool {
        guard !isEditingTask,
              let task = workspace.tasks.first(where: { $0.id == id && !$0.completed }),
              task.latestResume != nil else { return false }
        var next = workspace
        next.currentTaskID = id
        return commit(next)
    }
}
