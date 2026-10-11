import XCTest
@testable import ScreenDeck

/// Private temporary stores only; no live configuration, screen permission or user data is read.
final class ConfigurationIntegrationTests: XCTestCase {
    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-config-integration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func configurationStore(_ root: URL) -> ConfigurationStore {
        ConfigurationStore(userFileURL: root.appendingPathComponent("config.toml"))
    }

    private var preferences: CapturePreferences {
        CapturePreferences(displayIDs: [1], interval: 60, model: "qwen3:8b")
    }

    @MainActor
    func testTOMLPinSurvivesTaskDraftAndSubtaskChangesWithoutDualWritingWorkspace() throws {
        let root = try directory()
        let configuration = configurationStore(root)
        var value = UserConfiguration(capturePreferences: preferences, defaultPinned: true)
        value.model = .init(executor: "codex", model: "configured-model", effort: "high")
        _ = try configuration.saveUser(value, expectedDigest: nil)
        let originalConfiguration = try Data(contentsOf: configuration.userFileURL)
        let workspace = LocalWorkspaceStore(url: root.appendingPathComponent("tasks/local-workspace.json"))
        try workspace.save(LocalWorkspace(defaultPinned: false))
        let state = AppState(store: workspace, configurationStore: configuration)
        state.refresh()
        XCTAssertTrue(state.dataAvailable)
        XCTAssertTrue(state.defaultPinned)
        XCTAssertTrue(state.isPanelPinned)

        XCTAssertTrue(state.createTask(title: "配置接入"))
        let taskID = try XCTUnwrap(state.currentTaskID)
        XCTAssertTrue(state.saveConversationDraft(route: .task(taskID), text: "只改草稿"))
        XCTAssertTrue(state.addSubtask(taskID: taskID, title: "检查偏好"))
        let child = try XCTUnwrap(state.currentTask?.subtasks?.first)
        state.toggleSubtask(taskID: taskID, subtaskID: child.id)
        let chatID = try XCTUnwrap(state.createConversation(draft: "讨论配置"))
        XCTAssertTrue(state.saveConversationDraft(route: .chat(chatID), text: "继续讨论"))
        XCTAssertTrue(state.defaultPinned)
        XCTAssertTrue(state.isPanelPinned)
        XCTAssertFalse(try workspace.load().defaultPinned)
        XCTAssertEqual(try Data(contentsOf: configuration.userFileURL), originalConfiguration)

        let restored = AppState(store: workspace, configurationStore: configuration)
        restored.refresh()
        XCTAssertTrue(restored.defaultPinned)
        XCTAssertTrue(restored.isPanelPinned)
        XCTAssertEqual(restored.tasks.count, 1)
        XCTAssertEqual(restored.conversations.count, 1)
    }

    @MainActor
    func testPinSettingOnlyChangesTOMLGeneralPreferenceAndRemainsCanonicalAfterTaskMutation() throws {
        let root = try directory()
        let configuration = configurationStore(root)
        var initial = UserConfiguration(capturePreferences: preferences)
        initial.model = .init(executor: "api", model: "configured-model", effort: "medium")
        _ = try configuration.saveUser(initial, expectedDigest: nil)
        let workspace = LocalWorkspaceStore(url: root.appendingPathComponent("tasks/local-workspace.json"))
        try workspace.save(.init())
        let state = AppState(store: workspace, configurationStore: configuration)
        state.refresh()
        XCTAssertFalse(state.defaultPinned)
        state.setDefaultPinned(true)
        XCTAssertNil(state.operationError)
        XCTAssertTrue(state.defaultPinned)
        XCTAssertTrue(state.isPanelPinned)
        XCTAssertTrue(state.createTask(title: "不会重置固定偏好"))
        XCTAssertTrue(state.defaultPinned)
        let saved = try configuration.loadUser().configuration
        XCTAssertTrue(saved.general.defaultPinned)
        XCTAssertEqual(saved.capture, initial.capture)
        XCTAssertEqual(saved.model, initial.model)
        XCTAssertFalse(try workspace.load().defaultPinned)
    }

    @MainActor
    func testCapturePreferencesMergePreservesExternalGeneralAndModelChangesWithoutCapture() throws {
        let root = try directory()
        let configuration = configurationStore(root)
        _ = try configuration.saveUser(UserConfiguration(capturePreferences: preferences), expectedDigest: nil)
        let service = ConfigurationCaptureFixture()
        let sessionsRoot = root.appendingPathComponent("artifacts/WorkSessions")
        let controller = WorkSessionController(root: sessionsRoot, captureService: service,
                                               configurationFile: configuration.userFileURL)
        controller.load()
        XCTAssertTrue(controller.loaded)
        XCTAssertTrue(controller.preferencesLoaded)
        XCTAssertEqual(controller.preferences, preferences)

        let prior = try configuration.loadUser()
        var externallyChanged = prior.configuration
        externallyChanged.general.defaultPinned = true
        externallyChanged.model = .init(executor: "codex", model: "another-model", effort: "high")
        _ = try configuration.saveUser(externallyChanged, expectedDigest: prior.digest)
        let newPreferences = CapturePreferences(displayIDs: [2], interval: 30, model: " local-model ")
        XCTAssertTrue(controller.savePreferences(newPreferences))
        let saved = try configuration.loadUser().configuration
        XCTAssertEqual(saved.general, externallyChanged.general)
        XCTAssertEqual(saved.model, externallyChanged.model)
        XCTAssertEqual(saved.capturePreferences, try newPreferences.validated())
        XCTAssertEqual(controller.preferences, try newPreferences.validated())
        XCTAssertEqual(controller.selectedDisplays, [2])
        XCTAssertEqual(controller.interval, 30)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sessionsRoot.appendingPathComponent("capture-preferences.json").path))
        XCTAssertNil(controller.activeID)
        XCTAssertFalse(controller.capturing)
        XCTAssertEqual(service.requests, 0)
        XCTAssertEqual(service.captures, 0)

        let restored = WorkSessionController(root: sessionsRoot, captureService: service,
                                             configurationFile: configuration.userFileURL)
        restored.load()
        XCTAssertEqual(restored.preferences, controller.preferences)
        XCTAssertNil(restored.activeID)
        XCTAssertTrue(restored.sessions.isEmpty)
        XCTAssertEqual(service.requests, 0)
        XCTAssertEqual(service.captures, 0)
    }

    @MainActor
    func testExternalCaptureChangeIsNotOverwrittenUntilPreferencesAreReloaded() throws {
        let root = try directory()
        let configuration = configurationStore(root)
        _ = try configuration.saveUser(UserConfiguration(capturePreferences: preferences), expectedDigest: nil)
        let service = ConfigurationCaptureFixture()
        let controller = WorkSessionController(root: root.appendingPathComponent("artifacts/WorkSessions"),
                                               captureService: service, configurationFile: configuration.userFileURL)
        let prior = try configuration.loadUser()
        var externallyChanged = prior.configuration
        externallyChanged.capture.intervalSeconds = 120
        externallyChanged.general.defaultPinned = true
        externallyChanged.model = .init(executor: "api", model: "external-model", effort: "medium")
        _ = try configuration.saveUser(externallyChanged, expectedDigest: prior.digest)
        let externalBytes = try Data(contentsOf: configuration.userFileURL)
        let proposed = CapturePreferences(displayIDs: [1], interval: 30, model: "qwen3:8b")
        XCTAssertFalse(controller.savePreferences(proposed))
        XCTAssertEqual(controller.preferences, preferences)
        XCTAssertEqual(controller.interval, 60)
        XCTAssertNotNil(controller.preferencesError)
        XCTAssertEqual(try Data(contentsOf: configuration.userFileURL), externalBytes)

        controller.loadPreferences()
        XCTAssertTrue(controller.preferencesLoaded)
        XCTAssertNil(controller.preferencesError)
        XCTAssertEqual(controller.interval, 120)
        XCTAssertTrue(controller.savePreferences(proposed))
        let saved = try configuration.loadUser().configuration
        XCTAssertEqual(saved.capturePreferences, proposed)
        XCTAssertEqual(saved.general, externallyChanged.general)
        XCTAssertEqual(saved.model, externallyChanged.model)
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(service.requests, 0)
        XCTAssertEqual(service.captures, 0)
    }
}

@MainActor
private final class ConfigurationCaptureFixture: DesktopCapturing {
    var hasPermission = false
    var requests = 0
    var captures = 0
    func requestPermission() { requests += 1 }
    func displays() async throws -> [CaptureDisplay] { [] }
    func capture(display: CaptureDisplay) async throws -> CapturedDesktop {
        captures += 1
        throw CaptureFailure.encoding
    }
}
