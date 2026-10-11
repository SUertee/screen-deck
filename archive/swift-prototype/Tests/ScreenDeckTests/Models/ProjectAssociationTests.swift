import XCTest
@testable import ScreenDeck

final class ProjectAssociationTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("project-association-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func store(at root: URL) -> ProjectAssociationStore {
        ProjectAssociationStore(url: root.appendingPathComponent("global/project-associations.json"))
    }

    func testStoreRoundTripsOnlyLocationsAndBrowsingSelection() throws {
        let root = try directory()
        let store = store(at: root)
        XCTAssertEqual(try store.load(), ProjectAssociationState())
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        let item = ProjectAssociation(projectID: "project-11111111-1111-1111-1111-111111111111", name: "真实项目", rootPath: root.path)
        let state = ProjectAssociationState(associations: [item], selection: .init(projectID: item.projectID, taskID: "task-001"))
        try store.save(state)
        XCTAssertEqual(try store.load(), state)
        let text = String(decoding: try Data(contentsOf: store.url), as: UTF8.self)
        XCTAssertFalse(text.contains("run_ids"))
        XCTAssertFalse(text.contains("goal"))
        XCTAssertFalse(text.contains("executor"))
    }

    func testUnknownVersionsCorruptionUnknownKeysAndBooleanVersionNeverOverwrite() throws {
        let root = try directory()
        let store = store(at: root)
        try FileManager.default.createDirectory(at: store.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        for text in ["broken", "{\"version\":2,\"associations\":[]}", "{\"version\":true,\"associations\":[]}",
                     "{\"version\":1,\"associations\":[],\"commands\":[\"do something\"]}"] {
            let original = Data(text.utf8)
            try original.write(to: store.url)
            XCTAssertThrowsError(try store.load())
            XCTAssertThrowsError(try store.save(ProjectAssociationState()))
            XCTAssertEqual(try Data(contentsOf: store.url), original)
        }
    }

    func testStoreRejectsDuplicateIdentityPathAndInvalidSelection() throws {
        let root = try directory()
        let store = store(at: root)
        let first = ProjectAssociation(projectID: "project-11111111-1111-1111-1111-111111111111", name: "一", rootPath: root.path)
        let samePath = ProjectAssociation(projectID: "project-22222222-2222-2222-2222-222222222222", name: "二", rootPath: root.path)
        let sameID = ProjectAssociation(projectID: first.projectID, name: "一副本", rootPath: root.appendingPathComponent("copy").path)
        XCTAssertThrowsError(try store.save(.init(associations: [first, samePath])))
        XCTAssertThrowsError(try store.save(.init(associations: [first, sameID])))
        XCTAssertThrowsError(try store.save(.init(associations: [first], selection: .init(projectID: samePath.projectID, taskID: nil))))
        XCTAssertThrowsError(try store.save(.init(associations: [first], selection: .init(projectID: first.projectID, taskID: "../../secret"))))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
    }

    func testStoreRejectsSymlinkAndOversizedFileWithoutChangingTargets() throws {
        let root = try directory()
        let target = root.appendingPathComponent("original.json")
        let original = Data("{\"version\":1,\"associations\":[]}".utf8)
        try original.write(to: target)
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let linkedStore = ProjectAssociationStore(url: link)
        XCTAssertThrowsError(try linkedStore.load())
        XCTAssertThrowsError(try linkedStore.save(.init()))
        XCTAssertEqual(try Data(contentsOf: target), original)
        let oversized = root.appendingPathComponent("oversized.json")
        try Data(repeating: 0x20, count: 2 * 1024 * 1024 + 1).write(to: oversized)
        let oversizedStore = ProjectAssociationStore(url: oversized)
        XCTAssertThrowsError(try oversizedStore.load())
        XCTAssertThrowsError(try oversizedStore.save(.init()))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: oversized.path)[.size] as? NSNumber)?.intValue, 2 * 1024 * 1024 + 1)
    }

    @MainActor
    func testControllerInitializationHasNoFileReadsOrWrites() throws {
        let root = try directory()
        let store = SwitchableProjectAssociationStore(url: root.appendingPathComponent("associations.json"))
        let controller = ProjectWorkspaceController(store: store)
        XCTAssertFalse(controller.associationsLoaded)
        XCTAssertTrue(controller.associations.isEmpty)
        XCTAssertTrue(controller.snapshots.isEmpty)
        XCTAssertEqual(store.readAttempts, 0)
        XCTAssertEqual(store.writeAttempts, 0)
    }

    @MainActor
    func testDifferentProjectsWithSameTaskAndRunIDsRemainIsolatedAndRepeatedLoadDeduplicates() async throws {
        let root = try directory()
        let first = try ProjectRecordFixture(root: root.appendingPathComponent("first"))
        let second = try ProjectRecordFixture(root: root.appendingPathComponent("second"), projectID: "project-22222222-2222-2222-2222-222222222222", name: "第二项目")
        let sourceBefore = try Data(contentsOf: first.taskURL)
        let controller = ProjectWorkspaceController(store: store(at: root))
        let loaded = await controller.load()
        let associatedFirst = await controller.associate(root: first.root)
        let associatedSecond = await controller.associate(root: second.root)
        XCTAssertTrue(loaded && associatedFirst && associatedSecond)
        XCTAssertEqual(controller.associations.count, 2)
        XCTAssertEqual(controller.snapshots[first.projectID]?.tasks.first?.taskID, "task-001")
        XCTAssertEqual(controller.snapshots[second.projectID]?.tasks.first?.taskID, "task-001")
        XCTAssertEqual(controller.snapshots[first.projectID]?.runs.first?.runID, "run-20261006-001")
        XCTAssertTrue(controller.select(projectID: first.projectID, taskID: "task-001"))
        for _ in 0..<3 {
            let reloaded = await controller.load()
            XCTAssertTrue(reloaded)
        }
        XCTAssertEqual(controller.associations.count, 2)
        XCTAssertEqual(controller.snapshots.count, 2)
        XCTAssertEqual(controller.snapshots[first.projectID]?.tasks.count, 1)
        XCTAssertEqual(controller.selection, .init(projectID: first.projectID, taskID: "task-001"))
        XCTAssertEqual(try Data(contentsOf: first.taskURL), sourceBefore)
        let persisted = try controller.store.load()
        XCTAssertEqual(persisted.selection, controller.selection)
    }

    @MainActor
    func testDuplicateProjectAtDifferentPathRequiresExplicitRelinkAndPreservesTaskChoice() async throws {
        let root = try directory()
        let original = try ProjectRecordFixture(root: root.appendingPathComponent("original"))
        let copy = try ProjectRecordFixture(root: root.appendingPathComponent("copy"))
        let other = try ProjectRecordFixture(root: root.appendingPathComponent("other"), projectID: "project-22222222-2222-2222-2222-222222222222")
        let controller = ProjectWorkspaceController(store: store(at: root))
        _ = await controller.load()
        _ = await controller.associate(root: original.root)
        XCTAssertTrue(controller.select(projectID: original.projectID, taskID: "task-001"))
        let metadataBefore = try Data(contentsOf: controller.store.url)
        let duplicated = await controller.associate(root: copy.root)
        XCTAssertFalse(duplicated)
        XCTAssertEqual(controller.associations.count, 1)
        XCTAssertEqual(controller.associations.first?.rootPath, original.root.path)
        XCTAssertTrue(controller.error?.contains("重新关联") == true)
        XCTAssertEqual(try Data(contentsOf: controller.store.url), metadataBefore)
        let wrongIdentity = await controller.relink(projectID: original.projectID, root: other.root)
        XCTAssertFalse(wrongIdentity)
        XCTAssertEqual(controller.associations.first?.rootPath, original.root.path)
        let relinked = await controller.relink(projectID: original.projectID, root: copy.root)
        XCTAssertTrue(relinked)
        XCTAssertEqual(controller.associations.first?.rootPath, copy.root.path)
        XCTAssertEqual(controller.selection?.taskID, "task-001")
        XCTAssertEqual(try controller.store.load().associations.first?.rootPath, copy.root.path)
    }

    @MainActor
    func testFailedRefreshKeepsWholeOldSnapshotStaleUntilSourceRecovers() async throws {
        let root = try directory()
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"))
        let controller = ProjectWorkspaceController(store: store(at: root))
        _ = await controller.load()
        _ = await controller.associate(root: source.root)
        let prior = try XCTUnwrap(controller.snapshots[source.projectID])
        let originalRun = try Data(contentsOf: source.runURL)
        try Data("broken JSON".utf8).write(to: source.runURL)
        try source.mutate(source.taskURL) { $0["title"] = "不应半导入的新标题" }
        let refreshed = await controller.refresh(projectID: source.projectID)
        XCTAssertFalse(refreshed)
        XCTAssertEqual(controller.snapshots[source.projectID], prior)
        XCTAssertTrue(controller.staleProjectIDs.contains(source.projectID))
        XCTAssertNotNil(controller.diagnostics[source.projectID])
        XCTAssertThrowsError(try controller.referenceURL(.init(path: "docs/guide.md", label: "说明"), projectID: source.projectID))
        XCTAssertFalse(controller.select(projectID: source.projectID, taskID: "task-001"))
        try originalRun.write(to: source.runURL)
        let recovered = await controller.refresh(projectID: source.projectID)
        XCTAssertTrue(recovered)
        XCTAssertEqual(controller.snapshots[source.projectID]?.tasks.first?.title, "不应半导入的新标题")
        XCTAssertEqual(controller.snapshots[source.projectID]?.tasks.count, 1)
        XCTAssertFalse(controller.staleProjectIDs.contains(source.projectID))
        XCTAssertNil(controller.diagnostics[source.projectID])
        XCTAssertNoThrow(try controller.referenceURL(.init(path: "docs/guide.md", label: "说明"), projectID: source.projectID))
        XCTAssertThrowsError(try controller.referenceURL(.init(path: "docs/guide.md", label: "非来源声明的链接"), projectID: source.projectID))
        XCTAssertThrowsError(try controller.referenceURL(.init(path: ".screendeck/project.json", label: "未声明文件"), projectID: source.projectID))
    }

    @MainActor
    func testRestartRereadsSourceRestoresSelectionAndMissingSourceHasNoOfflineSnapshot() async throws {
        let root = try directory()
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"))
        let store = store(at: root)
        let original = ProjectWorkspaceController(store: store)
        _ = await original.load()
        _ = await original.associate(root: source.root)
        XCTAssertTrue(original.select(projectID: source.projectID, taskID: "task-001"))
        let restarted = ProjectWorkspaceController(store: store)
        let loaded = await restarted.load()
        XCTAssertTrue(loaded)
        XCTAssertEqual(restarted.selection?.taskID, "task-001")
        XCTAssertEqual(restarted.snapshots[source.projectID]?.runs.first?.executor.model, nil)
        let movedRoot = root.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: source.root, to: movedRoot)
        let missing = ProjectWorkspaceController(store: store)
        let metadataLoaded = await missing.load()
        XCTAssertTrue(metadataLoaded)
        XCTAssertEqual(missing.associations.count, 1)
        XCTAssertTrue(missing.snapshots.isEmpty)
        XCTAssertNotNil(missing.diagnostics[source.projectID])
        XCTAssertEqual(missing.selection, .init(projectID: source.projectID, taskID: nil))
        let recovered = await missing.relink(projectID: source.projectID, root: movedRoot)
        XCTAssertTrue(recovered)
        XCTAssertEqual(missing.snapshots[source.projectID]?.tasks.count, 1)
        XCTAssertNil(missing.diagnostics[source.projectID])
    }

    @MainActor
    func testFailedAssociationSelectionAndRelinkSavesNeverPublishUnpersistedChanges() async throws {
        let root = try directory()
        let first = try ProjectRecordFixture(root: root.appendingPathComponent("first"))
        let copy = try ProjectRecordFixture(root: root.appendingPathComponent("copy"))
        let second = try ProjectRecordFixture(root: root.appendingPathComponent("second"), projectID: "project-22222222-2222-2222-2222-222222222222")
        let store = SwitchableProjectAssociationStore(url: root.appendingPathComponent("associations.json"))
        let controller = ProjectWorkspaceController(store: store)
        _ = await controller.load()
        _ = await controller.associate(root: first.root)
        let savedSelection = controller.selection
        let bytes = try Data(contentsOf: store.url)
        store.failWrites = true
        let added = await controller.associate(root: second.root)
        XCTAssertFalse(added)
        XCTAssertEqual(controller.associations.count, 1)
        XCTAssertNil(controller.snapshots[second.projectID])
        XCTAssertEqual(controller.selection, savedSelection)
        XCTAssertFalse(controller.select(projectID: first.projectID, taskID: "task-001"))
        XCTAssertEqual(controller.selection, savedSelection)
        let relinked = await controller.relink(projectID: first.projectID, root: copy.root)
        XCTAssertFalse(relinked)
        XCTAssertEqual(controller.associations.first?.rootPath, first.root.path)
        XCTAssertEqual(controller.snapshots[first.projectID]?.rootURL.path, first.root.path)
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
        store.failWrites = false
        XCTAssertTrue(controller.select(projectID: first.projectID, taskID: "task-001"))
    }

    @MainActor
    func testCorruptAssociationReloadBlocksWritesAndMarksExistingSnapshotStale() async throws {
        let root = try directory()
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"))
        let controller = ProjectWorkspaceController(store: store(at: root))
        _ = await controller.load()
        _ = await controller.associate(root: source.root)
        let invalid = Data("{\"version\":999,\"associations\":[]}".utf8)
        try invalid.write(to: controller.store.url)
        let sameAssociation = await controller.associate(root: source.root)
        XCTAssertFalse(sameAssociation)
        XCTAssertEqual(try Data(contentsOf: controller.store.url), invalid)
        let loaded = await controller.load()
        XCTAssertFalse(loaded)
        XCTAssertFalse(controller.associationsLoaded)
        XCTAssertTrue(controller.staleProjectIDs.contains(source.projectID))
        XCTAssertNotNil(controller.diagnostics[source.projectID])
        XCTAssertFalse(controller.select(projectID: source.projectID))
        let refreshed = await controller.refresh(projectID: source.projectID)
        XCTAssertFalse(refreshed)
        XCTAssertEqual(try Data(contentsOf: controller.store.url), invalid)
    }

    @MainActor
    func testChangedSourceIdentityDoesNotReplaceAssociatedIdentityOrHistory() async throws {
        let root = try directory()
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"))
        let controller = ProjectWorkspaceController(store: store(at: root))
        _ = await controller.load()
        _ = await controller.associate(root: source.root)
        let prior = controller.snapshots[source.projectID]
        _ = try ProjectRecordFixture(root: source.root, projectID: "project-22222222-2222-2222-2222-222222222222")
        let refreshed = await controller.refresh(projectID: source.projectID)
        XCTAssertFalse(refreshed)
        XCTAssertEqual(controller.snapshots[source.projectID], prior)
        XCTAssertNil(controller.snapshots["project-22222222-2222-2222-2222-222222222222"])
        XCTAssertEqual(controller.associations.first?.projectID, source.projectID)
        XCTAssertTrue(controller.diagnostics[source.projectID]?.contains("project_id") == true)
    }
}

private final class SwitchableProjectAssociationStore: ProjectAssociationStoring {
    private let backing: ProjectAssociationStore
    var url: URL { backing.url }
    var failWrites = false
    var failReads = false
    private(set) var readAttempts = 0
    private(set) var writeAttempts = 0

    init(url: URL) { backing = ProjectAssociationStore(url: url) }

    func load() throws -> ProjectAssociationState {
        readAttempts += 1
        if failReads { throw CocoaError(.fileReadNoPermission) }
        return try backing.load()
    }

    func save(_ state: ProjectAssociationState) throws {
        writeAttempts += 1
        if failWrites { throw CocoaError(.fileWriteNoPermission) }
        try backing.save(state)
    }
}
