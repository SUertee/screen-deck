import AppKit
import Combine

struct DeckDisplayCandidate {
    let id: UInt32
    let builtIn: Bool
    let hasNotch: Bool
}

enum DeckDisplayPolicy {
    /// The supplied order is the system screen order, not the focused window's screen.
    static func preferredID(_ screens: [DeckDisplayCandidate]) -> UInt32? {
        (screens.first { $0.builtIn && $0.hasNotch }
            ?? screens.first { $0.builtIn }
            ?? screens.first)?.id
    }
}

@MainActor
final class DeckDisplay: ObservableObject {
    @Published private(set) var frame: NSRect = .zero
    @Published private(set) var notchWidth: CGFloat = 160
    @Published private(set) var menuBarHeight: CGFloat = 24

    init() { refresh() }

    func refresh() {
        let screens = NSScreen.screens
        func id(_ screen: NSScreen) -> UInt32 {
            (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        }
        let selected = DeckDisplayPolicy.preferredID(screens.map {
            DeckDisplayCandidate(id: id($0), builtIn: CGDisplayIsBuiltin(id($0)) != 0,
                                 hasNotch: $0.auxiliaryTopLeftArea != nil && $0.auxiliaryTopRightArea != nil)
        })
        guard let screen = screens.first(where: { id($0) == selected }) else { return }
        frame = screen.frame
        menuBarHeight = max(24, screen.safeAreaInsets.top)
        if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            notchWidth = max(74, right.minX - left.maxX)
        } else {
            notchWidth = 160
        }
    }

    var windowFrame: NSRect {
        NSRect(x: frame.midX - DeckPanel.expandedWidth / 2,
               y: frame.maxY - DeckPanel.expandedHeight,
               width: DeckPanel.expandedWidth, height: DeckPanel.expandedHeight)
    }

    var hotRect: NSRect {
        NSRect(x: frame.midX - notchWidth / 2, y: frame.maxY - menuBarHeight,
               width: notchWidth, height: menuBarHeight)
    }
}
