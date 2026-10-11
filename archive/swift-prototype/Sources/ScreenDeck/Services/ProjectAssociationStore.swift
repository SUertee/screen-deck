import Foundation
import CoreFoundation
import Darwin

struct ProjectAssociation: Codable, Equatable, Identifiable, Sendable {
    let projectID: String
    let name: String
    let rootPath: String
    var id: String { projectID }
    var rootURL: URL { URL(fileURLWithPath: rootPath, isDirectory: true) }
}

struct ProjectSelection: Codable, Equatable, Sendable {
    let projectID: String
    let taskID: String?
}

struct ProjectAssociationState: Codable, Equatable, Sendable {
    var version = 1
    var associations: [ProjectAssociation] = []
    var selection: ProjectSelection?

    func validated() throws -> ProjectAssociationState {
        guard version == 1, associations.count <= 1000 else { throw ProjectAssociationFailure.invalidData }
        var identities = Set<String>()
        var roots = Set<String>()
        for item in associations {
            guard item.projectID.range(of: "^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil,
                  !item.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  item.name.count <= 150,
                  item.rootPath.hasPrefix("/"), item.rootPath != "/", item.rootPath.count <= 4096,
                  !item.rootPath.contains("\0"),
                  item.rootURL.standardizedFileURL.path == item.rootPath,
                  identities.insert(item.projectID).inserted,
                  roots.insert(item.rootPath).inserted else { throw ProjectAssociationFailure.invalidData }
        }
        if let selection {
            guard identities.contains(selection.projectID) else { throw ProjectAssociationFailure.invalidData }
            if let taskID = selection.taskID {
                guard taskID.range(of: "^task-[0-9]{3,}$", options: .regularExpression) != nil else {
                    throw ProjectAssociationFailure.invalidData
                }
            }
        }
        return self
    }
}

enum ProjectAssociationFailure: LocalizedError {
    case invalidData
    case tooLarge
    case unsafeFile
    case missingFile
    case revisionChanged

    var errorDescription: String? {
        switch self {
        case .invalidData: return "项目关联文件损坏或版本不受支持，原文件未覆盖。"
        case .tooLarge: return "项目关联文件超过 2 MiB 上限，原文件未覆盖。"
        case .unsafeFile: return "项目关联位置不是普通文件，原位置未覆盖。"
        case .missingFile: return "已读取的项目关联文件已丢失或移动，请恢复原文件后重试；不会创建空关联文件。"
        case .revisionChanged: return "项目关联文件已被其他窗口或程序修改，请重新读取后重试；本次修改未覆盖外部数据。"
        }
    }
}

protocol ProjectAssociationStoring {
    var url: URL { get }
    func load() throws -> ProjectAssociationState
    func save(_ state: ProjectAssociationState) throws
}

/// Global storage contains only project locations and browsing selection, never source task/run bodies.
final class ProjectAssociationStore: ProjectAssociationStoring {
    let url: URL
    private let pathFailure: Error?
    private let maximumBytes = 2 * 1024 * 1024
    private var hasObservedExistingFile: Bool
    private var hasRememberedRevision = false
    private var rememberedRevision: Data?

    init(url: URL? = nil, requireExistingFile: Bool = false) {
        hasObservedExistingFile = requireExistingFile
        do { self.url = try url ?? ScreenDeckPaths().activeProjects(); pathFailure = nil }
        catch { self.url = ScreenDeckPaths().projects; pathFailure = error }
    }

    func load() throws -> ProjectAssociationState {
        if let pathFailure { throw pathFailure }
        let data = try existingData()
        let state = try data.map(decode) ?? ProjectAssociationState()
        rememberedRevision = data
        hasRememberedRevision = true
        return state
    }

    private func decode(_ data: Data) throws -> ProjectAssociationState {
        do {
            try validateKeys(data)
            return try JSONDecoder().decode(ProjectAssociationState.self, from: data).validated()
        } catch let error as ProjectAssociationFailure { throw error }
        catch { throw ProjectAssociationFailure.invalidData }
    }

    func save(_ state: ProjectAssociationState) throws {
        let state = try state.validated()
        // Even after a successful previous load, a damaged/unknown external revision must not be overwritten.
        if let pathFailure { throw pathFailure }
        let previous = try existingData()
        if let previous { _ = try decode(previous) }
        guard !hasRememberedRevision || previous == rememberedRevision else { throw ProjectAssociationFailure.revisionChanged }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(state)
        guard data.count <= maximumBytes else { throw ProjectAssociationFailure.tooLarge }
        try SafePrivateStorageIO.write(data, to: url, expected: previous, maximumBytes: maximumBytes)
        hasObservedExistingFile = true
        rememberedRevision = data
        hasRememberedRevision = true
    }

    private func existingData() throws -> Data? {
        let data = try SafePrivateStorageIO.read(url, maximumBytes: maximumBytes)
        if data != nil {
            hasObservedExistingFile = true
        } else if hasObservedExistingFile {
            throw ProjectAssociationFailure.missingFile
        }
        return data
    }

    private func validateKeys(_ data: Data) throws {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: ["version", "associations", "selection"]),
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let associations = object["associations"] as? [[String: Any]], associations.count <= 1000 else {
            throw ProjectAssociationFailure.invalidData
        }
        for item in associations {
            guard Set(item.keys) == ["projectID", "name", "rootPath"] else { throw ProjectAssociationFailure.invalidData }
        }
        if let value = object["selection"], !(value is NSNull) {
            guard let selection = value as? [String: Any],
                  Set(selection.keys).isSubset(of: ["projectID", "taskID"]),
                  selection["projectID"] != nil else { throw ProjectAssociationFailure.invalidData }
        }
    }
}
