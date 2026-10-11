import XCTest
@testable import ScreenDeck

final class SessionHistoryPathTests: XCTestCase {
    func testNewHistoryHasOneStableGlobalRootAndConstructionCreatesNothing() throws {
        let home = URL(fileURLWithPath: "/private/tmp/screendeck-chat-path-\(UUID().uuidString)", isDirectory: true)
        let paths = ScreenDeckPaths(home: home)
        XCTAssertEqual(paths.sessionHistory.path, home.appendingPathComponent(".screendeck/sessions").path)
        XCTAssertEqual(paths.previousSessionHistory.path, home.appendingPathComponent(".screendeck/conversations/history").path)
        XCTAssertEqual(paths.previousFlatSessionHistory.path, home.appendingPathComponent(".screendeck/sessions/history").path)
        XCTAssertEqual(Set(paths.previousSessionHistoryRoots), Set([paths.previousSessionHistory, paths.previousFlatSessionHistory]))
        XCTAssertEqual(paths.projectConversations.path, home.appendingPathComponent(".screendeck/conversations/project-drafts.json").path)
        XCTAssertEqual(paths.sessions.path, home.appendingPathComponent(".screendeck/artifacts/WorkSessions").path)
        XCTAssertEqual(try paths.activeLocation(), .global)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.path))
    }

    func testLegacyWorkspaceSelectionDoesNotMoveOrCreateIndependentChatHistory() throws {
        let home = URL(fileURLWithPath: "/private/tmp/screendeck-chat-path-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let paths = ScreenDeckPaths(home: home)
        try FileManager.default.createDirectory(at: paths.legacyRoot, withIntermediateDirectories: true)
        // Only names are inspected by path selection, never migrated or replaced here.
        try Data("legacy-path-fixture".utf8).write(to: paths.workspace(in: .legacy))
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        XCTAssertEqual(paths.sessionHistory.path, home.appendingPathComponent(".screendeck/sessions").path)
        XCTAssertEqual(paths.previousSessionHistory.path, home.appendingPathComponent(".screendeck/conversations/history").path)
        XCTAssertEqual(paths.previousFlatSessionHistory.path, home.appendingPathComponent(".screendeck/sessions/history").path)
        XCTAssertEqual(try paths.activeProjectConversations(), paths.legacyRoot.appendingPathComponent("project-conversations.json"))
        XCTAssertEqual(try paths.activeSessions(), paths.legacyRoot.appendingPathComponent("WorkSessions", isDirectory: true))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root.path))
        XCTAssertEqual(try Data(contentsOf: paths.workspace(in: .legacy)), Data("legacy-path-fixture".utf8))
    }
}
