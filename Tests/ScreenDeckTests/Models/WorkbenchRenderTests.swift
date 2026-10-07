import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

final class WorkbenchRenderTests: XCTestCase {
    @MainActor
    func testSettingsRenderInBothAppearancesWithoutCapture() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let state = AppState(store: LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json")))
        state.refresh()
        let service = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("WorkSessions"), captureService: service)
        memory.load(); await memory.refreshDisplays()
        let draft = SettingsDraft(memory: memory)
        draft.value.displayIDs = [1]
        for scheme in [ColorScheme.light, .dark] {
            for section in SettingsSection.allCases {
                draft.section = section
                let view = DeckSettingsView(state: state, memory: memory, draft: draft)
                    .frame(width: 740, height: 580).environment(\.colorScheme, scheme)
                let hosting = NSHostingView(rootView: view)
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 580), styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = hosting
                hosting.frame = NSRect(x: 0, y: 0, width: 740, height: 580)
                hosting.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(80))
                hosting.displayIfNeeded()
                let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
                hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                XCTAssertGreaterThan(bitmap.pixelsWide, 0)
                if let directory = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"] {
                    let url = URL(fileURLWithPath: directory, isDirectory: true)
                    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    try png.write(to: url.appendingPathComponent("设置-\(section.rawValue)-\(scheme == .dark ? "深色" : "浅色").png"))
                }
            }
        }
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(service.captures, 0)
        XCTAssertEqual(service.requests, 0)
    }

    @MainActor
    func testFixtureRendersWithoutCaptureOrUserData() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json"))
        let state = AppState(store: store); state.refresh()
        XCTAssertTrue(state.createTask(title: "竞品分析报告"))
        let task = try XCTUnwrap(state.currentTask)
        XCTAssertTrue(state.addSubtask(taskID: task.id, title: "核对产品 B 的免费版限制"))
        XCTAssertTrue(state.addSubtask(taskID: task.id, title: "整理比较结论"))
        XCTAssertTrue(state.saveResume(taskID: task.id, content: ResumeContent(progress: "产品 A 已整理；产品 B 的限制待确认。", nextStep: "核对产品 B 的免费版限制"), requestID: UUID()))
        let memory = WorkSessionController(root: root.appendingPathComponent("WorkSessions"))
        memory.load()
        for name in ["任务", "接续", "子任务", "记录"] {
            let view = WorkbenchView(state: state, memory: memory, initialTaskID: name == "任务" ? nil : task.id, initialTab: name)
                .frame(width: 440, height: 190).background(Color.black).environment(\.colorScheme, .dark)
            let hosting = NSHostingView(rootView: view)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 190), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = hosting
            hosting.frame = NSRect(x: 0, y: 0, width: 440, height: 190)
            hosting.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(80))
            hosting.displayIfNeeded()
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            XCTAssertGreaterThan(bitmap.pixelsWide, 0)
            let colors = stride(from: 0, to: bitmap.pixelsHigh, by: 3).flatMap { y in
                stride(from: 0, to: bitmap.pixelsWide, by: 3).compactMap { x in bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)?.redComponent }
            }
            XCTAssertGreaterThan((colors.max() ?? 0) - (colors.min() ?? 0), 0.3, "Rendered UI must not be a blank black image")
            if let directory = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"] {
                let url = URL(fileURLWithPath: directory, isDirectory: true)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: url.appendingPathComponent("\(name).png"))
            }
        }
        XCTAssertNil(memory.activeID)
    }
}
