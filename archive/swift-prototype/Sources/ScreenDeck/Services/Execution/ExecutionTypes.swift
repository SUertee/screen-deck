import Foundation

struct RuntimeSafety: Equatable, Sendable {
    let canSend: Bool
    let diagnostic: String
    static let isolationUnavailable = RuntimeSafety(canSend: false, diagnostic: "仅验证服务健康与固定版本，尚未读取模型目录。聊天发送、核对和停止尚未开放；需要先完成受控启动隔离。")
}

struct RuntimeConnectionReport: Equatable, Sendable {
    let version: String
    let providers: [LLMProviderConfig]
    let safety: RuntimeSafety
    init(version: String, providers: [LLMProviderConfig], safety: RuntimeSafety) {
        self.version = version; self.providers = providers; self.safety = safety
    }
}

struct RuntimeSession: Equatable, Sendable {
    let externalSessionID: String
    let directory: String
    init(externalSessionID: String, directory: String) { self.externalSessionID = externalSessionID; self.directory = directory }
}

struct RuntimeSubmissionReceipt: Equatable, Sendable {
    let externalMessageID: String
    init(externalMessageID: String) { self.externalMessageID = externalMessageID }
}

enum RuntimeSessionStatus: String, Codable, Sendable { case idle, busy, retry }

struct RuntimeTextPart: Equatable, Sendable {
    let externalPartID: String
    let text: String
    init(externalPartID: String, text: String) { self.externalPartID = externalPartID; self.text = text }
}

struct RuntimeMessage: Equatable, Sendable {
    let externalMessageID: String
    let externalSessionID: String
    let role: String
    let parts: [RuntimeTextPart]
    let parentMessageID: String?
    let observedModel: ModelSelection?
    let createdAt: Date?
    let completedAt: Date?
    let failure: String?
    var text: String { parts.map(\.text).joined() }
    init(externalMessageID: String, externalSessionID: String, role: String, parts: [RuntimeTextPart] = [], parentMessageID: String? = nil, observedModel: ModelSelection? = nil, createdAt: Date? = nil, completedAt: Date? = nil, failure: String? = nil) {
        self.externalMessageID = externalMessageID; self.externalSessionID = externalSessionID; self.role = role
        self.parts = parts; self.parentMessageID = parentMessageID; self.observedModel = observedModel
        self.createdAt = createdAt; self.completedAt = completedAt; self.failure = failure
    }
}

/// Snapshots replace one part. Deltas append; they are not interchangeable.
enum RuntimeStreamEvent: Equatable, Sendable {
    case messageUpdated(RuntimeMessage)
    case textSnapshot(sessionID: String, messageID: String, partID: String, text: String)
    case textDelta(sessionID: String, messageID: String, partID: String, text: String)
    case statusChanged(sessionID: String, status: RuntimeSessionStatus)
    case failure(sessionID: String, description: String)
    case permissionRequested(sessionID: String, requestID: String)
    case toolDetected(sessionID: String, toolName: String)
    case messageRemoved(sessionID: String, messageID: String)
    case partRemoved(sessionID: String, messageID: String, partID: String)
}
