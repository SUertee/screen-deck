import XCTest
@testable import ScreenDeck

final class LocalDraftAITests: XCTestCase {
    func testPreviewBoundsAndExclusions() throws {
        let task = LocalTask(title: "报告", subtasks: [Subtask(title: "已处理", completed: true), Subtask(title: "核对来源")])
        var session = WorkSession(taskID: task.id, taskTitle: task.title, startedAt: Date(), displayIDs: [1])
        session.evidence = (0..<10).map { index in
            let id = UUID()
            return WorkEvidence(id: id, capturedAt: Date(), displayID: 1, displayName: "内置", appName: "测试",
                                text: index == 9 ? "PRIVATE-EXCLUDED" : String(repeating: "长", count: 3000), imageName: "\(id).jpg", excluded: index == 9)
        }
        let input = DraftInput(task: task, session: session)
        XCTAssertEqual(input.evidence.count, 6)
        XCTAssertEqual(input.pendingSubtasks, ["核对来源"])
        XCTAssertTrue(input.evidence.allSatisfy { $0.text.count == 2000 })
        XCTAssertFalse(try input.preview().contains("PRIVATE-EXCLUDED"))
        XCTAssertFalse(try input.preview().contains(".jpg"))
    }

    func testUnknownOrMissingEvidenceRejected() throws {
        let id = UUID(), task = LocalTask(title: "任务")
        var session = WorkSession(taskID: task.id, taskTitle: task.title, startedAt: Date(), displayIDs: [1])
        session.evidence = [WorkEvidence(id: id, capturedAt: Date(), displayID: 1, displayName: "内置", appName: "编辑器", text: "资料", imageName: "\(id).jpg")]
        let input = DraftInput(task: task, session: session)
        XCTAssertThrowsError(try AIDraft(progress: "观察", nextStep: "核对", evidenceIDs: [UUID()]).validated(for: input))
        XCTAssertThrowsError(try AIDraft(progress: "观察", nextStep: "核对", evidenceIDs: []).validated(for: input))
        XCTAssertThrowsError(try AIDraft(progress: "", nextStep: "核对", evidenceIDs: [id]).validated(for: input))
        XCTAssertNoThrow(try AIDraft(progress: "观察", nextStep: "核对", evidenceIDs: [id]).validated(for: input))
    }

    @MainActor
    func testSourcesSurviveSavingWithoutCompletingTask() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json"))
        let state = AppState(store: store); state.refresh()
        XCTAssertTrue(state.createTask(title: "报告"))
        let taskID = try XCTUnwrap(state.currentTaskID), source = UUID(), session = UUID()
        XCTAssertTrue(state.saveResume(taskID: taskID, content: ResumeContent(progress: "画面线索", nextStep: "核对来源"), requestID: UUID(), evidenceIDs: [source], sessionID: session, origin: "AI 建议"))
        let restored = try store.load().tasks[0]
        XCTAssertFalse(restored.completed)
        XCTAssertEqual(restored.latestResume?.evidenceIDs, [source])
        XCTAssertEqual(restored.latestResume?.sessionID, session)
    }
}
