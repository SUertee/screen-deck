import XCTest
@testable import ScreenDeck

final class ProjectConversationTests: XCTestCase {
    private let first = "project-11111111-1111-1111-1111-111111111111"
    private let second = "project-22222222-2222-2222-2222-222222222222"

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("project-conversation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func store(_ root: URL) -> ProjectConversationStore {
        .init(url: root.appendingPathComponent("global/project-conversations.json"))
    }

    func testRoundTripSeparatesProjectsAndProjectRootFromTasks() throws {
        let root = try directory()
        let store = store(root)
        XCTAssertEqual(try store.load(), .init())
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        let state = ProjectConversationState(drafts: [
            .init(projectID: first, taskID: nil, text: "项目讨论"),
            .init(projectID: first, taskID: "task-001", text: "第一个项目\n任务输入"),
            .init(projectID: second, taskID: "task-001", text: "另一个项目")
        ])
        try store.save(state, replacing: .init())
        XCTAssertEqual(try store.load(), state)
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: store.url)) as? [String: Any])
        XCTAssertEqual(Set(keys.keys), ["version", "drafts"])
        let permissions = try FileManager.default.attributesOfItem(atPath: store.url.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testInvalidVersionUnknownKeysBooleanVersionAndCorruptionNeverOverwrite() throws {
        let root = try directory()
        let store = store(root)
        try FileManager.default.createDirectory(at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        for text in ["broken", "{\"version\":2,\"drafts\":[]}", "{\"version\":true,\"drafts\":[]}",
                     "{\"version\":1,\"drafts\":[],\"messages\":[]}",
                     "{\"version\":1,\"drafts\":[{\"projectID\":\"\(first)\",\"text\":\"x\",\"command\":\"x\"}]}"] {
            let original = Data(text.utf8)
            try original.write(to: store.url)
            XCTAssertThrowsError(try store.load())
            XCTAssertThrowsError(try store.save(.init(), replacing: .init()))
            XCTAssertEqual(try Data(contentsOf: store.url), original)
        }
    }

    func testDuplicateIdentityAndInvalidIDsFailWithoutCreatingFile() throws {
        let root = try directory()
        let store = store(root)
        let item = ProjectConversationDraft(projectID: first, taskID: "task-001", text: "x")
        for drafts in [[item, item], [.init(projectID: "../bad", taskID: nil, text: "x")],
                       [.init(projectID: first, taskID: "../../bad", text: "x")]] {
            XCTAssertThrowsError(try store.save(.init(drafts: drafts), replacing: .init()))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    func testFileAndDraftSizeCapsFailWithoutOverwrite() throws {
        let root = try directory()
        let store = store(root)
        let oversizedDraft = ProjectConversationDraft(projectID: first, taskID: nil, text: String(repeating: "a", count: 64 * 1024 + 1))
        XCTAssertThrowsError(try store.save(.init(drafts: [oversizedDraft]), replacing: .init()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        try FileManager.default.createDirectory(at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = Data(repeating: 0x20, count: 2 * 1024 * 1024 + 1)
        try original.write(to: store.url)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init(), replacing: .init()))
        XCTAssertEqual(try Data(contentsOf: store.url), original)
    }

    func testAggregateSizeAndRecordCountCapsRejectBeforeCreatingFile() throws {
        let root = try directory()
        let store = store(root)
        let many = (1...1001).map { ProjectConversationDraft(projectID: first, taskID: String(format: "task-%03d", $0), text: "x") }
        XCTAssertThrowsError(try store.save(.init(drafts: many), replacing: .init()))
        let large = (1...33).map { ProjectConversationDraft(projectID: first, taskID: String(format: "task-%03d", $0), text: String(repeating: "a", count: 64 * 1024)) }
        XCTAssertThrowsError(try store.save(.init(drafts: large), replacing: .init()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    func testSymlinkFileAndSymlinkImmediateParentAreNotOverwritten() throws {
        let root = try directory()
        let originalURL = root.appendingPathComponent("original.json")
        let original = Data("{\"version\":1,\"drafts\":[]}".utf8)
        try original.write(to: originalURL)
        let linked = root.appendingPathComponent("linked.json")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: originalURL)
        let linkedStore = ProjectConversationStore(url: linked)
        XCTAssertThrowsError(try linkedStore.load())
        XCTAssertThrowsError(try linkedStore.save(.init(), replacing: .init()))
        XCTAssertEqual(try Data(contentsOf: originalURL), original)
        let directoryLink = root.appendingPathComponent("linked-directory")
        try FileManager.default.createSymbolicLink(at: directoryLink, withDestinationURL: root)
        let linkedParentStore = ProjectConversationStore(url: directoryLink.appendingPathComponent("drafts.json"))
        XCTAssertThrowsError(try linkedParentStore.save(.init(), replacing: .init()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("drafts.json").path))
    }

    func testChangedValidRevisionIsNotSilentlyReplaced() throws {
        let root = try directory()
        let store = store(root)
        let external = ProjectConversationState(drafts: [.init(projectID: first, taskID: nil, text: "外部修改")])
        try store.save(external, replacing: .init())
        let bytes = try Data(contentsOf: store.url)
        XCTAssertThrowsError(try store.save(.init(), replacing: .init()))
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
    }

    @MainActor
    func testConstructionDoesNoReadOrWriteAndPreloadInputIsRetained() async throws {
        let root = try directory()
        let store = SwitchableProjectConversationStore(url: root.appendingPathComponent("drafts.json"))
        let controller = ProjectConversationController(store: store)
        XCTAssertEqual(store.readAttempts, 0)
        XCTAssertEqual(store.writeAttempts, 0)
        XCTAssertFalse(controller.isLoaded)
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: nil, text: "启动时输入"))
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "启动时输入")
        XCTAssertTrue(controller.hasUnsavedDrafts)
        XCTAssertEqual(store.writeAttempts, 0)
        let loaded = await controller.load()
        XCTAssertTrue(loaded)
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "启动时输入")
        XCTAssertTrue(controller.retryDrafts())
        XCTAssertEqual(try store.load().drafts.first?.text, "启动时输入")
    }

    @MainActor
    func testTaskProjectAndOtherProjectDraftsSurviveRestartWithoutSourceOrWorkspaceChanges() async throws {
        let root = try directory()
        let source = root.appendingPathComponent(".screendeck")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let sourceFile = source.appendingPathComponent("project.json")
        let workspace = root.appendingPathComponent("workspace.json")
        let sourceBytes = Data("source unchanged".utf8)
        let workspaceBytes = Data("legacy unchanged".utf8)
        try sourceBytes.write(to: sourceFile)
        try workspaceBytes.write(to: workspace)
        let store = store(root)
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: nil, text: "根讨论"))
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: "task-001", text: "任务讨论"))
        XCTAssertTrue(controller.saveDraft(projectID: second, taskID: "task-001", text: "另一个讨论"))
        let restored = ProjectConversationController(store: store)
        _ = await restored.load()
        XCTAssertEqual(restored.draft(projectID: first, taskID: nil), "根讨论")
        XCTAssertEqual(restored.draft(projectID: first, taskID: "task-001"), "任务讨论")
        XCTAssertEqual(restored.draft(projectID: second, taskID: "task-001"), "另一个讨论")
        XCTAssertFalse(restored.hasUnsavedDrafts)
        XCTAssertEqual(try Data(contentsOf: sourceFile), sourceBytes)
        XCTAssertEqual(try Data(contentsOf: workspace), workspaceBytes)
    }

    @MainActor
    func testFailedWritesPreserveLatestInputsAndRetryAllTogether() async throws {
        let root = try directory()
        let store = SwitchableProjectConversationStore(url: root.appendingPathComponent("drafts.json"))
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: "task-001", text: "已保存"))
        let bytes = try Data(contentsOf: store.url)
        store.failWrites = true
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: "task-001", text: "第一版"))
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: "task-001", text: "最新输入"))
        XCTAssertFalse(controller.saveDraft(projectID: second, taskID: "task-001", text: "另一份输入"))
        XCTAssertFalse(controller.retryDrafts())
        XCTAssertEqual(controller.draft(projectID: first, taskID: "task-001"), "最新输入")
        XCTAssertEqual(controller.draft(projectID: second, taskID: "task-001"), "另一份输入")
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
        XCTAssertTrue(controller.hasUnsavedDrafts)
        store.failWrites = false
        XCTAssertTrue(controller.retryDrafts())
        XCTAssertFalse(controller.hasUnsavedDrafts)
        XCTAssertNil(controller.error)
        let restored = ProjectConversationController(store: store)
        _ = await restored.load()
        XCTAssertEqual(restored.draft(projectID: first, taskID: "task-001"), "最新输入")
        XCTAssertEqual(restored.draft(projectID: second, taskID: "task-001"), "另一份输入")
    }

    @MainActor
    func testIndividualSaveAndDiscardOnlyClearIntendedPendingInputs() async throws {
        let root = try directory()
        let store = SwitchableProjectConversationStore(url: root.appendingPathComponent("drafts.json"))
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: nil, text: "已保存的根输入"))
        store.failWrites = true
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: nil, text: "根未保存"))
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: "task-001", text: "任务未保存"))
        store.failWrites = false
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: "task-001", text: "任务最终版本"))
        XCTAssertTrue(controller.isDraftUnsaved(projectID: first, taskID: nil))
        XCTAssertFalse(controller.isDraftUnsaved(projectID: first, taskID: "task-001"))
        let attempts = store.writeAttempts
        controller.discardUnsavedDrafts()
        XCTAssertFalse(controller.hasUnsavedDrafts)
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "已保存的根输入")
        XCTAssertEqual(controller.draft(projectID: first, taskID: "task-001"), "任务最终版本")
        XCTAssertEqual(store.writeAttempts, attempts)
    }

    @MainActor
    func testFailedLoadBlocksWritesAndReloadRetainsEmptyPendingInput() async throws {
        let root = try directory()
        let store = SwitchableProjectConversationStore(url: root.appendingPathComponent("drafts.json"))
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: "task-001", text: "已保存"))
        store.failReads = true
        let loaded = await controller.load()
        XCTAssertFalse(loaded)
        let attempts = store.writeAttempts
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: "task-001", text: ""))
        XCTAssertFalse(controller.retryDrafts())
        XCTAssertEqual(store.writeAttempts, attempts)
        XCTAssertEqual(controller.draft(projectID: first, taskID: "task-001"), "")
        store.failReads = false
        _ = await controller.load()
        XCTAssertTrue(controller.hasUnsavedDrafts)
        XCTAssertEqual(controller.draft(projectID: first, taskID: "task-001"), "")
        XCTAssertTrue(controller.retryDrafts())
        XCTAssertEqual(try store.load().drafts.first?.text, "")
    }

    @MainActor
    func testCorruptStoreBlocksOverwriteWhileUnsavedInputRemainsAvailable() async throws {
        let root = try directory()
        let store = store(root)
        try FileManager.default.createDirectory(at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = Data("corrupt".utf8)
        try original.write(to: store.url)
        let controller = ProjectConversationController(store: store)
        let loaded = await controller.load()
        XCTAssertFalse(loaded)
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: nil, text: "不能丢失"))
        XCTAssertFalse(controller.retryDrafts())
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "不能丢失")
        XCTAssertTrue(controller.hasUnsavedDrafts)
        XCTAssertEqual(try Data(contentsOf: store.url), original)
    }

    @MainActor
    func testExternalValidUpdateRequiresReloadAndKeepsPendingInput() async throws {
        let root = try directory()
        let store = store(root)
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        let external = ProjectConversationState(drafts: [.init(projectID: second, taskID: "task-001", text: "外部保存的输入")])
        try store.save(external, replacing: .init())
        let bytes = try Data(contentsOf: store.url)
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: nil, text: "本窗口输入"))
        XCTAssertFalse(controller.isLoaded)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "本窗口输入")
        _ = await controller.load()
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), "本窗口输入")
        XCTAssertEqual(controller.draft(projectID: second, taskID: "task-001"), "外部保存的输入")
        XCTAssertTrue(controller.retryDrafts())
        XCTAssertEqual(try store.load().drafts.count, 2)
    }

    @MainActor
    func testOversizedInputRemainsBufferedAndCanBeShortenedAndSaved() async throws {
        let root = try directory()
        let store = store(root)
        let controller = ProjectConversationController(store: store)
        _ = await controller.load()
        let text = String(repeating: "a", count: 64 * 1024 + 1)
        XCTAssertFalse(controller.saveDraft(projectID: first, taskID: nil, text: text))
        XCTAssertEqual(controller.draft(projectID: first, taskID: nil), text)
        XCTAssertTrue(controller.hasUnsavedDrafts)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        XCTAssertTrue(controller.saveDraft(projectID: first, taskID: nil, text: "缩短后的输入"))
        XCTAssertFalse(controller.hasUnsavedDrafts)
    }
}

private final class SwitchableProjectConversationStore: ProjectConversationStoring {
    let backing: ProjectConversationStore
    var url: URL { backing.url }
    var failReads = false
    var failWrites = false
    var readAttempts = 0
    var writeAttempts = 0
    init(url: URL) { backing = .init(url: url) }
    func load() throws -> ProjectConversationState {
        readAttempts += 1
        if failReads { throw CocoaError(.fileReadUnknown) }
        return try backing.load()
    }
    func save(_ state: ProjectConversationState, replacing expected: ProjectConversationState) throws {
        writeAttempts += 1
        if failWrites { throw CocoaError(.fileWriteUnknown) }
        try backing.save(state, replacing: expected)
    }
}
