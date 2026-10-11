import AppKit
import SwiftUI

/// Keeps one settings draft attached to its workbench until the user saves or discards it.
@MainActor
final class SettingsPresentation: NSObject, NSWindowDelegate {
    private(set) var window: NSWindow?
    private(set) var draft: SettingsDraft?
    private weak var previousFirstResponder: NSResponder?
    private var confirmingDiscard = false
    private let confirmDiscard: (NSWindow) -> Bool

    var isPresented: Bool { window != nil }

    init(confirmDiscard: ((NSWindow) -> Bool)? = nil) {
        self.confirmDiscard = confirmDiscard ?? Self.askToDiscard
    }

    func present(attachedTo parent: NSWindow, state: AppState, memory: WorkSessionController,
                 section: SettingsSection, projects: ProjectWorkspaceController? = nil,
                 onMigrateStorage: (() -> Void)? = nil) {
        if let window {
            draft?.section = section
            focus()
            assert(window.sheetParent === parent)
            return
        }
        guard parent.attachedSheet == nil else { return }
        let draft = SettingsDraft(memory: memory)
        draft.section = section
        let sheet = SettingsSheetWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 520),
                                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
        sheet.title = "ScreenDeck 设置"
        sheet.isReleasedWhenClosed = false
        sheet.appearance = NSAppearance(named: .aqua)
        sheet.delegate = self
        sheet.onRequestClose = { [weak self] in _ = self?.dismiss() }
        sheet.contentView = NSHostingView(rootView: DeckSettingsView(
            state: state, memory: memory, draft: draft, projects: projects, onMigrateStorage: onMigrateStorage,
            onClose: { [weak self] in _ = self?.dismiss() })
            .environment(\.colorScheme, .light))
        previousFirstResponder = parent.firstResponder
        self.draft = draft
        window = sheet
        if parent.isMiniaturized { parent.deminiaturize(nil) }
        parent.makeKeyAndOrderFront(nil)
        parent.beginSheet(sheet)
    }

    func focus() {
        guard let window, let parent = window.sheetParent else { return }
        if parent.isMiniaturized { parent.deminiaturize(nil) }
        parent.makeKeyAndOrderFront(nil)
        window.makeKey()
    }

    @discardableResult
    func confirmUnsavedChanges() -> Bool {
        guard let window, let draft, draft.isDirty else { return true }
        guard !confirmingDiscard else { return false }
        confirmingDiscard = true
        defer { confirmingDiscard = false }
        focus()
        return confirmDiscard(window)
    }

    @discardableResult
    func dismiss(returnFocus: Bool = true) -> Bool {
        guard confirmUnsavedChanges() else { return false }
        guard let window else { return true }
        draft?.discard()
        let parent = window.sheetParent
        parent?.endSheet(window)
        window.orderOut(nil)
        window.delegate = nil
        self.window = nil
        draft = nil
        if let previousFirstResponder { parent?.makeFirstResponder(previousFirstResponder) }
        previousFirstResponder = nil
        if returnFocus { parent?.makeKeyAndOrderFront(nil) }
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === window else { return true }
        _ = dismiss()
        // A sheet is ended through its parent, never closed as an independent window.
        return false
    }

    private static func askToDiscard(_: NSWindow) -> Bool {
        let alert = NSAlert()
        alert.messageText = "设置尚未保存"
        alert.informativeText = "继续编辑并保存，或放弃本次更改。关闭设置后会返回原来的工作台。"
        alert.addButton(withTitle: "继续编辑")
        alert.addButton(withTitle: "放弃更改")
        return alert.runModal() == .alertSecondButtonReturn
    }
}

@MainActor
private final class SettingsSheetWindow: NSWindow {
    var onRequestClose: (() -> Void)?

    override func cancelOperation(_ sender: Any?) { onRequestClose?() }
    override func performClose(_ sender: Any?) { onRequestClose?() }
}
