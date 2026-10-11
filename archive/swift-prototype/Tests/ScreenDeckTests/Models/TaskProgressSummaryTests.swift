import XCTest
@testable import ScreenDeck

final class TaskProgressSummaryTests: XCTestCase {
    func testEmptyTaskDoesNotInventProgress() {
        let summary = TaskProgressSummary(task: LocalTask(title: "空任务"))
        XCTAssertEqual(summary.totalCount, 0)
        XCTAssertEqual(summary.completedCount, 0)
        XCTAssertNil(summary.fractionCompleted)
        XCTAssertFalse(summary.usesSegmentedProgress)
        XCTAssertFalse(summary.hasPlanDraft)
        XCTAssertNil(summary.nextStep)
    }

    func testProgressUsesManualChecklistOnlyAndPreservesOrder() {
        let children = [Subtask(title: "整理需求", completed: true),
                        Subtask(title: "确认方案"),
                        Subtask(title: "准备素材", completed: true),
                        Subtask(title: "验收")]
        let summary = TaskProgressSummary(task: LocalTask(title: "工作台", subtasks: children))
        XCTAssertEqual(summary.steps.map(\.id), children.map(\.id))
        XCTAssertEqual(summary.steps.map(\.completed), [true, false, true, false])
        XCTAssertEqual(summary.completedCount, 2)
        XCTAssertEqual(summary.totalCount, 4)
        XCTAssertEqual(summary.fractionCompleted, 0.5)
        XCTAssertTrue(summary.usesSegmentedProgress)
    }

    func testCompletedParentDoesNotAutomaticallyCompleteChildren() {
        let task = LocalTask(title: "人工完成", completed: true,
                             subtasks: [Subtask(title: "未确认步骤")])
        let summary = TaskProgressSummary(task: task)
        XCTAssertEqual(summary.completedCount, 0)
        XCTAssertEqual(summary.fractionCompleted, 0)
        XCTAssertFalse(summary.steps[0].completed)
    }

    func testPlanStepsNeverBecomeExecutionEvidenceEvenWithMatchingTitles() {
        let plan = ExecutionPlan(version: 1, steps: [
            PlannedStep(title: "实现界面", executor: .agent, acceptance: "检查通过"),
            PlannedStep(title: "确认范围", executor: .human, acceptance: "人工确认")
        ])
        let task = LocalTask(title: "工作台", subtasks: [Subtask(title: "实现界面", completed: true)], executionPlan: plan)
        let summary = TaskProgressSummary(task: task)
        XCTAssertTrue(summary.hasPlanDraft)
        XCTAssertEqual(summary.plannedStepCount, 2)
        XCTAssertEqual(summary.totalCount, 1)
        XCTAssertEqual(summary.completedCount, 1)

        let planOnly = TaskProgressSummary(task: LocalTask(title: "仅计划", executionPlan: plan))
        XCTAssertTrue(planOnly.steps.isEmpty)
        XCTAssertNil(planOnly.fractionCompleted)
    }

    func testLargeChecklistUsesContinuousProgressWithoutLosingCounts() {
        let children = (0..<40).map { Subtask(title: "步骤 \($0)", completed: $0 < 13) }
        let summary = TaskProgressSummary(task: LocalTask(title: "大任务", subtasks: children))
        XCTAssertEqual(summary.completedCount, 13)
        XCTAssertEqual(summary.totalCount, 40)
        XCTAssertEqual(summary.fractionCompleted, Double(13) / 40)
        XCTAssertFalse(summary.usesSegmentedProgress)
    }

    func testNextStepOnlyComesFromLatestSavedResume() {
        let old = ResumeRecord(id: UUID(), savedAt: Date(timeIntervalSince1970: 1),
                               content: ResumeContent(nextStep: "旧的下一步"))
        let latest = ResumeRecord(id: UUID(), savedAt: Date(timeIntervalSince1970: 2),
                                  content: ResumeContent(nextStep: "检查本地预览"))
        let summary = TaskProgressSummary(task: LocalTask(title: "工作台", resumeRecords: [old, latest]))
        XCTAssertEqual(summary.nextStep, "检查本地预览")
        let whitespace = ResumeRecord(id: UUID(), savedAt: Date(timeIntervalSince1970: 3),
                                      content: ResumeContent(progress: "保存进度", nextStep: " \n"))
        let noNextStep = TaskProgressSummary(task: LocalTask(title: "工作台", resumeRecords: [old, whitespace]))
        XCTAssertNil(noNextStep.nextStep, "Do not resurrect a stale prior next step")
    }
}
