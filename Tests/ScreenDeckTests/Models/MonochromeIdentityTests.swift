import XCTest
import SwiftUI
@testable import ScreenDeck

final class MonochromeIdentityTests: XCTestCase {
    func testBothPalettesContainOnlyGrayscaleValues() {
        for palette in [DeckTheme.light, DeckTheme.dark] {
            for color in [palette.background, palette.surface, palette.text, palette.secondary,
                          palette.accent, palette.onAccent, palette.selection] {
                XCTAssertEqual((color >> 16) & 255, (color >> 8) & 255)
                XCTAssertEqual((color >> 8) & 255, color & 255)
            }
        }
    }

    func testLogoUsesMirroredHalfDiscsWithNarrowSeam() {
        let rect = CGRect(x: 0, y: 0, width: 11, height: 22)
        let left = HalfDisc().path(in: rect)
        let right = HalfDisc(mirrored: true).path(in: rect)
        XCTAssertEqual(left.boundingRect, rect)
        XCTAssertEqual(right.boundingRect, rect)
        XCTAssertFalse(left.contains(CGPoint(x: 1, y: 1)))
        XCTAssertTrue(left.contains(CGPoint(x: 10.9, y: 1)))
        XCTAssertTrue(right.contains(CGPoint(x: 0.1, y: 1)))
        XCTAssertFalse(right.contains(CGPoint(x: 10, y: 1)))
        XCTAssertTrue(left.contains(CGPoint(x: 1, y: 11)))
        XCTAssertTrue(right.contains(CGPoint(x: 10, y: 11)))
        XCTAssertEqual(ScreenDeckMark.seam, 2)
        // Constrain rather than stretch the half-circle in a taller proposal.
        XCTAssertEqual(HalfDisc().path(in: CGRect(x: 0, y: 0, width: 11, height: 40)).boundingRect.height, 22)
    }
}
