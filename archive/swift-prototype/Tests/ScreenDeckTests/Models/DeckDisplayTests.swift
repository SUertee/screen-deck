import XCTest
@testable import ScreenDeck

final class DeckDisplayTests: XCTestCase {
    func testNotchedInternalWinsOverExternalPrimary() {
        XCTAssertEqual(DeckDisplayPolicy.preferredID([
            .init(id: 1, builtIn: false, hasNotch: false),
            .init(id: 2, builtIn: true, hasNotch: true)
        ]), 2)
    }

    func testInternalWithoutNotchAndClamshellFallback() {
        let external = DeckDisplayCandidate(id: 1, builtIn: false, hasNotch: false)
        let internalDisplay = DeckDisplayCandidate(id: 2, builtIn: true, hasNotch: false)
        XCTAssertEqual(DeckDisplayPolicy.preferredID([external, internalDisplay]), 2)
        XCTAssertEqual(DeckDisplayPolicy.preferredID([external]), 1)
        XCTAssertNil(DeckDisplayPolicy.preferredID([]))
    }

    func testReconnectReturnsToNotchedInternal() {
        let external = DeckDisplayCandidate(id: 1, builtIn: false, hasNotch: false)
        let internalDisplay = DeckDisplayCandidate(id: 2, builtIn: true, hasNotch: true)
        XCTAssertEqual(DeckDisplayPolicy.preferredID([external]), 1)
        XCTAssertEqual(DeckDisplayPolicy.preferredID([external, internalDisplay]), 2)
        XCTAssertEqual(DeckDisplayPolicy.preferredID([internalDisplay, external]), 2)
    }
}
