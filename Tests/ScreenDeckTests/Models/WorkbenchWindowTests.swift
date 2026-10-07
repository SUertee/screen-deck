import XCTest
import AppKit
import SwiftUI
@testable import ScreenDeck

final class WorkbenchWindowTests: XCTestCase {
    @MainActor
    private func makeWindow() -> WorkbenchWindow {
        _ = NSApplication.shared
        let window = WorkbenchWindow()
        window.alphaValue = 0
        return window
    }

    @MainActor
    func testContentOccupiesWholeWindowAndKeepsNativeWindowCapabilities() throws {
        let window = makeWindow()
        defer { window.close() }
        window.contentView = NSView()
        window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertTrue(window.styleMask.contains([.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]))
        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titlebarSeparatorStyle, .none)
        XCTAssertEqual(window.contentView?.frame.height, window.frame.height)
        XCTAssertTrue(window.collectionBehavior.contains(.fullScreenPrimary))
        XCTAssertFalse(window.isMovableByWindowBackground)
        XCTAssertTrue(window.isMovable)
        XCTAssertEqual(window.contentMinSize, NSSize(width: 800, height: 560))
        XCTAssertNil(window.toolbar)
        XCTAssertEqual(window.frame.height - window.contentLayoutRect.height,
                       WorkbenchWindowChrome.headerHeight, accuracy: 0.5)
    }

    @MainActor
    func testNativeTrafficLightsStayReachableInsideHeaderAfterResize() throws {
        let window = makeWindow()
        defer { window.close() }
        window.contentView = NSView()
        let buttons = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try XCTUnwrap(window.standardWindowButton($0))
        }
        let originalParents = buttons.map(\.superview)

        for size in [NSSize(width: 800, height: 560), NSSize(width: 1280, height: 800), NSSize(width: 1600, height: 980)] {
            window.setContentSize(size)
            let content = try XCTUnwrap(window.contentView)
            let frameView = try XCTUnwrap(content.superview)
            frameView.layoutSubtreeIfNeeded()
            let header = NSRect(x: 0, y: content.bounds.maxY - WorkbenchWindowChrome.headerHeight,
                                width: WorkbenchWindowChrome.trafficLightReservedWidth,
                                height: WorkbenchWindowChrome.headerHeight)
            for (index, button) in buttons.enumerated() {
                let rect = button.convert(button.bounds, to: content)
                XCTAssertTrue(header.contains(rect), "Native control must remain in the sidebar's reserved header area")
                XCTAssertEqual(content.bounds.maxY - rect.midY, WorkbenchWindowChrome.headerHeight / 2, accuracy: 0.5)
                XCTAssertTrue(button.superview === originalParents[index], "AppKit must retain ownership of native control layout")
                XCTAssertFalse(button.isHidden)
                XCTAssertTrue(button.isEnabled)
                XCTAssertNotNil(button.action)
                let point = content.convert(NSPoint(x: rect.midX, y: rect.midY), to: frameView.superview)
                let hit = frameView.hitTest(point)
                XCTAssertTrue(hit === button || hit?.isDescendant(of: button) == true)
            }
        }
    }

    @MainActor
    func testNativeTrafficLightsRemainAlignedAfterDisplayedWindowLayout() async throws {
        let window = makeWindow()
        defer { window.close() }
        window.contentView = NSView()
        window.orderFrontRegardless()

        let buttons = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try XCTUnwrap(window.standardWindowButton($0))
        }
        let parents = buttons.map(\.superview)

        for size in [NSSize(width: 1000, height: 700), NSSize(width: 1280, height: 800)] {
            window.setContentSize(size)
            // Display and native layout happen after the synchronous setFrame call.
            // The hidden-window geometry test alone does not cover this lifecycle.
            window.contentView?.superview?.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
            let content = try XCTUnwrap(window.contentView)
            let rects = buttons.map { $0.convert($0.bounds, to: content) }
            for (index, rect) in rects.enumerated() {
                XCTAssertEqual(content.bounds.maxY - rect.midY, WorkbenchWindowChrome.headerHeight / 2, accuracy: 0.5)
                XCTAssertEqual(rect.midY, rects[0].midY, accuracy: 0.5)
                XCTAssertTrue(buttons[index].superview === parents[index])
            }
        }
    }

    @MainActor
    func testNativeControlAndParentLayoutChangesRecoverTogether() async throws {
        let window = makeWindow()
        defer { window.close() }
        window.contentView = NSView()
        let buttons = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try XCTUnwrap(window.standardWindowButton($0))
        }
        let titlebar = try XCTUnwrap(buttons[2].superview)
        let originalTitlebarOrigin = titlebar.frame.origin

        // A later native layout may update just the zoom control or its parent.
        // Correct the final group geometry after that pass, not halfway through it.
        buttons[2].setFrameOrigin(NSPoint(x: buttons[2].frame.minX, y: buttons[2].frame.minY + 14))
        titlebar.setFrameOrigin(NSPoint(x: originalTitlebarOrigin.x, y: originalTitlebarOrigin.y + 6))
        try await Task.sleep(for: .milliseconds(50))
        let content = try XCTUnwrap(window.contentView)
        for button in buttons {
            let rect = button.convert(button.bounds, to: content)
            XCTAssertEqual(content.bounds.maxY - rect.midY, WorkbenchWindowChrome.headerHeight / 2, accuracy: 0.5)
        }
        titlebar.setFrameOrigin(originalTitlebarOrigin)
        try await Task.sleep(for: .milliseconds(50))
        for button in buttons {
            let rect = button.convert(button.bounds, to: content)
            XCTAssertEqual(content.bounds.maxY - rect.midY, WorkbenchWindowChrome.headerHeight / 2, accuracy: 0.5)
        }
    }

    @MainActor
    func testTransparentTitlebarPreservesHeaderButtonsAndLimitsDragRegion() throws {
        let window = makeWindow()
        defer { window.close() }
        let content = NSView(frame: NSRect(origin: .zero, size: window.frame.size))
        let headerBottom = content.bounds.maxY - WorkbenchWindowChrome.headerHeight
        let drag = WorkbenchWindowDragView(frame: NSRect(x: 0, y: headerBottom,
                                                        width: content.bounds.width, height: WorkbenchWindowChrome.headerHeight))
        let body = NSView(frame: NSRect(x: 0, y: 0, width: content.bounds.width, height: headerBottom))
        let button = NSButton(title: "任务详情", target: nil, action: nil)
        button.frame = NSRect(x: 1160, y: headerBottom + (WorkbenchWindowChrome.headerHeight - 28) / 2,
                              width: 90, height: 28)
        content.addSubview(body)
        content.addSubview(drag)
        content.addSubview(button)
        window.contentView = content
        let frameView = try XCTUnwrap(content.superview)
        frameView.layoutSubtreeIfNeeded()

        for y in [button.frame.minY + 2, button.frame.midY, button.frame.maxY - 2] {
            let buttonHit = frameView.hitTest(NSPoint(x: 1200, y: y))
            XCTAssertTrue(buttonHit === button || buttonHit?.isDescendant(of: button) == true,
                          "The full header action, including its titlebar seam, must receive clicks")
            XCTAssertTrue(frameView.hitTest(NSPoint(x: 400, y: y)) === drag)
        }
        XCTAssertTrue(frameView.hitTest(NSPoint(x: 400, y: 400)) === body)
        XCTAssertFalse(window.isMovableByWindowBackground)
    }

    @MainActor
    func testSidebarBrandActionSharesHeaderWithoutCoveringNativeControls() throws {
        let window = makeWindow()
        defer { window.close() }
        let content = NSView(frame: NSRect(origin: .zero, size: window.frame.size))
        let headerBottom = content.bounds.maxY - WorkbenchWindowChrome.headerHeight
        let drag = WorkbenchWindowDragView(frame: NSRect(x: 0, y: headerBottom,
                                                        width: 240, height: WorkbenchWindowChrome.headerHeight))
        let name = NSTextField(labelWithString: "ScreenDeck")
        name.font = .systemFont(ofSize: 14, weight: .semibold)
        name.frame = NSRect(x: WorkbenchWindowChrome.trafficLightReservedWidth,
                            y: headerBottom + (WorkbenchWindowChrome.headerHeight - 20) / 2,
                            width: 100, height: 20)
        let collapse = NSButton(title: "", target: nil, action: nil)
        collapse.frame = NSRect(x: 196, y: headerBottom + (WorkbenchWindowChrome.headerHeight - 30) / 2,
                                width: 30, height: 30)
        content.addSubview(drag)
        content.addSubview(name)
        content.addSubview(collapse)
        window.contentView = content
        let frameView = try XCTUnwrap(content.superview)
        frameView.layoutSubtreeIfNeeded()

        let nativeButtons = try [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].map {
            try XCTUnwrap(window.standardWindowButton($0))
        }
        for nativeButton in nativeButtons {
            let rect = nativeButton.convert(nativeButton.bounds, to: content)
            XCTAssertLessThanOrEqual(rect.maxX, WorkbenchWindowChrome.trafficLightReservedWidth)
            XCTAssertFalse(rect.intersects(name.frame))
            XCTAssertFalse(rect.intersects(collapse.frame))
            XCTAssertEqual(rect.midY, collapse.frame.midY, accuracy: 0.5)
            let point = content.convert(NSPoint(x: rect.midX, y: rect.midY), to: frameView.superview)
            let hit = frameView.hitTest(point)
            XCTAssertTrue(hit === nativeButton || hit?.isDescendant(of: nativeButton) == true)
        }
        for y in [collapse.frame.minY + 2, collapse.frame.midY, collapse.frame.maxY - 2] {
            let point = content.convert(NSPoint(x: collapse.frame.midX, y: y), to: frameView.superview)
            let hit = frameView.hitTest(point)
            XCTAssertTrue(hit === collapse || hit?.isDescendant(of: collapse) == true,
                          "The sidebar brand action must stay clickable across the native titlebar seam")
        }
    }

    @MainActor
    func testFullScreenTransitionHandsOffNativeButtonLayoutAndRestoresOnFailure() throws {
        let window = makeWindow()
        defer { window.close() }
        let button = try XCTUnwrap(window.standardWindowButton(.closeButton))
        let initialOrigin = button.frame.origin
        NotificationCenter.default.post(name: NSWindow.willEnterFullScreenNotification, object: window)
        let animationOrigin = NSPoint(x: initialOrigin.x, y: initialOrigin.y + 8)
        button.setFrameOrigin(animationOrigin)
        XCTAssertEqual(button.frame.origin, animationOrigin, "Full-screen animation must retain control of native button placement")
        let delegate = AppDelegate()
        delegate.windowDidFailToEnterFullScreen(window)
        XCTAssertEqual(button.frame.origin, initialOrigin)

        NotificationCenter.default.post(name: NSWindow.willExitFullScreenNotification, object: window)
        button.setFrameOrigin(animationOrigin)
        NotificationCenter.default.post(name: NSWindow.didExitFullScreenNotification, object: window)
        XCTAssertEqual(button.frame.origin, initialOrigin)
    }

    @MainActor
    func testHostingHeaderIgnoresNativeTopInsetWithoutAddingAnotherRow() async throws {
        let window = makeWindow()
        defer { window.close() }
        let marker = NSView()
        let view = VStack(spacing: 0) {
            WorkbenchHeaderMarker(view: marker).frame(height: WorkbenchWindowChrome.headerHeight)
            Color.white
        }.ignoresSafeArea(.container, edges: .top)
        let hosting = NSHostingView(rootView: view)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        hosting.layoutSubtreeIfNeeded()

        let header = marker.convert(marker.bounds, to: hosting)
        XCTAssertEqual(header.height, WorkbenchWindowChrome.headerHeight, accuracy: 0.5)
        let headerTop = hosting.isFlipped ? header.minY : header.maxY
        let contentTop = hosting.isFlipped ? hosting.bounds.minY : hosting.bounds.maxY
        XCTAssertEqual(headerTop, contentTop, accuracy: 0.5, "SwiftUI header must start at the actual window top")
    }

    @MainActor
    func testSwiftUIHeaderActionIsNotCapturedByDragBackground() async throws {
        let window = makeWindow()
        defer { window.close() }
        let view = VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("任务详情") {}.buttonStyle(.borderless).frame(width: 90, height: 28)
            }.padding(.horizontal, 30).frame(height: WorkbenchWindowChrome.headerHeight)
                .background { WorkbenchWindowDragRegion() }
            Color.white
        }.ignoresSafeArea(.container, edges: .top)
        let hosting = NSHostingView(rootView: view)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        let frameView = try XCTUnwrap(hosting.superview)
        frameView.layoutSubtreeIfNeeded()
        let headerMidY = window.frame.height - WorkbenchWindowChrome.headerHeight / 2
        let hit = try XCTUnwrap(frameView.hitTest(NSPoint(x: 1200, y: headerMidY)))
        XCTAssertTrue(hit is NSButton, "A SwiftUI button must receive its header click: \(hit)")
        XCTAssertTrue(frameView.hitTest(NSPoint(x: 400, y: headerMidY)) is WorkbenchWindowDragView)
    }
}

private struct WorkbenchHeaderMarker: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
