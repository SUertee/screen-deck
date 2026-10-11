import XCTest
import AppKit
@testable import ScreenDeck

final class SettingsPresentationTests: XCTestCase {
    @MainActor
    private func fixture() -> (AppState, WorkSessionController, SettingsCaptureFixture, NSWindow) {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let state = AppState(store: LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json")))
        state.refresh()
        let service = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("WorkSessions"), captureService: service)
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        parent.alphaValue = 0
        parent.ignoresMouseEvents = true
        return (state, memory, service, parent)
    }

    @MainActor
    func testRepeatedEntryReusesAttachedSheetAndKeepsTaskAndDraft() throws {
        let (state, memory, service, parent) = fixture()
        let presentation = SettingsPresentation(confirmDiscard: { _ in true })
        defer { presentation.dismiss(returnFocus: false); parent.orderOut(nil) }
        XCTAssertTrue(state.createTask(title: "设置浮层测试"))
        let selectedTask = state.currentTaskID
        presentation.present(attachedTo: parent, state: state, memory: memory, section: .capture)
        let firstWindow = try XCTUnwrap(presentation.window)
        let firstDraft = try XCTUnwrap(presentation.draft)
        firstDraft.value.interval = 30

        presentation.present(attachedTo: parent, state: state, memory: memory, section: .ai)

        XCTAssertTrue(presentation.window === firstWindow)
        XCTAssertTrue(presentation.draft === firstDraft)
        XCTAssertTrue(firstWindow.sheetParent === parent)
        XCTAssertEqual(firstWindow.appearance?.name, .aqua)
        XCTAssertEqual(firstDraft.section, .ai)
        XCTAssertEqual(firstDraft.value.interval, 30)
        XCTAssertEqual(memory.preferences.interval, 60)
        XCTAssertEqual(state.currentTaskID, selectedTask)
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(service.captures, 0)
        XCTAssertEqual(service.requests, 0)
    }

    @MainActor
    func testEscapeAndWindowCloseUseSameUnsavedProtection() throws {
        let (state, memory, _, parent) = fixture()
        var discard = false
        var confirmations = 0
        let presentation = SettingsPresentation(confirmDiscard: { _ in
            confirmations += 1
            return discard
        })
        defer { discard = true; presentation.dismiss(returnFocus: false); parent.orderOut(nil) }
        presentation.present(attachedTo: parent, state: state, memory: memory, section: .general)
        let window = try XCTUnwrap(presentation.window)
        let draft = try XCTUnwrap(presentation.draft)
        draft.value.model = "qwen3:8b"

        window.cancelOperation(nil)
        XCTAssertTrue(presentation.isPresented)
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(confirmations, 1)

        window.performClose(nil)
        XCTAssertTrue(presentation.isPresented)
        XCTAssertTrue(draft.isDirty)
        XCTAssertEqual(confirmations, 2)

        discard = true
        window.cancelOperation(nil)
        XCTAssertFalse(presentation.isPresented)
        XCTAssertNil(window.sheetParent)
        XCTAssertNil(parent.attachedSheet)
        XCTAssertFalse(draft.isDirty)
        XCTAssertEqual(memory.preferences.model, "")
    }

    @MainActor
    func testParentCloseAndQuitCheckPreserveDraftWhenCancelled() throws {
        let (state, memory, _, parent) = fixture()
        var discard = false
        let presentation = SettingsPresentation(confirmDiscard: { _ in discard })
        defer { discard = true; presentation.dismiss(returnFocus: false); parent.orderOut(nil) }
        presentation.present(attachedTo: parent, state: state, memory: memory, section: .capture)
        let draft = try XCTUnwrap(presentation.draft)
        draft.value.interval = 120

        XCTAssertFalse(presentation.dismiss(returnFocus: false))
        XCTAssertFalse(presentation.confirmUnsavedChanges())
        XCTAssertEqual(draft.value.interval, 120)
        XCTAssertTrue(presentation.isPresented)
        XCTAssertTrue(presentation.window?.sheetParent === parent)

        discard = true
        XCTAssertTrue(presentation.confirmUnsavedChanges())
        XCTAssertTrue(draft.isDirty, "Checking a possible quit must keep edits until the caller actually proceeds")
        XCTAssertTrue(presentation.dismiss(returnFocus: false))
        XCTAssertFalse(presentation.isPresented)
        XCTAssertEqual(memory.preferences.interval, 60)
    }

    @MainActor
    func testSavedSheetClosesWithoutDiscardPromptAndReopensFresh() throws {
        let (state, memory, service, parent) = fixture()
        var confirmations = 0
        let presentation = SettingsPresentation(confirmDiscard: { _ in confirmations += 1; return true })
        defer { presentation.dismiss(returnFocus: false); parent.orderOut(nil) }
        presentation.present(attachedTo: parent, state: state, memory: memory, section: .ai)
        let oldDraft = try XCTUnwrap(presentation.draft)
        oldDraft.value.model = "qwen3:8b"
        oldDraft.save()
        XCTAssertTrue(oldDraft.saved)
        XCTAssertTrue(presentation.dismiss(returnFocus: false))
        XCTAssertEqual(confirmations, 0)

        presentation.present(attachedTo: parent, state: state, memory: memory, section: .general)
        XCTAssertFalse(presentation.draft === oldDraft)
        XCTAssertEqual(presentation.draft?.value.model, "qwen3:8b")
        XCTAssertFalse(try XCTUnwrap(presentation.draft).isDirty)
        XCTAssertTrue(presentation.window?.sheetParent === parent)
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(service.captures, 0)
        XCTAssertEqual(service.requests, 0)
    }
}
