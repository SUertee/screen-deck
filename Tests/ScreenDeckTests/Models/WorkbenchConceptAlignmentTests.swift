import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

final class WorkbenchConceptAlignmentTests: XCTestCase {
    private let sizes = [CGSize(width: 800, height: 560), CGSize(width: 1440, height: 900)]

    @MainActor
    func testNewChatWelcomeRendersWithoutChangingWorkspaceOrStartingCapture() async throws {
        let chat = LocalConversation(createdAt: Date(timeIntervalSince1970: 1))
        let fixture = try makeFixture(tasks: [backgroundTask()], conversations: [existingChat(), chat])
        fixture.navigation.route = .chat(chat.id)

        for size in sizes {
            try await render(fixture, size: size, name: "concept-new-chat")
            XCTAssertEqual(fixture.state.conversationDraft(for: .chat(chat.id)), "")
        }
    }

    @MainActor
    func testNewChatMultilineDraftRendersWithoutSavingOrSending() async throws {
        let draft = "先整理这次工作台的想法。\n确认范围和验收后再建立任务。\n这些文字仅保存在本地。"
        let chat = LocalConversation(createdAt: Date(timeIntervalSince1970: 1), draft: draft)
        let fixture = try makeFixture(tasks: [backgroundTask()], conversations: [existingChat(), chat])
        fixture.navigation.route = .chat(chat.id)

        for size in sizes {
            try await render(fixture, size: size, name: "concept-new-chat-draft")
            XCTAssertEqual(fixture.state.conversationDraft(for: .chat(chat.id)), draft)
        }
    }

    @MainActor
    func testAssignmentPlanRendersWithHumanAgentDependenciesAndLongText() async throws {
        let task = plannedTask(completed: false)
        try XCTUnwrap(task.executionPlan).validate()
        try await renderAssignment(task, name: "concept-assignment")
    }

    @MainActor
    func testCompletedParentKeepsAssignmentPlanAsDraftAndChildrenUnchanged() async throws {
        let task = plannedTask(completed: true)
        try await renderAssignment(task, name: "concept-assignment-completed")
    }

    @MainActor
    func testManualAssignmentRendersWithoutInventingAPlanOrCompletingSteps() async throws {
        let task = LocalTask(title: "整理原生工作台体验", subtasks: [
            Subtask(title: "核对新聊天的欢迎区与本地输入框", completed: true),
            Subtask(title: "在窄窗口检查分工列表的长标题、已完成标记和未完成项是否仍能清晰阅读"),
            Subtask(title: "人工确认交付")
        ], conversationDraft: "保留手动子任务，当前不启动执行。")
        try await renderAssignment(task, name: "concept-assignment-manual")
    }

    @MainActor
    func testEmptyAssignmentRendersWithoutCreatingStepsOrProgress() async throws {
        let task = LocalTask(title: "尚未安排分工的任务", conversationDraft: "还没有建立计划或子任务。")
        try await renderAssignment(task, name: "concept-assignment-empty")
    }

    private func backgroundTask() -> LocalTask {
        LocalTask(title: "保留已有任务", conversationDraft: "原任务草稿不应因浏览新聊天而变化。")
    }

    private func existingChat() -> LocalConversation {
        LocalConversation(title: "已有聊天", createdAt: Date(timeIntervalSince1970: 0), draft: "已有聊天的本地草稿。")
    }

    private func plannedTask(completed: Bool) -> LocalTask {
        let scope = PlannedStep(title: "确认本轮界面调整范围", executor: .human,
                                acceptance: "人工确认新聊天居中布局、分工阅读顺序和不接入执行器的边界。")
        let implementation = PlannedStep(
            title: "根据已确认的概念整理原生分工界面，并保留长标题、验收条件与依赖关系的完整内容",
            executor: .agent,
            acceptance: "在宽、窄两种窗口检查布局。" + String(repeating: "仅展示计划草稿，不把分工意图当作执行结果。", count: 4),
            dependencies: [scope.id])
        let review = PlannedStep(title: "审阅布局与验证证据", executor: .human,
                                 acceptance: "用户检查两种尺寸的画面，任务是否验收完成由用户明确决定。",
                                 dependencies: [scope.id, implementation.id])
        return LocalTask(title: "主工作台概念对齐", completed: completed,
                         subtasks: [Subtask(title: "整理本地界面资料", completed: true),
                                    Subtask(title: "人工检查两种窗口尺寸")],
                         executionPlan: ExecutionPlan(version: 2, steps: [scope, implementation, review]),
                         conversationDraft: "本轮只调整本地界面，保留原有草稿与任务记录。")
    }

    @MainActor
    private func renderAssignment(_ task: LocalTask, name: String) async throws {
        let fixture = try makeFixture(tasks: [task], conversations: [existingChat()])
        fixture.navigation.openTask(task.id)
        fixture.navigation.requestInspector(.assignment)

        for size in sizes {
            try await render(fixture, size: size, name: name)
            let rendered = try XCTUnwrap(fixture.state.tasks.first { $0.id == task.id })
            XCTAssertEqual(rendered.completed, task.completed)
            XCTAssertEqual(rendered.subtasks, task.subtasks)
            XCTAssertEqual(rendered.executionPlan, task.executionPlan)
            let summary = TaskProgressSummary(task: rendered)
            XCTAssertEqual(summary.completedCount, (task.subtasks ?? []).filter(\.completed).count)
            XCTAssertEqual(summary.totalCount, task.subtasks?.count ?? 0)
            XCTAssertEqual(summary.hasPlanDraft, task.executionPlan != nil,
                           "Completing the parent must not turn a plan into execution evidence")
            XCTAssertEqual(summary.plannedStepCount, task.executionPlan?.steps.count ?? 0)
            if task.subtasks?.isEmpty != false { XCTAssertNil(summary.fractionCompleted) }
            let assignment = TaskAssignmentPresentation(task: rendered)
            XCTAssertEqual(assignment.planVersion, task.executionPlan?.version)
            XCTAssertEqual(assignment.plannedSteps.map(\.statusLabel),
                           Array(repeating: "待确认", count: task.executionPlan?.steps.count ?? 0),
                           "All planned steps stay drafts even when the parent is completed")
            XCTAssertEqual(assignment.manualSteps.map(\.completed), (task.subtasks ?? []).map(\.completed))
        }
    }

    @MainActor
    private func makeFixture(tasks: [LocalTask], conversations: [LocalConversation]) throws -> ConceptRenderFixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = ConceptRenderStore(url: root.appendingPathComponent("workspace.json"))
        try store.save(LocalWorkspace(tasks: tasks,
                                      currentTaskID: tasks.first { !$0.completed }?.id,
                                      conversations: conversations))
        let state = AppState(store: store)
        state.refresh()
        let capture = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("sessions"), captureService: capture)
        memory.load()
        return ConceptRenderFixture(state: state, store: store, memory: memory,
                                    capture: capture, navigation: WorkbenchNavigation())
    }

    @MainActor
    private func render(_ fixture: ConceptRenderFixture, size: CGSize, name: String) async throws {
        _ = NSApplication.shared
        let tasks = fixture.state.tasks
        let chats = fixture.state.conversations
        let routes = tasks.map { WorkbenchRoute.task($0.id) } + chats.map { WorkbenchRoute.chat($0.id) }
        let drafts = routes.map { fixture.state.conversationDraft(for: $0) }
        let pending = routes.map { fixture.state.isConversationDraftUnsaved($0) }
        let currentTaskID = fixture.state.currentTaskID
        let deckRequest = fixture.state.deckTaskRequest
        let route = fixture.navigation.route
        let tab = fixture.navigation.inspectorTab
        let sidebarVisible = fixture.navigation.sidebarVisible
        let inspectorVisible = fixture.navigation.inspectorVisible
        let persistedBytes = try Data(contentsOf: fixture.store.url)
        let saveCount = fixture.store.saveCount

        let view = MainWorkbenchView(state: fixture.state, memory: fixture.memory, navigation: fixture.navigation)
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        defer { window.contentView = nil }
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(80))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(host.bounds.size, size)
        XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        XCTAssertGreaterThan(bitmap.pixelsHigh, 0)

        XCTAssertEqual(fixture.state.tasks, tasks)
        XCTAssertEqual(fixture.state.conversations, chats)
        XCTAssertEqual(routes.map { fixture.state.conversationDraft(for: $0) }, drafts)
        XCTAssertEqual(routes.map { fixture.state.isConversationDraftUnsaved($0) }, pending)
        XCTAssertFalse(fixture.state.hasUnsavedConversationDrafts)
        XCTAssertEqual(fixture.state.currentTaskID, currentTaskID)
        XCTAssertEqual(fixture.state.deckTaskRequest, deckRequest)
        XCTAssertEqual(fixture.navigation.route, route)
        XCTAssertEqual(fixture.navigation.inspectorTab, tab)
        XCTAssertEqual(fixture.navigation.sidebarVisible, sidebarVisible)
        XCTAssertEqual(fixture.navigation.inspectorVisible, inspectorVisible)
        XCTAssertEqual(fixture.store.saveCount, saveCount, "Rendering must not save even an identical workspace")
        XCTAssertEqual(try Data(contentsOf: fixture.store.url), persistedBytes)
        XCTAssertNil(fixture.memory.activeID)
        XCTAssertTrue(fixture.memory.sessions.isEmpty)
        XCTAssertFalse(fixture.memory.capturing)
        XCTAssertEqual(fixture.capture.requests, 0)
        XCTAssertEqual(fixture.capture.captures, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.memory.store.root.path))

        if let output = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"],
           !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let folder = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: folder.appendingPathComponent("\(name)-\(Int(size.width)).png"))
        }
    }
}

@MainActor
private struct ConceptRenderFixture {
    let state: AppState
    let store: ConceptRenderStore
    let memory: WorkSessionController
    let capture: SettingsCaptureFixture
    let navigation: WorkbenchNavigation
}

private final class ConceptRenderStore: WorkspaceStore {
    private let backing: LocalWorkspaceStore
    var url: URL { backing.url }
    private(set) var saveCount = 0

    init(url: URL) { backing = LocalWorkspaceStore(url: url) }
    func load() throws -> LocalWorkspace { try backing.load() }
    func save(_ workspace: LocalWorkspace) throws {
        try backing.save(workspace)
        saveCount += 1
    }
}
