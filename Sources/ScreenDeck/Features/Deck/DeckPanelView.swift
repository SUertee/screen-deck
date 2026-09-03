import SwiftUI

/// Deck 面板内容（纯 SwiftUI 动效，窗口尺寸恒定）：
/// - 收起态：顶部一条 74×37 纯黑矩形（= 刘海本身，视觉无痕）
/// - 探出态：黑矩形下移 12pt（抽屉拉开一条缝）
/// - 展开态：黑矩形隐藏，纸张以顶部为轴纵向铺开
struct DeckPanelView: View {
    @ObservedObject var state: AppState
    let onTogglePanel: () -> Void

    @State private var hoveredTaskID: Int?
    @State private var editingTaskID: Int?
    @State private var editDraft = ""
    @State private var hoverPoint: CGPoint?
    @FocusState private var focusedTaskID: Int?

    private var isExpanded: Bool { state.deckState == .expanded }
    private var isPeeked: Bool { state.deckState == .peeked }

    private var magneticOffset: CGSize {
        guard let hoverPoint, isExpanded else { return .zero }
        let x = ((hoverPoint.x / DeckPanel.expandedWidth) - 0.5) * 4
        let y = ((hoverPoint.y / DeckPanel.expandedHeight) - 0.5) * 2
        return CGSize(width: x, height: y)
    }

    private var highlightOffset: CGSize {
        CGSize(width: magneticOffset.width * 5, height: magneticOffset.height * 5)
    }

    var body: some View {
        ZStack(alignment: .top) {
            // 用 mask 揭开面板，避免纵向缩放导致文字和毛玻璃变形。
            glassPanel
                .mask(alignment: .top) {
                    RoundedRectangle(cornerRadius: isExpanded ? 18 : 11, style: .continuous)
                        .frame(height: isExpanded
                            ? DeckPanel.expandedHeight
                            : DeckPanel.menuBarHeight() + (isPeeked ? 18 : 0))
                }
                .scaleEffect(x: isExpanded ? 1 : 0.96, y: 1, anchor: .top)
                .offset(magneticOffset)
                .opacity(isExpanded ? 1 : 0)
                .allowsHitTesting(isExpanded)

            // 刘海本身：收起时居中，探出时下移一条缝
            notchRect
                .scaleEffect(isPeeked ? 1.04 : 1, anchor: .top)
                .offset(y: isPeeked ? 8 : 0)
                .opacity(isExpanded ? 0 : 1)
        }
        .frame(width: DeckPanel.expandedWidth,
               height: DeckPanel.expandedHeight,
               alignment: .top)
        .environment(\.colorScheme, .dark)
        .animation(
            isExpanded
                ? .spring(response: 0.38, dampingFraction: 0.78)
                : .spring(response: 0.28, dampingFraction: 0.9),
            value: state.deckState
        )
        .animation(.spring(response: 0.22, dampingFraction: 0.82), value: magneticOffset)
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
                cancelEditing()
            }
        }
    }

    // MARK: - 刘海矩形

    private var notchRect: some View {
        RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(Color.black)
            .frame(width: DeckPanel.notchWidth, height: DeckPanel.menuBarHeight())
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
                .overlay(
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white.opacity(0.5))
                        .offset(y: 9)
                )

            VStack(spacing: 0) {
                handleBar
                taskList
            }
            .opacity(isExpanded ? 1 : 0)
            .offset(y: isExpanded ? 0 : -8)
            .animation(.easeOut(duration: isExpanded ? 0.2 : 0.1), value: isExpanded)
        }
        .background(glassBackground)
    }

    private var handleBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(red: 0.68, green: 0.55, blue: 1.0))
            Text(state.sectionTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
            Spacer()
            if state.dataAvailable {
                Text("\(state.done)/\(state.total)")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color(red: 0.6, green: 0.8, blue: 1.0))
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .contentShape(Rectangle())
        .onTapGesture { onTogglePanel() }
    }

    // MARK: - 任务列表

    private var taskList: some View {
        ScrollView {
            LazyVStack(spacing: 1) {
                if state.tasks.isEmpty {
                    Text(state.statusMessage)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.vertical, 24)
                } else {
                    ForEach(state.tasks) { task in
                        taskRow(task)
                    }
                }
            }
            .padding(.vertical, 6)
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
                    .lineLimit(1)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { beginEditing(task) }
            }
            Spacer(minLength: 0)

            if editingTaskID == task.id {
                Button { saveEditing(task) } label: {
                    Image(systemName: "checkmark")
                }
                .buttonStyle(.plain)
                Button { cancelEditing() } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
            } else if hoveredTaskID == task.id {
                Button { beginEditing(task) } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.65))
                }
                .buttonStyle(.plain)
                .transition(.opacity.combined(with: .scale(scale: 0.85)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .onHover { isHovering in
            withAnimation(.easeOut(duration: 0.12)) {
                hoveredTaskID = isHovering ? task.id : (hoveredTaskID == task.id ? nil : hoveredTaskID)
            }
        }
    }

    private func beginEditing(_ task: TaskItem) {
        editingTaskID = task.id
        editDraft = task.text
        state.setEditingTask(true)
        DispatchQueue.main.async {
            focusedTaskID = task.id
        }
    }

    private func saveEditing(_ task: TaskItem) {
        guard state.updateText(for: task, to: editDraft) else { return }
        cancelEditing()
    }

    private func cancelEditing() {
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
                .fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [.white.opacity(0.18), .white.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .center
                    )
                )
                .offset(highlightOffset)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
