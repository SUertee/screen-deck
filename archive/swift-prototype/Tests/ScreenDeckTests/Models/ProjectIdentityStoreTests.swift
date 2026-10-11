import XCTest
import Darwin
@testable import ScreenDeck

final class ProjectIdentityStoreTests: XCTestCase {
    private let store = ProjectIdentityStore()

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("project-identity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func identityURL(_ root: URL) -> URL { root.appendingPathComponent(".screendeck/project.json") }

    private func write(_ object: [String: Any], root: URL) throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".screendeck"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: identityURL(root))
    }

    private var validObject: [String: Any] {
        ["schema_version": 2, "kind": "project", "project_id": "project-11111111-1111-1111-1111-111111111111",
         "name": "项目", "created_at": "2026-10-07T09:00:00+08:00"]
    }

    func testExplicitInitializationWritesOnlyFiveFieldIdentityAndRoundTrips() throws {
        let root = try directory()
        let now = Date(timeIntervalSince1970: 1_791_331_200)
        let identity = try store.initialize(root: root, name: "  ScreenDeck  ", now: now)
        XCTAssertEqual(identity.schemaVersion, 2)
        XCTAssertEqual(identity.kind, "project")
        XCTAssertEqual(identity.name, "ScreenDeck")
        XCTAssertNotNil(identity.projectID.range(of: "^project-[0-9a-f-]{36}$", options: .regularExpression))
        XCTAssertEqual(try store.read(root: root), identity)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: identityURL(root))) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["schema_version", "kind", "project_id", "name", "created_at"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [".screendeck"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".screendeck").path), ["project.json"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("AGENTLOG.md").path))
    }

    func testReadAndInvalidInitializationNeverCreateMissingDirectories() throws {
        let root = try directory()
        XCTAssertThrowsError(try store.read(root: root))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        for name in ["", "   ", "bad\nname", String(repeating: "x", count: 151)] {
            XCTAssertThrowsError(try store.initialize(root: root, name: name))
        }
        XCTAssertThrowsError(try store.initialize(root: root, name: "有效", now: Date(timeIntervalSince1970: .nan)))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
        let missing = root.appendingPathComponent("does-not-exist", isDirectory: true)
        XCTAssertThrowsError(try store.initialize(root: missing, name: "有效"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    func testAnyExistingIdentityWinsIncludingV1CorruptAndUnknownVersion() throws {
        let root = try directory()
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".screendeck"), withIntermediateDirectories: true)
        let v2 = try JSONSerialization.data(withJSONObject: validObject)
        let originals = [v2, Data("broken JSON".utf8), Data("{\"schema_version\":1}".utf8), Data("{\"schema_version\":99}".utf8)]
        for original in originals {
            try original.write(to: identityURL(root))
            XCTAssertThrowsError(try store.initialize(root: root, name: "不能替换")) { error in
                XCTAssertEqual(error as? ProjectIdentityFailure, .alreadyExists)
            }
            XCTAssertEqual(try Data(contentsOf: identityURL(root)), original)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".screendeck").path), ["project.json"])
        }
    }

    func testStrictKeysTypesIdentityAndCalendarDatesRejectWithoutWrites() throws {
        let root = try directory()
        let mutations: [(inout [String: Any]) -> Void] = [
            { $0["schema_version"] = true }, { $0["schema_version"] = 1 },
            { $0["kind"] = "task" }, { $0["project_id"] = "project-../secret" },
            { $0["project_id"] = "project-11111111-1111-1111-1111-111111111111\n" },
            { $0["project_id"] = "project-AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
            { $0["name"] = NSNull() }, { $0["name"] = "\n" },
            { $0["created_at"] = "2026-02-30T10:00:00Z" },
            { $0["created_at"] = "2026-10-07T24:00:00Z" },
            { $0["created_at"] = "2026-10-07T10:00:00+24:00" },
            { $0["created_at"] = "2026-10-07T10:00:00" },
            { $0["created_at"] = "0000-01-01T00:00:00Z" },
            { $0["command"] = "not authorization" }, { $0.removeValue(forKey: "kind") }
        ]
        for mutation in mutations {
            var object = validObject
            mutation(&object)
            try write(object, root: root)
            let original = try Data(contentsOf: identityURL(root))
            XCTAssertThrowsError(try store.read(root: root))
            XCTAssertEqual(try Data(contentsOf: identityURL(root)), original)
        }
        var object = validObject
        object["created_at"] = "2024-02-29T12:34:56.123Z"
        try write(object, root: root)
        XCTAssertNoThrow(try store.read(root: root))
    }

    func testSymlinkedIdentityIncludingDanglingLinkIsNeverFollowedOrReplaced() throws {
        let root = try directory()
        let source = root.appendingPathComponent("original.json")
        let original = try JSONSerialization.data(withJSONObject: validObject)
        try original.write(to: source)
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".screendeck"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: identityURL(root), withDestinationURL: source)
        XCTAssertThrowsError(try store.read(root: root))
        XCTAssertThrowsError(try store.initialize(root: root, name: "拒绝"))
        XCTAssertEqual(try Data(contentsOf: source), original)
        try FileManager.default.removeItem(at: identityURL(root))
        let missing = root.appendingPathComponent("absent.json")
        try FileManager.default.createSymbolicLink(at: identityURL(root), withDestinationURL: missing)
        XCTAssertThrowsError(try store.read(root: root))
        XCTAssertThrowsError(try store.initialize(root: root, name: "拒绝"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: identityURL(root).path), missing.path)
    }

    func testSymlinkedDeckDirectoryAndProjectRootNeverWriteToTarget() throws {
        let root = try directory()
        let target = root.appendingPathComponent("target", isDirectory: true)
        let project = root.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: project.appendingPathComponent(".screendeck"), withDestinationURL: target)
        XCTAssertThrowsError(try store.read(root: project))
        XCTAssertThrowsError(try store.initialize(root: project, name: "拒绝"))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: target.path).isEmpty)
        let linkedRoot = root.appendingPathComponent("linked-root")
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: target)
        XCTAssertThrowsError(try store.initialize(root: linkedRoot, name: "拒绝"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.appendingPathComponent(".screendeck").path))
    }

    func testBoundedReaderRejectsOversizedAndNonregularIdentity() throws {
        let root = try directory()
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".screendeck"), withIntermediateDirectories: true)
        let url = identityURL(root)
        try Data(repeating: 0x20, count: 64 * 1024 + 1).write(to: url)
        XCTAssertThrowsError(try store.read(root: root)) { error in
            XCTAssertEqual(error as? ProjectIdentityFailure, .tooLarge)
        }
        XCTAssertThrowsError(try store.initialize(root: root, name: "拒绝"))
        try FileManager.default.removeItem(at: url)
        XCTAssertEqual(mkfifo(url.path, 0o600), 0)
        XCTAssertThrowsError(try store.read(root: root))
        XCTAssertThrowsError(try store.initialize(root: root, name: "拒绝"))
    }

    func testRootCannotBeFilesystemRootURLOrFile() throws {
        let root = try directory()
        let file = root.appendingPathComponent("plain-file")
        try Data("keep".utf8).write(to: file)
        for url in [URL(fileURLWithPath: "/"), URL(string: "https://example.test/project")!, file] {
            XCTAssertThrowsError(try store.initialize(root: url, name: "拒绝"))
            XCTAssertThrowsError(try store.read(root: url))
        }
        XCTAssertEqual(try Data(contentsOf: file), Data("keep".utf8))
    }

    func testIdentitySurvivesFolderMoveAndIndependentProjectsReceiveDifferentIDs() throws {
        let root = try directory()
        let first = root.appendingPathComponent("first", isDirectory: true)
        let second = root.appendingPathComponent("second", isDirectory: true)
        try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        let initial = try store.initialize(root: first, name: "同名项目")
        let other = try store.initialize(root: second, name: "同名项目")
        XCTAssertNotEqual(initial.projectID, other.projectID)
        let moved = root.appendingPathComponent("renamed-project", isDirectory: true)
        try FileManager.default.moveItem(at: first, to: moved)
        XCTAssertEqual(try store.read(root: moved), initial)
        let original = try Data(contentsOf: identityURL(moved))
        XCTAssertThrowsError(try store.initialize(root: moved, name: "新名称"))
        XCTAssertEqual(try Data(contentsOf: identityURL(moved)), original)
    }

    func testProjectReaderAcceptsIdentityOnlyV2WithoutCreatingPrivateRecordDirectories() throws {
        let root = try directory()
        let identity = try store.initialize(root: root, name: "新项目")
        let snapshot = try ProjectRecordReader().read(root: root)
        XCTAssertEqual(snapshot.project.projectID, identity.projectID)
        XCTAssertEqual(snapshot.project.name, identity.name)
        XCTAssertEqual(snapshot.project.createdAt, identity.createdAt)
        XCTAssertTrue(snapshot.project.references.isEmpty)
        XCTAssertTrue(snapshot.tasks.isEmpty)
        XCTAssertTrue(snapshot.runs.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".screendeck").path), ["project.json"])
    }

    func testProjectReaderRejectsV2ExtraFieldsAndUnsafeRecordDirectories() throws {
        let root = try directory()
        var object = validObject
        object["command"] = "not an execution authorization"
        try write(object, root: root)
        XCTAssertThrowsError(try ProjectRecordReader().read(root: root))
        try write(validObject, root: root)
        let other = root.appendingPathComponent("other-records", isDirectory: true)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let deck = root.appendingPathComponent(".screendeck")
        for name in ["tasks", "runs"] {
            let unsafe = deck.appendingPathComponent(name)
            try FileManager.default.createSymbolicLink(at: unsafe, withDestinationURL: other)
            XCTAssertThrowsError(try ProjectRecordReader().read(root: root))
            try FileManager.default.removeItem(at: unsafe)
            try Data("not a directory".utf8).write(to: unsafe)
            XCTAssertThrowsError(try ProjectRecordReader().read(root: root))
            try FileManager.default.removeItem(at: unsafe)
        }
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: other.path).isEmpty)
    }

    func testProjectReaderKeepsV1HistoryAndStrictMissingDirectoryChecks() throws {
        let root = try directory()
        let fixture = try ProjectRecordFixture(root: root)
        let urls = [fixture.projectURL, fixture.taskURL, fixture.runURL]
        let originals = try urls.map { try Data(contentsOf: $0) }
        let snapshot = try ProjectRecordReader().read(root: root)
        XCTAssertEqual(snapshot.project.mode, "manual_pilot")
        XCTAssertEqual(snapshot.project.timezone, "Asia/Shanghai")
        XCTAssertEqual(snapshot.tasks.count, 1)
        XCTAssertEqual(snapshot.runs.count, 1)
        XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, originals)
        XCTAssertThrowsError(try store.initialize(root: root, name: "不能迁移"))
        XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, originals)
        try FileManager.default.removeItem(at: root.appendingPathComponent(".screendeck/runs"))
        XCTAssertThrowsError(try ProjectRecordReader().read(root: root))
    }
}
