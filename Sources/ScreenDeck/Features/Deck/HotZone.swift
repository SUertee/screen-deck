import AppKit

/// 鼠标热区：严格限定为刘海矩形本身（74×37），鼠标只在刘海上才会触发。
/// 交互节奏（抽屉手感）：
///   1. 鼠标进入刘海 → 立即"探出"（抽屉拉开一条缝，.peeked）
///   2. 停留 0.12s 仍在内 → 完全展开（.expanded）
///   3. 鼠标离开 → 收起：展开态 0.42s 后收起，探出态 0.22s 后收回
/// 同时使用全局与应用内鼠标监听，不需要辅助功能权限。
@MainActor
final class HotZone {
    /// 探出 → 展开的停留判定
    private static let expandDelay: TimeInterval = 0.12
    /// 展开态离开后的收起延迟
    private static let expandCollapseDelay: TimeInterval = 0.42
    /// 探出态离开后的收回延迟
    private static let peekCollapseDelay: TimeInterval = 0.22

    private let state: AppState
    private let panelFrame: () -> NSRect?
    private var monitor: Any?
    private var localMonitor: Any?
    private var expandWork: DispatchWorkItem?
    private var collapseWork: DispatchWorkItem?

    init(state: AppState, panelFrame: @escaping () -> NSRect?) {
        self.state = state
        self.panelFrame = panelFrame

        monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handleMouseMove()
            }
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] event in
            Task { @MainActor [weak self] in
                self?.handleMouseMove()
            }
            return event
        }
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }

    /// 触发区 = 刘海矩形本身（屏幕顶部中央 74×37）
    private func hotRect() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let menuBarH = DeckPanel.menuBarHeight()
        return NSRect(
            x: screen.frame.midX - DeckPanel.notchWidth / 2,
            y: screen.frame.maxY - menuBarH,
            width: DeckPanel.notchWidth,
            height: menuBarH
        )
    }

    private func mouseIsInsideHotZone(_ mouse: NSPoint) -> Bool {
        hotRect().contains(mouse)
    }

    /// 只有已探出/展开时，"面板区域"才算内部（用于保持展开）；
    /// 收起状态下窗口是透明的，其下方区域不应触发展开
    private func mouseIsInsidePanel(_ mouse: NSPoint) -> Bool {
        guard state.deckState == .expanded else { return false }
        return panelFrame()?.insetBy(dx: -10, dy: -10).contains(mouse) ?? false
    }

    private func handleMouseMove() {
        let mouse = NSEvent.mouseLocation // 屏幕坐标，左下角原点
        let inHot = mouseIsInsideHotZone(mouse)
        let inPanel = mouseIsInsidePanel(mouse)
        let inside = inHot || inPanel

        if inside {
            cancelCollapse()

            switch state.deckState {
            case .collapsed:
                state.deckState = .peeked // 抽屉先拉开一条缝
                scheduleExpand()
            case .peeked:
                scheduleExpand() // 已在探出，继续等展开判定
            case .expanded:
                break
            }
        } else {
            cancelExpand()
            if state.isEditingTask {
                cancelCollapse()
            } else {
                scheduleCollapse()
            }
        }
    }

    /// 停留满 expandDelay 且鼠标仍在热区/面板内 → 完全展开
    private func scheduleExpand() {
        guard expandWork == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.expandWork = nil
            let mouse = NSEvent.mouseLocation
            if self.mouseIsInsideHotZone(mouse) || self.mouseIsInsidePanel(mouse) {
                self.state.deckState = .expanded
            }
        }
        expandWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.expandDelay, execute: work)
    }

    private func cancelExpand() {
        expandWork?.cancel()
        expandWork = nil
    }

    private func scheduleCollapse() {
        guard collapseWork == nil else { return }
        let delay: TimeInterval = state.deckState == .peeked
            ? Self.peekCollapseDelay
            : Self.expandCollapseDelay
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.collapseWork = nil
            guard !self.state.isEditingTask else { return }
            let mouse = NSEvent.mouseLocation
            guard !self.mouseIsInsideHotZone(mouse), !self.mouseIsInsidePanel(mouse) else {
                return
            }
            self.state.deckState = .collapsed
        }
        collapseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelCollapse() {
        collapseWork?.cancel()
        collapseWork = nil
    }
}
