import Foundation

struct ResumeContent: Codable, Equatable {
    var progress = ""
    var nextStep = ""
    var materials: [String] = []

    static func materialURL(_ value: String) -> URL? {
        guard !value.contains(where: { $0.isWhitespace }),
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        return components.url
    }

    func validated() throws -> ResumeContent {
        let clean = ResumeContent(
            progress: progress.trimmingCharacters(in: .whitespacesAndNewlines),
            nextStep: nextStep.trimmingCharacters(in: .whitespacesAndNewlines),
            materials: materials.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
        guard !clean.progress.isEmpty || !clean.nextStep.isEmpty || !clean.materials.isEmpty else {
            throw ResumeError.emptyContent
        }
        for (index, value) in clean.materials.enumerated() where Self.materialURL(value) == nil {
            throw ResumeError.invalidMaterial(index + 1)
        }
        return clean
    }
}

struct ResumeRecord: Codable, Equatable, Identifiable {
    var id: UUID
    var savedAt: Date
    var content: ResumeContent
    var evidenceIDs: [UUID]? = nil
    var sessionID: UUID? = nil
    var origin: String? = nil
}

enum ResumeError: LocalizedError {
    case emptyContent, invalidMaterial(Int), unavailableTask
    var errorDescription: String? {
        switch self {
        case .emptyContent: return "请至少填写进度、下一步或一条材料链接。"
        case .invalidMaterial(let line): return "第 \(line) 条材料无效，请使用完整的 HTTP/HTTPS 网页地址。"
        case .unavailableTask: return "此任务无法暂存，请返回并重新选择未完成任务。"
        }
    }
}
