import XCTest
@testable import ScreenDeck

/// Missing is an empty initial store only until a file has been observed or migration requires it.
final class KnownPrivateStorePresenceTests: XCTestCase {
    private enum Kind: String, CaseIterable {
        case workspace, projects, conversations
    }

    private struct Fixture {
        let url: URL
        let seedBytes: Data
        let load: () throws -> Void
        let save: () throws -> Void
        let isMissingError: (Error) -> Bool
    }

    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-known-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fixture(_ kind: Kind, root: URL, requireExistingFile: Bool = false) throws -> Fixture {
        let url = root.appendingPathComponent("\(kind.rawValue)/private.json")
        let projectID = "project-11111111-1111-1111-1111-111111111111"
        switch kind {
        case .workspace:
            let store = LocalWorkspaceStore(url: url, requireExistingFile: requireExistingFile)
            let value = LocalWorkspace(tasks: [LocalTask(title: "保留任务")])
            return Fixture(url: url, seedBytes: try JSONEncoder().encode(value),
                           load: { _ = try store.load() }, save: { try store.save(value) },
                           isMissingError: { error in
                               guard let error = error as? WorkspaceError else { return false }
                               if case .missingFile = error { return true }
                               return false
                           })
        case .projects:
            let store = ProjectAssociationStore(url: url, requireExistingFile: requireExistingFile)
            let value = ProjectAssociationState(associations: [
                .init(projectID: projectID, name: "保留项目", rootPath: root.appendingPathComponent("Example").path)
            ])
            return Fixture(url: url, seedBytes: try JSONEncoder().encode(value),
                           load: { _ = try store.load() }, save: { try store.save(value) },
                           isMissingError: { error in
                               guard let error = error as? ProjectAssociationFailure else { return false }
                               if case .missingFile = error { return true }
                               return false
                           })
        case .conversations:
            let store = ProjectConversationStore(url: url, requireExistingFile: requireExistingFile)
            let value = ProjectConversationState(drafts: [
                .init(projectID: projectID, taskID: "task-001", text: "保留草稿")
            ])
            var expected = ProjectConversationState()
            return Fixture(url: url, seedBytes: try JSONEncoder().encode(value),
                           load: { expected = try store.load() },
                           save: { try store.save(value, replacing: expected); expected = value },
                           isMissingError: { error in
                               guard let error = error as? ProjectConversationFailure else { return false }
                               if case .missingFile = error { return true }
                               return false
                           })
        }
    }

    private func assertMissing(_ operation: () throws -> Void, fixture: Fixture,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try operation(), file: file, line: line) { error in
            XCTAssertTrue(fixture.isMissingError(error), "Unexpected error: \(error)", file: file, line: line)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.url.path), file: file, line: line)
    }

    func testRequiredMissingStoresNeverLoadEmptyOrCreateParents() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root, requireExistingFile: true)
            assertMissing(value.load, fixture: value)
            assertMissing(value.save, fixture: value)
            XCTAssertFalse(FileManager.default.fileExists(atPath: value.url.deletingLastPathComponent().path))
        }
    }

    func testFreshOptionalStoresLoadReadOnlyThenSaveAndRefuseDeletedSavedFile() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try value.load()
            XCTAssertFalse(FileManager.default.fileExists(atPath: value.url.deletingLastPathComponent().path))
            try value.save()
            XCTAssertTrue(FileManager.default.fileExists(atPath: value.url.path))
            try FileManager.default.removeItem(at: value.url)
            // No successful load after saving: publication itself establishes known presence.
            assertMissing(value.save, fixture: value)
            assertMissing(value.load, fixture: value)
            assertMissing(value.save, fixture: value)
        }
    }

    func testSuccessfulExistingLoadsRefuseDeletionWithoutResettingPresence() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try SafePrivateStorageIO.write(value.seedBytes, to: value.url, expected: nil)
            try value.load()
            try FileManager.default.removeItem(at: value.url)
            assertMissing(value.load, fixture: value)
            assertMissing(value.save, fixture: value)
            assertMissing(value.load, fixture: value)
        }
    }

    func testCorruptObservedFilesCannotBecomeFreshStoresAfterDeletion() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try SafePrivateStorageIO.write(Data("not-json".utf8), to: value.url, expected: nil)
            XCTAssertThrowsError(try value.load())
            try FileManager.default.removeItem(at: value.url)
            assertMissing(value.load, fixture: value)
            assertMissing(value.save, fixture: value)
        }
    }

    func testRestoringOriginalFileAllowsExplicitRetryWithoutReinitialization() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root, requireExistingFile: true)
            assertMissing(value.load, fixture: value)
            try SafePrivateStorageIO.write(value.seedBytes, to: value.url, expected: nil)
            try value.load()
            try FileManager.default.removeItem(at: value.url)
            assertMissing(value.save, fixture: value)
            try SafePrivateStorageIO.write(value.seedBytes, to: value.url, expected: nil)
            try value.load()
            try value.save()
            XCTAssertTrue(FileManager.default.fileExists(atPath: value.url.path))
        }
    }

    @MainActor
    func testMissingProjectDraftFileRetainsPendingInputAndRequiresRecovery() async throws {
        let root = try directory(), url = root.appendingPathComponent("drafts.json")
        let store = ProjectConversationStore(url: url)
        try store.save(.init(), replacing: .init())
        let controller = ProjectConversationController(store: store)
        let loaded = await controller.load()
        XCTAssertTrue(loaded)
        try FileManager.default.removeItem(at: url)
        let projectID = "project-11111111-1111-1111-1111-111111111111"
        XCTAssertFalse(controller.saveDraft(projectID: projectID, taskID: "task-001", text: "尚未保存"))
        XCTAssertFalse(controller.isLoaded)
        XCTAssertTrue(controller.hasUnsavedDrafts)
        XCTAssertEqual(controller.draft(projectID: projectID, taskID: "task-001"), "尚未保存")
        XCTAssertFalse(controller.retryDrafts())
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
