import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

/// Rendering is performed only against temporary source and global-store fixtures.
/// These are offscreen layout checks, not screenshots of the user's running app.
final class ProjectWorkbenchRenderTests: XCTestCase {
    private let sizes = [CGSize(width: 800, height: 560), CGSize(width: 1440, height: 900)]

    @MainActor
    func testProjectOverviewRendersRealRecordsWithoutChangingLocalWorkspace() async throws {
        let fixture = try await makeFixture()
        fixture.navigation.route = .project(fixture.source.projectID, taskID: nil)
        fixture.navigation.requestInspector()
        for size in sizes { try await render(fixture, size: size, name: "project-overview") }
        XCTAssertEqual(fixture.projects.snapshots[fixture.source.projectID]?.tasks.count, 1)
        XCTAssertEqual(fixture.projects.snapshots[fixture.source.projectID]?.runs.count, 1)
        XCTAssertEqual(fixture.state.tasks.count, 1, "Source tasks must never be copied into editable LocalTask")
    }

    @MainActor
    func testEveryProjectTaskInspectorTabRendersAtWideAndNarrowSizes() async throws {
        let fixture = try await makeFixture(longContent: true)
        XCTAssertTrue(fixture.projects.select(projectID: fixture.source.projectID, taskID: "task-001"))
        fixture.navigation.route = .project(fixture.source.projectID, taskID: "task-001")
        for tab in TaskInspectorTab.allCases {
            fixture.navigation.requestInspector(tab)
            for size in sizes {
                try await render(fixture, size: size, name: "project-task-\(tab.rawValue)")
            }
        }
        let task = try XCTUnwrap(fixture.projects.snapshots[fixture.source.projectID]?.tasks.first)
        XCTAssertEqual(task.acceptance.first?.verification, "not_checked")
        XCTAssertEqual(task.assignee, "shared")
        XCTAssertEqual(task.planVersion, 2)
    }

    @MainActor
    func testGlobalTaskSearchAndTimelineRoutesKeepProjectAndLocalRecordsSeparate() async throws {
        let fixture = try await makeFixture()
        for (route, label) in [(WorkbenchRoute.tasks, "tasks"), (.search, "search"), (.timeline, "timeline")] {
            fixture.navigation.route = route
            for size in sizes { try await render(fixture, size: size, name: "project-global-\(label)") }
        }
        XCTAssertEqual(fixture.projects.selection, .init(projectID: fixture.source.projectID, taskID: nil))
        XCTAssertEqual(fixture.state.tasks.first?.title, "保留已有本地任务")
        XCTAssertEqual(fixture.state.conversations.first?.draft, "原来的聊天草稿仍留在本地。")
    }

    @MainActor
    func testFailedSourceRefreshRendersStaleWholeSnapshotWithoutReadingOrOpeningReferences() async throws {
        let fixture = try await makeFixture()
        XCTAssertTrue(fixture.projects.select(projectID: fixture.source.projectID, taskID: "task-001"))
        fixture.navigation.route = .project(fixture.source.projectID, taskID: "task-001")
        fixture.navigation.requestInspector(.timeline)
        let previous = try XCTUnwrap(fixture.projects.snapshots[fixture.source.projectID])
        try Data("damaged fixture JSON".utf8).write(to: fixture.source.runURL)
        let refreshed = await fixture.projects.refresh(projectID: fixture.source.projectID)
        XCTAssertFalse(refreshed)
        XCTAssertEqual(fixture.projects.snapshots[fixture.source.projectID], previous)
        XCTAssertTrue(fixture.projects.staleProjectIDs.contains(fixture.source.projectID))
        for size in sizes { try await render(fixture, size: size, name: "project-stale-source") }
        XCTAssertThrowsError(try fixture.projects.referenceURL(.init(path: "docs/guide.md", label: "说明"),
                                                              projectID: fixture.source.projectID))
    }

    @MainActor
    func testMissingSourceAfterRestartRendersRememberedProjectButNoOfflineRecords() async throws {
        let fixture = try await makeFixture()
        XCTAssertTrue(fixture.projects.select(projectID: fixture.source.projectID, taskID: "task-001"))
        try FileManager.default.moveItem(at: fixture.source.root,
                                        to: fixture.root.appendingPathComponent("moved-source"))
        let counter = fixture.readCounter
        let restarted = ProjectWorkspaceController(store: fixture.projectStore, reader: { root in
            try counter.read(root: root)
        })
        let loaded = await restarted.load()
        XCTAssertTrue(loaded)
        XCTAssertEqual(restarted.selection, .init(projectID: fixture.source.projectID, taskID: nil))
        XCTAssertTrue(restarted.snapshots.isEmpty)
        XCTAssertNotNil(restarted.diagnostics[fixture.source.projectID])
        let restoredFixture = fixture.replacing(projects: restarted)
        restoredFixture.navigation.route = .project(fixture.source.projectID, taskID: nil)
        restoredFixture.navigation.requestInspector()
        for size in sizes { try await render(restoredFixture, size: size, name: "project-missing-source") }
    }

    @MainActor
    func testRememberedTaskSelectionRereadsSourceAndRendersWithoutRestoringExecution() async throws {
        let fixture = try await makeFixture()
        XCTAssertTrue(fixture.projects.select(projectID: fixture.source.projectID, taskID: "task-001"))
        let counter = fixture.readCounter
        let restarted = ProjectWorkspaceController(store: fixture.projectStore, reader: { root in
            try counter.read(root: root)
        })
        let loaded = await restarted.load()
        XCTAssertTrue(loaded)
        let selection = try XCTUnwrap(restarted.selection)
        XCTAssertEqual(selection.taskID, "task-001")
        let restoredFixture = fixture.replacing(projects: restarted)
        restoredFixture.navigation.route = .project(selection.projectID, taskID: selection.taskID)
        restoredFixture.navigation.requestInspector(.timeline)
        for size in sizes { try await render(restoredFixture, size: size, name: "project-restored-selection") }
    }

    @MainActor
    func testBrokenAssociationFileRendersDiagnosticWithoutOverwritingIt() async throws {
        let fixture = try await makeFixture()
        let invalid = Data("{\"version\":99,\"associations\":[]}".utf8)
        try invalid.write(to: fixture.projectStore.url)
        let loaded = await fixture.projects.load()
        XCTAssertFalse(loaded)
        XCTAssertFalse(fixture.projects.associationsLoaded)
        XCTAssertNotNil(fixture.projects.error)
        fixture.navigation.route = .tasks
        for size in sizes { try await render(fixture, size: size, name: "project-association-error") }
        XCTAssertEqual(try Data(contentsOf: fixture.projectStore.url), invalid)
    }

    func testPresentationKeepsUnknownTimesAndHistoricalRunningStatusHonest() throws {
        XCTAssertEqual(ProjectRecordPresentation.status("running"), "记录为执行中")
        XCTAssertEqual(ProjectRecordPresentation.time(nil), "未记录")
        XCTAssertEqual(ProjectRecordPresentation.time("invalid timestamp"), "invalid timestamp",
                       "An unformattable supplied value must not be relabeled as missing")
        XCTAssertEqual(ProjectRecordPresentation.time("2026-10-06T10:10:00+08:00"), "10-06 10:10:00 +08:00")
        XCTAssertEqual(ProjectRecordPresentation.assignee("shared"), "人机协同")
        let refs = [ProjectFileReference(path: "docs/guide.md", label: "首次引用"),
                    ProjectFileReference(path: "docs/guide.md", label: "重复引用")]
        XCTAssertEqual(ProjectRecordPresentation.references(refs), [refs[0]])
        for path in ["/temporary/guide.md", "/temporary/layout.PNG", "/temporary/report.pdf"] {
            XCTAssertTrue(ProjectRecordPresentation.supportsOpening(URL(fileURLWithPath: path)))
        }
        for path in ["/temporary/run.sh", "/temporary/ScreenDeck.app", "/temporary/run.command", "/temporary/demo.html"] {
            XCTAssertFalse(ProjectRecordPresentation.supportsOpening(URL(fileURLWithPath: path)))
        }
        XCTAssertFalse(ProjectRecordPresentation.supportsOpening(try XCTUnwrap(URL(string: "https://example.com/layout.png"))))
    }

    @MainActor
    func testProjectConversationRendersWithInspectorClosedWithoutChangingDraftsOrSource() async throws {
        let fixture = try await makeFixture()
        fixture.navigation.route = .project(fixture.source.projectID, taskID: "task-001")
        XCTAssertFalse(fixture.navigation.inspectorVisible)
        XCTAssertEqual(fixture.projectConversations.draft(projectID: fixture.source.projectID, taskID: "task-001"),
                       "这份任务补充仅保存为草稿，不发送给 Agent。")
        for size in sizes {
            XCTAssertFalse(fixture.navigation.showsInspector(at: size.width))
            try await render(fixture, size: size, name: "project-conversation")
        }
        XCTAssertFalse(fixture.projectConversations.hasUnsavedDrafts)
    }

    /// Structural assertions complement offscreen bitmap checks. They do not measure pixel layout.
    func testProjectCenterComposesInsteadOfDuplicatingRecordDetails() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/ScreenDeck/Features/WorkMemory/MainWorkbenchView.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "@ViewBuilder private var center: some View"))
        let end = try XCTUnwrap(source.range(of: "private var isChat: Bool", range: start.upperBound..<source.endIndex))
        let center = String(source[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(center.contains("case .project:"))
        XCTAssertTrue(center.contains("if let conversation = activeConversation"), "The center may display already-sent chat history")
        XCTAssertTrue(center.contains("projectChatWelcome"), "An empty project still has the conversational welcome")
        XCTAssertTrue(center.contains("composer"))
        XCTAssertFalse(center.contains("ProjectRecordContentView"), "Source details belong in the right inspector, not the conversation center")
        XCTAssertTrue(source.contains("accessibilityLabel(\"本地对话草稿\")"))
        XCTAssertTrue(source.contains(".disabled(!activeGeneration && !canSendDraft)"), "Send stays disabled until the actual controller permits it")
        XCTAssertTrue(source.contains("return chat.canSend(scope: scope)"), "The view must not bypass connection, model, consent or persistence gates")
        XCTAssertTrue(source.contains("accessibilityLabel(activeGeneration ? \"停止回复\" : \"发送消息\")"))
        XCTAssertTrue(source.contains("ProjectTaskInspectorView(snapshot:"))
    }

    @MainActor
    private func makeFixture(longContent: Bool = false) async throws -> ProjectWorkbenchRenderFixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("project-render-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"), name: "ScreenDeck 布局检查项目")
        if longContent {
            try source.mutate(source.taskURL) { object in
                object["title"] = "项目关联与执行记录展示：保留原有本地任务，并检查宽窄工作台中的真实来源与未知元信息"
                object["goal"] = "只读展示已登记任务、执行时间线与相关资料。" + String(repeating: "项目记录不能被当作自动执行授权，旧本地任务和草稿保持独立。", count: 3)
                object["acceptance"] = [["id": "user-review",
                                         "description": String(repeating: "人工检查任务来源、计划版本、未知模型与执行时间，确认布局后再验收。", count: 3),
                                         "verification": "not_checked", "requires_human": true]]
            }
        }
        let workspaceStore = ProjectRenderWorkspaceStore(url: root.appendingPathComponent("global/workspace.json"))
        let local = LocalTask(title: "保留已有本地任务", conversationDraft: "原任务草稿不能被项目记录覆盖。")
        let chat = LocalConversation(title: "已有聊天", createdAt: Date(timeIntervalSince1970: 1),
                                     draft: "原来的聊天草稿仍留在本地。")
        try workspaceStore.save(LocalWorkspace(tasks: [local], currentTaskID: local.id, conversations: [chat]))
        let state = AppState(store: workspaceStore)
        state.refresh()
        let capture = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("sessions"), captureService: capture)
        memory.load()
        let projectStore = ProjectRenderAssociationStore(url: root.appendingPathComponent("global/project-associations.json"))
        let counter = ProjectRenderReadCounter()
        let projects = ProjectWorkspaceController(store: projectStore, reader: { root in try counter.read(root: root) })
        let loaded = await projects.load()
        let associated = await projects.associate(root: source.root)
        XCTAssertTrue(loaded && associated)
        let conversationStore = ProjectRenderConversationStore(url: root.appendingPathComponent("global/project-conversations.json"))
        let projectConversations = ProjectConversationController(store: conversationStore)
        let conversationsLoaded = await projectConversations.load()
        XCTAssertTrue(conversationsLoaded)
        XCTAssertTrue(projectConversations.saveDraft(projectID: source.projectID, taskID: nil,
                                                     text: "项目级草稿与任务草稿保持独立。"))
        XCTAssertTrue(projectConversations.saveDraft(projectID: source.projectID, taskID: "task-001",
                                                     text: "这份任务补充仅保存为草稿，不发送给 Agent。"))
        return ProjectWorkbenchRenderFixture(root: root, source: source, state: state, workspaceStore: workspaceStore,
                                             projects: projects, projectStore: projectStore, readCounter: counter,
                                             projectConversations: projectConversations, conversationStore: conversationStore,
                                             memory: memory, capture: capture, navigation: WorkbenchNavigation())
    }

    @MainActor
    private func render(_ fixture: ProjectWorkbenchRenderFixture, size: CGSize, name: String) async throws {
        _ = NSApplication.shared
        let tasks = fixture.state.tasks
        let chats = fixture.state.conversations
        let currentTaskID = fixture.state.currentTaskID
        let deckRequest = fixture.state.deckTaskRequest
        let routes = tasks.map { WorkbenchRoute.task($0.id) } + chats.map { WorkbenchRoute.chat($0.id) }
        let drafts = routes.map { fixture.state.conversationDraft(for: $0) }
        let pending = routes.map { fixture.state.isConversationDraftUnsaved($0) }
        let route = fixture.navigation.route
        let tab = fixture.navigation.inspectorTab
        let selection = fixture.projects.selection
        let associations = fixture.projects.associations
        let snapshots = fixture.projects.snapshots
        let stale = fixture.projects.staleProjectIDs
        let diagnostics = fixture.projects.diagnostics
        let error = fixture.projects.error
        let workspaceBytes = try Data(contentsOf: fixture.workspaceStore.url)
        let associationBytes = try Data(contentsOf: fixture.projectStore.url)
        let workspaceWrites = fixture.workspaceStore.saveCount
        let associationWrites = fixture.projectStore.saveCount
        let associationReads = fixture.projectStore.loadCount
        let sourceReads = fixture.readCounter.count
        let sourceBytes = try sourceFileBytes(in: fixture.source.root)
        let projectDraftBytes = try Data(contentsOf: fixture.conversationStore.url)
        let projectDraftReads = fixture.conversationStore.loadCount
        let projectDraftWrites = fixture.conversationStore.saveCount
        let projectDrafts = [nil, "task-001"].map {
            fixture.projectConversations.draft(projectID: fixture.source.projectID, taskID: $0)
        }
        let projectDraftPending = fixture.projectConversations.hasUnsavedDrafts

        let view = MainWorkbenchView(state: fixture.state, memory: fixture.memory, navigation: fixture.navigation,
                                     projects: fixture.projects, projectConversations: fixture.projectConversations)
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        defer { window.contentView = nil }
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(80))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertEqual(host.bounds.size, size)
        XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        XCTAssertGreaterThan(bitmap.pixelsHigh, 0)

        XCTAssertEqual(fixture.state.tasks, tasks)
        XCTAssertEqual(fixture.state.conversations, chats)
        XCTAssertEqual(fixture.state.currentTaskID, currentTaskID)
        XCTAssertEqual(fixture.state.deckTaskRequest, deckRequest)
        XCTAssertEqual(routes.map { fixture.state.conversationDraft(for: $0) }, drafts)
        XCTAssertEqual(routes.map { fixture.state.isConversationDraftUnsaved($0) }, pending)
        XCTAssertEqual(fixture.navigation.route, route)
        XCTAssertEqual(fixture.navigation.inspectorTab, tab)
        XCTAssertEqual(fixture.projects.selection, selection)
        XCTAssertEqual(fixture.projects.associations, associations)
        XCTAssertEqual(fixture.projects.snapshots, snapshots)
        XCTAssertEqual(fixture.projects.staleProjectIDs, stale)
        XCTAssertEqual(fixture.projects.diagnostics, diagnostics)
        XCTAssertEqual(fixture.projects.error, error)
        XCTAssertEqual(fixture.workspaceStore.saveCount, workspaceWrites)
        XCTAssertEqual(fixture.projectStore.saveCount, associationWrites)
        XCTAssertEqual(fixture.projectStore.loadCount, associationReads)
        XCTAssertEqual(fixture.readCounter.count, sourceReads, "A render must not silently refresh or read linked files")
        XCTAssertEqual(fixture.conversationStore.loadCount, projectDraftReads)
        XCTAssertEqual(fixture.conversationStore.saveCount, projectDraftWrites)
        XCTAssertEqual([nil, "task-001"].map { fixture.projectConversations.draft(projectID: fixture.source.projectID, taskID: $0) }, projectDrafts)
        XCTAssertEqual(fixture.projectConversations.hasUnsavedDrafts, projectDraftPending)
        XCTAssertEqual(try Data(contentsOf: fixture.conversationStore.url), projectDraftBytes)
        XCTAssertEqual(try Data(contentsOf: fixture.workspaceStore.url), workspaceBytes)
        XCTAssertEqual(try Data(contentsOf: fixture.projectStore.url), associationBytes)
        XCTAssertEqual(try sourceFileBytes(in: fixture.source.root), sourceBytes)
        XCTAssertNil(fixture.memory.activeID)
        XCTAssertTrue(fixture.memory.sessions.isEmpty)
        XCTAssertFalse(fixture.memory.capturing)
        XCTAssertEqual(fixture.capture.requests, 0)
        XCTAssertEqual(fixture.capture.captures, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.memory.store.root.path))

        if let output = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"],
           !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let folder = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: folder.appendingPathComponent("\(name)-\(Int(size.width)).png"))
        }
    }

    private func sourceFileBytes(in root: URL) throws -> [String: Data] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [:] }
        let keys: [URLResourceKey] = [.isRegularFileKey]
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys))
        var bytes: [String: Data] = [:]
        for case let file as URL in enumerator where try file.resourceValues(forKeys: Set(keys)).isRegularFile == true {
            bytes[file.path] = try Data(contentsOf: file)
        }
        return bytes
    }
}

@MainActor
private struct ProjectWorkbenchRenderFixture {
    let root: URL
    let source: ProjectRecordFixture
    let state: AppState
    let workspaceStore: ProjectRenderWorkspaceStore
    let projects: ProjectWorkspaceController
    let projectStore: ProjectRenderAssociationStore
    let readCounter: ProjectRenderReadCounter
    let projectConversations: ProjectConversationController
    let conversationStore: ProjectRenderConversationStore
    let memory: WorkSessionController
    let capture: SettingsCaptureFixture
    let navigation: WorkbenchNavigation

    func replacing(projects: ProjectWorkspaceController) -> Self {
        Self(root: root, source: source, state: state, workspaceStore: workspaceStore,
             projects: projects, projectStore: projectStore, readCounter: readCounter,
             projectConversations: projectConversations, conversationStore: conversationStore,
             memory: memory, capture: capture, navigation: navigation)
    }
}

private final class ProjectRenderWorkspaceStore: WorkspaceStore {
    private let backing: LocalWorkspaceStore
    var url: URL { backing.url }
    private(set) var saveCount = 0
    init(url: URL) { backing = LocalWorkspaceStore(url: url) }
    func load() throws -> LocalWorkspace { try backing.load() }
    func save(_ value: LocalWorkspace) throws { try backing.save(value); saveCount += 1 }
}

private final class ProjectRenderAssociationStore: ProjectAssociationStoring {
    private let backing: ProjectAssociationStore
    var url: URL { backing.url }
    private(set) var saveCount = 0
    private(set) var loadCount = 0
    init(url: URL) { backing = ProjectAssociationStore(url: url) }
    func load() throws -> ProjectAssociationState { loadCount += 1; return try backing.load() }
    func save(_ value: ProjectAssociationState) throws { try backing.save(value); saveCount += 1 }
}

private final class ProjectRenderReadCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0
    var count: Int { lock.withLock { requests } }
    func read(root: URL) throws -> ProjectRecordSnapshot {
        lock.withLock { requests += 1 }
        return try ProjectRecordReader().read(root: root)
    }
}

private final class ProjectRenderConversationStore: ProjectConversationStoring {
    private let backing: ProjectConversationStore
    var url: URL { backing.url }
    private(set) var saveCount = 0
    private(set) var loadCount = 0
    init(url: URL) { backing = ProjectConversationStore(url: url) }
    func load() throws -> ProjectConversationState { loadCount += 1; return try backing.load() }
    func save(_ state: ProjectConversationState, replacing expected: ProjectConversationState) throws {
        try backing.save(state, replacing: expected)
        saveCount += 1
    }
}
