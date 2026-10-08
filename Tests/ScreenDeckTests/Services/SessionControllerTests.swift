import XCTest
@testable import ScreenDeck

private actor SessionTestGate {
    private(set) var opened = false
    private var continuations: [CheckedContinuation<Void, Never>] = []
    private(set) var waits = 0
    func wait() async {
        waits += 1
        guard !opened else { return }
        await withCheckedContinuation { continuations.append($0) }
    }
    func open() {
        opened = true
        let pending = continuations; continuations.removeAll()
        for continuation in pending { continuation.resume() }
    }
}

private actor SessionTestStore: SessionHistoryStoring {
    let backing: SessionHistoryStore
    private(set) var listCalls = 0
    private(set) var saved: [Session] = []
    var failNextSave = false
    var failAllSaves = false
    var failStateOnce: TurnState?
    var saveGate: SessionTestGate?
    var gatedState: TurnState?
    init(root: URL) { backing = SessionHistoryStore(root: root) }
    func setFailure(next: Bool = false, all: Bool = false, state: TurnState? = nil) {
        failNextSave = next; failAllSaves = all; failStateOnce = state
    }
    func gateSaves(_ gate: SessionTestGate, state: TurnState? = nil) { saveGate = gate; gatedState = state }
    func load(sessionID: UUID) async throws -> Session? { try await backing.load(sessionID: sessionID) }
    func list() async throws -> SessionHistoryListing { listCalls += 1; return try await backing.list() }
    func save(_ record: Session, expectedRevision: Int?) async throws -> Session {
        if let saveGate, gatedState == nil || record.turns.last?.state == gatedState { await saveGate.wait() }
        if failAllSaves || failNextSave || (failStateOnce != nil && record.turns.last?.state == failStateOnce) {
            failNextSave = false; failStateOnce = nil
            throw SessionHistoryFailure.revisionChanged
        }
        let persisted = try await backing.save(record, expectedRevision: expectedRevision)
        saved.append(persisted)
        return persisted
    }
}

private final class SessionTestRuntime: RuntimeClient, @unchecked Sendable {
    struct State {
        var connectCalls = 0, createCalls = 0, promptCalls = 0, messageCalls = 0, abortCalls = 0, rejectCalls = 0
        var safe = true, completeReplies = true, failCreateOnce = false, submissionUnknown = false
        var forcedSessionID: String?, returnedDirectory: String?
        var sendGate: SessionTestGate?, queryGate: SessionTestGate?
        var onSend: (@Sendable () async -> Void)?
        var messages: [String: [RuntimeMessage]] = [:]
        var statuses: [String: RuntimeSessionStatus] = [:]
        var continuations: [String: AsyncThrowingStream<RuntimeStreamEvent, Error>.Continuation] = [:]
    }
    static let directory = "/private/tmp/screendeck-chat-test-runtime"
    static let model = ModelSelection(providerID: "fixture", modelID: "fixture-model")
    private let lock = NSLock()
    private var value = State()
    func read<T>(_ body: (State) -> T) -> T { lock.lock(); defer { lock.unlock() }; return body(value) }
    func update(_ body: (inout State) -> Void) { lock.lock(); defer { lock.unlock() }; body(&value) }
    func connect() async throws -> RuntimeConnectionReport {
        update { $0.connectCalls += 1 }
        let safe = read { $0.safe }
        return .init(version: "1.18.35", providers: [
            .init(providerID: "fixture", name: "Fixture", models: [.init(modelID: "fixture-model", name: "Fixture model", variants: ["high"])])
        ], safety: .init(canSend: safe, diagnostic: safe ? "fixture-only" : "fixture profile unavailable"))
    }
    func createSession(title: String) async throws -> RuntimeSession {
        var shouldFail = false, sessionID = ""
        update {
            $0.createCalls += 1; shouldFail = $0.failCreateOnce; $0.failCreateOnce = false
            sessionID = $0.forcedSessionID ?? "ses_fixture_\($0.createCalls)"
            if !shouldFail { $0.messages[sessionID] = $0.messages[sessionID] ?? []; $0.statuses[sessionID] = $0.statuses[sessionID] ?? .idle }
        }
        if shouldFail { throw OpenCodeError.httpStatus(500) }
        return .init(externalSessionID: sessionID, directory: read { $0.returnedDirectory } ?? Self.directory)
    }
    func session(sessionID: String) async throws -> RuntimeSession {
        guard read({ $0.messages[sessionID] != nil }) else { throw OpenCodeError.httpStatus(404) }
        return .init(externalSessionID: sessionID, directory: read { $0.returnedDirectory } ?? Self.directory)
    }
    func sendMessage(sessionID: String, clientRequestID: String, text: String, model: ModelSelection) async throws -> RuntimeSubmissionReceipt {
        update { $0.promptCalls += 1 }
        if let onSend = read({ $0.onSend }) { await onSend() }
        if let gate = read({ $0.sendGate }) { await gate.wait() }
        if read({ $0.submissionUnknown }) { throw OpenCodeError.submissionUnknown }
        let requestID = UUID(uuidString: clientRequestID)!
        let messageID = await SessionController.externalMessageID(for: requestID)
        update {
            $0.messages[sessionID, default: []].append(.init(externalMessageID: messageID, externalSessionID: sessionID,
                role: "user", parts: [.init(externalPartID: "prt_user_\(messageID)", text: text)]))
            if $0.completeReplies {
                $0.messages[sessionID, default: []].append(.init(externalMessageID: "msg_assistant_\(messageID)",
                    externalSessionID: sessionID, role: "assistant", parts: [.init(externalPartID: "prt_answer", text: "完整回复")],
                    parentMessageID: messageID, observedModel: model, createdAt: Date(), completedAt: Date()))
                $0.statuses[sessionID] = .idle
            } else { $0.statuses[sessionID] = .busy }
        }
        return .init(externalMessageID: messageID)
    }
    func messages(sessionID: String) async throws -> [RuntimeMessage] {
        update { $0.messageCalls += 1 }
        if let gate = read({ $0.queryGate }) { await gate.wait() }
        return read { $0.messages[sessionID] ?? [] }
    }
    func status(sessionID: String) async throws -> RuntimeSessionStatus { read { $0.statuses[sessionID] ?? .idle } }
    func abort(sessionID: String) async throws { update { $0.abortCalls += 1; $0.statuses[sessionID] = .idle } }
    func rejectPermission(sessionID: String, requestID: String) async throws { update { $0.rejectCalls += 1 } }
    func events(sessionID: String) -> AsyncThrowingStream<RuntimeStreamEvent, Error> {
        AsyncThrowingStream { continuation in update { $0.continuations[sessionID] = continuation } }
    }
    func emit(_ event: RuntimeStreamEvent, sessionID: String) { read { $0.continuations[sessionID] }?.yield(event) }
    func closeStream(sessionID: String) { read { $0.continuations[sessionID] }?.finish(throwing: OpenCodeError.streamClosed) }
    func answer(sessionID: String, text: String, completed: Bool, model: ModelSelection? = SessionTestRuntime.model) {
        update {
            guard let user = $0.messages[sessionID]?.last(where: { $0.role == "user" }) else { return }
            $0.messages[sessionID]?.removeAll { $0.role == "assistant" }
            $0.messages[sessionID, default: []].append(.init(externalMessageID: "msg_assistant_\(user.externalMessageID)", externalSessionID: sessionID,
                role: "assistant", parts: [.init(externalPartID: "prt_answer", text: text)], parentMessageID: user.externalMessageID,
                observedModel: model, createdAt: Date(), completedAt: completed ? Date() : nil))
            $0.statuses[sessionID] = completed ? .idle : .busy
        }
    }
}

final class SessionControllerTests: XCTestCase {
    @MainActor private struct Fixture {
        let root: URL
        let store: SessionTestStore
        let runtime: SessionTestRuntime
        let connection: RuntimeConnectionController
        let controller: SessionController
        let scope: SessionScope = .localChat(UUID())
    }

    @MainActor private func fixture(connected: Bool = true, safe: Bool = true) async throws -> Fixture {
        let root = URL(fileURLWithPath: "/private/tmp", isDirectory: true)
            .appendingPathComponent("screendeck-controller-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = SessionTestStore(root: root.appendingPathComponent("history")), runtime = SessionTestRuntime()
        runtime.update { $0.safe = safe }
        let connection = RuntimeConnectionController(factory: { _, _ in runtime })
        let controller = SessionController(store: store, connection: connection)
        let fixture = Fixture(root: root, store: store, runtime: runtime, connection: connection, controller: controller)
        await controller.loadHistory()
        if connected {
            await connection.connect(settings: .init(directory: SessionTestRuntime.directory), password: "fixture-only")
            controller.selectedModel = SessionTestRuntime.model
            controller.externalSendingAllowed = true
        }
        return fixture
    }

    @MainActor private func eventually(_ description: String, file: StaticString = #filePath, line: UInt = #line,
                                       _ predicate: @escaping @MainActor () async -> Bool) async {
        for _ in 0..<200 {
            if await predicate() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("Timed out: \(description)", file: file, line: line)
    }

    @MainActor private func send(_ fixture: Fixture, text: String = "测试输入") async -> SendResult {
        await fixture.controller.sendMessage(text: text, scope: fixture.scope, draftRevision: 7)
    }

    @MainActor func testConstructionHasNoNetworkOrStorageIO() async throws {
        let root = URL(fileURLWithPath: "/private/tmp/screendeck-nonexistent-\(UUID().uuidString)")
        let store = SessionTestStore(root: root), runtime = SessionTestRuntime()
        let connection = RuntimeConnectionController(factory: { _, _ in runtime })
        let controller = SessionController(store: store, connection: connection)
        defer { controller.shutdown() }
        XCTAssertEqual(runtime.read { $0.connectCalls }, 0)
        let lists = await store.listCalls
        XCTAssertEqual(lists, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertFalse(controller.historyLoaded)
        XCTAssertFalse(controller.canSend(scope: .localChat(UUID())))
    }

    @MainActor func testConnectingInspectsWithoutCreatingOrSubmittingSession() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        XCTAssertEqual(f.runtime.read { $0.connectCalls }, 1)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 0)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
        XCTAssertTrue(f.controller.sessions.isEmpty)
    }

    @MainActor func testSafetyConsentAndCatalogIndependentlyPreventSending() async throws {
        let unsafe = try await fixture(safe: false); defer { unsafe.controller.shutdown() }
        let blocked = await send(unsafe)
        XCTAssertEqual(blocked, .notSubmitted)
        XCTAssertEqual(unsafe.runtime.read { $0.promptCalls }, 0)
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.controller.externalSendingAllowed = false
        let noConsent = await send(f)
        XCTAssertEqual(noConsent, .notSubmitted)
        f.controller.externalSendingAllowed = true
        f.controller.selectedModel = .init(providerID: "unknown", modelID: "not-in-catalog")
        let noCatalog = await send(f)
        XCTAssertEqual(noCatalog, .notSubmitted)
        f.controller.selectedModel = .init(providerID: "fixture", modelID: "fixture-model", variant: "invented")
        let noVariant = await send(f)
        XCTAssertEqual(noVariant, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 0)
        XCTAssertTrue(f.controller.sessions.isEmpty)
    }

    @MainActor func testUserInputAndSubmissionIdentityAreSavedBeforePrompt() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let audit = SessionTestGate()
        f.runtime.update { state in state.onSend = {
            let records = try? await f.store.backing.list().records
            if records?.first?.turns.last?.state == .submitting,
               records?.first?.messages.first?.text == "测试输入",
               records?.first?.messages.first?.externalMessageID != nil { await audit.open() }
        } }
        let result = await send(f)
        XCTAssertEqual(result, .accepted)
        // The gate only opens after observing the actual disk aggregate before prompt submission.
        let verifiedOnDiskBeforePrompt = await audit.opened
        XCTAssertTrue(verifiedOnDiskBeforePrompt)
        let saved = await f.store.saved
        XCTAssertTrue(saved.contains { $0.turns.last?.state == .submitting && $0.messages.first?.externalMessageID != nil })
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .finished)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.draftRevision, 7)
    }

    @MainActor func testFailedInitialWriteDoesNotSubmitAndRetryUnblocksNewRound() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        await f.store.setFailure(next: true)
        let first = await send(f)
        XCTAssertEqual(first, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 0)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
        XCTAssertTrue(f.controller.hasPendingWrites)
        await f.controller.retryPendingWrites()
        XCTAssertFalse(f.controller.hasPendingWrites)
        XCTAssertTrue(f.controller.canSend(scope: f.scope))
        let retry = await send(f, text: "重新提交")
        XCTAssertEqual(retry, .accepted)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.map(\.state), [.failed, .finished])
    }

    @MainActor func testCreateSessionFailureDoesNotPoisonNextRound() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.failCreateOnce = true }
        let first = await send(f)
        XCTAssertEqual(first, .notSubmitted)
        XCTAssertTrue(f.controller.canSend(scope: f.scope))
        let second = await send(f, text: "第二轮")
        XCTAssertEqual(second, .accepted)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.map(\.state), [.failed, .finished])
        XCTAssertNil(f.controller.session(for: f.scope)?.messages.first?.externalMessageID)
    }

    @MainActor func testUnknownSubmissionIsNotAutomaticallyResentOrRecreated() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.submissionUnknown = true }
        let first = await send(f)
        XCTAssertEqual(first, .uncertain)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .unknown)
        let blocked = await send(f)
        XCTAssertEqual(blocked, .notSubmitted)
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 1)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .unknown)
    }

    @MainActor func testMissingSubmittedUserAndBusyDoesNotPretendReplyIsStreaming() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.submissionUnknown = true }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.update { $0.statuses[session] = .busy }
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .unknown)
        XCTAssertFalse(f.controller.isGenerating(scope: f.scope))
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testCanonicalUpdatesIgnoreDuplicateAndOutOfOrderDeltaText() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.answer(sessionID: session, text: "当前完整快照", completed: false)
        for text in ["旧片段", "重复", "重复", "不应追加"] {
            f.runtime.emit(.textDelta(sessionID: session, messageID: "msg_unused", partID: "prt_unused", text: text), sessionID: session)
        }
        await eventually("canonical text") { f.controller.session(for: f.scope)?.messages.last?.text == "当前完整快照" }
        XCTAssertEqual(f.controller.session(for: f.scope)?.messages.filter { $0.role == .assistant }.count, 1)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        f.runtime.answer(sessionID: session, text: "最终完整快照", completed: true)
        f.runtime.emit(.statusChanged(sessionID: session, status: .idle), sessionID: session)
        await eventually("completed canonical reply") { f.controller.session(for: f.scope)?.turns.last?.state == .finished }
        XCTAssertEqual(f.controller.session(for: f.scope)?.messages.last?.text, "最终完整快照")
    }

    @MainActor func testUnexpectedPermissionOverridesCompletedReplyAndRejectsTool() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.answer(sessionID: session, text: "不能据此声称完成", completed: true)
        f.runtime.emit(.permissionRequested(sessionID: session, requestID: "per_fixture"), sessionID: session)
        await eventually("reject and unknown") { f.runtime.read { $0.rejectCalls } == 1 && f.controller.session(for: f.scope)?.turns.last?.state == .unknown }
        XCTAssertGreaterThanOrEqual(f.runtime.read { $0.abortCalls }, 1)
        XCTAssertFalse(f.controller.canSend(scope: f.scope))
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .unknown)
    }

    @MainActor func testUnexpectedToolOverridesCompletedReply() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.answer(sessionID: session, text: "仍须核对", completed: true)
        f.runtime.emit(.toolDetected(sessionID: session, toolName: "bash"), sessionID: session)
        await eventually("abort and unknown") { f.runtime.read { $0.abortCalls } >= 1 && f.controller.session(for: f.scope)?.turns.last?.state == .unknown }
        XCTAssertFalse(f.controller.canSend(scope: f.scope))
    }

    @MainActor func testStopQueuedDuringSuspendedPromptAbortsWhenSubmissionSettles() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        f.runtime.update { $0.completeReplies = false; $0.sendGate = gate }
        let operation = Task { await self.send(f) }
        await eventually("suspended prompt") { await gate.waits == 1 }
        await f.controller.stopGeneration(scope: f.scope)
        XCTAssertEqual(f.runtime.read { $0.abortCalls }, 0)
        await gate.open()
        _ = await operation.value
        await eventually("queued prompt stop") { f.runtime.read { $0.abortCalls } >= 1 }
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .cancelled)
    }

    @MainActor func testStopQueuedDuringCanonicalQueryAbortsAfterQueryReturns() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        f.runtime.update { $0.completeReplies = false; $0.queryGate = gate }
        let operation = Task { await self.send(f) }
        await eventually("suspended query") { await gate.waits == 1 }
        await f.controller.stopGeneration(scope: f.scope)
        await gate.open()
        _ = await operation.value
        await eventually("queued query stop") { f.runtime.read { $0.abortCalls } >= 1 && f.controller.session(for: f.scope)?.turns.last?.state == .cancelled }
    }

    @MainActor func testFailedStopPersistenceStillIssuesAbort() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        await f.store.setFailure(all: true)
        await f.controller.stopGeneration(scope: f.scope)
        XCTAssertEqual(f.runtime.read { $0.abortCalls }, 1)
        XCTAssertTrue(f.controller.hasPendingWrites)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .unknown)
    }

    @MainActor func testQueuedStopPersistenceFailureStillIssuesAbort() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        f.runtime.update { $0.completeReplies = false; $0.sendGate = gate }
        let operation = Task { await self.send(f) }
        await eventually("suspended send for failed stop save") { await gate.waits == 1 }
        await f.controller.stopGeneration(scope: f.scope)
        await f.store.setFailure(state: .cancelling)
        await gate.open()
        _ = await operation.value
        await eventually("queued abort despite save failure") { f.runtime.read { $0.abortCalls } >= 1 }
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testStopDuringInitialSaveCancelsBeforeSessionAndAllowsNextRound() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        await f.store.gateSaves(gate)
        let operation = Task { await self.send(f) }
        await eventually("initial save suspended") { await gate.waits == 1 }
        XCTAssertTrue(f.controller.isGenerating(scope: f.scope))
        await f.controller.stopGeneration(scope: f.scope)
        await gate.open()
        let result = await operation.value
        XCTAssertEqual(result, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 0)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .cancelled)
        XCTAssertNil(f.controller.session(for: f.scope)?.messages.first?.externalMessageID)
        XCTAssertTrue(f.controller.canSend(scope: f.scope))
        let next = await send(f, text: "明确开始下一轮")
        XCTAssertEqual(next, .accepted)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.map(\.state), [.cancelled, .finished])
    }

    @MainActor func testStopDuringSubmittingSaveClearsReservedIdentityWithoutPrompt() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        await f.store.gateSaves(gate, state: .submitting)
        let operation = Task { await self.send(f) }
        await eventually("submitting save suspended") { await gate.waits == 1 }
        await f.controller.stopGeneration(scope: f.scope)
        await gate.open()
        let result = await operation.value
        XCTAssertEqual(result, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.createCalls }, 1)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
        XCTAssertEqual(f.runtime.read { $0.abortCalls }, 0)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .cancelled)
        XCTAssertNil(f.controller.session(for: f.scope)?.messages.first?.externalMessageID)
        let next = await send(f, text: "下一次明确发送")
        XCTAssertEqual(next, .accepted)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testQueuedStopAfterAcknowledgmentWriteFailsStillAborts() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let gate = SessionTestGate()
        f.runtime.update { $0.completeReplies = false; $0.sendGate = gate }
        let operation = Task { await self.send(f) }
        await eventually("suspended send before failed acknowledgement save") { await gate.waits == 1 }
        await f.controller.stopGeneration(scope: f.scope)
        await f.store.setFailure(state: .streaming)
        await gate.open()
        let result = await operation.value
        XCTAssertEqual(result, .uncertain)
        XCTAssertEqual(f.runtime.read { $0.abortCalls }, 1)
        XCTAssertTrue(f.controller.hasPendingWrites)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testRuntimeCannotReuseOneSessionAcrossTwoProjectScopes() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.forcedSessionID = "ses_same" }
        let firstScope = SessionScope.project(projectID: "project-11111111-1111-1111-1111-111111111111", taskID: nil)
        let secondScope = SessionScope.project(projectID: "project-22222222-2222-2222-2222-222222222222", taskID: nil)
        let first = await f.controller.sendMessage(text: "第一个项目", scope: firstScope, draftRevision: 0)
        let second = await f.controller.sendMessage(text: "第二个项目", scope: secondScope, draftRevision: 0)
        XCTAssertEqual(first, .accepted)
        XCTAssertEqual(second, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        XCTAssertNil(f.controller.session(for: secondScope)?.binding)
    }

    @MainActor func testLoadedDuplicateExternalBindingsBlockBothScopes() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        let binding = RuntimeSessionBinding(externalSessionID: "ses_duplicate", endpoint: URL(string: "http://127.0.0.1:4096")!,
            directory: SessionTestRuntime.directory, compatibleVersion: "1.18.35", connectionGeneration: f.connection.generation)
        for project in ["project-11111111-1111-1111-1111-111111111111", "project-22222222-2222-2222-2222-222222222222"] {
            _ = try await f.store.backing.save(.init(title: "独立项目", scope: .project(projectID: project, taskID: nil), binding: binding), expectedRevision: nil)
        }
        await f.controller.loadHistory()
        XCTAssertEqual(f.controller.diagnostics.count, 2)
        for record in f.controller.sessions {
            XCTAssertFalse(f.controller.canSend(scope: record.scope))
            await f.controller.reconcileSession(scope: record.scope)
        }
        XCTAssertEqual(f.runtime.read { $0.messageCalls }, 0)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
    }

    @MainActor func testSessionDirectoryMismatchBlocksPrompt() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.returnedDirectory = "/private/tmp/wrong-context" }
        let result = await send(f)
        XCTAssertEqual(result, .notSubmitted)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.state, .failed)
    }

    @MainActor func testConnectionResetClearsConsentAndModelSynchronously() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        XCTAssertTrue(f.controller.externalSendingAllowed)
        f.connection.disconnect()
        XCTAssertFalse(f.controller.externalSendingAllowed)
        XCTAssertNil(f.controller.selectedModel)
        XCTAssertEqual(f.connection.status, .disconnected)
        await f.connection.connect(settings: .init(directory: SessionTestRuntime.directory), password: "fixture-only")
        XCTAssertFalse(f.controller.externalSendingAllowed)
        XCTAssertNil(f.controller.selectedModel)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 0)
    }

    @MainActor func testReconnectionRequiresExplicitHistoryReconciliationBeforeSend() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        _ = await send(f)
        let previousGeneration = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.connectionGeneration)
        f.connection.disconnect()
        await f.connection.connect(settings: .init(directory: SessionTestRuntime.directory), password: "fixture-only")
        f.controller.selectedModel = SessionTestRuntime.model; f.controller.externalSendingAllowed = true
        XCTAssertNotEqual(previousGeneration, f.connection.generation)
        XCTAssertFalse(f.controller.canSend(scope: f.scope))
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.controller.session(for: f.scope)?.binding?.connectionGeneration, f.connection.generation)
        XCTAssertTrue(f.controller.canSend(scope: f.scope))
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testRestartRecoversHistoryWithoutSendingAnyNewPrompt() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        f.controller.shutdown()
        let connection = RuntimeConnectionController(factory: { _, _ in f.runtime })
        let restored = SessionController(store: SessionHistoryStore(root: f.root.appendingPathComponent("history")), connection: connection)
        defer { restored.shutdown() }
        await restored.loadHistory()
        XCTAssertEqual(restored.session(for: f.scope)?.turns.last?.state, .unknown)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        await connection.connect(settings: .init(directory: SessionTestRuntime.directory), password: "fixture-only")
        await restored.reconcileSession(scope: f.scope)
        XCTAssertEqual(restored.session(for: f.scope)?.turns.last?.state, .streaming)
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
    }

    @MainActor func testCompletedBodyAndObservedModelCannotBeOverwrittenByLaterQuery() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.answer(sessionID: session, text: "被更改的旧回复", completed: true, model: .init(providerID: "other", modelID: "other"))
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.controller.session(for: f.scope)?.messages.last?.text, "完整回复")
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.observedModel, SessionTestRuntime.model)
        XCTAssertNotNil(f.controller.error)
        f.runtime.answer(sessionID: session, text: "完整回复", completed: true, model: nil)
        await f.controller.reconcileSession(scope: f.scope)
        XCTAssertEqual(f.controller.session(for: f.scope)?.turns.last?.observedModel, SessionTestRuntime.model)
        XCTAssertNil(f.controller.error)
    }

    @MainActor func testOrdinaryChatWritesOnlyIndependentHistoryNotTaskRecords() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        _ = await send(f)
        let names = try FileManager.default.contentsOfDirectory(atPath: f.root.path)
        XCTAssertEqual(names, ["history"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.root.appendingPathComponent("tasks").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.root.appendingPathComponent("runs").path))
        let listing = try await f.store.backing.list()
        XCTAssertEqual(listing.records.count, 1)
        XCTAssertTrue(listing.diagnostics.isEmpty)
    }

    @MainActor func testDisconnectedStreamRetainsCanonicalTextAndDoesNotResubmit() async throws {
        let f = try await fixture(); defer { f.controller.shutdown() }
        f.runtime.update { $0.completeReplies = false }
        _ = await send(f)
        let session = try XCTUnwrap(f.controller.session(for: f.scope)?.binding?.externalSessionID)
        f.runtime.answer(sessionID: session, text: "已核对的部分回复", completed: false)
        f.runtime.closeStream(sessionID: session)
        await eventually("disconnected stream reconciled") { f.controller.session(for: f.scope)?.turns.last?.state == .unknown }
        XCTAssertEqual(f.controller.session(for: f.scope)?.messages.last?.text, "已核对的部分回复")
        XCTAssertEqual(f.runtime.read { $0.promptCalls }, 1)
        XCTAssertFalse(f.controller.isGenerating(scope: f.scope))
    }
}
