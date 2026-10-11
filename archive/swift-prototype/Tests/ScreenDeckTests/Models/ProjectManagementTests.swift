import XCTest
@testable import ScreenDeck

final class ProjectManagementTests: XCTestCase {
    private func directory() throws -> URL {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-project-management-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    @MainActor
    func testRemovingNewProjectAssociationPreservesIdentityAndPrivateDrafts() async throws {
        let root = try directory(), source = root.appendingPathComponent("source")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let identity = try ProjectIdentityStore().initialize(root: source, name: "新项目")
        let identityURL = source.appendingPathComponent(".screendeck/project.json")
        let original = try Data(contentsOf: identityURL)
        let registry = ProjectAssociationStore(url: root.appendingPathComponent("private/projects.json"))
        let projects = ProjectWorkspaceController(store: registry)
        let loaded = await projects.load(); XCTAssertTrue(loaded)
        let linked = await projects.associate(root: source); XCTAssertTrue(linked)
        XCTAssertEqual(projects.selection?.projectID, identity.projectID)
        let drafts = ProjectConversationStore(url: root.appendingPathComponent("private/project-drafts.json"))
        let draft = ProjectConversationState(drafts: [.init(projectID: identity.projectID, taskID: nil, text: "保留未发送草稿")])
        try drafts.save(draft, replacing: .init())
        let originalDraft = try Data(contentsOf: drafts.url)

        XCTAssertTrue(projects.removeAssociation(projectID: identity.projectID))
        XCTAssertTrue(projects.associations.isEmpty)
        XCTAssertNil(projects.selection)
        XCTAssertNil(projects.snapshots[identity.projectID])
        XCTAssertTrue(try registry.load().associations.isEmpty)
        XCTAssertEqual(try Data(contentsOf: identityURL), original)
        XCTAssertEqual(try Data(contentsOf: drafts.url), originalDraft)
        XCTAssertEqual(try drafts.load(), draft)
        let relinked = await projects.associate(root: source); XCTAssertTrue(relinked)
        XCTAssertEqual(projects.associations.first?.projectID, identity.projectID)
    }

    @MainActor
    func testExternalAssociationChangeRefusesRemovalWithoutMutatingPublishedOrSourceState() async throws {
        let root = try directory(), source = root.appendingPathComponent("source")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let identity = try ProjectIdentityStore().initialize(root: source, name: "新项目")
        let registry = ProjectAssociationStore(url: root.appendingPathComponent("private/projects.json"))
        let projects = ProjectWorkspaceController(store: registry)
        let loaded = await projects.load(); XCTAssertTrue(loaded)
        let linked = await projects.associate(root: source); XCTAssertTrue(linked)
        let original = try Data(contentsOf: source.appendingPathComponent(".screendeck/project.json"))
        let anotherWindow = ProjectAssociationStore(url: registry.url)
        var external = try anotherWindow.load()
        external.associations[0] = .init(projectID: identity.projectID, name: "外部改名", rootPath: external.associations[0].rootPath)
        try anotherWindow.save(external)
        let externalBytes = try Data(contentsOf: registry.url)

        XCTAssertFalse(projects.removeAssociation(projectID: identity.projectID))
        XCTAssertEqual(projects.associations.count, 1)
        XCTAssertEqual(projects.selection?.projectID, identity.projectID)
        XCTAssertNotNil(projects.error)
        XCTAssertEqual(try Data(contentsOf: registry.url), externalBytes)
        XCTAssertEqual(try Data(contentsOf: source.appendingPathComponent(".screendeck/project.json")), original)
    }
}
