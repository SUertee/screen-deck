import SwiftUI

/// Presentation of source facts only: no status inference, Markdown execution, or executor control.
enum ProjectRecordPresentation {
    static func status(_ value: String) -> String {
        switch value {
        case "draft": return "草稿"
        case "ready": return "待开始"
        case "running": return "记录为执行中"
        case "awaiting_approval": return "待审批"
        case "verifying": return "验证中"
        case "awaiting_review": return "待审阅"
        case "completed": return "已完成"
        case "failed": return "失败"
        case "cancelled": return "已取消"
        case "interrupted": return "已中断"
        default: return value
        }
    }

    static func assignee(_ value: String) -> String {
        switch value {
        case "human": return "人工"
        case "agent": return "Agent"
        case "shared": return "人机协同"
        default: return value
        }
    }

    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: value) { return date }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: value)
    }

    static func time(_ value: String?) -> String {
        guard let value else { return "未记录" }
        guard let date = date(value) else { return value }
        let format = DateFormatter()
        format.locale = Locale(identifier: "zh_CN")
        format.timeZone = TimeZone(identifier: "Asia/Shanghai")
        format.dateFormat = "MM-dd HH:mm:ss"
        return format.string(from: date) + " +08:00"
    }

    static func sortedRuns(_ runs: [ProjectRunRecord]) -> [ProjectRunRecord] {
        runs.sorted {
            let a = date($0.recordedAt) ?? .distantPast
            let b = date($1.recordedAt) ?? .distantPast
            return a == b ? $0.runID > $1.runID : a > b
        }
    }

    static func references(_ references: [ProjectFileReference]) -> [ProjectFileReference] {
        var paths: Set<String> = []
        return references.filter { paths.insert($0.path).inserted }
    }

    static func supportsOpening(_ url: URL) -> Bool {
        url.isFileURL && ["md", "txt", "json", "png", "jpg", "jpeg", "gif", "webp", "pdf"].contains(url.pathExtension.lowercased())
    }
}

struct ProjectTaskCard: View {
    let task: ProjectTaskRecord
    var onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: task.status == "completed" ? "checkmark.circle.fill" : "checklist")
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 7) {
                    Text(task.title).fontWeight(.medium)
                    Text(task.goal).font(.callout).foregroundStyle(WorkbenchStyle.muted).lineLimit(2)
                    HStack(spacing: 8) {
                        Text(ProjectRecordPresentation.status(task.status))
                        Text("· \(task.runIDs.count) 次执行")
                        Text("· \(ProjectRecordPresentation.assignee(task.assignee))")
                    }.font(.caption).foregroundStyle(WorkbenchStyle.muted)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.caption).padding(.top, 4)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .background(WorkbenchStyle.rail, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct ProjectRecordContentView: View {
    let snapshot: ProjectRecordSnapshot?
    let taskID: String?
    let diagnostic: String?
    let stale: Bool
    let isLoading: Bool
    var onRefresh: () -> Void
    var onRelink: () -> Void
    var onSelect: (String) -> Void
    var onDetails: () -> Void
    var onReference: (ProjectFileReference) -> Void

    private var task: ProjectTaskRecord? { snapshot?.tasks.first { $0.taskID == taskID } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let diagnostic {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(stale ? "来源变化，当前显示旧快照" : "项目暂时无法读取", systemImage: "exclamationmark.triangle")
                            .fontWeight(.semibold)
                        Text(diagnostic).font(.callout).textSelection(.enabled)
                        HStack {
                            Button("重新读取", action: onRefresh).disabled(isLoading)
                            Button("重新关联…", action: onRelink).disabled(isLoading)
                        }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(WorkbenchStyle.inset, in: RoundedRectangle(cornerRadius: 12))
                }
                if let snapshot {
                    if let task {
                        taskContent(task, snapshot: snapshot)
                    } else if taskID != nil {
                        Text("这个任务已不在当前项目记录中。").font(.headline)
                        Button("打开现有任务") { onSelectProjectFallback(snapshot) }
                        projectContent(snapshot)
                    } else {
                        projectContent(snapshot)
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text("读取于 \(snapshot.loadedAt.formatted(date: .abbreviated, time: .shortened)) · 手动刷新")
                        Text(snapshot.rootURL.path).textSelection(.enabled)
                    }.font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                } else if diagnostic == nil {
                    Text(isLoading ? "正在读取项目记录…" : "尚无可用的项目记录").foregroundStyle(WorkbenchStyle.muted)
                }
            }.frame(maxWidth: 760, alignment: .leading).padding(28)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func onSelectProjectFallback(_ snapshot: ProjectRecordSnapshot) {
        if let first = snapshot.tasks.first { onSelect(first.taskID) }
        else { onRefresh() }
    }

    private func projectContent(_ snapshot: ProjectRecordSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text(snapshot.project.name).font(.system(size: 28, weight: .semibold))
                Text("\(snapshot.tasks.count) 个任务 · \(snapshot.runs.count) 次执行")
                    .foregroundStyle(WorkbenchStyle.muted)
            }
            ProjectReferenceList(references: snapshot.project.references, disabled: stale, onOpen: onReference)
            VStack(alignment: .leading, spacing: 10) {
                Text("项目任务").font(.headline)
                ForEach(snapshot.tasks, id: \.taskID) { task in
                    ProjectTaskCard(task: task) { onSelect(task.taskID) }
                }
                if snapshot.tasks.isEmpty { Text("项目尚未登记任务。").foregroundStyle(WorkbenchStyle.muted) }
            }
        }
    }

    private func taskContent(_ task: ProjectTaskRecord, snapshot: ProjectRecordSnapshot) -> some View {
        let runs = ProjectRecordPresentation.sortedRuns(snapshot.runs.filter { $0.taskID == task.taskID })
        return VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(snapshot.project.name).font(.caption).foregroundStyle(WorkbenchStyle.muted)
                    Spacer()
                    ProjectRecordStatus(value: task.status)
                }
                Text(task.goal).font(.system(size: 20, weight: .medium)).lineSpacing(5).textSelection(.enabled)
                Text("更新于 \(ProjectRecordPresentation.time(task.updatedAt))")
                    .font(.caption).foregroundStyle(WorkbenchStyle.muted)
            }
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("最近执行").font(.headline)
                    Spacer()
                    Button(action: onDetails) { Text("查看时间线").underline() }.buttonStyle(.plain).font(.callout)
                }
                if let latest = runs.first {
                    ProjectRunSummaryView(run: latest, title: nil, onOpenTask: nil, onReference: onReference, referencesDisabled: stale,
                                          sourceReference: snapshot.recordReference(collection: "runs", id: latest.runID))
                } else {
                    Text("尚未登记执行记录。").foregroundStyle(WorkbenchStyle.muted)
                }
            }
            ProjectReferenceList(references: task.references, disabled: stale, onOpen: onReference)
            Text("项目记录只读；浏览不会开始执行、修改任务或启用屏幕记录。")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
        }
    }
}

/// v1 has task-level intent, acceptance checks and run history, not an editable work plan,
/// independent decision events or approved delivery records. Keep these absences explicit.
struct ProjectTaskInspectorPresentation: Equatable {
    let task: ProjectTaskRecord
    let runs: [ProjectRunRecord]
    let references: [ProjectFileReference]

    init(snapshot: ProjectRecordSnapshot, task: ProjectTaskRecord) {
        self.task = task
        let taskRuns = ProjectRecordPresentation.sortedRuns(snapshot.runs.filter {
            $0.projectID == task.projectID && $0.taskID == task.taskID
        })
        runs = taskRuns
        references = ProjectRecordPresentation.references(task.references + taskRuns.flatMap(\.references))
    }

    var latestRun: ProjectRunRecord? { runs.first }
    var verifiedAcceptanceCount: Int { task.acceptance.filter { $0.verification == "verified" }.count }
    var acceptanceSummary: String { "\(verifiedAcceptanceCount) / \(task.acceptance.count) 项已验证" }
    var recordedStatus: String { ProjectRecordPresentation.status(task.status) }
    var hasStructuredAssignment: Bool { false }
    var hasDecisionEvents: Bool { false }
    var hasFinalDeliveries: Bool { false }
}

struct ProjectRunInspectorPresentation: Equatable {
    let agent: String
    let model: String
    let effort: String
    let recordedAt: String
    let startedAt: String
    let endedAt: String
    let skills: String
    let commitStatus: String
    let pushStatus: String

    init(run: ProjectRunRecord) {
        agent = run.executor.agent
        model = run.executor.model ?? "未知"
        effort = run.executor.effort ?? "未知"
        recordedAt = ProjectRecordPresentation.time(run.recordedAt)
        startedAt = ProjectRecordPresentation.time(run.startedAt)
        endedAt = ProjectRecordPresentation.time(run.endedAt)
        skills = run.skills.isEmpty ? "未使用" : run.skills.joined(separator: "、")
        commitStatus = run.git.commitStatus == "committed" ? "已提交" : run.git.commitStatus == "none" ? "未提交" : "未知"
        pushStatus = run.git.pushStatus == "pushed" ? "已推送" : run.git.pushStatus == "not_pushed" ? "未推送" : "未知"
    }
}

struct ProjectTaskInspectorView: View {
    let snapshot: ProjectRecordSnapshot
    let task: ProjectTaskRecord
    @Binding var tab: TaskInspectorTab
    let stale: Bool
    var diagnostic: String? = nil
    var isLoading = false
    var onRefresh: () -> Void = {}
    var onRelink: () -> Void = {}
    var onClose: () -> Void
    var onReference: (ProjectFileReference) -> Void
    var showsWorkspaceHeader: Bool = true
    @State private var expandedRunID: String?
    @State private var showsFullGoal = false
    @State private var showsAcceptance = false
    @State private var showsAllReferences = false

    private var presentation: ProjectTaskInspectorPresentation {
        ProjectTaskInspectorPresentation(snapshot: snapshot, task: task)
    }
    private var needsGoalDisclosure: Bool { task.goal.count > 80 || task.goal.contains("\n") }

    var body: some View {
        VStack(spacing: 0) {
            if showsWorkspaceHeader {
                HStack {
                    Text("任务详情").font(.system(size: 16, weight: .semibold)); Spacer()
                    Button(action: onClose) { Image(systemName: "xmark") }
                        .buttonStyle(.plain).accessibilityLabel("关闭任务详情")
                }.padding(.horizontal, 20).frame(height: WorkbenchWindowChrome.headerHeight)
                    .background { WorkbenchWindowDragRegion() }
                Divider()
            }
            TaskInspectorNavigationView(tab: $tab)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let diagnostic {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(stale ? "旧快照 · 已失效" : "项目记录暂不可用", systemImage: "exclamationmark.triangle")
                                .fontWeight(.medium)
                            Text(diagnostic).font(.caption).textSelection(.enabled)
                            HStack {
                                Button("重新读取", action: onRefresh).disabled(isLoading)
                                Button("重新关联…", action: onRelink).disabled(isLoading)
                            }
                        }.padding(12).background(WorkbenchStyle.inset, in: RoundedRectangle(cornerRadius: 10))
                    } else if stale {
                        Label("旧快照 · 已失效", systemImage: "exclamationmark.triangle").font(.caption)
                    }
                    switch tab {
                    case .overview: overview
                    case .assignment: assignment
                    case .timeline: timeline
                    case .delivery: delivery
                    }
                    DisclosureGroup("来源信息") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(task.taskID)
                            Text(snapshot.recordReference(collection: "tasks", id: task.taskID))
                            Text("创建：\(task.createdAt)")
                            Text("更新：\(task.updatedAt)")
                            Text(snapshot.project.projectID)
                        }.font(.caption).textSelection(.enabled).padding(.top, 8)
                    }.font(.caption).foregroundStyle(WorkbenchStyle.muted)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            }
        }.background(WorkbenchStyle.surface)
            .onChange(of: task.projectID + ":" + task.taskID) { _, _ in
                expandedRunID = nil
                showsFullGoal = false
                showsAcceptance = false
                showsAllReferences = false
            }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 24) {
            section("目标") {
                Text(task.goal).font(.callout).lineSpacing(4).lineLimit(needsGoalDisclosure ? 4 : nil).textSelection(.enabled)
                if needsGoalDisclosure {
                    DisclosureGroup(isExpanded: $showsFullGoal) {
                        Text(task.goal).font(.callout).lineSpacing(4).textSelection(.enabled).padding(.top, 8)
                    } label: {
                        Text("完整目标").font(.callout)
                    }
                }
            }
            section("当前过程") {
                ProjectRecordField(label: "记录状态", value: presentation.recordedStatus)
                if let latest = presentation.latestRun { runRow(latest) }
                else { Text("尚未登记执行记录。").font(.callout).foregroundStyle(WorkbenchStyle.muted) }
            }
            section("决定") {
                Text("尚未登记独立决定记录。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
                DisclosureGroup(isExpanded: $showsAcceptance) {
                    acceptanceDetails.padding(.top, 10)
                } label: {
                    Text("验收记录 · \(presentation.acceptanceSummary)").font(.callout)
                }
            }
            section("产物与资料") {
                if presentation.references.isEmpty {
                    Text("暂无关联资料或证据。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
                } else {
                    referenceRows(Array(presentation.references.prefix(3)))
                    if presentation.references.count > 3 {
                        DisclosureGroup(isExpanded: $showsAllReferences) {
                            referenceRows(Array(presentation.references.dropFirst(3))).padding(.top, 8)
                        } label: {
                            Text("其余 \(presentation.references.count - 3) 份资料").font(.callout)
                        }
                    }
                    Text("关联资料不等同于最终交付。").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                }
            }
        }
    }

    private var assignment: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("分工尚未登记").font(.system(size: 16, weight: .semibold))
            Text("当前记录未包含逐项工作、执行者与预期结果。")
                .font(.callout).lineSpacing(4).foregroundStyle(WorkbenchStyle.muted)
            Text("验收条目不是执行步骤；拟用模型与分工编辑尚未接入。")
                .font(.caption).lineSpacing(3).foregroundStyle(WorkbenchStyle.muted)
        }.padding(.vertical, 8)
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("执行历史 · 按录入时间排序").font(.system(size: 14, weight: .semibold))
            Text("历史记录不代表当前有进程正在运行。")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
            if presentation.runs.isEmpty {
                Text("暂无执行记录。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(presentation.runs, id: \.runID) { run in
                        runRow(run).padding(.vertical, 14)
                        Divider()
                    }
                }
            }
        }
    }

    private var delivery: some View {
        VStack(alignment: .leading, spacing: 24) {
            section("最终交付") {
                Text("尚未登记最终交付与验收状态。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
            }
            section("资料与证据") {
                referenceRows(presentation.references)
                Text("文件存在不表示已交付、获批或验收通过。")
                    .font(.caption).foregroundStyle(WorkbenchStyle.muted)
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 14, weight: .semibold))
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var acceptanceDetails: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("仅表示验收条目的记录结果，不作为分工或任务进度。")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted).padding(.bottom, 8)
            ForEach(task.acceptance, id: \.id) { acceptance in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: acceptance.verification == "verified" ? "checkmark.circle.fill" : acceptance.verification == "failed" ? "xmark.circle" : "circle")
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(acceptance.description).font(.callout).lineSpacing(3).textSelection(.enabled)
                        Text((acceptance.verification == "verified" ? "已验证" : acceptance.verification == "failed" ? "验证失败" : "未验证") + (acceptance.requiresHuman ? " · 需人工确认" : ""))
                            .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                    }
                }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                Divider()
            }
        }
    }

    private func runRow(_ run: ProjectRunRecord) -> some View {
        let expanded = expandedRunID == run.runID
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                expandedRunID = expanded ? nil : run.runID
            } label: {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("录入：\(ProjectRecordPresentation.time(run.recordedAt))")
                            .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                        Spacer(minLength: 4)
                        Text(ProjectRecordPresentation.status(run.status))
                            .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                    }
                    HStack(alignment: .top, spacing: 10) {
                        Text(run.summary).font(.callout).lineSpacing(3).lineLimit(3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9)).foregroundStyle(WorkbenchStyle.muted).padding(.top, 4)
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("执行记录：\(run.summary)")
                .accessibilityValue(expanded ? "已展开" : "已收起")
                .accessibilityHint("查看或收起历史元信息，不会启动执行")
            if expanded { runDetails(run).padding(.top, 14).padding(.leading, 12) }
        }
    }

    private func runDetails(_ run: ProjectRunRecord) -> some View {
        let details = ProjectRunInspectorPresentation(run: run)
        return VStack(alignment: .leading, spacing: 10) {
            Text(run.summary).font(.callout).lineSpacing(4).textSelection(.enabled)
            if run.status == "running" {
                Text("来源记录为执行中；未连接执行进程。").font(.caption).foregroundStyle(WorkbenchStyle.muted)
            }
            ProjectRecordField(label: "Agent", value: details.agent)
            ProjectRecordField(label: "模型", value: details.model)
            ProjectRecordField(label: "Effort", value: details.effort)
            ProjectRecordField(label: "计划版本", value: "v\(run.planVersion)")
            ProjectRecordField(label: "实际开始", value: details.startedAt)
            ProjectRecordField(label: "实际结束", value: details.endedAt)
            ProjectRecordField(label: "录入时间", value: details.recordedAt)
            ProjectRecordField(label: "Skills", value: details.skills)
            ProjectRecordField(label: "提交", value: details.commitStatus)
            ProjectRecordField(label: "推送", value: details.pushStatus)
            ForEach(run.git.commitIDs, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
            Text(run.executor.metadataSource).font(.caption).foregroundStyle(WorkbenchStyle.muted).textSelection(.enabled)
            Text("来源：\(snapshot.recordReference(collection: "runs", id: run.runID))")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted).textSelection(.enabled)
            if !run.references.isEmpty { referenceRows(ProjectRecordPresentation.references(run.references)) }
        }
    }

    private func referenceRows(_ references: [ProjectFileReference]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(references, id: \.path) { reference in
                Button { onReference(reference) } label: {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: ["png", "jpg", "jpeg", "gif", "webp"].contains(URL(fileURLWithPath: reference.path).pathExtension.lowercased()) ? "photo" : "doc.text")
                        Text(reference.label).multilineTextAlignment(.leading).lineLimit(2)
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right").font(.system(size: 9)).padding(.top, 3)
                    }.font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 9).contentShape(Rectangle())
                }.buttonStyle(.plain).help(reference.path).disabled(stale)
            }
            if references.isEmpty {
                Text("暂无关联资料或证据。").font(.callout).foregroundStyle(WorkbenchStyle.muted)
            }
        }
    }
}

private struct ProjectRecordStatus: View {
    let value: String
    var body: some View {
        Text(ProjectRecordPresentation.status(value)).font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(WorkbenchStyle.inset, in: Capsule())
    }
}

private struct ProjectRecordField: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label).foregroundStyle(WorkbenchStyle.muted)
            Spacer(minLength: 8)
            Text(value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }.font(.callout)
    }
}

struct ProjectReferenceList: View {
    let references: [ProjectFileReference]
    let disabled: Bool
    var onOpen: (ProjectFileReference) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("相关资料").font(.headline)
            ForEach(ProjectRecordPresentation.references(references), id: \.path) { reference in
                Button { onOpen(reference) } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: ["png", "jpg", "jpeg", "gif", "webp"].contains(URL(fileURLWithPath: reference.path).pathExtension.lowercased()) ? "photo" : "doc.text")
                        Text(reference.label).multilineTextAlignment(.leading).lineLimit(2)
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right").font(.system(size: 10))
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }.buttonStyle(.plain).font(.callout).help(reference.path).disabled(disabled)
            }
            if references.isEmpty { Text("暂无关联资料").font(.callout).foregroundStyle(WorkbenchStyle.muted) }
        }
    }
}

struct ProjectRunSummaryView: View {
    let run: ProjectRunRecord
    let title: String?
    var onOpenTask: (() -> Void)?
    var onReference: (ProjectFileReference) -> Void
    var referencesDisabled = false
    var sourceReference: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title, let onOpenTask {
                Button(title, action: onOpenTask).fontWeight(.semibold).buttonStyle(.plain)
            }
            HStack(alignment: .top) {
                Text("录入：\(ProjectRecordPresentation.time(run.recordedAt))")
                    .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                Spacer(minLength: 0)
                ProjectRecordStatus(value: run.status)
            }
            Text(run.summary).font(.callout).lineSpacing(4).textSelection(.enabled)
            if run.status == "running" {
                Text("这是来源文件中的状态，未连接执行进程。").font(.caption).foregroundStyle(WorkbenchStyle.muted)
            }
            DisclosureGroup("执行详情") {
                VStack(alignment: .leading, spacing: 10) {
                    ProjectRecordField(label: "Agent", value: run.executor.agent)
                    ProjectRecordField(label: "模型", value: run.executor.model ?? "未知")
                    ProjectRecordField(label: "Effort", value: run.executor.effort ?? "未知")
                    ProjectRecordField(label: "计划版本", value: "v\(run.planVersion)")
                    ProjectRecordField(label: "开始", value: ProjectRecordPresentation.time(run.startedAt))
                    ProjectRecordField(label: "结束", value: ProjectRecordPresentation.time(run.endedAt))
                    ProjectRecordField(label: "Skills", value: run.skills.isEmpty ? "未使用" : run.skills.joined(separator: "、"))
                    ProjectRecordField(label: "提交", value: run.git.commitStatus == "committed" ? "已提交" : run.git.commitStatus == "none" ? "未提交" : "未知")
                    ProjectRecordField(label: "推送", value: run.git.pushStatus == "pushed" ? "已推送" : run.git.pushStatus == "not_pushed" ? "未推送" : "未知")
                    ForEach(run.git.commitIDs, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
                    Text(run.executor.metadataSource).font(.caption).foregroundStyle(WorkbenchStyle.muted).textSelection(.enabled)
                    Text("来源：\(sourceReference ?? ".screendeck/runs/\(run.runID).json")").font(.caption).textSelection(.enabled)
                    ProjectReferenceList(references: run.references, disabled: referencesDisabled, onOpen: onReference)
                }.padding(.top, 10)
            }.font(.callout)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(WorkbenchStyle.rail, in: RoundedRectangle(cornerRadius: 12))
    }
}
