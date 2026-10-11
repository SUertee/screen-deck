import Foundation

/// A migrated history is private data bound to one explicitly selected checkout.
struct ProjectHistoryManifest: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let kind: String
    let projectID: String
    let sourceRoot: String
    let createdAt: String
    let project: ProjectHistoryProject
    let migration: ProjectHistoryMigration

    init(project: ProjectRecord, sourceRoot: String, createdAt: String,
         backupPath: String, migratedAt: String) {
        schemaVersion = 1
        kind = "project_history"
        projectID = project.projectID
        self.sourceRoot = sourceRoot
        self.createdAt = createdAt
        self.project = ProjectHistoryProject(project)
        migration = ProjectHistoryMigration(backupPath: backupPath, migratedAt: migratedAt)
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case kind
        case projectID = "project_id"
        case sourceRoot = "source_root"
        case createdAt = "created_at"
        case project, migration
    }
}

/// Keep the complete original v1 project, including its non-authoritative references.
struct ProjectHistoryProject: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let kind: String
    let projectID: String
    let name: String
    let createdAt: String
    let timezone: String
    let mode: String
    let references: [ProjectFileReference]

    init(_ record: ProjectRecord) {
        schemaVersion = 1; kind = "project"
        projectID = record.projectID; name = record.name; createdAt = record.createdAt
        timezone = record.timezone; mode = record.mode; references = record.references
    }

    var record: ProjectRecord {
        ProjectRecord(projectID: projectID, name: name, createdAt: createdAt,
                      timezone: timezone, mode: mode, references: references)
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case kind
        case projectID = "project_id"
        case name
        case createdAt = "created_at"
        case timezone, mode, references
    }
}

struct ProjectHistoryMigration: Codable, Equatable, Sendable {
    let backupPath: String
    let migratedAt: String

    enum CodingKeys: String, CodingKey {
        case backupPath = "backup_path"
        case migratedAt = "migrated_at"
    }
}

struct ProjectHistoryLocation: Sendable {
    let privateRoot: URL
    init(privateRoot: URL = ScreenDeckPaths().root) { self.privateRoot = privateRoot }

    func namespace(projectID: String) throws -> URL {
        try Self.validateProjectID(projectID)
        guard privateRoot.isFileURL,
              privateRoot.host == nil || privateRoot.host == "" || privateRoot.host == "localhost",
              !privateRoot.path.contains("\0"), privateRoot.path != "/" else {
            throw Self.issue("私人项目目录无效")
        }
        return privateRoot.standardizedFileURL.appendingPathComponent("projects/\(projectID)", isDirectory: true)
    }

    func manifestURL(projectID: String) throws -> URL {
        try namespace(projectID: projectID).appendingPathComponent("history.json")
    }

    static func privateReference(projectID: String, relativePath: String) throws -> String {
        try validateProjectID(projectID)
        _ = try relativeParts(relativePath)
        return "screendeck://\(projectID)/\(relativePath)"
    }

    /// Parse the literal URI; never URL-decode or normalize untrusted path components.
    static func parsePrivateReference(_ path: String, projectID: String) throws -> String {
        try validateProjectID(projectID)
        let prefix = "screendeck://\(projectID)/"
        guard path.hasPrefix(prefix) else { throw issue("私人引用不属于当前项目") }
        let relative = String(path.dropFirst(prefix.count))
        _ = try relativeParts(relative)
        return relative
    }

    static func normalizedRootPath(_ root: URL) throws -> String {
        guard root.isFileURL, root.host == nil || root.host == "" || root.host == "localhost",
              root.path.hasPrefix("/"), !root.path.contains("\0") else { throw issue("项目根地址无效") }
        var path = root.standardizedFileURL.path
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        guard path != "/" else { throw issue("项目根不能是文件系统根目录") }
        return path
    }

    private static func relativeParts(_ path: String) throws -> [String] {
        guard !path.contains("%"), !path.contains("\\"), !path.contains("\0"),
              !path.contains("?"), !path.contains("#"), !path.contains(":"), path.utf8.count <= 4096 else {
            throw issue("拒绝编码、URL 参数或非规范私人引用")
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, ["tasks", "runs", "artifacts"].contains(parts[0]),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw issue("私人引用必须定位当前项目的 tasks、runs 或 artifacts 内文件")
        }
        return parts
    }

    private static func validateProjectID(_ value: String) throws {
        guard value.range(of: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
            throw issue("project_id 无效")
        }
    }

    private static func issue(_ reason: String) -> ProjectRecordReadError {
        ProjectRecordReadError(path: "私人项目历史", reason: reason)
    }
}
