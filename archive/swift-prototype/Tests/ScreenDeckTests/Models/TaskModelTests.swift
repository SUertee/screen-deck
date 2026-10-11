import XCTest
@testable import ScreenDeck

final class TaskModelTests: XCTestCase {
    func testTasksPayloadDecoding() throws {
        let json = """
        {
          "available": true,
          "tasks": [
            {"line": 17, "indent": 0, "text": "编写今日工作日报", "done": false},
            {"line": 19, "indent": 1, "text": "发布知识引用展示", "done": true}
          ],
          "total": 2,
          "done": 1,
          "path": "日记/2026/08/2026-08-20.md",
          "section": "今日主要任务"
        }
        """
        let payload = try JSONDecoder().decode(TasksPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.available, true)
        XCTAssertEqual(payload.tasks?.count, 2)
        XCTAssertEqual(payload.tasks?[1].indent, 1)
        XCTAssertEqual(payload.tasks?[1].done, true)
        XCTAssertEqual(payload.section, "今日主要任务")
        XCTAssertEqual(payload.total, 2)
        XCTAssertEqual(payload.done, 1)
    }

    func testTasksPayloadDecodingWithError() throws {
        let json = """
        {"available": false, "error": "今日日记不存在: 日记/2026/08/2026-08-20.md"}
        """
        let payload = try JSONDecoder().decode(TasksPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.available, false)
        XCTAssertNil(payload.tasks)
        XCTAssertNotNil(payload.error)
    }
}
