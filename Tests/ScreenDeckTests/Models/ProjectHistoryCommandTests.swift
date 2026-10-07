import XCTest
@testable import ScreenDeck

final class ProjectHistoryCommandTests: XCTestCase {
    func testNormalLaunchDoesNotRunMaintenance() {
        XCTAssertNil(ProjectHistoryCommand.run(arguments: ["ScreenDeck", "--open-project", "/tmp/example"]))
    }

    func testExplicitMigrationAndInspectionUseAbsolutePaths() throws {
        let migrate = try ProjectHistoryCommand.parse(arguments: ["ScreenDeck", "--migrate-project-history", "/tmp/example"])
        XCTAssertTrue(migrate.migrate)
        XCTAssertNil(migrate.privateRoot)
        let inspect = try ProjectHistoryCommand.parse(arguments: ["ScreenDeck", "--inspect-project-history", "/tmp/example", "--private-root", "/tmp/history"])
        XCTAssertFalse(inspect.migrate)
        XCTAssertEqual(inspect.privateRoot?.path, "/tmp/history")
    }

    func testRejectsMixedFlagsRelativePathsAndShellExpansion() {
        for arguments in [
            ["ScreenDeck", "--migrate-project-history", "~/example"],
            ["ScreenDeck", "--migrate-project-history", "/tmp/example", "--open-project", "/tmp/other"],
            ["ScreenDeck", "--inspect-project-history", "/tmp/example", "--private-root", "relative"],
            ["ScreenDeck", "--inspect-project-history", "/tmp/example", "extra"]
        ] {
            XCTAssertThrowsError(try ProjectHistoryCommand.parse(arguments: arguments))
        }
    }
}
