import Foundation

/// 直接读写 Obsidian vault 的数据层（替代原 HTTP 桥）。
/// - 按 `.obsidian/daily-notes.json` 的 folder/format 定位今日日记
/// - 解析 `- [ ]` / `- [x]` 任务（可限定 ## 章节、wikilink 转显示名）
/// - 按行号勾选/取消，只替换勾选标记，行尾与其余内容原样保留
struct VaultService {
    let vaultURL: URL
    /// 只显示该二级标题章节下的任务；nil = 全部
    let taskSection: String?

    init(vaultPath: String?, taskSection: String? = nil) {
        if let vaultPath {
            vaultURL = URL(fileURLWithPath: vaultPath, isDirectory: true)
        } else {
            vaultURL = VaultService.defaultVaultURL()
        }
        self.taskSection = taskSection
    }

    /// 默认 vault：环境变量 SCREENDECK_VAULT，否则 ~/Obsidian/星宫
    static func defaultVaultURL() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let fallback = home.appendingPathComponent("Obsidian/星宫", isDirectory: true)
        guard let env = ProcessInfo.processInfo.environment["SCREENDECK_VAULT"], !env.isEmpty else {
            return fallback
        }
        return URL(fileURLWithPath: env, isDirectory: true)
    }

    // MARK: - 日记路径

    private struct DailyConfig {
        let folder: String
        let formatter: DateFormatter
    }

    private func dailyConfig() throws -> DailyConfig {
        let configURL = vaultURL.appendingPathComponent(".obsidian/daily-notes.json")
        let data: Data
        do {
            data = try Data(contentsOf: configURL)
        } catch {
            throw VaultError.configMissing(configURL.path)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw VaultError.configBroken(configURL.path)
        }
        let folder = (json["folder"] as? String) ?? ""
        let format = (json["format"] as? String) ?? "YYYY-MM-DD"
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = Self.translateFormat(format)
        return DailyConfig(folder: folder, formatter: formatter)
    }

    /// Obsidian moment 格式 → DateFormatter 格式（按 token 长度降序替换）
    static func translateFormat(_ format: String) -> String {
        let tokens: [(String, String)] = [
            ("YYYY", "yyyy"), ("dddd", "EEEE"), ("MMMM", "MMMM"),
            ("MMM", "MMM"), ("ddd", "EEE"), ("YY", "yy"),
            ("MM", "MM"), ("DD", "dd"), ("HH", "HH"),
            ("hh", "hh"), ("mm", "mm"), ("ss", "ss"),
        ]
        var out = format
        for (obs, df) in tokens.sorted(by: { $0.0.count > $1.0.count }) {
            out = out.replacingOccurrences(of: obs, with: df)
        }
        return out
    }

    private func dailyNoteURL(for date: Date = Date()) throws -> URL {
        let config = try dailyConfig()
        let name = config.formatter.string(from: date)
        return vaultURL
            .appendingPathComponent(config.folder)
            .appendingPathComponent(name + ".md")
    }

    private func relativePath(_ url: URL) -> String {
        url.path.replacingOccurrences(of: vaultURL.path + "/", with: "")
    }

    // MARK: - 任务解析

    private static let taskRegex = try! NSRegularExpression(pattern: #"^(\s*)-\s+\[([ xX])\]\s+(.*)$"#)
    /// 仅二级标题（## 后不能紧跟 #，避免匹配 ### 三级标题）
    private static let sectionRegex = try! NSRegularExpression(pattern: "^(##(?!\\#)\\s+)(.+)$")
    private static let wikilinkRegex = try! NSRegularExpression(pattern: #"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]"#)

    static func stripWikilinks(_ text: String) -> String {
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)
        let matches = wikilinkRegex.matches(in: text, options: [], range: range)
        guard !matches.isEmpty else { return text }
        var result = ""
        var cursor = 0
        for m in matches {
            result += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
            let target = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let aliasRange = m.range(at: 2)
            let alias = aliasRange.location != NSNotFound
                ? ns.substring(with: aliasRange).trimmingCharacters(in: .whitespaces)
                : nil
            result += alias ?? target
            cursor = m.range.location + m.range.length
        }
        result += ns.substring(with: NSRange(location: cursor, length: ns.length - cursor))
        return result
    }

    /// 解析全文任务；section 非空时只保留该二级标题下的任务
    static func parseTasks(in content: String, section: String?) -> [TaskItem] {
        var tasks: [TaskItem] = []
        var currentSection: String?
        var lineNumber = 1

        let ns = content as NSString
        var range = NSRange(location: 0, length: 0)
        while range.location < ns.length {
            let r = ns.lineRange(for: NSRange(location: range.location, length: 0))
            let line = ns.substring(with: r)
            let trimmed = line.trimmingCharacters(in: .newlines)
            let trimmedNS = trimmed as NSString

            if let m = Self.sectionRegex.firstMatch(in: trimmed, options: [],
                                                    range: NSRange(location: 0, length: trimmedNS.length)) {
                currentSection = trimmedNS.substring(with: m.range(at: 2))
                    .trimmingCharacters(in: .whitespaces)
            }

            if let m = Self.taskRegex.firstMatch(in: trimmed, options: [],
                                                 range: NSRange(location: 0, length: trimmedNS.length)) {
                if let section, section != currentSection {
                    // 不在目标章节，跳过
                } else {
                    let indent = trimmedNS.substring(with: m.range(at: 1)).count
                    let mark = trimmedNS.substring(with: m.range(at: 2))
                    let rest = trimmedNS.substring(with: m.range(at: 3))
                    tasks.append(TaskItem(
                        line: lineNumber,
                        indent: indent,
                        text: Self.stripWikilinks(rest).trimmingCharacters(in: .whitespaces),
                        done: mark.lowercased() == "x"
                    ))
                }
            }
            lineNumber += 1
            range.location = r.location + r.length
        }
        return tasks
    }

    // MARK: - 对外接口

    /// 读取今日任务
    func fetchTasks() throws -> TasksPayload {
        let url = try dailyNoteURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            return TasksPayload(
                available: false, tasks: nil, total: nil, done: nil,
                path: relativePath(url), section: taskSection,
                error: "今日日记不存在: \(relativePath(url))"
            )
        }
        let content = try String(contentsOf: url, encoding: .utf8)
        return payload(from: content, url: url)
    }

    /// 勾选/取消第 line 行任务（1-based），返回新任务列表
    func toggleTask(line: Int) throws -> TasksPayload {
        let url = try dailyNoteURL()
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw VaultError.noteMissing(relativePath(url))
        }
        let content = try String(contentsOf: url, encoding: .utf8)
        let ns = content as NSString

        // 拆行（含行尾符）
        var lines: [String] = []
        var range = NSRange(location: 0, length: 0)
        while range.location < ns.length {
            let r = ns.lineRange(for: NSRange(location: range.location, length: 0))
            lines.append(ns.substring(with: r))
            range.location = r.location + r.length
        }

        guard (1...lines.count).contains(line) else {
            throw VaultError.badLine(line)
        }
        guard let flipped = Self.flipCheckbox(in: lines[line - 1]) else {
            throw VaultError.notATask(line)
        }
        lines[line - 1] = flipped
        var newContent = lines.joined()
        // lineRange 对最后一行不保留结尾换行符，写回时补上原行尾
        if content.hasSuffix("\r\n"), !newContent.hasSuffix("\r\n") {
            newContent += "\r\n"
        } else if content.hasSuffix("\n"), !newContent.hasSuffix("\n") {
            newContent += "\n"
        } else if content.hasSuffix("\r"), !newContent.hasSuffix("\r") {
            newContent += "\r"
        }
        try newContent.write(to: url, atomically: true, encoding: .utf8)
        return payload(from: newContent, url: url)
    }

    /// 只翻转勾选标记，行其余内容（含行尾符）原样保留
    static func flipCheckbox(in line: String) -> String? {
        let ns = line as NSString
        guard let m = taskRegex.firstMatch(in: line, options: [],
                                           range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        let markRange = m.range(at: 2)
        let mark = ns.substring(with: markRange)
        let newMark = mark.lowercased() == "x" ? " " : "x"
        return ns.replacingCharacters(in: markRange, with: newMark)
    }

    private func payload(from content: String, url: URL) -> TasksPayload {
        let tasks = Self.parseTasks(in: content, section: taskSection)
        return TasksPayload(
            available: true,
            tasks: tasks,
            total: tasks.count,
            done: tasks.filter(\.done).count,
            path: relativePath(url),
            section: taskSection,
            error: nil
        )
    }
}

enum VaultError: LocalizedError {
    case configMissing(String)
    case configBroken(String)
    case noteMissing(String)
    case badLine(Int)
    case notATask(Int)

    var errorDescription: String? {
        switch self {
        case .configMissing(let path): return "未找到 Obsidian 配置: \(path)"
        case .configBroken(let path): return "daily-notes.json 解析失败: \(path)"
        case .noteMissing(let path): return "今日日记不存在: \(path)"
        case .badLine(let n): return "行号越界: \(n)"
        case .notATask(let n): return "第 \(n) 行不是任务"
        }
    }
}
