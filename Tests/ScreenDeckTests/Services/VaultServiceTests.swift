import XCTest
@testable import ScreenDeck

final class VaultServiceTests: XCTestCase {
    private var tmpRoot: URL!
    private var todayName = ""

    override func setUp() {
        super.setUp()
        tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ScreenDeckTests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        todayName = Self.dayFormatter.string(from: Date())
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpRoot)
        super.tearDown()
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// 造一个带 daily-notes.json 的临时 vault
    private func makeVault(format: String, folder: String = "日记", lineEnding: String = "\n") -> URL {
        try! FileManager.default.createDirectory(
            at: tmpRoot.appendingPathComponent(".obsidian"), withIntermediateDirectories: true)
        let config = #"{"folder": "\#(folder)", "format": "\#(format)"}"#
        try! config.write(to: tmpRoot.appendingPathComponent(".obsidian/daily-notes.json"),
                          atomically: true, encoding: .utf8)
        return tmpRoot
    }

    private func writeDailyNote(_ body: String, folder: String, lineEnding: String) {
        let dir = tmpRoot.appendingPathComponent(folder)
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let content = body.replacingOccurrences(of: "\n", with: lineEnding)
        try! content.write(to: dir.appendingPathComponent(todayName + ".md"),
                           atomically: true, encoding: .utf8)
    }

    // MARK: - 格式翻译

    func testTranslateFormat() {
        XCTAssertEqual(VaultService.translateFormat("YYYY/MM/YYYY-MM-DD"), "yyyy/MM/yyyy-MM-dd")
        XCTAssertEqual(VaultService.translateFormat("YYYY-MM-DD"), "yyyy-MM-dd")
        XCTAssertEqual(VaultService.translateFormat("YYYY年MM月DD日"), "yyyy年MM月dd日")
    }

    // MARK: - 解析

    func testParseTasksWithSectionFilter() throws {
        let vault = makeVault(format: "YYYY-MM-DD")
        writeDailyNote("""
        ---
        type: daily
        ---
        ## 每日必做
        - [ ] 早睡早起
        - [x] 健身
        ## 今日主要任务
        ### 工作
        - [ ] 编写日报
        - [ ] [[链接|显示名]]（备注）
        ## 今天哪里做得好
        - [ ] 不该出现的
        """, folder: "日记", lineEnding: "\n")

        let service = VaultService(vaultPath: vault.path, taskSection: "今日主要任务")
        let payload = try service.fetchTasks()
        XCTAssertTrue(payload.available == true)
        XCTAssertEqual(payload.total, 2)
        XCTAssertEqual(payload.tasks?.map(\.text), ["编写日报", "显示名（备注）"])
        XCTAssertEqual(payload.section, "今日主要任务")
    }

    func testParseTasksNoFilter() throws {
        let vault = makeVault(format: "YYYY-MM-DD")
        writeDailyNote("""
        ## 每日必做
        - [ ] A
        ## 今日主要任务
        - [ ] B
        """, folder: "日记", lineEnding: "\n")

        let service = VaultService(vaultPath: vault.path, taskSection: nil)
        let payload = try service.fetchTasks()
        XCTAssertEqual(payload.total, 2)
    }

    // MARK: - 勾选往返（CRLF 极端情况）

    func testToggleTaskRoundTripCRLF() throws {
        let vault = makeVault(format: "YYYY-MM-DD")
        writeDailyNote("""
        ---
        type: daily
        ---
        ## 每日必做
        - [ ] A
        - [ ] B
        - [ ] 子任务
        - [ ] C

        """, folder: "日记", lineEnding: "\r\n")

        let service = VaultService(vaultPath: vault.path, taskSection: "每日必做")
        let payload = try service.fetchTasks()
        XCTAssertEqual(payload.total, 4)

        // 勾选第 8 行（C；前 3 行是 frontmatter，第 4 行是标题）
        let toggled = try service.toggleTask(line: 8)
        XCTAssertEqual(toggled.done, 1)

        // 验证文件：行数不变、CRLF 完好、只有 C 被勾
        let raw = try Data(contentsOf: vault.appendingPathComponent("日记/\(todayName).md"))
        let text = String(decoding: raw, as: UTF8.self)
        XCTAssertEqual(text.components(separatedBy: "\r\n").count, 9) // 8 行内容 + 结尾空段
        XCTAssertTrue(text.contains("- [x] C\r\n"))
        XCTAssertFalse(text.contains("- [x] B"))

        // 切回
        let reverted = try service.toggleTask(line: 8)
        XCTAssertEqual(reverted.done, 0)
    }

    // MARK: - 错误处理

    func testMissingDailyNote() throws {
        let vault = makeVault(format: "YYYY-MM-DD") // 不写日记文件
        let service = VaultService(vaultPath: vault.path, taskSection: nil)
        let payload = try service.fetchTasks()
        XCTAssertEqual(payload.available, false)
        XCTAssertNotNil(payload.error)
    }

    func testToggleInvalidLine() throws {
        let vault = makeVault(format: "YYYY-MM-DD")
        writeDailyNote("## 任务\n- [ ] A\n", folder: "日记", lineEnding: "\n")
        let service = VaultService(vaultPath: vault.path, taskSection: nil)
        XCTAssertThrowsError(try service.toggleTask(line: 99)) // 越界
        XCTAssertThrowsError(try service.toggleTask(line: 1)) // 标题行不是任务
    }
}
