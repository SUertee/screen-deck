import XCTest
@testable import ScreenDeck

final class OpenCodeProtocolTests: XCTestCase {
    func testLoopbackAddressValidationRejectsDNSAndCredentialTargets() throws {
        for address in ["http://127.0.0.1:4096", "http://[::1]:4096/"] {
            XCTAssertNoThrow(try OpenCodeClient.validateEndpoint(URL(string: address)!))
        }
        for address in ["http://localhost:4096", "http://127.1:4096", "http://127.0.0.1", "https://127.0.0.1:4096",
                        "http://example.com:4096", "http://127.0.0.1:4096/api", "http://user:secret@127.0.0.1:4096",
                        "http://127.0.0.1:4096?target=example.com", "http://127.0.0.1:4096#fragment"] {
            XCTAssertThrowsError(try OpenCodeClient.validateEndpoint(URL(string: address)!), address)
        }
    }

    func testConnectionRequiresPasswordAndDedicatedAbsoluteDirectory() {
        XCTAssertThrowsError(try OpenCodeClient(settings: settings, password: ""))
        XCTAssertThrowsError(try OpenCodeClient(settings: OpenCodeConnectionSettings(directory: "relative"), password: "test-only"))
        XCTAssertThrowsError(try OpenCodeClient(settings: OpenCodeConnectionSettings(directory: "/tmp/../private"), password: "test-only"))
    }

    func testConnectionRejectsControlCharactersAndEmptyUsername() {
        XCTAssertThrowsError(try OpenCodeClient(settings: .init(directory: "/tmp/runtime\rprivate"), password: "test-only"))
        for username in ["", "user\rname", "user\0name", "user\nname", "user:name"] {
            XCTAssertThrowsError(try OpenCodeClient(settings: .init(directory: settings.directory, username: username), password: "test-only"))
        }
    }

    func testConnectOnlyQueriesPinnedProtocolAndReportsMissingStartupProof() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "Authorization"))
            let path = request.url!.path
            if path != "/global/health" {
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, self.settings.directory)
            }
            return (200, try self.response(path: path))
        }
        let report = try await client.connect()
        XCTAssertEqual(report.version, "1.18.35")
        XCTAssertEqual(report.providers, [])
        XCTAssertFalse(report.safety.canSend)
        XCTAssertEqual(report.safety, .isolationUnavailable)
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.map { $0.url!.path }, ["/global/health"])
        do { _ = try await client.createSession(title: "local-only"); XCTFail("No verified startup proof") }
        catch { XCTAssertTrue(error is OpenCodeError) }
        do { _ = try await client.sendMessage(sessionID: "ses_test", clientRequestID: UUID().uuidString, text: "DO-NOT-SEND", model: .init(providerID: "test-provider", modelID: "test-model")); XCTFail() }
        catch { XCTAssertTrue(error is OpenCodeError) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
    }

    func testWrongVersionStopsBeforeInstanceInitialization() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { _ in (200, Data(#"{"healthy":true,"version":"2.0.0"}"#.utf8)) }
        do { _ = try await client.connect(); XCTFail() }
        catch { XCTAssertEqual(error as? OpenCodeError, .unsupportedVersion("2.0.0")) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
    }

    func testMalformedVersionDoesNotExposeArbitraryServerText() async throws {
        for version in ["", String(repeating: "x", count: 65), "1.18.35\nSECRET", "版本", "<script>", "1.18.35:secret"] {
            let client = try makeClient()
            OpenCodeTestURLProtocol.install { _ in (200, try JSONSerialization.data(withJSONObject: ["healthy": true, "version": version])) }
            do { _ = try await client.connect(); XCTFail() }
            catch { XCTAssertEqual(error as? OpenCodeError, .malformedResponse) }
            XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
        }
    }

    func testAuthenticationFailureAndRedirectAreNotRetried() async throws {
        for status in [401, 403, 302, 500] {
            let client = try makeClient()
            OpenCodeTestURLProtocol.install { _ in (status, Data()) }
            do { _ = try await client.connect(); XCTFail() }
            catch {
                XCTAssertEqual(error as? OpenCodeError, [401, 403].contains(status) ? .authenticationRequired : .httpStatus(status))
            }
            XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
        }
    }

    func testConnectNeverInitializesInstanceDirectoryWithoutStartupProof() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in
            if request.url!.path == "/path" { return (200, Data(#"{"directory":"/other"}"#.utf8)) }
            return (200, try self.response(path: request.url!.path))
        }
        let report = try await client.connect()
        XCTAssertFalse(report.safety.canSend)
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.map { $0.url!.path }, ["/global/health"])
    }

    func testRecoveryQueriesCannotBypassMissingStartupProof() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in
            switch request.url!.path {
            case "/session/ses_test": return (200, Data(#"{"id":"ses_test","directory":"/tmp/screendeck-test-runtime"}"#.utf8))
            case "/session/ses_test/message": return (200, try JSONSerialization.data(withJSONObject: [["info": self.messageInfo(role: "assistant"), "parts": [self.textPart("已生成")]]]))
            case "/session/status": return (200, Data(#"{"ses_test":{"type":"idle"}}"#.utf8))
            default: return (200, try self.response(path: request.url!.path))
            }
        }
        _ = try await client.connect()
        do { _ = try await client.session(sessionID: "ses_test"); XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        do { _ = try await client.messages(sessionID: "ses_test"); XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        do { _ = try await client.status(sessionID: "ses_test"); XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.map { $0.url!.path }, ["/global/health"])
    }

    func testControlRequestsCannotBypassMissingStartupProof() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in
            if request.httpMethod == "POST" {
                return (200, Data("true".utf8))
            }
            return (200, try self.response(path: request.url!.path))
        }
        _ = try await client.connect()
        do { try await client.rejectPermission(sessionID: "ses_test", requestID: "per_test"); XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        do { try await client.abort(sessionID: "ses_test"); XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.map { $0.url!.path }, ["/global/health"])
    }

    func testInvalidExternalIdentifierCannotBecomeRequestPath() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in (200, try self.response(path: request.url!.path)) }
        _ = try await client.connect()
        do { _ = try await client.messages(sessionID: "ses_test/../../auth"); XCTFail() }
        catch { XCTAssertTrue(error is OpenCodeError) }
        XCTAssertThrowsError(try OpenCodeClient.validateIdentifier("ses_test/../../auth", prefix: "ses"))
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
    }

    func testCrossOriginRedirectDoesNotForwardAuthentication() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { _ in (302, Data()) }
        OpenCodeTestURLProtocol.redirectTarget = URL(string: "http://example.invalid:4096")
        defer { OpenCodeTestURLProtocol.redirectTarget = nil }
        do { _ = try await client.connect(); XCTFail() }
        catch { XCTAssertEqual(error as? OpenCodeError, .httpStatus(302)) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.count, 1)
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.first?.url?.host, "127.0.0.1")
    }

    func testStreamCannotInitializeInstanceDirectoryWithoutStartupProof() async throws {
        let client = try makeClient()
        OpenCodeTestURLProtocol.install { request in
            return (200, try self.response(path: request.url!.path))
        }
        _ = try await client.connect()
        let stream = client.events(sessionID: "ses_test")
        do { for try await _ in stream { XCTFail() }; XCTFail() } catch { XCTAssertTrue(error is OpenCodeError) }
        XCTAssertEqual(OpenCodeTestURLProtocol.requests.map { $0.url!.path }, ["/global/health"])
    }

    func testProviderCatalogIsPureAndIncludesOnlyConnectedModels() throws {
        let providers = try OpenCodeClient.providers(try XCTUnwrap(JSONSerialization.jsonObject(with: response(path: "/provider")) as? [String: Any]))
        XCTAssertEqual(providers.map(\.providerID), ["test-provider"])
        XCTAssertEqual(providers[0].models[0].variants, ["high"])
    }

    func testSessionResponseRequiresExactDirectoryBinding() throws {
        let value = try OpenCodeClient.sessionValue(["id": "ses_test", "directory": settings.directory], expectedDirectory: settings.directory)
        XCTAssertEqual(value.externalSessionID, "ses_test")
        XCTAssertThrowsError(try OpenCodeClient.sessionValue(["id": "ses_test", "directory": "/other"], expectedDirectory: settings.directory))
        XCTAssertThrowsError(try OpenCodeClient.sessionValue(["id": "ses_test/other", "directory": settings.directory], expectedDirectory: settings.directory))
    }

    func testProfileDiagnosticRejectsToolsPluginsMCPAndOverrides() throws {
        var config = safeConfig
        XCTAssertNil(OpenCodeClient.profileDiagnostic(config: config, agents: safeAgents, agentName: "screendeck-chat"))
        for patch: [String: Any] in [["permission": "allow"], ["permission": ["*": "deny", "read": "allow"]],
                                     ["plugin": ["evil-plugin"]], ["instructions": ["AGENTS.md"]], ["mcp": ["a": [:]]],
                                     ["skills": ["paths": ["/tmp/skill"]]], ["compaction": ["auto": true]], ["share": "auto"], ["default_agent": "build"]] {
            config = safeConfig.merging(patch) { _, new in new }
            XCTAssertNotNil(OpenCodeClient.profileDiagnostic(config: config, agents: safeAgents, agentName: "screendeck-chat"))
        }
        var agents = safeAgents
        agents[0]["permission"] = [["permission": "*", "pattern": "*", "action": "deny"], ["permission": "read", "pattern": "*", "action": "allow"]]
        XCTAssertNotNil(OpenCodeClient.profileDiagnostic(config: safeConfig, agents: agents, agentName: "screendeck-chat"))
    }

    func testModelSelectionAndProviderMetadataHaveNoSecretFields() throws {
        let selection = ModelSelection(providerID: "test-provider", modelID: "test-model", variant: "high")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(selection)) as? [String: String])
        XCTAssertEqual(json, ["provider_id": "test-provider", "model_id": "test-model", "variant": "high"])
        let provider = LLMProviderConfig(providerID: "test-provider", name: "Test", models: [], credentialReference: "keychain://reference")
        let serialized = String(data: try JSONEncoder().encode(provider), encoding: .utf8)!
        XCTAssertTrue(serialized.contains("credential_reference"))
        XCTAssertFalse(serialized.contains("password"))
        XCTAssertFalse(serialized.contains("api_key"))
    }

    func testSSEFramingPreservesUTF8CRLFMultilineAndComments() throws {
        var decoder = OpenCodeSSEDecoder()
        let payload = "\u{FEFF}: comment\r\nid: evt_test\r\nevent: ignored\r\ndata: {\r\ndata: \"text\":\"中文\"}\r\n\r\n"
        var frames: [OpenCodeSSEDecoder.Frame] = []
        for byte in payload.utf8 { frames += try decoder.append(Data([byte])) }
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].id, "evt_test")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: frames[0].data) as? [String: String])
        XCTAssertEqual(object["text"], "中文")
    }

    func testSSEFramingBoundsAndInvalidUTF8() throws {
        var decoder = OpenCodeSSEDecoder(maximumLineBytes: 8, maximumEventBytes: 12)
        XCTAssertThrowsError(try decoder.append(Data("data: too-long".utf8)))
        var invalid = OpenCodeSSEDecoder()
        XCTAssertThrowsError(try invalid.append(Data([0xff, 10])))
        var events = OpenCodeSSEDecoder(maximumLineBytes: 20, maximumEventBytes: 10)
        XCTAssertThrowsError(try events.append(Data("data: 12345\ndata: 67890\n\n".utf8)))
    }

    func testMapperDistinguishesSnapshotAndDeltaAndDeduplicatesOnlyEventID() throws {
        var mapper = OpenCodeEventMapper(sessionID: "ses_test")
        let snapshot = try frame(type: "message.part.updated", id: "evt_1", properties: ["sessionID": "ses_test", "part": textPart("你好")])
        XCTAssertEqual(try mapper.map(snapshot), .textSnapshot(sessionID: "ses_test", messageID: "msg_test", partID: "prt_test", text: "你好"))
        XCTAssertNil(try mapper.map(snapshot))
        let delta = try frame(type: "message.part.delta", id: "evt_2", properties: ["sessionID": "ses_test", "messageID": "msg_test", "partID": "prt_test", "field": "text", "delta": "好"])
        XCTAssertEqual(try mapper.map(delta), .textDelta(sessionID: "ses_test", messageID: "msg_test", partID: "prt_test", text: "好"))
        let repeatedText = try frame(type: "message.part.delta", id: "evt_3", properties: ["sessionID": "ses_test", "messageID": "msg_test", "partID": "prt_test", "field": "text", "delta": "好"])
        XCTAssertNotNil(try mapper.map(repeatedText), "Identical text is not duplicate evidence")
    }

    func testMapperNeverPublishesReasoningOrAnotherSession() throws {
        var mapper = OpenCodeEventMapper(sessionID: "ses_test")
        var part = textPart("PRIVATE-REASONING")
        part["type"] = "reasoning"
        XCTAssertNil(try mapper.map(frame(type: "message.part.updated", properties: ["sessionID": "ses_test", "part": part])))
        XCTAssertNil(try mapper.map(frame(type: "message.part.delta", properties: ["sessionID": "ses_test", "messageID": "msg_test", "partID": "prt_test", "field": "text", "delta": "PRIVATE-REASONING"])))
        XCTAssertNil(try mapper.map(frame(type: "session.status", properties: ["sessionID": "ses_other", "status": ["type": "busy"]])))
    }

    func testIgnoredAndSyntheticTextNeverEnableVisibleDeltas() throws {
        for flag in ["ignored", "synthetic"] {
            var mapper = OpenCodeEventMapper(sessionID: "ses_test")
            var part = textPart("HIDDEN"); part[flag] = true
            XCTAssertNil(try mapper.map(frame(type: "message.part.updated", properties: ["sessionID": "ses_test", "part": part])))
            XCTAssertNil(try mapper.map(frame(type: "message.part.delta", properties: ["sessionID": "ses_test", "messageID": "msg_test", "partID": "prt_test", "field": "text", "delta": "HIDDEN"])))
        }
    }

    func testEventAndPartIdentifiersAreBoundedBeforeRememberingThem() throws {
        var mapper = OpenCodeEventMapper(sessionID: "ses_test")
        XCTAssertThrowsError(try mapper.map(frame(type: "session.status", id: String(repeating: "x", count: 161), properties: ["sessionID": "ses_test", "status": ["type": "busy"]])))
        XCTAssertThrowsError(try mapper.map(frame(type: "session.status", id: String(repeating: "中", count: 54), properties: ["sessionID": "ses_test", "status": ["type": "busy"]])))
        var part = textPart("text"); part["id"] = String(repeating: "x", count: 161)
        XCTAssertThrowsError(try mapper.map(frame(type: "message.part.updated", properties: ["sessionID": "ses_test", "part": part])))
    }

    func testMapperExposesPermissionAndUnexpectedToolWithoutRawPayload() throws {
        var mapper = OpenCodeEventMapper(sessionID: "ses_test")
        XCTAssertEqual(try mapper.map(frame(type: "permission.asked", properties: ["sessionID": "ses_test", "id": "per_test", "metadata": ["secret": "do-not-publish"]])),
                       .permissionRequested(sessionID: "ses_test", requestID: "per_test"))
        XCTAssertEqual(try mapper.map(frame(type: "message.part.updated", properties: ["sessionID": "ses_test", "part": ["id": "prt_tool", "type": "tool", "tool": "bash", "state": ["input": "secret"]]])),
                       .toolDetected(sessionID: "ses_test", toolName: "bash"))
    }

    func testMessageSnapshotUsesActualAssistantModelAndOnlyVisibleText() throws {
        var info = messageInfo(role: "assistant")
        info["error"] = ["name": "ProviderAuthError", "data": ["message": "SECRET"]]
        var reasoning = textPart("PRIVATE-REASONING"); reasoning["type"] = "reasoning"
        let message = try OpenCodeEventMapper.message(info: info, parts: [textPart("visible"), reasoning], expectedSessionID: "ses_test")
        XCTAssertEqual(message.text, "visible")
        XCTAssertEqual(message.observedModel, .init(providerID: "test-provider", modelID: "test-model"))
        XCTAssertEqual(message.failure, "ProviderAuthError")
        let user = try OpenCodeEventMapper.message(info: messageInfo(role: "user"), parts: [], expectedSessionID: "ses_test")
        XCTAssertNil(user.observedModel)
        XCTAssertThrowsError(try OpenCodeEventMapper.message(info: info, parts: [["type": "tool"]], expectedSessionID: "ses_test"))
    }

    private var settings: OpenCodeConnectionSettings { .init(directory: "/tmp/screendeck-test-runtime") }
    private var safeConfig: [String: Any] { ["default_agent": "screendeck-chat", "permission": "deny", "plugin": [], "instructions": [], "mcp": [:], "compaction": ["auto": false], "share": "disabled"] }
    private var safeAgents: [[String: Any]] { [["name": "screendeck-chat", "mode": "primary", "permission": [["permission": "*", "pattern": "*", "action": "deny"]]]] }

    private func makeClient() throws -> OpenCodeClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OpenCodeTestURLProtocol.self]
        return try OpenCodeClient(settings: settings, password: "test-only-never-real", configuration: configuration)
    }

    private func response(path: String) throws -> Data {
        let object: Any
        switch path {
        case "/global/health": object = ["healthy": true, "version": "1.18.35"]
        case "/provider": object = ["all": [["id": "test-provider", "name": "Test", "models": ["test-model": ["name": "Test model", "variants": ["high": [:], "disabled": ["disabled": true]]]]], ["id": "disconnected", "name": "Other", "models": [:]]], "connected": ["test-provider"], "default": ["test-provider": "test-model"]]
        case "/config": object = safeConfig
        case "/agent": object = safeAgents
        case "/path": object = ["directory": settings.directory]
        default: throw OpenCodeError.malformedResponse
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    private func messageInfo(role: String) -> [String: Any] {
        ["id": "msg_test", "sessionID": "ses_test", "role": role, "providerID": "test-provider", "modelID": "test-model", "time": ["created": 1234000, "completed": 1235000]]
    }
    private func textPart(_ text: String) -> [String: Any] { ["id": "prt_test", "sessionID": "ses_test", "messageID": "msg_test", "type": "text", "text": text] }
    private func frame(type: String, id: String? = nil, properties: [String: Any]) throws -> OpenCodeSSEDecoder.Frame {
        var object: [String: Any] = ["type": type, "properties": properties]
        if let id { object["id"] = id }
        return .init(id: nil, data: try JSONSerialization.data(withJSONObject: object))
    }
}

private final class OpenCodeTestURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var handler: ((URLRequest) throws -> (Int, Data))?
    private static var recorded: [URLRequest] = []
    static var redirectTarget: URL?
    static var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    static func install(_ value: @escaping (URLRequest) throws -> (Int, Data)) { lock.lock(); defer { lock.unlock() }; handler = value; recorded = [] }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handler; Self.recorded.append(request); Self.lock.unlock()
        do {
            let (code, data) = try XCTUnwrap(handler)(request)
            let isEvent = request.url!.path == "/event"
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": isEvent ? "text/event-stream" : "application/json"] )!
            if let target = Self.redirectTarget {
                var redirected = request; redirected.url = target
                client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
