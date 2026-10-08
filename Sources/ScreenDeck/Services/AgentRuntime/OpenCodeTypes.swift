import Foundation

/// Provider metadata only. Credentials are references, never API keys or passwords.
struct LLMProviderConfig: Codable, Equatable, Sendable, Identifiable {
    var id: String { providerID }
    let providerID: String
    let name: String
    let models: [ModelDescriptor]
    let defaultModelID: String?
    let credentialReference: String?

    init(providerID: String, name: String, models: [ModelDescriptor], defaultModelID: String? = nil, credentialReference: String? = nil) {
        self.providerID = providerID; self.name = name; self.models = models
        self.defaultModelID = defaultModelID; self.credentialReference = credentialReference
    }

    enum CodingKeys: String, CodingKey {
        case providerID = "provider_id", name, models
        case defaultModelID = "default_model_id", credentialReference = "credential_reference"
    }
}

struct ModelDescriptor: Codable, Equatable, Sendable, Identifiable {
    var id: String { modelID }
    let modelID: String
    let name: String
    let variants: [String]
    init(modelID: String, name: String, variants: [String] = []) {
        self.modelID = modelID; self.name = name; self.variants = variants
    }
    enum CodingKeys: String, CodingKey { case modelID = "model_id", name, variants }
}

struct ModelSelection: Codable, Equatable, Hashable, Sendable {
    let providerID: String
    let modelID: String
    let variant: String?
    init(providerID: String, modelID: String, variant: String? = nil) {
        self.providerID = providerID; self.modelID = modelID; self.variant = variant
    }
    enum CodingKeys: String, CodingKey { case providerID = "provider_id", modelID = "model_id", variant }
}

struct OpenCodeConnectionSettings: Equatable, Sendable {
    let endpoint: URL
    /// A runtime-only directory, never the user's selected project root by default.
    let directory: String
    let username: String
    let agentName: String
    init(endpoint: URL = URL(string: "http://127.0.0.1:4096")!, directory: String, username: String = "opencode", agentName: String = "screendeck-chat") {
        self.endpoint = endpoint; self.directory = directory; self.username = username; self.agentName = agentName
    }
}

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

protocol RuntimeClient: Sendable {
    func connect() async throws -> RuntimeConnectionReport
    func createSession(title: String) async throws -> RuntimeSession
    func session(sessionID: String) async throws -> RuntimeSession
    func sendMessage(sessionID: String, clientRequestID: String, text: String, model: ModelSelection) async throws -> RuntimeSubmissionReceipt
    func messages(sessionID: String) async throws -> [RuntimeMessage]
    func status(sessionID: String) async throws -> RuntimeSessionStatus
    func abort(sessionID: String) async throws
    func rejectPermission(sessionID: String, requestID: String) async throws
    /// Subscription starts when called, before sendMessage; cancellation releases its network task.
    func events(sessionID: String) -> AsyncThrowingStream<RuntimeStreamEvent, Error>
}

enum OpenCodeError: Error, Equatable, LocalizedError {
    case invalidEndpoint, invalidDirectory, authenticationRequired, unsupportedVersion(String)
    case unsafeProfile(String), malformedResponse, responseTooLarge, streamOverflow, streamClosed
    case invalidIdentifier, invalidModel, httpStatus(Int), submissionUnknown
    var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "仅支持明确的 HTTP 回环地址 127.0.0.1 或 [::1]，不接受重定向。"
        case .invalidDirectory: return "需要明确的运行时专用绝对目录。"
        case .authenticationRequired: return "OpenCode 认证失败，请检查服务密码。"
        case .unsupportedVersion(let version): return "OpenCode 版本不受支持：\(version)。当前仅核验 1.18.35。"
        case .unsafeProfile(let diagnostic): return diagnostic
        case .malformedResponse: return "OpenCode 返回了不兼容的协议内容。"
        case .responseTooLarge: return "OpenCode 回复超过协议缓冲上限。"
        case .streamOverflow: return "消息流缓冲已满，请核对会话历史。"
        case .streamClosed: return "消息流已断开，请核对会话状态。"
        case .invalidIdentifier: return "外部会话或消息标识无效。"
        case .invalidModel: return "请选择实际已连接提供商的可用模型。"
        case .httpStatus(let code): return "OpenCode 请求失败（HTTP \(code)）。"
        case .submissionUnknown: return "提交结果未知，请核对会话；不会自动重发。"
        }
    }
}
