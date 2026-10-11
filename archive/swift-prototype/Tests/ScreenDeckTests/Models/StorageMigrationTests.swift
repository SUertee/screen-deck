import XCTest
import Darwin
@testable import ScreenDeck

final class StorageMigrationTests: XCTestCase {
    private func fixture() throws -> ScreenDeckPaths {
        let home = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("storage-migration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        return ScreenDeckPaths(home: home, legacyRoot: home.appendingPathComponent("legacy", isDirectory: true))
    }
    private func writeLegacy(_ paths: ScreenDeckPaths) throws -> LocalWorkspace {
        let workspace = LocalWorkspace(tasks: [LocalTask(title: "保留任务")])
        try LocalWorkspaceStore(url: paths.workspace(in: .legacy)).save(workspace)
        try ProjectAssociationStore(url: paths.projects(in: .legacy)).save(.init())
        try ProjectConversationStore(url: paths.projectConversations(in: .legacy)).save(.init(), replacing: .init())
        return workspace
    }
    private func savePreferences(_ paths: ScreenDeckPaths) throws -> CapturePreferences {
        let preferences = CapturePreferences(displayIDs: [1, 2], interval: 30, model: "local")
        try CapturePreferencesStore(url: paths.sessions(in: .legacy).appendingPathComponent("capture-preferences.json")).save(preferences)
        return preferences
    }

    func testFreshPathsResolveWithoutWritingDirectories() throws {
        let paths = try fixture()
        XCTAssertEqual(try paths.activeLocation(), .global)
        XCTAssertEqual(try paths.activeWorkspace(), paths.root.appendingPathComponent("tasks/local-workspace.json"))
        XCTAssertEqual(paths.sessions.path, paths.root.appendingPathComponent("artifacts/WorkSessions").path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root.path))
        XCTAssertFalse(try StorageMigration(paths: paths).inspect().isNeeded)
    }

    func testExplicitMigrationCopiesValidatedBytesRetainsLegacyAndIsIdempotent() throws {
        let paths = try fixture()
        let workspace = try writeLegacy(paths)
        let original = try Data(contentsOf: paths.workspace(in: .legacy))
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        let inspection = try StorageMigration(paths: paths).inspect()
        XCTAssertTrue(inspection.isNeeded)
        XCTAssertEqual(inspection.fileCount, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root.path))
        let result = try StorageMigration(paths: paths).migrate()
        XCTAssertEqual(result.legacyBackupURL, paths.legacyRoot)
        XCTAssertFalse(result.alreadyComplete)
        XCTAssertEqual(try paths.activeLocation(), .global)
        XCTAssertEqual(try LocalWorkspaceStore(url: paths.workspace).load(), workspace)
        XCTAssertEqual(try Data(contentsOf: paths.workspace(in: .legacy)), original)
        XCTAssertEqual(try Data(contentsOf: paths.workspace), original)
        let marker = try Data(contentsOf: paths.migrationMarker)
        XCTAssertTrue(try StorageMigration(paths: paths).migrate().alreadyComplete)
        XCTAssertEqual(try Data(contentsOf: paths.migrationMarker), marker)
        XCTAssertTrue(try StorageMigration(paths: paths).inspect().isComplete)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: paths.workspace.path)[.posixPermissions] as? NSNumber, 0o600)
    }

    func testCapturePreferencesAndWorkSessionImagesStayAssociatedWithoutStartingCapture() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        let preferences = try savePreferences(paths)
        let started = Date()
        let evidence = WorkEvidence(capturedAt: started, displayID: 1, displayName: "主屏", appName: "Editor", text: "保留证据", imageName: "")
        var imageEvidence = evidence; imageEvidence.imageName = "\(evidence.id.uuidString).jpg"
        let session = WorkSession(taskID: UUID(), taskTitle: "任务", startedAt: started,
                                  endedAt: started, status: .paused, displayIDs: [1], evidence: [imageEvidence])
        let old = WorkSessionStore(root: paths.sessions(in: .legacy)); try old.save(session)
        let image = Data([0xFF, 0xD8, 0xFF, 0xD9])
        try image.write(to: try XCTUnwrap(old.imageURL(sessionID: session.id, evidence: imageEvidence)))
        var converted: CapturePreferences?
        let result = try StorageMigration(paths: paths).migrate { value, destination in
            converted = value
            try ConfigurationParser.encode(UserConfiguration(capturePreferences: value ?? .init())).write(to: destination)
        }
        XCTAssertEqual(converted, preferences)
        XCTAssertEqual(result.fileCount, 7)
        let new = WorkSessionStore(root: paths.sessions)
        XCTAssertEqual(try new.load(), [session])
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(new.imageURL(sessionID: session.id, evidence: imageEvidence))), image)
        XCTAssertEqual(try old.load(), [session])
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessions.appendingPathComponent("capture-preferences.json").path))
        // A user may legitimately trash captured sessions; the manifest is historical, not live inventory.
        try FileManager.default.removeItem(at: new.folder(session.id))
        XCTAssertEqual(try paths.activeLocation(), .global)
    }

    func testPreferencesRequireExplicitConfigurationConversion() throws {
        let paths = try fixture(); _ = try writeLegacy(paths); _ = try savePreferences(paths)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate()) { error in
            XCTAssertEqual(error as? StorageMigrationFailure, .needsConfiguration)
        }
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.migrationMarker.path))
    }

    func testCorruptOrUnknownVersionAndUnknownLegacyFileDoNotMutateSource() throws {
        for content in ["broken", "{\"schemaVersion\":2,\"tasks\":[]}"] {
            let paths = try fixture(); _ = try writeLegacy(paths)
            let data = Data(content.utf8); try data.write(to: paths.workspace(in: .legacy))
            XCTAssertThrowsError(try StorageMigration(paths: paths).migrate())
            XCTAssertEqual(try Data(contentsOf: paths.workspace(in: .legacy)), data)
            XCTAssertFalse(FileManager.default.fileExists(atPath: paths.root.path))
        }
        let paths = try fixture(); _ = try writeLegacy(paths)
        try Data("unknown private file".utf8).write(to: paths.legacyRoot.appendingPathComponent("future.json"))
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate())
        XCTAssertEqual(try paths.activeLocation(), .legacy)
    }

    func testDestinationConflictNeverOverwritesEvenUnknownContent() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        try FileManager.default.createDirectory(at: paths.workspace.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = Data("unknown destination".utf8); try data.write(to: paths.workspace)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate()) { error in
            XCTAssertEqual(error as? StorageMigrationFailure, .destinationConflict)
        }
        XCTAssertEqual(try Data(contentsOf: paths.workspace), data)
        XCTAssertEqual(try paths.activeLocation(), .legacy)
    }

    func testExistingConfigurationAndSessionDirectoryAreNotOverwritten() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        try FileManager.default.createDirectory(at: paths.root, withIntermediateDirectories: true)
        let original = Data("private config".utf8); try original.write(to: paths.config)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { _, url in try Data("converted".utf8).write(to: url) })
        XCTAssertEqual(try Data(contentsOf: paths.config), original)
        let other = try fixture(); _ = try writeLegacy(other); _ = try savePreferences(other)
        try FileManager.default.createDirectory(at: other.sessions, withIntermediateDirectories: true)
        XCTAssertThrowsError(try StorageMigration(paths: other).migrate { _, url in try Data("converted".utf8).write(to: url) })
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.migrationMarker.path))
    }

    func testSourceAndDestinationSymlinkAncestorsAreRejected() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        let original = try Data(contentsOf: paths.workspace(in: .legacy))
        let alias = paths.legacyRoot.appendingPathComponent("original.json")
        try original.write(to: alias)
        try FileManager.default.removeItem(at: paths.workspace(in: .legacy))
        try FileManager.default.createSymbolicLink(at: paths.workspace(in: .legacy), withDestinationURL: alias)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate())
        XCTAssertEqual(try Data(contentsOf: alias), original)
        let other = try fixture(); _ = try writeLegacy(other)
        let target = other.root.deletingLastPathComponent().appendingPathComponent("other")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: other.root, withDestinationURL: target)
        XCTAssertThrowsError(try StorageMigration(paths: other).migrate())
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
    }

    func testConversionFailureAndSourceChangeRollbackUncommittedFiles() throws {
        let paths = try fixture(); _ = try writeLegacy(paths); _ = try savePreferences(paths)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { value, url in
            try Data("partial conversion".utf8).write(to: url)
            throw WorkspaceError.invalidData
        })
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.workspace.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.config.path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: paths.root.path).isEmpty)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { value, url in
            try ConfigurationParser.encode(UserConfiguration(capturePreferences: value ?? .init())).write(to: url)
            // Simulate a non-cooperating external writer; normal stores are locked during migration.
            try JSONEncoder().encode(LocalWorkspace(tasks: [LocalTask(title: "外部修改")])).write(to: paths.workspace(in: .legacy), options: .atomic)
        }) { error in XCTAssertEqual(error as? StorageMigrationFailure, .sourceChanged) }
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        XCTAssertEqual(try LocalWorkspaceStore(url: paths.workspace(in: .legacy)).load().tasks.first?.title, "外部修改")
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.migrationMarker.path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: paths.root.path).isEmpty)
    }

    func testAddedSourceDuringConversionIsDetected() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { _, url in
            try Data("config_version = 1".utf8).write(to: url)
            _ = try self.savePreferences(paths)
        }) { error in XCTAssertEqual(error as? StorageMigrationFailure, .sourceChanged) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.migrationMarker.path))
        XCTAssertEqual(try paths.activeLocation(), .legacy)
    }

    func testLimitsAndInterruptedMigrationLockPreventActivation() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        var migration = StorageMigration(paths: paths); migration.maximumFiles = 1
        XCTAssertThrowsError(try migration.migrate()) { error in XCTAssertEqual(error as? StorageMigrationFailure, .tooLarge) }
        migration.maximumFiles = 5000; migration.maximumTotalBytes = 1
        XCTAssertThrowsError(try migration.migrate())
        try FileManager.default.createDirectory(at: paths.root, withIntermediateDirectories: true)
        let lock = paths.root.appendingPathComponent(".storage-migration-lock")
        let original = Data("existing lock".utf8); try original.write(to: lock)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate()) { error in XCTAssertEqual(error as? StorageMigrationFailure, .inProgress) }
        XCTAssertEqual(try Data(contentsOf: lock), original)
        XCTAssertEqual(try paths.activeLocation(), .legacy)
    }

    func testDamagedOrSymlinkMarkerNeverSilentlySwitchesOrFallsBack() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        try FileManager.default.createDirectory(at: paths.root, withIntermediateDirectories: true)
        let data = Data("unknown marker".utf8); try data.write(to: paths.migrationMarker)
        XCTAssertThrowsError(try paths.activeLocation())
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate())
        XCTAssertEqual(try Data(contentsOf: paths.migrationMarker), data)
        let other = try fixture(); _ = try writeLegacy(other)
        try FileManager.default.createDirectory(at: other.root, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: other.migrationMarker, withDestinationURL: paths.migrationMarker)
        XCTAssertThrowsError(try other.activeLocation())
    }

    func testMissingOrSymlinkCommittedFileFailsClosedButLegitimateEditsRemainValid() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        _ = try StorageMigration(paths: paths).migrate()
        try LocalWorkspaceStore(url: paths.workspace).save(.init(tasks: [LocalTask(title: "正常修改")]))
        XCTAssertEqual(try paths.activeLocation(), .global)
        try FileManager.default.removeItem(at: paths.workspace)
        XCTAssertThrowsError(try paths.activeLocation())
        try FileManager.default.createSymbolicLink(at: paths.workspace, withDestinationURL: paths.workspace(in: .legacy))
        XCTAssertThrowsError(try paths.activeLocation())
    }

    func testForgedManifestAndEmptyManifestNeverActivate() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        _ = try StorageMigration(paths: paths).migrate()
        let original = try JSONDecoder().decode(StorageMigrationMarker.self, from: Data(contentsOf: paths.migrationMarker))
        for files in [[], [StorageMigrationMarker.Entry(source: "future.json", destination: "projects.json", sha256: String(repeating: "0", count: 64), bytes: 1)]] {
            let forged = StorageMigrationMarker(version: 1, transactionID: original.transactionID,
                legacyRootPath: original.legacyRootPath, createdAt: original.createdAt, files: files)
            try JSONEncoder().encode(forged).write(to: paths.migrationMarker)
            XCTAssertThrowsError(try paths.activeLocation())
        }
    }

    func testInvalidConfigurationAndLostPreferencesNeverActivate() throws {
        let paths = try fixture(); _ = try writeLegacy(paths); _ = try savePreferences(paths)
        for text in ["not TOML", "config_version = 2", "config_version = 1", "config_version = 1\n[capture]\nenabled = true"] {
            XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { _, destination in
                try Data(text.utf8).write(to: destination)
            })
            XCTAssertEqual(try paths.activeLocation(), .legacy)
            XCTAssertFalse(FileManager.default.fileExists(atPath: paths.config.path))
        }
    }

    func testLateDestinationConflictRollsBackOnlyOurFilesPreservingExternalRevision() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        let external = Data("external revision".utf8)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { _, destination in
            try Data("config_version = 1".utf8).write(to: destination)
            try FileManager.default.createDirectory(at: paths.workspace.deletingLastPathComponent(), withIntermediateDirectories: true)
            try external.write(to: paths.workspace)
        }) { error in XCTAssertEqual(error as? StorageMigrationFailure, .destinationConflict) }
        XCTAssertEqual(try Data(contentsOf: paths.workspace), external)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.projects.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.projectConversations.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.migrationMarker.path))
        XCTAssertEqual(try paths.activeLocation(), .legacy)
    }

    func testKnownLegacyLockMustBeEmptyAndAvailableAndCannotChangeIdentity() throws {
        let paths = try fixture(); _ = try writeLegacy(paths)
        let lock = paths.legacyRoot.appendingPathComponent(".workspace.json.lock")
        let descriptor = open(lock.path, O_RDONLY)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { close(descriptor) }
        XCTAssertEqual(flock(descriptor, LOCK_EX | LOCK_NB), 0)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate()) { error in
            XCTAssertEqual(error as? StorageMigrationFailure, .inProgress)
        }
        flock(descriptor, LOCK_UN)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate { _, destination in
            try Data("config_version = 1".utf8).write(to: destination)
            try FileManager.default.removeItem(at: lock)
            try Data().write(to: lock)
        }) { error in XCTAssertEqual(error as? StorageMigrationFailure, .sourceChanged) }
        XCTAssertEqual(try paths.activeLocation(), .legacy)
        try Data("not lock metadata".utf8).write(to: lock)
        XCTAssertThrowsError(try StorageMigration(paths: paths).migrate())
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.migrationMarker.path))
    }
}
