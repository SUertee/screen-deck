import SwiftUI
import AppKit

@main
struct ScreenDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("ScreenDeck", systemImage: "checklist") {
            Button("展开 / 收起 Deck") { appDelegate.togglePanel() }
            Divider()
            Button("退出 ScreenDeck") { NSApp.terminate(nil) }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: DeckPanel?
    private var state: AppState?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 菜单栏常驻工具，不占 Dock
        NSApp.setActivationPolicy(.accessory)

        let state = AppState()
        self.state = state
        state.startPolling()

        let panel = DeckPanel(state: state)
        self.panel = panel
        panel.show()
    }

    func togglePanel() {
        panel?.toggle()
    }

    func applicationWillTerminate(_ notification: Notification) {
        state?.stopPolling()
    }
}
