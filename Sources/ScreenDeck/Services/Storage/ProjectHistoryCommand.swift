import Foundation

/// Explicit maintenance commands. A normal launch neither migrates nor rewrites records.
enum ProjectHistoryCommand {
    static func run(arguments: [String]) -> Int32? {
        let flags = ["--migrate-project-history", "--inspect-project-history"]
        guard arguments.dropFirst().contains(where: { flags.contains($0) }) else { return nil }
        do {
            let request = try parse(arguments: arguments)
            let privateRoot = request.privateRoot ?? ScreenDeckPaths().root
            var output: [String: Any]
            if request.migrate {
                let result = try ProjectHistoryMigrator(privateRoot: privateRoot).migrate(root: request.root)
                output = ["project_id": result.projectID, "tasks": result.taskCount,
                          "runs": result.runCount, "artifacts": result.artifactCount,
                          "backup_path": result.backupURL.path,
                          "already_migrated": result.alreadyMigrated]
                if let pending = result.cleanupPendingURL {
                    output["cleanup_pending_path"] = pending.path
                }
            } else {
                let reader = ProjectRecordReader(privateRoot: privateRoot)
                let snapshot = try reader.read(root: request.root)
                let references = Set(snapshot.project.references
                    + snapshot.tasks.flatMap(\.references) + snapshot.runs.flatMap(\.references))
                for reference in references {
                    _ = try reader.validatedReference(reference, root: request.root)
                }
                output = ["project_id": snapshot.project.projectID, "tasks": snapshot.tasks.count,
                          "runs": snapshot.runs.count, "validated_references": references.count]
            }
            let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self))
            return 0
        } catch {
            let message = "项目历史操作未完成：\(error.localizedDescription)\n"
            FileHandle.standardError.write(Data(message.utf8))
            return 1
        }
    }

    struct Request: Equatable {
        let migrate: Bool
        let root: URL
        let privateRoot: URL?
    }

    static func parse(arguments: [String]) throws -> Request {
        let values = Array(arguments.dropFirst())
        guard values.count == 2 || values.count == 4,
              ["--migrate-project-history", "--inspect-project-history"].contains(values[0]),
              values[1].hasPrefix("/"), !values[1].contains("\0"),
              (values.count == 2 || (values[2] == "--private-root"
                && values[3].hasPrefix("/") && !values[3].contains("\0"))) else {
            throw CommandFailure.arguments
        }
        return Request(migrate: values[0] == "--migrate-project-history",
                       root: URL(fileURLWithPath: values[1], isDirectory: true).standardizedFileURL,
                       privateRoot: values.count == 4
                        ? URL(fileURLWithPath: values[3], isDirectory: true).standardizedFileURL : nil)
    }

    private enum CommandFailure: LocalizedError {
        case arguments
        var errorDescription: String? {
            "使用 --migrate-project-history 或 --inspect-project-history <绝对项目路径>；可选 --private-root <绝对私人数据路径>。不能与打开项目参数混用。"
        }
    }
}
