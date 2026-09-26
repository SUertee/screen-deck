import SwiftUI

/// Deck 面板内容（纯 SwiftUI 动效，窗口尺寸恒定）：
/// - 收起态：与系统刘海宽度一致的顶部把手
/// - 探出态：把手轻微延长，保持与顶部连续
/// - 展开态：背景裁切展开；文字和点击位置不缩放、不随鼠标位移
struct DeckPanelView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var state: AppState
    let onTogglePanel: () -> Void

    @State private var hoveredTaskID: Int?
    @State private var editingTaskID: Int?
    @State private var editDraft = ""
    @State private var hoverPoint: CGPoint?
    @State private var confirmClose = false
    @State private var editError: String?
    @FocusState private var focusedTaskID: Int?

    private var isExpanded: Bool { state.deckState == .expanded }
    private var isPeeked: Bool { state.deckState == .peeked }
    private var panelSize: CGSize { DeckMotion.contentSize(hasTasks: !state.tasks.isEmpty) }

    private var highlightOffset: CGSize {
        DeckMotion.highlight(at: hoverPoint,
                             size: CGSize(width: DeckPanel.expandedWidth, height: DeckPanel.expandedHeight),
                             enabled: isExpanded && !reduceMotion && !state.isEditingTask)
    }

    var body: some View {
        ZStack(alignment: .top) {
            // 用 mask 揭开面板，避免纵向缩放导致文字和毛玻璃变形。
            glassPanel
                .mask(alignment: .top) {
                    RoundedRectangle(cornerRadius: isExpanded ? 18 : 11, style: .continuous)
                        .frame(width: isExpanded || reduceMotion ? panelSize.width : DeckPanel.notchWidth,
                               height: isExpanded || reduceMotion
                            ? panelSize.height
                            : DeckPanel.menuBarHeight() + (isPeeked ? 18 : 0))
                }
                .opacity(isExpanded ? 1 : 0)
                .allowsHitTesting(isExpanded)
                .accessibilityHidden(!isExpanded)

            // 顶边保持锚定，探出时只延长把手。
            notchRect
                .opacity(isExpanded ? 0 : 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .frame(width: panelSize.width,
               height: panelSize.height,
               alignment: .top)
        .environment(\.colorScheme, .dark)
        .confirmationDialog("放弃未保存的修改并收起？", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("放弃修改并收起", role: .destructive) { cancelEditing(); onTogglePanel() }
            Button("继续编辑", role: .cancel) { }
        }
        .animation(DeckMotion.transition(to: state.deckState, reduceMotion: reduceMotion), value: state.deckState)
        .onContinuousHover { phase in
            switch phase {
            case .active(let location):
                hoverPoint = location
            case .ended:
                hoverPoint = nil
            }
        }
        .onChange(of: state.deckState) { _, newState in
            if newState != .expanded {
                hoverPoint = nil
                hoveredTaskID = nil
                cancelEditing()
            }
        }
    }

    // MARK: - 刘海矩形

    private var notchRect: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color.black)
            .frame(width: DeckPanel.notchWidth,
                   height: DeckPanel.menuBarHeight() + (isPeeked && !reduceMotion ? 8 : 0))
            .overlay(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(Color.white.opacity(isPeeked ? 0.18 : 0.05), lineWidth: 1)
            )
    }

    // MARK: - 展开面板

    private var glassPanel: some View {
        VStack(spacing: 0) {
            // 顶部刘海把手（占位，保持视觉连续）
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color.black)
                .frame(width: DeckPanel.notchWidth, height: DeckPanel.menuBarHeight())

            VStack(spacing: 0) {
                handleBar
                taskList
                if let editError {
                    Text(editError).font(.caption).foregroundStyle(.orange).padding(.horizontal, 16)
                }
                Color.clear.frame(height: 12)
            }
            .opacity(isExpanded ? 1 : 0)
            .offset(y: isExpanded || reduceMotion ? 0 : -4)
            .animation(.easeOut(duration: reduceMotion ? 0.1 : (isExpanded ? 0.18 : 0.1)), value: isExpanded)
        }
        .frame(width: panelSize.width, height: panelSize.height, alignment: .top)
        .background(glassBackground)
    }

    private var handleBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(red: 0.68, green: 0.55, blue: 1.0))
            Text(state.sectionTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
            Spacer()
            if state.dataAvailable && state.total > 0 {
                Text("已完成 \(state.done) / \(state.total)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.65))
            }
            Button {
                state.isPanelPinned.toggle()
            } label: {
                Image(systemName: state.isPanelPinned ? "pin.fill" : "pin")
                    .frame(width: 24, height: 28)
            }
            .buttonStyle(.plain)
            .foregroundStyle(state.isPanelPinned ? Color.accentColor : .white.opacity(0.6))
            .help(state.isPanelPinned ? "取消固定展开" : "保持展开")
            .accessibilityLabel(state.isPanelPinned ? "取消固定展开" : "保持展开")
            Button { if editingTaskID != nil { confirmClose = true } else { onTogglePanel() } } label: {
                Image(systemName: "chevron.up")
                    .frame(width: 24, height: 28)
            }
            .buttonStyle(.plain)
            .help("收起面板")
            .accessibilityLabel("收起面板")
        }
        .padding(.horizontal, 16)
        .frame(height: 40)
        .contentShape(Rectangle())
    }

    // MARK: - 任务列表

    private var taskList: some View {
        ScrollView {
            if state.tasks.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(state.dataAvailable ? "还没有任务" : "暂时无法读取任务")
                        .font(.system(size: 15, weight: .medium))
                    Text(state.statusMessage)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.6))
                        .fixedSize(horizontal: false, vertical: true)
                    if !state.dataAvailable {
                        Button("重新读取") { state.refresh() }.buttonStyle(.bordered)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 22)
                .padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 6) {
                    ForEach(state.tasks) { task in
                        taskRow(task)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
        }
    }

    private func taskRow(_ task: TaskItem) -> some View {
        HStack(spacing: 8) {
            Button {
                state.toggle(task)
            } label: {
                Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundStyle(task.done
                        ? Color(red: 0.35, green: 0.8, blue: 0.5)
                        : Color.white.opacity(0.5))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.done ? "标记为未完成" : "标记为完成")
            .disabled(editingTaskID != nil || !state.dataAvailable)

            if editingTaskID == task.id {
                TextField("任务内容", text: $editDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white)
                    .focused($focusedTaskID, equals: task.id)
                    .onSubmit { saveEditing(task) }
                    .onExitCommand { cancelEditing() }
            } else {
                Text(indentSpace(task.indent) + task.text)
                    .font(.system(size: 12.5))
                    .foregroundStyle(task.done ? Color.white.opacity(0.45) : .white)
                    .strikethrough(task.done, color: .white.opacity(0.4))
                    .lineLimit(3)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { beginEditing(task) }
            }
            Spacer(minLength: 0)

            HStack(spacing: 8) {
                if editingTaskID == task.id {
                    Button { saveEditing(task) } label: {
                        Image(systemName: "checkmark")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("保存任务")
                    Button { cancelEditing() } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("取消编辑")
                } else {
                    Button { beginEditing(task) } label: {
                        Image(systemName: "pencil")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white.opacity(0.65))
                    }
                    .buttonStyle(.plain)
                    .opacity(hoveredTaskID == task.id ? 1 : 0.45)
                    .help("编辑任务")
                    .accessibilityLabel("编辑任务")
                }
            }
            .frame(width: 44, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .background(Color.white.opacity(hoveredTaskID == task.id || editingTaskID == task.id ? 0.11 : 0.045))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.white.opacity(hoveredTaskID == task.id ? 0.22 : 0.07))
                .allowsHitTesting(false)
        }
        .onHover { isHovering in
            withAnimation(.easeOut(duration: reduceMotion ? 0 : 0.12)) {
                hoveredTaskID = isHovering ? task.id : (hoveredTaskID == task.id ? nil : hoveredTaskID)
            }
        }
    }

    private func beginEditing(_ task: TaskItem) {
        guard state.dataAvailable, editingTaskID == nil else { return }
        editingTaskID = task.id
        editDraft = task.text
        state.setEditingTask(true)
        DispatchQueue.main.async {
            focusedTaskID = task.id
        }
    }

    private func saveEditing(_ task: TaskItem) {
        guard state.updateText(for: task, to: editDraft) else {
            editError = state.statusMessage
            return
        }
        cancelEditing()
    }

    private func cancelEditing() {
        editError = nil
        editingTaskID = nil
        focusedTaskID = nil
        editDraft = ""
        state.setEditingTask(false)
    }

    private func indentSpace(_ level: Int) -> String {
        String(repeating: "  ", count: min(level, 6))
    }

    // MARK: - 玻璃质感

    private var glassBackground: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.black)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
                .padding(.top, DeckPanel.menuBarHeight())
        }
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
