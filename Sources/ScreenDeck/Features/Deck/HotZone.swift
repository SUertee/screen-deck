import AppKit
import Combine

/// 鼠标热区：按系统刘海宽度计算，悬停触发，不依赖点击。
/// 交互节奏（抽屉手感）：
///   1. 鼠标进入刘海 → 立即"探出"（抽屉拉开一条缝，.peeked）
///   2. 停留 0.16s 仍在内 → 完全展开（.expanded）
///   3. 鼠标离开仅收回探出态；展开后点击外部收起，编辑/固定时保持。
/// 同时使用全局与应用内鼠标监听，不需要辅助功能权限。
@MainActor
final class HotZone {
    private let state: AppState
    private let panelFrame: () -> NSRect?
    private let hotRect: () -> NSRect
    private var monitor: Any?
    private var localMonitor: Any?
    private var clickMonitor: Any?
    private var localClickMonitor: Any?
    private var expandWork: DispatchWorkItem?
    private var collapseWork: DispatchWorkItem?
    private var cancellables = Set<AnyCancellable>()

    init(state: AppState, hotRect: @escaping () -> NSRect, panelFrame: @escaping () -> NSRect?) {
        self.state = state
        self.panelFrame = panelFrame
        self.hotRect = hotRect

        // Reevaluate after editing/pinning changes even if the mouse is stationary.
        // Published emits before assignment, so deliver on the next main-loop turn.
        state.$isEditingTask.combineLatest(state.$isPanelPinned)
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.cancelCollapse()
                guard self.state.deckState != .collapsed else { return }
                self.handleMouseMove()
            }
            .store(in: &cancellables)
        state.$deckState.dropFirst()
            .sink { [weak self] _ in
                self?.cancelExpand()
                self?.cancelCollapse()
            }
            .store(in: &cancellables)

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
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleOutsideClick() }
        }
        localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
            Task { @MainActor [weak self] in self?.handleOutsideClick() }
            return event
        }
    }

    deinit {
        expandWork?.cancel()
        collapseWork?.cancel()
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        if let localClickMonitor { NSEvent.removeMonitor(localClickMonitor) }
    }

    private func handleOutsideClick() {
        guard DeckMotion.allowsOutsideDismiss(state: state.deckState,
                                               editing: state.isEditingTask,
                                               pinned: state.isPanelPinned),
              let frame = panelFrame(), !frame.contains(NSEvent.mouseLocation) else { return }
        state.deckState = .collapsed
    }

    func displayDidChange() {
        cancelExpand()
        cancelCollapse()
        handleMouseMove()
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
            if !DeckMotion.allowsAutoCollapse(state: state.deckState,
                                             editing: state.isEditingTask,
                                             pinned: state.isPanelPinned) {
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
            guard self.state.deckState == .peeked else { return }
            let mouse = NSEvent.mouseLocation
            if self.mouseIsInsideHotZone(mouse) || self.mouseIsInsidePanel(mouse) {
                self.state.deckState = .expanded
            }
        }
        expandWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + DeckMotion.expandDelay, execute: work)
    }

    private func cancelExpand() {
        expandWork?.cancel()
        expandWork = nil
    }

    private func scheduleCollapse() {
        guard collapseWork == nil,
              DeckMotion.allowsAutoCollapse(state: state.deckState,
                                            editing: state.isEditingTask,
                                            pinned: state.isPanelPinned) else { return }
        let scheduledState = state.deckState
        let delay: TimeInterval = state.deckState == .peeked
            ? DeckMotion.peekLeaveDelay
            : DeckMotion.expandedLeaveDelay
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.collapseWork = nil
            guard self.state.deckState == scheduledState,
                  DeckMotion.allowsAutoCollapse(state: self.state.deckState,
                                                editing: self.state.isEditingTask,
                                                pinned: self.state.isPanelPinned) else { return }
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
