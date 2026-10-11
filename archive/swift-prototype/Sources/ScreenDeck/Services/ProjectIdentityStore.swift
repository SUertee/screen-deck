import Foundation
import CoreFoundation
import Darwin

/// Shared identity only. Configuration, private history and local paths belong elsewhere.
struct ProjectIdentity: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let kind: String
    let projectID: String
    let name: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case kind
        case projectID = "project_id"
        case name
        case createdAt = "created_at"
    }
}

enum ProjectIdentityFailure: LocalizedError, Equatable {
    case invalidRoot, unsafeLocation, alreadyExists, invalidData, tooLarge, sourceChanged

    var errorDescription: String? {
        switch self {
        case .invalidRoot: return "请选择已经存在的本机项目文件夹，不能使用文件系统根目录。"
        case .unsafeLocation: return "项目身份位置不是普通文件或文件夹，或包含符号链接；原位置未覆盖。"
        case .alreadyExists: return "项目身份已经存在；不会覆盖、修复或重新生成项目 ID。"
        case .invalidData: return "项目身份损坏或版本不受支持；此入口只读取五字段 v2 身份。"
        case .tooLarge: return "项目身份文件超过 64 KiB 上限，原文件未覆盖。"
        case .sourceChanged: return "读取或初始化期间项目位置发生变化，请重新选择文件夹。"
        }
    }
}

/// Nothing is created by construction or read(). Initialization is a separate, explicit action.
struct ProjectIdentityStore: Sendable {
    private let maximumBytes = 64 * 1024

    func read(root: URL) throws -> ProjectIdentity {
        let rootURL = try checkedRoot(root)
        let rootFD = try openRoot(rootURL)
        defer { close(rootFD) }
        let directoryFD = try openDirectory(rootFD: rootFD)
        defer { close(directoryFD) }
        let descriptor = openat(directoryFD, "project.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw ProjectIdentityFailure.unsafeLocation }
        defer { close(descriptor) }
        let before = try signature(descriptor, directory: false)
        guard before.st_size >= 0, before.st_size <= maximumBytes else { throw ProjectIdentityFailure.tooLarge }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
            if count < 0, errno == EINTR { continue }
            guard count >= 0 else { throw CocoaError(.fileReadUnknown) }
            if count == 0 { break }
            guard data.count <= maximumBytes - count else { throw ProjectIdentityFailure.tooLarge }
            data.append(contentsOf: buffer.prefix(count))
        }
        let after = try signature(descriptor, directory: false)
        guard unchanged(before, after), Int64(data.count) == before.st_size else {
            throw ProjectIdentityFailure.sourceChanged
        }
        try validateLocations(rootURL: rootURL, rootFD: rootFD, directoryFD: directoryFD)
        var current = stat()
        guard fstatat(directoryFD, "project.json", &current, AT_SYMLINK_NOFOLLOW) == 0,
              unchanged(before, current) else { throw ProjectIdentityFailure.sourceChanged }
        return try decode(data)
    }

    /// Atomically publishes a complete identity via an exclusive link; any existing leaf wins.
    /// It never migrates v1 identities or creates task/run/config/log files.
    func initialize(root: URL, name: String, now: Date = Date()) throws -> ProjectIdentity {
        let rootURL = try checkedRoot(root)
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validName(cleanName), now.timeIntervalSince1970.isFinite else { throw ProjectIdentityFailure.invalidData }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let identity = ProjectIdentity(schemaVersion: 2, kind: "project",
                                       projectID: "project-\(UUID().uuidString.lowercased())",
                                       name: cleanName, createdAt: formatter.string(from: now))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(identity)
        _ = try decode(data)

        let rootFD = try openRoot(rootURL)
        defer { close(rootFD) }
        if mkdirat(rootFD, ".screendeck", 0o700) != 0, errno != EEXIST {
            throw CocoaError(.fileWriteUnknown)
        }
        let directoryFD = try openDirectory(rootFD: rootFD)
        defer { close(directoryFD) }
        var existing = stat()
        if fstatat(directoryFD, "project.json", &existing, AT_SYMLINK_NOFOLLOW) == 0 {
            throw ProjectIdentityFailure.alreadyExists
        }
        guard errno == ENOENT else { throw ProjectIdentityFailure.unsafeLocation }

        let temporaryName = ".project-identity-\(UUID().uuidString).tmp"
        let descriptor = openat(directoryFD, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer {
            close(descriptor)
            unlinkat(directoryFD, temporaryName, 0)
        }
        try data.withUnsafeBytes { buffer in
            guard let bytes = buffer.baseAddress else { return }
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(descriptor, bytes.advanced(by: offset), buffer.count - offset)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw CocoaError(.fileWriteUnknown) }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
        try validateLocations(rootURL: rootURL, rootFD: rootFD, directoryFD: directoryFD)
        guard linkat(directoryFD, temporaryName, directoryFD, "project.json", 0) == 0 else {
            if errno == EEXIST { throw ProjectIdentityFailure.alreadyExists }
            throw CocoaError(.fileWriteUnknown)
        }
        _ = fsync(directoryFD)
        return identity
    }

    private func decode(_ data: Data) throws -> ProjectIdentity {
        do {
            guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["schema_version", "kind", "project_id", "name", "created_at"],
                  let version = object["schema_version"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 2,
                  object["kind"] as? String == "project",
                  let id = object["project_id"] as? String, id.utf8.count == 44,
                  id.range(of: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil,
                  let name = object["name"] as? String, validName(name),
                  let timestamp = object["created_at"] as? String, validTimestamp(timestamp) else {
                throw ProjectIdentityFailure.invalidData
            }
            return try JSONDecoder().decode(ProjectIdentity.self, from: data)
        } catch let error as ProjectIdentityFailure { throw error }
        catch { throw ProjectIdentityFailure.invalidData }
    }

    private func validName(_ name: String) -> Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && name.unicodeScalars.count <= 150
            && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }

    private func validTimestamp(_ text: String) -> Bool {
        let pattern = "^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.range.length == text.utf16.count else { return false }
        func capture(_ index: Int) -> String {
            String(text[Range(match.range(at: index), in: text)!])
        }
        let values = (1...6).map { Int(capture($0))! }
        let (year, month, day, hour, minute, second) = (values[0], values[1], values[2], values[3], values[4], values[5])
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard year >= 1, (1...12).contains(month), (1...monthDays[month - 1]).contains(day),
              hour <= 23, minute <= 59, second <= 59 else { return false }
        let zone = capture(7)
        if zone != "Z" {
            let parts = zone.dropFirst().split(separator: ":").compactMap { Int($0) }
            guard parts.count == 2, parts[0] <= 23, parts[1] <= 59 else { return false }
        }
        return true
    }

    private func checkedRoot(_ root: URL) throws -> URL {
        guard root.isFileURL, root.host == nil || root.host == "" || root.host == "localhost",
              !root.path.contains("\0") else { throw ProjectIdentityFailure.invalidRoot }
        let result = root.standardizedFileURL
        guard result.path != "/", !result.path.isEmpty else { throw ProjectIdentityFailure.invalidRoot }
        return result
    }

    private func openRoot(_ root: URL) throws -> Int32 {
        // A trailing slash would allow POSIX to follow a directory symlink.
        var path = root.path
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ProjectIdentityFailure.invalidRoot }
        return descriptor
    }

    private func openDirectory(rootFD: Int32) throws -> Int32 {
        let descriptor = openat(rootFD, ".screendeck", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ProjectIdentityFailure.unsafeLocation }
        return descriptor
    }

    private func signature(_ descriptor: Int32, directory: Bool) throws -> stat {
        var result = stat()
        guard fstat(descriptor, &result) == 0,
              result.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG) else {
            throw ProjectIdentityFailure.unsafeLocation
        }
        return result
    }

    private func validateLocations(rootURL: URL, rootFD: Int32, directoryFD: Int32) throws {
        let root = try signature(rootFD, directory: true)
        let currentRootFD = try openRoot(rootURL)
        defer { close(currentRootFD) }
        let currentRoot = try signature(currentRootFD, directory: true)
        let directory = try signature(directoryFD, directory: true)
        var currentDirectory = stat()
        guard root.st_dev == currentRoot.st_dev, root.st_ino == currentRoot.st_ino,
              fstatat(rootFD, ".screendeck", &currentDirectory, AT_SYMLINK_NOFOLLOW) == 0,
              currentDirectory.st_mode & S_IFMT == S_IFDIR,
              directory.st_dev == currentDirectory.st_dev, directory.st_ino == currentDirectory.st_ino else {
            throw ProjectIdentityFailure.sourceChanged
        }
    }

    private func unchanged(_ first: stat, _ second: stat) -> Bool {
        first.st_dev == second.st_dev && first.st_ino == second.st_ino && first.st_size == second.st_size
            && first.st_mtimespec.tv_sec == second.st_mtimespec.tv_sec
            && first.st_mtimespec.tv_nsec == second.st_mtimespec.tv_nsec
            && first.st_ctimespec.tv_sec == second.st_ctimespec.tv_sec
            && first.st_ctimespec.tv_nsec == second.st_ctimespec.tv_nsec
            && second.st_mode & S_IFMT == S_IFREG
    }
}
