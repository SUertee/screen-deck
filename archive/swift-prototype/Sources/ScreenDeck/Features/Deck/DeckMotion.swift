import SwiftUI

/// Shared motion and hover policy. Keep text and click targets stationary.
enum DeckMotion {
    static func clampedSize(_ size: CGSize, screen: CGSize) -> CGSize {
        CGSize(width: min(max(340, size.width), min(800, max(340, screen.width - 32))),
               height: min(max(160, size.height), min(640, max(160, screen.height - 80))))
    }
    static let expandDelay: TimeInterval = 0.16
    static let expandedLeaveDelay: TimeInterval = 0.7
    static let peekLeaveDelay: TimeInterval = 0.18

    static func transition(to state: DeckState, reduceMotion: Bool) -> Animation {
        if reduceMotion { return .easeOut(duration: 0.1) }
        switch state {
        case .expanded: return .spring(response: 0.34, dampingFraction: 1)
        case .peeked: return .easeOut(duration: 0.14)
        case .collapsed: return .easeInOut(duration: 0.22)
        }
    }

    static func highlight(at point: CGPoint?, size: CGSize, enabled: Bool) -> CGSize {
        guard enabled, let point, size.width > 0, size.height > 0 else { return .zero }
        let x = min(max(point.x / size.width, 0), 1) - 0.5
        let y = min(max(point.y / size.height, 0), 1) - 0.5
        return CGSize(width: x * 12, height: y * 6)
    }

    static func allowsAutoCollapse(state: DeckState, editing: Bool, pinned: Bool) -> Bool {
        state == .peeked && !editing && !pinned
    }

    static func allowsOutsideDismiss(state: DeckState, editing: Bool, pinned: Bool) -> Bool {
        state == .expanded && !editing && !pinned
    }

    static func contentSize(hasTasks: Bool) -> CGSize {
        // Keep the window stable when the first task is saved; only the shell animates.
        CGSize(width: 440, height: 260)
    }

    static func listHeight(rows: Int, hasCompleted: Bool, hasError: Bool, menuHeight: CGFloat) -> CGFloat {
        min(360, max(160, menuHeight + 40 + 30 + CGFloat(max(0, rows) + 1) * 48
                     + (hasCompleted ? 26 : 0) + (hasError ? 80 : 0)))
    }
}
