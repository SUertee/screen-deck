import XCTest
@testable import ScreenDeck

final class ExecutionPlanTests: XCTestCase {
    private func step(_ executor: PlannedExecutor = .human) -> PlannedStep {
        PlannedStep(title: "确认页面方向", executor: executor, acceptance: "用户确认文案")
    }

    func testParallelAndDependentStepsValidate() throws {
        let first = step()
        let second = step(.agent)
        var last = step()
        last.dependencies = [first.id, second.id]
        try ExecutionPlan(version: 1, steps: [last, second, first]).validate()
    }

    func testRejectsMissingDuplicateAndSelfDependencies() {
        var value = step()
        value.dependencies = [UUID()]
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [value]).validate())
        value.dependencies = [value.id]
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [value]).validate())
        let parent = step()
        value.dependencies = [parent.id, parent.id]
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [parent, value]).validate())
    }

    func testRejectsCycleEvenWithIndependentStep() {
        var first = step()
        var second = step(.agent)
        first.dependencies = [second.id]
        second.dependencies = [first.id]
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [step(), first, second]).validate())
    }

    func testRejectsInvalidVersionEmptyFieldsAndDuplicateIDs() {
        let valid = step()
        XCTAssertThrowsError(try ExecutionPlan(version: 0, steps: [valid]).validate())
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: []).validate())
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [valid, valid]).validate())
        var invalid = valid
        invalid.title = " \n"
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [invalid]).validate())
        invalid = valid
        invalid.acceptance = "\t"
        XCTAssertThrowsError(try ExecutionPlan(version: 1, steps: [invalid]).validate())
    }

    func testLegacyTaskDecodesWithoutPlan() throws {
        let json = """
        {"schemaVersion":1,"tasks":[{"id":"\(UUID())","title":"旧任务","completed":false}],"defaultPinned":false}
        """
        let workspace = try JSONDecoder().decode(LocalWorkspace.self, from: Data(json.utf8))
        try workspace.validate()
        XCTAssertNil(workspace.tasks[0].executionPlan)
    }

    func testPlanPersistsAndInvalidSavePreservesExistingFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LocalWorkspaceStore(url: directory.appendingPathComponent("workspace.json"))
        let plan = ExecutionPlan(version: 2, steps: [step(), step(.agent)])
        let task = LocalTask(title: "官网任务", executionPlan: plan)
        let workspace = LocalWorkspace(tasks: [task], currentTaskID: task.id)
        try store.save(workspace)
        XCTAssertEqual(try store.load(), workspace)
        var invalid = workspace
        invalid.tasks[0].executionPlan?.version = 0
        XCTAssertThrowsError(try store.save(invalid))
        XCTAssertEqual(try store.load(), workspace)
    }

    func testInvalidStoredPlanIsNotTreatedAsEmptyWorkspace() throws {
        var task = LocalTask(title: "损坏计划")
        task.executionPlan = ExecutionPlan(version: 1, steps: [])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("workspace.json")
        let data = try JSONEncoder().encode(LocalWorkspace(tasks: [task]))
        try data.write(to: url)
        XCTAssertThrowsError(try LocalWorkspaceStore(url: url).load())
        XCTAssertEqual(try Data(contentsOf: url), data)
    }
}
