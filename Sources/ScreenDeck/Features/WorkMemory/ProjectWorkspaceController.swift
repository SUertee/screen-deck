import Foundation
import Combine

@MainActor
final class ProjectWorkspaceController: ObservableObject {
    @Published private(set) var associations: [ProjectAssociation] = []
    @Published private(set) var snapshots: [String: ProjectRecordSnapshot] = [:]
    @Published private(set) var diagnostics: [String: String] = [:]
    @Published private(set) var staleProjectIDs = Set<String>()
    @Published private(set) var error: String?
    @Published private(set) var isLoading = false
    @Published private(set) var selection: ProjectSelection?
    @Published private(set) var associationsLoaded = false

    let store: any ProjectAssociationStoring
    private let read: @Sendable (URL) throws -> ProjectRecordSnapshot
    private let referenceReader: ProjectRecordReader

    /// Explicit load() is required. Constructing/rendering a workbench never reads user projects.
    init(store: (any ProjectAssociationStoring)? = nil,
         privateRoot: URL = ScreenDeckPaths().root,
         reader: (@Sendable (URL) throws -> ProjectRecordSnapshot)? = nil) {
        self.store = store ?? ProjectAssociationStore()
        let recordReader = ProjectRecordReader(privateRoot: privateRoot)
        referenceReader = recordReader
        self.read = reader ?? { try recordReader.read(root: $0) }
    }

    @discardableResult
    func load() async -> Bool {
        guard beginOperation() else { return false }
        defer { isLoading = false }
        let stored: ProjectAssociationState
        do { stored = try store.load().validated() }
        catch {
            associationsLoaded = false
            staleProjectIDs.formUnion(snapshots.keys)
            let message = "项目关联读取失败：\(error.localizedDescription)"
            for id in snapshots.keys { diagnostics[id] = message }
            self.error = message
            return false
        }
        associationsLoaded = true
        associations = stored.associations
        let knownIDs = Set(associations.map(\.projectID))
        snapshots = snapshots.filter { knownIDs.contains($0.key) }
        diagnostics = diagnostics.filter { knownIDs.contains($0.key) }
        staleProjectIDs.formIntersection(knownIDs)
        for association in associations { _ = await readAssociation(association) }
        selection = recoveredSelection(stored.selection)
        error = nil
        return true
    }

    @discardableResult
    func associate(root: URL) async -> Bool {
        guard associationsLoaded else {
            error = "请先读取项目关联；读取失败时不会覆盖原文件。"
            return false
        }
        guard beginOperation() else { return false }
        defer { isLoading = false }
        var sourceWasRead = false
        do {
            let snapshot = try await sourceSnapshot(root: root)
            sourceWasRead = true
            let id = snapshot.project.projectID
            let path = snapshot.rootURL.standardizedFileURL.path
            if let existing = associations.first(where: { $0.projectID == id }) {
                guard existing.rootPath == path else {
                    error = "此项目已关联到 \(existing.rootPath)。如需更换位置，请使用“重新关联”，不会自动合并。"
                    return false
                }
                let proposedSelection = ProjectSelection(projectID: id, taskID: nil)
                try persist(associations: associations, selection: proposedSelection)
                selection = proposedSelection
                publish(snapshot)
                return true
            }
            guard !associations.contains(where: { $0.rootPath == path }) else {
                if let previous = associations.first(where: { $0.rootPath == path }) {
                    if snapshots[previous.projectID] != nil { staleProjectIDs.insert(previous.projectID) }
                    diagnostics[previous.projectID] = "同一位置声明了不同的 project_id，旧快照已失效。"
                }
                error = "此文件夹已关联其他项目身份。请核对 project_id，不会替换原关联。"
                return false
            }
            let association = ProjectAssociation(projectID: id, name: snapshot.project.name, rootPath: path)
            let proposedAssociations = associations + [association]
            let proposedSelection = ProjectSelection(projectID: id, taskID: nil)
            try persist(associations: proposedAssociations, selection: proposedSelection)
            associations = proposedAssociations
            selection = proposedSelection
            publish(snapshot)
            return true
        } catch {
            if !sourceWasRead,
               let known = associations.first(where: { $0.rootPath == root.standardizedFileURL.path }) {
                if snapshots[known.projectID] != nil { staleProjectIDs.insert(known.projectID) }
                diagnostics[known.projectID] = "项目来源读取失败：\(error.localizedDescription)"
            }
            self.error = "项目未关联：\(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    func refresh(projectID: String) async -> Bool {
        guard associationsLoaded, let association = associations.first(where: { $0.projectID == projectID }) else {
            error = "项目尚未关联或关联文件未正常读取。"
            return false
        }
        guard beginOperation() else { return false }
        defer { isLoading = false }
        return await readAssociation(association)
    }

    @discardableResult
    func relink(projectID: String, root: URL) async -> Bool {
        guard associationsLoaded, let index = associations.firstIndex(where: { $0.projectID == projectID }) else {
            error = "找不到需要重新关联的项目。"
            return false
        }
        guard beginOperation() else { return false }
        defer { isLoading = false }
        do {
            let snapshot = try await sourceSnapshot(root: root)
            guard snapshot.project.projectID == projectID else {
                error = "新位置的 project_id 与原项目不一致，原关联未改变。"
                return false
            }
            let path = snapshot.rootURL.standardizedFileURL.path
            guard !associations.contains(where: { $0.projectID != projectID && $0.rootPath == path }) else {
                error = "新位置已属于另一个已关联项目，原关联未改变。"
                return false
            }
            var proposed = associations
            proposed[index] = ProjectAssociation(projectID: projectID, name: snapshot.project.name, rootPath: path)
            let proposedSelection = selection?.projectID == projectID ? validSelection(selection, snapshot: snapshot) : selection
            try persist(associations: proposed, selection: proposedSelection)
            associations = proposed
            selection = proposedSelection
            publish(snapshot)
            return true
        } catch {
            self.error = "项目未重新关联：\(error.localizedDescription)"
            return false
        }
    }

    /// Removing a local location never deletes project records, files or conversation drafts.
    @discardableResult
    func removeAssociation(projectID: String) -> Bool {
        guard associationsLoaded, !isLoading,
              associations.contains(where: { $0.projectID == projectID }) else { return false }
        let proposed = associations.filter { $0.projectID != projectID }
        let proposedSelection = selection?.projectID == projectID ? nil : selection
        do {
            try persist(associations: proposed, selection: proposedSelection)
            associations = proposed; selection = proposedSelection
            snapshots[projectID] = nil; diagnostics[projectID] = nil
            staleProjectIDs.remove(projectID); error = nil
            return true
        } catch { self.error = "关联未移除：\(error.localizedDescription)"; return false }
    }

    @discardableResult
    func select(projectID: String, taskID: String? = nil) -> Bool {
        guard associationsLoaded, !isLoading,
              associations.contains(where: { $0.projectID == projectID }) else {
            error = "项目关联尚未就绪，浏览选择未保存。"
            return false
        }
        if let taskID {
            guard !staleProjectIDs.contains(projectID),
                  snapshots[projectID]?.tasks.contains(where: { $0.taskID == taskID }) == true else {
                error = "任务不存在或来源已失效；请先刷新项目。"
                return false
            }
        }
        let proposedSelection = ProjectSelection(projectID: projectID, taskID: taskID)
        do {
            if selection != proposedSelection { try persist(associations: associations, selection: proposedSelection) }
            selection = proposedSelection
            error = nil
            return true
        } catch {
            self.error = "浏览选择未保存：\(error.localizedDescription)"
            return false
        }
    }

    /// Task references stay bound to their owner even when another task declares the same path.
    func hasReference(_ reference: ProjectFileReference, projectID: String, taskID: String?) -> Bool {
        guard associationsLoaded, !staleProjectIDs.contains(projectID),
              let snapshot = snapshots[projectID] else { return false }
        if let taskID {
            guard let task = snapshot.tasks.first(where: { $0.taskID == taskID }) else { return false }
            return task.references.contains(reference)
                || snapshot.runs.contains(where: { $0.taskID == taskID && $0.references.contains(reference) })
        }
        return snapshot.project.references.contains(reference)
            || snapshot.tasks.contains(where: { $0.references.contains(reference) })
            || snapshot.runs.contains(where: { $0.references.contains(reference) })
    }

    func referenceURL(_ reference: ProjectFileReference, projectID: String) throws -> URL {
        guard associationsLoaded, !staleProjectIDs.contains(projectID),
              let snapshot = snapshots[projectID] else { throw ProjectAssociationFailure.invalidData }
        let declared = snapshot.project.references.contains(reference)
            || snapshot.tasks.contains(where: { $0.references.contains(reference) })
            || snapshot.runs.contains(where: { $0.references.contains(reference) })
        guard declared else { throw ProjectAssociationFailure.invalidData }
        return try referenceReader.validatedReference(reference, root: snapshot.rootURL)
    }

    private func beginOperation() -> Bool {
        guard !isLoading else { return false }
        isLoading = true
        error = nil
        return true
    }

    private func sourceSnapshot(root: URL) async throws -> ProjectRecordSnapshot {
        let reader = read
        return try await Task.detached(priority: .userInitiated) { try reader(root) }.value
    }

    private func readAssociation(_ association: ProjectAssociation) async -> Bool {
        do {
            let snapshot = try await sourceSnapshot(root: association.rootURL)
            guard snapshot.project.projectID == association.projectID else {
                throw ProjectAssociationReadFailure.identityChanged
            }
            publish(snapshot)
            return true
        } catch {
            if snapshots[association.projectID] != nil { staleProjectIDs.insert(association.projectID) }
            diagnostics[association.projectID] = "项目来源读取失败：\(error.localizedDescription)"
            self.error = diagnostics[association.projectID]
            return false
        }
    }

    private func publish(_ snapshot: ProjectRecordSnapshot) {
        let id = snapshot.project.projectID
        snapshots[id] = snapshot
        staleProjectIDs.remove(id)
        diagnostics[id] = nil
        error = nil
        if selection?.projectID == id { selection = validSelection(selection, snapshot: snapshot) }
    }

    private func persist(associations: [ProjectAssociation], selection: ProjectSelection?) throws {
        try store.save(ProjectAssociationState(associations: associations, selection: selection))
    }

    private func recoveredSelection(_ proposed: ProjectSelection?) -> ProjectSelection? {
        guard let proposed, associations.contains(where: { $0.projectID == proposed.projectID }) else { return nil }
        guard let snapshot = snapshots[proposed.projectID], !staleProjectIDs.contains(proposed.projectID) else {
            // Location is remembered even when absent; no offline snapshot or run is restored.
            return ProjectSelection(projectID: proposed.projectID, taskID: nil)
        }
        return validSelection(proposed, snapshot: snapshot)
    }

    private func validSelection(_ proposed: ProjectSelection?, snapshot: ProjectRecordSnapshot) -> ProjectSelection? {
        guard let proposed else { return nil }
        if let taskID = proposed.taskID, !snapshot.tasks.contains(where: { $0.taskID == taskID }) {
            return ProjectSelection(projectID: proposed.projectID, taskID: nil)
        }
        return proposed
    }
}

private enum ProjectAssociationReadFailure: LocalizedError {
    case identityChanged
    var errorDescription: String? { "项目位置声明了不同的 project_id；请核对来源或显式重新关联。" }
}
