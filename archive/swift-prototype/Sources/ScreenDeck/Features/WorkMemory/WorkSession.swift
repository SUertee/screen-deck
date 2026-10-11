import Foundation

struct Subtask: Codable, Equatable, Identifiable {
    var id = UUID()
    var title: String
    var completed = false
}

enum SessionStatus: String, Codable { case recording, paused, interrupted }

struct WorkEvidence: Codable, Equatable, Identifiable {
    var id = UUID()
    var capturedAt: Date
    var displayID: UInt32
    var displayName: String
    var appName: String
    var text: String
    var imageName: String
    var excluded = false
}

struct WorkSession: Codable, Equatable, Identifiable {
    var id = UUID()
    var taskID: UUID
    var taskTitle: String
    var startedAt: Date
    var endedAt: Date?
    var status: SessionStatus = .recording
    var displayIDs: [UInt32]
    var evidence: [WorkEvidence] = []
    var note: String?

    func validate() throws {
        guard !taskTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              startedAt.timeIntervalSince1970.isFinite,
              endedAt.map({ $0.timeIntervalSince1970.isFinite && $0 >= startedAt }) ?? true,
              status == .recording ? endedAt == nil : endedAt != nil,
              !displayIDs.isEmpty, Set(displayIDs).count == displayIDs.count,
              Set(evidence.map(\.id)).count == evidence.count else { throw WorkspaceError.invalidData }
        for item in evidence {
            guard displayIDs.contains(item.displayID), item.capturedAt >= startedAt,
                  item.capturedAt.timeIntervalSince1970.isFinite,
                  endedAt.map({ item.capturedAt <= $0 }) ?? true,
                  item.imageName == "\(item.id.uuidString).jpg" else { throw WorkspaceError.invalidData }
        }
    }
}

/// Observations, not claims about completion. Can be used without a model or network.
enum EvidenceDigest {
    static func draft(session: WorkSession, task: LocalTask) -> ResumeContent {
        let items = session.evidence.filter { !$0.excluded }
        let apps = Array(Set(items.map(\.appName).filter { !$0.isEmpty })).sorted()
        let recent = items.suffix(3).compactMap { item -> String? in
            let line = item.text.split(separator: "\n").map(String.init)
                .first { $0.trimmingCharacters(in: .whitespaces).count > 8 }
            return line.map { "画面文字：\(String($0.prefix(160)))" }
        }
        var parts = [items.isEmpty ? "本次未保存屏幕线索，可手动补充进度。" : "本次保存 \(items.count) 条画面线索。"]
        if !apps.isEmpty { parts.append("采样时前台应用：\(apps.joined(separator: "、"))。") }
        parts.append(contentsOf: Array(NSOrderedSet(array: recent)) as? [String] ?? recent)
        let next = task.subtasks?.first(where: { !$0.completed })?.title
            ?? task.latestResume?.content.nextStep
        return ResumeContent(progress: parts.joined(separator: "\n"),
                             nextStep: next.flatMap { $0.isEmpty ? nil : $0 } ?? "检查最近记录，确认接下来要做的一步。",
                             materials: task.latestResume?.content.materials ?? [])
    }
}

struct WorkSessionStore {
    let root: URL

    func folder(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    func imageURL(sessionID: UUID, evidence: WorkEvidence) -> URL? {
        guard evidence.imageName == "\(evidence.id.uuidString).jpg" else { return nil }
        return folder(sessionID).appendingPathComponent(evidence.imageName)
    }
    func save(_ session: WorkSession) throws {
        try session.validate()
        let directory = folder(session.id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(session)
        try data.write(to: directory.appendingPathComponent("session.json"), options: .atomic)
    }
    func load() throws -> [WorkSession] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { UUID(uuidString: $0.lastPathComponent) != nil }
            .map { directory in
                let session = try JSONDecoder().decode(WorkSession.self, from: Data(contentsOf: directory.appendingPathComponent("session.json")))
                try session.validate()
                guard directory.lastPathComponent == session.id.uuidString else { throw WorkspaceError.invalidData }
                return session
            }.sorted { $0.startedAt > $1.startedAt }
    }
}
