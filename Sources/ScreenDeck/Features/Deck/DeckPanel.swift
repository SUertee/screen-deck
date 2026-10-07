import AppKit
import SwiftUI
import Combine

/// Deck 主窗口：尺寸固定为展开态，所有动效由 SwiftUI 内部完成
/// （收起时窗口透明 + 鼠标穿透，视觉上只剩刘海里那条黑矩形）
final class DeckPanel: NSPanel {
    /// 探出时抽屉多拉出的高度
    static let peekExtension: CGFloat = 26
    /// 展开态面板宽度/高度（也是窗口固定尺寸）
    static let expandedWidth: CGFloat = 440
    static let expandedHeight: CGFloat = 260

    private let state: AppState
    private var cancellables = Set<AnyCancellable>()
    private var hotZone: HotZone?
    private let display = DeckDisplay()

    override var canBecomeKey: Bool { true }

    init(state: AppState, memory: WorkSessionController, onOpenSettings: @escaping () -> Void,
         onOpenWorkbench: @escaping (UUID?) -> Void = { _ in }) {
        self.state = state

        let rect = display.windowFrame

        super.init(contentRect: rect,
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        let hostingView = NSHostingView(rootView: DeckPanelView(
            state: state,
            memory: memory,
            display: display,
            onTogglePanel: { [weak self] in
                self?.toggle()
            },
            onOpenSettings: onOpenSettings,
            onOpenWorkbench: onOpenWorkbench
        ))
        hostingView.sizingOptions = []

        isFloatingPanel = true
        // 层级高于菜单栏（.statusBar=25 > .mainMenu=24），能坐在刘海位置
        level = .statusBar
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        becomesKeyOnlyIfNeeded = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        animationBehavior = .none
        acceptsMouseMovedEvents = true
        contentView = hostingView
        setFrame(display.windowFrame, display: true)
        NotificationCenter.default.publisher(for: NSApplication.didChangeScreenParametersNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.display.refresh()
                self.setFrame(self.display.windowFrame, display: true)
                self.hotZone?.displayDidChange()
            }
            .store(in: &cancellables)

        // 展开时接收点击，收起时鼠标穿透（菜单栏/下方应用不受影响）
        state.$deckState
            .sink { [weak self] newState in
                self?.ignoresMouseEvents = (newState != .expanded)
            }
            .store(in: &cancellables)

        // 全局鼠标热区
        hotZone = HotZone(state: state, hotRect: { [weak self] in self?.display.hotRect ?? .zero }) { [weak self] in
            self?.frame
        }
    }

    // MARK: - 对外控制

    func toggle() {
        guard !state.isEditingTask else { return }
        switch state.deckState {
        case .collapsed, .peeked:
            state.deckState = .expanded
        case .expanded:
            state.deckState = .collapsed
        }
    }

    func show() {
        orderFrontRegardless()
    }

}
