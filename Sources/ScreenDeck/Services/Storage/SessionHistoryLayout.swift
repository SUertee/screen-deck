import Foundation

/// Date buckets are a storage layout, not session identity or a history branch.
enum SessionHistoryLayout {
    static let maximumScannedDirectories = 4096
    static let maximumScannedEntries = 8192

    static func filename(_ id: UUID) -> String { "\(id.uuidString.lowercased()).json" }

    static func dateComponents(_ date: Date) -> [String] {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return [String(format: "%04d", parts.year!), String(format: "%02d", parts.month!),
                String(format: "%02d", parts.day!)]
    }

    static func file(for id: UUID, createdAt: Date, root: URL) -> URL {
        dateComponents(createdAt).reduce(root) { $0.appendingPathComponent($1, isDirectory: true) }
            .appendingPathComponent(filename(id))
    }

    static func isValidBucket(_ parts: [String]) -> Bool {
        guard parts.count == 3, let year = number(parts[0], width: 4, range: 1970...9999),
              let month = number(parts[1], width: 2, range: 1...12),
              let day = number(parts[2], width: 2, range: 1...31),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return false }
        return dateComponents(date) == parts
    }

    private static var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        value.locale = Locale(identifier: "en_US_POSIX")
        return value
    }

    private static func number(_ value: String, width: Int, range: ClosedRange<Int>) -> Int? {
        guard value.utf8.count == width, value.utf8.allSatisfy({ (48...57).contains($0) }),
              let result = Int(value), range.contains(result) else { return nil }
        return result
    }

    struct Scan {
        var files: [UUID: [URL]] = [:]
        var candidates: [URL] = []
        var diagnostics: [SessionHistoryDiagnostic] = []
        var fileCount = 0
        var hasUnclassifiedFiles = false
        var directoryCount = 0
        var entryCount = 0
    }

    /// Fixed-depth, bounded, no-follow enumeration. No persistent index is trusted or written.
    static func scan(_ root: URL, maximumSessions: Int) throws -> Scan {
        var result = Scan(), directories = 0, entries = 0
        func walk(_ directory: URL, parts: [String]) throws {
            directories += 1
            guard directories <= maximumScannedDirectories, entries <= maximumScannedEntries else {
                throw SessionHistoryFailure.tooLarge
            }
            guard let children = try SafePrivateStorageIO.directoryEntries(directory,
                    maximumEntries: max(1, maximumScannedEntries - entries)) else {
                if parts.isEmpty { return }
                throw SessionHistoryFailure.incompleteScan
            }
            entries += children.count
            guard entries <= maximumScannedEntries else { throw SessionHistoryFailure.tooLarge }
            for child in children.sorted(by: { $0.name < $1.name }) {
                let url = directory.appendingPathComponent(child.name)
                if child.name == ".DS_Store", child.kind == .regularFile { continue }
                if parts.isEmpty, child.name == "history" { throw SessionHistoryFailure.previousDirectoryNeedsMigration }
                if parts.count < 3 {
                    // A flat JSON root is also an old layout, never an empty dated library.
                    if parts.isEmpty, child.name.hasSuffix(".json") { throw SessionHistoryFailure.previousDirectoryNeedsMigration }
                    let valid: Bool
                    switch parts.count {
                    case 0: valid = number(child.name, width: 4, range: 1970...9999) != nil
                    case 1: valid = number(child.name, width: 2, range: 1...12) != nil
                    default: valid = isValidBucket(parts + [child.name])
                    }
                    guard valid else { throw SessionHistoryFailure.incompleteScan }
                    guard child.kind == .directory else {
                        throw SafePrivateStorageError(reason: "会话日期位置不是安全的目录，扫描未完成")
                    }
                    try walk(url, parts: parts + [child.name])
                } else {
                    if isStorageSidecar(child.name) {
                        guard child.kind == .regularFile else {
                            throw SafePrivateStorageError(reason: "会话临时文件或锁位置类型异常，扫描未完成")
                        }
                        continue
                    }
                    guard child.name.hasSuffix(".json") else { throw SessionHistoryFailure.incompleteScan }
                    result.fileCount += 1
                    guard result.fileCount <= maximumSessions else { throw SessionHistoryFailure.tooLarge }
                    result.candidates.append(url)
                    if let id = UUID(uuidString: String(child.name.dropLast(5))) {
                        // Invalid case or file type remains associated with the ID so it cannot be recreated.
                        result.files[id, default: []].append(url)
                    } else {
                        result.hasUnclassifiedFiles = true
                        result.diagnostics.append(.init(filename: (parts + [child.name]).joined(separator: "/"),
                                                        reason: "记录文件名无效，未读取。"))
                    }
                }
            }
        }
        try walk(root, parts: [])
        result.directoryCount = directories
        result.entryCount = entries
        return result
    }

    private static func isStorageSidecar(_ name: String) -> Bool {
        guard name.hasPrefix(".") else { return false }
        // Safe I/O also creates locks for malformed JSON filenames; diagnose the JSON, not its lock.
        if name.hasSuffix(".json.lock"), name.count > ".json.lock".count + 1 { return true }
        guard name.hasSuffix(".tmp"), name.count > 46 else { return false }
        let stem = String(name.dropLast(4))
        guard UUID(uuidString: String(stem.suffix(36))) != nil else { return false }
        let prefix = String(stem.dropLast(36))
        return prefix.hasSuffix(".json.") && prefix.count > ".json.".count + 1
    }
}
