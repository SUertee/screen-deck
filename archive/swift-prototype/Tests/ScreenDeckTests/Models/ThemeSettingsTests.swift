import XCTest
@testable import ScreenDeck

final class ThemeSettingsTests: XCTestCase {
    private func root() -> URL {
        let result = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: result) }
        return result
    }

    @MainActor
    func testSettingsPersistWithoutStartingCaptureOrRequestingPermission() async throws {
        let root = root(), service = SettingsCaptureFixture()
        let controller = WorkSessionController(root: root, captureService: service)
        controller.load()
        let value = CapturePreferences(displayIDs: [1], interval: 120, model: " qwen3:8b ")
        XCTAssertTrue(controller.savePreferences(value))
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(service.captures, 0)
        XCTAssertEqual(service.requests, 0)
        let restored = WorkSessionController(root: root, captureService: service)
        restored.load()
        XCTAssertEqual(restored.preferences.model, "qwen3:8b")
        XCTAssertEqual(restored.interval, 120)
        XCTAssertEqual(restored.selectedDisplays, [1])
        XCTAssertNil(restored.activeID)
        XCTAssertTrue(restored.sessions.isEmpty)
    }

    @MainActor
    func testMissingDisplayBlocksStartRatherThanNarrowingSelection() async throws {
        let service = SettingsCaptureFixture()
        let controller = WorkSessionController(root: root(), captureService: service)
        controller.load()
        XCTAssertTrue(controller.savePreferences(CapturePreferences(displayIDs: [1, 2])))
        await controller.refreshDisplays()
        XCTAssertEqual(controller.selectedDisplays, [1, 2])
        XCTAssertFalse(controller.start(task: LocalTask(title: "测试"), automaticSampling: false))
        XCTAssertNil(controller.activeID)
        XCTAssertEqual(service.captures, 0)
    }

    @MainActor
    func testRecordingLocksConfiguration() async throws {
        let controller = WorkSessionController(root: root(), captureService: SettingsCaptureFixture())
        controller.load(); await controller.refreshDisplays()
        XCTAssertTrue(controller.savePreferences(CapturePreferences(displayIDs: [1])))
        XCTAssertTrue(controller.start(task: LocalTask(title: "测试"), automaticSampling: false))
        XCTAssertFalse(controller.savePreferences(CapturePreferences(interval: 30)))
        XCTAssertEqual(controller.preferences.interval, 60)
        _ = controller.pause()
        XCTAssertTrue(controller.savePreferences(CapturePreferences(interval: 30)))
    }

    @MainActor
    func testCorruptPreferencesPreservedAndBlockSaving() throws {
        let root = root()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("capture-preferences.json")
        let invalid = Data("broken".utf8)
        try invalid.write(to: file)
        let controller = WorkSessionController(root: root, captureService: SettingsCaptureFixture())
        XCTAssertFalse(controller.preferencesLoaded)
        XCTAssertNotNil(controller.preferencesError)
        XCTAssertFalse(controller.savePreferences(CapturePreferences()))
        XCTAssertEqual(try Data(contentsOf: file), invalid)
    }

    @MainActor
    func testFailedSaveKeepsPriorConfigurationAndDraft() throws {
        let root = root()
        let controller = WorkSessionController(root: root, captureService: SettingsCaptureFixture())
        let draft = SettingsDraft(memory: controller)
        // Block only the fresh fixture's destination to simulate a filesystem failure.
        try FileManager.default.createDirectory(at: root.appendingPathComponent("capture-preferences.json"), withIntermediateDirectories: true)
        draft.value.interval = 30
        draft.save()
        XCTAssertFalse(draft.saved)
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(controller.interval, 60)
        XCTAssertEqual(draft.value.interval, 30)
        XCTAssertNotNil(controller.preferencesError)
    }

    @MainActor
    func testSettingsDraftCancelAndSave() throws {
        let controller = WorkSessionController(root: root(), captureService: SettingsCaptureFixture())
        let draft = SettingsDraft(memory: controller)
        draft.value.interval = 30
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(controller.interval, 60)
        draft.discard()
        XCTAssertFalse(draft.isDirty)
        draft.value.model = "qwen3:8b"
        draft.save()
        XCTAssertTrue(draft.saved)
        XCTAssertFalse(draft.isDirty)
        XCTAssertEqual(controller.preferences.model, "qwen3:8b")
        draft.value.model = "qwen-cloud"
        draft.save()
        XCTAssertFalse(draft.saved)
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(controller.preferences.model, "qwen3:8b")
    }

    func testValidationRejectsUnsupportedConfiguration() throws {
        XCTAssertThrowsError(try CapturePreferences(interval: 1).validated())
        XCTAssertThrowsError(try CapturePreferences(displayIDs: [0]).validated())
        XCTAssertThrowsError(try CapturePreferences(model: "model-cloud").validated())
        XCTAssertThrowsError(try CapturePreferences(model: "a\nb").validated())
        XCTAssertNoThrow(try CapturePreferences().validated())
    }

    func testTextPaletteMeetsContrastFloor() {
        func luminance(_ hex: UInt32) -> Double {
            let channels = [Double((hex >> 16) & 255), Double((hex >> 8) & 255), Double(hex & 255)].map { value -> Double in
                let s = value / 255
                return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
            }
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        func ratio(_ a: UInt32, _ b: UInt32) -> Double {
            let x = luminance(a), y = luminance(b)
            return (max(x, y) + 0.05) / (min(x, y) + 0.05)
        }
        for p in [DeckTheme.dark, DeckTheme.light] {
            for surface in [p.background, p.surface, p.selection] {
                XCTAssertGreaterThanOrEqual(ratio(p.text, surface), 4.5)
                XCTAssertGreaterThanOrEqual(ratio(p.secondary, surface), 4.5)
                XCTAssertGreaterThanOrEqual(ratio(p.accent, surface), 4.5)
            }
            XCTAssertGreaterThanOrEqual(ratio(p.onAccent, p.accent), 4.5)
        }
    }
}

@MainActor
final class SettingsCaptureFixture: DesktopCapturing {
    var hasPermission = true
    var captures = 0
    var requests = 0
    func requestPermission() { requests += 1 }
    func displays() async throws -> [CaptureDisplay] {
        [CaptureDisplay(id: 1, name: "内置显示器", width: 1512, height: 982)]
    }
    func capture(display: CaptureDisplay) async throws -> CapturedDesktop {
        captures += 1
        throw CaptureFailure.encoding
    }
}
