import Foundation

/// Fixed v1.18.35 adapter. Connecting does not create a session or call a model.
/// HTTP-visible settings cannot attest the server's environment / discovered AGENTS.
/// Until a ScreenDeck-owned startup proof exists, this client stays diagnostic-only.
final class OpenCodeClient: RuntimeClient, @unchecked Sendable {
    static let compatibleVersion = "1.18.35"
    // Contract provenance: anomalyco/opencode commit 53d1eabb61e21162157817bf677da0a4ad3332e3,
    // packages/sdk/openapi.json. The adapter is ScreenDeck-authored, not copied runtime code.
    let settings: OpenCodeConnectionSettings
    private let password: String
    private let transport: URLSession
    private let state = ConnectionState()
    private let maximumResponseBytes = 8 * 1024 * 1024

    private actor ConnectionState {
        var report: RuntimeConnectionReport?
        func set(_ value: RuntimeConnectionReport?) { report = value }
        func get() -> RuntimeConnectionReport? { report }
    }

    private final class TransportDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            // Reject every redirect, including same-origin redirects, so credentials never follow one.
            completionHandler(nil)
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    init(settings: OpenCodeConnectionSettings, password: String, configuration: URLSessionConfiguration = .ephemeral) throws {
        try Self.validateEndpoint(settings.endpoint)
        guard settings.directory.hasPrefix("/"), !settings.directory.contains("\0"), !settings.directory.contains("\n"), !settings.directory.contains("\r"),
              !settings.directory.split(separator: "/").contains("..") else { throw OpenCodeError.invalidDirectory }
        guard !password.isEmpty, !settings.username.isEmpty, !settings.username.contains(":"),
              !settings.username.contains("\n"), !settings.username.contains("\r"), !settings.username.contains("\0") else { throw OpenCodeError.authenticationRequired }
        self.settings = settings; self.password = password
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        configuration.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0,
                                                    "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0]
        transport = URLSession(configuration: configuration, delegate: TransportDelegate(), delegateQueue: nil)
    }

    deinit { transport.invalidateAndCancel() }

    static func validateEndpoint(_ endpoint: URL) throws {
        guard let components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false), components.scheme == "http",
              ["127.0.0.1", "[::1]", "::1"].contains(components.host ?? ""),
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              ["", "/"].contains(components.path), let port = components.port, (1...65535).contains(port) else { throw OpenCodeError.invalidEndpoint }
    }

    func connect() async throws -> RuntimeConnectionReport {
        await state.set(nil)
        let health = try await object(path: "/global/health", scoped: false)
        guard health["healthy"] as? Bool == true, let version = health["version"] as? String,
              !version.isEmpty, version.utf8.count <= 64,
              version.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [43, 45, 46].contains($0) }) else { throw OpenCodeError.malformedResponse }
        guard version == Self.compatibleVersion else { throw OpenCodeError.unsupportedVersion(version) }
        // Even instance-scoped GET /config, /agent and /provider can initialize discovered
        // plugins, skills and npm dependencies before their response is available.
        // No ScreenDeck-owned startup proof exists in task-012, so do not touch them yet.
        let report = RuntimeConnectionReport(version: version, providers: [], safety: .isolationUnavailable)
        await state.set(report)
        return report
    }

    func createSession(title: String) async throws -> RuntimeSession {
        try await requireSendPermission()
        guard title.utf8.count <= 600 else { throw OpenCodeError.responseTooLarge }
        let body: [String: Any] = ["title": title, "agent": settings.agentName,
                                  "permission": [["permission": "*", "pattern": "*", "action": "deny"]]]
        let object = try await object(path: "/session", method: "POST", body: body)
        return try Self.sessionValue(object, expectedDirectory: settings.directory)
    }

    func session(sessionID: String) async throws -> RuntimeSession {
        try await requireConnected()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        let object = try await object(path: "/session/\(sessionID)")
        let value = try Self.sessionValue(object, expectedDirectory: settings.directory)
        guard value.externalSessionID == sessionID else { throw OpenCodeError.malformedResponse }
        return value
    }

    func sendMessage(sessionID: String, clientRequestID: String, text: String, model: ModelSelection) async throws -> RuntimeSubmissionReceipt {
        try await requireSendPermission()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        guard let requestUUID = UUID(uuidString: clientRequestID), !text.isEmpty, text.utf8.count <= 128 * 1024 else { throw OpenCodeError.invalidIdentifier }
        guard let report = await state.get(), report.providers.contains(where: { provider in
            provider.providerID == model.providerID && provider.models.contains(where: { descriptor in
                descriptor.modelID == model.modelID && (model.variant == nil || descriptor.variants.contains(model.variant!))
            })
        }) else { throw OpenCodeError.invalidModel }
        // A stable external message ID supports query reconciliation; it is not an exactly-once claim.
        let messageID = "msg" + requestUUID.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var body: [String: Any] = ["messageID": messageID, "agent": settings.agentName,
                                  "model": ["providerID": model.providerID, "modelID": model.modelID],
                                  "parts": [["type": "text", "text": text]]]
        if let variant = model.variant { body["variant"] = variant }
        do {
            _ = try await request(path: "/session/\(sessionID)/prompt_async", method: "POST", body: body, expectedStatus: 204)
            return RuntimeSubmissionReceipt(externalMessageID: messageID)
        } catch let error as OpenCodeError {
            if case .httpStatus(let status) = error, status >= 500 { throw OpenCodeError.submissionUnknown }
            if error == .responseTooLarge || error == .malformedResponse { throw OpenCodeError.submissionUnknown }
            throw error
        }
        catch { throw OpenCodeError.submissionUnknown }
    }

    func messages(sessionID: String) async throws -> [RuntimeMessage] {
        try await requireConnected()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        guard let entries = try await json(path: "/session/\(sessionID)/message") as? [[String: Any]], entries.count <= 2048 else { throw OpenCodeError.malformedResponse }
        return try entries.map { entry in
            guard let info = entry["info"] as? [String: Any], let parts = entry["parts"] as? [[String: Any]] else { throw OpenCodeError.malformedResponse }
            return try OpenCodeEventMapper.message(info: info, parts: parts, expectedSessionID: sessionID)
        }
    }

    func status(sessionID: String) async throws -> RuntimeSessionStatus {
        try await requireConnected()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        // Query the session first: a missing entry in status alone is not proof that it still exists.
        _ = try await session(sessionID: sessionID)
        let statuses = try await object(path: "/session/status")
        guard let value = statuses[sessionID] else { return .idle }
        guard let object = value as? [String: Any], let raw = object["type"] as? String,
              let status = RuntimeSessionStatus(rawValue: raw) else { throw OpenCodeError.malformedResponse }
        return status
    }

    func abort(sessionID: String) async throws {
        try await requireConnected()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        let result = try await json(path: "/session/\(sessionID)/abort", method: "POST", body: [:])
        guard result as? Bool == true else { throw OpenCodeError.malformedResponse }
        // Caller must query status before declaring generation stopped.
    }

    func rejectPermission(sessionID: String, requestID: String) async throws {
        try await requireConnected()
        try Self.validateIdentifier(sessionID, prefix: "ses")
        try Self.validateIdentifier(requestID, prefix: "per")
        let result = try await json(path: "/permission/\(requestID)/reply", method: "POST", body: ["reply": "reject"])
        guard result as? Bool == true else { throw OpenCodeError.malformedResponse }
    }

    func events(sessionID: String) -> AsyncThrowingStream<RuntimeStreamEvent, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(256)) { continuation in
            let task = Task { [weak self] in
                guard let self else { continuation.finish(); return }
                do {
                    try await self.requireConnected()
                    try Self.validateIdentifier(sessionID, prefix: "ses")
                    var request = try self.makeRequest(path: "/event")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    // Long-lived SSE still has a bounded inactivity timeout; disconnect is visible.
                    request.timeoutInterval = 90
                    let (bytes, response) = try await self.transport.bytes(for: request)
                    try self.checkResponse(response)
                    guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else { throw OpenCodeError.malformedResponse }
                    var decoder = OpenCodeSSEDecoder()
                    var mapper = OpenCodeEventMapper(sessionID: sessionID)
                    var chunk = Data()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        chunk.append(byte)
                        guard byte == 10 || byte == 13 || chunk.count >= 4096 else { continue }
                        let frames = try decoder.append(chunk)
                        chunk.removeAll(keepingCapacity: true)
                        for frame in frames {
                            guard let event = try mapper.map(frame) else { continue }
                            switch continuation.yield(event) {
                            case .dropped: throw OpenCodeError.streamOverflow
                            case .terminated: return
                            case .enqueued: break
                            @unknown default: throw OpenCodeError.streamOverflow
                            }
                        }
                    }
                    throw OpenCodeError.streamClosed
                } catch is CancellationError { continuation.finish() }
                catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { @Sendable _ in task.cancel() }
        }
    }

    private func requireConnected() async throws {
        // Query/recovery/control methods are instance-scoped too. They must not bypass
        // the same isolation prerequisite as sending, including manual reconciliation.
        try await requireSendPermission()
    }

    private func requireSendPermission() async throws {
        guard let report = await state.get(), report.safety.canSend else {
            throw OpenCodeError.unsafeProfile(await state.get()?.safety.diagnostic ?? "请先显式连接并核验 OpenCode 服务。")
        }
    }

    static func sessionValue(_ object: [String: Any], expectedDirectory: String) throws -> RuntimeSession {
        guard let id = object["id"] as? String, let directory = object["directory"] as? String,
              directory == expectedDirectory else { throw OpenCodeError.unsafeProfile("外部会话不属于当前运行时目录。") }
        try Self.validateIdentifier(id, prefix: "ses")
        return RuntimeSession(externalSessionID: id, directory: directory)
    }

    private func makeRequest(path: String, method: String = "GET", body: [String: Any]? = nil, scoped: Bool = true) throws -> URLRequest {
        var components = URLComponents(url: settings.endpoint, resolvingAgainstBaseURL: false)!
        components.path = path
        components.queryItems = scoped ? [URLQueryItem(name: "directory", value: settings.directory)] : nil
        guard let url = components.url else { throw OpenCodeError.invalidEndpoint }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Basic " + Data("\(settings.username):\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil, scoped: Bool = true, expectedStatus: Int? = nil) async throws -> Data {
        let request = try makeRequest(path: path, method: method, body: body, scoped: scoped)
        let (bytes, response) = try await transport.bytes(for: request)
        try checkResponse(response)
        if let expectedStatus, (response as? HTTPURLResponse)?.statusCode != expectedStatus { throw OpenCodeError.submissionUnknown }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximumResponseBytes else { throw OpenCodeError.responseTooLarge }
            data.append(byte)
        }
        return data
    }

    private func checkResponse(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else { throw OpenCodeError.malformedResponse }
        if response.statusCode == 401 || response.statusCode == 403 { throw OpenCodeError.authenticationRequired }
        guard (200...299).contains(response.statusCode) else { throw OpenCodeError.httpStatus(response.statusCode) }
    }

    private func json(path: String, method: String = "GET", body: [String: Any]? = nil, scoped: Bool = true) async throws -> Any {
        let data = try await request(path: path, method: method, body: body, scoped: scoped)
        do { return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) }
        catch { throw OpenCodeError.malformedResponse }
    }

    private func object(path: String, method: String = "GET", body: [String: Any]? = nil, scoped: Bool = true) async throws -> [String: Any] {
        guard let value = try await json(path: path, method: method, body: body, scoped: scoped) as? [String: Any] else { throw OpenCodeError.malformedResponse }
        return value
    }

    static func validateIdentifier(_ value: String, prefix: String) throws {
        guard value.hasPrefix(prefix), value.count <= 160, value.count > prefix.count,
              value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 95 || $0 == 45 }) else { throw OpenCodeError.invalidIdentifier }
    }

    static func providers(_ object: [String: Any]) throws -> [LLMProviderConfig] {
        guard let all = object["all"] as? [[String: Any]], let connected = object["connected"] as? [String],
              let defaults = object["default"] as? [String: String] else { throw OpenCodeError.malformedResponse }
        let ids = Set(connected)
        return try all.compactMap { provider in
            guard let id = provider["id"] as? String, let name = provider["name"] as? String,
                  let models = provider["models"] as? [String: [String: Any]] else { throw OpenCodeError.malformedResponse }
            guard ids.contains(id) else { return nil }
            let descriptors = models.keys.sorted().compactMap { modelID -> ModelDescriptor? in
                let model = models[modelID]!
                if model["status"] as? String == "deprecated" || model["disabled"] as? Bool == true { return nil }
                let variants = (model["variants"] as? [String: [String: Any]] ?? [:]).filter { $0.value["disabled"] as? Bool != true }.keys.sorted()
                return ModelDescriptor(modelID: modelID, name: model["name"] as? String ?? modelID, variants: variants)
            }
            return LLMProviderConfig(providerID: id, name: name, models: descriptors, defaultModelID: defaults[id])
        }.sorted { $0.providerID < $1.providerID }
    }

    static func profileDiagnostic(config: [String: Any], agents: [[String: Any]], agentName: String) -> String? {
        guard config["default_agent"] as? String == agentName else { return "普通聊天需要专用 screendeck-chat profile，不能使用默认编码 Agent。" }
        let permission = config["permission"]
        let denyAll = permission as? String == "deny" || (permission as? [String: Any])?["*"] as? String == "deny"
        guard denyAll else { return "普通聊天配置未禁止全部工具。" }
        if let map = permission as? [String: Any], map.values.contains(where: { ($0 as? String) != "deny" }) { return "工具权限包含覆盖规则，不能作为无工具聊天。" }
        for key in ["plugin", "instructions"] {
            if let value = config[key] as? [Any], !value.isEmpty { return "普通聊天不加载插件或附加指令。" }
        }
        for key in ["mcp", "reference", "references"] {
            if let value = config[key] as? [String: Any], !value.isEmpty { return "普通聊天不加载 MCP 或项目引用。" }
        }
        if let skills = config["skills"] as? [String: Any], skills.values.contains(where: { ($0 as? [Any])?.isEmpty == false }) { return "普通聊天不加载外部 skills。" }
        guard (config["compaction"] as? [String: Any])?["auto"] as? Bool == false, config["share"] as? String != "auto",
              config["autoshare"] as? Bool != true else { return "需要关闭自动压缩和自动分享，避免额外模型调用或外发。" }
        guard let agent = agents.first(where: { $0["name"] as? String == agentName }), agent["mode"] as? String != "subagent",
              let rules = agent["permission"] as? [[String: Any]],
              rules.contains(where: { $0["permission"] as? String == "*" && $0["pattern"] as? String == "*" && $0["action"] as? String == "deny" }) else { return "服务未返回可核验的普通聊天 Agent 权限。" }
        // OpenCode appends an external-directory rule for its truncation cache. It does not grant a tool.
        if rules.contains(where: { $0["permission"] as? String != "external_directory" && $0["action"] as? String != "deny" }) { return "普通聊天 Agent 仍有工具许可，已阻止发送。" }
        return nil
    }
}
