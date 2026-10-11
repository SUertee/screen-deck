import XCTest
import Darwin
@testable import ScreenDeck

final class SafePrivateDirectoryTests: XCTestCase {
    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-directory-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testMissingDirectoryReturnsNilWithoutCreatingAncestors() throws {
        let root = try directory(), missing = root.appendingPathComponent("missing/nested")
        XCTAssertNil(try SafePrivateStorageIO.directoryEntries(missing, maximumEntries: 1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("missing").path))
    }

    func testExistingEmptyDirectoryIsAnEmptySnapshot() throws {
        let root = try directory()
        XCTAssertEqual(try SafePrivateStorageIO.directoryEntries(root, maximumEntries: 1), [])
    }

    func testKindsIncludeHiddenUnicodeLinksAndFIFOWithoutFollowingChildren() throws {
        let root = try directory(), target = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
        try Data("preserve".utf8).write(to: target.appendingPathComponent("private.json"))
        try Data().write(to: root.appendingPathComponent("草稿.json"))
        try Data().write(to: root.appendingPathComponent(".hidden"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("directory-link"),
                                                 withDestinationURL: target)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("file-link"),
                                                 withDestinationURL: target.appendingPathComponent("private.json"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("dangling-link"),
                                                 withDestinationURL: target.appendingPathComponent("missing"))
        XCTAssertEqual(mkfifo(root.appendingPathComponent("pipe").path, 0o600), 0)
        let entries = try XCTUnwrap(SafePrivateStorageIO.directoryEntries(root, maximumEntries: 7))
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0.kind) }), [
            "outside": .directory, "草稿.json": .regularFile, ".hidden": .regularFile,
            "directory-link": .other, "file-link": .other, "dangling-link": .other, "pipe": .other,
        ])
        XCTAssertEqual(try Data(contentsOf: target.appendingPathComponent("private.json")), Data("preserve".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.appendingPathComponent("missing").path))
    }

    func testEntryLimitIsInclusiveAndCountsEveryNonDotEntry() throws {
        let root = try directory()
        try Data().write(to: root.appendingPathComponent(".hidden"))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"),
                                                 withDestinationURL: root.appendingPathComponent("absent"))
        XCTAssertEqual(try SafePrivateStorageIO.directoryEntries(root, maximumEntries: 2)?.count, 2)
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(root, maximumEntries: 1)) { error in
            XCTAssertEqual(error as? PrivateStorageDirectoryError, .tooManyEntries)
        }
    }

    func testInvalidLimitsRejectEvenMissingDirectories() throws {
        let missing = try directory().appendingPathComponent("missing")
        for maximum in [-1, 0, SafePrivateStorageIO.defaultMaximumDirectoryEntries + 1, Int.max] {
            XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(missing, maximumEntries: maximum))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing.path))
    }

    func testDirectoryAndAncestorLinksRejectRatherThanReturningMissing() throws {
        let root = try directory(), target = root.appendingPathComponent("actual")
        try FileManager.default.createDirectory(at: target.appendingPathComponent("nested"),
                                                withIntermediateDirectories: true)
        let link = root.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(link, maximumEntries: 1))
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(link.appendingPathComponent("nested"),
                                                                     maximumEntries: 1))
        let dangling = root.appendingPathComponent("dangling")
        try FileManager.default.createSymbolicLink(at: dangling, withDestinationURL: root.appendingPathComponent("absent"))
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(dangling, maximumEntries: 1))
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(dangling.appendingPathComponent("nested"),
                                                                     maximumEntries: 1))
    }

    func testRegularFileAndRemoteURLAreErrors() throws {
        let file = try directory().appendingPathComponent("file")
        try Data().write(to: file)
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(file, maximumEntries: 1))
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(URL(string: "https://example.com/data")!,
                                                                     maximumEntries: 1))
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(URL(string: "file://example.com/private/tmp")!,
                                                                     maximumEntries: 1))
    }

    func testUnreadableDirectoryIsNotReportedAsMissing() throws {
        guard geteuid() != 0 else { throw XCTSkip("Root bypasses filesystem permissions") }
        let root = try directory()
        XCTAssertEqual(chmod(root.path, 0), 0)
        defer { _ = chmod(root.path, 0o700) }
        XCTAssertThrowsError(try SafePrivateStorageIO.directoryEntries(root, maximumEntries: 1))
    }

    func testConcurrentDirectoryMutationCannotProduceAnUnvalidatedSnapshot() throws {
        let root = try directory()
        let fixedNames = Set((0..<512).map { "entry-\($0)" })
        for name in fixedNames { try Data().write(to: root.appendingPathComponent(name)) }
        let control = MutationControl(), started = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
        let marker = root.appendingPathComponent("changing").path
        DispatchQueue.global().async {
            defer { finished.signal() }
            var announced = false
            while !control.isStopped {
                let descriptor = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
                if descriptor >= 0 { close(descriptor) }
                _ = unlink(marker)
                if !announced { announced = true; started.signal() }
            }
        }
        defer {
            control.stop()
            XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        }
        XCTAssertEqual(started.wait(timeout: .now() + 5), .success)
        var observedChange = false
        for _ in 0..<30 {
            do {
                let snapshot = try SafePrivateStorageIO.directoryEntries(root, maximumEntries: 1024)
                let entries = try XCTUnwrap(snapshot)
                let names = Set(entries.map(\.name))
                XCTAssertEqual(names.intersection(fixedNames), fixedNames)
                XCTAssertTrue(names.subtracting(fixedNames).isSubset(of: ["changing"]))
                XCTAssertEqual(entries.count, names.count)
                XCTAssertTrue(entries.allSatisfy { $0.kind == .regularFile })
            }
            catch PrivateStorageDirectoryError.directoryChanged { observedChange = true; break }
            catch { XCTFail("Unexpected scan failure: \(error)"); return }
        }
        // Scheduling may let every bounded scan fall between mutations. That is a valid snapshot,
        // not a reader failure; only a run observing a changed directory exercises this race guard.
        if !observedChange { throw XCTSkip("The writer did not overlap a directory snapshot validation") }
    }

    private final class MutationControl: @unchecked Sendable {
        private let lock = NSLock()
        private var stopped = false

        var isStopped: Bool {
            lock.lock()
            defer { lock.unlock() }
            return stopped
        }

        func stop() {
            lock.lock()
            stopped = true
            lock.unlock()
        }
    }
}
