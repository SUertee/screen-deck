import AppKit
import SwiftUI
import Combine

/// Deck 主窗口：尺寸固定为展开态，所有动效由 SwiftUI 内部完成
/// （收起时窗口透明 + 鼠标穿透，视觉上只剩刘海里那条黑矩形）
final class DeckPanel: NSPanel {
    /// 刘海宽度（MacBook Pro 14/16" 硬件规格 ≈74pt；MacBook Air ≈126pt）
    static let notchWidth: CGFloat = 74
    /// 探出时抽屉多拉出的高度
    static let peekExtension: CGFloat = 26
    /// 展开态面板宽度/高度（也是窗口固定尺寸）
    static let expandedWidth: CGFloat = 340
    static let expandedHeight: CGFloat = 500

    private let state: AppState
    private var cancellables = Set<AnyCancellable>()
    private var hotZone: HotZone?

    init(state: AppState) {
        self.state = state

        let rect = Self.windowFrame()

        super.init(contentRect: rect,
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered,
                   defer: false)

        let hostingView = NSHostingView(rootView: DeckPanelView(
            state: state,
            onTogglePanel: { [weak self] in
                self?.toggle()
            }
        ))

        isFloatingPanel = true
        // 层级高于菜单栏（.statusBar=25 > .mainMenu=24），能坐在刘海位置
        level = .statusBar
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        becomesKeyOnlyIfNeeded = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        animationBehavior = .none
        contentView = hostingView

        // 展开时接收点击，收起时鼠标穿透（菜单栏/下方应用不受影响）
        state.$deckState
            .sink { [weak self] newState in
                self?.ignoresMouseEvents = (newState != .expanded)
            }
            .store(in: &cancellables)

        // 全局鼠标热区
        hotZone = HotZone(state: state) { [weak self] in
            self?.frame
        }
    }

    // MARK: - 对外控制

    func toggle() {
        switch state.deckState {
        case .collapsed, .peeked:
            state.deckState = .expanded
        case .expanded:
            state.deckState = .collapsed
        }
    }

    func show() {
        setFrame(Self.windowFrame(), display: true)
        orderFrontRegardless()
    }

    // MARK: - 窗口尺寸（固定）

    /// 菜单栏高度（刘海 Mac 上 = 37pt）
    static func menuBarHeight() -> CGFloat {
        guard let screen = NSScreen.main else { return 37 }
        return screen.frame.maxY - screen.visibleFrame.maxY
    }

    static func windowFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        return NSRect(
            x: screen.frame.midX - expandedWidth / 2,
            y: screen.frame.maxY - expandedHeight,
            width: expandedWidth,
            height: expandedHeight
        )
    }
}
