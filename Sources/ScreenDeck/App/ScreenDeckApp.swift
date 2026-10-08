import SwiftUI
import AppKit
import Darwin

@main
struct ScreenDeckApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("ScreenDeck", systemImage: "checklist") {
            Button("打开主工作台") { appDelegate.showWorkbench() }.keyboardShortcut("0")
            Button("展开 / 收起 Deck") { appDelegate.togglePanel() }
            Button("设置…") { appDelegate.showSettings() }.keyboardShortcut(",")
            Button("停止屏幕记录") { appDelegate.stopRecording() }
            Divider()
            Button("退出 ScreenDeck") { NSApp.terminate(nil) }
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("设置…") { appDelegate.showSettings() }.keyboardShortcut(",")
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var panel: DeckPanel?
    private var state: AppState?
    private let settingsPresentation = SettingsPresentation()
    private var workbenchWindow: NSWindow?
    private var workbenchNavigation = WorkbenchNavigation()
    private var projects = ProjectWorkspaceController()
    private var projectConversations = ProjectConversationController()
    private var chat = SessionController()
    private var memory: WorkSessionController?
    private var sleepObservers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let status = ProjectHistoryCommand.run(arguments: ProcessInfo.processInfo.arguments) {
            exit(status)
        }
        // 菜单栏常驻工具，不占 Dock
        NSApp.setActivationPolicy(.accessory)

        configureWorkbench()
    }

    private func configureWorkbench() {
        let paths = ScreenDeckPaths()
        let location: ScreenDeckStorageLocation
        let migratedFiles: Set<String>
        do {
            location = try paths.activeLocation()
            migratedFiles = Set(try StorageMigration.readMarker(paths: paths)?.files.map(\.destination) ?? [])
        }
        catch { showStorageError(error); return }
        let configuration = location == .global ? ConfigurationStore(userFileURL: paths.config) : nil

        projects = ProjectWorkspaceController(store: ProjectAssociationStore(url: paths.projects(in: location),
            requireExistingFile: migratedFiles.contains("projects.json")))
        projectConversations = ProjectConversationController(store: ProjectConversationStore(url: paths.projectConversations(in: location),
            requireExistingFile: migratedFiles.contains("conversations/project-drafts.json")))
        chat = SessionController(store: SessionHistoryStore(root: paths.sessionHistory,
            previousRoots: paths.previousSessionHistoryRoots))
        let state = AppState(store: LocalWorkspaceStore(url: paths.workspace(in: location),
            requireExistingFile: migratedFiles.contains("tasks/local-workspace.json")), configurationStore: configuration)
        self.state = state
        state.refresh()
        let memory = WorkSessionController(root: paths.sessions(in: location),
                                           configurationFile: configuration?.userFileURL)
        memory.load()
        self.memory = memory
        for name in [NSWorkspace.screensDidSleepNotification, NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            sleepObservers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak memory] _ in
                Task { @MainActor in _ = memory?.pause(note: "屏幕休眠或用户会话离开，已停止采集。") }
            })
        }

        let panel = DeckPanel(state: state, memory: memory,
                              onOpenSettings: { [weak self] in self?.showSettings() },
                              onOpenWorkbench: { [weak self] id in self?.showWorkbench(taskID: id) })
        self.panel = panel
        panel.show()
        showWorkbench()
        let launchRevision = workbenchNavigation.routingRevision
        Task { @MainActor in await projectConversations.load() }
        Task { @MainActor in await chat.loadHistory() }
        Task { @MainActor in
            guard await projects.load() else { return }
            // Explicit local launch request uses the same validated association path as the picker.
            // It only opens/browses a directory; source records cannot launch execution or capture.
            let arguments = ProcessInfo.processInfo.arguments
            var explicitProjectOpened = false
            if let index = arguments.firstIndex(of: "--open-project"), arguments.indices.contains(index + 1) {
                let path = arguments[index + 1]
                if path.hasPrefix("/"), await projects.associate(root: URL(fileURLWithPath: path, isDirectory: true)),
                   let selection = projects.selection {
                    explicitProjectOpened = true
                    if let taskIndex = arguments.firstIndex(of: "--open-task"), arguments.indices.contains(taskIndex + 1) {
                        _ = projects.select(projectID: selection.projectID, taskID: arguments[taskIndex + 1])
                    }
                }
            }
            if explicitProjectOpened, let selection = projects.selection {
                workbenchNavigation.openLaunchProject(selection.projectID, taskID: selection.taskID,
                                                      expectedRevision: launchRevision)
            }
        }
    }

    func showWorkbench(taskID: UUID? = nil) {
        guard let state, let memory else { return }
        // Never conceal an unsaved Deck editor.
        guard !state.isEditingTask else { panel?.makeKeyAndOrderFront(nil); return }
        if !settingsPresentation.isPresented, let id = taskID, state.tasks.contains(where: { $0.id == id }) {
            workbenchNavigation.openTask(id)
        }
        if workbenchWindow == nil {
            let window = WorkbenchWindow()
            window.delegate = self
            window.setFrameAutosaveName("ScreenDeckMainWorkbench")
            window.contentView = NSHostingView(rootView: MainWorkbenchView(
                state: state, memory: memory, navigation: workbenchNavigation, projects: projects,
                projectConversations: projectConversations,
                chat: chat,
                onOpenSettings: { [weak self] in self?.showSettings() },
                onOpenDeck: { [weak self] id in self?.showTaskInDeck(id) })
                .ignoresSafeArea(.container, edges: .top))
            window.center()
            workbenchWindow = window
        }
        state.deckState = .collapsed
        NSApp.activate(ignoringOtherApps: true)
        if workbenchWindow?.isMiniaturized == true { workbenchWindow?.deminiaturize(nil) }
        workbenchWindow?.makeKeyAndOrderFront(nil)
        settingsPresentation.focus()
    }

    private func showTaskInDeck(_ id: UUID) {
        guard let state else { return }
        guard memory?.activeID == nil || memory?.activeSession?.taskID == id else {
            let alert = NSAlert()
            alert.messageText = "正在记录另一个任务"
            alert.informativeText = "请先停止屏幕记录，再将这个任务带到 Deck。"
            alert.addButton(withTitle: "返回工作台")
            alert.runModal()
            return
        }
        guard state.focusTaskInDeck(id) else {
            if state.isEditingTask { panel?.makeKeyAndOrderFront(nil) }
            else {
                let alert = NSAlert()
                alert.messageText = "暂时无法打开这个任务"
                alert.informativeText = state.operationError ?? "请确认任务仍然存在且尚未完成，再重试。"
                alert.addButton(withTitle: "返回工作台")
                alert.runModal()
            }
            return
        }
        panel?.makeKeyAndOrderFront(nil)
    }

    func togglePanel() {
        panel?.toggle()
    }
    func stopRecording() { _ = memory?.pause() }

    func showSettings() {
        guard let state, let memory else { return }
        guard !state.isEditingTask else {
            panel?.makeKeyAndOrderFront(nil)
            return
        }
        // A settings entry never selects a task or starts a work session.
        showWorkbench()
        guard let workbenchWindow else { return }
        settingsPresentation.present(attachedTo: workbenchWindow, state: state, memory: memory,
                                     section: state.requestedSettingsSection, projects: projects,
                                     onMigrateStorage: { [weak self] in self?.migrateStorage() })
    }

    /// The main actor serializes the explicit migration with UI writes. Old windows/controllers
    /// are retired before a new store is used; there is no dual-write or capture restoration.
    private func migrateStorage() {
        guard let state, let memory,
              state.dataAvailable, memory.loaded, memory.preferencesLoaded,
              !state.isEditingTask, !state.hasUnsavedConversationDrafts,
              !projectConversations.hasUnsavedDrafts, projectConversations.isLoaded,
              !chat.hasActiveTurn, !chat.hasPendingWrites,
              !projects.isLoading, memory.activeID == nil, !memory.capturing,
              settingsPresentation.draft?.isDirty != true else {
            let alert = NSAlert(); alert.messageText = "暂时不能迁移"
            alert.informativeText = "请先停止屏幕记录，保存草稿和设置，并等待项目读取完成。"
            alert.runModal(); return
        }
        do {
            let paths = ScreenDeckPaths()
            let migration = StorageMigration(paths: paths)
            let plan = try migration.inspect()
            guard plan.isNeeded else { return }
            let alert = NSAlert()
            alert.messageText = "整理本机数据到 ~/.screendeck？"
            alert.informativeText = "将复制并校验 \(plan.fileCount) 个文件（\(ByteCountFormatter.string(fromByteCount: Int64(plan.byteCount), countStyle: .file))）。\n\n旧位置保留为备份：\(plan.legacyRoot.path)\n\n完成后刷新工作台；不搬动项目内的任务记录和附件，也不会开始执行或录屏。"
            alert.addButton(withTitle: "迁移并刷新工作台"); alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            // A modal alert runs a nested event loop; recheck before touching files.
            guard !state.isEditingTask, !state.hasUnsavedConversationDrafts,
                  !chat.hasActiveTurn, !chat.hasPendingWrites,
                  !projectConversations.hasUnsavedDrafts, !projects.isLoading,
                  memory.activeID == nil, !memory.capturing,
                  settingsPresentation.draft?.isDirty != true else { return }
            _ = try migration.migrate { preferences, stagedURL in
                let pinned = try LocalWorkspaceStore(url: paths.workspace(in: .legacy)).load().defaultPinned
                let value = UserConfiguration(capturePreferences: preferences ?? CapturePreferences(), defaultPinned: pinned)
                _ = try ConfigurationStore(userFileURL: stagedURL).saveUser(value, expectedDigest: nil)
            }
            _ = settingsPresentation.dismiss(returnFocus: false)
            workbenchWindow?.delegate = nil
            workbenchWindow?.contentView = nil
            workbenchWindow?.close(); workbenchWindow = nil
            panel?.orderOut(nil); panel?.contentView = nil; panel = nil
            for observer in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
            sleepObservers.removeAll()
            workbenchNavigation = WorkbenchNavigation()
            projects = ProjectWorkspaceController()
            projectConversations = ProjectConversationController()
            chat.shutdown()
            self.state = nil; self.memory = nil
            configureWorkbench()
        } catch { showStorageError(error) }
    }

    private func showStorageError(_ error: Error) {
        let alert = NSAlert(); alert.messageText = "存储整理未完成"
        alert.informativeText = "\(error.localizedDescription)\n旧数据未删除。请检查目录与配置后重试。"
        alert.addButton(withTitle: "返回"); alert.runModal()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard sender === workbenchWindow else { return true }
        return settingsPresentation.dismiss(returnFocus: false)
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        (window as? WorkbenchWindow)?.finishFullScreenTransition()
    }

    func windowDidFailToExitFullScreen(_ window: NSWindow) {
        (window as? WorkbenchWindow)?.finishFullScreenTransition()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard settingsPresentation.confirmUnsavedChanges() else { return .terminateCancel }
        if chat.hasPendingWrites {
            let alert = NSAlert()
            alert.messageText = "回复尚未保存"
            alert.informativeText = "请返回工作台重试保存回复，再退出。不会自动重发消息或丢弃内存中的回复。"
            alert.addButton(withTitle: "返回工作台"); alert.runModal(); showWorkbench()
            return .terminateCancel
        }
        if chat.hasActiveTurn {
            let alert = NSAlert()
            alert.messageText = "回复还未结束"
            alert.informativeText = "退出不会证明服务已经停止。已保存的会话下次需手动核对，不会自动重发；要停止回复，请先在工作台点击停止。"
            alert.addButton(withTitle: "继续等待"); alert.addButton(withTitle: "保留记录并退出")
            guard alert.runModal() == .alertSecondButtonReturn, !chat.hasPendingWrites else { return .terminateCancel }
        }
        var discardConversationDrafts = false
        var discardProjectDrafts = false
        if let state, state.hasUnsavedConversationDrafts, !retryLocalConversationDrafts() {
            let alert = NSAlert()
            alert.messageText = "聊天草稿尚未保存"
            alert.informativeText = "重试保存仍未成功。继续编辑会保留输入；放弃并退出将丢弃未保存的草稿。"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "放弃并退出")
            guard alert.runModal() == .alertSecondButtonReturn else {
                showWorkbench()
                return .terminateCancel
            }
            discardConversationDrafts = true
        }
        if projectConversations.hasUnsavedDrafts, !projectConversations.retryDrafts() {
            let alert = NSAlert()
            alert.messageText = "项目对话草稿尚未保存"
            alert.informativeText = "继续编辑会保留输入；放弃并退出将丢弃未保存的项目草稿。"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "放弃并退出")
            guard alert.runModal() == .alertSecondButtonReturn else {
                showWorkbench()
                return .terminateCancel
            }
            discardProjectDrafts = true
        }
        if state?.isEditingTask == true {
            let alert = NSAlert()
            alert.messageText = "任务修改尚未保存"
            alert.informativeText = "返回面板保存，或放弃修改并退出。"
            alert.addButton(withTitle: "继续编辑")
            alert.addButton(withTitle: "放弃并退出")
            guard alert.runModal() == .alertSecondButtonReturn else { return .terminateCancel }
        }
        if discardConversationDrafts { state?.discardUnsavedConversationDrafts() }
        if discardProjectDrafts { projectConversations.discardUnsavedDrafts() }
        guard !chat.hasPendingWrites else { return .terminateCancel }
        chat.shutdown()
        _ = memory?.pause()
        return .terminateNow
    }

    /// A later quit confirmation can cancel termination, so keep newly saved input visible.
    private func retryLocalConversationDrafts() -> Bool {
        guard let state else { return true }
        let creating = workbenchNavigation.route == .newChat && state.isConversationDraftUnsaved(.newChat)
        let saved = state.retryConversationDrafts()
        if saved, creating, let id = state.conversations.last?.id { workbenchNavigation.route = .chat(id) }
        return saved
    }
}
