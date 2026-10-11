import SwiftUI
import AppKit

enum SettingsSection: String, CaseIterable, Identifiable {
    case general = "通用", projects = "项目", capture = "屏幕记录", ai = "AI", privacy = "数据与隐私"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .projects: return "folder"
        case .capture: return "display"
        case .ai: return "sparkles"
        case .privacy: return "lock.shield"
        }
    }
}

@MainActor
final class SettingsDraft: ObservableObject {
    @Published var section: SettingsSection = .general
    @Published var value: CapturePreferences
    @Published var saved = false
    private let memory: WorkSessionController
    var isDirty: Bool { value != memory.preferences }
    init(memory: WorkSessionController) { self.memory = memory; value = memory.preferences }
    func discard() { value = memory.preferences; saved = false }
    func save() { saved = memory.savePreferences(value); if saved { value = memory.preferences } }
}

struct DeckSettingsView: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast
    @ObservedObject var state: AppState
    @ObservedObject var memory: WorkSessionController
    @ObservedObject var draft: SettingsDraft
    var projects: ProjectWorkspaceController? = nil
    var onMigrateStorage: (() -> Void)? = nil
    var onClose: () -> Void = {}
    private var palette: DeckTheme.Palette { DeckTheme.palette(scheme) }
    private var secondary: Color { DeckTheme.color(palette.secondary) }
    private var accent: Color { DeckTheme.color(palette.accent) }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        Text(draft.section.rawValue).font(.system(size: 24, weight: .semibold))
                        switch draft.section {
                        case .general: general
                        case .projects:
                            if let projects { ProjectManagementSettings(projects: projects) }
                        case .capture: capture
                        case .ai: ai
                        case .privacy: privacy
                        }
                        if let error = memory.preferencesError {
                            Label(error, systemImage: "exclamationmark.triangle").font(.callout)
                            if !memory.preferencesLoaded {
                                Button("重试读取设置") { memory.loadPreferences(); draft.discard() }
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(26)
                }
                Divider()
                VStack(alignment: .leading, spacing: 12) {
                    Text(!memory.preferencesLoaded ? "设置尚未读取，重试成功后可保存" : (memory.activeID != nil ? "记录中，停止后可保存配置" : (draft.isDirty ? "有未保存的更改" : (draft.saved ? "设置已保存" : "保存设置不会开始记录"))))
                        .font(.caption).foregroundStyle(secondary)
                    HStack(spacing: 12) {
                        Button(draft.isDirty ? "取消" : "返回工作台", action: onClose)
                            .keyboardShortcut(.cancelAction)
                        Spacer()
                        if draft.isDirty { Button("撤销更改") { draft.discard() } }
                        Button("保存设置") { draft.save() }
                            .buttonStyle(DeckPrimaryButtonStyle())
                            .keyboardShortcut("s", modifiers: .command)
                            .disabled(!draft.isDirty || !memory.preferencesLoaded || memory.activeID != nil)
                    }
                }.padding(18)
            }
            .background(DeckTheme.color(palette.surface))
        }
        .foregroundStyle(DeckTheme.color(palette.text)).tint(accent)
        .frame(minWidth: 700, idealWidth: 740, minHeight: 500, idealHeight: 520)
        .background(DeckTheme.color(palette.background))
        .onChange(of: draft.value) { _, _ in draft.saved = false }
        .task { await refreshAvailableDisplays() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refreshAvailableDisplays() }
        }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("设置").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
                    .buttonStyle(.plain)
                    .padding(5)
                    .accessibilityLabel("关闭设置，返回工作台")
                    .help("关闭设置")
            }.padding(.bottom, 18)
            ForEach(SettingsSection.allCases) { section in
                Button { draft.section = section } label: {
                    Label(section.rawValue, systemImage: section.icon)
                        .font(.system(size: 13, weight: draft.section == section ? .semibold : .regular))
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                        .foregroundStyle(draft.section == section ? accent : DeckTheme.color(palette.text))
                        .background(draft.section == section ? DeckTheme.color(palette.selection) : .clear,
                                    in: RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
                    .accessibilityAddTraits(draft.section == section ? .isSelected : [])
            }
            Spacer()
            Text("ScreenDeck · 本地工作台").font(.caption).foregroundStyle(secondary)
        }.padding(16).frame(width: 174)
    }

    private var general: some View {
        VStack(alignment: .leading, spacing: 18) {
            group("快捷 Deck") {
                Toggle("默认固定展开", isOn: Binding(get: { state.defaultPinned }, set: { state.setDefaultPinned($0) }))
                    .disabled(!state.dataAvailable)
                helper("此项即时保存。固定后，点击面板外部不会收起。")
            }
            group("外观") {
                Text("黑白灰 · 统一外观")
                helper("主工作台与设置使用浅色界面；Deck 保持深色外壳，方便随时查看当前任务。")
            }
            if !state.dataAvailable { Label(state.statusMessage, systemImage: "exclamationmark.triangle") }
            if let error = state.operationError { Label(error, systemImage: "exclamationmark.triangle") }
        }
    }

    private var capture: some View {
        VStack(alignment: .leading, spacing: 18) {
            helper("选择记录范围，开始前由你确认。截图可能包含其他应用的敏感内容。")
            group("录屏权限") {
                HStack {
                    Label(memory.permissionGranted ? "已授权" : "未授权", systemImage: memory.permissionGranted ? "checkmark.circle" : "lock")
                    Spacer()
                    if !memory.permissionGranted {
                        Button("授予权限") { memory.requestPermission() }
                    }
                    Button("刷新") { Task { await memory.refreshDisplays() } }.disabled(memory.loadingDisplays)
                }
                if !memory.permissionGranted { helper("在系统设置中允许后返回刷新；系统可能要求重新打开应用。") }
            }
            group("记录哪些屏幕") {
                if memory.loadingDisplays {
                    HStack { ProgressView().controlSize(.small); Text("正在读取可用屏幕…") }
                } else if memory.displays.isEmpty {
                    helper(memory.permissionGranted ? "尚未读取到屏幕，请刷新重试。" : "授权后可以选择屏幕；未授权仍可使用本地任务。")
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 10) {
                    ForEach(memory.displays) { display in
                        Toggle(isOn: Binding(get: { draft.value.displayIDs.contains(display.id) }, set: {
                            if $0 { draft.value.displayIDs.insert(display.id) } else { draft.value.displayIDs.remove(display.id) }
                        })) {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(display.name, systemImage: "display").lineLimit(2)
                                Text("\(display.width) × \(display.height) · ID \(display.id)").font(.caption).foregroundStyle(secondary)
                            }
                        }
                        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(draft.value.displayIDs.contains(display.id) ? DeckTheme.color(palette.selection) : DeckTheme.color(palette.background), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(draft.value.displayIDs.contains(display.id) ? accent : secondary.opacity(contrast == .increased ? 1 : 0.4)))
                    }
                }
                if !draft.value.displayIDs.subtracting(Set(memory.displays.map(\.id))).isEmpty {
                    helper("部分已选屏幕目前不可用，开始记录前需要重新核对。")
                    Button("移除不可用屏幕") { draft.value.displayIDs.formIntersection(Set(memory.displays.map(\.id))) }
                        .disabled(memory.loadingDisplays || !memory.permissionGranted)
                }
                if draft.value.displayIDs.isEmpty { helper("未选择屏幕时不会开始采集。") }
            }.disabled(memory.activeID != nil)
            Picker("采样间隔", selection: $draft.value.interval) {
                ForEach([15.0, 30, 60, 120, 300], id: \.self) { Text("\(Int($0)) 秒").tag($0) }
            }.disabled(memory.activeID != nil)
            helper("间隔越短，截图数量与存储占用越多。仅在任务中点击并确认「开始记录」后采集，不采集摄像头、麦克风或按键。")
            if memory.activeID != nil {
                Label("正在记录；请先停止，再更改记录配置。", systemImage: "record.circle")
                Button("立即停止记录") { _ = memory.pause() }
            }
            if let error = memory.error { Label(error, systemImage: "exclamationmark.triangle").font(.caption) }
        }
    }

    private var ai: some View {
        VStack(alignment: .leading, spacing: 18) {
            group("主聊天 Agent") {
                Label("尚未接入", systemImage: "plug")
                helper("主工作台目前保存本地聊天草稿，还不能发送消息或执行 Agent 任务。这里的 Ollama 配置仅用于接续摘要。")
            }
            group("本地接续摘要 · Ollama") {
                Text("本地模型名称").font(.callout.weight(.medium))
                TextField("例如 qwen3:8b", text: $draft.value.model).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("本地 Ollama 模型名称").disabled(memory.activeID != nil)
                helper("填写已经安装的本地模型，用于整理任务接续摘要。留空时不使用 AI；本应用不会替你下载模型。")
            }
            group("请求边界") {
                Text("127.0.0.1:11434").font(.system(.callout, design: .monospaced))
                helper("只有你预览并确认后，才发送所选任务与文字线索。不会发送截图，也不会自动勾选任务。")
                helper("不要使用云模型。本机服务是否向外转发取决于其配置，localhost 不等于绝对离线。")
            }
        }
    }

    private var privacy: some View {
        VStack(alignment: .leading, spacing: 18) {
            group("本地数据") {
                Text(dataDirectory.path)
                    .font(.caption).textSelection(.enabled)
                Text(memory.configurationFileURL == nil ? "仍使用旧存储；迁移前保留现有设置。" : "用户设置：config.toml")
                    .font(.callout).foregroundStyle(secondary)
                Button("打开数据目录") {
                    let directory = dataDirectory
                    NSWorkspace.shared.open(FileManager.default.fileExists(atPath: directory.path) ? directory : directory.deletingLastPathComponent())
                }
                Button("重新读取任务") { state.refresh() }.disabled(state.isEditingTask)
                if let onMigrateStorage, memory.configurationFileURL == nil {
                    Button("迁移到 ~/.screendeck…", action: onMigrateStorage)
                        .disabled(draft.isDirty || memory.activeID != nil || state.isEditingTask)
                    helper("先检查再确认。保留旧数据备份，完成后刷新工作台；不会移动项目内的历史附件。")
                }
            }
            group("记录与删除") {
                helper("截图与识别文字未加密存储在 WorkSessions。每次会话最多 240 条，退出、休眠或会话离开会停止，不自动恢复。")
                helper("在任务的「记录」页，可将停止的会话移到废纸篓。排除摘要不删除原图；删除会话也不删除已保存的接续卡。")
                if memory.activeID != nil { Button("立即停止记录") { _ = memory.pause() } }
            }
        }
    }

    private func helper(_ text: String) -> some View {
        Text(text).font(.callout).foregroundStyle(secondary).fixedSize(horizontal: false, vertical: true)
    }
    private var dataDirectory: URL {
        memory.configurationFileURL?.deletingLastPathComponent() ?? memory.store.root.deletingLastPathComponent()
    }
    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func refreshAvailableDisplays() async {
        memory.refreshPermission()
        if memory.permissionGranted { await memory.refreshDisplays() }
    }
}
