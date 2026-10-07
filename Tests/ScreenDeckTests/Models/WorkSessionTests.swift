import XCTest
@testable import ScreenDeck

final class WorkSessionTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    @MainActor
    func testSubtasksPersistWithoutAutomaticallyCompletingParent() throws {
        let store = LocalWorkspaceStore(url: try directory().appendingPathComponent("workspace.json"))
        let state = AppState(store: store)
        state.refresh()
        XCTAssertTrue(state.createTask(title: "报告"))
        let id = try XCTUnwrap(state.currentTaskID)
        XCTAssertFalse(state.addSubtask(taskID: id, title: "  "))
        XCTAssertTrue(state.addSubtask(taskID: id, title: "  调研  "))
        let child = try XCTUnwrap(state.currentTask?.subtasks?.first)
        state.toggleSubtask(taskID: id, subtaskID: child.id)
        let restored = try store.load().tasks[0]
        XCTAssertEqual(restored.subtasks?.first?.title, "调研")
        XCTAssertEqual(restored.subtasks?.first?.completed, true)
        XCTAssertFalse(restored.completed)
    }

    @MainActor
    func testStartRequiresPermissionAndExplicitDisplaySelection() async throws {
        let service = FakeDesktopCapture()
        let controller = WorkSessionController(root: try directory(), captureService: service)
        controller.load()
        await controller.refreshDisplays()
        let task = LocalTask(title: "任务")
        XCTAssertFalse(controller.start(task: task, automaticSampling: false))
        controller.selectedDisplays = [1]
        service.hasPermission = false
        XCTAssertFalse(controller.start(task: task, automaticSampling: false))
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(service.calls, 0)
    }

    @MainActor
    func testMultiDisplayEvidenceAndPausedSessionPersist() async throws {
        let root = try directory()
        let controller = WorkSessionController(root: root, captureService: FakeDesktopCapture())
        controller.load()
        await controller.refreshDisplays()
        controller.selectedDisplays = [1, 2]
        let task = LocalTask(title: "研究")
        XCTAssertTrue(controller.start(task: task, automaticSampling: false))
        XCTAssertFalse(controller.start(task: LocalTask(title: "其他"), automaticSampling: false))
        await controller.captureOnce()
        XCTAssertEqual(controller.activeSession?.evidence.map(\.displayID), [1, 2])
        let session = try XCTUnwrap(controller.pause())
        XCTAssertEqual(session.status, .paused)
        XCTAssertNil(controller.activeID)
        let restored = WorkSessionController(root: root, captureService: FakeDesktopCapture())
        restored.load()
        XCTAssertNil(restored.activeID)
        XCTAssertEqual(restored.sessions[0], session)
        for item in session.evidence {
            XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(controller.store.imageURL(sessionID: session.id, evidence: item)).path))
        }
    }

    @MainActor
    func testInterruptedSessionNeverRestartsRecording() async throws {
        let root = try directory()
        let session = WorkSession(taskID: UUID(), taskTitle: "旧任务", startedAt: Date(), displayIDs: [1])
        try WorkSessionStore(root: root).save(session)
        let service = FakeDesktopCapture()
        let controller = WorkSessionController(root: root, captureService: service)
        controller.load()
        XCTAssertEqual(controller.sessions.first?.status, .interrupted)
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(service.calls, 0)
        XCTAssertEqual(try WorkSessionStore(root: root).load().first?.status, .interrupted)
    }

    @MainActor
    func testPauseDiscardsInFlightFrame() async throws {
        let service = FakeDesktopCapture()
        service.suspend = true
        let controller = WorkSessionController(root: try directory(), captureService: service)
        controller.load()
        await controller.refreshDisplays()
        controller.selectedDisplays = [1]
        XCTAssertTrue(controller.start(task: LocalTask(title: "暂停测试"), automaticSampling: false))
        let running = Task { await controller.captureOnce() }
        while service.continuation == nil { await Task.yield() }
        XCTAssertNotNil(controller.pause())
        service.continuation?.resume()
        await running.value
        XCTAssertTrue(controller.sessions[0].evidence.isEmpty)
        XCTAssertFalse(controller.capturing)
    }

    @MainActor
    func testCaptureFailureStopsSessionAndExposesError() async throws {
        let service = FakeDesktopCapture()
        service.fail = true
        let controller = WorkSessionController(root: try directory(), captureService: service)
        controller.load()
        await controller.refreshDisplays()
        controller.selectedDisplays = [1]
        XCTAssertTrue(controller.start(task: LocalTask(title: "失败"), automaticSampling: false))
        await controller.captureOnce()
        XCTAssertNil(controller.activeID)
        XCTAssertNotNil(controller.error)
        XCTAssertEqual(controller.sessions.first?.status, .paused)
    }

    @MainActor
    func testPermissionRevokedDuringCaptureDoesNotSaveFrame() async throws {
        let service = FakeDesktopCapture(); service.suspend = true
        let controller = WorkSessionController(root: try directory(), captureService: service)
        controller.load(); await controller.refreshDisplays(); controller.selectedDisplays = [1]
        XCTAssertTrue(controller.start(task: LocalTask(title: "撤销授权"), automaticSampling: false))
        let running = Task { await controller.captureOnce() }
        while service.continuation == nil { await Task.yield() }
        service.hasPermission = false; service.continuation?.resume()
        await running.value
        XCTAssertNil(controller.activeID)
        XCTAssertTrue(controller.sessions[0].evidence.isEmpty)
        XCTAssertNotNil(controller.error)
    }

    @MainActor
    func testExcludedEvidencePersists() async throws {
        let root = try directory()
        let controller = WorkSessionController(root: root, captureService: FakeDesktopCapture())
        controller.load(); await controller.refreshDisplays(); controller.selectedDisplays = [1]
        XCTAssertTrue(controller.start(task: LocalTask(title: "排除"), automaticSampling: false))
        await controller.captureOnce()
        let session = try XCTUnwrap(controller.pause())
        controller.setExcluded(sessionID: session.id, evidenceID: try XCTUnwrap(session.evidence.first?.id), excluded: true)
        XCTAssertTrue(try XCTUnwrap(WorkSessionStore(root: root).load().first?.evidence.first).excluded)
    }

    @MainActor
    func testCorruptSessionBlocksCaptureWithoutOverwriting() throws {
        let root = try directory(), id = UUID()
        let folder = root.appendingPathComponent(id.uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent("session.json"), bad = Data("broken".utf8)
        try bad.write(to: file)
        let controller = WorkSessionController(root: root, captureService: FakeDesktopCapture())
        controller.load()
        XCTAssertFalse(controller.loaded)
        XCTAssertNotNil(controller.error)
        XCTAssertFalse(controller.start(task: LocalTask(title: "任务"), automaticSampling: false))
        XCTAssertEqual(try Data(contentsOf: file), bad)
    }

    @MainActor
    func testPauseStopsEvenWhenFinalSaveFails() async throws {
        let controller = WorkSessionController(root: try directory(), captureService: FakeDesktopCapture())
        controller.load(); await controller.refreshDisplays(); controller.selectedDisplays = [1]
        XCTAssertTrue(controller.start(task: LocalTask(title: "保存失败"), automaticSampling: false))
        let id = try XCTUnwrap(controller.activeID)
        let file = controller.store.folder(id).appendingPathComponent("session.json")
        // Only this test's fresh fixture file is replaced to simulate a failed atomic write.
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        XCTAssertNil(controller.pause())
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(controller.sessions.first?.status, .paused)
        XCTAssertTrue(controller.error?.contains("保存失败") == true)
    }

    func testEvidencePathsCannotEscapeSessionDirectory() throws {
        var session = WorkSession(taskID: UUID(), taskTitle: "任务", startedAt: Date(), displayIDs: [1])
        let evidence = WorkEvidence(capturedAt: Date(), displayID: 1, displayName: "屏幕", appName: "编辑器", text: "", imageName: "../../private.jpg")
        session.evidence = [evidence]
        XCTAssertThrowsError(try session.validate())
        XCTAssertNil(WorkSessionStore(root: try directory()).imageURL(sessionID: session.id, evidence: evidence))
    }

    func testDigestUsesOnlyIncludedEvidenceAndDoesNotClaimCompletion() throws {
        let id = UUID()
        var session = WorkSession(taskID: id, taskTitle: "报告", startedAt: Date(), displayIDs: [1])
        let a = UUID(), b = UUID()
        session.evidence = [
            WorkEvidence(id: a, capturedAt: Date(), displayID: 1, displayName: "A", appName: "编辑器", text: "今天的报告初稿正在编辑", imageName: "\(a).jpg"),
            WorkEvidence(id: b, capturedAt: Date(), displayID: 1, displayName: "A", appName: "隐私应用", text: "不应该出现在草稿中", imageName: "\(b).jpg", excluded: true)
        ]
        let task = LocalTask(id: id, title: "报告", subtasks: [Subtask(title: "核对来源")])
        let result = EvidenceDigest.draft(session: session, task: task)
        XCTAssertTrue(result.progress.contains("编辑器"))
        XCTAssertFalse(result.progress.contains("隐私应用"))
        XCTAssertEqual(result.nextStep, "核对来源")
        XCTAssertFalse(result.progress.contains("已完成"))
    }
}

@MainActor
private final class FakeDesktopCapture: DesktopCapturing {
    var hasPermission = true
    var calls = 0
    var fail = false
    var suspend = false
    var continuation: CheckedContinuation<Void, Never>?
    func requestPermission() {}
    func displays() async throws -> [CaptureDisplay] {
        [CaptureDisplay(id: 1, name: "内置", width: 1512, height: 982), CaptureDisplay(id: 2, name: "外接", width: 1920, height: 2160)]
    }
    func capture(display: CaptureDisplay) async throws -> CapturedDesktop {
        calls += 1
        if fail { throw CaptureFailure.missingDisplay }
        if suspend { await withCheckedContinuation { continuation = $0 } }
        return CapturedDesktop(display: display, jpeg: Data([1, 2, 3]), text: "用于单元测试的画面文字", appName: "测试应用", capturedAt: Date())
    }
}
