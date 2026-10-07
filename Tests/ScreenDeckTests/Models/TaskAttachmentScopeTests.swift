import XCTest
@testable import ScreenDeck

final class TaskAttachmentScopeTests: XCTestCase {
    private let taskReference = ProjectFileReference(path: "docs/guide.md", label: "说明")
    private let runReference = ProjectFileReference(path: "docs/run-only.md", label: "执行证据")
    private let projectReference = ProjectFileReference(path: "docs/project-only.md", label: "项目资料")
    private let otherReference = ProjectFileReference(path: "docs/other-only.md", label: "其他任务资料")

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("task-attachment-scope-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func record(_ reference: ProjectFileReference) -> [String: String] {
        ["path": reference.path, "label": reference.label]
    }

    /// All records and attachments are temporary. The second task intentionally shares
    /// the first task's exact reference, so a project-wide membership check is insufficient.
    private func fixture(at root: URL) throws -> ProjectRecordFixture {
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"))
        for reference in [runReference, projectReference, otherReference] {
            try Data("# \(reference.label)\n".utf8)
                .write(to: source.root.appendingPathComponent(reference.path))
        }
        try source.mutate(source.projectURL) {
            $0["references"] = [record(projectReference), record(taskReference)]
        }
        try source.mutate(source.taskURL) { $0["references"] = [record(taskReference)] }
        try source.mutate(source.runURL) { $0["references"] = [record(runReference)] }
        var secondTask = try JSONSerialization.jsonObject(with: Data(contentsOf: source.taskURL)) as! [String: Any]
        secondTask["task_id"] = "task-002"
        secondTask["title"] = "另一个任务"
        secondTask["run_ids"] = [String]()
        secondTask["references"] = [record(otherReference), record(taskReference)]
        try source.write(secondTask, to: source.root.appendingPathComponent(".screendeck/tasks/task-002.json"))
        return source
    }

    private func sourceBytes(_ source: ProjectRecordFixture) throws -> [String: Data] {
        let paths = [".screendeck/project.json", ".screendeck/tasks/task-001.json",
                     ".screendeck/tasks/task-002.json", ".screendeck/runs/run-20261006-001.json",
                     taskReference.path, runReference.path, projectReference.path, otherReference.path]
        var bytes: [String: Data] = [:]
        for path in paths {
            let url = source.root.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: url.path) { bytes[path] = try Data(contentsOf: url) }
        }
        return bytes
    }

    @MainActor
    private func associatedController(_ source: ProjectRecordFixture, at root: URL) async -> ProjectWorkspaceController {
        let store = ProjectAssociationStore(url: root.appendingPathComponent("global/project-associations.json"))
        let controller = ProjectWorkspaceController(store: store)
        let loaded = await controller.load()
        let associated = await controller.associate(root: source.root)
        XCTAssertTrue(loaded)
        XCTAssertTrue(associated)
        return controller
    }

    @MainActor
    func testReferenceChecksDoNotReadOrWriteBeforeExplicitAssociation() throws {
        let root = try directory()
        let source = try fixture(at: root)
        let before = try sourceBytes(source)
        let store = ProjectAssociationStore(url: root.appendingPathComponent("global/project-associations.json"))
        let controller = ProjectWorkspaceController(store: store)

        XCTAssertFalse(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(projectReference, projectID: source.projectID, taskID: nil))
        XCTAssertTrue(controller.snapshots.isEmpty)
        XCTAssertFalse(controller.associationsLoaded)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.url.path))
        XCTAssertEqual(try sourceBytes(source), before)
    }

    @MainActor
    func testTaskOnlyAcceptsItsOwnTaskAndRunReferencesWhileProjectScopeAcceptsDeclaredReferences() async throws {
        let root = try directory()
        let source = try fixture(at: root)
        let before = try sourceBytes(source)
        let controller = await associatedController(source, at: root)

        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(projectReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(otherReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-002"))
        XCTAssertFalse(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-999"))
        XCTAssertFalse(controller.hasReference(taskReference, projectID: "project-missing", taskID: "task-001"))
        for reference in [taskReference, runReference, projectReference, otherReference] {
            XCTAssertTrue(controller.hasReference(reference, projectID: source.projectID, taskID: nil))
        }
        let changedLabel = ProjectFileReference(path: taskReference.path, label: "未登记的新标签")
        XCTAssertFalse(controller.hasReference(changedLabel, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(changedLabel, projectID: source.projectID, taskID: nil))
        XCTAssertEqual(try sourceBytes(source), before)
    }

    @MainActor
    func testSuccessfulRefreshRemovingTaskReferenceDoesNotInheritSamePathFromAnotherOwner() async throws {
        let root = try directory()
        let source = try fixture(at: root)
        let controller = await associatedController(source, at: root)
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))

        try source.mutate(source.taskURL) { $0["references"] = [[String: String]]() }
        let expectedSource = try sourceBytes(source)
        let refreshed = await controller.refresh(projectID: source.projectID)

        XCTAssertTrue(refreshed)
        XCTAssertFalse(controller.staleProjectIDs.contains(source.projectID))
        XCTAssertFalse(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-002"))
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: nil))
        // A globally valid URL cannot authorize the removed task's cached attachment.
        XCTAssertNoThrow(try controller.referenceURL(taskReference, projectID: source.projectID))
        XCTAssertEqual(try sourceBytes(source), expectedSource)
    }

    @MainActor
    func testSuccessfulRefreshRemovingRunReferenceDoesNotInheritProjectDeclaration() async throws {
        let root = try directory()
        let source = try fixture(at: root)
        try source.mutate(source.projectURL) {
            $0["references"] = [record(projectReference), record(taskReference), record(runReference)]
        }
        let controller = await associatedController(source, at: root)
        XCTAssertTrue(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))

        try source.mutate(source.runURL) { $0["references"] = [[String: String]]() }
        let expectedSource = try sourceBytes(source)
        let refreshed = await controller.refresh(projectID: source.projectID)

        XCTAssertTrue(refreshed)
        XCTAssertFalse(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(runReference, projectID: source.projectID, taskID: nil))
        XCTAssertNoThrow(try controller.referenceURL(runReference, projectID: source.projectID))
        XCTAssertEqual(try sourceBytes(source), expectedSource)
    }

    @MainActor
    func testSuccessfulRefreshDeletingTaskAndItsRunInvalidatesOldOwnerDespiteSharedPath() async throws {
        let root = try directory()
        let source = try fixture(at: root)
        let controller = await associatedController(source, at: root)
        XCTAssertTrue(controller.select(projectID: source.projectID, taskID: "task-001"))

        // The simulated serial source writer deletes the run too, keeping v1 consistent.
        try FileManager.default.removeItem(at: source.runURL)
        try FileManager.default.removeItem(at: source.taskURL)
        let expectedSource = try sourceBytes(source)
        let refreshed = await controller.refresh(projectID: source.projectID)

        XCTAssertTrue(refreshed)
        XCTAssertEqual(controller.snapshots[source.projectID]?.tasks.map(\.taskID), ["task-002"])
        XCTAssertEqual(controller.selection, ProjectSelection(projectID: source.projectID, taskID: nil))
        XCTAssertFalse(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-002"))
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: nil))
        XCTAssertEqual(try sourceBytes(source), expectedSource)
    }

    @MainActor
    func testFailedRefreshDisablesAllReferenceScopesUntilSuccessfulRecoveryWithoutSourceWrites() async throws {
        let root = try directory()
        let source = try fixture(at: root)
        let controller = await associatedController(source, at: root)
        let priorSnapshot = try XCTUnwrap(controller.snapshots[source.projectID])
        let validRun = try Data(contentsOf: source.runURL)
        try Data("broken JSON".utf8).write(to: source.runURL)
        let expectedInvalidSource = try sourceBytes(source)
        let failed = await controller.refresh(projectID: source.projectID)

        XCTAssertFalse(failed)
        XCTAssertEqual(controller.snapshots[source.projectID], priorSnapshot)
        XCTAssertTrue(controller.staleProjectIDs.contains(source.projectID))
        XCTAssertFalse(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertFalse(controller.hasReference(projectReference, projectID: source.projectID, taskID: nil))
        XCTAssertEqual(try sourceBytes(source), expectedInvalidSource)

        try validRun.write(to: source.runURL)
        let expectedRecoveredSource = try sourceBytes(source)
        let recovered = await controller.refresh(projectID: source.projectID)
        XCTAssertTrue(recovered)
        XCTAssertTrue(controller.hasReference(taskReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(runReference, projectID: source.projectID, taskID: "task-001"))
        XCTAssertTrue(controller.hasReference(projectReference, projectID: source.projectID, taskID: nil))
        XCTAssertEqual(try sourceBytes(source), expectedRecoveredSource)
    }
}
