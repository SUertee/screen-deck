import Foundation
import TOMLKit

enum ConfigurationParser {
    static let maximumBytes = 128 * 1024

    static func user(_ data: Data) throws -> UserConfiguration {
        let table = try parse(data)
        try keys(table, allowed: ["config_version", "general", "capture", "model"], path: "用户")
        var value = UserConfiguration()
        value.configVersion = try version(table)
        if let general = try subtable(table, "general") {
            try keys(general, allowed: ["default_pinned"], path: "general")
            value.general.defaultPinned = try boolean(general, "default_pinned") ?? false
        }
        if let capture = try subtable(table, "capture") {
            try keys(capture, allowed: ["selected_display_ids", "interval_seconds", "local_summary_model"], path: "capture")
            if let array = capture["selected_display_ids"] {
                guard let items = array.array else { throw issue("capture.selected_display_ids", "必须是整数数组") }
                value.capture.selectedDisplayIDs = try items.map { item in
                    guard let integer = item.int, integer > 0, let id = UInt32(exactly: integer) else {
                        throw issue("capture.selected_display_ids", "屏幕编号必须是正 UInt32 整数")
                    }
                    return id
                }
            }
            if let interval = capture["interval_seconds"] {
                guard let number = interval.double ?? interval.int.map(Double.init) else {
                    throw issue("capture.interval_seconds", "必须是数字")
                }
                value.capture.intervalSeconds = number
            }
            value.capture.localSummaryModel = try string(capture, "local_summary_model") ?? ""
        }
        if let model = try subtable(table, "model") { value.model = try modelPreferences(model) }
        return try validated(value)
    }

    static func project(_ data: Data) throws -> ProjectConfiguration {
        let table = try parse(data)
        try keys(table, allowed: ["config_version", "workspace", "validation", "documentation", "handoff", "model"], path: "项目")
        var value = ProjectConfiguration()
        value.configVersion = try version(table)
        if let workspace = try subtable(table, "workspace") {
            try keys(workspace, allowed: ["editable_roots", "protected_paths", "ignored_paths"], path: "workspace")
            value.workspace.editableRoots = try strings(workspace, "editable_roots")
            value.workspace.protectedPaths = try strings(workspace, "protected_paths")
            value.workspace.ignoredPaths = try strings(workspace, "ignored_paths")
        }
        if let validation = try subtable(table, "validation") {
            try keys(validation, allowed: ["test_argv", "build_argv"], path: "validation")
            value.validation.testArgv = try strings(validation, "test_argv")
            value.validation.buildArgv = try strings(validation, "build_argv")
        }
        if let documentation = try subtable(table, "documentation") {
            try keys(documentation, allowed: ["directory"], path: "documentation")
            value.documentationDirectory = try string(documentation, "directory") ?? "docs"
        }
        if let handoff = try subtable(table, "handoff") {
            try keys(handoff, allowed: ["summary_path"], path: "handoff")
            value.summaryPath = try string(handoff, "summary_path") ?? "AGENTLOG.md"
        }
        if let model = try subtable(table, "model") { value.model = try modelPreferences(model) }
        for (field, paths) in [("workspace.editable_roots", value.workspace.editableRoots),
                               ("workspace.protected_paths", value.workspace.protectedPaths),
                               ("workspace.ignored_paths", value.workspace.ignoredPaths),
                               ("documentation.directory", [value.documentationDirectory]),
                               ("handoff.summary_path", [value.summaryPath])] {
            guard paths.count <= 128, Set(paths).count == paths.count else { throw issue(field, "路径重复或数量过多") }
            for path in paths { try relativePath(path, field: field) }
        }
        for (field, argv) in [("validation.test_argv", value.validation.testArgv),
                              ("validation.build_argv", value.validation.buildArgv)] {
            guard argv.count <= 64 else { throw issue(field, "命令参数过多") }
            for argument in argv {
                guard !argument.isEmpty, argument.utf8.count <= 4096, !argument.contains("\0"),
                      !argument.contains("\n"), !argument.contains("\r") else { throw issue(field, "参数无效") }
            }
            // No shell interpretation or command execution is performed here.
        }
        return value
    }

    static func validated(_ value: UserConfiguration) throws -> UserConfiguration {
        guard value.configVersion == 1 else { throw issue("config_version", "不支持此版本，原文件未改动") }
        guard Set(value.capture.selectedDisplayIDs).count == value.capture.selectedDisplayIDs.count else {
            throw issue("capture.selected_display_ids", "屏幕编号重复")
        }
        do { _ = try value.capturePreferences.validated() }
        catch { throw issue("capture", "采集偏好无效；加载配置不会开启采集") }
        try validateModel(value.model)
        return value
    }

    static func encode(_ value: UserConfiguration) throws -> Data {
        let value = try validated(value)
        let root = TOMLTable()
        root["config_version"] = 1
        root["general"] = TOMLTable(["default_pinned": value.general.defaultPinned])
        root["capture"] = TOMLTable(["selected_display_ids": TOMLArray(value.capture.selectedDisplayIDs.map { Int($0) }),
                                     "interval_seconds": value.capture.intervalSeconds,
                                     "local_summary_model": value.capture.localSummaryModel])
        let model = TOMLTable()
        if let executor = value.model.executor { model["executor"] = executor }
        if let name = value.model.model { model["model"] = name }
        if let effort = value.model.effort { model["effort"] = effort }
        if !model.isEmpty { root["model"] = model }
        return Data((root.convert() + "\n").utf8)
    }

    static func relativePath(_ path: String, field: String) throws {
        let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, path.utf8.count <= 1024, !path.hasPrefix("/"), !path.hasPrefix("~"),
              !path.contains("\\"), !path.contains("\0"), !path.contains("\n"), !path.contains("\r"),
              !path.contains(":"), !path.contains("$"), !path.contains("`"),
              !path.contains("#"), !path.contains("?"),
              !pieces.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            throw issue(field, "必须是项目内规范相对路径，不支持 shell 替换或越界")
        }
    }

    private static func parse(_ data: Data) throws -> TOMLTable {
        guard data.count <= maximumBytes else { throw issue("文件", "超过 128 KiB 上限") }
        guard let text = String(data: data, encoding: .utf8), !text.contains("\0"),
              !text.contains("\\u0000"), !text.contains("\\U00000000") else {
            throw issue("文件", "必须是无 NUL 的 UTF-8 TOML")
        }
        do { return try TOMLTable(string: text) }
        catch let error as TOMLParseError {
            // Do not echo source strings or arbitrary parser descriptions into
            // UI/logs; a malformed file could contain a pasted credential.
            throw issue("文件", "TOML 语法无效（第 \(error.source.begin.line) 行，第 \(error.source.begin.column) 列）")
        }
        catch { throw issue("文件", "TOML 语法无效") }
    }
    private static func version(_ table: TOMLTable) throws -> Int {
        guard let version = table["config_version"]?.int else { throw issue("config_version", "必须声明整数版本") }
        guard version == 1 else { throw issue("config_version", "不支持版本 \(version)，原文件未改动") }
        return version
    }
    private static func keys(_ table: TOMLTable, allowed: Set<String>, path: String) throws {
        let unknown = Set(table.keys).subtracting(allowed).sorted()
        guard unknown.isEmpty else { throw issue(path, "不支持字段 \(unknown.joined(separator: ", "))") }
    }
    private static func subtable(_ table: TOMLTable, _ key: String) throws -> TOMLTable? {
        guard let value = table[key] else { return nil }
        guard let table = value.table else { throw issue(key, "必须是 TOML 表") }
        return table
    }
    private static func string(_ table: TOMLTable, _ key: String) throws -> String? {
        guard let value = table[key] else { return nil }
        guard let string = value.string else { throw issue(key, "必须是字符串") }
        return string
    }
    private static func boolean(_ table: TOMLTable, _ key: String) throws -> Bool? {
        guard let value = table[key] else { return nil }
        guard let boolean = value.bool else { throw issue(key, "必须是布尔值") }
        return boolean
    }
    private static func strings(_ table: TOMLTable, _ key: String) throws -> [String] {
        guard let value = table[key] else { return [] }
        guard let array = value.array else { throw issue(key, "必须是字符串数组") }
        return try array.map { value in
            guard let string = value.string else { throw issue(key, "数组项必须是字符串") }
            return string
        }
    }
    private static func modelPreferences(_ table: TOMLTable) throws -> UserConfiguration.ModelPreferences {
        try keys(table, allowed: ["executor", "model", "effort"], path: "model")
        let value = UserConfiguration.ModelPreferences(executor: try string(table, "executor"),
                                                       model: try string(table, "model"),
                                                       effort: try string(table, "effort"))
        try validateModel(value)
        return value
    }
    private static func validateModel(_ model: UserConfiguration.ModelPreferences) throws {
        for (field, value) in [("model.executor", model.executor), ("model.model", model.model), ("model.effort", model.effort)] {
            if let value {
                guard !value.isEmpty, value.utf8.count <= 200,
                      !value.contains("\0"), !value.contains("\n"), !value.contains("\r") else { throw issue(field, "偏好值无效") }
            }
        }
    }
    private static func issue(_ field: String, _ reason: String) -> ConfigurationError {
        ConfigurationError(field: field, reason: reason)
    }
}
