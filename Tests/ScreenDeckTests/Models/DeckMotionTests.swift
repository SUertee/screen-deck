import XCTest
@testable import ScreenDeck

final class DeckMotionTests: XCTestCase {
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

    func testEmptyDeckIsCompact() {
        XCTAssertEqual(DeckMotion.contentSize(hasTasks: false), CGSize(width: 360, height: 200))
        XCTAssertEqual(DeckMotion.contentSize(hasTasks: true), CGSize(width: 540, height: 300))
    }

    func testTimingLeavesAComfortableReturnWindow() {
        XCTAssertGreaterThan(DeckMotion.expandDelay, 0)
        XCTAssertLessThan(DeckMotion.expandDelay, DeckMotion.peekLeaveDelay)
        XCTAssertGreaterThan(DeckMotion.expandedLeaveDelay, DeckMotion.peekLeaveDelay)
    }
}
