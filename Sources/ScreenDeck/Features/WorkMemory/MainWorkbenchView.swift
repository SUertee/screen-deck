// finesse · register=product · shell=three-column · palette=monochrome
// Native SwiftUI translation of the approved concept. No simulated agent output.
import SwiftUI
import AppKit

enum WorkbenchStyle {
    static let ink = DeckTheme.color(DeckTheme.light.text)
    static let muted = DeckTheme.color(DeckTheme.light.secondary)
    static let surface = DeckTheme.color(DeckTheme.light.surface)
    static let rail = DeckTheme.color(DeckTheme.light.background)
    static let inset = DeckTheme.color(DeckTheme.light.selection)
    static let line = Color.primary.opacity(0.09)
}

@MainActor
struct MainWorkbenchView: View {
    @ObservedObject var state: AppState
    @ObservedObject var memory: WorkSessionController
    @ObservedObject var navigation: WorkbenchNavigation
    @ObservedObject var projects = ProjectWorkspaceController()
    @ObservedObject var projectConversations = ProjectConversationController()
    @ObservedObject var workspace = TaskWorkspaceController()
    var onOpenSettings: () -> Void = {}
    var onOpenDeck: (UUID) -> Void = { _ in }
    @State private var query = ""
    @State private var newTitle = ""
    @State private var addingTask = false
    @State private var childDrafts: [UUID: String] = [:]
    @State private var showingConnection = false
    @State private var showingAddMenu = false
    @State private var renameDrafts: [UUID: String] = [:]
    @State private var tasksExpanded = true
    @State private var chatsExpanded = true
    @State private var expandedProjects: Set<String> = []
    @State private var referenceError: String?
    @State private var loadingAttachment: WorkspaceAttachmentID?
    @FocusState private var draftFocused: Bool

    private var selectedTask: LocalTask? {
        guard case .task(let id) = navigation.route else { return nil }
        return state.tasks.first { $0.id == id }
    }
    private var selectedChat: LocalConversation? {
        guard case .chat(let id) = navigation.route else { return nil }
        return state.conversations.first { $0.id == id }
    }
    private var projectID: String? {
        if case .project(let id, _) = navigation.route { return id }
        return nil
    }
    private var projectSnapshot: ProjectRecordSnapshot? {
        projectID.flatMap { projects.snapshots[$0] }
    }
    private var projectTask: ProjectTaskRecord? {
        guard case .project(_, let taskID) = navigation.route else { return nil }
        return projectSnapshot?.tasks.first { $0.taskID == taskID }
    }
    private var hasInspector: Bool { selectedTask != nil || projectID != nil }
    private var workspaceScope: TaskWorkspaceScope? {
        if let task = selectedTask { return .local(task.id) }
        if case .project(let id, let taskID) = navigation.route { return .project(id, taskID: taskID) }
        return nil
    }
    private var workspaceSession: TaskWorkspaceSession {
        workspaceScope.map { workspace.session(for: $0) } ?? TaskWorkspaceSession()
    }
    private var workspaceReferences: [ProjectFileReference] {
        guard let snapshot = projectSnapshot else { return [] }
        if let task = projectTask {
            return ProjectRecordPresentation.references(task.references +
                snapshot.runs.filter { $0.taskID == task.taskID }.flatMap(\.references))
        }
        return ProjectRecordPresentation.references(snapshot.project.references)
    }
    private var draft: Binding<String> {
        Binding(get: {
            if case .project(let id, let taskID) = navigation.route {
                return projectConversations.draft(projectID: id, taskID: taskID)
            }
            return state.conversationDraft(for: navigation.route)
        }, set: { text in
            switch navigation.route {
            case .newChat:
                if let id = state.startConversationDraft(text: text) { navigation.route = .chat(id) }
            case .project(let id, let taskID):
                _ = projectConversations.saveDraft(projectID: id, taskID: taskID, text: text)
            default: _ = state.saveConversationDraft(route: navigation.route, text: text)
            }
        })
    }
    private var heading: String {
        if let task = selectedTask { return task.title }
        if let chat = selectedChat { return chat.title }
        if let task = projectTask { return task.title }
        if let id = projectID { return projects.associations.first { $0.projectID == id }?.name ?? "项目" }
        switch navigation.route {
        case .newChat, .chat: return "新聊天"
        case .search: return "搜索"
        case .timeline: return "时间线"
        default: return "任务"
        }
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    if navigation.sidebarVisible {
                        sidebar.frame(width: geometry.size.width < 1050 ? 240 : 260)
                        Divider()
                    }
                    VStack(spacing: 0) {
                        header(width: geometry.size.width)
                        Divider()
                        if !state.dataAvailable && projectID == nil {
                            empty("任务暂时无法读取", detail: state.statusMessage, icon: "exclamationmark.triangle")
                            Button("重新读取") { state.refresh() }.padding()
                        } else {
                            center
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                        .disabled(hasInspector && navigation.showsInspector(at: geometry.size.width) && geometry.size.width < 1080)
                        .accessibilityHidden(hasInspector && navigation.showsInspector(at: geometry.size.width) && geometry.size.width < 1080)
                    if hasInspector, navigation.showsInspector(at: geometry.size.width), geometry.size.width >= 1080 {
                        Divider()
                        activeInspector.frame(width: min(580, max(390, geometry.size.width * 0.38)))
                    }
                }
                .overlay(alignment: .trailing) {
                    if hasInspector, navigation.showsInspector(at: geometry.size.width), geometry.size.width < 1080 {
                        activeInspector.frame(width: 340)
                            .background(WorkbenchStyle.surface)
                            .overlay(alignment: .leading) { Rectangle().fill(WorkbenchStyle.line).frame(width: 1) }
                            .shadow(color: .black.opacity(0.08), radius: 12, x: -4)
                    }
                }
                // Keep capture controls visible outside the narrow inspector overlay,
                // without shifting the native window buttons out of their top row.
                if let session = memory.activeSession { recordingStatus(taskID: session.taskID) }
                if let error = state.operationError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                if let error = memory.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                if let error = projects.error {
                    HStack {
                        Label(error, systemImage: "exclamationmark.triangle")
                        Spacer(minLength: 8)
                        if !projects.associationsLoaded {
                            Button("重试读取关联") { Task { _ = await projects.load() } }.disabled(projects.isLoading)
                        }
                    }.font(.caption).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(WorkbenchStyle.surface)
        .foregroundStyle(WorkbenchStyle.ink)
        .tint(WorkbenchStyle.ink)
        .environment(\.colorScheme, .light)
        .font(.system(size: 14))
        .alert("新建任务", isPresented: $addingTask) {
            TextField("任务名称", text: $newTitle)
            Button("取消", role: .cancel) { newTitle = "" }
            Button("创建") {
                if state.createTask(title: newTitle), let task = state.tasks.last {
                    navigation.openTask(task.id); newTitle = ""
                }
            }.disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: { Text("只创建本地任务，不会启动 AI 或屏幕记录。") }
        .alert("资料暂时无法打开", isPresented: Binding(get: { referenceError != nil }, set: { if !$0 { referenceError = nil } })) {
            Button("好", role: .cancel) { referenceError = nil }
        } message: { Text(referenceError ?? "") }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Color.clear.frame(width: WorkbenchWindowChrome.trafficLightReservedWidth)
                    .accessibilityHidden(true)
                Text("ScreenDeck").font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Button { navigation.sidebarVisible = false } label: {
                    ScreenDeckMark().frame(width: 30, height: 30)
                        .background(WorkbenchStyle.ink.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))
                }.buttonStyle(.plain).help("收起侧栏").accessibilityLabel("收起侧栏")
                    .keyboardShortcut("s", modifiers: [.command, .control])
            }.padding(.trailing, 12).frame(height: WorkbenchWindowChrome.headerHeight)
                .background(WorkbenchStyle.rail)
                .background { WorkbenchWindowDragRegion() }
            Divider()
            VStack(spacing: 2) {
                navButton("新建聊天", icon: "plus", selected: navigation.route == .newChat || selectedChat != nil) {
                    navigation.openNewChat()
                }.disabled(!state.dataAvailable).keyboardShortcut("n")
                navButton("搜索", icon: "magnifyingglass", selected: navigation.route == .search) { navigation.route = .search }
                    .keyboardShortcut("k")
                navButton("任务", icon: "checklist", selected: navigation.route == .tasks) { navigation.route = .tasks }
                navButton("时间线", icon: "clock", selected: navigation.route == .timeline) { navigation.route = .timeline }
            }.padding(.horizontal, 12).padding(.top, 20)
            Color.clear.frame(height: 28).accessibilityHidden(true)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("项目"); Spacer()
                        Button(action: chooseProjectFolder) { Image(systemName: "plus") }
                            .buttonStyle(.plain).help("打开项目文件夹").accessibilityLabel("打开项目文件夹")
                            .disabled(projects.isLoading)
                    }.font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.horizontal, 12)
                    ForEach(projects.associations, id: \.projectID) { association in
                        projectSidebar(association)
                    }
                    if projects.associations.isEmpty {
                        Button("打开项目文件夹…", action: chooseProjectFolder)
                            .buttonStyle(.plain).font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(12)
                            .disabled(projects.isLoading)
                    }
                    Color.clear.frame(height: 20).accessibilityHidden(true)
                    HStack {
                        Button { tasksExpanded.toggle() } label: {
                            HStack { Text("本地任务"); Spacer(); Image(systemName: tasksExpanded ? "chevron.up" : "chevron.down") }
                        }.buttonStyle(.plain).accessibilityLabel(tasksExpanded ? "收起本地任务" : "展开本地任务")
                        Spacer()
                        Button { addingTask = true } label: { Image(systemName: "plus") }
                            .buttonStyle(.plain).help("新建任务").accessibilityLabel("新建本地任务")
                            .disabled(!state.dataAvailable || state.isEditingTask)
                    }.font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.horizontal, 12)
                    if tasksExpanded {
                        ForEach(state.tasks) { task in
                            navButton(task.title, icon: task.completed ? "checkmark.circle" : "bubble.left",
                                      selected: navigation.route == .task(task.id)) { navigation.openTask(task.id) }
                        }
                        if state.tasks.isEmpty { Text("暂无任务，点 + 创建").font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(12) }
                    }
                    Color.clear.frame(height: 29).accessibilityHidden(true)
                    Button { chatsExpanded.toggle() } label: {
                        HStack { Text("最近聊天"); Spacer(); Image(systemName: chatsExpanded ? "chevron.up" : "chevron.down") }
                    }.buttonStyle(.plain).font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.horizontal, 12)
                    if chatsExpanded {
                        ForEach(state.conversations.reversed()) { chat in
                            navButton(chat.draft.isEmpty ? chat.title : String(chat.draft.prefix(20)), icon: "bubble.left",
                                      selected: navigation.route == .chat(chat.id)) { navigation.route = .chat(chat.id) }
                        }
                        if state.conversations.isEmpty { Text("从新建聊天记录想法").font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(12) }
                    }
                }.padding(.horizontal, 12)
            }
            navButton("设置", icon: "gearshape", action: onOpenSettings).padding(12)
        }.background(WorkbenchStyle.rail)
    }

    private func navButton(_ title: String, icon: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 18)
                Text(title).lineLimit(1)
                Spacer(minLength: 0)
            }.padding(.horizontal, 12).frame(height: 38)
                .background(selected ? WorkbenchStyle.ink.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).help(title)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private func projectSidebar(_ association: ProjectAssociation) -> some View {
        HStack(spacing: 0) {
            Button {
                if expandedProjects.contains(association.projectID) { expandedProjects.remove(association.projectID) }
                else { expandedProjects.insert(association.projectID) }
            } label: {
                Image(systemName: expandedProjects.contains(association.projectID) ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9)).frame(width: 20, height: 32)
            }.buttonStyle(.plain).accessibilityLabel("展开或收起 \(association.name)")
            navButton(association.name, icon: "folder", selected: navigation.route == .project(association.projectID, taskID: nil)) {
                openProject(association.projectID)
            }
        }.onAppear { expandedProjects.insert(association.projectID) }
        if expandedProjects.contains(association.projectID) {
            ForEach(projects.snapshots[association.projectID]?.tasks ?? [], id: \.taskID) { task in
                navButton(task.title, icon: "checklist", selected: navigation.route == .project(association.projectID, taskID: task.taskID)) {
                    openProject(association.projectID, taskID: task.taskID)
                }.padding(.leading, 18)
            }
            if projects.diagnostics[association.projectID] != nil {
                Label(projects.staleProjectIDs.contains(association.projectID) ? "记录已失效" : "来源不可用", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.horizontal, 14)
            }
        }
    }

    private func openProject(_ id: String, taskID: String? = nil) {
        guard projects.select(projectID: id, taskID: taskID) else { return }
        expandedProjects.insert(id)
        navigation.route = .project(id, taskID: taskID)
        navigation.inspectorVisible = true
        navigation.inspectorRequestedOnNarrow = false
        navigation.inspectorTab = .overview
    }

    private func chooseProjectFolder() { chooseProjectFolder(relink: nil) }

    private func chooseProjectFolder(relink id: String?) {
        let panel = NSOpenPanel()
        panel.title = id == nil ? "打开 ScreenDeck 项目" : "重新关联项目文件夹"
        panel.message = "打开已有项目，或在确认后初始化项目身份。不启动任务。"
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false; panel.canCreateDirectories = false
        guard let window = NSApp.keyWindow else { return }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let root = panel.url else { return }
            Task { @MainActor in
                let success: Bool
                if let id { success = await projects.relink(projectID: id, root: root) }
                else {
                    let identity = root.appendingPathComponent(".screendeck/project.json")
                    var attributes = stat()
                    if lstat(identity.path, &attributes) != 0, errno == ENOENT {
                        let confirmation = NSAlert()
                        confirmation.messageText = "初始化这个项目？"
                        confirmation.informativeText = "只创建 .screendeck/project.json 项目身份；不创建任务、执行命令或记录屏幕。"
                        confirmation.addButton(withTitle: "初始化并打开")
                        confirmation.addButton(withTitle: "取消")
                        guard confirmation.runModal() == .alertFirstButtonReturn else { return }
                        do { _ = try ProjectIdentityStore().initialize(root: root, name: root.lastPathComponent) }
                        catch {
                            let alert = NSAlert(); alert.messageText = "项目未初始化"
                            alert.informativeText = error.localizedDescription; alert.runModal(); return
                        }
                    }
                    success = await projects.associate(root: root)
                }
                if success, let selection = projects.selection {
                    expandedProjects.insert(selection.projectID)
                    navigation.route = .project(selection.projectID, taskID: selection.taskID)
                    navigation.inspectorVisible = true
                    navigation.inspectorRequestedOnNarrow = false
                    navigation.inspectorTab = .overview
                }
            }
        }
    }

    private func openReference(_ reference: ProjectFileReference, projectID: String, taskID requestedTaskID: String? = nil) {
        let previewExtensions = Set(["md", "txt", "json", "png", "jpg", "jpeg", "gif", "webp"])
        guard previewExtensions.contains(URL(fileURLWithPath: reference.path).pathExtension.lowercased()) else {
            openExternalReference(reference, projectID: projectID)
            return
        }
        guard loadingAttachment == nil else { return }
        do {
            _ = try projects.referenceURL(reference, projectID: projectID)
            guard let snapshot = projects.snapshots[projectID] else { return }
            if self.projectID != projectID || (requestedTaskID != nil && projectTask?.taskID != requestedTaskID) {
                openProject(projectID, taskID: requestedTaskID)
                guard self.projectID == projectID,
                      requestedTaskID == nil || projectTask?.taskID == requestedTaskID else { return }
            }
            let taskID = projectTask?.taskID
            guard projects.hasReference(reference, projectID: projectID, taskID: taskID) else {
                throw ProjectRecordReadError(path: reference.path, reason: "当前任务未登记这份附件，请刷新任务")
            }
            let scope = TaskWorkspaceScope.project(projectID, taskID: taskID)
            let id = WorkspaceAttachmentID(projectID: projectID, taskID: taskID, relativePath: reference.path)
            let root = snapshot.rootURL
            loadingAttachment = id
            navigation.requestInspector(navigation.inspectorTab)
            Task { @MainActor in
                defer { if loadingAttachment == id { loadingAttachment = nil } }
                do {
                    let preview = try await Task.detached(priority: .userInitiated) {
                        try ProjectAttachmentReader().read(reference: reference, root: root)
                    }.value
                    // A refresh/relink may have happened while reading. Do not publish into a new source.
                    let currentURL = try projects.referenceURL(reference, projectID: projectID)
                    guard currentURL.standardizedFileURL == preview.sourceURL.standardizedFileURL,
                          projects.hasReference(reference, projectID: projectID, taskID: taskID) else {
                        throw ProjectRecordReadError(path: reference.path, reason: "任务或附件来源已变化，请重新打开附件")
                    }
                    workspace.open(WorkspaceAttachment(id: id, reference: reference, preview: preview), in: scope)
                } catch {
                    if workspaceScope == scope { referenceError = error.localizedDescription }
                }
            }
        } catch { referenceError = error.localizedDescription }
    }

    private func openExternalReference(_ reference: ProjectFileReference, projectID: String) {
        do {
            let url = try projects.referenceURL(reference, projectID: projectID)
            guard ProjectRecordPresentation.supportsOpening(url) else {
                referenceError = "这种文件暂不支持打开：\(reference.path)。不会执行脚本或应用。"
                return
            }
            guard NSWorkspace.shared.open(url) else {
                referenceError = "没有可打开这份资料的应用：\(reference.path)"
                return
            }
        } catch { referenceError = error.localizedDescription }
    }

    @ViewBuilder private var activeInspector: some View {
        if let scope = workspaceScope {
            VStack(spacing: 0) {
                TaskWorkspaceTabsView(session: workspaceSession,
                                      taskLabel: projectID != nil && projectTask == nil ? "项目详情" : "任务详情",
                                      references: workspaceReferences,
                                      isLoading: loadingAttachment?.projectID == projectID && loadingAttachment != nil,
                                      onTask: { workspace.showTask(in: scope) },
                                      onSelect: { workspace.select($0, in: scope) },
                                      onCloseFile: { workspace.close($0, in: scope) },
                                      onReference: { if let id = projectID { openReference($0, projectID: id) } },
                                      onClosePane: { navigation.inspectorVisible = false })
                Divider()
                ZStack {
                    activeTaskInspector
                        .opacity(workspaceSession.selectedAttachment == nil ? 1 : 0)
                        .allowsHitTesting(workspaceSession.selectedAttachment == nil)
                        .accessibilityHidden(workspaceSession.selectedAttachment != nil)
                    if let attachment = workspaceSession.selectedAttachment {
                        WorkspaceAttachmentPreviewView(attachment: attachment, stale: isPreviewStale(attachment),
                                                       onReload: {
                                                           guard !isPreviewStale(attachment) else { return }
                                                           openReference(attachment.reference, projectID: attachment.id.projectID,
                                                                         taskID: attachment.id.taskID)
                                                       },
                                                       onOpenExternal: {
                                                           guard !isPreviewStale(attachment) else { return }
                                                           openExternalReference(attachment.reference, projectID: attachment.id.projectID)
                                                       },
                                                       onTask: { workspace.showTask(in: scope) })
                            .id(attachment.id)
                    }
                }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
            }.background(WorkbenchStyle.surface)
        }
    }

    private func isPreviewStale(_ attachment: WorkspaceAttachment) -> Bool {
        let id = attachment.id.projectID
        guard !projects.staleProjectIDs.contains(id), let snapshot = projects.snapshots[id] else { return true }
        guard projects.hasReference(attachment.reference, projectID: id, taskID: attachment.id.taskID) else { return true }
        return snapshot.rootURL.appendingPathComponent(attachment.reference.path).standardizedFileURL
            != attachment.preview.sourceURL.standardizedFileURL
    }

    @ViewBuilder private var activeTaskInspector: some View {
        if let task = selectedTask { inspector(task) }
        else if let snapshot = projectSnapshot, let task = projectTask {
            ProjectTaskInspectorView(snapshot: snapshot, task: task, tab: $navigation.inspectorTab,
                                     stale: projects.staleProjectIDs.contains(snapshot.project.projectID),
                                     diagnostic: projects.diagnostics[snapshot.project.projectID],
                                     isLoading: projects.isLoading,
                                     onRefresh: { Task { _ = await projects.refresh(projectID: snapshot.project.projectID) } },
                                     onRelink: { chooseProjectFolder(relink: snapshot.project.projectID) },
                                     onClose: { navigation.inspectorVisible = false },
                                     onReference: { openReference($0, projectID: snapshot.project.projectID) },
                                     showsWorkspaceHeader: false)
        } else if let id = projectID {
            VStack(spacing: 0) {
                ProjectRecordContentView(snapshot: projectSnapshot,
                                         taskID: { if case .project(_, let taskID) = navigation.route { return taskID }; return nil }(),
                                         diagnostic: projects.diagnostics[id], stale: projects.staleProjectIDs.contains(id),
                                         isLoading: projects.isLoading,
                                         onRefresh: { Task { _ = await projects.refresh(projectID: id) } },
                                         onRelink: { chooseProjectFolder(relink: id) },
                                         onSelect: { openProject(id, taskID: $0) },
                                         onDetails: { navigation.requestInspector(.timeline) },
                                         onReference: { openReference($0, projectID: id) })
            }
        }
    }

    private func header(width: CGFloat) -> some View {
        HStack(spacing: 12) {
            if !navigation.sidebarVisible {
                Color.clear.frame(width: WorkbenchWindowChrome.trafficLightReservedWidth - 20)
                Button { navigation.sidebarVisible = true } label: { ScreenDeckMark().frame(width: 30, height: 30) }
                    .help("展开侧栏").accessibilityLabel("展开侧栏")
                    .keyboardShortcut("s", modifiers: [.command, .control])
            }
            Image(systemName: projectID != nil ? "folder" : selectedTask == nil ? "bubble.left" : "folder")
            Text(heading).font(.system(size: 17, weight: .semibold)).lineLimit(1)
            Spacer()
            if let task = selectedTask {
                Menu {
                    Button("在 Deck 中继续") { onOpenDeck(task.id) }.disabled(!canOpenDeck(task))
                    Button("查看任务分工") { navigation.requestInspector(.assignment) }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 28) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("任务操作")
                Button { navigation.toggleInspector(at: width) } label: { Image(systemName: "sidebar.right") }
                    .help("展开或收起任务详情").accessibilityLabel("切换任务详情")
            }
            if let id = projectID {
                Button { Task { _ = await projects.refresh(projectID: id) } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 24, height: 28)
                }.disabled(projects.isLoading).help("重新读取项目记录").accessibilityLabel("重新读取项目记录")
                Menu {
                    Button("重新关联文件夹…") { chooseProjectFolder(relink: id) }
                    Button("在访达显示文件夹") {
                        if let path = projects.associations.first(where: { $0.projectID == id })?.rootPath {
                            NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
                        }
                    }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 28) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                if projectID != nil {
                    Button { navigation.toggleInspector(at: width) } label: { Image(systemName: "sidebar.right") }
                        .help("展开或收起任务详情").accessibilityLabel("切换任务详情")
                }
            }
        }.buttonStyle(.borderless).padding(.horizontal, 20).frame(height: WorkbenchWindowChrome.headerHeight)
            .background(WorkbenchStyle.rail)
            .background { WorkbenchWindowDragRegion() }
    }

    private func canOpenDeck(_ task: LocalTask) -> Bool {
        !state.isEditingTask && !task.completed && (memory.activeID == nil || memory.activeSession?.taskID == task.id)
    }

    private func recordingStatus(taskID: UUID) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "record.circle")
            Text("正在记录 · \(state.tasks.first(where: { $0.id == taskID })?.title ?? "当前任务")")
                .lineLimit(1)
            Spacer(minLength: 4)
            Button("回到 Deck") { onOpenDeck(taskID) }.disabled(state.isEditingTask)
            Button("停止记录") { _ = memory.pause() }.fontWeight(.semibold)
        }.font(.system(size: 12)).buttonStyle(.borderless)
            .padding(.horizontal, 20).padding(.vertical, 10).background(WorkbenchStyle.inset)
            .help("切换窗口不会停止记录；点击停止后不再采集新的屏幕内容")
    }

    @ViewBuilder private var center: some View {
        switch navigation.route {
        case .project:
            projectChatWelcome
            composer
        case .tasks, .search: taskList
        case .timeline: timeline(taskID: nil)
        case .newChat, .chat:
            newChatWelcome
            composer
        case .task:
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let task = selectedTask {
                        Text(task.completed ? "你已将这个任务标记为完成。记录与材料仍可在右侧查看。" : "任务已建立。分工与进度在右侧，下方可以记录补充要求。")
                            .font(.system(size: 15))
                        if let resume = task.latestResume {
                            VStack(alignment: .leading, spacing: 14) {
                                Text("上次记录 · \(resume.savedAt.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                                if !resume.content.progress.isEmpty { Text(resume.content.progress).textSelection(.enabled) }
                                if !resume.content.nextStep.isEmpty {
                                    Text("接下来：\(resume.content.nextStep)").textSelection(.enabled)
                                }
                            }.padding(.vertical, 8)
                        }
                        Button {
                            navigation.requestInspector()
                        } label: { HStack(spacing: 8) { Text("查看任务详情").underline(); Image(systemName: "arrow.right") } }
                            .buttonStyle(.plain).foregroundStyle(WorkbenchStyle.muted)
                    }
                }.lineSpacing(6).frame(maxWidth: 760, alignment: .leading).padding(.horizontal, 24).padding(.vertical, 32)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            composer
        }
    }

    private var isChat: Bool {
        switch navigation.route { case .newChat, .chat: return true; default: return false }
    }

    private var projectChatWelcome: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 16) {
                    Text(projectTask == nil ? "从这个项目开始" : "继续这个任务")
                        .font(.system(size: 26, weight: .semibold)).multilineTextAlignment(.center)
                    Text("在这里补充要求，详情与执行记录在右侧。")
                        .font(.system(size: 14)).foregroundStyle(WorkbenchStyle.muted)
                        .multilineTextAlignment(.center)
                    Button { navigation.requestInspector() } label: {
                        Label(projectTask == nil ? "查看项目详情" : "查看任务详情", systemImage: "sidebar.right")
                            .padding(.horizontal, 16).frame(height: 40)
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkbenchStyle.line))
                    }.buttonStyle(.plain)
                    if let id = projectID, projects.diagnostics[id] != nil {
                        Label("项目记录暂不可用，可在详情中重新读取。", systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                    }
                }.padding(24).frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
    }

    private var newChatWelcome: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 18) {
                    Text("今天想推进什么？")
                        .font(.system(size: 30, weight: .semibold))
                        .multilineTextAlignment(.center)
                    Text("可以先讨论，也可以从一个目标开始。")
                        .font(.system(size: 15)).foregroundStyle(WorkbenchStyle.muted)
                        .multilineTextAlignment(.center)
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 12) { chatSuggestions }
                        VStack(spacing: 10) { chatSuggestions }
                    }.padding(.top, 12)
                }
                .padding(.horizontal, 24).padding(.vertical, 40)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height)
            }
        }
    }

    @ViewBuilder private var chatSuggestions: some View {
        Button { draftFocused = true } label: {
            Label("讨论一个想法", systemImage: "bubble.left")
                .padding(.horizontal, 20).frame(height: 44)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkbenchStyle.line))
        }.buttonStyle(.plain).accessibilityHint("将焦点移到草稿，不会发送消息")
        Button { addingTask = true } label: {
            Label("梳理一个任务", systemImage: "checklist")
                .padding(.horizontal, 20).frame(height: 44)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(WorkbenchStyle.line))
        }.buttonStyle(.plain).disabled(!state.dataAvailable || state.isEditingTask)
            .accessibilityHint("打开新建本地任务，不会启动 AI")
    }

    private var draftField: some View {
        TextField(isChat ? "描述一个想法，或你想完成的事…" : "补充要求，或继续讨论…", text: draft, axis: .vertical)
            .lineLimit(1...5).textFieldStyle(.plain).accessibilityLabel("本地对话草稿")
            .focused($draftFocused).disabled(projectID == nil ? !state.dataAvailable : !projectConversations.isLoaded)
    }

    private var composer: some View {
        VStack(spacing: 8) {
            Group {
                if isChat {
                    VStack(alignment: .leading, spacing: 12) {
                        draftField.padding(.horizontal, 4).padding(.top, 4)
                            .frame(minHeight: 40, alignment: .topLeading)
                        HStack {
                            composerAddButton
                            Spacer(minLength: 12)
                            composerExecutionControls
                        }
                    }
                } else {
                    HStack(alignment: .bottom, spacing: 12) {
                        composerAddButton
                        draftField.padding(.vertical, 9)
                        composerExecutionControls
                    }
                }
            }.padding(12).background(WorkbenchStyle.surface, in: RoundedRectangle(cornerRadius: 18))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(WorkbenchStyle.line))
            if state.hasUnsavedConversationDrafts {
                HStack(spacing: 8) {
                    Label("有草稿未保存，输入仍保留", systemImage: "exclamationmark.triangle")
                    Button("重试保存") {
                        let creating = navigation.route == .newChat && state.isConversationDraftUnsaved(.newChat)
                        if state.retryConversationDrafts(), creating, let id = state.conversations.last?.id {
                            navigation.route = .chat(id)
                        }
                    }.buttonStyle(.borderless)
                }.font(.system(size: 11)).foregroundStyle(WorkbenchStyle.ink)
            }
            if (projectConversations.error != nil || projectConversations.hasUnsavedDrafts),
               projectID != nil || projectConversations.hasUnsavedDrafts {
                HStack(alignment: .top, spacing: 8) {
                    Label(projectConversations.error ?? "有项目草稿未保存，输入仍保留", systemImage: "exclamationmark.triangle")
                    Button(projectConversations.isLoaded ? "重试保存" : "重新读取") {
                        if projectConversations.isLoaded { _ = projectConversations.retryDrafts() }
                        else { Task { await projectConversations.load() } }
                    }.buttonStyle(.borderless)
                }.font(.system(size: 11)).foregroundStyle(WorkbenchStyle.ink)
            }
        }.frame(maxWidth: 760).padding(.horizontal, 20).padding(.bottom, isChat ? 28 : 14)
            .frame(maxWidth: .infinity)
    }

    private var composerAddButton: some View {
        Button { showingAddMenu.toggle() } label: {
            Image(systemName: "plus").font(.system(size: 19)).frame(width: 36, height: 36)
                .overlay(Circle().stroke(WorkbenchStyle.line))
        }.buttonStyle(.plain).accessibilityLabel("添加")
            .popover(isPresented: $showingAddMenu) {
                VStack(alignment: .leading, spacing: 14) {
                    Button("新建任务") { showingAddMenu = false; addingTask = true }
                        .disabled(!state.dataAvailable || state.isEditingTask)
                    Text("文件附件暂未接入").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                }.padding(16)
            }
    }

    private var composerExecutionControls: some View {
        HStack(spacing: 14) {
            Button { showingConnection.toggle() } label: {
                HStack(spacing: 6) {
                    Text("连接 Agent").font(.system(size: 12)).fixedSize()
                    Image(systemName: "chevron.down").font(.system(size: 9))
                }.frame(height: 36)
            }.buttonStyle(.plain).accessibilityLabel("Agent 连接状态，尚未接入")
                .popover(isPresented: $showingConnection) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("对话执行配置").font(.headline)
                        Text("尚未接入 Agent。模型与思考强度不可选，草稿不会外发。")
                        Text("子任务的执行者将在右侧「分工」中管理。")
                            .foregroundStyle(.secondary)
                    }.padding(20).frame(width: 290)
                }
            Button {} label: {
                Image(systemName: "arrow.up").font(.system(size: 17, weight: .medium))
                    .foregroundStyle(WorkbenchStyle.surface).frame(width: 36, height: 36)
                    .background(WorkbenchStyle.muted, in: Circle())
            }.buttonStyle(.plain).disabled(true)
                .accessibilityLabel("发送不可用，尚未连接 AI").help("尚未连接 AI，不能发送")
        }
    }

    private var taskList: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                TextField("搜索任务或聊天草稿", text: $query).textFieldStyle(.roundedBorder)
                Button("新建任务") { addingTask = true }.disabled(!state.dataAvailable || state.isEditingTask)
            }
            Text("\(projects.associations.count) 个项目 · \(state.tasks.count) 个本地任务")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(projects.associations, id: \.projectID) { association in
                        let tasks = projects.snapshots[association.projectID]?.tasks ?? []
                        if tasks.contains(where: { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.goal.localizedCaseInsensitiveContains(query) }) {
                            HStack {
                                Text(association.name).font(.caption).foregroundStyle(WorkbenchStyle.muted)
                                if projects.staleProjectIDs.contains(association.projectID) { Text("旧快照 · 已失效").font(.caption) }
                            }.padding(.top, 8)
                            ForEach(tasks.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.goal.localizedCaseInsensitiveContains(query) }, id: \.taskID) { task in
                                ProjectTaskCard(task: task) { openProject(association.projectID, taskID: task.taskID) }
                            }
                        }
                    }
                    if !state.tasks.isEmpty { Text("本地任务").font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.top, 8) }
                    ForEach(state.tasks.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }) { task in
                        Button { navigation.openTask(task.id) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(task.title).fontWeight(.medium)
                                    Text(task.completed ? "已完成" : task.id == state.currentTaskID ? "Deck 当前任务" : "未完成")
                                        .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                                }
                                Spacer(); Image(systemName: "chevron.right")
                            }.padding(16).background(WorkbenchStyle.rail, in: RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain)
                    }
                    if navigation.route == .search {
                        ForEach(state.conversations.filter { query.isEmpty || $0.draft.localizedCaseInsensitiveContains(query) }) { chat in
                            Button { navigation.route = .chat(chat.id) } label: {
                                Label(chat.draft.isEmpty ? chat.title : String(chat.draft.prefix(60)), systemImage: "bubble.left")
                                    .padding(12)
                            }.buttonStyle(.plain)
                        }
                    }
                    if state.tasks.isEmpty && projects.associations.isEmpty && navigation.route != .search { empty("还没有任务", detail: "打开项目文件夹，或创建本地任务。", icon: "checklist") }
                    else if !query.isEmpty && !state.tasks.contains(where: { $0.title.localizedCaseInsensitiveContains(query) }) {
                        if !projects.snapshots.values.contains(where: { $0.tasks.contains(where: { $0.title.localizedCaseInsensitiveContains(query) || $0.goal.localizedCaseInsensitiveContains(query) }) }) && (navigation.route != .search || !state.conversations.contains(where: { $0.draft.localizedCaseInsensitiveContains(query) })) {
                            Text("没有匹配的结果").foregroundStyle(WorkbenchStyle.muted).padding()
                        }
                    }
                }
            }
        }.padding(20)
    }

    private func inspector(_ task: LocalTask) -> some View {
        VStack(spacing: 0) {
            TaskInspectorNavigationView(tab: $navigation.inspectorTab)
            Divider()
            if navigation.inspectorTab == .timeline { timeline(taskID: task.id) }
            else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        switch navigation.inspectorTab {
                        case .overview: overview(task)
                        case .assignment: assignment(task)
                        case .delivery: delivery(task)
                        case .timeline: EmptyView()
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(22)
                }
            }
        }.background(WorkbenchStyle.surface)
    }

    private func overview(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            TaskOverviewView(task: task,
                             canEditSubtasks: !task.completed && !state.isEditingTask,
                             canOpenDeck: canOpenDeck(task),
                             onToggleSubtask: { state.toggleSubtask(taskID: task.id, subtaskID: $0) },
                             onShowAssignment: { navigation.inspectorTab = .assignment },
                             onOpenDeck: { onOpenDeck(task.id) })
            if let session = memory.activeSession, session.taskID != task.id {
                Text("其他任务正在记录。请先停止记录，再切换 Deck 当前任务。").font(.caption).foregroundStyle(WorkbenchStyle.muted)
            }
            Divider()
            if renameDrafts[task.id] != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("任务名称").font(.caption)
                    TextField("任务名称", text: Binding(get: { renameDrafts[task.id] ?? task.title }, set: { renameDrafts[task.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                    HStack {
                        Button("保存名称") {
                            if state.renameTask(id: task.id, title: renameDrafts[task.id] ?? task.title) { renameDrafts.removeValue(forKey: task.id) }
                        }.disabled((renameDrafts[task.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || state.isEditingTask || memory.activeSession?.taskID == task.id)
                        Button("取消") { renameDrafts.removeValue(forKey: task.id) }
                    }
                    Text("保存失败时保留输入；退出前请保存名称。").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                }
            } else {
                Button("修改任务名称") { renameDrafts[task.id] = task.title }
                    .disabled(state.isEditingTask || memory.activeSession?.taskID == task.id)
            }
            Button(task.completed ? "重新打开任务" : "手动标记完成") { state.toggle(task) }
                .disabled(state.isEditingTask || memory.activeSession?.taskID == task.id)
            Text("任务由你验收；子任务全部勾选后，不会自动完成主任务。")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
            Divider()
            materials(task)
        }
    }

    private func assignment(_ task: LocalTask) -> some View {
        TaskAssignmentView(task: task, canEdit: !task.completed && !state.isEditingTask,
                           childDraft: Binding(get: { childDrafts[task.id] ?? "" }, set: { childDrafts[task.id] = $0 }),
                           onAdd: { addChild(task) },
                           onToggle: { state.toggleSubtask(taskID: task.id, subtaskID: $0) },
                           onDiscuss: { draftFocused = true })
    }

    private func addChild(_ task: LocalTask) {
        if state.addSubtask(taskID: task.id, title: childDrafts[task.id] ?? "") { childDrafts[task.id] = "" }
    }

    private func delivery(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("暂无 AI 交付").font(.headline)
            Text("接续材料是参考资料，不代表已验收的交付物。").foregroundStyle(WorkbenchStyle.muted)
            materials(task)
        }
    }

    private func materials(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("相关材料").font(.headline)
            ForEach(task.latestResume?.content.materials ?? [], id: \.self) { value in
                if let url = ResumeContent.materialURL(value) {
                    Link(destination: url) { Label(value, systemImage: "link").lineLimit(2) }
                }
            }
            if task.latestResume?.content.materials.isEmpty ?? true {
                Text("暂无材料链接，可从 Deck 的接续编辑中添加。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
            }
        }
    }

    private func timeline(taskID: UUID?) -> some View {
        let records = state.tasks.filter { taskID == nil || $0.id == taskID }.flatMap { task in
            (task.resumeRecords ?? []).map { TimelineEntry(id: $0.id, taskID: task.id, title: task.title, date: $0.savedAt, detail: $0.content.progress) }
        }.sorted { $0.date > $1.date }
        return ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if taskID == nil {
                    ForEach(projects.associations, id: \.projectID) { association in
                        if let snapshot = projects.snapshots[association.projectID] {
                            HStack {
                                Text("\(association.name) · 执行记录").font(.headline)
                                if projects.staleProjectIDs.contains(association.projectID) { Text("已失效").font(.caption) }
                            }
                            ForEach(ProjectRecordPresentation.sortedRuns(snapshot.runs), id: \.runID) { run in
                                ProjectRunSummaryView(run: run, title: snapshot.tasks.first(where: { $0.taskID == run.taskID })?.title,
                                                      onOpenTask: { openProject(association.projectID, taskID: run.taskID) },
                                                      onReference: { openReference($0, projectID: association.projectID, taskID: run.taskID) },
                                                      referencesDisabled: projects.staleProjectIDs.contains(association.projectID),
                                                      sourceReference: snapshot.recordReference(collection: "runs", id: run.runID))
                            }
                        } else if let diagnostic = projects.diagnostics[association.projectID] {
                            Label("\(association.name)：\(diagnostic)", systemImage: "exclamationmark.triangle").font(.caption)
                        }
                    }
                }
                Text(taskID == nil ? "所有任务的接续记录" : "本任务的接续记录").font(.headline)
                Text("只展示已有保存时间的记录，不推测历史执行过程。屏幕采集详情仍在 Deck 的「记录」中查看。")
                    .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                if records.isEmpty { empty("暂无本地接续记录", detail: "在 Deck 暂存进度后，记录会出现在这里。", icon: "clock") }
                ForEach(records) { record in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(record.date.formatted()).font(.caption).foregroundStyle(WorkbenchStyle.muted)
                        Button(record.title) { navigation.openTask(record.taskID) }.buttonStyle(.plain).fontWeight(.semibold)
                        Text(record.detail.isEmpty ? "已保存下一步或材料" : record.detail).textSelection(.enabled)
                        Divider()
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
        }
    }

    private func empty(_ title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: icon).font(.system(size: 25)).foregroundStyle(WorkbenchStyle.muted)
            Text(title).font(.headline)
            Text(detail).font(.callout).foregroundStyle(WorkbenchStyle.muted)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 32)
    }
}

private struct TimelineEntry: Identifiable {
    let id: UUID
    let taskID: UUID
    let title: String
    let date: Date
    let detail: String
}
