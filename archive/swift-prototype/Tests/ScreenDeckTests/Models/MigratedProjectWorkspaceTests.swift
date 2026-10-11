import Foundation
import XCTest
@testable import ScreenDeck

@MainActor
final class MigratedProjectWorkspaceTests: XCTestCase {
    func testMigratedProjectSelectionAndPreviewRemainBoundToPrivateHistory() async throws {
        let base = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("screendeck-migrated-workspace-\(UUID())")
        defer { try? FileManager.default.removeItem(at: base) }
        let source = try ProjectRecordFixture(root: base.appendingPathComponent("project"))
        let privateRoot = base.appendingPathComponent("private")
        let oldArtifact = source.root.appendingPathComponent(".screendeck/artifacts/report.txt")
        try FileManager.default.createDirectory(at: oldArtifact.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("Verified temporary evidence".utf8).write(to: oldArtifact)
        try source.mutate(source.taskURL) {
            $0["references"] = [["path": ".screendeck/artifacts/report.txt", "label": "Evidence"]]
        }
        _ = try ProjectHistoryMigrator(privateRoot: privateRoot).migrate(root: source.root)
        let store = ProjectAssociationStore(url: base.appendingPathComponent("association.json"))
        let controller = ProjectWorkspaceController(store: store, privateRoot: privateRoot)
        let loaded = await controller.load()
        XCTAssertTrue(loaded)
        let associated = await controller.associate(root: source.root)
        XCTAssertTrue(associated)
        XCTAssertTrue(controller.select(projectID: source.projectID, taskID: "task-001"))
        let snapshot = try XCTUnwrap(controller.snapshots[source.projectID])
        XCTAssertNotNil(snapshot.historyRootURL)
        XCTAssertEqual(snapshot.recordReference(collection: "tasks", id: "task-001"),
                       "screendeck://\(source.projectID)/tasks/task-001.json")
        let reference = try XCTUnwrap(snapshot.tasks.first?.references.first)
        XCTAssertTrue(reference.path.hasPrefix("screendeck://\(source.projectID)/artifacts/"))
        XCTAssertTrue(controller.hasReference(reference, projectID: source.projectID, taskID: "task-001"))
        let resolved = try controller.referenceURL(reference, projectID: source.projectID)
        XCTAssertEqual(resolved.path, privateRoot.appendingPathComponent("projects/\(source.projectID)/artifacts/report.txt").standardizedFileURL.path)
        let preview = try ProjectAttachmentReader(privateRoot: privateRoot).read(reference: reference, root: source.root)
        XCTAssertEqual(preview.sourceURL, resolved)
        XCTAssertEqual(preview.content, .text("Verified temporary evidence"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldArtifact.path))
        XCTAssertTrue(controller.removeAssociation(projectID: source.projectID))
        XCTAssertTrue(FileManager.default.fileExists(atPath: resolved.path))
        XCTAssertEqual(try ProjectRecordReader(privateRoot: privateRoot).read(root: source.root).runs.count, 1)
    }
}
