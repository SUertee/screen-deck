import XCTest
@testable import ScreenDeck

final class DeckMotionTests: XCTestCase {
    func testResizeLimitsAndScreenBounds() {
        XCTAssertEqual(DeckMotion.clampedSize(CGSize(width: 100, height: 10), screen: CGSize(width: 1440, height: 900)), CGSize(width: 340, height: 160))
        XCTAssertEqual(DeckMotion.clampedSize(CGSize(width: 900, height: 900), screen: CGSize(width: 1440, height: 900)), CGSize(width: 800, height: 640))
        XCTAssertEqual(DeckMotion.clampedSize(CGSize(width: 800, height: 640), screen: CGSize(width: 700, height: 600)), CGSize(width: 668, height: 520))
    }

    func testPanelSizeRoundTripAndLegacyCompatibility() throws {
        let old = Data("{\"schemaVersion\":1,\"tasks\":[],\"defaultPinned\":false}".utf8)
        XCTAssertNil(try JSONDecoder().decode(LocalWorkspace.self, from: old).panelSize)
        var workspace = LocalWorkspace()
        workspace.panelSize = CGSize(width: 600, height: 400)
        try workspace.validate()
        let restored = try JSONDecoder().decode(LocalWorkspace.self, from: JSONEncoder().encode(workspace))
        XCTAssertEqual(restored.panelSize, workspace.panelSize)
        workspace.panelSize = CGSize(width: 1, height: 1)
        XCTAssertThrowsError(try workspace.validate())
    }
    func testPointerFeedbackIsClamped() {
        let size = CGSize(width: 340, height: 500)
        XCTAssertEqual(DeckMotion.highlight(at: CGPoint(x: -100, y: 900), size: size, enabled: true),
                       CGSize(width: -6, height: 3))
        XCTAssertEqual(DeckMotion.highlight(at: CGPoint(x: 900, y: -100), size: size, enabled: true),
                       CGSize(width: 6, height: -3))
    }

    func testCenteredPointerHasNoOffset() {
        XCTAssertEqual(DeckMotion.highlight(at: CGPoint(x: 170, y: 250),
                                             size: CGSize(width: 340, height: 500), enabled: true), .zero)
    }

    func testDisabledOrMissingPointerHasNoOffset() {
        let size = CGSize(width: 340, height: 500)
        XCTAssertEqual(DeckMotion.highlight(at: .zero, size: size, enabled: false), .zero)
        XCTAssertEqual(DeckMotion.highlight(at: nil, size: size, enabled: true), .zero)
        XCTAssertEqual(DeckMotion.highlight(at: .zero, size: .zero, enabled: true), .zero)
    }

    func testEditingAndPinningPreventAutoCollapse() {
        for state in [DeckState.peeked, .expanded] {
            XCTAssertFalse(DeckMotion.allowsAutoCollapse(state: state, editing: true, pinned: false))
            XCTAssertFalse(DeckMotion.allowsAutoCollapse(state: state, editing: false, pinned: true))
            XCTAssertFalse(DeckMotion.allowsAutoCollapse(state: state, editing: true, pinned: true))
            XCTAssertEqual(DeckMotion.allowsAutoCollapse(state: state, editing: false, pinned: false), state == .peeked)
        }
    }

    func testCollapsedStateNeverSchedulesAnotherCollapse() {
        XCTAssertFalse(DeckMotion.allowsAutoCollapse(state: .collapsed, editing: false, pinned: false))
    }

    func testOutsideClickOnlyDismissesUnprotectedExpandedPanel() {
        for state in [DeckState.collapsed, .peeked, .expanded] {
            XCTAssertEqual(DeckMotion.allowsOutsideDismiss(state: state, editing: false, pinned: false), state == .expanded)
            XCTAssertFalse(DeckMotion.allowsOutsideDismiss(state: state, editing: true, pinned: false))
            XCTAssertFalse(DeckMotion.allowsOutsideDismiss(state: state, editing: false, pinned: true))
        }
    }

    func testCreatingFirstTaskDoesNotResizeWindow() {
        XCTAssertEqual(DeckMotion.contentSize(hasTasks: false), CGSize(width: 440, height: 260))
        XCTAssertEqual(DeckMotion.contentSize(hasTasks: true), DeckMotion.contentSize(hasTasks: false))
    }

    func testListHeightGrowsAndCaps() {
        let empty = DeckMotion.listHeight(rows: 0, hasCompleted: false, hasError: false, menuHeight: 37)
        let one = DeckMotion.listHeight(rows: 1, hasCompleted: false, hasError: false, menuHeight: 37)
        XCTAssertGreaterThanOrEqual(empty, 160)
        XCTAssertGreaterThan(one, empty)
        XCTAssertEqual(DeckMotion.listHeight(rows: 100, hasCompleted: true, hasError: true, menuHeight: 37), 360)
        XCTAssertGreaterThan(DeckMotion.listHeight(rows: 0, hasCompleted: true, hasError: false, menuHeight: 37), empty)
    }

    func testTimingLeavesAComfortableReturnWindow() {
        XCTAssertGreaterThan(DeckMotion.expandDelay, 0)
        XCTAssertLessThan(DeckMotion.expandDelay, DeckMotion.peekLeaveDelay)
        XCTAssertGreaterThan(DeckMotion.expandedLeaveDelay, DeckMotion.peekLeaveDelay)
    }
}
