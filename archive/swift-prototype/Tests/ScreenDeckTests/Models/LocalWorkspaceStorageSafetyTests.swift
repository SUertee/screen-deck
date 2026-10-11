import XCTest
import Darwin
@testable import ScreenDeck

final class LocalWorkspaceStorageSafetyTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("workspace-safety-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testMissingWorkspaceLoadIsReadOnly() throws {
        let root = try directory(), url = root.appendingPathComponent("not-created/workspace.json")
        XCTAssertEqual(try LocalWorkspaceStore(url: url).load(), LocalWorkspace())
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path))
    }

    func testCorruptionUnknownVersionAndUnknownFieldsCannotBeOverwritten() throws {
        let root = try directory(), url = root.appendingPathComponent("workspace.json")
        let store = LocalWorkspaceStore(url: url)
        var unknownVersion = LocalWorkspace()
        unknownVersion.schemaVersion = 9
        var unknownField = try JSONSerialization.jsonObject(with: JSONEncoder().encode(LocalWorkspace())) as! [String: Any]
        unknownField["futurePrivateData"] = ["not": "discardable"]
        for original in [Data("broken".utf8), try JSONEncoder().encode(unknownVersion),
                         try JSONSerialization.data(withJSONObject: unknownField)] {
            try original.write(to: url)
            XCTAssertThrowsError(try store.load())
            XCTAssertThrowsError(try store.save(.init()))
            XCTAssertEqual(try Data(contentsOf: url), original)
        }
    }

    func testUnknownNestedTaskAndPlanFieldsCannotBeDiscarded() throws {
        let root = try directory(), url = root.appendingPathComponent("workspace.json")
        let store = LocalWorkspaceStore(url: url)
        let workspace = LocalWorkspace(tasks: [LocalTask(title: "keep")])
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(workspace)) as! [String: Any]
        var tasks = object["tasks"] as! [[String: Any]]
        tasks[0]["privateFuturePayload"] = "preserve"
        object["tasks"] = tasks
        let original = try JSONSerialization.data(withJSONObject: object)
        try original.write(to: url)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init()))
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testLeafSymlinkAddedAfterConstructionCannotResetOrSaveWorkspace() throws {
        let root = try directory(), url = root.appendingPathComponent("workspace.json")
        let store = LocalWorkspaceStore(url: url), target = root.appendingPathComponent("other.json")
        let original = try JSONEncoder().encode(LocalWorkspace(tasks: [LocalTask(title: "other")]))
        try original.write(to: target)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init()))
        XCTAssertEqual(try Data(contentsOf: target), original)
    }

    func testDanglingLeafSymlinkIsNotTreatedAsMissing() throws {
        let root = try directory(), url = root.appendingPathComponent("workspace.json")
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: root.appendingPathComponent("missing.json"))
        let store = LocalWorkspaceStore(url: url)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("missing.json").path))
    }

    func testAncestorLinkAddedAfterConstructionCannotReadOrCreateFilesOutsideScope() throws {
        let root = try directory(), location = root.appendingPathComponent("private")
        let outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let store = LocalWorkspaceStore(url: location.appendingPathComponent("tasks/workspace.json"))
        try FileManager.default.createSymbolicLink(at: location, withDestinationURL: outside)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init()))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: outside.path).isEmpty)
    }

    func testRegularDirectoryCannotBeReadAsWorkspace() throws {
        let root = try directory()
        XCTAssertThrowsError(try LocalWorkspaceStore(url: root).load())
        XCTAssertThrowsError(try LocalWorkspaceStore(url: root).save(.init()))
    }

    func testBoundedReaderRejectsOversizedDataBeforeDecoding() throws {
        let root = try directory(), url = root.appendingPathComponent("oversized.json")
        try Data(repeating: 0x20, count: 2 * 1024 * 1024 + 1).write(to: url)
        XCTAssertThrowsError(try SafePrivateStorageIO.read(url, maximumBytes: 2 * 1024 * 1024))
        XCTAssertThrowsError(try SafePrivateStorageIO.write(Data("{}".utf8), to: url, expected: nil,
                                                          maximumBytes: 2 * 1024 * 1024))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue, 2 * 1024 * 1024 + 1)
    }

    func testWorkspaceLargerThanThirtyTwoMiBCannotBeOverwritten() throws {
        let root = try directory(), url = root.appendingPathComponent("large.json")
        // Sparse ordinary file keeps the test fast while exercising the stat size guard.
        XCTAssertTrue(FileManager.default.createFile(atPath: url.path, contents: nil))
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(SafePrivateStorageIO.defaultMaximumBytes + 1))
        try handle.close()
        let store = LocalWorkspaceStore(url: url)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init()))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue,
                       SafePrivateStorageIO.defaultMaximumBytes + 1)
    }

    func testCASRejectsExternalChangeAndNilCannotOverwriteExisting() throws {
        let root = try directory(), url = root.appendingPathComponent("payload.json")
        let old = Data("original".utf8), external = Data("external".utf8)
        try SafePrivateStorageIO.write(old, to: url, expected: nil)
        try external.write(to: url)
        XCTAssertThrowsError(try SafePrivateStorageIO.write(Data("replace".utf8), to: url, expected: old))
        XCTAssertThrowsError(try SafePrivateStorageIO.write(Data("replace".utf8), to: url, expected: nil))
        XCTAssertEqual(try Data(contentsOf: url), external)
    }

    func testValidWorkspaceAtomicSaveUsesPrivatePermissionsAndRoundTrips() throws {
        let root = try directory(), url = root.appendingPathComponent("private/tasks/workspace.json")
        let store = LocalWorkspaceStore(url: url)
        var first = LocalWorkspace(tasks: [LocalTask(title: "private")])
        try store.save(first)
        XCTAssertEqual(try store.load(), first)
        first.tasks[0].title = "updated"
        try store.save(first)
        XCTAssertEqual(try store.load(), first)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path).contains(where: { $0.hasSuffix(".tmp") }))
    }

    func testSymlinkLockCannotTouchUnrelatedTarget() throws {
        let root = try directory(), url = root.appendingPathComponent("workspace.json")
        let target = root.appendingPathComponent("unrelated"), original = Data("do not touch".utf8)
        try original.write(to: target)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent(".workspace.json.lock"), withDestinationURL: target)
        XCTAssertThrowsError(try LocalWorkspaceStore(url: url).save(.init()))
        XCTAssertEqual(try Data(contentsOf: target), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
