import Foundation

enum ScreenDeckStorageLocation: Equatable {
    case legacy, global
}

/// One resolver for all private stores. Construction and resolution never create or migrate data.
struct ScreenDeckPaths {
    let root: URL
    let legacyRoot: URL

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, legacyRoot: URL? = nil) {
        // Do not use standardizedFileURL here: macOS rewrites /private/var to the /var symlink.
        // Migration validates the supplied components without silently following aliases.
        root = home.appendingPathComponent(".screendeck", isDirectory: true)
        self.legacyRoot = legacyRoot ?? home.appendingPathComponent("Library/Application Support/ScreenDeck", isDirectory: true)
    }

    var config: URL { root.appendingPathComponent("config.toml") }
    var projects: URL { projects(in: .global) }
    var workspace: URL { workspace(in: .global) }
    var projectConversations: URL { projectConversations(in: .global) }
    var sessions: URL { sessions(in: .global) }
    // Dialogue history is independent of legacy workspace/capture storage and is never dual-written.
    var sessionHistory: URL { root.appendingPathComponent("sessions", isDirectory: true) }
    // Detection only: existing pre-rename history requires an explicit migration, not an empty new library.
    var previousSessionHistory: URL { root.appendingPathComponent("conversations/history", isDirectory: true) }
    var previousFlatSessionHistory: URL { root.appendingPathComponent("sessions/history", isDirectory: true) }
    var previousSessionHistoryRoots: [URL] { [previousFlatSessionHistory, previousSessionHistory] }
    var migrationMarker: URL { root.appendingPathComponent("storage-migration.json") }

    func activeLocation() throws -> ScreenDeckStorageLocation {
        if try StorageMigration.readMarker(paths: self) != nil { return .global }
        return try StorageMigration.hasLegacyData(paths: self) ? .legacy : .global
    }

    func activeRoot() throws -> URL { try activeLocation() == .legacy ? legacyRoot : root }
    func activeConfig() throws -> URL { try activeRoot().appendingPathComponent("config.toml") }
    func activeWorkspace() throws -> URL { try workspace(in: activeLocation()) }
    func activeProjects() throws -> URL { try projects(in: activeLocation()) }
    func activeProjectConversations() throws -> URL { try projectConversations(in: activeLocation()) }
    func activeSessions() throws -> URL { try sessions(in: activeLocation()) }

    func workspace(in location: ScreenDeckStorageLocation) -> URL {
        location == .legacy ? legacyRoot.appendingPathComponent("workspace.json") : root.appendingPathComponent("tasks/local-workspace.json")
    }
    func projects(in location: ScreenDeckStorageLocation) -> URL {
        location == .legacy ? legacyRoot.appendingPathComponent("project-associations.json") : root.appendingPathComponent("projects.json")
    }
    func projectConversations(in location: ScreenDeckStorageLocation) -> URL {
        location == .legacy ? legacyRoot.appendingPathComponent("project-conversations.json") : root.appendingPathComponent("conversations/project-drafts.json")
    }
    func sessions(in location: ScreenDeckStorageLocation) -> URL {
        (location == .legacy ? legacyRoot : root.appendingPathComponent("artifacts", isDirectory: true)).appendingPathComponent("WorkSessions", isDirectory: true)
    }
}
