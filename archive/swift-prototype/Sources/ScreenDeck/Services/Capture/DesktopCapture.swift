import AppKit
import ScreenCaptureKit
import Vision
import ImageIO
import UniformTypeIdentifiers

struct CaptureDisplay: Identifiable, Equatable {
    let id: UInt32
    let name: String
    let width: Int
    let height: Int
}

struct CapturedDesktop {
    let display: CaptureDisplay
    let jpeg: Data
    let text: String
    let appName: String
    let capturedAt: Date
}

enum CaptureFailure: LocalizedError {
    case permission, missingDisplay, encoding, noSelection
    var errorDescription: String? {
        switch self {
        case .permission: return "未获得屏幕录制权限。请在系统设置中允许 ScreenDeck，然后重新打开应用。"
        case .missingDisplay: return "所选显示器已断开。已停止记录，请重新选择屏幕。"
        case .encoding: return "截图编码失败，原有记录仍保留。"
        case .noSelection: return "请选择至少一个要记录的屏幕。"
        }
    }
}

@MainActor
protocol DesktopCapturing {
    var hasPermission: Bool { get }
    func requestPermission()
    func displays() async throws -> [CaptureDisplay]
    func capture(display: CaptureDisplay) async throws -> CapturedDesktop
}

/// Independent implementation using Apple frameworks. No Screenpipe dependency.
@MainActor
final class DesktopCapture: DesktopCapturing {
    var hasPermission: Bool { CGPreflightScreenCaptureAccess() }
    func requestPermission() { CGRequestScreenCaptureAccess() }

    func displays() async throws -> [CaptureDisplay] {
        guard hasPermission else { throw CaptureFailure.permission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return content.displays.map { display in
            let name = NSScreen.screens.first {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID
            }?.localizedName ?? "显示器 \(display.displayID)"
            return CaptureDisplay(id: display.displayID, name: name, width: display.width, height: display.height)
        }.sorted { $0.id < $1.id }
    }

    func capture(display: CaptureDisplay) async throws -> CapturedDesktop {
        guard hasPermission else { throw CaptureFailure.permission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let source = content.displays.first(where: { $0.displayID == display.id }) else { throw CaptureFailure.missingDisplay }
        // Excluding this process prevents the Deck from repeatedly capturing its own transcript.
        // This is not a sensitive-data detector: all other visible content may be recorded.
        let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: source, excludingApplications: ownApps, exceptingWindows: [])
        let config = SCStreamConfiguration()
        let scale = min(1.0, 2560.0 / Double(max(source.width, source.height)))
        config.width = max(1, Int(Double(source.width) * scale))
        config.height = max(1, Int(Double(source.height) * scale))
        config.showsCursor = false
        config.capturesAudio = false
        let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "未知应用"
        let capturedAt = Date()
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        try Task.checkCancellation()
        let processed = try await Task.detached(priority: .utility) { () throws -> (Data, String) in
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
                throw CaptureFailure.encoding
            }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw CaptureFailure.encoding }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            return (data as Data, String(text.prefix(16000)))
        }.value
        try Task.checkCancellation()
        return CapturedDesktop(display: display, jpeg: processed.0, text: processed.1, appName: app, capturedAt: capturedAt)
    }
}
