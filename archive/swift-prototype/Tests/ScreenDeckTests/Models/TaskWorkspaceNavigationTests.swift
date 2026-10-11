import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

final class TaskWorkspaceNavigationTests: XCTestCase {
    private func item(project: String = "project-a", task: String? = "task-001", path: String = "docs/guide.md",
                      text: String = "# 已读取资料") -> WorkspaceAttachment {
        let id = WorkspaceAttachmentID(projectID: project, taskID: task, relativePath: path)
        return WorkspaceAttachment(id: id, reference: .init(path: path, label: "资料"),
                                   preview: ProjectAttachmentPreview(content: .text(text),
                                                                     fileName: URL(fileURLWithPath: path).lastPathComponent,
                                                                     bytes: text.utf8.count,
                                                                     loadedAt: Date(timeIntervalSince1970: 1),
                                                                     sourceURL: URL(fileURLWithPath: "/temporary/source").appendingPathComponent(path)))
    }

    @MainActor
    func testTaskTabIsDefaultAndOpeningSameAttachmentUpdatesInsteadOfDuplicating() {
        let workspace = TaskWorkspaceController()
        let scope = TaskWorkspaceScope.project("project-a", taskID: "task-001")
        XCTAssertNil(workspace.session(for: scope).selectedAttachment)
        XCTAssertTrue(workspace.sessions.isEmpty, "Reading presentation state must not populate the cache")
        workspace.open(item(), in: scope)
        workspace.open(item(text: "新快照"), in: scope)
        XCTAssertEqual(workspace.session(for: scope).attachments.count, 1)
        XCTAssertEqual(workspace.session(for: scope).selectedAttachment?.preview.content, .text("新快照"))
        workspace.showTask(in: scope)
        XCTAssertNil(workspace.session(for: scope).selectedAttachment)
        XCTAssertEqual(workspace.session(for: scope).attachments.count, 1)
    }

    @MainActor
    func testSamePathAndTaskNamesAreIsolatedAcrossProjectAndTaskIdentities() {
        let workspace = TaskWorkspaceController()
        let a = TaskWorkspaceScope.project("project-a", taskID: "task-001")
        let b = TaskWorkspaceScope.project("project-b", taskID: "task-001")
        let c = TaskWorkspaceScope.project("project-a", taskID: "task-002")
        workspace.open(item(), in: a)
        workspace.open(item(project: "project-b"), in: b)
        workspace.open(item(task: "task-002"), in: c)
        workspace.showTask(in: b)
        XCTAssertNotNil(workspace.session(for: a).selectedAttachment)
        XCTAssertNil(workspace.session(for: b).selectedAttachment)
        XCTAssertNotNil(workspace.session(for: c).selectedAttachment)
        XCTAssertEqual(workspace.sessions.count, 3)
    }

    @MainActor
    func testMismatchedScopeOrPathCannotOpenAnAttachment() {
        let workspace = TaskWorkspaceController()
        workspace.open(item(), in: .local(UUID()))
        workspace.open(item(), in: .project("project-b", taskID: "task-001"))
        let invalid = WorkspaceAttachment(id: item().id,
                                           reference: .init(path: "different.md", label: "不一致"), preview: item().preview)
        workspace.open(invalid, in: .project("project-a", taskID: "task-001"))
        XCTAssertTrue(workspace.sessions.isEmpty)
    }

    @MainActor
    func testClosingActiveAttachmentReturnsToTaskButKeepsOtherFiles() {
        let workspace = TaskWorkspaceController()
        let scope = TaskWorkspaceScope.project("project-a", taskID: "task-001")
        let first = item()
        let second = item(path: "docs/another.md")
        workspace.open(first, in: scope)
        workspace.open(second, in: scope)
        workspace.close(second.id, in: scope)
        XCTAssertNil(workspace.session(for: scope).selectedAttachment)
        XCTAssertEqual(workspace.session(for: scope).attachments, [first])
        workspace.select(first.id, in: scope)
        XCTAssertEqual(workspace.session(for: scope).selectedAttachment?.id, first.id)
    }

    @MainActor
    func testPreviewCacheHasBoundedFilesAndScopes() {
        let workspace = TaskWorkspaceController()
        let scope = TaskWorkspaceScope.project("project-a", taskID: "task-001")
        for index in 0..<12 { workspace.open(item(path: "docs/\(index).md"), in: scope) }
        XCTAssertEqual(workspace.session(for: scope).attachments.count, TaskWorkspaceController.attachmentLimit)
        XCTAssertEqual(workspace.session(for: scope).selectedAttachment?.reference.path, "docs/11.md")
        for index in 0..<20 {
            workspace.open(item(project: "project-\(index)"), in: .project("project-\(index)", taskID: "task-001"))
        }
        XCTAssertEqual(workspace.sessions.count, TaskWorkspaceController.sessionLimit)
    }

    @MainActor
    func testPreviewSelectionDoesNotChangeTaskViewsOrRequestExecution() {
        let navigation = WorkbenchNavigation()
        let workspace = TaskWorkspaceController()
        navigation.route = .project("project-a", taskID: "task-001")
        navigation.inspectorTab = .assignment
        let route = navigation.route
        let scope = TaskWorkspaceScope.project("project-a", taskID: "task-001")
        workspace.open(item(), in: scope)
        workspace.showTask(in: scope)
        XCTAssertEqual(navigation.route, route)
        XCTAssertEqual(navigation.inspectorTab, .assignment)
        XCTAssertFalse(navigation.inspectorVisible)
    }

    @MainActor
    func testCacheByteBudgetEvictsOldScopesAndOldFilesButKeepsSelectedPreview() {
        let workspace = TaskWorkspaceController()
        func large(_ project: String, _ path: String) -> WorkspaceAttachment {
            let base = item(project: project, path: path)
            return WorkspaceAttachment(id: base.id, reference: base.reference,
                                       preview: .init(content: base.preview.content, fileName: base.preview.fileName,
                                                      bytes: 16 * 1024 * 1024, loadedAt: base.preview.loadedAt,
                                                      sourceURL: base.preview.sourceURL))
        }
        for index in 0..<6 {
            workspace.open(large("project-\(index)", "docs/image.png"),
                           in: .project("project-\(index)", taskID: "task-001"))
        }
        XCTAssertEqual(workspace.sessions.count, 4)
        XCTAssertNil(workspace.sessions[.project("project-0", taskID: "task-001")])
        let scope = TaskWorkspaceScope.project("project-selected", taskID: "task-001")
        for index in 0..<6 { workspace.open(large("project-selected", "docs/\(index).png"), in: scope) }
        XCTAssertEqual(workspace.sessions.count, 1)
        XCTAssertEqual(workspace.session(for: scope).attachments.count, 4)
        XCTAssertEqual(workspace.session(for: scope).selectedAttachment?.reference.path, "docs/5.png")
    }

    @MainActor
    func testNativeWorkspaceAndAttachmentPreviewRenderWithoutSourceMutation() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tabbed-render-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let source = try ProjectRecordFixture(root: root.appendingPathComponent("source"), name: "ScreenDeck")
        let imageFile = source.root.appendingPathComponent("docs/preview.png")
        let image = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 360,
                                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let pixels = try XCTUnwrap(image.bitmapData)
        for y in 0..<360 {
            for x in 0..<640 {
                let offset = y * image.bytesPerRow + x * 4
                let value: UInt8 = x < 320 ? 255 : 0
                pixels[offset] = value; pixels[offset + 1] = value; pixels[offset + 2] = value
                pixels[offset + 3] = 255
            }
        }
        try XCTUnwrap(image.representation(using: .png, properties: [:])).write(to: imageFile)
        try source.mutate(source.taskURL) { object in
            object["references"] = [["path": "docs/guide.md", "label": "说明"],
                                    ["path": "docs/preview.png", "label": "布局检查"]]
        }
        let sourcePaths = [source.projectURL, source.taskURL, source.runURL, source.root.appendingPathComponent("docs/guide.md"), imageFile]
        let sourceBytes = try sourcePaths.map { try Data(contentsOf: $0) }
        let local = LocalTask(title: "本地工作安排", subtasks: [Subtask(title: "人工检查界面")],
                              executionPlan: .init(version: 1, steps: [
                                PlannedStep(title: "确定目标与修改范围", executor: .human, acceptance: "人工确认范围"),
                                PlannedStep(title: "实现工作台界面", executor: .agent, acceptance: "提供可检查的界面")
                              ]))
        let store = LocalWorkspaceStore(url: root.appendingPathComponent("local/workspace.json"))
        try store.save(LocalWorkspace(tasks: [local], currentTaskID: local.id))
        let state = AppState(store: store)
        state.refresh()
        let bytes = try Data(contentsOf: store.url)
        let service = SettingsCaptureFixture()
        let memory = WorkSessionController(root: root.appendingPathComponent("sessions"), captureService: service)
        memory.load()
        let projects = ProjectWorkspaceController(store: ProjectAssociationStore(url: root.appendingPathComponent("associations.json")))
        let loaded = await projects.load()
        let associated = await projects.associate(root: source.root)
        XCTAssertTrue(loaded && associated)
        let drafts = ProjectConversationController(store: ProjectConversationStore(url: root.appendingPathComponent("drafts.json")))
        let draftsLoaded = await drafts.load()
        XCTAssertTrue(draftsLoaded)
        let navigation = WorkbenchNavigation()
        navigation.route = .project(source.projectID, taskID: "task-001")
        navigation.requestInspector(.overview)
        let workspace = TaskWorkspaceController()
        let reference = ProjectFileReference(path: "docs/guide.md", label: "说明")
        _ = try projects.referenceURL(reference, projectID: source.projectID)
        let preview = try ProjectAttachmentReader().read(reference: reference, root: source.root)
        let scope = TaskWorkspaceScope.project(source.projectID, taskID: "task-001")
        let attachment = WorkspaceAttachment(id: .init(projectID: source.projectID, taskID: "task-001", relativePath: reference.path),
                                             reference: reference, preview: preview)
        let imageReference = ProjectFileReference(path: "docs/preview.png", label: "布局检查")
        let imageAttachment = WorkspaceAttachment(id: .init(projectID: source.projectID, taskID: "task-001", relativePath: imageReference.path),
                                                  reference: imageReference,
                                                  preview: try ProjectAttachmentReader().read(reference: imageReference, root: source.root))

        for size in [CGSize(width: 1440, height: 900), CGSize(width: 800, height: 560)] {
            for mode in ["overview", "document", "return", "image", "assignment", "timeline", "delivery", "local-assignment", "new-chat"] {
                switch mode {
                case "document":
                    workspace.open(attachment, in: scope)
                case "return":
                    workspace.showTask(in: scope)
                case "image":
                    workspace.open(imageAttachment, in: scope)
                case "assignment", "timeline", "delivery":
                    workspace.showTask(in: scope)
                    let tab: TaskInspectorTab = mode == "assignment" ? .assignment : mode == "timeline" ? .timeline : .delivery
                    navigation.requestInspector(tab)
                case "local-assignment":
                    navigation.openTask(local.id)
                    navigation.requestInspector(.assignment)
                case "new-chat":
                    navigation.openNewChat()
                default:
                    navigation.route = .project(source.projectID, taskID: "task-001")
                    navigation.requestInspector(.overview)
                }
                let view = MainWorkbenchView(state: state, memory: memory, navigation: navigation,
                                             projects: projects, projectConversations: drafts, workspace: workspace)
                    .frame(width: size.width, height: size.height)
                let host = NSHostingView(rootView: view)
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
                window.appearance = NSAppearance(named: .aqua)
                window.contentView = host
                host.frame = NSRect(origin: .zero, size: size)
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(100))
                host.layoutSubtreeIfNeeded()
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                XCTAssertEqual(host.bounds.size, size)
                if mode == "image" {
                    let scaleX = CGFloat(bitmap.pixelsWide) / size.width
                    let scaleY = CGFloat(bitmap.pixelsHigh) / size.height
                    let sample = try XCTUnwrap(bitmap.colorAt(x: Int((size.width - 60) * scaleX),
                                                              y: Int(152 * scaleY))?.usingColorSpace(.deviceRGB))
                    XCTAssertLessThan(sample.redComponent, 0.1, "The static image must be visible inside both pane widths")
                    XCTAssertLessThan(sample.greenComponent, 0.1)
                    XCTAssertLessThan(sample.blueComponent, 0.1)
                }
                if let path = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"] {
                    let folder = URL(fileURLWithPath: path)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: folder.appendingPathComponent("native-tabs-\(mode)-\(Int(size.width)).png"))
                }
                window.contentView = nil
            }
        }
        XCTAssertEqual(try Data(contentsOf: store.url), bytes)
        XCTAssertEqual(try sourcePaths.map { try Data(contentsOf: $0) }, sourceBytes)
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(service.requests, 0)
        XCTAssertEqual(service.captures, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: memory.store.root.path))
    }
}
