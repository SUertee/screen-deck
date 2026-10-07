import Foundation

struct CapturePreferences: Codable, Equatable {
    var displayIDs: Set<UInt32> = []
    var interval: TimeInterval = 60
    var model = ""

    func validated() throws -> Self {
        guard [15.0, 30, 60, 120, 300].contains(interval), displayIDs.count <= 32,
              !displayIDs.contains(0), model.count <= 200 else { throw WorkspaceError.invalidData }
        var result = self
        result.model = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !result.model.lowercased().contains("cloud"), !result.model.contains("\n") else {
            throw WorkspaceError.invalidData
        }
        return result
    }
}

struct CapturePreferencesStore {
    let url: URL
    func load() throws -> CapturePreferences {
        guard FileManager.default.fileExists(atPath: url.path) else { return CapturePreferences() }
        return try JSONDecoder().decode(CapturePreferences.self, from: Data(contentsOf: url)).validated()
    }
    func save(_ value: CapturePreferences) throws {
        let data = try JSONEncoder().encode(value.validated())
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
    }
}
