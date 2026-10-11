import SwiftUI

struct DeckPanelView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var state: AppState
    @ObservedObject var memory: WorkSessionController
    @ObservedObject var display: DeckDisplay
    @State private var addRequest = 0
    let onTogglePanel: () -> Void
    let onOpenSettings: () -> Void
    var onOpenWorkbench: (UUID?) -> Void = { _ in }
    private var expanded: Bool { state.deckState == .expanded }
    private var size: CGSize { DeckMotion.contentSize(hasTasks: !state.tasks.isEmpty) }

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                Color.clear.frame(height: display.menuBarHeight)
                header
                WorkbenchView(state: state, memory: memory, addRequest: addRequest, onOpenSettings: onOpenSettings, onOpenWorkbench: onOpenWorkbench)
            }
            .frame(width: size.width, height: size.height)
            .opacity(expanded ? 1 : 0)
            .animation(.easeOut(duration: reduceMotion ? 0.1 : 0.16)
                .delay(expanded && !reduceMotion ? 0.10 : 0), value: expanded)
            .background(Color.black)
            .mask(alignment: .top) {
                RoundedRectangle(cornerRadius: expanded ? 18 : 11)
                    .frame(width: expanded ? size.width : display.notchWidth,
                           height: expanded ? size.height : display.menuBarHeight)
            }
            .allowsHitTesting(expanded)
            .accessibilityHidden(!expanded)
            RoundedRectangle(cornerRadius: 11).fill(.black)
                .frame(width: display.notchWidth,
                       height: display.menuBarHeight + (state.deckState == .peeked ? 8 : 0))
                .opacity(expanded ? 0 : 1).allowsHitTesting(false)
            if !expanded && memory.activeID != nil {
                Circle().fill(DeckTheme.accent).frame(width: 5, height: 5)
                    .offset(y: display.menuBarHeight - 7).allowsHitTesting(false)
                    .accessibilityLabel("ScreenDeck 正在记录屏幕")
            }
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .environment(\.colorScheme, .dark)
        .foregroundStyle(DeckTheme.text, DeckTheme.secondary)
        .tint(DeckTheme.accent)
        .animation(DeckMotion.transition(to: state.deckState, reduceMotion: reduceMotion), value: state.deckState)

    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("工作台").font(.system(size: 13, weight: .semibold))
            Text(memory.activeID == nil ? "未在记录" : "● 记录中").font(.caption)
                .foregroundStyle(memory.activeID == nil ? DeckTheme.secondary : DeckTheme.accent)
            Spacer()
            Button { onOpenWorkbench(state.currentTaskID) } label: { Image(systemName: "macwindow") }
                .disabled(state.isEditingTask).help("打开主工作台").accessibilityLabel("打开主工作台")
            if memory.activeID != nil {
                Button { _ = memory.pause() } label: { Image(systemName: "pause.circle.fill") }
                    .help("立即停止屏幕记录").accessibilityLabel("立即停止屏幕记录")
            }
            Button { addRequest += 1 } label: { Image(systemName: "plus") }
                .disabled(state.isEditingTask || !state.dataAvailable).help("新建任务").accessibilityLabel("新建任务")
            Button { state.requestedSettingsSection = .general; onOpenSettings() } label: { Image(systemName: "gearshape") }
                .disabled(state.isEditingTask).help("设置").accessibilityLabel("设置")
            Button { state.isPanelPinned.toggle() } label: { Image(systemName: state.isPanelPinned ? "pin.fill" : "pin") }
                .help("固定展开").accessibilityLabel("固定展开")
            Button {
                if !state.isEditingTask { onTogglePanel() }
            } label: { Image(systemName: "chevron.up") }
                .disabled(state.isEditingTask).help("收起").accessibilityLabel("收起")
        }
        .buttonStyle(.borderless).padding(.horizontal, 16).frame(height: 36)
    }

}
