import Foundation
import Combine

/// View-only workspace identity. It is not a task record, plan, or execution grant.
enum TaskWorkspaceScope: Hashable, Sendable {
    case local(UUID)
    case project(String, taskID: String?)
}

struct WorkspaceAttachmentID: Hashable, Sendable {
    let projectID: String
    let taskID: String?
    let relativePath: String
}

struct WorkspaceAttachment: Identifiable, Equatable, Sendable {
    let id: WorkspaceAttachmentID
    let reference: ProjectFileReference
    let preview: ProjectAttachmentPreview
}

struct TaskWorkspaceSession: Equatable {
    var attachments: [WorkspaceAttachment] = []
    var selectedAttachmentID: WorkspaceAttachmentID?
    var selectedAttachment: WorkspaceAttachment? {
        attachments.first { $0.id == selectedAttachmentID }
    }
}

/// Only explicit user actions populate the cache. Rendering never reads files or writes source records.
@MainActor
final class TaskWorkspaceController: ObservableObject {
    static let attachmentLimit = 6
    static let sessionLimit = 8
    static let byteLimit = 64 * 1024 * 1024
    @Published private(set) var sessions: [TaskWorkspaceScope: TaskWorkspaceSession] = [:]
    private var accessOrder: [TaskWorkspaceScope] = []

    func session(for scope: TaskWorkspaceScope) -> TaskWorkspaceSession {
        sessions[scope] ?? TaskWorkspaceSession()
    }

    func showTask(in scope: TaskWorkspaceScope) {
        var session = session(for: scope)
        session.selectedAttachmentID = nil
        publish(session, for: scope)
    }

    func select(_ id: WorkspaceAttachmentID, in scope: TaskWorkspaceScope) {
        var session = session(for: scope)
        guard session.attachments.contains(where: { $0.id == id }) else { return }
        session.selectedAttachmentID = id
        publish(session, for: scope)
    }

    func open(_ attachment: WorkspaceAttachment, in scope: TaskWorkspaceScope) {
        guard scope == .project(attachment.id.projectID, taskID: attachment.id.taskID),
              attachment.reference.path == attachment.id.relativePath else { return }
        var session = session(for: scope)
        if let index = session.attachments.firstIndex(where: { $0.id == attachment.id }) {
            session.attachments[index] = attachment
        } else {
            if session.attachments.count == Self.attachmentLimit { session.attachments.removeFirst() }
            session.attachments.append(attachment)
        }
        session.selectedAttachmentID = attachment.id
        publish(session, for: scope)
    }

    func close(_ id: WorkspaceAttachmentID, in scope: TaskWorkspaceScope) {
        var session = session(for: scope)
        session.attachments.removeAll { $0.id == id }
        if session.selectedAttachmentID == id { session.selectedAttachmentID = nil }
        publish(session, for: scope)
    }

    private func publish(_ session: TaskWorkspaceSession, for scope: TaskWorkspaceScope) {
        accessOrder.removeAll { $0 == scope }
        accessOrder.append(scope)
        while accessOrder.count > Self.sessionLimit {
            sessions.removeValue(forKey: accessOrder.removeFirst())
        }
        sessions[scope] = session
        while cachedBytes > Self.byteLimit, accessOrder.count > 1 {
            sessions.removeValue(forKey: accessOrder.removeFirst())
        }
        while cachedBytes > Self.byteLimit, var current = sessions[scope], current.attachments.count > 1 {
            let removed = current.attachments.removeFirst()
            if current.selectedAttachmentID == removed.id { current.selectedAttachmentID = nil }
            sessions[scope] = current
        }
    }

    private var cachedBytes: Int {
        sessions.values.reduce(0) { total, session in
            total + session.attachments.reduce(0) { $0 + max(0, $1.preview.bytes) }
        }
    }
}
