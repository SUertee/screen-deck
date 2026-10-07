import XCTest
import SwiftUI
@testable import ScreenDeck

final class TaskInspectorPresentationTests: XCTestCase {
    private let projectID = "project-11111111-1111-1111-1111-111111111111"

    func testVerifiedAcceptanceAndCompletedTaskDoNotInventPlansDecisionsOrDeliveries() {
        let task = makeTask(status: "completed", verification: "verified")
        let presentation = ProjectTaskInspectorPresentation(snapshot: makeSnapshot(tasks: [task]), task: task)
        XCTAssertEqual(presentation.recordedStatus, "已完成")
        XCTAssertEqual(presentation.verifiedAcceptanceCount, 1)
        XCTAssertEqual(presentation.acceptanceSummary, "1 / 1 项已验证")
        XCTAssertFalse(presentation.hasStructuredAssignment)
        XCTAssertFalse(presentation.hasDecisionEvents)
        XCTAssertFalse(presentation.hasFinalDeliveries)
        XCTAssertNil(presentation.latestRun)
        XCTAssertTrue(presentation.runs.isEmpty)
    }

    func testInspectorOnlyIncludesRunsForItsExactProjectAndTaskIdentity() {
        let task = makeTask()
        let own = makeRun()
        let sameTaskOtherProject = makeRun(projectID: "project-22222222-2222-2222-2222-222222222222")
        let otherTask = makeRun(taskID: "task-002")
        let presentation = ProjectTaskInspectorPresentation(
            snapshot: makeSnapshot(tasks: [task], runs: [sameTaskOtherProject, otherTask, own]), task: task)
        XCTAssertEqual(presentation.runs, [own])
        XCTAssertEqual(presentation.latestRun, own)
    }

    func testRelatedEvidenceDeduplicatesPathsWithoutGrantingDeliveryAcceptance() {
        let document = ProjectFileReference(path: "docs/guide.md", label: "项目说明")
        let image = ProjectFileReference(path: ".screendeck/artifacts/layout.png", label: "布局证据")
        let task = makeTask(references: [document])
        let run = makeRun(references: [.init(path: document.path, label: "执行引用"), image])
        let presentation = ProjectTaskInspectorPresentation(snapshot: makeSnapshot(tasks: [task], runs: [run]), task: task)
        XCTAssertEqual(presentation.references, [document, image])
        XCTAssertFalse(presentation.hasFinalDeliveries)
        XCTAssertEqual(presentation.verifiedAcceptanceCount, 0)
    }

    func testLatestSummaryUsesRecordedOrderingWithoutInventingActualTimes() {
        let task = makeTask()
        let earlier = makeRun(runID: "run-20261006-001", recordedAt: "2026-10-06T10:00:00+08:00")
        let later = makeRun(runID: "run-20261006-002", recordedAt: "2026-10-06T11:00:00+08:00")
        let presentation = ProjectTaskInspectorPresentation(snapshot: makeSnapshot(tasks: [task], runs: [earlier, later]), task: task)
        XCTAssertEqual(presentation.runs.map(\.runID), [later.runID, earlier.runID])
        XCTAssertEqual(presentation.latestRun?.recordedAt, later.recordedAt)
        XCTAssertNil(presentation.latestRun?.startedAt)
        XCTAssertNil(presentation.latestRun?.endedAt)
    }

    func testHistoricalRunningMetadataRemainsUnknownAndDoesNotUseDefaultModelOrEffort() {
        let run = makeRun(status: "running")
        let details = ProjectRunInspectorPresentation(run: run)
        XCTAssertEqual(ProjectRecordPresentation.status(run.status), "记录为执行中")
        XCTAssertEqual(details.agent, "Codex")
        XCTAssertEqual(details.model, "未知")
        XCTAssertEqual(details.effort, "未知")
        XCTAssertEqual(details.startedAt, "未记录")
        XCTAssertEqual(details.endedAt, "未记录")
        XCTAssertEqual(details.recordedAt, "10-06 10:10:00 +08:00")
        XCTAssertEqual(details.skills, "未使用")
        XCTAssertEqual(details.commitStatus, "未知")
        XCTAssertEqual(details.pushStatus, "未知")
    }

    func testActualExecutorMetadataIsPresentedVerbatimWithoutTurningItIntoARecommendation() {
        let run = makeRun(executor: .init(agent: "本地执行器", model: "记录模型", effort: "记录强度", metadataSource: "执行器提供"),
                          skills: ["skill-one", "skill-two"], git: .init(commitStatus: "none", commitIDs: [], pushStatus: "not_pushed"))
        let details = ProjectRunInspectorPresentation(run: run)
        XCTAssertEqual(details.agent, "本地执行器")
        XCTAssertEqual(details.model, "记录模型")
        XCTAssertEqual(details.effort, "记录强度")
        XCTAssertEqual(details.skills, "skill-one、skill-two")
        XCTAssertEqual(details.commitStatus, "未提交")
        XCTAssertEqual(details.pushStatus, "未推送")
    }

    @MainActor
    func testHeaderParameterPreservesLegacyInitializerAndSupportsOuterContentTabs() {
        let task = makeTask()
        let snapshot = makeSnapshot(tasks: [task])
        let legacy = ProjectTaskInspectorView(snapshot: snapshot, task: task, tab: .constant(.overview), stale: false,
                                               onClose: {}, onReference: { _ in })
        let embedded = ProjectTaskInspectorView(snapshot: snapshot, task: task, tab: .constant(.assignment), stale: false,
                                                 onClose: {}, onReference: { _ in }, showsWorkspaceHeader: false)
        XCTAssertTrue(legacy.showsWorkspaceHeader)
        XCTAssertFalse(embedded.showsWorkspaceHeader)
    }

    private func makeTask(status: String = "awaiting_review", verification: String = "not_checked",
                          references: [ProjectFileReference] = []) -> ProjectTaskRecord {
        .init(projectID: projectID, taskID: "task-001", title: "项目关联与执行记录展示", goal: "只读展示项目记录", status: status,
              planVersion: 1, assignee: "shared", createdAt: "2026-10-06T09:00:00+08:00", updatedAt: "2026-10-06T10:00:00+08:00",
              runIDs: [], acceptance: [.init(id: "review", description: "人工检查真实来源", verification: verification, requiresHuman: true)],
              references: references)
    }

    private func makeRun(projectID: String? = nil, taskID: String = "task-001", runID: String = "run-20261006-001",
                         status: String = "running", recordedAt: String = "2026-10-06T10:10:00+08:00",
                         executor: ProjectExecutor? = nil, skills: [String] = [], git: ProjectGit? = nil,
                         references: [ProjectFileReference] = []) -> ProjectRunRecord {
        .init(projectID: projectID ?? self.projectID, taskID: taskID, runID: runID, planVersion: 1, status: status,
              startedAt: nil, endedAt: nil, recordedAt: recordedAt,
              executor: executor ?? .init(agent: "Codex", model: nil, effort: nil, metadataSource: "未提供实际元信息"),
              skills: skills, summary: "历史执行记录", git: git ?? .init(commitStatus: "unknown", commitIDs: [], pushStatus: "unknown"),
              references: references)
    }

    private func makeSnapshot(tasks: [ProjectTaskRecord], runs: [ProjectRunRecord] = []) -> ProjectRecordSnapshot {
        .init(rootURL: URL(fileURLWithPath: "/temporary/inspector-fixture"),
              project: .init(projectID: projectID, name: "临时项目", createdAt: "2026-10-06T09:00:00+08:00",
                             timezone: "Asia/Shanghai", mode: "manual_pilot", references: []),
              tasks: tasks, runs: runs, loadedAt: Date(timeIntervalSince1970: 1))
    }
}
