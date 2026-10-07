import XCTest
@testable import ScreenDeck

final class ProjectHistoryMigrationTests: XCTestCase {
    private struct Fixture {
        let base: URL
        let source: ProjectRecordFixture
        let privateRoot: URL
        let proof: Data
        var namespace: URL { privateRoot.appendingPathComponent("projects/\(source.projectID)", isDirectory: true) }
    }
    private func fixture() throws -> Fixture {
        let base = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("project-history-migration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let source = try ProjectRecordFixture(root: base.appendingPathComponent("source", isDirectory: true))
        let privateRoot = base.appendingPathComponent("private", isDirectory: true)
        let artifactRoot = source.root.appendingPathComponent(".screendeck/artifacts/task-001", isDirectory: true)
        try FileManager.default.createDirectory(at: artifactRoot.appendingPathComponent("empty"), withIntermediateDirectories: true)
        let proof = Data([0, 1, 2, 3, 0xFF])
        try proof.write(to: artifactRoot.appendingPathComponent("preview.png"))
        try Data("原件证据\n".utf8).write(to: artifactRoot.appendingPathComponent("report.txt"))
        try source.mutate(source.taskURL) { object in
            object["references"] = [
                ["path": "docs/guide.md", "label": "正式资料"],
                ["path": ".screendeck/artifacts/task-001/preview.png", "label": "预览"]
            ]
        }
        try source.mutate(source.runURL) { object in
            object["references"] = [["path": ".screendeck/tasks/task-001.json", "label": "所属任务"]]
        }
        try source.mutate(source.projectURL) { object in
            object["references"] = [
                ["path": "docs/guide.md", "label": "正式资料"],
                ["path": ".screendeck/runs/run-20261006-001.json", "label": "首轮执行"]
            ]
        }
        return .init(base: base, source: source, privateRoot: privateRoot, proof: proof)
    }

    func testCompleteMigrationKeepsIDsFactsOriginalBackupAndPrivateReferences() throws {
        let fixture = try fixture()
        let source = fixture.source
        let originalProject = try Data(contentsOf: source.projectURL)
        let originalTask = try Data(contentsOf: source.taskURL)
        let originalRun = try Data(contentsOf: source.runURL)
        let docs = try Data(contentsOf: source.root.appendingPathComponent("docs/guide.md"))
        try FileManager.default.createDirectory(at: fixture.privateRoot, withIntermediateDirectories: true)
        let unrelated = fixture.privateRoot.appendingPathComponent("projects.json")
        let unrelatedBytes = Data("现有本机项目索引不动".utf8); try unrelatedBytes.write(to: unrelated)
        let result = try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: source.root)
        XCTAssertEqual(result.projectID, source.projectID)
        XCTAssertEqual(result.taskCount, 1); XCTAssertEqual(result.runCount, 1); XCTAssertEqual(result.artifactCount, 2)
        XCTAssertNil(result.cleanupPendingURL); XCTAssertFalse(result.alreadyMigrated)
        XCTAssertEqual(try Data(contentsOf: result.backupURL.appendingPathComponent("project.json")), originalProject)
        XCTAssertEqual(try Data(contentsOf: result.backupURL.appendingPathComponent("tasks/task-001.json")), originalTask)
        XCTAssertEqual(try Data(contentsOf: result.backupURL.appendingPathComponent("runs/run-20261006-001.json")), originalRun)
        XCTAssertEqual(try Data(contentsOf: result.backupURL.appendingPathComponent("artifacts/task-001/preview.png")), fixture.proof)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.backupURL.appendingPathComponent("artifacts/task-001/empty").path))
        let identity = try ProjectIdentityStore().read(root: source.root)
        XCTAssertEqual(identity.schemaVersion, 2); XCTAssertEqual(identity.projectID, source.projectID)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: source.projectURL)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["schema_version", "kind", "project_id", "name", "created_at"])
        for directory in ["tasks", "runs", "artifacts"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: source.root.appendingPathComponent(".screendeck/\(directory)").path))
        }
        XCTAssertEqual(try Data(contentsOf: source.root.appendingPathComponent("docs/guide.md")), docs)
        XCTAssertEqual(try Data(contentsOf: unrelated), unrelatedBytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.privateRoot.appendingPathComponent("storage-migration.json").path))
        let reader = ProjectRecordReader(privateRoot: fixture.privateRoot)
        let snapshot = try reader.read(root: source.root)
        XCTAssertEqual(snapshot.tasks.first?.taskID, "task-001")
        XCTAssertNil(snapshot.runs.first?.executor.model); XCTAssertNil(snapshot.runs.first?.executor.effort)
        XCTAssertEqual(snapshot.runs.first?.recordedAt, "2026-10-06T10:10:00+08:00")
        XCTAssertEqual(snapshot.tasks.first?.references.first?.path, "docs/guide.md")
        let privateReference = try XCTUnwrap(snapshot.tasks.first?.references.last)
        XCTAssertEqual(privateReference.path, "screendeck://\(source.projectID)/artifacts/task-001/preview.png")
        XCTAssertEqual(try reader.readReferenceData(privateReference, root: source.root, maximumBytes: 1024), fixture.proof)
        XCTAssertEqual(snapshot.project.references.last?.path, "screendeck://\(source.projectID)/runs/run-20261006-001.json")
        let backupManifest = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: result.backupURL.appendingPathComponent("backup.json"))) as? [String: Any])
        XCTAssertEqual(backupManifest["project_id"] as? String, source.projectID)
        XCTAssertEqual((backupManifest["files"] as? [[String: Any]])?.count, 5)
    }

    func testRepeatedMigrationIsIdempotentAndVerifiesBackup() throws {
        let fixture = try fixture()
        let migrator = ProjectHistoryMigrator(privateRoot: fixture.privateRoot)
        let first = try migrator.migrate(root: fixture.source.root)
        let identity = try Data(contentsOf: fixture.source.projectURL)
        let second = try migrator.migrate(root: fixture.source.root)
        XCTAssertTrue(second.alreadyMigrated); XCTAssertEqual(second.backupURL, first.backupURL)
        XCTAssertEqual(try Data(contentsOf: fixture.source.projectURL), identity)
        try Data("外部破坏备份".utf8).write(to: first.backupURL.appendingPathComponent("tasks/task-001.json"))
        XCTAssertThrowsError(try migrator.migrate(root: fixture.source.root))
        XCTAssertEqual(try Data(contentsOf: fixture.source.projectURL), identity)
    }

    func testExistingNamespaceCannotBeOverwritten() throws {
        let fixture = try fixture()
        let original = try Data(contentsOf: fixture.source.projectURL)
        try FileManager.default.createDirectory(at: fixture.namespace, withIntermediateDirectories: true)
        let sentinel = fixture.namespace.appendingPathComponent("foreign.json")
        let bytes = Data("不覆盖".utf8); try bytes.write(to: sentinel)
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: fixture.source.root))
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
        XCTAssertEqual(try Data(contentsOf: fixture.source.projectURL), original)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.source.taskURL.path))
    }

    func testSourceChangeBeforeCommitNeverRemovesSource() throws {
        let fixture = try fixture()
        let original = try Data(contentsOf: fixture.source.projectURL)
        let hooks = ProjectHistoryMigrator.Hooks(beforeSourceCommit: {
            try fixture.source.mutate(fixture.source.taskURL) { $0["goal"] = "用户新修改" }
        })
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot, hooks: hooks).migrate(root: fixture.source.root))
        XCTAssertEqual(try Data(contentsOf: fixture.source.projectURL), original)
        XCTAssertEqual(try ProjectRecordReader(privateRoot: fixture.privateRoot).read(root: fixture.source.root).tasks.first?.goal, "用户新修改")
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.namespace.path))
    }

    func testFailureAfterIdentityCommitRestoresExactIdentityDirectoriesAndRetainsBackup() throws {
        let fixture = try fixture()
        let original = try Data(contentsOf: fixture.source.projectURL)
        let task = try Data(contentsOf: fixture.source.taskURL)
        let hooks = ProjectHistoryMigrator.Hooks(afterIdentityCommit: { throw WorkspaceError.invalidData })
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot, hooks: hooks).migrate(root: fixture.source.root))
        XCTAssertEqual(try Data(contentsOf: fixture.source.projectURL), original)
        XCTAssertEqual(try Data(contentsOf: fixture.source.taskURL), task)
        XCTAssertEqual(try ProjectRecordReader(privateRoot: fixture.privateRoot).read(root: fixture.source.root).tasks.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.namespace.path))
        let backups = try FileManager.default.contentsOfDirectory(at: fixture.privateRoot.appendingPathComponent("backups/\(fixture.source.projectID)"), includingPropertiesForKeys: nil)
        XCTAssertEqual(backups.count, 1)
        XCTAssertEqual(try Data(contentsOf: backups[0].appendingPathComponent("project.json")), original)
        XCTAssertEqual(try Data(contentsOf: backups[0].appendingPathComponent("artifacts/task-001/preview.png")), fixture.proof)
    }

    func testExternalIdentityChangeNeverGetsOverwrittenByRollback() throws {
        let fixture = try fixture()
        let hooks = ProjectHistoryMigrator.Hooks(afterIdentityCommit: {
            try fixture.source.mutate(fixture.source.projectURL) { $0["name"] = "外部更改的名字" }
            throw WorkspaceError.invalidData
        })
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot, hooks: hooks).migrate(root: fixture.source.root)) { error in
            guard case ProjectHistoryMigrationFailure.recoveryRequired = error else { return XCTFail("应提供恢复诊断") }
        }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture.source.projectURL)) as? [String: Any])
        XCTAssertEqual(object["name"] as? String, "外部更改的名字")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.namespace.appendingPathComponent("history.json").path))
    }

    func testArtifactSymlinkAndPrivateRootSymlinkNeverReadOrWriteOutsideScope() throws {
        let fixture = try fixture()
        let external = fixture.base.appendingPathComponent("external.txt")
        let secret = Data("不读取、不改动".utf8); try secret.write(to: external)
        let linked = fixture.source.root.appendingPathComponent(".screendeck/artifacts/task-001/link.txt")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: external)
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: fixture.source.root))
        XCTAssertEqual(try Data(contentsOf: external), secret)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.namespace.path))
        let other = try self.fixture()
        let externalDirectory = other.base.appendingPathComponent("external-dir", isDirectory: true)
        try FileManager.default.createDirectory(at: externalDirectory, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: other.privateRoot, withDestinationURL: externalDirectory)
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: other.privateRoot).migrate(root: other.source.root))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: externalDirectory.path).isEmpty)
    }

    func testLimitsAndInvalidRelationshipsPreserveLegacy() throws {
        let fixture = try fixture()
        var migrator = ProjectHistoryMigrator(privateRoot: fixture.privateRoot); migrator.maximumFiles = 1
        XCTAssertThrowsError(try migrator.migrate(root: fixture.source.root))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.source.taskURL.path))
        try fixture.source.mutate(fixture.source.taskURL) { $0["run_ids"] = [] }
        XCTAssertThrowsError(try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: fixture.source.root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.namespace.path))
    }

    func testSchemaReferenceIsMappedOnlyWhenSharedSchemaExists() throws {
        let fixture = try fixture()
        let oldSchema = fixture.source.root.appendingPathComponent(".screendeck/schema/record.schema.json")
        let sharedSchema = fixture.source.root.appendingPathComponent("Resources/Schemas/record.schema.json")
        try FileManager.default.createDirectory(at: oldSchema.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sharedSchema.deletingLastPathComponent(), withIntermediateDirectories: true)
        let schema = Data("{\"title\":\"schema\"}".utf8); try schema.write(to: oldSchema); try schema.write(to: sharedSchema)
        try fixture.source.mutate(fixture.source.taskURL) { object in
            object["references"] = [["path": ".screendeck/schema/record.schema.json", "label": "契约"]]
        }
        _ = try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: fixture.source.root)
        let snapshot = try ProjectRecordReader(privateRoot: fixture.privateRoot).read(root: fixture.source.root)
        XCTAssertEqual(snapshot.tasks.first?.references.first?.path, "Resources/Schemas/record.schema.json")
        XCTAssertEqual(try Data(contentsOf: oldSchema), schema)
    }

    func testCleanupLeavesExternallyAddedContentAndReportsPendingOnRepeat() throws {
        let fixture = try fixture()
        let hooks = ProjectHistoryMigrator.Hooks(afterIdentityCommit: {
            let deck = fixture.source.root.appendingPathComponent(".screendeck", isDirectory: true)
            let retired = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: deck, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent.hasPrefix(".history-migration-") })
            try FileManager.default.createDirectory(at: retired.appendingPathComponent("external-empty"), withIntermediateDirectories: false)
        })
        let result = try ProjectHistoryMigrator(privateRoot: fixture.privateRoot, hooks: hooks).migrate(root: fixture.source.root)
        let pending = try XCTUnwrap(result.cleanupPendingURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: pending.appendingPathComponent("external-empty").path))
        XCTAssertEqual(try ProjectIdentityStore().read(root: fixture.source.root).schemaVersion, 2)
        XCTAssertEqual(try ProjectRecordReader(privateRoot: fixture.privateRoot).read(root: fixture.source.root).tasks.count, 1)
        let repeated = try ProjectHistoryMigrator(privateRoot: fixture.privateRoot).migrate(root: fixture.source.root)
        XCTAssertTrue(repeated.alreadyMigrated); XCTAssertEqual(repeated.cleanupPendingURL, pending)
    }
}
