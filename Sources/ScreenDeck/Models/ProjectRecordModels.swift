import Foundation

// Project records remain distinct from editable LocalTask and are never execution authority.
struct ProjectFileReference: Codable, Equatable, Hashable, Sendable {
    let path: String
    let label: String
}

struct ProjectAcceptance: Codable, Equatable, Sendable {
    let id: String
    let description: String
    let verification: String
    let requiresHuman: Bool

    enum CodingKeys: String, CodingKey {
        case id, description, verification
        case requiresHuman = "requires_human"
    }
}

struct ProjectExecutor: Codable, Equatable, Sendable {
    let agent: String
    let model: String?
    let effort: String?
    let metadataSource: String

    enum CodingKeys: String, CodingKey {
        case agent, model, effort
        case metadataSource = "metadata_source"
    }
}

struct ProjectGit: Codable, Equatable, Sendable {
    let commitStatus: String
    let commitIDs: [String]
    let pushStatus: String

    enum CodingKeys: String, CodingKey {
        case commitStatus = "commit_status"
        case commitIDs = "commit_ids"
        case pushStatus = "push_status"
    }
}

struct ProjectRecord: Codable, Equatable, Sendable {
    let projectID: String
    let name: String
    let createdAt: String
    let timezone: String
    let mode: String
    let references: [ProjectFileReference]

    init(projectID: String, name: String, createdAt: String, timezone: String,
         mode: String, references: [ProjectFileReference]) {
        self.projectID = projectID; self.name = name; self.createdAt = createdAt
        self.timezone = timezone; self.mode = mode; self.references = references
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        projectID = try values.decode(String.self, forKey: .projectID)
        name = try values.decode(String.self, forKey: .name)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        // v2 identity owns no display configuration or document index.
        timezone = try values.decodeIfPresent(String.self, forKey: .timezone) ?? ""
        mode = try values.decodeIfPresent(String.self, forKey: .mode) ?? "managed"
        references = try values.decodeIfPresent([ProjectFileReference].self, forKey: .references) ?? []
    }

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case name
        case createdAt = "created_at"
        case timezone, mode, references
    }
}

struct ProjectTaskRecord: Codable, Equatable, Sendable {
    let projectID: String
    let taskID: String
    let title: String
    let goal: String
    let status: String
    let planVersion: Int
    let assignee: String
    let createdAt: String
    let updatedAt: String
    let runIDs: [String]
    let acceptance: [ProjectAcceptance]
    let references: [ProjectFileReference]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case taskID = "task_id"
        case title, goal, status
        case planVersion = "plan_version"
        case assignee
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case runIDs = "run_ids"
        case acceptance, references
    }
}

struct ProjectRunRecord: Codable, Equatable, Sendable {
    let projectID: String
    let taskID: String
    let runID: String
    let planVersion: Int
    let status: String
    let startedAt: String?
    let endedAt: String?
    let recordedAt: String
    let executor: ProjectExecutor
    let skills: [String]
    let summary: String
    let git: ProjectGit
    let references: [ProjectFileReference]

    enum CodingKeys: String, CodingKey {
        case projectID = "project_id"
        case taskID = "task_id"
        case runID = "run_id"
        case planVersion = "plan_version"
        case status
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case recordedAt = "recorded_at"
        case executor, skills, summary, git, references
    }
}

struct ProjectRecordSnapshot: Equatable, Sendable {
    let rootURL: URL
    let project: ProjectRecord
    let tasks: [ProjectTaskRecord]
    let runs: [ProjectRunRecord]
    let loadedAt: Date
    let historyRootURL: URL?

    init(rootURL: URL, project: ProjectRecord, tasks: [ProjectTaskRecord],
         runs: [ProjectRunRecord], loadedAt: Date, historyRootURL: URL? = nil) {
        self.rootURL = rootURL; self.project = project; self.tasks = tasks
        self.runs = runs; self.loadedAt = loadedAt; self.historyRootURL = historyRootURL
    }

    func recordReference(collection: String, id: String) -> String {
        let relative = "\(collection)/\(id).json"
        return historyRootURL == nil ? ".screendeck/\(relative)"
            : "screendeck://\(project.projectID)/\(relative)"
    }
}
