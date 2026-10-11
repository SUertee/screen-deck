import Foundation

/// Sent history has its own identity; project/task scopes never change task state.
enum SessionScope: Hashable, Sendable, Codable {
    case localChat(UUID)
    case localTask(UUID)
    case project(projectID: String, taskID: String?)

    private enum CodingKeys: String, CodingKey {
        case kind, localChatID = "local_chat_id", localTaskID = "local_task_id"
        case projectID = "project_id", taskID = "task_id"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "local_chat": self = .localChat(try values.decode(UUID.self, forKey: .localChatID))
        case "local_task": self = .localTask(try values.decode(UUID.self, forKey: .localTaskID))
        case "project": self = .project(projectID: try values.decode(String.self, forKey: .projectID),
                                        taskID: try values.decodeIfPresent(String.self, forKey: .taskID))
        default: throw SessionHistoryFailure.invalidRecord
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .localChat(let id):
            try values.encode("local_chat", forKey: .kind)
            try values.encode(id, forKey: .localChatID)
        case .localTask(let id):
            try values.encode("local_task", forKey: .kind)
            try values.encode(id, forKey: .localTaskID)
        case .project(let projectID, let taskID):
            try values.encode("project", forKey: .kind)
            try values.encode(projectID, forKey: .projectID)
            try values.encodeIfPresent(taskID, forKey: .taskID)
        }
    }
}

enum TurnState: String, Codable, Sendable {
    case prepared, submitting, streaming, finished, failed, cancelling, cancelled, unknown
}

enum MessageRole: String, Codable, Sendable { case user, assistant }

/// A round's durable facts. No network stream, Task, cancellation closure or secret is persisted.
struct Turn: Codable, Equatable, Sendable, Identifiable {
    var turnID: UUID = UUID()
    var clientRequestID: UUID = UUID()
    var requestedModel: ModelSelection
    var observedModel: ModelSelection? = nil
    var state: TurnState = .prepared
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
    var draftRevision: Int = 0
    var failure: String? = nil
    var id: UUID { turnID }

    enum CodingKeys: String, CodingKey {
        case turnID = "turn_id", clientRequestID = "client_request_id"
        case requestedModel = "requested_model", observedModel = "observed_model"
        case state, createdAt = "created_at", updatedAt = "updated_at"
        case draftRevision = "draft_revision", failure
    }
}

struct Message: Codable, Equatable, Sendable, Identifiable {
    var messageID: UUID = UUID()
    var turnID: UUID
    var role: MessageRole
    var text: String
    var externalMessageID: String? = nil
    var externalPartID: String? = nil
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
    var id: UUID { messageID }

    enum CodingKeys: String, CodingKey {
        case messageID = "message_id", turnID = "turn_id", role, text
        case externalMessageID = "external_message_id", externalPartID = "external_part_id"
        case createdAt = "created_at", updatedAt = "updated_at"
    }
}

struct RuntimeSessionBinding: Codable, Equatable, Sendable {
    var externalSessionID: String
    var endpoint: URL
    var directory: String
    var compatibleVersion: String
    /// A ScreenDeck connection generation, not a claimed server instance ID.
    var connectionGeneration: UUID

    enum CodingKeys: String, CodingKey {
        case externalSessionID = "external_session_id", endpoint, directory
        case compatibleVersion = "compatible_version", connectionGeneration = "connection_generation"
    }
}

struct Session: Codable, Equatable, Sendable, Identifiable {
    var schemaVersion: Int = 1
    // The Swift name is sessionID; the v1 wire key remains conversation_id.
    var sessionID: UUID = UUID()
    var title: String
    var scope: SessionScope
    var createdAt: Date = Date()
    var updatedAt: Date = Date()
    /// Zero denotes an unsaved record. Stores assign the next revision on successful replacement.
    var revision: Int = 0
    var binding: RuntimeSessionBinding? = nil
    var turns: [Turn] = []
    var messages: [Message] = []
    var id: UUID { sessionID }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", sessionID = "conversation_id", title, scope
        case createdAt = "created_at", updatedAt = "updated_at", revision, binding, turns, messages
    }
}
