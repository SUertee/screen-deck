import XCTest
@testable import ScreenDeck

final class SessionRecordCompatibilityTests: XCTestCase {
    private let sessionID = UUID(uuidString: "10000000-0000-4000-8000-000000000001")!

    // Handwritten v1 history, independent of the renamed models and any user records.
    private func legacyJSON(scopeJSON: String = #"{"kind":"local_chat","local_chat_id":"20000000-0000-4000-8000-000000000001"}"#) -> Data {
        Data(#"""
        {
          "schema_version": 1,
          "conversation_id": "10000000-0000-4000-8000-000000000001",
          "title": "旧版兼容性测试会话",
          "scope": \#(scopeJSON),
          "created_at": "2026-10-07T15:00:00.123Z",
          "updated_at": "2026-10-07T15:01:00.456Z",
          "revision": 7,
          "binding": {
            "external_session_id": "ses_legacy_fixture",
            "endpoint": "http://127.0.0.1:4096",
            "directory": "/private/tmp/screendeck-legacy-fixture",
            "compatible_version": "1.18.35",
            "connection_generation": "30000000-0000-4000-8000-000000000001"
          },
          "turns": [
            {
              "turn_id": "40000000-0000-4000-8000-000000000001",
              "client_request_id": "50000000-0000-4000-8000-000000000001",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model","variant":"default"},
              "state": "prepared",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:00:00.123Z",
              "draft_revision": 1
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000002",
              "client_request_id": "50000000-0000-4000-8000-000000000002",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "state": "submitting",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:00:00.123Z",
              "draft_revision": 2
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000003",
              "client_request_id": "50000000-0000-4000-8000-000000000003",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "observed_model": {"provider_id":"fixture-provider","model_id":"observed-model"},
              "state": "streaming",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:00:00.123Z",
              "draft_revision": 3
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000004",
              "client_request_id": "50000000-0000-4000-8000-000000000004",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model","variant":"default"},
              "observed_model": {"provider_id":"fixture-provider","model_id":"observed-model","variant":"observed"},
              "state": "finished",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z",
              "draft_revision": 4
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000005",
              "client_request_id": "50000000-0000-4000-8000-000000000005",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "state": "failed",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z",
              "draft_revision": 5,
              "failure": "fixture failure"
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000006",
              "client_request_id": "50000000-0000-4000-8000-000000000006",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "state": "cancelling",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z",
              "draft_revision": 6
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000007",
              "client_request_id": "50000000-0000-4000-8000-000000000007",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "state": "cancelled",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z",
              "draft_revision": 7
            },
            {
              "turn_id": "40000000-0000-4000-8000-000000000008",
              "client_request_id": "50000000-0000-4000-8000-000000000008",
              "requested_model": {"provider_id":"fixture-provider","model_id":"requested-model"},
              "state": "unknown",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z",
              "draft_revision": 8
            }
          ],
          "messages": [
            {
              "message_id": "60000000-0000-4000-8000-000000000001",
              "turn_id": "40000000-0000-4000-8000-000000000004",
              "role": "user",
              "text": "手写测试输入\n第二行",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:00:00.123Z"
            },
            {
              "message_id": "60000000-0000-4000-8000-000000000002",
              "turn_id": "40000000-0000-4000-8000-000000000004",
              "role": "assistant",
              "text": "手写测试回复",
              "external_message_id": "msg_legacy_fixture",
              "external_part_id": "prt_legacy_fixture",
              "created_at": "2026-10-07T15:00:00.123Z",
              "updated_at": "2026-10-07T15:01:00.456Z"
            }
          ]
        }
        """#.utf8)
    }

    private func dateFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            return try XCTUnwrap(self.dateFormatter().date(from: value))
        }
        return decoder
    }

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var value = encoder.singleValueContainer()
            try value.encode(self.dateFormatter().string(from: date))
        }
        return encoder
    }

    private func object(_ bytes: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? NSDictionary)
    }

    func testLegacyV1DecodesRenamedTypesAndKeepsLocalIdentitySeparate() throws {
        let session = try decoder().decode(Session.self, from: legacyJSON())
        let states: [TurnState] = [.prepared, .submitting, .streaming, .finished, .failed, .cancelling, .cancelled, .unknown]
        XCTAssertEqual(session.schemaVersion, 1)
        XCTAssertEqual(session.sessionID, sessionID)
        XCTAssertEqual(session.id, sessionID)
        XCTAssertEqual(session.revision, 7)
        XCTAssertEqual(session.turns.map(\.state), states)
        XCTAssertEqual(session.turns.map(\.draftRevision), Array(1...8))
        XCTAssertEqual(session.turns[0].requestedModel,
                       ModelSelection(providerID: "fixture-provider", modelID: "requested-model", variant: "default"))
        XCTAssertNil(session.turns[0].observedModel)
        XCTAssertNil(session.turns[1].requestedModel.variant)
        XCTAssertEqual(session.turns[2].observedModel,
                       ModelSelection(providerID: "fixture-provider", modelID: "observed-model"))
        XCTAssertEqual(session.turns[3].observedModel,
                       ModelSelection(providerID: "fixture-provider", modelID: "observed-model", variant: "observed"))
        XCTAssertEqual(session.turns[4].failure, "fixture failure")
        XCTAssertEqual(session.messages.map(\.role), [MessageRole.user, .assistant])
        XCTAssertEqual(session.messages[0].text, "手写测试输入\n第二行")
        XCTAssertEqual(session.messages[1].turnID, session.turns[3].turnID)
        XCTAssertEqual(session.messages[1].externalMessageID, "msg_legacy_fixture")
        XCTAssertEqual(session.messages[1].externalPartID, "prt_legacy_fixture")
        let binding: RuntimeSessionBinding = try XCTUnwrap(session.binding)
        XCTAssertEqual(binding.externalSessionID, "ses_legacy_fixture")
        XCTAssertNotEqual(session.sessionID.uuidString, binding.externalSessionID)
        XCTAssertEqual(binding.endpoint, URL(string: "http://127.0.0.1:4096"))
        XCTAssertEqual(binding.directory, "/private/tmp/screendeck-legacy-fixture")
        XCTAssertEqual(binding.compatibleVersion, "1.18.35")
        XCTAssertEqual(binding.connectionGeneration, UUID(uuidString: "30000000-0000-4000-8000-000000000001"))
    }

    func testReencodingLegacyV1PreservesEveryJSONFieldAndValue() throws {
        let original = legacyJSON()
        let session = try decoder().decode(Session.self, from: original)
        let encoded = try encoder().encode(session)
        let json = try object(encoded)
        XCTAssertEqual(json, try object(original))
        XCTAssertEqual(json["conversation_id"] as? String, sessionID.uuidString)
        XCTAssertNil(json["session_id"])
        XCTAssertNil(json["sessionID"])
        XCTAssertEqual(try decoder().decode(Session.self, from: encoded), session)
    }

    func testAllLegacyScopesPreserveTheirExistingWireKeys() throws {
        let scopes: [(String, SessionScope)] = [
            (#"{"kind":"local_chat","local_chat_id":"20000000-0000-4000-8000-000000000001"}"#,
             .localChat(UUID(uuidString: "20000000-0000-4000-8000-000000000001")!)),
            (#"{"kind":"local_task","local_task_id":"20000000-0000-4000-8000-000000000002"}"#,
             .localTask(UUID(uuidString: "20000000-0000-4000-8000-000000000002")!)),
            (#"{"kind":"project","project_id":"project-11111111-1111-1111-1111-111111111111"}"#,
             .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: nil)),
            (#"{"kind":"project","project_id":"project-11111111-1111-1111-1111-111111111111","task_id":"task-013"}"#,
             .project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: "task-013"))
        ]
        for (scopeJSON, expectedScope) in scopes {
            let original = legacyJSON(scopeJSON: scopeJSON)
            let session = try decoder().decode(Session.self, from: original)
            XCTAssertEqual(session.scope, expectedScope)
            XCTAssertEqual(try object(encoder().encode(session)), try object(original))
        }
    }

    func testStoreReadsLegacyFileByLocalSessionIDWithoutChangingOriginal() async throws {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-session-compatibility-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let bucket = root.appendingPathComponent("2026/10/07", isDirectory: true)
        try FileManager.default.createDirectory(at: bucket, withIntermediateDirectories: true)
        let file = bucket.appendingPathComponent("\(sessionID.uuidString.lowercased()).json")
        let original = legacyJSON()
        try original.write(to: file)
        let expected = try decoder().decode(Session.self, from: original)
        let store = SessionHistoryStore(root: root)
        let loaded = try await store.load(sessionID: sessionID)
        let listing = try await store.list()
        let reopened = try await SessionHistoryStore(root: root).load(sessionID: sessionID)
        XCTAssertEqual(loaded, expected)
        XCTAssertEqual(reopened, expected)
        XCTAssertEqual(listing.records, [expected])
        XCTAssertTrue(listing.diagnostics.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["2026"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bucket.path), [file.lastPathComponent])
    }
}
