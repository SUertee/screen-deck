import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

/// Temporary fixtures only: these are layout checks, not acceptance of the user's running app.
final class ProjectSettingsRenderTests: XCTestCase {
    @MainActor
    func testProjectAndMigrationSettingsRenderWithoutMutationsOrCapture() async throws {
        _ = NSApplication.shared
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-project-settings-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("source", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        _ = try ProjectIdentityStore().initialize(root: folder, name: "临时项目")
        let identityURL = folder.appendingPathComponent(".screendeck/project.json")
        let original = try Data(contentsOf: identityURL)
        let projects = ProjectWorkspaceController(store: ProjectAssociationStore(url: root.appendingPathComponent("projects.json")))
        let state = AppState(store: LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json")))
        state.refresh()
        let service = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("WorkSessions"), captureService: service)
        memory.load()
        let draft = SettingsDraft(memory: memory)
        var migrations = 0
        for stage in ["unloaded", "empty", "linked"] {
            if stage == "empty" {
                let loaded = await projects.load()
                XCTAssertTrue(loaded)
            }
            if stage == "linked" {
                let linked = await projects.associate(root: folder)
                XCTAssertTrue(linked)
            }
            for scheme in [ColorScheme.light, .dark] {
                for section in [SettingsSection.projects, .privacy] {
                    draft.section = section
                    let view = DeckSettingsView(state: state, memory: memory, draft: draft,
                        projects: projects, onMigrateStorage: { migrations += 1 })
                        .frame(width: 740, height: 580).environment(\.colorScheme, scheme)
                    let hosting = NSHostingView(rootView: view)
                    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 580),
                        styleMask: [.borderless], backing: .buffered, defer: false)
                    window.contentView = hosting
                    hosting.frame = NSRect(x: 0, y: 0, width: 740, height: 580)
                    hosting.layoutSubtreeIfNeeded()
                    try await Task.sleep(for: .milliseconds(60))
                    hosting.displayIfNeeded()
                    let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
                    hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
                    XCTAssertGreaterThan(bitmap.pixelsWide, 0)
                    if let output = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"] {
                        let directory = URL(fileURLWithPath: output, isDirectory: true)
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to:
                            directory.appendingPathComponent("settings-\(stage)-\(section.rawValue)-\(scheme == .dark ? "dark" : "light").png"))
                    }
                    window.orderOut(nil)
                }
            }
        }
        XCTAssertEqual(try Data(contentsOf: identityURL), original)
        XCTAssertEqual(migrations, 0)
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(service.captures, 0)
        XCTAssertEqual(service.requests, 0)
    }
}
