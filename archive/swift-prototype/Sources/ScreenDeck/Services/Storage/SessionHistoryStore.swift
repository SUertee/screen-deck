import Foundation
import CoreFoundation

enum SessionHistoryFailure: LocalizedError, Equatable {
    case invalidRecord, unsupportedVersion, tooLarge, revisionChanged, missingFile, unobservedRecord
    case previousDirectoryNeedsMigration
    case duplicateSession, invalidDatePath, creationDateChanged, incompleteScan

    var errorDescription: String? {
        switch self {
        case .invalidRecord: return "聊天记录损坏或字段不受支持，原文件未覆盖。"
        case .unsupportedVersion: return "聊天记录版本不受支持，原文件未覆盖。"
        case .tooLarge: return "聊天记录超过容量上限，历史未截断，原文件未覆盖。"
        case .revisionChanged: return "聊天记录已被其他窗口或程序修改，请重新读取。"
        case .missingFile: return "已读取的聊天记录已丢失或移动，不会重新创建覆盖历史。"
        case .unobservedRecord: return "请先读取现有聊天记录，再保存更改。"
        case .previousDirectoryNeedsMigration: return "发现旧会话目录（conversations/history 或 sessions/history），需明确迁移到 sessions/年/月/日；未自动移动、合并或覆盖历史，聊天读写暂不可用。"
        case .duplicateSession: return "多个日期目录存在相同会话 ID，未选择或覆盖其中任何记录。"
        case .invalidDatePath: return "会话文件名或日期目录与记录不符，原文件未移动或覆盖。"
        case .creationDateChanged: return "已保存会话的创建时间不能更改，续聊仍使用原文件。"
        case .incompleteScan: return "会话目录扫描未完成或结构异常，不能将其视为空历史。"
        }
    }
}

struct SessionHistoryDiagnostic: Equatable, Sendable {
    let filename: String
    let reason: String
}

struct SessionHistoryListing: Sendable {
    let records: [Session]
    let diagnostics: [SessionHistoryDiagnostic]
}

protocol SessionHistoryStoring: Sendable {
    func load(sessionID: UUID) async throws -> Session?
    func list() async throws -> SessionHistoryListing
    func save(_ session: Session, expectedRevision: Int?) async throws -> Session
}

/// One JSON aggregate per session. SafePrivateStorageIO adds a cooperating-writer flock
/// and exact-byte compare/atomic replacement; the actor is only the in-process serializer.
actor SessionHistoryStore: SessionHistoryStoring {
    static let maximumFileBytes = 16 * 1024 * 1024
    static let maximumMessageBytes = 1024 * 1024
    static let maximumTurns = 1000
    static let maximumMessages = 2000
    static let maximumSessions = 1000
    static let maximumScannedDirectories = SessionHistoryLayout.maximumScannedDirectories
    static let maximumScannedEntries = SessionHistoryLayout.maximumScannedEntries

    let root: URL
    private let previousRoots: [URL]
    private struct Observation { let bytes: Data; let file: URL }
    private var observed: [UUID: Observation] = [:]

    init(root: URL, previousRoots: [URL] = []) {
        self.root = root
        self.previousRoots = previousRoots
    }

    init(root: URL, previousRoot: URL?) {
        self.root = root
        self.previousRoots = previousRoot.map { [$0] } ?? []
    }

    func load(sessionID: UUID) throws -> Session? {
        let index = try scan()
        guard let candidates = index.files[sessionID] else {
            if observed[sessionID] != nil { throw SessionHistoryFailure.missingFile }
            guard !index.hasUnclassifiedFiles else { throw SessionHistoryFailure.incompleteScan }
            return nil
        }
        return try read(sessionID: sessionID, candidates: candidates).record
    }

    func list() throws -> SessionHistoryListing {
        let index = try scan()
        var records: [Session] = [], diagnostics = index.diagnostics
        for (id, candidates) in index.files.sorted(by: { $0.key.uuidString < $1.key.uuidString }) {
            do {
                records.append(try read(sessionID: id, candidates: candidates).record)
            } catch {
                for entry in candidates {
                    diagnostics.append(.init(filename: relativePath(entry), reason: error.localizedDescription))
                }
            }
        }
        records.sort { $0.updatedAt > $1.updatedAt }
        return .init(records: records, diagnostics: diagnostics)
    }

    func save(_ session: Session, expectedRevision: Int?) throws -> Session {
        try validateRoot()
        try Self.validate(session)
        let index = try scan()
        let previous: Data?
        let url: URL
        if let candidates = index.files[session.sessionID] {
            let value = try read(sessionID: session.sessionID, candidates: candidates, observe: false)
            guard observed[session.sessionID] != nil else { throw SessionHistoryFailure.unobservedRecord }
            let existing = value.record
            previous = value.bytes
            url = candidates[0]
            guard existing.sessionID == session.sessionID,
                  existing.scope == session.scope else { throw SessionHistoryFailure.invalidRecord }
            guard Self.dateFormatter().string(from: existing.createdAt) == Self.dateFormatter().string(from: session.createdAt) else {
                throw SessionHistoryFailure.creationDateChanged
            }
            guard let expectedRevision, expectedRevision == existing.revision,
                  session.revision == expectedRevision else { throw SessionHistoryFailure.revisionChanged }
            guard observed[session.sessionID]?.bytes == previous else { throw SessionHistoryFailure.revisionChanged }
        } else {
            guard observed[session.sessionID] == nil, expectedRevision == nil else { throw SessionHistoryFailure.missingFile }
            guard session.revision == 0 else { throw SessionHistoryFailure.revisionChanged }
            guard !index.hasUnclassifiedFiles else { throw SessionHistoryFailure.incompleteScan }
            guard index.fileCount < Self.maximumSessions else { throw SessionHistoryFailure.tooLarge }
            previous = nil
            // Persisted precision determines the bucket as well as the immutable creation timestamp.
            let createdAt = Self.dateFormatter().date(from: Self.dateFormatter().string(from: session.createdAt))!
            url = SessionHistoryLayout.file(for: session.sessionID, createdAt: createdAt, root: root)
        }
        var updated = session
        guard session.revision < Int.max else { throw SessionHistoryFailure.invalidRecord }
        updated.revision += 1
        let data = try Self.encoder().encode(updated)
        guard data.count <= Self.maximumFileBytes else { throw SessionHistoryFailure.tooLarge }
        let persisted = try decode(data)
        try reserveWriteCapacity(index, file: url, createsRecord: previous == nil)
        try SafePrivateStorageIO.write(data, to: url, expected: previous, maximumBytes: Self.maximumFileBytes)
        observed[session.sessionID] = Observation(bytes: data, file: url)
        return persisted
    }

    private func scan() throws -> SessionHistoryLayout.Scan {
        try validateRoot()
        var index = try SessionHistoryLayout.scan(root, maximumSessions: Self.maximumSessions)
        // Filename-only indexing cannot prove absence: a renamed file may still claim another ID.
        // Validate identity without retaining the entire library's JSON bytes in memory.
        for url in index.candidates {
            guard let bytes = try? SafePrivateStorageIO.read(url, maximumBytes: Self.maximumFileBytes) else {
                index.hasUnclassifiedFiles = true
                continue
            }
            // A readable ID is a possible identity claim even if the version/other fields are unsupported.
            if let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
               let value = object["conversation_id"] as? String, let id = UUID(uuidString: value),
               !(index.files[id] ?? []).contains(url) {
                index.files[id, default: []].append(url)
                index.hasUnclassifiedFiles = true
            }
            do { _ = try decode(bytes) }
            catch { index.hasUnclassifiedFiles = true }
        }
        return index
    }

    private func reserveWriteCapacity(_ index: SessionHistoryLayout.Scan, file: URL, createsRecord: Bool) throws {
        var additionalDirectories = 0
        var directory = root
        for component in file.deletingLastPathComponent().pathComponents.dropFirst(root.pathComponents.count) {
            directory = directory.appendingPathComponent(component, isDirectory: true)
            if try !SafePrivateStorageIO.directoryExists(directory) { additionalDirectories += 1 }
        }
        let lock = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).lock")
        let createsLock = try SafePrivateStorageIO.read(lock, maximumBytes: 1) == nil
        // Reserve one more entry for atomic replacement's temporary file, including on updates.
        let additionalEntries = additionalDirectories + (createsRecord ? 1 : 0) + (createsLock ? 1 : 0) + 1
        guard index.directoryCount + additionalDirectories <= Self.maximumScannedDirectories,
              index.entryCount + additionalEntries <= Self.maximumScannedEntries else { throw SessionHistoryFailure.tooLarge }
    }

    private func read(sessionID: UUID, candidates: [URL], observe: Bool = true) throws -> (record: Session, bytes: Data) {
        guard candidates.count == 1 else { throw SessionHistoryFailure.duplicateSession }
        let url = candidates[0]
        if let original = observed[sessionID], original.file != url { throw SessionHistoryFailure.missingFile }
        guard let data = try SafePrivateStorageIO.read(url, maximumBytes: Self.maximumFileBytes) else {
            throw SessionHistoryFailure.missingFile
        }
        let record = try decode(data)
        guard record.sessionID == sessionID else { throw SessionHistoryFailure.invalidRecord }
        guard url == SessionHistoryLayout.file(for: sessionID, createdAt: record.createdAt, root: root) else {
            throw SessionHistoryFailure.invalidDatePath
        }
        if observe { observed[sessionID] = Observation(bytes: data, file: url) }
        return (record, data)
    }

    private func relativePath(_ url: URL) -> String {
        url.pathComponents.dropFirst(root.pathComponents.count).joined(separator: "/")
    }

    private func validateRoot() throws {
        guard root.isFileURL, root.path != "/", !root.path.contains("\0") else { throw SessionHistoryFailure.invalidRecord }
        for previousRoot in previousRoots {
            guard previousRoot.isFileURL, previousRoot.path != "/", !previousRoot.path.contains("\0") else {
                throw SessionHistoryFailure.invalidRecord
            }
            // Fail closed even for an empty old directory. Selecting between two roots is a migration decision.
            if try SafePrivateStorageIO.directoryExists(previousRoot) {
                throw SessionHistoryFailure.previousDirectoryNeedsMigration
            }
        }
        // Traverses each existing ancestor with O_NOFOLLOW; missing directories are not created.
        _ = try SafePrivateStorageIO.read(root.appendingPathComponent(".chat-history-validation"), maximumBytes: 1)
    }

    private func decode(_ data: Data) throws -> Session {
        guard data.count <= Self.maximumFileBytes else { throw SessionHistoryFailure.tooLarge }
        do {
            try Self.validateFields(data)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom { decoder in
                let value = try decoder.singleValueContainer().decode(String.self)
                guard let date = Self.dateFormatter().date(from: value) else { throw SessionHistoryFailure.invalidRecord }
                return date
            }
            let record = try decoder.decode(Session.self, from: data)
            try Self.validate(record)
            guard record.revision > 0 else { throw SessionHistoryFailure.invalidRecord }
            return record
        } catch let failure as SessionHistoryFailure { throw failure }
        catch { throw SessionHistoryFailure.invalidRecord }
    }

    private static func dateFormatter() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }

    private static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var value = encoder.singleValueContainer()
            try value.encode(dateFormatter().string(from: date))
        }
        return encoder
    }

    private static func validate(_ record: Session) throws {
        guard record.schemaVersion == 1 else { throw SessionHistoryFailure.unsupportedVersion }
        guard record.revision >= 0, !record.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              record.title.utf8.count <= 600, validDate(record.createdAt),
              validDate(record.updatedAt) else { throw SessionHistoryFailure.invalidRecord }
        guard record.turns.count <= maximumTurns, record.messages.count <= maximumMessages else { throw SessionHistoryFailure.tooLarge }
        if case .project(let projectID, let taskID) = record.scope {
            _ = try ProjectConversationKey(projectID: projectID, taskID: taskID).validated()
        }
        if let binding = record.binding {
            guard bounded(binding.externalSessionID, maximum: 256), bounded(binding.compatibleVersion, maximum: 100),
                  binding.directory.hasPrefix("/"), binding.directory.utf8.count <= 4096,
                  !binding.directory.contains("\0"), !binding.directory.contains("\n"), !binding.directory.contains("\r"),
                  !binding.directory.split(separator: "/").contains(".."),
                  binding.endpoint.scheme == "http", ["127.0.0.1", "[::1]", "::1"].contains(binding.endpoint.host ?? ""),
                  binding.endpoint.user == nil, binding.endpoint.password == nil,
                  binding.endpoint.query == nil, binding.endpoint.fragment == nil,
                  binding.endpoint.path.isEmpty || binding.endpoint.path == "/",
                  binding.endpoint.port.map({ (1...65535).contains($0) }) == true else { throw SessionHistoryFailure.invalidRecord }
        }
        var turnIDs = Set<UUID>(), requestIDs = Set<UUID>(), messageIDs = Set<UUID>()
        for turn in record.turns {
            guard turnIDs.insert(turn.turnID).inserted, requestIDs.insert(turn.clientRequestID).inserted,
                  turn.draftRevision >= 0, validDate(turn.createdAt),
                  validDate(turn.updatedAt) else { throw SessionHistoryFailure.invalidRecord }
            try validateModel(turn.requestedModel)
            if let model = turn.observedModel { try validateModel(model) }
            if let failure = turn.failure, failure.utf8.count > 4096 { throw SessionHistoryFailure.tooLarge }
        }
        var externalMessages: [String: (turnID: UUID, role: MessageRole, whole: Bool, parts: Set<String>)] = [:]
        for message in record.messages {
            guard messageIDs.insert(message.messageID).inserted, turnIDs.contains(message.turnID),
                  validDate(message.createdAt), validDate(message.updatedAt) else {
                throw SessionHistoryFailure.invalidRecord
            }
            guard message.text.utf8.count <= maximumMessageBytes else { throw SessionHistoryFailure.tooLarge }
            for value in [message.externalMessageID, message.externalPartID].compactMap({ $0 }) {
                guard bounded(value, maximum: 256) else { throw SessionHistoryFailure.invalidRecord }
            }
            guard message.externalPartID == nil || message.externalMessageID != nil else { throw SessionHistoryFailure.invalidRecord }
            if let externalID = message.externalMessageID {
                if var group = externalMessages[externalID] {
                    guard group.turnID == message.turnID, group.role == message.role, !group.whole,
                          let part = message.externalPartID, group.parts.insert(part).inserted else { throw SessionHistoryFailure.invalidRecord }
                    externalMessages[externalID] = group
                } else {
                    externalMessages[externalID] = (message.turnID, message.role, message.externalPartID == nil,
                                                    Set(message.externalPartID.map { [$0] } ?? []))
                }
            }
        }
    }

    private static func validateModel(_ model: ModelSelection) throws {
        guard bounded(model.providerID, maximum: 150), bounded(model.modelID, maximum: 200),
              model.variant.map({ bounded($0, maximum: 100) }) ?? true else { throw SessionHistoryFailure.invalidRecord }
    }

    private static func bounded(_ string: String, maximum: Int) -> Bool {
        !string.isEmpty && !string.contains("\0") && string.utf8.count <= maximum
    }

    private static func validDate(_ date: Date) -> Bool {
        let seconds = date.timeIntervalSince1970
        return seconds.isFinite && (0...253_402_300_799).contains(seconds)
    }

    /// JSONDecoder normally ignores unknown keys. Reject them before decoding, recursively,
    /// so future/secret/async-handle fields cannot be silently accepted or stripped on save.
    private static func validateFields(_ data: Data) throws {
        guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw SessionHistoryFailure.invalidRecord }
        try keys(record, required: ["schema_version", "conversation_id", "title", "scope", "created_at", "updated_at", "revision", "turns", "messages"], optional: ["binding"])
        guard let version = integer(record["schema_version"]), version == 1 else { throw SessionHistoryFailure.unsupportedVersion }
        guard integer(record["revision"]) != nil else { throw SessionHistoryFailure.invalidRecord }
        guard let scope = record["scope"] as? [String: Any] else { throw SessionHistoryFailure.invalidRecord }
        switch scope["kind"] as? String {
        case "local_chat": try keys(scope, required: ["kind", "local_chat_id"])
        case "local_task": try keys(scope, required: ["kind", "local_task_id"])
        case "project": try keys(scope, required: ["kind", "project_id"], optional: ["task_id"])
        default: throw SessionHistoryFailure.invalidRecord
        }
        if let value = record["binding"], !(value is NSNull) {
            guard let binding = value as? [String: Any] else { throw SessionHistoryFailure.invalidRecord }
            try keys(binding, required: ["external_session_id", "endpoint", "directory", "compatible_version", "connection_generation"])
        }
        guard let turns = record["turns"] as? [[String: Any]], let messages = record["messages"] as? [[String: Any]] else {
            throw SessionHistoryFailure.invalidRecord
        }
        guard turns.count <= maximumTurns, messages.count <= maximumMessages else { throw SessionHistoryFailure.tooLarge }
        for turn in turns {
            try keys(turn, required: ["turn_id", "client_request_id", "requested_model", "state", "created_at", "updated_at", "draft_revision"], optional: ["observed_model", "failure"])
            guard integer(turn["draft_revision"]) != nil else { throw SessionHistoryFailure.invalidRecord }
            for key in ["requested_model", "observed_model"] {
                if let value = turn[key], !(value is NSNull) {
                    guard let model = value as? [String: Any] else { throw SessionHistoryFailure.invalidRecord }
                    try keys(model, required: ["provider_id", "model_id"], optional: ["variant"])
                }
            }
        }
        for message in messages {
            try keys(message, required: ["message_id", "turn_id", "role", "text", "created_at", "updated_at"], optional: ["external_message_id", "external_part_id"])
        }
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue < Double(Int.max) else { return nil }
        return number.intValue
    }

    private static func keys(_ object: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(object.keys)
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else { throw SessionHistoryFailure.invalidRecord }
    }
}
