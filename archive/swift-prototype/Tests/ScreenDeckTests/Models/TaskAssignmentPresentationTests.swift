import XCTest
@testable import ScreenDeck

final class TaskAssignmentPresentationTests: XCTestCase {
    func testEmptyTaskDoesNotCreateAPlanOrManualSteps() {
        let presentation = TaskAssignmentPresentation(task: LocalTask(title: "空任务"))
        XCTAssertNil(presentation.planVersion)
        XCTAssertTrue(presentation.plannedSteps.isEmpty)
        XCTAssertTrue(presentation.manualSteps.isEmpty)
    }

    func testPlanRowsShowAssignmentIntentWithoutExecutionEvidence() {
        let plan = ExecutionPlan(version: 2, steps: [
            PlannedStep(title: "确认范围", executor: .human, acceptance: "范围明确"),
            PlannedStep(title: "实现界面", executor: .agent, acceptance: "界面符合设计")
        ])
        let presentation = TaskAssignmentPresentation(task: LocalTask(title: "工作台", executionPlan: plan))
        XCTAssertEqual(presentation.planVersion, 2)
        XCTAssertEqual(presentation.plannedSteps.map(\.id), plan.steps.map(\.id))
        XCTAssertEqual(presentation.plannedSteps.map(\.executorLabel), ["你", "Agent"])
        XCTAssertEqual(presentation.plannedSteps.map(\.statusLabel), ["待确认", "待确认"])
        XCTAssertEqual(presentation.plannedSteps.map(\.acceptance), ["范围明确", "界面符合设计"])
        XCTAssertTrue(presentation.manualSteps.isEmpty)
    }

    func testCompletedParentDoesNotChangePlanOrUncheckedManualRows() {
        let plan = ExecutionPlan(version: 1, steps: [
            PlannedStep(title: "实现界面", executor: .agent, acceptance: "人工验收")
        ])
        let task = LocalTask(title: "工作台", completed: true,
                             subtasks: [Subtask(title: "等待验收")], executionPlan: plan)
        let presentation = TaskAssignmentPresentation(task: task)
        XCTAssertEqual(presentation.plannedSteps[0].statusLabel, "待确认")
        XCTAssertFalse(presentation.manualSteps[0].completed)
        XCTAssertEqual(presentation.manualSteps[0].statusLabel, "待完成")
    }

    func testSameNamedManualCompletionDoesNotMergeWithPlan() {
        let planStep = PlannedStep(title: "检查结果", executor: .agent, acceptance: "给出验证证据")
        let children = [Subtask(title: "检查结果", completed: true), Subtask(title: "检查结果")]
        let task = LocalTask(title: "工作台", subtasks: children,
                             executionPlan: ExecutionPlan(version: 1, steps: [planStep]))
        let presentation = TaskAssignmentPresentation(task: task)
        XCTAssertEqual(presentation.plannedSteps.count, 1)
        XCTAssertEqual(presentation.manualSteps.count, 2)
        XCTAssertEqual(presentation.plannedSteps[0].statusLabel, "待确认")
        XCTAssertEqual(presentation.manualSteps.map(\.id), children.map(\.id))
        XCTAssertEqual(presentation.manualSteps.map(\.statusLabel), ["已完成", "待完成"])
    }

    func testDependencyLabelsResolveByIDAndDistinguishDuplicateTitles() {
        let first = PlannedStep(title: "核对", executor: .human, acceptance: "范围明确")
        let second = PlannedStep(title: "核对", executor: .human, acceptance: "资料完整")
        let final = PlannedStep(title: "实现", executor: .agent, acceptance: "检查通过",
                                dependencies: [second.id, first.id])
        let task = LocalTask(title: "工作台", executionPlan: ExecutionPlan(version: 1, steps: [first, second, final]))
        let rows = TaskAssignmentPresentation(task: task).plannedSteps
        XCTAssertTrue(rows[0].dependencyLabels.isEmpty)
        XCTAssertEqual(rows[2].dependencyLabels, ["步骤 2 · 核对", "步骤 1 · 核对"])
        XCTAssertFalse(rows[2].dependencyLabels.joined().contains(first.id.uuidString))
        XCTAssertFalse(rows[2].dependencyLabels.joined().contains(second.id.uuidString))
    }

    func testMissingDependencyDoesNotExposeInternalUUIDOrInventItsName() {
        let missingID = UUID()
        let step = PlannedStep(title: "实现", executor: .agent, acceptance: "检查通过", dependencies: [missingID])
        let task = LocalTask(title: "未验证的数据", executionPlan: ExecutionPlan(version: 1, steps: [step]))
        let row = TaskAssignmentPresentation(task: task).plannedSteps[0]
        XCTAssertEqual(row.dependencyLabels, ["依赖步骤不可用"])
        XCTAssertFalse(row.dependencyLabels.joined().contains(missingID.uuidString))
        XCTAssertEqual(row.statusLabel, "待确认")
    }

    func testDisclosureOpensAtMostOneWorkItemAndCanCloseIt() {
        let first = UUID()
        let second = UUID()
        var disclosure = TaskAssignmentDisclosure()
        XCTAssertNil(disclosure.expandedStepID)
        disclosure.toggle(first)
        XCTAssertEqual(disclosure.expandedStepID, first)
        disclosure.toggle(second)
        XCTAssertEqual(disclosure.expandedStepID, second)
        disclosure.toggle(second)
        XCTAssertNil(disclosure.expandedStepID)
    }

    func testDisclosureCanResetOnTaskChangeAndDropsUnavailableSteps() {
        let step = UUID()
        var disclosure = TaskAssignmentDisclosure()
        disclosure.toggle(step)
        disclosure.retainIfAvailable(in: [step])
        XCTAssertEqual(disclosure.expandedStepID, step)
        disclosure.retainIfAvailable(in: [UUID()])
        XCTAssertNil(disclosure.expandedStepID)
        disclosure.toggle(step)
        disclosure.collapse()
        XCTAssertNil(disclosure.expandedStepID)
    }

    func testWorkIdentityAndExecutorAreIndependentFromAcceptanceText() {
        let work = PlannedStep(title: "整理工作台界面", executor: .agent,
                               acceptance: "由你检查布局是否符合预期")
        let task = LocalTask(title: "工作台", executionPlan: ExecutionPlan(version: 1, steps: [work]))
        let row = TaskAssignmentPresentation(task: task).plannedSteps[0]
        XCTAssertEqual(row.title, "整理工作台界面")
        XCTAssertEqual(row.executorLabel, "Agent", "Acceptance wording must not decide ownership")
        XCTAssertEqual(row.acceptance, "由你检查布局是否符合预期")
        XCTAssertEqual(row.statusLabel, "待确认")
    }
}
