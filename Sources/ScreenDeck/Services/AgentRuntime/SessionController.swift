import Foundation
import Combine

enum SendResult: Equatable { case accepted, notSubmitted, uncertain }

/// Durable turns are data. Network tasks and cancellation belong only to this controller.
@MainActor
final class SessionController: ObservableObject {
    @Published private(set) var sessions: [Session] = []
    @Published private(set) var historyLoaded = false
    @Published private(set) var error: String?
    @Published private(set) var diagnostics: [SessionHistoryDiagnostic] = []
    @Published var selectedModel: ModelSelection?
    @Published var externalSendingAllowed = false
    let connection: RuntimeConnectionController
    private let store: (any SessionHistoryStoring)?
    private var connectionObservation: AnyCancellable?
    private var operations: Set<UUID> = []
    private var sendingScopes: Set<SessionScope> = []
    private var streams: [UUID: Task<Void, Never>] = [:]
    private var refreshRequested: Set<UUID> = []
    private var disconnectedStreams: Set<UUID> = []
    private var safetyFailures: Set<UUID> = []
    private var blockedScopes: Set<SessionScope> = []
    private var stopRequests: Set<UUID> = []
    private var stopBeforeSubmission: Set<SessionScope> = []
    private var pendingWrites: [UUID: Session] = [:]
    private var loading = false
    var hasPendingWrites: Bool { !pendingWrites.isEmpty }
    var hasActiveTurn: Bool { !operations.isEmpty || !streams.isEmpty || !sendingScopes.isEmpty || !stopRequests.isEmpty }

    /// Default construction has no file or network side effects, including in render tests.
    init(store: (any SessionHistoryStoring)? = nil, connection: RuntimeConnectionController? = nil) {
        self.store = store
        let resolved = connection ?? RuntimeConnectionController()
        self.connection = resolved
        resolved.permitsChange = { [weak self] in self?.hasActiveTurn != true && self?.hasPendingWrites != true }
        resolved.onReset = { [weak self] in self?.externalSendingAllowed = false; self?.selectedModel = nil }
        connectionObservation = resolved.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.objectWillChange.send()
            }
        }
    }

    func session(for scope: SessionScope) -> Session? { sessions.first { $0.scope == scope } }
    func isGenerating(scope: SessionScope) -> Bool {
        sendingScopes.contains(scope) || session(for: scope).map { streams[$0.id] != nil || operations.contains($0.id) } == true
    }
    func needsReconciliation(scope: SessionScope) -> Bool {
        guard let record = session(for: scope) else { return false }
        if let binding = record.binding, binding.connectionGeneration != connection.generation { return true }
        return pendingWrites[record.id] != nil || record.turns.contains { [.prepared, .submitting, .unknown, .cancelling].contains($0.state) }
    }
    func canSend(scope: SessionScope) -> Bool {
        historyLoaded && !loading && store != nil && connection.canSend && externalSendingAllowed && modelIsAvailable &&
        !blockedScopes.contains(scope) &&
        !isGenerating(scope: scope) && !needsReconciliation(scope: scope) && !hasPendingWrites &&
        session(for: scope)?.turns.contains(where: { $0.state == .streaming }) != true
    }
    private var modelIsAvailable: Bool {
        guard let selectedModel else { return false }
        return connection.providers.contains { provider in
            provider.providerID == selectedModel.providerID && provider.models.contains {
                $0.modelID == selectedModel.modelID && (selectedModel.variant == nil || $0.variants.contains(selectedModel.variant!))
            }
        }
    }

    func loadHistory() async {
        guard let store, !loading, !hasActiveTurn, !hasPendingWrites else { return }
        loading = true; defer { loading = false }
        do {
            let listing = try await store.list()
            var seen: Set<SessionScope> = []
            var accepted: [Session] = []
            var issues = listing.diagnostics
            blockedScopes.removeAll()
            for var record in listing.records {
                guard seen.insert(record.scope).inserted else {
                    blockedScopes.insert(record.scope)
                    issues.append(.init(filename: record.id.uuidString, reason: "同一上下文存在多个聊天记录，请人工核对。")); continue
                }
                for index in record.turns.indices where !Self.isTerminal(record.turns[index].state) {
                    if record.turns[index].state == .prepared && !record.messages.contains(where: { $0.turnID == record.turns[index].id && $0.externalMessageID != nil }) {
                        record.turns[index].state = .failed
                        record.turns[index].failure = "该轮在提交前中断，未发送给模型。"
                    } else {
                        record.turns[index].state = .unknown
                        if record.turns[index].failure?.contains("非聊天能力") == true { safetyFailures.insert(record.id) }
                        else { record.turns[index].failure = "上次回复尚未核对；恢复不会自动重发。" }
                    }
                }
                accepted.append(record)
            }
            for record in accepted {
                guard let binding = record.binding else { continue }
                if accepted.contains(where: { $0.id != record.id && Self.sameExternalSession($0.binding, binding) }) {
                    blockedScopes.insert(record.scope)
                    issues.append(.init(filename: record.id.uuidString, reason: "外部会话重复关联，已禁止发送和核对，请人工检查。"))
                }
            }
            sessions = accepted; diagnostics = issues; historyLoaded = true; error = nil
        } catch { historyLoaded = false; self.error = Self.storageDiagnostic(error) }
    }

    func sendMessage(text: String, scope: SessionScope, draftRevision: Int) async -> SendResult {
        guard canSend(scope: scope), let client = connection.client, let settings = connection.settings,
              let report = connection.report, let model = selectedModel else {
            error = connection.report?.safety.canSend == false ? connection.report?.safety.diagnostic : "请连接、选择模型并确认外发；有待核对记录时不能重发。"
            return .notSubmitted
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 128 * 1024, draftRevision >= 0 else {
            error = "消息为空或超过聊天容量上限。"; return .notSubmitted
        }
        sendingScopes.insert(scope)
        let proposedTitle = String(text.prefix(60))
        var record = session(for: scope) ?? Session(title: proposedTitle.utf8.count <= 600 ? proposedTitle : "新聊天", scope: scope)
        if case .localChat(let id) = scope, record.revision == 0 { record.sessionID = id }
        let id = record.id
        operations.insert(id)
        defer { sendingScopes.remove(scope); finishOperation(id) }
        guard record.turns.count < SessionHistoryStore.maximumTurns,
              record.messages.count + 2 <= SessionHistoryStore.maximumMessages else {
            error = "该聊天已达容量上限，请新建聊天；历史不会被截断。"; return .notSubmitted
        }
        let turn = Turn(requestedModel: model, draftRevision: draftRevision)
        let externalID = Self.externalMessageID(for: turn.clientRequestID)
        record.turns.append(turn)
        record.messages.append(Message(turnID: turn.id, role: .user, text: text))
        record.updatedAt = Date()
        guard await persist(record, beforeSubmission: true) else { return .notSubmitted }
        if stopBeforeSubmission.remove(scope) != nil || stopRequests.remove(id) != nil {
            await cancelBeforeSubmission(id, turnID: turn.id)
            return .notSubmitted
        }
        do {
            if let binding = record.binding {
                guard binding.endpoint == settings.endpoint, binding.directory == settings.directory,
                      binding.compatibleVersion == report.version, binding.connectionGeneration == connection.generation else {
                    throw OpenCodeError.unsafeProfile("连接已变化，请先核对原会话；不会自动创建替代会话或重发。")
                }
                try await validateRuntimeSession(binding, client: client)
            } else {
                let session = try await client.createSession(title: record.title)
                guard session.directory == settings.directory else { throw OpenCodeError.invalidDirectory }
                guard !sessions.contains(where: { $0.id != id && $0.binding?.externalSessionID == session.externalSessionID && $0.binding?.endpoint == settings.endpoint && $0.binding?.directory == session.directory }) else {
                    throw OpenCodeError.unsafeProfile("外部会话已属于另一个聊天，不会跨项目复用。")
                }
                record = current(id)!
                record.binding = RuntimeSessionBinding(externalSessionID: session.externalSessionID, endpoint: settings.endpoint,
                    directory: session.directory, compatibleVersion: report.version, connectionGeneration: connection.generation)
                guard await persist(record, beforeSubmission: true) else { return .notSubmitted }
            }
        } catch {
            await setState(id, turnID: turn.id, state: .failed, failure: Self.runtimeDiagnostic(error))
            return .notSubmitted
        }
        guard let binding = current(id)?.binding else { return .notSubmitted }
        if stopRequests.remove(id) != nil {
            await cancelBeforeSubmission(id, turnID: turn.id)
            return .notSubmitted
        }
        record = current(id)!
        record.turns[record.turns.count - 1].state = .submitting
        if let index = record.messages.firstIndex(where: { $0.turnID == turn.id && $0.role == .user }) { record.messages[index].externalMessageID = externalID }
        guard await persist(record, beforeSubmission: true) else { return .notSubmitted }
        if stopRequests.remove(id) != nil {
            await cancelBeforeSubmission(id, turnID: turn.id)
            return .notSubmitted
        }
        startStream(id, binding: binding, client: client)
        do {
            let receipt = try await client.sendMessage(sessionID: binding.externalSessionID,
                clientRequestID: turn.clientRequestID.uuidString, text: text, model: model)
            guard receipt.externalMessageID == externalID else { throw OpenCodeError.malformedResponse }
        } catch {
            if stopRequests.remove(id) != nil { try? await client.abort(sessionID: binding.externalSessionID) }
            await setState(id, turnID: turn.id, state: .unknown, failure: Self.runtimeDiagnostic(error))
            cancelStream(id); return .uncertain
        }
        if safetyFailures.contains(id) {
            await setState(id, turnID: turn.id, state: .unknown, failure: "检测到非聊天能力，已尝试拒绝并停止；请核对结果。")
            cancelStream(id); return .uncertain
        }
        guard await setState(id, turnID: turn.id, state: .streaming, failure: nil) else {
            if stopRequests.remove(id) != nil { try? await client.abort(sessionID: binding.externalSessionID) }
            cancelStream(id); return .uncertain
        }
        if stopRequests.remove(id) != nil {
            _ = await setState(id, turnID: turn.id, state: .cancelling, failure: "已请求停止，等待服务核对。")
            do { try await client.abort(sessionID: binding.externalSessionID) }
            catch { await setState(id, turnID: turn.id, state: .unknown, failure: "停止结果未确认，请核对会话。"); cancelStream(id); return .accepted }
        }
        do { try await refresh(id, client: client, allowRebind: false) }
        catch { await setState(id, turnID: turn.id, state: .unknown, failure: Self.runtimeDiagnostic(error)); cancelStream(id) }
        return .accepted
    }

    func reconcileSession(scope: SessionScope) async {
        guard !blockedScopes.contains(scope) else { error = "该会话关联有冲突，不能自动核对或合并。"; return }
        guard let record = session(for: scope), let client = connection.client, !operations.contains(record.id) else { return }
        guard pendingWrites[record.id] == nil else { error = "请先重试保存，避免覆盖尚未落盘的回复。"; return }
        operations.insert(record.id); defer { finishOperation(record.id) }
        do {
            try await refresh(record.id, client: client, allowRebind: true)
            if let updated = current(record.id), updated.turns.last?.state == .streaming, let binding = updated.binding {
                startStream(record.id, binding: binding, client: client)
            }
            error = nil
        } catch { self.error = Self.runtimeDiagnostic(error) }
    }

    func stopGeneration(scope: SessionScope) async {
        if sendingScopes.contains(scope), session(for: scope) == nil {
            stopBeforeSubmission.insert(scope); error = "准备发送已取消，将保留输入。"; return
        }
        if let record = session(for: scope), operations.contains(record.id), isGenerating(scope: scope) {
            stopRequests.insert(record.id); error = "停止已排队；提交结果核对后会请求服务停止。"; return
        }
        guard let record = session(for: scope), let binding = record.binding, let turn = record.turns.last,
              !Self.isTerminal(turn.state), let client = connection.client, !operations.contains(record.id) else { return }
        operations.insert(record.id); defer { finishOperation(record.id) }
        do {
            try await validateRuntimeSession(binding, client: client)
            _ = await setState(record.id, turnID: turn.id, state: .cancelling, failure: "已请求停止，等待服务核对。")
            // Failure to save cannot silently suppress an explicitly requested abort.
            try await client.abort(sessionID: binding.externalSessionID)
            try await refresh(record.id, client: client, allowRebind: true)
            if current(record.id)?.turns.last?.state != .cancelled && current(record.id)?.turns.last?.state != .finished {
                await setState(record.id, turnID: turn.id, state: .unknown, failure: "停止回复尚未确认；不会当作已取消。")
            }
            cancelStream(record.id)
        } catch {
            await setState(record.id, turnID: turn.id, state: .unknown, failure: "停止结果未确认，请核对会话。")
            cancelStream(record.id)
        }
    }

    func retryPendingWrites() async {
        for (id, record) in pendingWrites where !operations.contains(id) {
            operations.insert(id)
            _ = await persist(record)
            finishOperation(id)
        }
    }

    /// App exit cancels subscriptions only. It does not pretend an external operation stopped.
    func shutdown() { for task in streams.values { task.cancel() }; streams.removeAll() }

    private func startStream(_ id: UUID, binding: RuntimeSessionBinding, client: any RuntimeClient) {
        cancelStream(id); disconnectedStreams.remove(id)
        let events = client.events(sessionID: binding.externalSessionID)
        streams[id] = Task { [weak self] in
            do {
                for try await event in events {
                    guard !Task.isCancelled, let self else { return }
                    await self.receive(event, id: id, binding: binding, client: client)
                }
            } catch { /* A dropped stream is reconciled, never blindly reconnected or replayed. */ }
            guard !Task.isCancelled, let self else { return }
            self.disconnectedStreams.insert(id); self.refreshRequested.insert(id)
            self.scheduleRefresh(id, client: client)
        }
    }

    private func receive(_ event: RuntimeStreamEvent, id: UUID, binding: RuntimeSessionBinding, client: any RuntimeClient) async {
        guard current(id)?.binding == binding else { return }
        let sessionID: String
        switch event {
        case .messageUpdated(let message): sessionID = message.externalSessionID
        case .textSnapshot(let session, _, _, _), .textDelta(let session, _, _, _),
             .statusChanged(let session, _), .failure(let session, _), .permissionRequested(let session, _),
             .toolDetected(let session, _), .messageRemoved(let session, _), .partRemoved(let session, _, _): sessionID = session
        }
        guard sessionID == binding.externalSessionID else { return }
        switch event {
        case .permissionRequested(_, let requestID):
            safetyFailures.insert(id)
            try? await client.rejectPermission(sessionID: sessionID, requestID: requestID)
            try? await client.abort(sessionID: sessionID)
        case .toolDetected:
            safetyFailures.insert(id); try? await client.abort(sessionID: sessionID)
        default: break
        }
        // Event IDs help bounded deduplication, not permanent ordering or replay guarantees.
        // Fetch canonical parts instead of appending ambiguous chunks/regressing old snapshots.
        refreshRequested.insert(id); scheduleRefresh(id, client: client)
    }

    private func scheduleRefresh(_ id: UUID, client: any RuntimeClient) {
        guard !operations.contains(id), refreshRequested.remove(id) != nil else { return }
        operations.insert(id)
        Task { [weak self] in
            guard let self else { return }
            defer { self.finishOperation(id) }
            do { try await self.refresh(id, client: client, allowRebind: false) }
            catch {
                if let turn = self.current(id)?.turns.last, !Self.isTerminal(turn.state) {
                    await self.setState(id, turnID: turn.id, state: .unknown, failure: Self.runtimeDiagnostic(error))
                }
                self.cancelStream(id)
            }
        }
    }

    private func refresh(_ id: UUID, client: any RuntimeClient, allowRebind: Bool) async throws {
        guard var record = current(id), let binding = record.binding, let settings = connection.settings,
              let report = connection.report, binding.endpoint == settings.endpoint, binding.directory == settings.directory,
              binding.compatibleVersion == report.version,
              allowRebind || binding.connectionGeneration == connection.generation else { throw OpenCodeError.invalidDirectory }
        try await validateRuntimeSession(binding, client: client)
        let remote = try await client.messages(sessionID: binding.externalSessionID)
        let status = try await client.status(sessionID: binding.externalSessionID)
        guard Set(remote.map(\.externalMessageID)).count == remote.count,
              remote.allSatisfy({ $0.externalSessionID == binding.externalSessionID }) else { throw OpenCodeError.malformedResponse }
        let userMessages = record.messages.filter { $0.role == .user }
        let previouslyTerminal = Set(record.turns.filter { Self.isTerminal($0.state) }.map(\.id))
        var matchedUsers: Set<String> = []
        for message in userMessages where message.externalMessageID != nil {
            if let externalID = message.externalMessageID, let match = remote.first(where: { $0.externalMessageID == externalID }) {
                guard match.role == "user", match.text == message.text else { throw OpenCodeError.malformedResponse }
                matchedUsers.insert(externalID)
            } else if record.turns.first(where: { $0.id == message.turnID }).map({ Self.isTerminal($0.state) }) == true {
                throw OpenCodeError.unsafeProfile("原会话历史不完整，不能自动关联到另一服务。")
            }
        }
        for message in remote where message.role == "assistant" {
            guard let parent = message.parentMessageID, matchedUsers.contains(parent), let user = userMessages.first(where: { $0.externalMessageID == parent }),
                  let turnIndex = record.turns.firstIndex(where: { $0.id == user.turnID }) else { continue }
            guard message.text.utf8.count <= SessionHistoryStore.maximumMessageBytes else { throw SessionHistoryFailure.tooLarge }
            if let index = record.messages.firstIndex(where: { $0.externalMessageID == message.externalMessageID }) {
                guard record.messages[index].role == .assistant, record.messages[index].turnID == user.turnID else {
                    throw OpenCodeError.malformedResponse
                }
                if previouslyTerminal.contains(user.turnID) {
                    guard record.messages[index].text == message.text else { throw OpenCodeError.unsafeProfile("已完成回复在服务端发生变化，本地原件未覆盖。") }
                } else { record.messages[index].text = message.text; record.messages[index].updatedAt = Date() }
            } else {
                guard !previouslyTerminal.contains(user.turnID) else { throw OpenCodeError.unsafeProfile("已完成轮次出现新的回复，请人工核对。") }
                guard record.messages.count < SessionHistoryStore.maximumMessages else { throw SessionHistoryFailure.tooLarge }
                record.messages.append(Message(turnID: user.turnID, role: .assistant, text: message.text,
                    externalMessageID: message.externalMessageID, createdAt: message.createdAt ?? Date()))
            }
            if let observed = message.observedModel {
                if previouslyTerminal.contains(user.turnID), let old = record.turns[turnIndex].observedModel, old != observed {
                    throw OpenCodeError.unsafeProfile("已核实的模型信息发生变化，本地记录未覆盖。")
                }
                record.turns[turnIndex].observedModel = observed
            }
            if !Self.isTerminal(record.turns[turnIndex].state) {
                if message.failure != nil { record.turns[turnIndex].state = .failed; record.turns[turnIndex].failure = "模型回复失败，请核对已保存内容。" }
                else if message.completedAt != nil && status == .idle { record.turns[turnIndex].state = .finished; record.turns[turnIndex].failure = nil }
            }
        }
        if let index = record.turns.indices.last, safetyFailures.contains(id) || !Self.isTerminal(record.turns[index].state) {
            if safetyFailures.contains(id) {
                record.turns[index].state = .unknown; record.turns[index].failure = "检测到非聊天能力，已拒绝并请求停止；请核对服务。"
            } else if record.messages.first(where: { $0.turnID == record.turns[index].id && $0.role == .user }).flatMap(\.externalMessageID).map({ matchedUsers.contains($0) }) != true {
                record.turns[index].state = .unknown; record.turns[index].failure = "未找到本轮已提交消息，不能把其它活动当作当前回复。"
            } else if record.turns[index].state == .cancelling && status == .idle {
                record.turns[index].state = .cancelled; record.turns[index].failure = nil
            } else if disconnectedStreams.contains(id) || status == .idle {
                record.turns[index].state = .unknown; record.turns[index].failure = "回复状态尚未确认，请核对会话；不会自动重发。"
            } else {
                record.turns[index].state = .streaming; record.turns[index].failure = nil
            }
            record.turns[index].updatedAt = Date()
        }
        if allowRebind, record.turns.last?.state != .unknown { record.binding?.connectionGeneration = connection.generation }
        record.updatedAt = Date()
        guard await persist(record) else { throw SessionHistoryFailure.revisionChanged }
        if record.turns.last.map({ Self.isTerminal($0.state) || $0.state == .unknown }) == true { cancelStream(id) }
    }

    private func validateRuntimeSession(_ binding: RuntimeSessionBinding, client: any RuntimeClient) async throws {
        guard let settings = connection.settings, let report = connection.report,
              binding.endpoint == settings.endpoint, binding.directory == settings.directory,
              binding.compatibleVersion == report.version else { throw OpenCodeError.invalidDirectory }
        let session = try await client.session(sessionID: binding.externalSessionID)
        guard session.externalSessionID == binding.externalSessionID, session.directory == binding.directory else {
            throw OpenCodeError.invalidDirectory
        }
    }

    @discardableResult
    private func setState(_ id: UUID, turnID: UUID, state: TurnState, failure: String?) async -> Bool {
        guard var record = current(id), let index = record.turns.firstIndex(where: { $0.id == turnID }) else { return false }
        record.turns[index].state = state; record.turns[index].failure = failure; record.turns[index].updatedAt = Date()
        record.updatedAt = Date(); return await persist(record)
    }

    private func cancelBeforeSubmission(_ id: UUID, turnID: UUID) async {
        guard var record = current(id), let index = record.turns.firstIndex(where: { $0.id == turnID }) else { return }
        record.turns[index].state = .cancelled; record.turns[index].failure = "发送前已取消。"
        record.turns[index].updatedAt = Date(); record.updatedAt = Date()
        for message in record.messages.indices where record.messages[message].turnID == turnID {
            record.messages[message].externalMessageID = nil
        }
        _ = await persist(record, beforeSubmission: true)
    }

    @discardableResult
    private func persist(_ record: Session, beforeSubmission: Bool = false) async -> Bool {
        guard let store else { error = "聊天存储未初始化。"; return false }
        do {
            let saved = try await store.save(record, expectedRevision: record.revision == 0 ? nil : record.revision)
            pendingWrites.removeValue(forKey: record.id); publish(saved); error = nil; return true
        } catch {
            var retained = record
            if let index = retained.turns.indices.last, !Self.isTerminal(retained.turns[index].state) {
                retained.turns[index].state = beforeSubmission ? .failed : .unknown
                retained.turns[index].failure = beforeSubmission ? "提交前保存失败，该轮未发送给模型。" : "回复未完全保存，请重试保存；不会自动重发。"
                if beforeSubmission {
                    for message in retained.messages.indices where retained.messages[message].turnID == retained.turns[index].id {
                        retained.messages[message].externalMessageID = nil
                    }
                }
            }
            pendingWrites[record.id] = retained; publish(retained); self.error = Self.storageDiagnostic(error); return false
        }
    }

    private func publish(_ record: Session) {
        if let index = sessions.firstIndex(where: { $0.id == record.id }) { sessions[index] = record }
        else { sessions.append(record) }
        sessions.sort { $0.updatedAt > $1.updatedAt }
    }
    private func current(_ id: UUID) -> Session? { sessions.first { $0.id == id } }
    private func cancelStream(_ id: UUID) { streams.removeValue(forKey: id)?.cancel() }
    private func finishOperation(_ id: UUID) {
        operations.remove(id); objectWillChange.send()
        if stopRequests.contains(id), let record = current(id) {
            if let turn = record.turns.last, !Self.isTerminal(turn.state) {
                Task { [weak self] in
                    guard let self else { return }
                    self.stopRequests.remove(id)
                    await self.stopGeneration(scope: record.scope)
                }
                return
            }
            stopRequests.remove(id)
        }
        if let client = connection.client { scheduleRefresh(id, client: client) }
    }
    static func externalMessageID(for requestID: UUID) -> String { "msg" + requestID.uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
    private static func sameExternalSession(_ left: RuntimeSessionBinding?, _ right: RuntimeSessionBinding) -> Bool {
        left?.endpoint == right.endpoint && left?.directory == right.directory && left?.externalSessionID == right.externalSessionID
    }
    private static func isTerminal(_ state: TurnState) -> Bool { [.finished, .failed, .cancelled].contains(state) }
    private static func runtimeDiagnostic(_ error: Error) -> String {
        (error as? OpenCodeError)?.localizedDescription ?? (error as? SessionHistoryFailure)?.localizedDescription ?? "会话请求未完成，请核对状态；不会自动重发。"
    }
    private static func storageDiagnostic(_ error: Error) -> String {
        (error as? SessionHistoryFailure)?.localizedDescription ?? "聊天记录未能安全保存或读取，原文件不会被覆盖。"
    }
}
