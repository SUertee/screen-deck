import XCTest
@testable import ScreenDeck

final class ProjectHistoryReaderTests: XCTestCase {
    private struct Fixture {
        let parent: URL
        let source: ProjectRecordFixture
        let privateRoot: URL
        let namespace: URL
        let identity: ProjectIdentity
        let reference: ProjectFileReference
        var manifestURL: URL { namespace.appendingPathComponent("history.json") }
        var taskURL: URL { namespace.appendingPathComponent("tasks/task-001.json") }
        var runURL: URL { namespace.appendingPathComponent("runs/run-20261006-001.json") }
        var attachmentURL: URL { namespace.appendingPathComponent("artifacts/task-001/preview.txt") }
        var reader: ProjectRecordReader { ProjectRecordReader(privateRoot: privateRoot) }
    }

    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-private-history-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fixture(migrated: Bool = true) throws -> Fixture {
        let parent = try directory()
        let source = try ProjectRecordFixture(root: parent.appendingPathComponent("source"))
        let privateRoot = parent.appendingPathComponent("private")
        let snapshot = try ProjectRecordReader(privateRoot: privateRoot).read(root: source.root)
        let namespace = try ProjectHistoryLocation(privateRoot: privateRoot).namespace(projectID: source.projectID)
        for path in ["tasks", "runs", "artifacts/task-001"] {
            try FileManager.default.createDirectory(at: namespace.appendingPathComponent(path), withIntermediateDirectories: true)
        }
        let reference = ProjectFileReference(path: try ProjectHistoryLocation.privateReference(projectID: source.projectID,
                                                                                                relativePath: "artifacts/task-001/preview.txt"),
                                             label: "原执行产物")
        try Data("# 私人执行原件\n".utf8).write(to: namespace.appendingPathComponent("artifacts/task-001/preview.txt"))
        let taskURL = namespace.appendingPathComponent("tasks/task-001.json")
        let runURL = namespace.appendingPathComponent("runs/run-20261006-001.json")
        try FileManager.default.copyItem(at: source.taskURL, to: taskURL)
        try FileManager.default.copyItem(at: source.runURL, to: runURL)
        for url in [taskURL, runURL] {
            try source.mutate(url) { $0["references"] = [["path": reference.path, "label": reference.label],
                                                        ["path": "docs/guide.md", "label": "正式资料"]] }
        }
        let identity = ProjectIdentity(schemaVersion: 2, kind: "project", projectID: source.projectID,
                                       name: snapshot.project.name, createdAt: snapshot.project.createdAt)
        let manifest = ProjectHistoryManifest(project: snapshot.project,
                                              sourceRoot: try ProjectHistoryLocation.normalizedRootPath(source.root),
                                              createdAt: "2026-10-07T12:00:00+08:00",
                                              backupPath: parent.appendingPathComponent("backup").path,
                                              migratedAt: "2026-10-07T12:00:00+08:00")
        try JSONEncoder().encode(manifest).write(to: namespace.appendingPathComponent("history.json"))
        if migrated {
            try JSONEncoder().encode(identity).write(to: source.projectURL)
            try FileManager.default.removeItem(at: source.root.appendingPathComponent(".screendeck/tasks"))
            try FileManager.default.removeItem(at: source.root.appendingPathComponent(".screendeck/runs"))
        }
        return Fixture(parent: parent, source: source, privateRoot: privateRoot, namespace: namespace,
                       identity: identity, reference: reference)
    }

    func testMigratedIdentityReadsPrivateTasksAndPreservesOriginalProjectReferences() throws {
        let value = try fixture()
        let identityBefore = try Data(contentsOf: value.source.projectURL)
        let manifestBefore = try Data(contentsOf: value.manifestURL)
        let snapshot = try value.reader.read(root: value.source.root)
        XCTAssertEqual(snapshot.project.projectID, value.source.projectID)
        XCTAssertEqual(snapshot.project.timezone, "Asia/Shanghai")
        XCTAssertEqual(snapshot.project.mode, "manual_pilot")
        XCTAssertEqual(snapshot.project.references, [.init(path: "docs/guide.md", label: "使用说明")])
        XCTAssertEqual(snapshot.tasks.map(\.taskID), ["task-001"])
        XCTAssertEqual(snapshot.runs.map(\.runID), ["run-20261006-001"])
        XCTAssertEqual(snapshot.tasks[0].references.first, value.reference)
        XCTAssertEqual(snapshot.tasks[0].status, "awaiting_review")
        XCTAssertEqual(try Data(contentsOf: value.source.projectURL), identityBefore)
        XCTAssertEqual(try Data(contentsOf: value.manifestURL), manifestBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: value.source.taskURL.path))
    }

    func testPrivatePreviewReturnsActualResolvedSourceAndFormalDocsStayProjectRelative() throws {
        let value = try fixture()
        let preview = try ProjectAttachmentReader(privateRoot: value.privateRoot)
            .read(reference: value.reference, root: value.source.root)
        XCTAssertEqual(preview.content, .text("# 私人执行原件\n"))
        XCTAssertEqual(preview.fileName, "preview.txt")
        XCTAssertEqual(preview.sourceURL, value.attachmentURL.standardizedFileURL)
        XCTAssertEqual(try value.reader.validatedReference(value.reference, root: value.source.root), value.attachmentURL.standardizedFileURL)
        let docs = ProjectFileReference(path: "docs/guide.md", label: "正式资料")
        XCTAssertEqual(try value.reader.validatedReference(docs, root: value.source.root),
                       value.source.root.standardizedFileURL.appendingPathComponent("docs/guide.md"))
    }

    func testSameIDAtAnotherCheckoutCannotReadPrivateHistoryOrAttachments() throws {
        let value = try fixture()
        let copy = value.parent.appendingPathComponent("same-ID-another-checkout")
        try FileManager.default.copyItem(at: value.source.root, to: copy)
        XCTAssertThrowsError(try value.reader.read(root: copy))
        XCTAssertThrowsError(try value.reader.validatedReference(value.reference, root: copy))
        XCTAssertThrowsError(try value.reader.readReferenceData(value.reference, root: copy, maximumBytes: 1024))
    }

    func testStrictManifestRejectsUnknownKeysVersionsOtherProjectsAndNoncanonicalBindings() throws {
        let value = try fixture()
        let original = try Data(contentsOf: value.manifestURL)
        let changes: [(inout [String: Any]) -> Void] = [
            { $0["unknown"] = "not ignored" },
            { $0["schema_version"] = true },
            { $0["schema_version"] = 2 },
            { $0["project_id"] = "project-22222222-2222-2222-2222-222222222222" },
            { $0["source_root"] = value.parent.appendingPathComponent("other").path },
            { $0["source_root"] = value.source.root.path + "/../source" },
            { $0["created_at"] = "2026-02-30T10:00:00Z" },
            { var project = $0["project"] as! [String: Any]; project["schema_version"] = 2; $0["project"] = project },
            { var migration = $0["migration"] as! [String: Any]; migration["command"] = "not authority"; $0["migration"] = migration }
        ]
        for change in changes {
            var object = try JSONSerialization.jsonObject(with: original) as! [String: Any]
            change(&object)
            try JSONSerialization.data(withJSONObject: object).write(to: value.manifestURL)
            XCTAssertThrowsError(try value.reader.read(root: value.source.root))
            XCTAssertThrowsError(try value.reader.validatedReference(value.reference, root: value.source.root))
        }
        try original.write(to: value.manifestURL)
        XCTAssertNoThrow(try value.reader.read(root: value.source.root))
    }

    func testUnboundPrivateContentsAreNotPresentedAsAnEmptyNewProject() throws {
        let value = try fixture()
        try FileManager.default.removeItem(at: value.manifestURL)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
        XCTAssertThrowsError(try value.reader.validatedReference(value.reference, root: value.source.root))
        let parent = try directory(), root = parent.appendingPathComponent("fresh-project")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        _ = try ProjectIdentityStore().initialize(root: root, name: "尚无历史")
        let privateRoot = parent.appendingPathComponent("never-created")
        let snapshot = try ProjectRecordReader(privateRoot: privateRoot).read(root: root)
        XCTAssertTrue(snapshot.tasks.isEmpty && snapshot.runs.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: privateRoot.path))
    }

    func testPrivateReferenceGrammarRejectsCrossProjectEncodingTraversalAndOtherNamespaces() throws {
        let value = try fixture(), prefix = "screendeck://\(value.source.projectID)/"
        for path in [prefix + "artifacts/../preview.txt", prefix + "artifacts/%2e%2e/preview.txt",
                     prefix + "artifacts/%70review.txt", prefix + "artifacts//preview.txt",
                     prefix + "artifacts/./preview.txt", prefix + "artifacts/preview.txt?query=1",
                     prefix + "artifacts/preview.txt#anchor", prefix + "docs/guide.md",
                     "screendeck://project-22222222-2222-2222-2222-222222222222/artifacts/preview.txt"] {
            let reference = ProjectFileReference(path: path, label: "拒绝")
            XCTAssertThrowsError(try value.reader.validatedReference(reference, root: value.source.root))
            XCTAssertThrowsError(try value.reader.readReferenceData(reference, root: value.source.root, maximumBytes: 1024))
        }
    }

    func testMissingLinkedAndDuplicatePrivateRecordsFailWithoutPartialSnapshots() throws {
        let value = try fixture()
        let run = try Data(contentsOf: value.runURL)
        try FileManager.default.removeItem(at: value.runURL)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
        try run.write(to: value.runURL)
        let duplicate = value.namespace.appendingPathComponent("tasks/task-002.json")
        try FileManager.default.copyItem(at: value.taskURL, to: duplicate)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
        try FileManager.default.removeItem(at: duplicate)
        let original = try Data(contentsOf: value.taskURL)
        let outside = value.parent.appendingPathComponent("outside-task.json")
        try original.write(to: outside)
        try FileManager.default.removeItem(at: value.taskURL)
        try FileManager.default.createSymbolicLink(at: value.taskURL, withDestinationURL: outside)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
    }

    func testPrivateManifestArtifactAndAncestorSymlinksNeverFollowTargets() throws {
        let value = try fixture()
        let artifact = try Data(contentsOf: value.attachmentURL)
        let target = value.parent.appendingPathComponent("outside.txt")
        try artifact.write(to: target)
        try FileManager.default.removeItem(at: value.attachmentURL)
        try FileManager.default.createSymbolicLink(at: value.attachmentURL, withDestinationURL: target)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
        XCTAssertThrowsError(try value.reader.readReferenceData(value.reference, root: value.source.root, maximumBytes: 1024))
        let manifest = try Data(contentsOf: value.manifestURL)
        let other = value.parent.appendingPathComponent("outside-history.json")
        try manifest.write(to: other)
        try FileManager.default.removeItem(at: value.manifestURL)
        try FileManager.default.createSymbolicLink(at: value.manifestURL, withDestinationURL: other)
        XCTAssertThrowsError(try value.reader.read(root: value.source.root))
        let alias = value.parent.appendingPathComponent("private-alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: value.privateRoot)
        XCTAssertThrowsError(try ProjectRecordReader(privateRoot: alias).read(root: value.source.root))
        XCTAssertEqual(try Data(contentsOf: target), artifact)
        XCTAssertEqual(try Data(contentsOf: other), manifest)
    }

    func testStagingValidationDoesNotModifySourceV1IdentityAndUsesOriginalRootBinding() throws {
        let value = try fixture(migrated: false)
        let before = try Data(contentsOf: value.source.projectURL)
        let snapshot = try value.reader.readPrivateNamespace(root: value.source.root, project: value.identity,
                                                             namespaceRoot: value.namespace)
        XCTAssertEqual(snapshot.tasks[0].references.first, value.reference)
        XCTAssertEqual(try Data(contentsOf: value.source.projectURL), before)
        XCTAssertEqual(try value.reader.read(root: value.source.root).tasks[0].references.first?.path, "docs/guide.md")
        let wrong = ProjectIdentity(schemaVersion: 2, kind: "project", projectID: value.identity.projectID,
                                    name: "冒充原项目", createdAt: value.identity.createdAt)
        XCTAssertThrowsError(try value.reader.readPrivateNamespace(root: value.source.root, project: wrong,
                                                                  namespaceRoot: value.namespace))
    }

    func testPrivateHistoryStillHonorsRecordCountAndAggregateReadLimits() throws {
        let value = try fixture()
        let noRuns = ProjectRecordReader(privateRoot: value.privateRoot,
                                        limits: .init(jsonBytes: 2 * 1024 * 1024, tasks: 1000, runs: 0, totalBytes: 32 * 1024 * 1024))
        XCTAssertThrowsError(try noRuns.read(root: value.source.root))
        let bounded = ProjectRecordReader(privateRoot: value.privateRoot,
                                         limits: .init(jsonBytes: 2 * 1024 * 1024, tasks: 1000, runs: 1000, totalBytes: 1000))
        XCTAssertThrowsError(try bounded.read(root: value.source.root))
        XCTAssertThrowsError(try value.reader.readReferenceData(value.reference, root: value.source.root, maximumBytes: 2))
    }
}
