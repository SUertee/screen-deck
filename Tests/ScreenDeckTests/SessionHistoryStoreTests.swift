import XCTest
import Darwin
@testable import ScreenDeck

final class SessionHistoryStoreTests: XCTestCase {
    private let time = Date(timeIntervalSince1970: 1_791_331_200)

    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-chat-history-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func record(scope: SessionScope? = nil) -> Session {
        let turn = Turn(requestedModel: .init(providerID: "test", modelID: "model", variant: "default"),
                            createdAt: time, updatedAt: time)
        let message = Message(turnID: turn.turnID, role: .user, text: "纯聊天测试输入",
                                  createdAt: time, updatedAt: time)
        return Session(title: "聊天历史", scope: scope ?? .localChat(UUID()),
                                createdAt: time, updatedAt: time, turns: [turn], messages: [message])
    }

    private func file(_ conversation: Session, root: URL) -> URL {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy/MM/dd"
        return root.appendingPathComponent(formatter.string(from: conversation.createdAt), isDirectory: true)
            .appendingPathComponent("\(conversation.sessionID.uuidString.lowercased()).json")
    }

    private func flatFile(_ session: Session, root: URL) -> URL {
        root.appendingPathComponent("\(session.sessionID.uuidString.lowercased()).json")
    }

    private func previousRoots(_ paths: ScreenDeckPaths) -> [URL] {
        paths.previousSessionHistoryRoots
    }

    private func date(_ value: String) throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: value))
    }

    private func writeFlatFixture(_ proposed: Session, root: URL) throws -> Session {
        var session = proposed
        session.revision = 1
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var value = encoder.singleValueContainer()
            try value.encode(formatter.string(from: date))
        }
        try SafePrivateStorageIO.write(encoder.encode(session), to: flatFile(session, root: root), expected: nil)
        return session
    }

    private func assertStorageFailure(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(error is SessionHistoryFailure || error is SafePrivateStorageError || error is PrivateStorageDirectoryError,
                      "Unexpected non-storage failure: \(error)", file: file, line: line)
    }

    private func allEntries(_ root: URL) throws -> [String] {
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        return enumerator.compactMap { ($0 as? URL)?.path.replacingOccurrences(of: root.path + "/", with: "") }.sorted()
    }

    private func alter(_ url: URL, _ update: (inout [String: Any]) -> Void) throws -> Data {
        let previous = try XCTUnwrap(SafePrivateStorageIO.read(url, maximumBytes: SessionHistoryStore.maximumFileBytes))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: previous) as? [String: Any])
        update(&object)
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try SafePrivateStorageIO.write(bytes, to: url, expected: previous, maximumBytes: SessionHistoryStore.maximumFileBytes)
        return bytes
    }

    private func assertHistoryOperationsFail(_ store: SessionHistoryStore, session: Session,
                                            expectedRevision: Int? = nil,
                                            expectedFailure: SessionHistoryFailure? = .previousDirectoryNeedsMigration,
                                            file: StaticString = #filePath, line: UInt = #line) async {
        func assertFailure(_ error: Error) {
            if let expectedFailure {
                XCTAssertEqual(error as? SessionHistoryFailure, expectedFailure, file: file, line: line)
            } else {
                XCTAssertNotNil(error as? SafePrivateStorageError, file: file, line: line)
            }
        }
        do {
            _ = try await store.load(sessionID: session.sessionID)
            XCTFail("The previous history root did not block loading", file: file, line: line)
        } catch { assertFailure(error) }
        do {
            _ = try await store.list()
            XCTFail("The previous history root did not block listing", file: file, line: line)
        } catch { assertFailure(error) }
        do {
            _ = try await store.save(session, expectedRevision: expectedRevision)
            XCTFail("The previous history root did not block saving", file: file, line: line)
        } catch { assertFailure(error) }
    }

    func testConstructionAndEmptyReadsCreateNoDirectories() async throws {
        let parent = try directory()
        let root = parent.appendingPathComponent("absent/history", isDirectory: true)
        let previousRoot = parent.appendingPathComponent("previous/history", isDirectory: true)
        let store = SessionHistoryStore(root: root, previousRoots: [previousRoot])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: previousRoot.path))
        let absent = try await store.load(sessionID: UUID())
        let listing = try await store.list()
        XCTAssertNil(absent)
        XCTAssertTrue(listing.records.isEmpty)
        XCTAssertTrue(listing.diagnostics.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent("absent").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: parent.appendingPathComponent("previous").path))
    }

    func testMissingPreviousHistoryRootPermitsNewHistoryWithoutCreatingOldDirectory() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        let listing = try await store.list()
        XCTAssertTrue(listing.records.isEmpty)
        let saved = try await store.save(record(), expectedRevision: nil)
        let loaded = try await store.load(sessionID: saved.sessionID)
        XCTAssertEqual(loaded, saved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file(saved, root: paths.sessionHistory).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.previousSessionHistory.deletingLastPathComponent().path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.previousFlatSessionHistory.path))
        let bytes = try Data(contentsOf: file(saved, root: paths.sessionHistory))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(json["schema_version"] as? Int, 1)
        XCTAssertEqual(json["conversation_id"] as? String, saved.sessionID.uuidString)
        XCTAssertNil(json["session_id"])
    }

    func testPreviousHistoryBlocksAllOperationsAndLeavesOldBytesAndNewRootUntouched() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        let old = try writeFlatFixture(record(), root: paths.previousSessionHistory)
        let oldFile = flatFile(old, root: paths.previousSessionHistory)
        let original = try Data(contentsOf: oldFile)
        let originalNames = try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).sorted()
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessionHistory.path))
        await assertHistoryOperationsFail(store, session: old, expectedRevision: old.revision)
        XCTAssertEqual(try Data(contentsOf: oldFile), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).sorted(), originalNames)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessionHistory.path))
    }

    func testBothHistoryRootsConflictWithoutChangingEitherLibrary() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        let old = try writeFlatFixture(record(), root: paths.previousSessionHistory)
        var current = try await SessionHistoryStore(root: paths.sessionHistory).save(record(), expectedRevision: nil)
        let oldFile = flatFile(old, root: paths.previousSessionHistory)
        let currentFile = file(current, root: paths.sessionHistory)
        let oldBytes = try Data(contentsOf: oldFile), currentBytes = try Data(contentsOf: currentFile)
        let oldNames = try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).sorted()
        let currentNames = try FileManager.default.contentsOfDirectory(atPath: paths.sessionHistory.path).sorted()
        current.title = "不得写入的冲突修改"
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        await assertHistoryOperationsFail(store, session: current, expectedRevision: current.revision)
        XCTAssertEqual(try Data(contentsOf: oldFile), oldBytes)
        XCTAssertEqual(try Data(contentsOf: currentFile), currentBytes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).sorted(), oldNames)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: paths.sessionHistory.path).sorted(), currentNames)
    }

    func testEmptyPreviousHistoryDirectoryStillBlocksAllOperations() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        try FileManager.default.createDirectory(at: paths.previousSessionHistory, withIntermediateDirectories: true)
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        await assertHistoryOperationsFail(store, session: record())
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessionHistory.path))
    }

    func testPreviousHistorySymlinkLeafAndAncestorAreRejectedWithoutFollowingTarget() async throws {
        for linksAncestor in [false, true] {
            let parent = try directory()
            let paths = ScreenDeckPaths(home: parent)
            let outside = parent.appendingPathComponent("outside", isDirectory: true)
            let targetRoot = outside.appendingPathComponent("history", isDirectory: true)
            try FileManager.default.createDirectory(at: targetRoot, withIntermediateDirectories: true)
            let target = targetRoot.appendingPathComponent("fixture.json")
            let bytes = Data("unchanged symlink-target fixture".utf8)
            try SafePrivateStorageIO.write(bytes, to: target, expected: nil)
            let targetNames = try FileManager.default.contentsOfDirectory(atPath: targetRoot.path).sorted()
            let link = linksAncestor ? paths.previousSessionHistory.deletingLastPathComponent() : paths.previousSessionHistory
            let destination = linksAncestor ? outside : targetRoot
            try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: destination)
            let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
            await assertHistoryOperationsFail(store, session: record(), expectedFailure: nil)
            XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: targetRoot.path).sorted(), targetNames)
            XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessionHistory.path))
            var attributes = stat()
            XCTAssertEqual(lstat(link.path, &attributes), 0)
            XCTAssertEqual(attributes.st_mode & S_IFMT, S_IFLNK)
        }
    }

    func testPreviousHistoryRootMustBeDirectoryAndRegularFileIsUnchanged() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        let bytes = Data("unchanged non-directory fixture".utf8)
        try SafePrivateStorageIO.write(bytes, to: paths.previousSessionHistory, expected: nil)
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        await assertHistoryOperationsFail(store, session: record(), expectedFailure: nil)
        XCTAssertEqual(try Data(contentsOf: paths.previousSessionHistory), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: paths.sessionHistory.path))
    }

    func testPreviousHistoryAppearingAfterCurrentRecordReadBlocksSubsequentOperations() async throws {
        let paths = ScreenDeckPaths(home: try directory())
        let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
        var current = try await store.save(record(), expectedRevision: nil)
        let observed = try await store.load(sessionID: current.sessionID)
        XCTAssertEqual(observed, current)
        let currentFile = file(current, root: paths.sessionHistory)
        let original = try Data(contentsOf: currentFile)
        let originalNames = try FileManager.default.contentsOfDirectory(atPath: paths.sessionHistory.path).sorted()
        try FileManager.default.createDirectory(at: paths.previousSessionHistory, withIntermediateDirectories: true)
        current.title = "旧目录出现后不得写入"
        await assertHistoryOperationsFail(store, session: current, expectedRevision: current.revision)
        XCTAssertEqual(try Data(contentsOf: currentFile), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: paths.sessionHistory.path).sorted(), originalNames)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: paths.previousSessionHistory.path).isEmpty)
    }

    func testPreviousFlatSessionsHistoryBlocksEvenWhenEmptyOrAlongsideDatedRecords() async throws {
        for containsOldFile in [false, true] {
            let paths = ScreenDeckPaths(home: try directory())
            let saved = try await SessionHistoryStore(root: paths.sessionHistory).save(record(), expectedRevision: nil)
            let currentFile = file(saved, root: paths.sessionHistory)
            let original = try Data(contentsOf: currentFile)
            try FileManager.default.createDirectory(at: paths.previousFlatSessionHistory, withIntermediateDirectories: true)
            var oldFile: URL?, oldBytes: Data?
            if containsOldFile {
                let old = try writeFlatFixture(record(), root: paths.previousFlatSessionHistory)
                oldFile = flatFile(old, root: paths.previousFlatSessionHistory)
                oldBytes = try Data(contentsOf: try XCTUnwrap(oldFile))
            }
            let originalEntries = try allEntries(paths.sessionHistory)
            let store = SessionHistoryStore(root: paths.sessionHistory, previousRoots: previousRoots(paths))
            await assertHistoryOperationsFail(store, session: saved, expectedRevision: saved.revision)
            XCTAssertEqual(try Data(contentsOf: currentFile), original)
            if let oldFile, let oldBytes { XCTAssertEqual(try Data(contentsOf: oldFile), oldBytes) }
            XCTAssertEqual(try allEntries(paths.sessionHistory), originalEntries)
        }
    }

    func testUTCDateBucketsUseCreationInstantIncludingMidnightAndYearBoundary() async throws {
        let cases = [
            ("2026-10-08T07:59:59.999+08:00", "2026/10/07"),
            ("2026-10-08T08:00:00.000+08:00", "2026/10/08"),
            ("2026-12-31T19:30:00.000-05:00", "2027/01/01")
        ]
        for (timestamp, expectedBucket) in cases {
            let root = try directory()
            var proposed = record()
            proposed.createdAt = try date(timestamp)
            proposed.updatedAt = proposed.createdAt.addingTimeInterval(10)
            let saved = try await SessionHistoryStore(root: root).save(proposed, expectedRevision: nil)
            let expected = root.appendingPathComponent(expectedBucket, isDirectory: true)
                .appendingPathComponent("\(saved.sessionID.uuidString.lowercased()).json")
            XCTAssertTrue(FileManager.default.fileExists(atPath: expected.path))
            XCTAssertEqual(file(saved, root: root), expected)
            XCTAssertFalse(FileManager.default.fileExists(atPath: flatFile(saved, root: root).path))
            let reopened = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
            XCTAssertEqual(reopened, saved)
        }
    }

    func testLeapDayUsesGregorianUTCDateAndReopensByID() async throws {
        let root = try directory()
        var proposed = record()
        proposed.createdAt = try date("2024-02-29T23:59:59.999Z")
        proposed.updatedAt = try date("2024-03-01T00:00:01.000Z")
        let saved = try await SessionHistoryStore(root: root).save(proposed, expectedRevision: nil)
        let expected = root.appendingPathComponent("2024/02/29/\(saved.sessionID.uuidString.lowercased()).json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: expected.path))
        let loaded = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
        XCTAssertEqual(loaded, saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("2024/03/01").path))
    }

    func testContinuationAcrossDaysUpdatesOriginalFileAndKeepsCreationDate() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var proposed = record()
        proposed.createdAt = try date("2026-10-07T23:59:59.999Z")
        proposed.updatedAt = proposed.createdAt
        var saved = try await store.save(proposed, expectedRevision: nil)
        let originalFile = root.appendingPathComponent("2026/10/07/\(saved.sessionID.uuidString.lowercased()).json")
        saved.updatedAt = try date("2026-10-09T00:00:01.000Z")
        saved.title = "跨日继续的同一会话"
        let revised = try await store.save(saved, expectedRevision: saved.revision)
        XCTAssertEqual(revised.createdAt, proposed.createdAt)
        XCTAssertEqual(revised.revision, 2)
        let loaded = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
        XCTAssertEqual(loaded, revised)
        XCTAssertTrue(FileManager.default.fileExists(atPath: originalFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("2026/10/09").path))
    }

    func testRestartRebuildsIDLookupWithoutWritingCacheAndListsByUpdatedAt() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var first = record(), second = record()
        first.createdAt = try date("2026-01-02T03:04:05.000Z")
        first.updatedAt = try date("2026-10-09T00:00:00.000Z")
        second.createdAt = try date("2026-09-10T11:12:13.000Z")
        second.updatedAt = try date("2026-10-08T00:00:00.000Z")
        let savedFirst = try await store.save(first, expectedRevision: nil)
        let savedSecond = try await store.save(second, expectedRevision: nil)
        let originalEntries = try allEntries(root)
        let firstBytes = try Data(contentsOf: file(savedFirst, root: root))
        let secondBytes = try Data(contentsOf: file(savedSecond, root: root))
        let reopened = SessionHistoryStore(root: root)
        let loadedSecond = try await reopened.load(sessionID: savedSecond.sessionID)
        let loadedFirst = try await reopened.load(sessionID: savedFirst.sessionID)
        let missing = try await reopened.load(sessionID: UUID())
        let listing = try await reopened.list()
        XCTAssertEqual(loadedFirst, savedFirst)
        XCTAssertEqual(loadedSecond, savedSecond)
        XCTAssertNil(missing)
        XCTAssertEqual(listing.records.map(\.sessionID), [savedFirst.sessionID, savedSecond.sessionID])
        XCTAssertTrue(listing.diagnostics.isEmpty)
        XCTAssertEqual(try allEntries(root), originalEntries)
        XCTAssertEqual(try Data(contentsOf: file(savedFirst, root: root)), firstBytes)
        XCTAssertEqual(try Data(contentsOf: file(savedSecond, root: root)), secondBytes)
    }

    func testIDLookupRefreshesAfterAnotherWriterAddsADifferentDateBucket() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let initial = try await store.list()
        XCTAssertTrue(initial.records.isEmpty)
        var proposed = record()
        proposed.createdAt = try date("2025-05-06T07:08:09.000Z")
        let saved = try await SessionHistoryStore(root: root).save(proposed, expectedRevision: nil)
        let loaded = try await store.load(sessionID: saved.sessionID)
        XCTAssertEqual(loaded, saved)
    }

    func testCreationDateCannotChangeWithinDayOrToAnotherBucket() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var proposed = record()
        proposed.createdAt = try date("2026-10-07T12:00:00.000Z")
        let saved = try await store.save(proposed, expectedRevision: nil)
        let originalFile = file(saved, root: root)
        let original = try Data(contentsOf: originalFile)
        let originalEntries = try allEntries(root)
        for changedDate in ["2026-10-07T12:00:01.000Z", "2026-10-08T12:00:00.000Z"] {
            var changed = saved
            changed.createdAt = try date(changedDate)
            do {
                _ = try await store.save(changed, expectedRevision: changed.revision)
                XCTFail("A persisted creation timestamp was changed")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .creationDateChanged) }
            XCTAssertEqual(try Data(contentsOf: originalFile), original)
            XCTAssertEqual(try allEntries(root), originalEntries)
        }
    }

    func testDuplicateIDsAcrossDateBucketsBlockLookupAndSaveButKeepHealthyRecords() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let duplicate = try await store.save(record(), expectedRevision: nil)
        let healthy = try await store.save(record(), expectedRevision: nil)
        let originalFile = file(duplicate, root: root)
        let original = try Data(contentsOf: originalFile)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
        object["created_at"] = "2025-02-03T00:00:00.000Z"
        object["updated_at"] = "2025-02-03T00:00:01.000Z"
        let copyBytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let duplicateFile = root.appendingPathComponent("2025/02/03/\(duplicate.sessionID.uuidString.lowercased()).json")
        try SafePrivateStorageIO.write(copyBytes, to: duplicateFile, expected: nil)
        let originalEntries = try allEntries(root)
        let listing = try await store.list()
        XCTAssertEqual(listing.records.map(\.sessionID), [healthy.sessionID])
        XCTAssertFalse(listing.diagnostics.isEmpty)
        do {
            _ = try await store.load(sessionID: duplicate.sessionID)
            XCTFail("A duplicate ID selected one arbitrary path")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
        do {
            _ = try await store.save(duplicate, expectedRevision: duplicate.revision)
            XCTFail("A duplicate ID library allowed an overwrite")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
        XCTAssertEqual(try Data(contentsOf: originalFile), original)
        XCTAssertEqual(try Data(contentsOf: duplicateFile), copyBytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testRecordCreationDateMustMatchItsBucketWithoutRelocatingOriginal() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let url = file(saved, root: root)
        let changed = try alter(url) { $0["created_at"] = "2024-02-29T01:00:00.000Z" }
        let originalEntries = try allEntries(root)
        let listing = try await store.list()
        XCTAssertTrue(listing.records.isEmpty)
        XCTAssertFalse(listing.diagnostics.isEmpty)
        do {
            _ = try await store.load(sessionID: saved.sessionID)
            XCTFail("A record whose creation date did not match the path was loaded")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidDatePath) }
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("A mismatched date record was overwritten")
        } catch { assertStorageFailure(error) }
        XCTAssertEqual(try Data(contentsOf: url), changed)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testExternallyMovedObservedRecordCannotBeRecreatedAtOriginalPath() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let originalFile = file(saved, root: root)
        let bytes = try Data(contentsOf: originalFile)
        let moved = root.appendingPathComponent("2024/02/29/\(saved.sessionID.uuidString.lowercased()).json")
        try FileManager.default.createDirectory(at: moved.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: originalFile, to: moved)
        let originalEntries = try allEntries(root)
        do {
            _ = try await store.load(sessionID: saved.sessionID)
            XCTFail("An externally moved record was accepted without a diagnostic")
        } catch { assertStorageFailure(error) }
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("An externally moved observed record was recreated")
        } catch { assertStorageFailure(error) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: originalFile.path))
        XCTAssertEqual(try Data(contentsOf: moved), bytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testMalformedCalendarDirectoriesFailWholeScanAndPreventNewWrites() async throws {
        for path in ["year", "2026/13", "2026/02/29", "2026/10/8", "2024/02/30"] {
            let root = try directory()
            try FileManager.default.createDirectory(at: root.appendingPathComponent(path), withIntermediateDirectories: true)
            let store = SessionHistoryStore(root: root)
            let proposed = record()
            let originalEntries = try allEntries(root)
            do {
                _ = try await store.list()
                XCTFail("Malformed calendar directory was silently ignored: \(path)")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.load(sessionID: proposed.sessionID)
                XCTFail("An incomplete date scan was treated as a missing ID")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("An incomplete date scan allowed a new record")
            } catch { assertStorageFailure(error) }
            XCTAssertEqual(try allEntries(root), originalEntries)
        }
    }

    func testCalendarPathComponentsMustBeDirectoriesAndRemainUnchanged() async throws {
        for path in ["2026", "2026/10", "2026/10/07"] {
            let root = try directory()
            let nonDirectory = root.appendingPathComponent(path)
            let bytes = Data("unchanged calendar-path fixture".utf8)
            try FileManager.default.createDirectory(at: nonDirectory.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: nonDirectory)
            let originalEntries = try allEntries(root)
            let store = SessionHistoryStore(root: root)
            let proposed = record()
            do {
                _ = try await store.list()
                XCTFail("A numeric calendar file was silently ignored: \(path)")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.load(sessionID: proposed.sessionID)
                XCTFail("A non-directory calendar component was treated as a missing ID")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("A numeric calendar file permitted writing")
            } catch { assertStorageFailure(error) }
            XCTAssertEqual(try Data(contentsOf: nonDirectory), bytes)
            XCTAssertEqual(try allEntries(root), originalEntries)
        }
    }

    func testCalendarDirectorySymlinksFailWholeScanWithoutFollowingTargets() async throws {
        for path in ["2026", "2026/10", "2026/10/07"] {
            let parent = try directory()
            let root = parent.appendingPathComponent("sessions", isDirectory: true)
            let outside = parent.appendingPathComponent("outside", isDirectory: true)
            let target = outside.appendingPathComponent("fixture.json")
            let bytes = Data("unchanged date-bucket symlink target".utf8)
            try SafePrivateStorageIO.write(bytes, to: target, expected: nil)
            let link = root.appendingPathComponent(path, isDirectory: true)
            try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
            let outsideEntries = try allEntries(outside)
            let originalEntries = try allEntries(root)
            let store = SessionHistoryStore(root: root)
            let proposed = record()
            do {
                _ = try await store.list()
                XCTFail("A calendar directory symlink was followed: \(path)")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.load(sessionID: proposed.sessionID)
                XCTFail("A calendar symlink was treated as an empty date bucket")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("A calendar symlink permitted a history write")
            } catch { assertStorageFailure(error) }
            XCTAssertEqual(try Data(contentsOf: target), bytes)
            XCTAssertEqual(try allEntries(outside), outsideEntries)
            XCTAssertEqual(try allEntries(root), originalEntries)
            var attributes = stat()
            XCTAssertEqual(lstat(link.path, &attributes), 0)
            XCTAssertEqual(attributes.st_mode & S_IFMT, S_IFLNK)
        }
    }

    func testUnclassifiedJSONFileBlocksCreationWithoutOverwritingHealthyHistory() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let healthy = try await store.save(record(), expectedRevision: nil)
        let healthyFile = file(healthy, root: root)
        let original = try Data(contentsOf: healthyFile)
        let unknownFile = healthyFile.deletingLastPathComponent().appendingPathComponent("unknown.json")
        let unknownBytes = Data("{\"fixture\":\"unknown identity\"}".utf8)
        try SafePrivateStorageIO.write(unknownBytes, to: unknownFile, expected: nil)
        let originalEntries = try allEntries(root)
        let listing = try await store.list()
        XCTAssertEqual(listing.records.map(\.sessionID), [healthy.sessionID])
        XCTAssertFalse(listing.diagnostics.isEmpty)
        do {
            _ = try await store.save(record(), expectedRevision: nil)
            XCTFail("An unclassified record permitted creation of another history file")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .incompleteScan) }
        XCTAssertEqual(try Data(contentsOf: healthyFile), original)
        XCTAssertEqual(try Data(contentsOf: unknownFile), unknownBytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testDamagedJSONCannotProveAnotherSessionIDIsAbsent() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let healthy = try await store.save(record(), expectedRevision: nil)
        let healthyFile = file(healthy, root: root)
        let original = try Data(contentsOf: healthyFile)
        let damagedFile = healthyFile.deletingLastPathComponent()
            .appendingPathComponent("\(UUID().uuidString.lowercased()).json")
        let damagedBytes = Data("{damaged temporary fixture".utf8)
        try damagedBytes.write(to: damagedFile)
        let originalEntries = try allEntries(root)
        let listing = try await store.list()
        XCTAssertEqual(listing.records.map(\.sessionID), [healthy.sessionID])
        XCTAssertFalse(listing.diagnostics.isEmpty)
        let proposed = record()
        do {
            _ = try await SessionHistoryStore(root: root).load(sessionID: proposed.sessionID)
            XCTFail("Damaged JSON was treated as proof that an ID did not exist")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .incompleteScan) }
        do {
            _ = try await store.save(proposed, expectedRevision: nil)
            XCTFail("Damaged JSON permitted a new record despite an unknown body identity")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .incompleteScan) }
        XCTAssertEqual(try Data(contentsOf: healthyFile), original)
        XCTAssertEqual(try Data(contentsOf: damagedFile), damagedBytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testSidecarNamesCannotHideDirectoriesOrSymlinks() async throws {
        for isTemporary in [false, true] {
            for isSymlink in [false, true] {
                let parent = try directory()
                let root = parent.appendingPathComponent("sessions", isDirectory: true)
                let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
                try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
                let filename = "\(UUID().uuidString.lowercased()).json"
                let name = isTemporary ? ".\(filename).\(UUID().uuidString.lowercased()).tmp" : ".\(filename).lock"
                let sidecar = bucket.appendingPathComponent(name)
                let outside = parent.appendingPathComponent("outside", isDirectory: true)
                try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
                let target = outside.appendingPathComponent("fixture.json")
                let bytes = Data("unchanged sidecar target".utf8)
                try bytes.write(to: target)
                if isSymlink {
                    try FileManager.default.createSymbolicLink(at: sidecar, withDestinationURL: target)
                } else {
                    try FileManager.default.createDirectory(at: sidecar, withIntermediateDirectories: true)
                }
                let originalEntries = try allEntries(root)
                let outsideEntries = try allEntries(outside)
                let store = SessionHistoryStore(root: root)
                do {
                    _ = try await store.list()
                    XCTFail("A storage sidecar name hid a non-regular entry")
                } catch { assertStorageFailure(error) }
                do {
                    _ = try await store.load(sessionID: UUID())
                    XCTFail("A sidecar directory or symlink made a scan appear complete")
                } catch { assertStorageFailure(error) }
                do {
                    _ = try await store.save(record(), expectedRevision: nil)
                    XCTFail("A non-regular sidecar permitted writing history")
                } catch { assertStorageFailure(error) }
                XCTAssertEqual(try Data(contentsOf: target), bytes)
                XCTAssertEqual(try allEntries(outside), outsideEntries)
                XCTAssertEqual(try allEntries(root), originalEntries)
                var attributes = stat()
                XCTAssertEqual(lstat(sidecar.path, &attributes), 0)
                XCTAssertEqual(attributes.st_mode & S_IFMT, isSymlink ? S_IFLNK : S_IFDIR)
            }
        }
    }

    func testTemporarySidecarRequiresExactDotSeparatedFilenameAndUUID() async throws {
        for separator in ["!", "-", "_"] {
            let root = try directory()
            let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
            try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
            let fake = bucket.appendingPathComponent(".\(UUID().uuidString.lowercased()).json\(separator)\(UUID().uuidString.lowercased()).tmp")
            let bytes = Data("unchanged malformed sidecar".utf8)
            try bytes.write(to: fake)
            let originalEntries = try allEntries(root)
            let store = SessionHistoryStore(root: root)
            do {
                _ = try await store.list()
                XCTFail("A non-dot temporary sidecar delimiter was accepted")
            } catch { assertStorageFailure(error) }
            do {
                _ = try await store.save(record(), expectedRevision: nil)
                XCTFail("A malformed temporary sidecar permitted writing")
            } catch { assertStorageFailure(error) }
            XCTAssertEqual(try Data(contentsOf: fake), bytes)
            XCTAssertEqual(try allEntries(root), originalEntries)
        }
    }

    func testExactRegularLockAndTemporarySidecarsAreReadOnlyIgnoredEntries() async throws {
        let root = try directory()
        let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
        try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
        let filename = "\(UUID().uuidString.lowercased()).json"
        let lock = bucket.appendingPathComponent(".\(filename).lock")
        let temporary = bucket.appendingPathComponent(".\(filename).\(UUID().uuidString.lowercased()).tmp")
        let bytes = Data("preserve regular temporary fixture".utf8)
        try Data().write(to: lock)
        try bytes.write(to: temporary)
        let originalEntries = try allEntries(root)
        let store = SessionHistoryStore(root: root)
        let listing = try await store.list()
        let missing = try await store.load(sessionID: UUID())
        XCTAssertTrue(listing.records.isEmpty)
        XCTAssertTrue(listing.diagnostics.isEmpty)
        XCTAssertNil(missing)
        XCTAssertEqual(try Data(contentsOf: lock), Data())
        XCTAssertEqual(try Data(contentsOf: temporary), bytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testGlobalSessionLimitCountsRecordsAcrossDifferentDateBuckets() async throws {
        let root = try directory()
        for index in 0...SessionHistoryStore.maximumSessions {
            let bucket = root.appendingPathComponent(index % 2 == 0 ? "2026/01/01" : "2026/01/02", isDirectory: true)
            try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
            try Data("{}".utf8).write(to: bucket.appendingPathComponent("\(UUID().uuidString.lowercased()).json"))
        }
        let originalEntries = try allEntries(root)
        let store = SessionHistoryStore(root: root)
        do {
            _ = try await store.list()
            XCTFail("An oversized library returned a partial listing")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        do {
            _ = try await store.save(record(), expectedRevision: nil)
            XCTFail("The global record limit was counted per day")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testDirectoryScanLimitFailsClosedWithoutCreatingARecord() async throws {
        let root = try directory()
        for year in 1970...(1970 + SessionHistoryStore.maximumScannedDirectories) {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(String(format: "%04d", year)), withIntermediateDirectories: true)
        }
        let originalEntries = try allEntries(root)
        let store = SessionHistoryStore(root: root)
        do {
            _ = try await store.list()
            XCTFail("A directory scan limit returned a partial library")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        do {
            _ = try await store.save(record(), expectedRevision: nil)
            XCTFail("An incomplete directory scan allowed writing")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testEntryScanLimitIncludesIgnoredLockFilesWithoutWritingHistory() async throws {
        let root = try directory()
        let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
        try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
        for _ in 0...SessionHistoryStore.maximumScannedEntries {
            try Data().write(to: bucket.appendingPathComponent(".\(UUID().uuidString.lowercased()).json.lock"))
        }
        let originalEntries = try allEntries(root)
        let store = SessionHistoryStore(root: root)
        do {
            _ = try await store.list()
            XCTFail("Ignored file names bypassed the entry scan limit")
        } catch { XCTAssertEqual(error as? PrivateStorageDirectoryError, .tooManyEntries) }
        do {
            _ = try await store.save(record(), expectedRevision: nil)
            XCTFail("An entry scan limit allowed a new history file")
        } catch { XCTAssertEqual(error as? PrivateStorageDirectoryError, .tooManyEntries) }
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testSaveAtDirectoryScanLimitPreflightsNewDateDirectoriesWithoutMutatingLibrary() async throws {
        let root = try directory()
        // The root itself is the remaining directory counted by the scanner.
        for year in 1970..<(1970 + SessionHistoryStore.maximumScannedDirectories - 1) {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(String(format: "%04d", year)), withIntermediateDirectories: true)
        }
        let originalEntries = try allEntries(root)
        XCTAssertEqual(originalEntries.count + 1, SessionHistoryStore.maximumScannedDirectories)
        let store = SessionHistoryStore(root: root)
        let initial = try await store.list()
        XCTAssertTrue(initial.records.isEmpty)
        XCTAssertTrue(initial.diagnostics.isEmpty)
        var proposed = record()
        proposed.createdAt = try date("2026-10-07T12:00:00.000Z")
        do {
            _ = try await store.save(proposed, expectedRevision: nil)
            XCTFail("A successful write made a previously complete directory scan exceed its limit")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        XCTAssertEqual(try allEntries(root), originalEntries)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file(proposed, root: root).path))
        let unchanged = try await SessionHistoryStore(root: root).list()
        XCTAssertTrue(unchanged.records.isEmpty)
        XCTAssertTrue(unchanged.diagnostics.isEmpty)
    }

    func testSaveAtEntryScanLimitReservesJSONLockAndTemporarySlotsBeforeWriting() async throws {
        let root = try directory()
        let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
        try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
        // The year, month and day entries occupy the other three slots.
        for _ in 0..<(SessionHistoryStore.maximumScannedEntries - 3) {
            try Data().write(to: bucket.appendingPathComponent(".\(UUID().uuidString.lowercased()).json.lock"))
        }
        let originalEntries = try allEntries(root)
        XCTAssertEqual(originalEntries.count, SessionHistoryStore.maximumScannedEntries)
        let store = SessionHistoryStore(root: root)
        let initial = try await store.list()
        XCTAssertTrue(initial.records.isEmpty)
        XCTAssertTrue(initial.diagnostics.isEmpty)
        var proposed = record()
        proposed.createdAt = try date("2026-10-07T12:00:00.000Z")
        do {
            _ = try await store.save(proposed, expectedRevision: nil)
            XCTFail("A successful write exhausted unreserved JSON, lock or temporary slots")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        XCTAssertEqual(try allEntries(root), originalEntries)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file(proposed, root: root).path))
        let unchanged = try await SessionHistoryStore(root: root).list()
        XCTAssertTrue(unchanged.records.isEmpty)
        XCTAssertTrue(unchanged.diagnostics.isEmpty)
    }

    func testRoundTripUsesIndependentSnakeCaseHistoryAndExplicitDates() async throws {
        let root = try directory().appendingPathComponent("history", isDirectory: true)
        let store = SessionHistoryStore(root: root)
        var proposed = record()
        proposed.binding = .init(externalSessionID: "ses_test", endpoint: URL(string: "http://127.0.0.1:4096")!,
                                 directory: "/private/tmp/isolated-chat", compatibleVersion: "1.18.35",
                                 connectionGeneration: UUID())
        let saved = try await store.save(proposed, expectedRevision: nil)
        XCTAssertEqual(saved.revision, 1)
        let loaded = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
        XCTAssertEqual(loaded, saved)
        let bytes = try Data(contentsOf: file(saved, root: root))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(json["schema_version"] as? Int, 1)
        XCTAssertNotNil(json["conversation_id"])
        XCTAssertNil(json["conversationID"])
        XCTAssertNil(json["password"])
        XCTAssertTrue((json["created_at"] as? String)?.hasSuffix("Z") == true)
        XCTAssertEqual(try file(saved, root: root).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile, true)
        var attributes = stat()
        XCTAssertEqual(lstat(file(saved, root: root).path, &attributes), 0)
        XCTAssertEqual(attributes.st_mode & 0o777, 0o600)
    }

    func testAllScopesRoundTripAndProjectIDIsValidated() async throws {
        let root = try directory()
        let scopes: [SessionScope] = [
            .localChat(UUID()), .localTask(UUID()),
            .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: nil),
            .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: "task-013")
        ]
        let store = SessionHistoryStore(root: root)
        for scope in scopes {
            let saved = try await store.save(record(scope: scope), expectedRevision: nil)
            let loaded = try await store.load(sessionID: saved.sessionID)
            XCTAssertEqual(loaded?.scope, scope)
        }
        do {
            _ = try await store.save(record(scope: .project(projectID: "../../outside", taskID: nil)), expectedRevision: nil)
            XCTFail("An invalid project identity was accepted")
        } catch { }
        do {
            _ = try await store.save(record(scope: .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: "../task")), expectedRevision: nil)
            XCTFail("An invalid task identity was accepted")
        } catch { }
    }

    func testRevisionIncrementsAndExistingFilesRequireObservation() async throws {
        let root = try directory()
        let first = SessionHistoryStore(root: root)
        var saved = try await first.save(record(), expectedRevision: nil)
        saved.title = "修改标题"
        let second = SessionHistoryStore(root: root)
        do {
            _ = try await second.save(saved, expectedRevision: saved.revision)
            XCTFail("Unobserved existing record was overwritten")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .unobservedRecord) }
        _ = try await second.load(sessionID: saved.sessionID)
        let revised = try await second.save(saved, expectedRevision: saved.revision)
        XCTAssertEqual(revised.revision, 2)
        do {
            _ = try await first.save(saved, expectedRevision: saved.revision)
            XCTFail("A stale revision was accepted")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .revisionChanged) }
    }

    func testExactByteComparisonRejectsExternalEditsWithSameRevision() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let url = file(saved, root: root)
        let changed = try alter(url) { $0["title"] = "外部修改但仍使用同一revision" }
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("An external edit was overwritten")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .revisionChanged) }
        XCTAssertEqual(try Data(contentsOf: url), changed)
        let refreshed = try await store.load(sessionID: saved.sessionID)
        let reloaded = try XCTUnwrap(refreshed)
        let revised = try await store.save(reloaded, expectedRevision: reloaded.revision)
        XCTAssertEqual(revised.title, "外部修改但仍使用同一revision")
    }

    func testMissingPreviouslyObservedFileCannotBeRecreated() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let url = file(saved, root: root)
        try FileManager.default.removeItem(at: url)
        do {
            _ = try await store.load(sessionID: saved.sessionID)
            XCTFail("A previously observed file vanished without diagnostic")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .missingFile) }
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("Missing history was recreated")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .missingFile) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testDamagedAndUnknownVersionRecordsAreNotOverwritten() async throws {
        for version in [2, 99] {
            let root = try directory()
            let store = SessionHistoryStore(root: root)
            let saved = try await store.save(record(), expectedRevision: nil)
            let url = file(saved, root: root)
            let changed = try alter(url) { $0["schema_version"] = version }
            do {
                _ = try await store.save(saved, expectedRevision: saved.revision)
                XCTFail("Unknown version was overwritten")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .unsupportedVersion) }
            XCTAssertEqual(try Data(contentsOf: url), changed)
        }
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let url = file(saved, root: root)
        let previous = try Data(contentsOf: url), broken = Data("{not json".utf8)
        try SafePrivateStorageIO.write(broken, to: url, expected: previous)
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("Damaged history was overwritten")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        XCTAssertEqual(try Data(contentsOf: url), broken)
    }

    func testUnknownNestedAndBooleanVersionFieldsAreRejected() async throws {
        let modifications: [(inout [String: Any]) -> Void] = [
            { $0["password"] = "not-a-real-secret" },
            { $0["schema_version"] = true },
            { $0["revision"] = true },
            { $0["revision"] = 1.5 },
            { var scope = $0["scope"] as! [String: Any]; scope["project_id"] = "unexpected"; $0["scope"] = scope },
            { var turns = $0["turns"] as! [[String: Any]]; turns[0]["async_handle"] = "unsupported"; $0["turns"] = turns },
            { var turns = $0["turns"] as! [[String: Any]]; turns[0]["draft_revision"] = true; $0["turns"] = turns },
            { var turns = $0["turns"] as! [[String: Any]]; var model = turns[0]["requested_model"] as! [String: Any]; model["api_key"] = "fixture-only"; turns[0]["requested_model"] = model; $0["turns"] = turns },
            { var messages = $0["messages"] as! [[String: Any]]; messages[0]["raw_protocol"] = [:]; $0["messages"] = messages }
        ]
        for modification in modifications {
            let root = try directory()
            let store = SessionHistoryStore(root: root)
            let saved = try await store.save(record(), expectedRevision: nil)
            let url = file(saved, root: root)
            let changed = try alter(url, modification)
            do {
                _ = try await store.load(sessionID: saved.sessionID)
                XCTFail("Unsupported field or scalar was accepted")
            } catch { }
            XCTAssertEqual(try Data(contentsOf: url), changed)
        }
    }

    func testListingKeepsHealthyHistoryAndReportsBrokenFilesSeparately() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let healthy = try await store.save(record(), expectedRevision: nil)
        let broken = try await store.save(record(), expectedRevision: nil)
        _ = try alter(file(broken, root: root)) { $0["schema_version"] = 99 }
        let unknownFile = file(healthy, root: root).deletingLastPathComponent().appendingPathComponent("unknown.json")
        try SafePrivateStorageIO.write(Data("{}".utf8), to: unknownFile, expected: nil)
        let listing = try await store.list()
        XCTAssertEqual(listing.records.map(\.sessionID), [healthy.sessionID])
        XCTAssertEqual(listing.diagnostics.count, 2)
        XCTAssertTrue(listing.diagnostics.contains { $0.filename.hasSuffix("unknown.json") })
    }

    func testDuplicateIDsAndBrokenTurnRelationshipsAreRejected() async throws {
        let mutations: [(inout Session) -> Void] = [
            { $0.turns.append($0.turns[0]) },
            { var extra = $0.turns[0]; extra.turnID = UUID(); $0.turns.append(extra) },
            { $0.messages.append($0.messages[0]) },
            { $0.messages[0].turnID = UUID() },
            { $0.turns[0].draftRevision = -1 }
        ]
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        for mutate in mutations {
            var proposed = record()
            mutate(&proposed)
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("An invalid relation was saved")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
            XCTAssertFalse(FileManager.default.fileExists(atPath: file(proposed, root: root).path))
        }
    }

    func testUTF8MessageLimitRejectsWithoutSilentTruncationOrOverwrite() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var saved = try await store.save(record(), expectedRevision: nil)
        let url = file(saved, root: root), original = try Data(contentsOf: file(saved, root: root))
        saved.messages[0].text = String(repeating: "中", count: SessionHistoryStore.maximumMessageBytes / 3 + 1)
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("Oversized UTF-8 text was saved")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        XCTAssertEqual(try Data(contentsOf: url), original)
    }

    func testMessageAndTurnCountLimits() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        for messageOverflow in [false, true] {
            var proposed = record()
            if messageOverflow {
                proposed.messages = (0...SessionHistoryStore.maximumMessages).map { _ in
                    Message(turnID: proposed.turns[0].turnID, role: .assistant, text: "", createdAt: time, updatedAt: time)
                }
            } else {
                proposed.turns = (0...SessionHistoryStore.maximumTurns).map { _ in
                    Turn(requestedModel: .init(providerID: "test", modelID: "model"), createdAt: time, updatedAt: time)
                }
                proposed.messages = []
            }
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("Record count limit was ignored")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .tooLarge) }
        }
    }

    func testRuntimeBindingRejectsSecretsAndNonLoopbackEndpoints() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        for address in ["http://example.com:4096", "http://localhost:4096", "http://user:password@127.0.0.1:4096", "http://127.0.0.1:4096?token=fixture", "https://127.0.0.1:4096", "http://127.0.0.1:4096/path"] {
            var proposed = record()
            proposed.binding = .init(externalSessionID: "ses_fixture", endpoint: URL(string: address)!,
                                     directory: "/private/tmp/test", compatibleVersion: "1.18.35", connectionGeneration: UUID())
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("Unsafe runtime binding was saved")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        }
    }

    func testSymlinkLeafAndAncestorAreRejectedWithoutTouchingTarget() async throws {
        let root = try directory()
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let target = outside.appendingPathComponent("target.json")
        let bytes = Data("unchanged fixture".utf8)
        try SafePrivateStorageIO.write(bytes, to: target, expected: nil)
        let leafRoot = root.appendingPathComponent("leaf", isDirectory: true)
        try FileManager.default.createDirectory(at: leafRoot, withIntermediateDirectories: true)
        let proposed = record()
        try FileManager.default.createDirectory(at: file(proposed, root: leafRoot).deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: file(proposed, root: leafRoot), withDestinationURL: target)
        do {
            _ = try await SessionHistoryStore(root: leafRoot).save(proposed, expectedRevision: nil)
            XCTFail("A symlink leaf was followed")
        } catch { }
        let ancestor = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: ancestor, withDestinationURL: outside)
        do {
            _ = try await SessionHistoryStore(root: ancestor).list()
            XCTFail("A symlink history directory was followed")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: target), bytes)
    }

    func testPersistentFileLockRejectsContendingWriter() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let lockURL = file(saved, root: root).deletingLastPathComponent()
            .appendingPathComponent(".\(file(saved, root: root).lastPathComponent).lock")
        let descriptor = open(lockURL.path, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        XCTAssertEqual(flock(descriptor, LOCK_EX | LOCK_NB), 0)
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("A contended lock was ignored")
        } catch { XCTAssertNotNil(error as? SafePrivateStorageError) }
        let unchanged = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
        XCTAssertEqual(unchanged?.revision, 1)
    }

    func testFilenameAndRecordIdentityMustMatch() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let saved = try await store.save(record(), expectedRevision: nil)
        let newID = UUID(), previous = try Data(contentsOf: file(saved, root: root))
        let wrongFile = file(saved, root: root).deletingLastPathComponent().appendingPathComponent("\(newID.uuidString.lowercased()).json")
        try SafePrivateStorageIO.write(previous, to: wrongFile, expected: nil)
        do {
            _ = try await SessionHistoryStore(root: root).load(sessionID: newID)
            XCTFail("A record with mismatched filename identity was accepted")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        let listing = try await store.list()
        XCTAssertFalse(listing.records.contains { $0.sessionID == saved.sessionID || $0.sessionID == newID })
        XCTAssertTrue(listing.diagnostics.contains { $0.filename.hasSuffix(wrongFile.lastPathComponent) })
        XCTAssertTrue(listing.diagnostics.contains { $0.filename.hasSuffix(file(saved, root: root).lastPathComponent) })
        do {
            _ = try await SessionHistoryStore(root: root).load(sessionID: saved.sessionID)
            XCTFail("A duplicate body identity selected the original correctly named file")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("A duplicate body identity permitted overwriting the original file")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
        XCTAssertEqual(try Data(contentsOf: file(saved, root: root)), previous)
        XCTAssertEqual(try Data(contentsOf: wrongFile), previous)
    }

    func testRestartFindsRenamedBodyIdentityAndCannotRecreateItsOriginalFilename() async throws {
        let root = try directory()
        let saved = try await SessionHistoryStore(root: root).save(record(), expectedRevision: nil)
        let originalFile = file(saved, root: root)
        let bytes = try Data(contentsOf: originalFile)
        let renamed = originalFile.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString.lowercased()).json")
        try FileManager.default.moveItem(at: originalFile, to: renamed)
        let originalEntries = try allEntries(root)
        let reopened = SessionHistoryStore(root: root)
        do {
            _ = try await reopened.load(sessionID: saved.sessionID)
            XCTFail("A renamed JSON body identity was reported absent or silently accepted")
        } catch { assertStorageFailure(error) }
        var proposed = saved
        proposed.revision = 0
        proposed.title = "不得重建的同ID会话"
        do {
            _ = try await reopened.save(proposed, expectedRevision: nil)
            XCTFail("A renamed record's body ID was recreated at its original filename")
        } catch { assertStorageFailure(error) }
        let listing = try await reopened.list()
        XCTAssertFalse(listing.records.contains { $0.sessionID == saved.sessionID })
        XCTAssertFalse(listing.diagnostics.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: originalFile.path))
        XCTAssertEqual(try Data(contentsOf: renamed), bytes)
        XCTAssertEqual(try allEntries(root), originalEntries)
    }

    func testUnclassifiedFilenameStillClaimsBodyIdentityIncludingUnknownVersions() async throws {
        for version in [1, 99] {
            for keepsOriginal in [false, true] {
                let root = try directory()
                let saved = try await SessionHistoryStore(root: root).save(record(), expectedRevision: nil)
                let originalFile = file(saved, root: root)
                let originalBytes = try Data(contentsOf: originalFile)
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: originalBytes) as? [String: Any])
                object["schema_version"] = version
                let badBytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
                let badFile = originalFile.deletingLastPathComponent().appendingPathComponent("bad.json")
                try badBytes.write(to: badFile)
                if !keepsOriginal { try FileManager.default.removeItem(at: originalFile) }
                let originalEntries = try allEntries(root)
                let reopened = SessionHistoryStore(root: root)
                do {
                    _ = try await reopened.load(sessionID: saved.sessionID)
                    XCTFail("An unclassified filename's readable body ID was absent or selected")
                } catch {
                    if keepsOriginal { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
                    else { assertStorageFailure(error) }
                }
                var proposed = saved
                if !keepsOriginal { proposed.revision = 0 }
                proposed.title = "不得由坏文件名隐藏的同ID会话"
                do {
                    _ = try await reopened.save(proposed, expectedRevision: keepsOriginal ? saved.revision : nil)
                    XCTFail("An unclassified filename's body identity allowed recreation or overwrite")
                } catch {
                    if keepsOriginal { XCTAssertEqual(error as? SessionHistoryFailure, .duplicateSession) }
                    else { assertStorageFailure(error) }
                }
                let listing = try await reopened.list()
                XCTAssertFalse(listing.records.contains { $0.sessionID == saved.sessionID })
                XCTAssertTrue(listing.diagnostics.contains { $0.filename.hasSuffix("bad.json") })
                XCTAssertEqual(try Data(contentsOf: badFile), badBytes)
                if keepsOriginal { XCTAssertEqual(try Data(contentsOf: originalFile), originalBytes) }
                else { XCTAssertFalse(FileManager.default.fileExists(atPath: originalFile.path)) }
                XCTAssertEqual(try allEntries(root), originalEntries)
            }
        }
    }

    func testPersistedScopeCannotBeMovedToAnotherConversationOrProject() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var saved = try await store.save(record(), expectedRevision: nil)
        let original = try Data(contentsOf: file(saved, root: root))
        saved.scope = .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: "task-013")
        do {
            _ = try await store.save(saved, expectedRevision: saved.revision)
            XCTFail("An existing conversation was silently moved across scopes")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        XCTAssertEqual(try Data(contentsOf: file(saved, root: root)), original)
    }

    func testUnencodableDatesAreRejectedBeforeWriting() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        var proposed = record()
        proposed.updatedAt = Date(timeIntervalSince1970: 1e100)
        do {
            _ = try await store.save(proposed, expectedRevision: nil)
            XCTFail("An unencodable timestamp was persisted")
        } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file(proposed, root: root).path))
    }

    func testExternalMessagePartIdentityValidationRejectsDuplicatesAndMixedRepresentations() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        let mutations: [(inout Session) -> Void] = [
            { $0.messages[0].externalPartID = "prt_without_message" },
            { $0.messages[0].externalMessageID = "msg_same"; var duplicate = $0.messages[0]; duplicate.messageID = UUID(); $0.messages.append(duplicate) },
            { $0.messages[0].externalMessageID = "msg_same"; $0.messages[0].externalPartID = "prt_same"; var duplicate = $0.messages[0]; duplicate.messageID = UUID(); $0.messages.append(duplicate) },
            { $0.messages[0].externalMessageID = "msg_same"; var part = $0.messages[0]; part.messageID = UUID(); part.externalPartID = "prt_part"; $0.messages.append(part) },
            { $0.messages[0].externalMessageID = "msg_same"; $0.messages[0].externalPartID = "prt_user"; var assistant = $0.messages[0]; assistant.messageID = UUID(); assistant.role = .assistant; assistant.externalPartID = "prt_assistant"; $0.messages.append(assistant) },
            { $0.messages[0].externalMessageID = "msg_same"; $0.messages[0].externalPartID = "prt_first"; let extraTurn = Turn(requestedModel: .init(providerID: "test", modelID: "model")); $0.turns.append(extraTurn); var next = $0.messages[0]; next.messageID = UUID(); next.turnID = extraTurn.id; next.externalPartID = "prt_second"; $0.messages.append(next) }
        ]
        for mutation in mutations {
            var proposed = record()
            mutation(&proposed)
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("Invalid external message grouping was accepted")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        }
        var valid = record()
        valid.messages[0].externalMessageID = "msg_multi_part"; valid.messages[0].externalPartID = "prt_first"
        var next = valid.messages[0]
        next.messageID = UUID(); next.externalPartID = "prt_second"; next.text = "第二段"
        valid.messages.append(next)
        let saved = try await store.save(valid, expectedRevision: nil)
        XCTAssertEqual(saved.messages.count, 2)
    }

    func testBindingRequiresExplicitPortAndSingleLineDirectory() async throws {
        let root = try directory()
        let store = SessionHistoryStore(root: root)
        for (endpoint, directory) in [("http://127.0.0.1", "/private/tmp/test"), ("http://127.0.0.1:4096", "/private/tmp/line\nbreak"), ("http://127.0.0.1:4096", "/private/tmp/line\rbreak")] {
            var proposed = record()
            proposed.binding = .init(externalSessionID: "ses_fixture", endpoint: URL(string: endpoint)!, directory: directory,
                compatibleVersion: "1.18.35", connectionGeneration: UUID())
            do {
                _ = try await store.save(proposed, expectedRevision: nil)
                XCTFail("Ambiguous runtime binding was accepted")
            } catch { XCTAssertEqual(error as? SessionHistoryFailure, .invalidRecord) }
        }
    }
}
