import Foundation
@main struct ScreenMetadataTests {
    static func main() {
        let left = CGRect(x: -1280, y: 0, width: 1280, height: 800), right = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        func window(_ id: UInt32, _ pid: Int32, _ rect: CGRect, _ layer: Int = 0, _ name: String = "Editor") -> ScreenWindowCandidate {
            ScreenWindowCandidate(id: id, title: "Synthetic window", appName: name, bundleID: "fixture.\(name)", processID: pid, bounds: rect, layer: layer, isOnScreen: true)
        }
        let onLeft = window(1, 101, left), onRight = window(2, 202, right), overlay = window(3, 303, right, 10)
        let tiny = window(6, 606, CGRect(x: 10, y: 10, width: 1, height: 1))
        let selected = ScreenMetadata.topmostWindow([tiny, overlay, onLeft, onRight], displayBounds: right, excludedApps: [])!
        precondition(selected.id == 2, "Never attribute another screen's frontmost app to this display")
        let context = ScreenMetadata.context(selected, frontmostPID: 101, observedAt: "2026-10-21T00:00:00Z")
        precondition(context["appIsFrontmost"] as? Bool == false)
        precondition(context["windowFocus"] as? String == "unknown")
        precondition(ScreenMetadata.topmostWindow([onLeft], displayBounds: right, excludedApps: []) == nil)
        precondition(ScreenMetadata.topmostWindow([onRight], displayBounds: right, excludedApps: ["FIXTURE.EDITOR"]) == nil)
        let span = window(4, 404, CGRect(x: -100, y: 20, width: 400, height: 300))
        precondition(ScreenMetadata.topmostWindow([span], displayBounds: left, excludedApps: [])?.id == 4)
        precondition(ScreenMetadata.topmostWindow([span], displayBounds: right, excludedApps: [])?.id == 4)
        let empty = ScreenMetadata.context(nil, frontmostPID: 101, observedAt: "2026-10-21T00:00:00Z")
        precondition(empty["kind"] as? String == "unattributed" && empty["appIsFrontmost"] is NSNull && empty["window"] == nil)
        let unstable = ScreenMetadata.context(onRight, frontmostPID: nil, observedAt: "2026-10-21T00:00:00Z")
        precondition(unstable["appIsFrontmost"] is NSNull)
        precondition(ScreenMetadata.topmostWindow([onRight, window(5, 202, right)], displayBounds: right, excludedApps: [])?.id == 2, "Same-app windows do not all become focused")
        print("PASS native metadata: display intersection, z-order, exclusions, spanning window, unknown focus, unstable foreground")
    }
}
