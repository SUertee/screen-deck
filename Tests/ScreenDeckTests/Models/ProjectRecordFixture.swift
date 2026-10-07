import Foundation
@testable import ScreenDeck

/// Entirely temporary source records. No global store or actual user task data.
struct ProjectRecordFixture {
    let root: URL
    let projectID: String
    var taskURL: URL { root.appendingPathComponent(".screendeck/tasks/task-001.json") }
    var runURL: URL { root.appendingPathComponent(".screendeck/runs/run-20261006-001.json") }
    var projectURL: URL { root.appendingPathComponent(".screendeck/project.json") }

    init(root: URL, projectID: String = "project-11111111-1111-1111-1111-111111111111", name: String = "示例项目") throws {
        self.root = root
        self.projectID = projectID
        for relative in [".screendeck/tasks", ".screendeck/runs", "docs"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(relative), withIntermediateDirectories: true)
        }
        try Data("# 项目说明\n".utf8).write(to: root.appendingPathComponent("docs/guide.md"))
        try write([
            "schema_version": 1, "kind": "project", "project_id": projectID, "name": name,
            "created_at": "2026-10-06T09:00:00+08:00", "timezone": "Asia/Shanghai", "mode": "manual_pilot",
            "references": [["path": "docs/guide.md", "label": "使用说明"]]
        ], to: projectURL)
        try write([
            "schema_version": 1, "kind": "task", "project_id": projectID, "task_id": "task-001",
            "title": "实现项目读取", "goal": "验证真实任务与执行记录", "status": "awaiting_review",
            "plan_version": 2, "assignee": "shared", "created_at": "2026-10-06T09:00:00+08:00",
            "updated_at": "2026-10-06T10:00:00+08:00", "run_ids": ["run-20261006-001"],
            "acceptance": [["id": "user-review", "description": "用户审阅真实记录", "verification": "not_checked", "requires_human": true]],
            "references": [["path": "docs/guide.md", "label": "说明"]]
        ], to: taskURL)
        try write([
            "schema_version": 1, "kind": "run", "project_id": projectID, "task_id": "task-001",
            "run_id": "run-20261006-001", "plan_version": 1, "status": "completed",
            "started_at": NSNull(), "ended_at": "2026-10-06T10:00:00+08:00", "recorded_at": "2026-10-06T10:10:00+08:00",
            "executor": ["agent": "Codex", "model": NSNull(), "effort": NSNull(), "metadata_source": "实际元信息未提供"],
            "skills": [], "summary": "完成读取，尚未用户验收",
            "git": ["commit_status": "none", "commit_ids": [], "push_status": "not_pushed"],
            "references": [["path": "docs/guide.md", "label": "关联资料"]]
        ], to: runURL)
    }

    func write(_ object: [String: Any], to url: URL) throws {
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: url)
    }

    func mutate(_ url: URL, _ change: (inout [String: Any]) -> Void) throws {
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        change(&object)
        try write(object, to: url)
    }
}
