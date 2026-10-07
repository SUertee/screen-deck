import XCTest
@testable import ScreenDeck

final class LocalWorkspaceTests: XCTestCase {
    private func temporaryStore() throws -> LocalWorkspaceStore {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return LocalWorkspaceStore(url: folder.appendingPathComponent("workspace.json"))
    }

    @MainActor
    func testCreateRenameSelectionAndSettingsSurviveRestart() async throws {
        let store = try temporaryStore()
        let first = AppState(store: store)
        first.refresh()
        XCTAssertTrue(first.dataAvailable)
        XCTAssertTrue(first.tasks.isEmpty)
        XCTAssertTrue(first.createTask(title: "  写报告  "))
        let id = try XCTUnwrap(first.currentTaskID)
        XCTAssertTrue(first.renameTask(id: id, title: "竞品分析"))
        XCTAssertTrue(first.createTask(title: "演示脚本"))
        XCTAssertEqual(first.currentTaskID, id)
        first.selectTask(first.tasks[1])
        first.setDefaultPinned(true)

        let restored = AppState(store: store)
        restored.refresh()
        XCTAssertEqual(restored.tasks, first.tasks)
        XCTAssertEqual(restored.currentTaskID, first.tasks[1].id)
        XCTAssertTrue(restored.defaultPinned)
        XCTAssertTrue(restored.isPanelPinned)
    }

    @MainActor
    func testEmptyNamesRejectedAndCompletionClearsSelection() async throws {
        let state = AppState(store: try temporaryStore())
        state.refresh()
        XCTAssertFalse(state.createTask(title: " \n "))
        XCTAssertTrue(state.tasks.isEmpty)
        XCTAssertTrue(state.createTask(title: "任务"))
        let task = state.tasks[0]
        XCTAssertFalse(state.renameTask(id: task.id, title: ""))
        XCTAssertEqual(state.tasks[0].title, "任务")
        state.toggle(task)
        XCTAssertNil(state.currentTaskID)
        state.selectTask(state.tasks[0])
        XCTAssertNil(state.currentTaskID)
        state.toggle(state.tasks[0])
        state.selectTask(state.tasks[0])
        XCTAssertEqual(state.currentTaskID, task.id)
    }

    @MainActor
    func testCorruptDataIsNotEmptyOrOverwritten() async throws {
        let store = try temporaryStore()
        let bytes = Data("not json".utf8)
        try bytes.write(to: store.url)
        let state = AppState(store: store)
        state.refresh()
        XCTAssertFalse(state.dataAvailable)
        XCTAssertTrue(state.statusMessage.contains("读取失败"))
        XCTAssertFalse(state.createTask(title: "不要覆盖"))
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
    }

    func testUnsupportedVersionAndInvalidReferencesRejected() throws {
        let store = try temporaryStore()
        var workspace = LocalWorkspace()
        workspace.schemaVersion = 2
        try JSONEncoder().encode(workspace).write(to: store.url)
        XCTAssertThrowsError(try store.load())
        workspace.schemaVersion = 1
        workspace.currentTaskID = UUID()
        XCTAssertThrowsError(try store.save(workspace))
        let task = LocalTask(title: "重复")
        workspace.currentTaskID = nil
        workspace.tasks = [task, task]
        XCTAssertThrowsError(try store.save(workspace))
    }

    @MainActor
    func testFailedSaveDoesNotPublishSuccess() async {
        let state = AppState(store: FailingStore())
        state.refresh()
        XCTAssertFalse(state.createTask(title: "保存失败"))
        XCTAssertTrue(state.tasks.isEmpty)
        XCTAssertNil(state.currentTaskID)
        XCTAssertNotNil(state.operationError)
        state.setDefaultPinned(true)
        XCTAssertFalse(state.defaultPinned)
    }

    @MainActor
    func testReloadDoesNotInterruptEditing() async throws {
        let state = AppState(store: try temporaryStore())
        state.refresh()
        state.createTask(title: "原任务")
        state.setEditingTask(true)
        state.refresh()
        XCTAssertTrue(state.isEditingTask)
        XCTAssertEqual(state.tasks[0].title, "原任务")
    }
}

private struct FailingStore: WorkspaceStore {
    let url = URL(fileURLWithPath: "/unused-test-workspace.json")
    func load() throws -> LocalWorkspace { LocalWorkspace() }
    func save(_ workspace: LocalWorkspace) throws { throw CocoaError(.fileWriteNoPermission) }
}
