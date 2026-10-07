import Foundation
import Combine

/// Local drafts, not submitted conversations or agent output.
struct LocalConversation: Codable, Equatable, Identifiable {
    var id = UUID()
    var title = "新聊天"
    var createdAt = Date()
    var draft = ""
}

enum WorkbenchRoute: Hashable {
    case newChat, tasks, search, timeline, task(UUID), chat(UUID)
    case project(String, taskID: String?)
}

struct DeckTaskRequest: Equatable {
    var requestID = UUID()
    var taskID: UUID
}

enum TaskInspectorTab: String, CaseIterable {
    case overview = "概览", assignment = "分工", timeline = "时间线", delivery = "交付"
}

/// Browsing is independent of the focused task and of any capture session.
@MainActor
final class WorkbenchNavigation: ObservableObject {
    @Published var sidebarVisible = true
    @Published var route: WorkbenchRoute = .newChat {
        didSet { routingRevision &+= 1 }
    }
    private(set) var routingRevision: UInt = 0
    @Published var inspectorVisible = false
    @Published var inspectorRequestedOnNarrow = false
    @Published var inspectorTab: TaskInspectorTab = .overview

    func openNewChat() {
        route = .newChat
        inspectorVisible = false
        inspectorRequestedOnNarrow = false
    }

    /// Only explicit launch arguments navigate. Async loading must not steal a user's newer selection.
    @discardableResult
    func openLaunchProject(_ id: String, taskID: String?, expectedRevision: UInt) -> Bool {
        guard routingRevision == expectedRevision else { return false }
        route = .project(id, taskID: taskID)
        inspectorVisible = true
        inspectorRequestedOnNarrow = false
        inspectorTab = .overview
        return true
    }

    func openTask(_ id: UUID) {
        route = .task(id)
        inspectorVisible = true
        inspectorRequestedOnNarrow = false
        inspectorTab = .overview
    }

    func showsInspector(at width: CGFloat) -> Bool {
        inspectorVisible && (width >= 1080 || inspectorRequestedOnNarrow)
    }

    func requestInspector(_ tab: TaskInspectorTab = .overview) {
        inspectorVisible = true
        inspectorRequestedOnNarrow = true
        inspectorTab = tab
    }

    func toggleInspector(at width: CGFloat) {
        if showsInspector(at: width) { inspectorVisible = false; inspectorRequestedOnNarrow = false }
        else { requestInspector(inspectorTab) }
    }
}
