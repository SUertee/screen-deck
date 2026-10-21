import Cocoa
import ScreenCaptureKit
import Vision
import CoreGraphics

struct Options: Decodable {
    let displayID: UInt32?
    let excludedApps: [String]
}

@available(macOS 14.0, *)
@main struct ScreenRecorder {
    static func emit(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
    }
    @MainActor static func displayInfo(_ display: SCDisplay) -> [String: Any] {
        let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }
        var result: [String: Any] = ["id": Int(display.displayID), "name": String((screen?.localizedName ?? "显示器 \(display.displayID)").prefix(200)), "width": display.width, "height": display.height, "bounds": ScreenMetadata.rect(CGDisplayBounds(display.displayID))]
        if let uuid = CGDisplayCreateUUIDFromDisplayID(display.displayID)?.takeRetainedValue() {
            result["uuid"] = CFUUIDCreateString(nil, uuid) as String
        }
        return result
    }
    @MainActor static func main() async {
        do {
            let command = CommandLine.arguments.dropFirst().first ?? ""
            if command == "permission" {
                try emit(["granted": CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()]); return
            }
            guard CGPreflightScreenCaptureAccess() else { try emit(["error": "permission"]); return }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            if command == "displays" {
                try emit(content.displays.map { displayInfo($0) }); return
            }
            guard command == "capture" else { throw NSError(domain: "command", code: 1) }
            let options = try JSONDecoder().decode(Options.self, from: FileHandle.standardInput.readDataToEndOfFile())
            guard let display = content.displays.first(where: { options.displayID == nil ? $0.displayID == CGMainDisplayID() : $0.displayID == options.displayID }) else {
                try emit(["error": "display"]); return
            }
            let exclusions = options.excludedApps.map { $0.lowercased() }
            let front = NSWorkspace.shared.frontmostApplication
            let appName = front?.localizedName ?? "未知应用"
            let bundleID = front?.bundleIdentifier ?? ""
            func excluded(_ name: String, _ id: String) -> Bool { exclusions.contains(name.lowercased()) || exclusions.contains(id.lowercased()) }
            // Skip the whole sample when an excluded app is in front; also remove its background windows.
            if excluded(appName, bundleID) { try emit(["skipped": true]); return }
            let hidden = content.applications.filter { excluded($0.applicationName, $0.bundleIdentifier) }
            // SCShareableContent order is unspecified. Match its window IDs to the
            // CGWindowList front-to-back order and global display bounds instead.
            let byID = Dictionary(content.windows.map { ($0.windowID, $0) }, uniquingKeysWith: { first, _ in first })
            let ordered = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).compactMap { info -> ScreenWindowCandidate? in
                guard let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                      let window = byID[id], window.isOnScreen,
                      let app = window.owningApplication,
                      let rawBounds = info[kCGWindowBounds as String] as? [String: Any],
                      let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else { return nil }
                return ScreenWindowCandidate(id: id, title: window.title ?? "", appName: app.applicationName, bundleID: app.bundleIdentifier,
                    processID: app.processID, bounds: bounds, layer: window.windowLayer, isOnScreen: window.isOnScreen)
            }
            let window = ScreenMetadata.topmostWindow(ordered, displayBounds: CGDisplayBounds(display.displayID), excludedApps: options.excludedApps)
            let observedAt = ISO8601DateFormatter().string(from: Date())
            let filter = SCContentFilter(display: display, excludingApplications: hidden, exceptingWindows: [])
            let config = SCStreamConfiguration()
            config.width = min(display.width * 2, 1920)
            config.height = Int(Double(config.width) * Double(display.height) / Double(display.width))
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            // App activation can change during the async screenshot; do not label
            // a selected window as focused, or retain an unstable app-active claim.
            let after = NSWorkspace.shared.frontmostApplication
            let stableFrontmostPID = front?.processIdentifier == after?.processIdentifier ? front?.processIdentifier : nil
            if let after, excluded(after.localizedName ?? "", after.bundleIdentifier ?? "") { try emit(["skipped": true]); return }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            let text = String((request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").prefix(24000))
            let bitmap = NSBitmapImageRep(cgImage: image)
            guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.72]) else { throw NSError(domain: "image", code: 1) }
            try emit(["appName": String((window?.appName ?? "未识别本屏应用").prefix(200)), "bundleID": window?.bundleID ?? "", "displayID": Int(display.displayID), "width": image.width, "height": image.height, "text": text, "jpeg": jpeg.base64EncodedString(), "capturedAt": observedAt, "display": displayInfo(display), "context": ScreenMetadata.context(window, frontmostPID: stableFrontmostPID, observedAt: observedAt)])
        } catch {
            // Never emit OCR content, paths, or OS diagnostic strings on failure.
            try? emit(["error": "capture"])
            exit(1)
        }
    }
}
