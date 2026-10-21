import Foundation
import CoreGraphics

struct ScreenWindowCandidate {
    let id: UInt32
    let title: String
    let appName: String
    let bundleID: String
    let processID: Int32
    let bounds: CGRect
    let layer: Int
    let isOnScreen: Bool
}

/// Input order is CoreGraphics front-to-back. No OS calls or capture in this policy.
enum ScreenMetadata {
    static func rect(_ value: CGRect) -> [String: Double] {
        ["x": value.origin.x, "y": value.origin.y, "width": value.width, "height": value.height]
    }
    static func topmostWindow(_ windows: [ScreenWindowCandidate], displayBounds: CGRect, excludedApps: [String]) -> ScreenWindowCandidate? {
        let excluded = Set(excludedApps.map { $0.lowercased() })
        return windows.first {
            $0.isOnScreen && $0.layer == 0 && $0.bounds.width >= 100 && $0.bounds.height >= 100 &&
            !$0.bounds.intersection(displayBounds).isEmpty &&
            !excluded.contains($0.appName.lowercased()) && !excluded.contains($0.bundleID.lowercased())
        }
    }
    static func context(_ window: ScreenWindowCandidate?, frontmostPID: Int32?, observedAt: String) -> [String: Any] {
        guard let window else {
            return ["kind": "unattributed", "observedAt": observedAt, "appIsFrontmost": NSNull(), "windowFocus": "unknown"]
        }
        return ["kind": "topmost-window-on-display", "observedAt": observedAt,
                "appIsFrontmost": frontmostPID.map { $0 == window.processID } as Any? ?? NSNull(),
                "windowFocus": "unknown", "window": ["id": Int(window.id), "title": String(window.title.prefix(1000)), "bounds": rect(window.bounds)]]
    }
}
