import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

final class MainWorkbenchTests: XCTestCase {
    private func store() -> LocalWorkspaceStore {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return LocalWorkspaceStore(url: root.appendingPathComponent("workspace.json"))
    }

    func testOldWorkspaceDecodesWithoutDrafts() throws {
        let old = Data("{\"schemaVersion\":1,\"tasks\":[],\"defaultPinned\":false}".utf8)
        let workspace = try JSONDecoder().decode(LocalWorkspace.self, from: old)
        try workspace.validate()
        XCTAssertNil(workspace.conversations)
    }

    @MainActor func testDraftsPersistAndRemainSeparate() async throws {
        let store = store()
        let state = AppState(store: store); state.refresh()
        XCTAssertTrue(state.createTask(title: "主工作台"))
        let id = try XCTUnwrap(state.currentTaskID)
        let chatID = try XCTUnwrap(state.createConversation())
        XCTAssertTrue(state.saveConversationDraft(route: .task(id), text: "任务要求"))
        XCTAssertTrue(state.saveConversationDraft(route: .chat(chatID), text: "普通讨论"))
        XCTAssertFalse(state.saveConversationDraft(route: .tasks, text: "不能写"))
        let restored = AppState(store: store); restored.refresh()
        XCTAssertEqual(restored.tasks.first?.conversationDraft, "任务要求")
        XCTAssertEqual(restored.conversations.first?.draft, "普通讨论")
        XCTAssertEqual(restored.tasks.count, 1)
    }

    @MainActor func testBrowsingDoesNotChangeFocusAndExplicitDeckRequestDoes() async throws {
        let state = AppState(store: store()); state.refresh()
        state.createTask(title: "A"); state.createTask(title: "B")
        let firstID = try XCTUnwrap(state.currentTaskID)
        let secondID = state.tasks[1].id
        let navigation = WorkbenchNavigation()
        XCTAssertTrue(navigation.sidebarVisible)
        navigation.sidebarVisible = false
        navigation.openTask(secondID)
        XCTAssertFalse(navigation.sidebarVisible, "Task navigation must not forcibly reopen the sidebar")
        XCTAssertEqual(state.currentTaskID, firstID)
        XCTAssertTrue(state.focusTaskInDeck(secondID))
        XCTAssertEqual(state.currentTaskID, secondID)
        XCTAssertEqual(state.deckTaskRequest?.taskID, secondID)
        XCTAssertEqual(state.deckState, .expanded)
        let request = state.deckTaskRequest
        XCTAssertTrue(state.focusTaskInDeck(secondID))
        XCTAssertNotEqual(state.deckTaskRequest, request, "Repeated opening must navigate again")
        state.setEditingTask(true)
        XCTAssertFalse(state.focusTaskInDeck(firstID))
        XCTAssertEqual(state.currentTaskID, secondID)
        state.setEditingTask(false)
        state.toggle(state.tasks[0])
        XCTAssertFalse(state.focusTaskInDeck(firstID))
    }

    @MainActor func testFailedWritesDoNotPublishNavigationOrChats() async {
        let state = AppState(store: WorkbenchFailingStore()); state.refresh()
        XCTAssertNil(state.createConversation())
        XCTAssertFalse(state.focusTaskInDeck(state.tasks[0].id))
        XCTAssertFalse(state.saveConversationDraft(route: .task(state.tasks[0].id), text: "unsaved"))
        XCTAssertNil(state.deckTaskRequest)
        XCTAssertNil(state.currentTaskID)
        XCTAssertTrue(state.conversations.isEmpty)
        XCTAssertNil(state.tasks[0].conversationDraft)
        XCTAssertNotNil(state.operationError)
    }

    @MainActor func testMainWorkbenchRendersAtSupportedSizesWithoutCapture() async throws {
        _ = NSApplication.shared
        let store = store()
        let state = AppState(store: store); state.refresh()
        state.createTask(title: "开发主工作台")
        let id = try XCTUnwrap(state.currentTaskID)
        state.addSubtask(taskID: id, title: "检查主窗口与 Deck 的任务联动")
        state.addSubtask(taskID: id, title: "确认主工作台布局")
        state.addSubtask(taskID: id, title: "实现任务进度与执行清单")
        state.addSubtask(taskID: id, title: "体验并验收")
        for child in state.currentTask?.subtasks?.prefix(2) ?? [] {
            state.toggleSubtask(taskID: id, subtaskID: child.id)
        }
        state.saveResume(taskID: id, content: ResumeContent(progress: "已确认黑白三栏布局，主窗口承载长内容。", nextStep: "验证窗口之间的跳转与草稿恢复。"), requestID: UUID())
        let capture = SettingsCaptureFixture()
        let memory = WorkSessionController(root: store.url.deletingLastPathComponent().appendingPathComponent("sessions"), captureService: capture)
        memory.load()
        let navigation = WorkbenchNavigation(); navigation.openTask(id)
        for size in [CGSize(width: 800, height: 560), CGSize(width: 1100, height: 760), CGSize(width: 1440, height: 900)] {
            let view = MainWorkbenchView(state: state, memory: memory, navigation: navigation).frame(width: size.width, height: size.height)
            let host = NSHostingView(rootView: view)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(80))
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            XCTAssertGreaterThan(bitmap.pixelsWide, 0)
            if let output = ProcessInfo.processInfo.environment["SCREENDECK_REVIEW_OUTPUT"] {
                let folder = URL(fileURLWithPath: output)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: folder.appendingPathComponent("main-workbench-\(Int(size.width)).png"))
            }
        }
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(capture.requests, 0)
        XCTAssertEqual(capture.captures, 0)
    }

    @MainActor func testAllWorkbenchRoutesRenderWithSidebarCollapsed() async throws {
        _ = NSApplication.shared
        let store = store()
        let state = AppState(store: store); state.refresh()
        state.createTask(title: String(repeating: "长任务标题", count: 12))
        let taskID = try XCTUnwrap(state.currentTaskID)
        let chatID = try XCTUnwrap(state.createConversation())
        state.saveConversationDraft(route: .chat(chatID), text: "仅为本地草稿，不应触发执行")
        let capture = SettingsCaptureFixture()
        let memory = WorkSessionController(root: store.url.deletingLastPathComponent().appendingPathComponent("sessions"), captureService: capture)
        memory.load()
        let navigation = WorkbenchNavigation(); navigation.sidebarVisible = false
        for route in [WorkbenchRoute.tasks, .search, .timeline, .chat(chatID), .task(taskID)] {
            navigation.route = route
            let host = NSHostingView(rootView: MainWorkbenchView(state: state, memory: memory, navigation: navigation).frame(width: 800, height: 560))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 560), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: 800, height: 560)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        }
        XCTAssertFalse(navigation.sidebarVisible)
        XCTAssertNil(memory.activeID)
        XCTAssertEqual(capture.requests, 0)
        XCTAssertEqual(capture.captures, 0)
        XCTAssertEqual(state.conversationDraft(for: .chat(chatID)), "仅为本地草稿，不应触发执行")
    }
}

private struct WorkbenchFailingStore: WorkspaceStore {
    var url = URL(fileURLWithPath: "/unused-workbench-fixture.json")
    func load() throws -> LocalWorkspace { LocalWorkspace(tasks: [LocalTask(title: "test")]) }
    func save(_ workspace: LocalWorkspace) throws { throw CocoaError(.fileWriteNoPermission) }
}
