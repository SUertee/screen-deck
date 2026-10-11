import Foundation

/// Bounded SSE framing over bytes, preserving UTF-8 split across network chunks.
struct OpenCodeSSEDecoder {
    private var line = Data()
    private var dataLines: [String] = []
    private var eventByteCount = 0
    private var previousWasCR = false
    private var firstLine = true
    private var eventID: String?
    let maximumLineBytes: Int
    let maximumEventBytes: Int

    struct Frame: Equatable { let id: String?; let data: Data }
    init(maximumLineBytes: Int = 256 * 1024, maximumEventBytes: Int = 1024 * 1024) {
        self.maximumLineBytes = maximumLineBytes; self.maximumEventBytes = maximumEventBytes
    }

    mutating func append(_ bytes: Data) throws -> [Frame] {
        var frames: [Frame] = []
        for byte in bytes {
            if previousWasCR {
                previousWasCR = false
                if byte == 10 { continue }
            }
            if byte == 13 || byte == 10 {
                if let frame = try consumeLine() { frames.append(frame) }
                previousWasCR = byte == 13
            } else {
                guard line.count < maximumLineBytes else { throw OpenCodeError.responseTooLarge }
                line.append(byte)
            }
        }
        return frames
    }

    private mutating func consumeLine() throws -> Frame? {
        guard var value = String(data: line, encoding: .utf8) else { throw OpenCodeError.malformedResponse }
        line.removeAll(keepingCapacity: true)
        if firstLine { firstLine = false; if value.hasPrefix("\u{FEFF}") { value.removeFirst() } }
        if value.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true); eventByteCount = 0; eventID = nil }
            guard !dataLines.isEmpty else { return nil }
            return Frame(id: eventID, data: Data(dataLines.joined(separator: "\n").utf8))
        }
        if value.hasPrefix(":") { return nil }
        let pair = value.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(pair[0])
        var content = pair.count == 2 ? String(pair[1]) : ""
        if content.hasPrefix(" ") { content.removeFirst() }
        switch field {
        case "data":
            eventByteCount += content.utf8.count + 1
            guard eventByteCount <= maximumEventBytes else { throw OpenCodeError.responseTooLarge }
            dataLines.append(content)
        case "id": if !content.contains("\0") { eventID = content }
        default: break
        }
        return nil
    }
}

/// Official v1.18.35 protocol projection; never exposes reasoning/tool payloads to the chat.
struct OpenCodeEventMapper {
    let sessionID: String
    private var seenEventIDs = Set<String>()
    private var eventIDs: [String] = []
    private var partKinds: [String: String] = [:]
    private let maximumRememberedEvents = 4096

    init(sessionID: String) { self.sessionID = sessionID }

    mutating func map(_ frame: OpenCodeSSEDecoder.Frame) throws -> RuntimeStreamEvent? {
        guard let object = try JSONSerialization.jsonObject(with: frame.data) as? [String: Any],
              let type = object["type"] as? String else { throw OpenCodeError.malformedResponse }
        // /event is instance-scoped. Never publish another conversation's events.
        let properties = object["properties"] as? [String: Any] ?? [:]
        let info = properties["info"] as? [String: Any]
        let part = properties["part"] as? [String: Any]
        let externalSessionID = properties["sessionID"] as? String ?? info?["sessionID"] as? String ?? part?["sessionID"] as? String
        guard externalSessionID == sessionID else { return nil }
        let eventID = object["id"] as? String ?? frame.id
        if let eventID, eventID.utf8.count > 160 { throw OpenCodeError.malformedResponse }
        if let eventID, seenEventIDs.contains(eventID) { return nil }

        let event: RuntimeStreamEvent?
        switch type {
        case "message.updated":
            guard let info else { throw OpenCodeError.malformedResponse }
            event = .messageUpdated(try Self.message(info: info, parts: [], expectedSessionID: sessionID))
        case "message.part.updated":
            guard let part, let kind = part["type"] as? String else { throw OpenCodeError.malformedResponse }
            if let partID = part["id"] as? String {
                guard partID.utf8.count <= 160 else { throw OpenCodeError.malformedResponse }
                guard partKinds.count < 4096 || partKinds[partID] != nil else { throw OpenCodeError.streamOverflow }
                let visibleText = kind == "text" && part["ignored"] as? Bool != true && part["synthetic"] as? Bool != true
                partKinds[partID] = visibleText ? "text" : "ignored"
            }
            if kind == "tool" {
                event = .toolDetected(sessionID: sessionID, toolName: part["tool"] as? String ?? "unknown")
            } else if kind == "text", part["ignored"] as? Bool != true, part["synthetic"] as? Bool != true {
                guard let messageID = part["messageID"] as? String, let partID = part["id"] as? String, let text = part["text"] as? String else { throw OpenCodeError.malformedResponse }
                event = .textSnapshot(sessionID: sessionID, messageID: messageID, partID: partID, text: text)
            } else { event = nil }
        case "message.part.delta":
            guard let messageID = properties["messageID"] as? String, let partID = properties["partID"] as? String,
                  let field = properties["field"] as? String, let delta = properties["delta"] as? String else { throw OpenCodeError.malformedResponse }
            // Reasoning parts also use a "text" field. Never publish an untyped delta as chat text.
            event = field == "text" && partKinds[partID] == "text" ? .textDelta(sessionID: sessionID, messageID: messageID, partID: partID, text: delta) : nil
        case "session.status":
            guard let status = properties["status"] as? [String: Any], let raw = status["type"] as? String,
                  let value = RuntimeSessionStatus(rawValue: raw) else { throw OpenCodeError.malformedResponse }
            event = .statusChanged(sessionID: sessionID, status: value)
        case "session.idle": event = .statusChanged(sessionID: sessionID, status: .idle)
        case "session.error":
            event = .failure(sessionID: sessionID, description: Self.failureName(properties["error"]) ?? "OpenCode 会话失败。")
        case "permission.asked":
            guard let requestID = properties["id"] as? String else { throw OpenCodeError.malformedResponse }
            event = .permissionRequested(sessionID: sessionID, requestID: requestID)
        case "question.asked": event = .toolDetected(sessionID: sessionID, toolName: "question")
        case "message.removed":
            guard let messageID = properties["messageID"] as? String else { throw OpenCodeError.malformedResponse }
            event = .messageRemoved(sessionID: sessionID, messageID: messageID)
        case "message.part.removed":
            guard let messageID = properties["messageID"] as? String, let partID = properties["partID"] as? String else { throw OpenCodeError.malformedResponse }
            event = .partRemoved(sessionID: sessionID, messageID: messageID, partID: partID)
            partKinds.removeValue(forKey: partID)
        default: event = nil
        }
        if let eventID {
            seenEventIDs.insert(eventID); eventIDs.append(eventID)
            if eventIDs.count > maximumRememberedEvents { seenEventIDs.remove(eventIDs.removeFirst()) }
        }
        return event
    }

    static func message(info: [String: Any], parts: [[String: Any]], expectedSessionID: String) throws -> RuntimeMessage {
        guard let messageID = info["id"] as? String, let sessionID = info["sessionID"] as? String,
              sessionID == expectedSessionID, let role = info["role"] as? String, ["user", "assistant"].contains(role) else { throw OpenCodeError.malformedResponse }
        var textParts: [RuntimeTextPart] = []
        for part in parts {
            if part["type"] as? String == "tool" { throw OpenCodeError.unsafeProfile("无工具聊天中发现工具记录；已阻止继续发送。") }
            guard part["type"] as? String == "text", part["ignored"] as? Bool != true, part["synthetic"] as? Bool != true else { continue }
            guard let partID = part["id"] as? String, let text = part["text"] as? String,
                  part["sessionID"] as? String == sessionID, part["messageID"] as? String == messageID else { throw OpenCodeError.malformedResponse }
            textParts.append(RuntimeTextPart(externalPartID: partID, text: text))
        }
        let model: ModelSelection?
        if role == "assistant", let providerID = info["providerID"] as? String, let modelID = info["modelID"] as? String {
            model = ModelSelection(providerID: providerID, modelID: modelID, variant: info["variant"] as? String)
        } else { model = nil }
        let time = info["time"] as? [String: Any]
        return RuntimeMessage(externalMessageID: messageID, externalSessionID: sessionID, role: role, parts: textParts,
                                  parentMessageID: info["parentID"] as? String, observedModel: model,
                                  createdAt: milliseconds(time?["created"]), completedAt: milliseconds(time?["completed"]), failure: failureName(info["error"]))
    }

    private static func milliseconds(_ value: Any?) -> Date? {
        guard let number = value as? NSNumber, number.doubleValue.isFinite, number.doubleValue >= 0 else { return nil }
        return Date(timeIntervalSince1970: number.doubleValue / 1000)
    }

    private static func failureName(_ value: Any?) -> String? {
        guard let error = value as? [String: Any] else { return nil }
        // Raw provider messages may contain secrets. Only expose the known error classification.
        let known = ["ProviderAuthError", "UnknownError", "MessageOutputLengthError", "MessageAbortedError",
                     "StructuredOutputError", "ContextOverflowError", "ContentFilterError", "APIError"]
        guard let name = error["name"] as? String, known.contains(name) else { return "OpenCode 会话失败。" }
        return name
    }
}
