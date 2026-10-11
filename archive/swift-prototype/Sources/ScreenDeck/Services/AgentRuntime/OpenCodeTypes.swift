import Foundation

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
