import XCTest
@testable import ScreenDeck

final class PrivateStoreRevisionTests: XCTestCase {
    private enum Kind: String, CaseIterable { case workspace, projects }

    private struct Fixture {
        let url: URL
        let initialBytes: Data
        let externalBytes: Data
        let load: () throws -> Void
        let save: () throws -> Void
        let isRevisionError: (Error) -> Bool
        let hasInitialState: () throws -> Bool
    }

    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-revision-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fixture(_ kind: Kind, root: URL) throws -> Fixture {
        let url = root.appendingPathComponent("\(kind.rawValue)/private.json")
        switch kind {
        case .workspace:
            let store = LocalWorkspaceStore(url: url)
            let initial = LocalWorkspace(tasks: [LocalTask(title: "原始任务")])
            var external = initial
            external.tasks[0].title = "其他窗口修改的有效任务"
            return Fixture(url: url, initialBytes: try JSONEncoder().encode(initial),
                           externalBytes: try JSONEncoder().encode(external),
                           load: { _ = try store.load() }, save: { try store.save(initial) },
                           isRevisionError: { error in
                               guard let error = error as? WorkspaceError else { return false }
                               if case .revisionChanged = error { return true }
                               return false
                           }, hasInitialState: { try store.load() == initial })
        case .projects:
            let store = ProjectAssociationStore(url: url)
            let projectRoot = root.appendingPathComponent("Example").path
            let initial = ProjectAssociationState(associations: [
                .init(projectID: "project-11111111-1111-1111-1111-111111111111", name: "原始项目", rootPath: projectRoot)
            ])
            var external = initial
            external.associations[0] = .init(projectID: initial.associations[0].projectID,
                                             name: "其他窗口修改的有效项目", rootPath: projectRoot)
            return Fixture(url: url, initialBytes: try JSONEncoder().encode(initial),
                           externalBytes: try JSONEncoder().encode(external),
                           load: { _ = try store.load() }, save: { try store.save(initial) },
                           isRevisionError: { error in
                               guard let error = error as? ProjectAssociationFailure else { return false }
                               if case .revisionChanged = error { return true }
                               return false
                           }, hasInitialState: { try store.load() == initial })
        }
    }

    private func assertExternalRevisionIsPreservedUntilReload(_ value: Fixture,
                                                             file: StaticString = #filePath, line: UInt = #line) throws {
        let previous = try SafePrivateStorageIO.read(value.url, maximumBytes: SafePrivateStorageIO.defaultMaximumBytes)
        try SafePrivateStorageIO.write(value.externalBytes, to: value.url, expected: previous)
        for _ in 0..<2 {
            XCTAssertThrowsError(try value.save(), file: file, line: line) { error in
                XCTAssertTrue(value.isRevisionError(error), "Unexpected error: \(error)", file: file, line: line)
            }
            XCTAssertEqual(try Data(contentsOf: value.url), value.externalBytes, file: file, line: line)
        }
        // An explicit refresh makes later edits use the newly read revision.
        try value.load()
        try value.save()
        XCTAssertTrue(try value.hasInitialState(), file: file, line: line)
    }

    func testSuccessfulLoadRemembersExactRevisionAndRejectsValidExternalChanges() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try SafePrivateStorageIO.write(value.initialBytes, to: value.url, expected: nil)
            try value.load()
            try assertExternalRevisionIsPreservedUntilReload(value)
        }
    }

    func testSuccessfulSaveRemembersExactRevisionWithoutSubsequentLoad() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try value.save()
            try assertExternalRevisionIsPreservedUntilReload(value)
        }
    }

    func testInitialMissingLoadRemembersAbsenceAndCannotOverwriteAnExternallyCreatedStore() throws {
        let root = try directory()
        for kind in Kind.allCases {
            let value = try fixture(kind, root: root)
            try value.load()
            XCTAssertFalse(FileManager.default.fileExists(atPath: value.url.deletingLastPathComponent().path))
            try assertExternalRevisionIsPreservedUntilReload(value)
        }
    }
}
