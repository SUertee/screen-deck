import Foundation

/// 桥服务 /tasks 返回的任务条目
struct TaskItem: Codable, Identifiable, Equatable {
    let line: Int
    let indent: Int
    let text: String
    let done: Bool

    var id: Int { line }
}

/// 桥服务 /tasks 的完整响应
struct TasksPayload: Codable, Equatable {
    let available: Bool?
    let tasks: [TaskItem]?
    let total: Int?
    let done: Int?
    let path: String?
    let section: String?
    let error: String?
}
