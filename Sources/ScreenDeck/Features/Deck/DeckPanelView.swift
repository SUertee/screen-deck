import SwiftUI

/// Deck 面板内容（纯 SwiftUI 动效，窗口尺寸恒定）：
/// - 收起态：顶部一条 74×37 纯黑矩形（= 刘海本身，视觉无痕）
/// - 探出态：黑矩形下移 12pt（抽屉拉开一条缝）
/// - 展开态：黑矩形隐藏，纸张以顶部为轴纵向铺开
struct DeckPanelView: View {
    @ObservedObject var state: AppState
    let onTogglePanel: () -> Void

    private var isExpanded: Bool { state.deckState == .expanded }
    private var isPeeked: Bool { state.deckState == .peeked }

    var body: some View {
        ZStack(alignment: .top) {
            // 纸张：以顶部为轴纵向"滚开"（唯一的运动方向 = 自上而下）
            glassPanel
                .scaleEffect(x: 1, y: isExpanded ? 1 : 0.05, anchor: .top)
                .opacity(isExpanded ? 1 : 0)
                .allowsHitTesting(isExpanded)

            // 刘海本身：收起时居中，探出时下移一条缝
            notchRect
                .offset(y: isPeeked ? 12 : 0)
                .opacity(isExpanded ? 0 : 1)
        }
        .frame(width: DeckPanel.expandedWidth,
               height: DeckPanel.expandedHeight,
               alignment: .top)
        .environment(\.colorScheme, .dark)
        // 展开：spring（轻快有回弹）；收起：快速 easeOut(0.16)
        .animation(
            isExpanded
                ? .spring(response: 0.32, dampingFraction: 0.9)
                : .easeOut(duration: 0.16),
            value: state.deckState
        )
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

            handleBar
            taskList
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
                            .onTapGesture {
                                state.toggle(task)
                            }
                    }
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func taskRow(_ task: TaskItem) -> some View {
        HStack(spacing: 8) {
            Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 14))
                .foregroundStyle(task.done
                    ? Color(red: 0.35, green: 0.8, blue: 0.5)
                    : Color.white.opacity(0.5))
            Text(indentSpace(task.indent) + task.text)
                .font(.system(size: 12.5))
                .foregroundStyle(task.done ? Color.white.opacity(0.45) : .white)
                .strikethrough(task.done, color: .white.opacity(0.4))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .background(Color.white.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 7))
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
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.22), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
