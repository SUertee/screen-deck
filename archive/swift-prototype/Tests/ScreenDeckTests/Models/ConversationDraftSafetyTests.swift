import XCTest
@testable import ScreenDeck

final class ConversationDraftSafetyTests: XCTestCase {
    @MainActor
    private func fixture() throws -> (AppState, SwitchableDraftStore, WorkbenchRoute, WorkbenchRoute) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = SwitchableDraftStore(url: root.appendingPathComponent("workspace.json"))
        // Task and chat IDs can overlap; their drafts must remain independent.
        let id = UUID()
        let task = LocalTask(id: id, title: "临时任务", conversationDraft: "已保存的任务草稿")
        let chat = LocalConversation(id: id, draft: "已保存的聊天草稿")
        try store.save(LocalWorkspace(tasks: [task], currentTaskID: id, conversations: [chat]))
        let state = AppState(store: store)
        state.refresh()
        return (state, store, .task(id), .chat(id))
    }

    @MainActor
    func testFailedWritesKeepLatestDraftsSeparateFromPersistedData() async throws {
        let (state, store, task, chat) = try fixture()
        let originalBytes = try Data(contentsOf: store.url)
        store.failWrites = true

        XCTAssertFalse(state.saveConversationDraft(route: task, text: "第一版"))
        XCTAssertFalse(state.saveConversationDraft(route: chat, text: "未保存的聊天"))
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "最新任务输入\n第二行"))

        XCTAssertEqual(state.conversationDraft(for: task), "最新任务输入\n第二行")
        XCTAssertEqual(state.conversationDraft(for: chat), "未保存的聊天")
        XCTAssertTrue(state.hasUnsavedConversationDrafts)
        XCTAssertTrue(state.isConversationDraftUnsaved(task))
        XCTAssertTrue(state.isConversationDraftUnsaved(chat))
        XCTAssertEqual(state.tasks.first?.conversationDraft, "已保存的任务草稿")
        XCTAssertEqual(state.conversations.first?.draft, "已保存的聊天草稿")
        XCTAssertEqual(try Data(contentsOf: store.url), originalBytes)
        XCTAssertNotNil(state.operationError)

        let restored = AppState(store: store)
        restored.refresh()
        XCTAssertEqual(restored.conversationDraft(for: task), "已保存的任务草稿")
        XCTAssertEqual(restored.conversationDraft(for: chat), "已保存的聊天草稿")
        XCTAssertFalse(restored.hasUnsavedConversationDrafts)
    }

    @MainActor
    func testRefreshAndUnrelatedSuccessfulCommitPreservePendingInput() async throws {
        let (state, store, task, chat) = try fixture()
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "尚未保存"))
        state.refresh()
        XCTAssertTrue(state.isConversationDraftUnsaved(task))
        XCTAssertEqual(state.conversationDraft(for: task), "尚未保存")

        store.failWrites = false
        XCTAssertTrue(state.renameTask(id: try XCTUnwrap(state.tasks.first?.id), title: "已改名"))
        XCTAssertTrue(state.isConversationDraftUnsaved(task))
        XCTAssertEqual(state.conversationDraft(for: task), "尚未保存")
        XCTAssertEqual(state.conversationDraft(for: chat), "已保存的聊天草稿")
        XCTAssertEqual(try store.load().tasks.first?.conversationDraft, "已保存的任务草稿")
        XCTAssertEqual(try store.load().tasks.first?.title, "已改名")
    }

    @MainActor
    func testRetryPreservesAllDraftsOnFailureAndPersistsThemTogetherOnRecovery() async throws {
        let (state, store, task, chat) = try fixture()
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "任务重试"))
        XCTAssertFalse(state.saveConversationDraft(route: chat, text: "聊天重试"))
        XCTAssertFalse(state.retryConversationDrafts())
        XCTAssertTrue(state.isConversationDraftUnsaved(task))
        XCTAssertTrue(state.isConversationDraftUnsaved(chat))
        XCTAssertEqual(try store.load().tasks.first?.conversationDraft, "已保存的任务草稿")
        XCTAssertEqual(try store.load().conversations?.first?.draft, "已保存的聊天草稿")

        store.failWrites = false
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertFalse(state.isConversationDraftUnsaved(task))
        XCTAssertFalse(state.isConversationDraftUnsaved(chat))
        XCTAssertNil(state.operationError)
        let restored = AppState(store: store)
        restored.refresh()
        XCTAssertEqual(restored.conversationDraft(for: task), "任务重试")
        XCTAssertEqual(restored.conversationDraft(for: chat), "聊天重试")
        let attempts = store.writeAttempts
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertEqual(store.writeAttempts, attempts)
    }

    @MainActor
    func testSuccessfulIndividualSaveClearsOnlyItsOwnPendingDraft() async throws {
        let (state, store, task, chat) = try fixture()
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "任务未保存"))
        XCTAssertFalse(state.saveConversationDraft(route: chat, text: "聊天未保存"))
        store.failWrites = false

        XCTAssertTrue(state.saveConversationDraft(route: task, text: "任务最终版本"))
        XCTAssertFalse(state.isConversationDraftUnsaved(task))
        XCTAssertTrue(state.isConversationDraftUnsaved(chat))
        XCTAssertTrue(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(state.conversationDraft(for: task), "任务最终版本")
        XCTAssertEqual(state.conversationDraft(for: chat), "聊天未保存")
        XCTAssertEqual(try store.load().tasks.first?.conversationDraft, "任务最终版本")
        XCTAssertEqual(try store.load().conversations?.first?.draft, "已保存的聊天草稿")
    }

    @MainActor
    func testDiscardRevealsPersistedDraftsWithoutWriting() async throws {
        let (state, store, task, chat) = try fixture()
        let originalBytes = try Data(contentsOf: store.url)
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "丢弃任务输入"))
        XCTAssertFalse(state.saveConversationDraft(route: chat, text: "丢弃聊天输入"))
        let attempts = store.writeAttempts

        state.discardUnsavedConversationDrafts()

        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertFalse(state.isConversationDraftUnsaved(task))
        XCTAssertFalse(state.isConversationDraftUnsaved(chat))
        XCTAssertEqual(state.conversationDraft(for: task), "已保存的任务草稿")
        XCTAssertEqual(state.conversationDraft(for: chat), "已保存的聊天草稿")
        XCTAssertEqual(store.writeAttempts, attempts)
        XCTAssertEqual(try Data(contentsOf: store.url), originalBytes)
    }

    @MainActor
    func testEmptyPendingDraftRemainsEmptyThroughRefreshAndRetry() async throws {
        let (state, store, task, _) = try fixture()
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: ""))
        state.refresh()
        XCTAssertTrue(state.isConversationDraftUnsaved(task))
        XCTAssertEqual(state.conversationDraft(for: task), "")
        XCTAssertEqual(state.tasks.first?.conversationDraft, "已保存的任务草稿")

        store.failWrites = false
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(try store.load().tasks.first?.conversationDraft, "")
    }

    @MainActor
    func testFailedRefreshBlocksWritesButKeepsLatestInputUntilReload() async throws {
        let (state, store, task, _) = try fixture()
        store.failReads = true
        state.refresh()
        XCTAssertFalse(state.dataAvailable)
        let attempts = store.writeAttempts
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "读取失败时的输入"))
        XCTAssertFalse(state.retryConversationDrafts())
        XCTAssertEqual(store.writeAttempts, attempts)
        XCTAssertEqual(state.conversationDraft(for: task), "读取失败时的输入")
        XCTAssertTrue(state.isConversationDraftUnsaved(task))

        store.failReads = false
        state.refresh()
        XCTAssertEqual(state.conversationDraft(for: task), "读取失败时的输入")
        XCTAssertTrue(state.retryConversationDrafts())
        XCTAssertEqual(try store.load().tasks.first?.conversationDraft, "读取失败时的输入")
    }

    @MainActor
    func testMissingDraftTargetDoesNotSilentlyDropPendingInput() async throws {
        let (state, store, task, _) = try fixture()
        store.failWrites = true
        XCTAssertFalse(state.saveConversationDraft(route: task, text: "保留直到明确丢弃"))
        store.failWrites = false
        try store.save(LocalWorkspace())
        state.refresh()

        XCTAssertFalse(state.retryConversationDrafts())
        XCTAssertTrue(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(state.conversationDraft(for: task), "保留直到明确丢弃")
        XCTAssertTrue(try store.load().tasks.isEmpty)
        XCTAssertNotNil(state.operationError)
        state.discardUnsavedConversationDrafts()
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(state.conversationDraft(for: task), "")
    }

    @MainActor
    func testNonConversationRoutesDoNotCreatePendingDrafts() async throws {
        let (state, store, _, _) = try fixture()
        let attempts = store.writeAttempts
        for route in [WorkbenchRoute.tasks, .search, .timeline] {
            XCTAssertFalse(state.saveConversationDraft(route: route, text: "不可写入"))
            XCTAssertFalse(state.isConversationDraftUnsaved(route))
            XCTAssertEqual(state.conversationDraft(for: route), "")
        }
        XCTAssertFalse(state.hasUnsavedConversationDrafts)
        XCTAssertEqual(store.writeAttempts, attempts)
    }
}

private final class SwitchableDraftStore: WorkspaceStore {
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
