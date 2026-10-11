import XCTest
@testable import ScreenDeck

/// Temporary stores only; these tests never instantiate the app delegate or user's stores.
final class ChatRoutingTests: XCTestCase {
    private let projectID = "project-11111111-1111-1111-1111-111111111111"

    @MainActor
    private func fixture() -> (AppState, ChatRoutingStore) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("chat-routing-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = ChatRoutingStore(url: root.appendingPathComponent("workspace.json"))
        let state = AppState(store: store)
        state.refresh()
        return (state, store)
    }

    @MainActor
    func testDefaultAndRepeatedNewChatNavigationDoNotPersistEmptyConversations() async {
        let (state, store) = fixture()
        let navigation = WorkbenchNavigation()
        XCTAssertEqual(navigation.route, .newChat)
        XCTAssertFalse(navigation.inspectorVisible)
        XCTAssertFalse(navigation.showsInspector(at: 800))
        XCTAssertFalse(navigation.showsInspector(at: 1440))
        for _ in 0..<10 {
            navigation.openNewChat()
            XCTAssertNil(state.startConversationDraft(text: ""))
        }
        XCTAssertEqual(navigation.route, .newChat)
        XCTAssertTrue(state.conversations.isEmpty)
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(store.writeAttempts, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    @MainActor
    func testFirstTypingCreatesOneChatAndFollowingEditsUseItsIdentity() async throws {
        let (state, store) = fixture()
        let navigation = WorkbenchNavigation()
        let chatID = try XCTUnwrap(state.startConversationDraft(text: "先记一个想法"))
        navigation.route = .chat(chatID)
        XCTAssertTrue(state.saveConversationDraft(route: navigation.route, text: "先记一个想法，再补充要求"))
        XCTAssertEqual(state.conversations.count, 1)
        XCTAssertEqual(state.conversationDraft(for: .chat(chatID)), "先记一个想法，再补充要求")
        XCTAssertEqual(state.conversationDraft(for: .newChat), "")
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        let restarted = AppState(store: store)
        restarted.refresh()
        XCTAssertEqual(restarted.conversations.first?.id, chatID)
        XCTAssertEqual(restarted.conversations.first?.draft, "先记一个想法，再补充要求")
        XCTAssertEqual(restarted.tasks.count, 0)
    }

    @MainActor
    func testFailedFirstTypingKeepsLatestPendingInputAndRetryPersistsOnlyOnce() async throws {
        let (state, store) = fixture()
        store.failWrites = true
        XCTAssertNil(state.startConversationDraft(text: "第一版输入"))
        XCTAssertNil(state.startConversationDraft(text: "最新输入\n第二行"))
        XCTAssertTrue(state.conversations.isEmpty)
        XCTAssertEqual(state.conversationDraft(for: .newChat), "最新输入\n第二行")
        XCTAssertTrue(state.isConversationDraftUnsaved(.newChat))
        XCTAssertFalse(state.retryConversationDrafts())
        XCTAssertEqual(state.conversationDraft(for: .newChat), "最新输入\n第二行")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        store.failWrites = false
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(state.conversations.count, 1)
        XCTAssertEqual(state.conversations.first?.draft, "最新输入\n第二行")
        let attempts = store.writeAttempts
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertEqual(store.writeAttempts, attempts)
        let restarted = AppState(store: store)
        restarted.refresh()
        XCTAssertEqual(restarted.conversations, state.conversations)
    }

    @MainActor
    func testClearingOrDiscardingFailedWelcomeInputDoesNotWriteAChat() async {
        let (state, store) = fixture()
        store.failWrites = true
        XCTAssertNil(state.startConversationDraft(text: "未保存的输入"))
        let attempts = store.writeAttempts
        XCTAssertNil(state.startConversationDraft(text: ""))
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(state.conversationDraft(for: .newChat), "")
        XCTAssertEqual(store.writeAttempts, attempts)
        XCTAssertNil(state.startConversationDraft(text: "重新输入"))
        state.discardUnsavedConversationDrafts()
        XCTAssertEqual(state.conversationDraft(for: .newChat), "")
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertTrue(state.conversations.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    @MainActor
    func testUnavailableWorkspaceBuffersFirstInputWithoutAttemptingWrites() async {
        let (state, store) = fixture()
        store.failReads = true
        state.refresh()
        XCTAssertFalse(state.dataAvailable)
        XCTAssertNil(state.startConversationDraft(text: "等重新读取后再保存"))
        XCTAssertEqual(store.writeAttempts, 0)
        XCTAssertEqual(state.conversationDraft(for: .newChat), "等重新读取后再保存")
        XCTAssertFalse(state.retryConversationDrafts())
        store.failReads = false
        state.refresh()
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertEqual(state.conversations.first?.draft, "等重新读取后再保存")
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
    }

    @MainActor
    func testExplicitLaunchProjectNavigatesOnlyAtUnchangedRevision() async {
        let navigation = WorkbenchNavigation()
        navigation.sidebarVisible = false
        let revision = navigation.routingRevision
        XCTAssertTrue(navigation.openLaunchProject(projectID, taskID: "task-001", expectedRevision: revision))
        XCTAssertEqual(navigation.route, .project(projectID, taskID: "task-001"))
        XCTAssertEqual(navigation.inspectorTab, .overview)
        XCTAssertFalse(navigation.sidebarVisible)
        XCTAssertTrue(navigation.showsInspector(at: 1440))
        XCTAssertFalse(navigation.showsInspector(at: 800), "Opening a task must not cover the narrow conversation")
        XCTAssertFalse(navigation.openLaunchProject(projectID, taskID: nil, expectedRevision: revision))
        XCTAssertEqual(navigation.route, .project(projectID, taskID: "task-001"))
    }

    @MainActor
    func testDelayedProjectLoadCannotStealNewerNavigationEvenAfterReturningToNewChat() async {
        let navigation = WorkbenchNavigation()
        let launchRevision = navigation.routingRevision
        navigation.route = .timeline
        navigation.openNewChat()
        XCTAssertFalse(navigation.openLaunchProject(projectID, taskID: "task-001", expectedRevision: launchRevision))
        XCTAssertEqual(navigation.route, .newChat)
        XCTAssertFalse(navigation.inspectorVisible)
    }

    @MainActor
    func testNarrowInspectorRequiresExplicitRequestAndNewContextResetsIt() async {
        let navigation = WorkbenchNavigation()
        navigation.openTask(UUID())
        XCTAssertTrue(navigation.showsInspector(at: 1080))
        XCTAssertFalse(navigation.showsInspector(at: 1079))
        navigation.requestInspector(.timeline)
        XCTAssertTrue(navigation.showsInspector(at: 800))
        XCTAssertEqual(navigation.inspectorTab, .timeline)
        navigation.toggleInspector(at: 800)
        XCTAssertFalse(navigation.showsInspector(at: 800))
        XCTAssertFalse(navigation.inspectorRequestedOnNarrow)
        navigation.toggleInspector(at: 800)
        XCTAssertTrue(navigation.showsInspector(at: 800))
        navigation.openTask(UUID())
        XCTAssertFalse(navigation.showsInspector(at: 800))
        XCTAssertEqual(navigation.inspectorTab, .overview)
        navigation.requestInspector(.delivery)
        navigation.openNewChat()
        XCTAssertFalse(navigation.inspectorVisible)
        XCTAssertFalse(navigation.inspectorRequestedOnNarrow)
    }

    /// Guard the actual app wiring, not merely the pure policy, without launching real user stores.
    func testOrdinaryStartupLoadsAssociationsWithoutRestoringARecordRoute() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/ScreenDeck/App/ScreenDeckApp.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "func applicationDidFinishLaunching"))
        let end = try XCTUnwrap(source.range(of: "func showWorkbench", range: start.upperBound..<source.endIndex))
        let startup = String(source[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(startup.contains("showWorkbench()"))
        XCTAssertFalse(startup.contains("showWorkbench(taskID: state.currentTaskID)"))
        XCTAssertTrue(startup.contains("if explicitProjectOpened, let selection = projects.selection"))
        XCTAssertTrue(startup.contains("expectedRevision: launchRevision"))
        XCTAssertFalse(startup.contains("workbenchNavigation.route = .project"))
    }
}

private final class ChatRoutingStore: WorkspaceStore {
    private let backing: LocalWorkspaceStore
    var url: URL { backing.url }
    var failWrites = false
    var failReads = false
    private(set) var writeAttempts = 0
    init(url: URL) { backing = LocalWorkspaceStore(url: url) }
    func load() throws -> LocalWorkspace {
        if failReads { throw CocoaError(.fileReadNoPermission) }
        return try backing.load()
    }
    func save(_ workspace: LocalWorkspace) throws {
        writeAttempts += 1
        if failWrites { throw CocoaError(.fileWriteNoPermission) }
        try backing.save(workspace)
    }
}
