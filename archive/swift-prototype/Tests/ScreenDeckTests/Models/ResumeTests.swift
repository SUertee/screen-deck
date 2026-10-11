import XCTest
@testable import ScreenDeck

final class ResumeTests: XCTestCase {
    private func temporaryStore() throws -> LocalWorkspaceStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return LocalWorkspaceStore(url: directory.appendingPathComponent("workspace.json"))
    }

    @MainActor
    func testCheckpointSurvivesReloadAndResumeDoesNotCompleteTask() async throws {
        let store = try temporaryStore()
        let state = AppState(store: store)
        state.refresh()
        state.createTask(title: "竞品分析")
        let id = try XCTUnwrap(state.currentTaskID)
        let date = Date(timeIntervalSince1970: 1_800_000_000)
        let input = ResumeContent(progress: "产品 A 已整理", nextStep: "核实产品 B", materials: ["https://example.com"])
        XCTAssertTrue(state.saveResume(taskID: id, content: input, requestID: UUID(), now: date))
        let restored = AppState(store: store)
        restored.refresh()
        XCTAssertEqual(restored.currentTaskID, id)
        XCTAssertEqual(restored.currentTask?.latestResume?.content, input)
        XCTAssertEqual(restored.currentTask?.latestResume?.savedAt, date)
        XCTAssertTrue(restored.resumeTask(id: id))
        XCTAssertFalse(try XCTUnwrap(restored.currentTask).completed)
        XCTAssertEqual(restored.currentTask?.resumeRecords?.count, 1)
    }

    @MainActor
    func testTasksAreIsolatedAndOldCheckpointDoesNotChange() async throws {
        let state = AppState(store: try temporaryStore())
        state.refresh()
        state.createTask(title: "A")
        let a = try XCTUnwrap(state.currentTaskID)
        let first = ResumeContent(progress: "A 第一版")
        XCTAssertTrue(state.saveResume(taskID: a, content: first, requestID: UUID()))
        state.createTask(title: "B")
        state.selectTask(state.tasks[1])
        let b = try XCTUnwrap(state.currentTaskID)
        XCTAssertFalse(state.saveResume(taskID: a, content: ResumeContent(progress: "不应写到 A"), requestID: UUID()))
        XCTAssertTrue(state.saveResume(taskID: b, content: ResumeContent(nextStep: "B 下一步"), requestID: UUID()))
        state.selectTask(state.tasks[0])
        XCTAssertTrue(state.saveResume(taskID: a, content: ResumeContent(progress: "A 第二版"), requestID: UUID()))
        XCTAssertEqual(state.tasks[0].resumeRecords?.first?.content, first)
        XCTAssertEqual(state.tasks[0].latestResume?.content.progress, "A 第二版")
        XCTAssertEqual(state.tasks[1].latestResume?.content.nextStep, "B 下一步")
    }

    @MainActor
    func testRetryIsIdempotentAndInvalidInputDoesNotReplaceSnapshot() async throws {
        let state = AppState(store: try temporaryStore())
        state.refresh()
        state.createTask(title: "A")
        let id = try XCTUnwrap(state.currentTaskID)
        let request = UUID()
        let input = ResumeContent(progress: "已保存")
        XCTAssertTrue(state.saveResume(taskID: id, content: input, requestID: request))
        XCTAssertTrue(state.saveResume(taskID: id, content: input, requestID: request))
        let old = state.currentTask?.latestResume
        XCTAssertEqual(state.currentTask?.resumeRecords?.count, 1)
        XCTAssertFalse(state.saveResume(taskID: id, content: ResumeContent(), requestID: UUID()))
        XCTAssertFalse(state.saveResume(taskID: id, content: ResumeContent(materials: ["file:///tmp/private"]), requestID: UUID()))
        XCTAssertEqual(state.currentTask?.latestResume, old)
        XCTAssertNotNil(state.operationError)
        state.toggle(state.tasks[0])
        XCTAssertFalse(state.saveResume(taskID: id, content: input, requestID: UUID()))
        XCTAssertFalse(state.resumeTask(id: id))
    }

    @MainActor
    func testWriteFailureKeepsPreviousCheckpointAndEditingState() async throws {
        let store = SwitchableResumeStore()
        let state = AppState(store: store)
        state.refresh()
        state.createTask(title: "A")
        let id = try XCTUnwrap(state.currentTaskID)
        XCTAssertTrue(state.saveResume(taskID: id, content: ResumeContent(progress: "旧记录"), requestID: UUID()))
        let old = state.currentTask?.latestResume
        state.setEditingTask(true)
        store.fail = true
        XCTAssertFalse(state.saveResume(taskID: id, content: ResumeContent(progress: "新输入"), requestID: UUID()))
        XCTAssertTrue(state.isEditingTask)
        XCTAssertEqual(state.currentTask?.latestResume, old)
        XCTAssertEqual(store.value.tasks[0].latestResume, old)
        XCTAssertTrue(state.operationError?.contains("保存失败") == true)
        store.fail = false
        XCTAssertTrue(state.saveResume(taskID: id, content: ResumeContent(progress: "新输入"), requestID: UUID()))
        XCTAssertNil(state.operationError)
    }

    func testLegacyTaskLoadsWithoutResumeRecord() throws {
        let json = """
        {"schemaVersion":1,"tasks":[{"id":"00000000-0000-0000-0000-000000000001","title":"旧任务","completed":false}],"defaultPinned":false}
        """
        let value = try JSONDecoder().decode(LocalWorkspace.self, from: Data(json.utf8))
        try value.validate()
        XCTAssertNil(value.tasks[0].latestResume)
    }

    func testMaterialValidationAndWhitespace() throws {
        for invalid in ["javascript:alert(1)", "file:///tmp/a", "https://", "example.com", "https://user:secret@example.com", "https://example.com/a b"] {
            XCTAssertNil(ResumeContent.materialURL(invalid), invalid)
        }
        XCTAssertNotNil(ResumeContent.materialURL("https://example.com/path?q=1#section"))
        XCTAssertNotNil(ResumeContent.materialURL("http://example.com"))
        let clean = try ResumeContent(progress: " 进度 \n", materials: [" ", " https://example.com "]).validated()
        XCTAssertEqual(clean.progress, "进度")
        XCTAssertEqual(clean.materials, ["https://example.com"])
        XCTAssertThrowsError(try ResumeContent(progress: " \n", materials: [" "]).validated())
    }
}

private final class SwitchableResumeStore: WorkspaceStore {
    let url = URL(fileURLWithPath: "/unused-resume-test.json")
    var value = LocalWorkspace()
    var fail = false
    func load() throws -> LocalWorkspace { value }
    func save(_ workspace: LocalWorkspace) throws {
        if fail { throw CocoaError(.fileWriteNoPermission) }
        try workspace.validate()
        value = workspace
    }
}
