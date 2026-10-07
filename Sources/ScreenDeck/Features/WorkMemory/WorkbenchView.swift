import SwiftUI
import AppKit

/// One lightweight surface: task list → task detail. Capture always starts explicitly.
struct WorkbenchView: View {
    @ObservedObject var state: AppState
    @ObservedObject var memory: WorkSessionController
    @State private var detailID: UUID?
    @State private var tab = "接续"
    @State private var adding = false
    @State private var title = ""
    @State private var childTitle = ""
    @State private var consent = false
    @State private var showCapture = false
    @State private var editing = false
    @State private var draft = ResumeContent()
    @State private var requestID = UUID()
    @State private var materialText = ""
    @State private var renaming = false
    @State private var renameTitle = ""
    @State private var screenFilter: UInt32 = 0
    @State private var expandedEvidence: UUID?
    @State private var aiInput: DraftInput?
    @State private var completedExpanded = false
    @State private var othersExpanded = false
    let addRequest: Int
    let onOpenSettings: () -> Void
    let onOpenWorkbench: (UUID?) -> Void
    @State private var aiBusy = false
    @State private var aiError: String?
    @State private var aiJob: Task<Void, Never>?
    @State private var sourceIDs: [UUID] = []
    @State private var sourceSessionID: UUID?
    @State private var draftOrigin = "手动"
    @State private var trashSessionID: UUID?
    @State private var recordQuery = ""
    @State private var sessionFilter: UUID?
    @FocusState private var titleFocused: Bool

    private var task: LocalTask? { state.tasks.first { $0.id == detailID } }
    private var taskSessions: [WorkSession] { memory.sessions.filter { $0.taskID == detailID } }

    init(state: AppState, memory: WorkSessionController, initialTaskID: UUID? = nil, initialTab: String = "接续", addRequest: Int = 0, onOpenSettings: @escaping () -> Void = {}, onOpenWorkbench: @escaping (UUID?) -> Void = { _ in }) {
        self.state = state; self.memory = memory
        self.addRequest = addRequest; self.onOpenSettings = onOpenSettings
        self.onOpenWorkbench = onOpenWorkbench
        _detailID = State(initialValue: initialTaskID)
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if !state.dataAvailable {
                    Text("任务读取失败").font(.headline)
                    Text(state.statusMessage).font(.caption)
                    Button("重新读取") { state.refresh() }
                } else if let task {
                    detail(task)
                } else {
                    taskList
                }
                if let error = state.operationError { Text(error).font(.caption).foregroundStyle(.orange) }
                if let error = memory.preferencesError {
                    Text(error).font(.caption).foregroundStyle(DeckTheme.secondary)
                    Button("检查设置") { openSettings(.capture) }.disabled(state.isEditingTask)
                }
                if let error = memory.error {
                    Text(error).font(.caption).foregroundStyle(.orange)
                    if !memory.loaded { Button("重试读取工作记录") { memory.load() } }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.bottom, 12)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(DeckTheme.text, DeckTheme.secondary)
        .tint(DeckTheme.accent)
        .onChange(of: addRequest) { _, _ in
            guard !state.isEditingTask else { return }
            detailID = nil; adding = true; state.setEditingTask(true); titleFocused = true
        }
        .onChange(of: memory.selectedDisplays) { _, _ in consent = false }
        .onChange(of: state.deckTaskRequest) { _, request in
            guard !state.isEditingTask, let request else { return }
            detailID = request.taskID; tab = "接续"; showCapture = false; consent = false
        }
        .onChange(of: memory.interval) { _, _ in consent = false }
        .onDisappear { aiJob?.cancel() }
        .confirmationDialog("将这次会话的截图和文字移到废纸篓？已保存的接续卡仍保留。", isPresented: Binding(get: { trashSessionID != nil }, set: { if !$0 { trashSessionID = nil } }), titleVisibility: .visible) {
            Button("移到废纸篓", role: .destructive) {
                if let id = trashSessionID { memory.trashSession(id) }
                trashSessionID = nil
            }
            Button("取消", role: .cancel) { trashSessionID = nil }
        }
    }

    private var taskList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if adding {
                HStack {
                    Image(systemName: "circle").foregroundStyle(DeckTheme.secondary)
                    TextField("任务名称", text: $title).textFieldStyle(.plain).focused($titleFocused)
                        .onSubmit { createTask() }
                    Button { createTask() } label: { Image(systemName: "return") }.accessibilityLabel("保存新任务")
                    Button { adding = false; title = ""; state.setEditingTask(false) } label: { Image(systemName: "xmark") }.accessibilityLabel("取消新建")
                }.padding(.vertical, 7)
            }
            if let current = state.currentTask, !current.completed {
                currentSummary(current).disabled(adding)
            }
            let others = state.tasks.filter { !$0.completed && $0.id != state.currentTaskID }
            if !others.isEmpty {
                if state.currentTask == nil {
                    ForEach(others) { taskRow($0) }
                } else {
                    DisclosureGroup("其他任务 · \(others.count)", isExpanded: $othersExpanded) {
                        ForEach(others) { taskRow($0) }
                    }.font(.callout).disabled(adding)
                }
            }
            let completed = state.tasks.filter(\.completed)
            if !completed.isEmpty {
                Divider()
                DisclosureGroup("已完成 · \(completed.count)", isExpanded: $completedExpanded) {
                    ForEach(completed) { taskRow($0) }
                }.font(.callout).foregroundStyle(DeckTheme.secondary).disabled(adding)
            }
            if state.tasks.isEmpty && !adding {
                VStack(alignment: .leading, spacing: 10) {
                    Text("还没有任务").font(.headline)
                    Button("新建任务") { adding = true; state.setEditingTask(true); titleFocused = true }
                        .buttonStyle(DeckPrimaryButtonStyle())
                }.padding(.vertical, 12)
            }
        }
    }

    private func taskRow(_ item: LocalTask) -> some View {
        HStack(spacing: 10) {
            Button { state.toggle(item) } label: {
                Image(systemName: item.completed ? "checkmark.circle.fill" : "circle")
            }.disabled(adding || memory.activeSession?.taskID == item.id)
                .accessibilityLabel(item.completed ? "重新打开任务" : "完成任务")
            Button {
                detailID = item.id; tab = "接续"
                if !item.completed && memory.activeID == nil { state.selectTask(item) }
            } label: {
                HStack {
                    Text(item.title).strikethrough(item.completed).lineLimit(1)
                    Spacer()
                    if memory.activeSession?.taskID == item.id {
                        Text("记录中").font(.caption).foregroundStyle(DeckTheme.accent)
                    }
                    Image(systemName: "chevron.right").font(.caption2)
                }.contentShape(Rectangle())
            }.disabled(adding)
        }
        .foregroundStyle(item.completed ? DeckTheme.secondary : DeckTheme.text)
        .padding(.vertical, 6)
    }

    private func currentSummary(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("当前任务", systemImage: "scope").font(.caption).foregroundStyle(DeckTheme.secondary)
                Spacer()
                Button { detailID = task.id; tab = "接续"; renameTitle = task.title; renaming = true; state.setEditingTask(true) } label: {
                    Image(systemName: "pencil")
                }.accessibilityLabel("修改任务名称").disabled(memory.activeID != nil)
            }
            HStack(spacing: 8) {
                Button { state.toggle(task) } label: { Image(systemName: "circle") }
                    .foregroundStyle(DeckTheme.secondary).accessibilityLabel("完成当前任务")
                    .disabled(memory.activeSession?.taskID == task.id)
                Button { detailID = task.id; tab = "接续" } label: {
                    Text(task.title).font(.system(size: 17, weight: .semibold)).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.help("查看任务详情")
            }
            if let saved = task.latestResume {
                Text(saved.content.progress).font(.caption).foregroundStyle(DeckTheme.secondary).lineLimit(1)
                if !saved.content.nextStep.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Text("下一步").font(.caption).foregroundStyle(DeckTheme.secondary)
                        Text(saved.content.nextStep).font(.callout).lineLimit(2)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(DeckTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            HStack(spacing: 8) {
                if let saved = task.latestResume {
                    Text("已暂存 · \(saved.savedAt.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(DeckTheme.secondary)
                }
                Spacer()
                Button(task.latestResume == nil ? "打开任务" : "继续任务") {
                    if task.latestResume != nil { guard state.resumeTask(id: task.id) else { return } }
                    detailID = task.id; tab = "接续"
                }.buttonStyle(DeckPrimaryButtonStyle())
            }.padding(.top, 2)
        }.padding(.bottom, 4)
    }

    private func detail(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { onOpenWorkbench(task.id) } label: {
                Label("在主工作台打开", systemImage: "arrow.up.right.square")
            }.disabled(state.isEditingTask)
            HStack {
                Button { detailID = nil; showCapture = false; consent = false; childTitle = "" } label: { Image(systemName: "chevron.left") }.accessibilityLabel("返回任务列表").disabled(state.isEditingTask)
                if renaming {
                    TextField("任务名称", text: $renameTitle).textFieldStyle(.plain).onSubmit { saveName(task) }
                    Button("保存") { saveName(task) }
                    Button("取消") { renaming = false; state.setEditingTask(false) }
                } else {
                    Text(task.title).font(.headline).lineLimit(1)
                    Button { renameTitle = task.title; renaming = true; state.setEditingTask(true) } label: { Image(systemName: "pencil") }
                        .accessibilityLabel("修改任务名称").disabled(state.isEditingTask || memory.activeID != nil)
                }
                Spacer()
                if memory.activeSession?.taskID == task.id {
                    Button("暂停") { pauseAndDraft(task) }.foregroundStyle(DeckTheme.accent).disabled(state.isEditingTask)
                } else if !task.completed {
                    Button("记录屏幕") { showCapture.toggle(); consent = false }.disabled(state.isEditingTask || memory.activeID != nil)
                }
            }
            if showCapture { captureSetup(task) }
            HStack(spacing: 6) {
                ForEach(["接续", "子任务", "记录"], id: \.self) { name in
                    Button { tab = name } label: {
                        Text(name).font(.system(size: 12, weight: tab == name ? .semibold : .regular))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .foregroundStyle(tab == name ? DeckTheme.accent : DeckTheme.secondary)
                            .background(tab == name ? DeckTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 7))
                    }.accessibilityAddTraits(tab == name ? .isSelected : [])
                }
                Spacer()
            }.disabled(state.isEditingTask)
            Group { switch tab {
            case "子任务": subtasks(task)
            case "记录": records
            default: resume(task)
            } }.disabled(renaming)
        }
    }

    private func captureSetup(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("本次记录").font(.subheadline.bold())
            let selected = memory.displays.filter { memory.selectedDisplays.contains($0.id) }
            let missing = !memory.selectedDisplays.isSubset(of: Set(memory.displays.map(\.id)))
            if memory.loadingDisplays {
                Text("正在核对屏幕…").font(.caption)
            } else if !memory.hasPermission || selected.isEmpty || missing {
                Text(missing ? "已选屏幕不可用，请到设置重新核对。" : "请先在设置中授权并选择记录屏幕。")
                    .font(.caption).foregroundStyle(DeckTheme.secondary)
            } else {
                Text("\(selected.map(\.name).joined(separator: "、")) · 每 \(Int(memory.interval)) 秒")
                    .font(.caption)
                Toggle("同意记录这些屏幕的可见内容", isOn: $consent).font(.caption)
                Text("可能包含敏感信息；截图和文字仅在本机保存。")
                    .font(.caption2).foregroundStyle(DeckTheme.secondary)
            }
            HStack {
                Button("记录设置…") { openSettings(.capture) }
                Button("暂不记录") { showCapture = false; consent = false }
                Spacer()
                Button("开始记录") {
                    state.selectTask(task)
                    guard state.currentTaskID == task.id else { return }
                    if memory.start(task: task) { showCapture = false; consent = false }
                }.buttonStyle(DeckPrimaryButtonStyle())
                    .disabled(!consent || selected.isEmpty || missing || !memory.hasPermission || memory.loadingDisplays || !memory.loaded || !memory.preferencesLoaded)
            }.font(.caption)
        }.padding(10).background(DeckTheme.surface, in: RoundedRectangle(cornerRadius: 10))
            .task { await memory.refreshDisplays() }
    }

    private func openSettings(_ section: SettingsSection) {
        guard !state.isEditingTask else { return }
        state.requestedSettingsSection = section
        showCapture = false; consent = false
        onOpenSettings()
    }

    private func subtasks(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(task.subtasks ?? []) { child in
                HStack {
                    Button { state.toggleSubtask(taskID: task.id, subtaskID: child.id) } label: {
                        Image(systemName: child.completed ? "checkmark.circle.fill" : "circle")
                    }.disabled(task.completed).accessibilityLabel(child.completed ? "取消完成子任务" : "完成子任务")
                    Text(child.title).strikethrough(child.completed).foregroundStyle(child.completed ? .secondary : .primary)
                }.padding(.vertical, 4)
            }
            if !task.completed {
                HStack {
                    Image(systemName: "plus").foregroundStyle(.secondary)
                    TextField("添加子任务", text: $childTitle).textFieldStyle(.plain)
                        .onSubmit { if state.addSubtask(taskID: task.id, title: childTitle) { childTitle = "" } }
                        .onChange(of: childTitle) { _, value in state.setEditingTask(!value.isEmpty) }
                    Button("添加") { if state.addSubtask(taskID: task.id, title: childTitle) { childTitle = "" } }
                        .disabled(childTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if !childTitle.isEmpty { Button("取消") { childTitle = "" } }
                }.padding(.vertical, 5)
            }
            Text("勾选由你确认；屏幕活动不等于完成。") .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func resume(_ task: LocalTask) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if editing {
                Text("\(draftOrigin)草稿 · 请确认内容").font(.caption).foregroundStyle(.secondary)
                Text("做到哪里 / 最近线索").font(.caption).foregroundStyle(DeckTheme.secondary)
                TextField("补充最近进度", text: $draft.progress, axis: .vertical).lineLimit(2...5)
                    .accessibilityLabel("做到哪里或最近线索")
                Text("下一步").font(.caption).foregroundStyle(DeckTheme.secondary)
                TextField("回来后先做什么", text: $draft.nextStep, axis: .vertical).lineLimit(1...3)
                    .accessibilityLabel("下一步")
                Text("材料链接 · 每行一个").font(.caption).foregroundStyle(DeckTheme.secondary)
                TextField("https://…", text: $materialText, axis: .vertical).lineLimit(1...3)
                    .accessibilityLabel("材料链接，每行一个")
                HStack {
                    Button("取消") { editing = false; state.setEditingTask(false) }
                    Spacer()
                    Button("保存接续卡") {
                        draft.materials = materialText.components(separatedBy: .newlines)
                        if state.saveResume(taskID: task.id, content: draft, requestID: requestID, evidenceIDs: sourceIDs, sessionID: sourceSessionID, origin: draftOrigin) {
                            editing = false; state.setEditingTask(false)
                        }
                    }
                }
            } else if let input = aiInput {
                Text("交给本机 AI 的文本预览").font(.caption.bold())
                Text("仅调用 127.0.0.1:11434。请使用已安装的本地模型，不使用云模型；本机服务的转发行为由其配置决定。") .font(.caption).foregroundStyle(.secondary)
                Text("本地模型：\(memory.preferences.model)").font(.caption).foregroundStyle(DeckTheme.secondary)
                DisclosureGroup("查看将发送的文本（\(input.evidence.count) 条记录）") {
                    Text((try? input.preview()) ?? "预览失败").font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                }.font(.caption)
                if let aiError { Text(aiError).font(.caption).foregroundStyle(.orange) }
                HStack {
                    Button(aiBusy ? "取消生成" : "返回") {
                        aiJob?.cancel(); aiJob = nil; aiInput = nil; aiBusy = false; state.setEditingTask(false)
                    }
                    Spacer()
                    Button(aiBusy ? "整理中…" : "同意并生成草稿") { generateAI(input, task: task) }.disabled(aiBusy || memory.preferences.model.isEmpty)
                }
            } else {
                if let saved = task.latestResume {
                    Text(saved.content.progress).font(.callout).textSelection(.enabled)
                    if !saved.content.nextStep.isEmpty {
                        HStack(alignment: .top) {
                            Image(systemName: "arrow.turn.down.right")
                            Text(saved.content.nextStep).textSelection(.enabled)
                        }.foregroundStyle(DeckTheme.text).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(DeckTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                    }
                    ForEach(saved.content.materials, id: \.self) { material in
                        if let url = ResumeContent.materialURL(material) { Link(destination: url) { Label(url.host ?? material, systemImage: "arrow.up.right").lineLimit(1) }.font(.caption).foregroundStyle(DeckTheme.secondary) }
                    }
                    Text(saved.savedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary)
                    if let ids = saved.evidenceIDs, !ids.isEmpty {
                        Button("\(saved.origin ?? "线索") · 查看 \(ids.count) 条来源所在会话") {
                            sessionFilter = saved.sessionID; screenFilter = 0; recordQuery = ""; tab = "记录"
                        }.font(.caption2)
                    }
                } else {
                    Text("尚无接续卡").font(.callout).foregroundStyle(.secondary)
                }
                if !task.completed {
                    HStack {
                        Button("写一句进度") { beginDraft(task.latestResume?.content ?? ResumeContent(), task: task) }
                        Spacer()
                        Button("从记录整理") {
                            if let session = taskSessions.first { beginEvidenceDraft(session, task: task) }
                        }.disabled(taskSessions.isEmpty || memory.activeID != nil)
                    }.disabled(memory.activeSession?.taskID != nil && memory.activeSession?.taskID != task.id)
                    Button(memory.preferences.model.isEmpty ? "配置本机 AI…" : "本机 AI 整理…") {
                        if memory.preferences.model.isEmpty { openSettings(.ai); return }
                        if let session = taskSessions.first {
                            state.selectTask(task)
                            guard state.currentTaskID == task.id else { return }
                            sourceSessionID = session.id
                            aiInput = DraftInput(task: task, session: session); aiError = nil
                            state.setEditingTask(true)
                        }
                    }.font(.caption).disabled((!memory.preferences.model.isEmpty && taskSessions.first?.evidence.filter { !$0.excluded }.isEmpty != false) || memory.activeID != nil)
                }
            }
        }
    }

    private var records: some View {
        LazyVStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("本地采样记录").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if memory.activeSession?.taskID == detailID {
                    Button(memory.capturing ? "采集中…" : "立即采样") { Task { await memory.captureOnce() } }.disabled(memory.capturing)
                }
            }
            let screens = Array(Set(taskSessions.flatMap(\.displayIDs))).sorted()
            if !taskSessions.isEmpty {
                TextField("查找文字或应用", text: $recordQuery).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("搜索本任务的屏幕文字和应用")
                Picker("会话", selection: $sessionFilter) {
                    Text("所有会话").tag(nil as UUID?)
                    ForEach(taskSessions) { Text($0.startedAt.formatted(date: .abbreviated, time: .shortened)).tag(Optional($0.id)) }
                }
            }
            if screens.count > 1 {
                Picker("显示器", selection: $screenFilter) {
                    Text("所有屏幕").tag(UInt32(0))
                    ForEach(screens, id: \.self) { Text("屏幕 \($0)").tag($0) }
                }
            }
            if taskSessions.isEmpty { Text("还没有记录。配置屏幕后，点击「记录屏幕」确认开始。") .font(.caption).foregroundStyle(.secondary) }
            if sessionFilter != nil && !taskSessions.contains(where: { $0.id == sessionFilter }) {
                Text("来源会话已移除或暂不可用。接续卡中的内容仍保留。") .font(.caption).foregroundStyle(.secondary)
                Button("显示所有会话") { sessionFilter = nil }
            }
            ForEach(taskSessions.filter { sessionFilter == nil || $0.id == sessionFilter }) { session in
                HStack {
                    Text("\(session.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(session.status == .recording ? "记录中" : "已停止")")
                    Spacer()
                    Button { trashSessionID = session.id } label: { Image(systemName: "trash") }
                        .accessibilityLabel("移除这次会话记录").disabled(session.id == memory.activeID || memory.capturing)
                }.font(.caption).foregroundStyle(.secondary)
                if let note = session.note { Text(note).font(.caption2).foregroundStyle(.orange) }
                let items = session.evidence.reversed().filter {
                    (screenFilter == 0 || $0.displayID == screenFilter) &&
                    (recordQuery.isEmpty || $0.text.localizedCaseInsensitiveContains(recordQuery) || $0.appName.localizedCaseInsensitiveContains(recordQuery))
                }
                if items.isEmpty { Text("没有符合条件的画面线索。") .font(.caption2).foregroundStyle(.secondary) }
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Button { expandedEvidence = expandedEvidence == item.id ? nil : item.id } label: {
                            HStack {
                                Image(systemName: "display")
                                Text("\(item.capturedAt.formatted(date: .omitted, time: .standard)) · \(item.displayName)").lineLimit(1)
                                Spacer()
                                Image(systemName: expandedEvidence == item.id ? "chevron.up" : "chevron.down")
                            }.font(.caption)
                        }
                        if expandedEvidence == item.id {
                            Text("采样时前台应用：\(item.appName)").font(.caption2).foregroundStyle(.secondary)
                            Text("来源：\(item.id.uuidString)").font(.caption2).textSelection(.enabled)
                            if let url = memory.store.imageURL(sessionID: session.id, evidence: item), let image = NSImage(contentsOf: url) {
                                Image(nsImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 6))
                                Button("查看原图") { NSWorkspace.shared.open(url) }.font(.caption)
                            } else {
                                Text("截图文件不可用，文字记录仍可查看。") .font(.caption).foregroundStyle(.orange)
                            }
                            Text(item.text.isEmpty ? "未识别到文字" : item.text).font(.caption).textSelection(.enabled)
                            Toggle("用于接续草稿", isOn: Binding(get: { !item.excluded }, set: { memory.setExcluded(sessionID: session.id, evidenceID: item.id, excluded: !$0) })).font(.caption)
                            if item.excluded { Text("已排除摘要，原始记录仍保存在本机。") .font(.caption2).foregroundStyle(.secondary) }
                        }
                    }.padding(8).background(DeckTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }

    private func createTask() {
        if state.createTask(title: title) { adding = false; title = ""; state.setEditingTask(false) }
    }
    private func beginDraft(_ content: ResumeContent, task: LocalTask) {
        state.selectTask(task)
        guard state.currentTaskID == task.id else { return }
        draft = content; materialText = content.materials.joined(separator: "\n"); requestID = UUID(); editing = true; state.setEditingTask(true)
        sourceIDs = []; sourceSessionID = nil; draftOrigin = "手动"
    }
    private func saveName(_ task: LocalTask) {
        if state.renameTask(id: task.id, title: renameTitle) { renaming = false; state.setEditingTask(false) }
    }
    private func pauseAndDraft(_ task: LocalTask) {
        if let session = memory.pause() {
            tab = "接续"
            beginEvidenceDraft(session, task: task)
        }
    }
    private func beginEvidenceDraft(_ session: WorkSession, task: LocalTask) {
        beginDraft(EvidenceDigest.draft(session: session, task: task), task: task)
        sourceIDs = session.evidence.filter { !$0.excluded }.map(\.id)
        sourceSessionID = session.id; draftOrigin = "本地线索"
    }
    private func generateAI(_ input: DraftInput, task: LocalTask) {
        aiBusy = true; aiError = nil
        let sessionID = sourceSessionID
        aiJob = Task { @MainActor in
            do {
                let output = try await LocalDraftAI().generate(input: input, model: memory.preferences.model)
                try Task.checkCancellation()
                aiInput = nil; aiBusy = false; state.setEditingTask(false)
                beginDraft(ResumeContent(progress: output.progress, nextStep: output.nextStep, materials: task.latestResume?.content.materials ?? []), task: task)
                sourceIDs = output.evidenceIDs; sourceSessionID = sessionID; draftOrigin = "AI 建议"
            } catch is CancellationError { }
            catch {
                guard !Task.isCancelled else { return }
                aiBusy = false; aiError = error is DraftAIError ? error.localizedDescription : "本机模型暂不可用，可取消并使用本地线索草稿。"
            }
        }
    }
}
