import AppKit
import SwiftUI

/// Shared geometry for the SwiftUI headings drawn underneath the native titlebar.
enum WorkbenchWindowChrome {
    static let headerHeight: CGFloat = 54
    static let trafficLightReservedWidth: CGFloat = 84
}

/// A full-content window whose native controls share the workbench's first row.
/// AppKit owns the traffic lights; only their normal-window positions are adjusted.
@MainActor
final class WorkbenchWindow: NSWindow {
    private var chromeObservers: [NSObjectProtocol] = []
    private var positioningButtons = false
    private var trafficLightLayoutScheduled = false
    private var changingFullScreen = false

    init(contentRect: NSRect = NSRect(x: 0, y: 0, width: 1280, height: 800)) {
        super.init(contentRect: contentRect,
                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "ScreenDeck"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        titlebarSeparatorStyle = .none
        isReleasedWhenClosed = false
        isMovableByWindowBackground = false
        contentMinSize = NSSize(width: 800, height: 560)
        appearance = NSAppearance(named: .aqua)
        collectionBehavior.insert(.fullScreenPrimary)
        tabbingMode = .disallowed

        // Reserve the full heading height through the public accessory API. An empty
        // NSToolbar would intercept clicks intended for the SwiftUI heading below it.
        let nativeTitlebarHeight = frame.height - contentLayoutRect.height
        let accessory = NSTitlebarAccessoryViewController()
        accessory.layoutAttribute = .bottom
        accessory.automaticallyAdjustsSize = false
        accessory.view = WorkbenchTitlebarPassThroughView(frame: NSRect(
            x: 0, y: 0, width: frame.width,
            height: max(0, WorkbenchWindowChrome.headerHeight - nativeTitlebarHeight)))
        addTitlebarAccessoryViewController(accessory)
        observeChromeLayout()
        positionTrafficLights()
    }

    deinit {
        for observer in chromeObservers { NotificationCenter.default.removeObserver(observer) }
    }

    private var trafficLights: [NSButton] {
        [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap(standardWindowButton)
    }

    private func observeChromeLayout() {
        var observedViews = Set<ObjectIdentifier>()
        for button in trafficLights {
            // AppKit may lay out one native control, or move the entire titlebar,
            // after another control's frame notification has already fired.
            // Finish that layout pass before correcting the group together.
            var current: NSView? = button
            while let view = current {
                if observedViews.insert(ObjectIdentifier(view)).inserted {
                    view.postsFrameChangedNotifications = true
                    view.postsBoundsChangedNotifications = true
                    observe(NSView.frameDidChangeNotification, object: view) { $0.scheduleTrafficLightLayout() }
                    observe(NSView.boundsDidChangeNotification, object: view) { $0.scheduleTrafficLightLayout() }
                }
                current = view.superview
            }
        }
        observe(NSWindow.didResizeNotification, object: self) {
            $0.positionTrafficLights()
            $0.scheduleTrafficLightLayout()
        }
        observe(NSWindow.didBecomeKeyNotification, object: self) { $0.scheduleTrafficLightLayout() }
        for name in [NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification] {
            observe(name, object: self) { $0.changingFullScreen = true }
        }
        for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
            observe(name, object: self) { $0.finishFullScreenTransition() }
        }
    }

    func finishFullScreenTransition() {
        changingFullScreen = false
        positionTrafficLights()
        scheduleTrafficLightLayout()
    }

    override func order(_ place: NSWindow.OrderingMode, relativeTo otherWin: Int) {
        super.order(place, relativeTo: otherWin)
        if place != .out { scheduleTrafficLightLayout() }
    }

    private func scheduleTrafficLightLayout() {
        guard !positioningButtons, !trafficLightLayoutScheduled else { return }
        trafficLightLayoutScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.trafficLightLayoutScheduled = false
            self.positionTrafficLights()
        }
    }

    private func observe(_ name: Notification.Name, object: AnyObject,
                         action: @escaping @MainActor (WorkbenchWindow) -> Void) {
        chromeObservers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                action(self)
            }
        })
    }

    private func positionTrafficLights() {
        guard !positioningButtons, !changingFullScreen, !styleMask.contains(.fullScreen) else { return }
        positioningButtons = true
        defer { positioningButtons = false }
        for (index, button) in trafficLights.enumerated() {
            guard let parent = button.superview else { continue }
            let origin = NSPoint(x: 16 + CGFloat(index) * 20,
                                 y: frame.height - WorkbenchWindowChrome.headerHeight / 2 - button.frame.height / 2)
            let convertedOrigin = parent.convert(origin, from: nil)
            if button.frame.origin != convertedOrigin { button.setFrameOrigin(convertedOrigin) }
        }
    }
}

/// The accessory's enclosing clip view otherwise absorbs clicks even when its
/// child returns nil. Forward hit testing to the real control without reparenting it.
@MainActor
private final class WorkbenchTitlebarPassThroughView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let localPoint = convert(point, from: superview)
        // AppKit includes the clip view's upper boundary in hit testing. Match that
        // boundary so the seam through the middle of the heading has no dead pixel.
        guard localPoint.x >= bounds.minX, localPoint.x <= bounds.maxX,
              localPoint.y >= bounds.minY, localPoint.y <= bounds.maxY,
              let window else { return nil }
        let windowPoint = superview?.convert(point, to: nil) ?? point
        for type: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
            if let button = window.standardWindowButton(type), let parent = button.superview,
               let hit = button.hitTest(parent.convert(windowPoint, from: nil)) { return hit }
        }
        guard let content = window.contentView else { return nil }
        return content.hitTest(content.superview?.convert(windowPoint, from: nil) ?? windowPoint)
    }
}

/// Put behind a header, not above its buttons or over the workbench body.
struct WorkbenchWindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> WorkbenchWindowDragView { WorkbenchWindowDragView() }
    func updateNSView(_ nsView: WorkbenchWindowDragView, context: Context) {}
}

@MainActor
final class WorkbenchWindowDragView: NSView {
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard event.type == .leftMouseDown, let window, window.attachedSheet == nil else { return }
        window.performDrag(with: event)
    }
}
