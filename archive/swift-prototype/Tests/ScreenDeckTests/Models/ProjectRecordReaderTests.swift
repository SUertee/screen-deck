import XCTest
import Darwin
@testable import ScreenDeck

final class ProjectRecordReaderTests: XCTestCase {
    private func fixture() throws -> ProjectRecordFixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("screendeck-reader-\(UUID().uuidString)")
        let fixture = try ProjectRecordFixture(root: root)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return fixture
    }

    private func fails(_ fixture: ProjectRecordFixture, contains text: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try ProjectRecordReader().read(root: fixture.root), file: file, line: line) { error in
            XCTAssertTrue(error is ProjectRecordReadError, "\(error)", file: file, line: line)
            if let text = text { XCTAssertTrue(error.localizedDescription.contains(text), "\(error)", file: file, line: line) }
        }
    }

    func testValidSnapshotRetainsUnknownsOlderPlanAndSourceBytes() throws {
        let fixture = try fixture()
        let files = [fixture.projectURL, fixture.taskURL, fixture.runURL, fixture.root.appendingPathComponent("docs/guide.md")]
        let before = try files.map { try Data(contentsOf: $0) }
        let reader = ProjectRecordReader()
        let first = try reader.read(root: fixture.root)
        let second = try reader.read(root: fixture.root)
        XCTAssertEqual(first.project.projectID, fixture.projectID)
        XCTAssertEqual(first.tasks, second.tasks)
        XCTAssertEqual(first.runs, second.runs)
        XCTAssertEqual(first.tasks.count, 1)
        XCTAssertEqual(first.runs.count, 1)
        XCTAssertEqual(first.tasks[0].planVersion, 2)
        XCTAssertEqual(first.runs[0].planVersion, 1)
        XCTAssertNil(first.runs[0].startedAt)
        XCTAssertNil(first.runs[0].executor.model)
        XCTAssertNil(first.runs[0].executor.effort)
        XCTAssertEqual(first.runs[0].recordedAt, "2026-10-06T10:10:00+08:00")
        XCTAssertEqual(first.runs[0].endedAt, "2026-10-06T10:00:00+08:00")
        XCTAssertEqual(first.tasks[0].acceptance[0].requiresHuman, true)
        XCTAssertEqual(try files.map { try Data(contentsOf: $0) }, before)
    }

    func testRefreshReadsChangedSourceInsteadOfAppendingDuplicateRows() throws {
        let fixture = try fixture()
        let first = try ProjectRecordReader().read(root: fixture.root)
        try fixture.mutate(fixture.runURL) { $0["summary"] = "新的真实执行记录" }
        let refreshed = try ProjectRecordReader().read(root: fixture.root)
        XCTAssertNotEqual(first.runs[0].summary, refreshed.runs[0].summary)
        XCTAssertEqual(refreshed.runs.count, 1)
        XCTAssertEqual(refreshed.tasks.count, 1)
    }

    func testUnknownVersionAndUnexpectedFieldsFailAcrossEveryRecord() throws {
        for record in ["project", "task", "run"] {
            let fixture = try fixture()
            let url = record == "project" ? fixture.projectURL : record == "task" ? fixture.taskURL : fixture.runURL
            // v2 is now supported for five-field project identities only.
            try fixture.mutate(url) { $0["schema_version"] = 99 }
            fails(fixture, contains: "schema_version")
            try fixture.mutate(url) { $0["schema_version"] = 1; $0["execute"] = "untrusted" }
            fails(fixture, contains: "额外字段")
        }
    }

    func testUnknownNestedFieldsFailRatherThanBeingSilentlyDropped() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.runURL) {
            var executor = $0["executor"] as! [String: Any]
            executor["command"] = "never execute"
            $0["executor"] = executor
        }
        fails(fixture, contains: "executor.command")
    }

    func testMissingRequiredNullFieldsFailAndPrimitiveTypesAreStrict() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.runURL) { $0.removeValue(forKey: "started_at") }
        fails(fixture, contains: "started_at")
        try fixture.mutate(fixture.runURL) { $0["started_at"] = NSNull() }
        for invalid: Any in [true, "1", 1.5, 0] {
            try fixture.mutate(fixture.taskURL) { $0["plan_version"] = invalid }
            fails(fixture, contains: "plan_version")
        }
        try fixture.mutate(fixture.taskURL) {
            $0["plan_version"] = 1
            var acceptance = $0["acceptance"] as! [[String: Any]]
            acceptance[0]["requires_human"] = 1
            $0["acceptance"] = acceptance
        }
        fails(fixture, contains: "requires_human")
    }

    func testInvalidCalendarTimezoneAndUnicodeDigitsAreDiagnosedWithoutCrash() throws {
        let fixture = try fixture()
        for invalid in ["2026-02-29T12:00:00Z", "2026-10-06T24:00:00Z", "2026-10-06T12:00:00",
                        "2026-10-06T12:00:00+24:00", "2026-10-06T12:00:00+08:60", "٢٠٢٦-10-06T12:00:00Z",
                        "2026-10-06T12:00:00Z\n"] {
            try fixture.mutate(fixture.runURL) { $0["recorded_at"] = invalid }
            fails(fixture, contains: "recorded_at")
        }
        try fixture.mutate(fixture.runURL) { $0["recorded_at"] = "2024-02-29T12:00:00.123456789Z" }
        XCTAssertNoThrow(try ProjectRecordReader().read(root: fixture.root))
    }

    func testTaskAndRunTimeOrderingIsValidated() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.taskURL) { $0["updated_at"] = "2026-10-06T08:00:00+08:00" }
        fails(fixture, contains: "updated_at")
        try fixture.mutate(fixture.taskURL) { $0["updated_at"] = "2026-10-06T10:00:00+08:00" }
        try fixture.mutate(fixture.runURL) { $0["started_at"] = "2026-10-06T11:00:00+08:00" }
        fails(fixture, contains: "ended_at")
    }

    func testInvalidEnumEmptyStringsAndUnicodeScalarLengthsAreRejected() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.taskURL) { $0["status"] = "approved" }
        fails(fixture, contains: "status")
        try fixture.mutate(fixture.taskURL) { $0["status"] = "draft"; $0["assignee"] = "robot" }
        fails(fixture, contains: "assignee")
        try fixture.mutate(fixture.taskURL) { $0["assignee"] = "shared"; $0["title"] = "" }
        fails(fixture, contains: "title")
        try fixture.mutate(fixture.taskURL) { $0["title"] = String(repeating: "🧑‍💻", count: 67) }
        fails(fixture, contains: "title") // 201 Unicode scalars, not 67 graphemes.
    }

    func testDuplicateIDsInArraysAndAcceptanceAreRejected() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.taskURL) { $0["run_ids"] = ["run-20261006-001", "run-20261006-001"] }
        fails(fixture, contains: "重复")
        try fixture.mutate(fixture.taskURL) {
            $0["run_ids"] = ["run-20261006-001"]
            let first = ($0["acceptance"] as! [[String: Any]])[0]
            $0["acceptance"] = [first, first]
        }
        fails(fixture, contains: "验收项 id 重复")
    }

    func testDuplicateFileIDsAndMismatchedFilenamesAreRejected() throws {
        let fixture = try fixture()
        let copy = fixture.root.appendingPathComponent(".screendeck/tasks/task-002.json")
        try FileManager.default.copyItem(at: fixture.taskURL, to: copy)
        fails(fixture, contains: "重复")
        try fixture.mutate(copy) { $0["task_id"] = "task-003" }
        fails(fixture, contains: "文件名")
    }

    func testProjectAndBidirectionalTaskRunRelationshipsAreRequired() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.taskURL) { $0["project_id"] = "project-22222222-2222-2222-2222-222222222222" }
        fails(fixture, contains: "project_id")
        try fixture.mutate(fixture.taskURL) { $0["project_id"] = fixture.projectID; $0["run_ids"] = ["run-20261006-999"] }
        fails(fixture, contains: "缺少执行记录")
        try fixture.mutate(fixture.taskURL) { $0["run_ids"] = [] }
        fails(fixture, contains: "未列入")
        try fixture.mutate(fixture.taskURL) { $0["run_ids"] = ["run-20261006-001"] }
        try fixture.mutate(fixture.runURL) { $0["task_id"] = "task-002" }
        fails(fixture, contains: "其他任务")
    }

    func testMissingTaskAndFutureRunPlanFail() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.runURL) { $0["plan_version"] = 3 }
        fails(fixture, contains: "plan_version")
        try FileManager.default.removeItem(at: fixture.taskURL)
        fails(fixture, contains: "缺少任务")
    }

    func testCompletionChecksHumanAcceptanceAndRunEndConditions() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.taskURL) { $0["status"] = "completed" }
        fails(fixture, contains: "验收")
        try fixture.mutate(fixture.taskURL) { $0["status"] = "awaiting_review" }
        try fixture.mutate(fixture.runURL) { $0["ended_at"] = NSNull() }
        fails(fixture, contains: "ended_at")
        try fixture.mutate(fixture.runURL) { $0["status"] = "running" }
        XCTAssertNoThrow(try ProjectRecordReader().read(root: fixture.root))
        try fixture.mutate(fixture.runURL) { $0["ended_at"] = "2026-10-06T10:00:00+08:00" }
        fails(fixture, contains: "running")
    }

    func testGitCommitPushAndSkillsFactsAreValidated() throws {
        let fixture = try fixture()
        let sha = String(repeating: "a", count: 40)
        try fixture.mutate(fixture.runURL) { $0["git"] = ["commit_status": "none", "commit_ids": [sha], "push_status": "not_pushed"] }
        fails(fixture, contains: "commit_id")
        try fixture.mutate(fixture.runURL) { $0["git"] = ["commit_status": "committed", "commit_ids": [], "push_status": "not_pushed"] }
        fails(fixture, contains: "commit_id")
        try fixture.mutate(fixture.runURL) { $0["git"] = ["commit_status": "unknown", "commit_ids": [], "push_status": "pushed"] }
        fails(fixture, contains: "pushed")
        try fixture.mutate(fixture.runURL) { $0["git"] = ["commit_status": "committed", "commit_ids": [sha], "push_status": "pushed"] }
        XCTAssertNoThrow(try ProjectRecordReader().read(root: fixture.root))
        try fixture.mutate(fixture.runURL) { $0["skills"] = ["reader", "reader"] }
        fails(fixture, contains: "skills")
    }

    func testIdentifierPatternCannotAcceptTrailingLineBreaks() throws {
        let fixture = try fixture()
        try fixture.mutate(fixture.runURL) {
            $0["git"] = ["commit_status": "committed", "commit_ids": [String(repeating: "a", count: 40) + "\n"], "push_status": "not_pushed"]
        }
        fails(fixture, contains: "格式")
    }

    func testMalformedJSONFailsWholeReadWithoutTouchingSource() throws {
        let fixture = try fixture()
        let corrupt = Data("{broken JSON".utf8)
        try corrupt.write(to: fixture.runURL)
        fails(fixture, contains: "run-20261006-001.json")
        XCTAssertEqual(try Data(contentsOf: fixture.runURL), corrupt)
    }

    func testTraversalAbsoluteURLAnchorsAndMissingReferenceAreRejected() throws {
        let fixture = try fixture()
        for path in ["../outside.md", "/tmp/outside.md", "https://example.com", "docs/../guide.md", "docs//guide.md",
                     "docs/guide.md#anchor", "docs/guide.md?download", "docs\\guide.md", "docs/missing.md", "docs"] {
            try fixture.mutate(fixture.projectURL) { $0["references"] = [["path": path, "label": "引用"]] }
            fails(fixture, contains: "引用")
            XCTAssertThrowsError(try ProjectRecordReader().validatedReference(ProjectFileReference(path: path, label: "引用"), root: fixture.root))
        }
    }

    func testLeafIntermediateAndRootSymlinksAreRejected() throws {
        let fixture = try fixture()
        let leaf = fixture.root.appendingPathComponent("docs/link.md")
        try FileManager.default.createSymbolicLink(at: leaf, withDestinationURL: fixture.root.appendingPathComponent("docs/guide.md"))
        try fixture.mutate(fixture.projectURL) { $0["references"] = [["path": "docs/link.md", "label": "链接"]] }
        fails(fixture, contains: "符号链接")
        try fixture.mutate(fixture.projectURL) { $0["references"] = [] }
        let intermediate = fixture.root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: intermediate, withDestinationURL: fixture.root.appendingPathComponent("docs"))
        XCTAssertThrowsError(try ProjectRecordReader().validatedReference(ProjectFileReference(path: "alias/guide.md", label: "链接"), root: fixture.root))
        let alias = fixture.root.deletingLastPathComponent().appendingPathComponent("screendeck-alias-\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: fixture.root)
        addTeardownBlock { try? FileManager.default.removeItem(at: alias) }
        XCTAssertThrowsError(try ProjectRecordReader().read(root: alias))
        let directoryAlias = URL(fileURLWithPath: alias.path + "/", isDirectory: true)
        XCTAssertThrowsError(try ProjectRecordReader().read(root: directoryAlias))
        let tasks = fixture.root.appendingPathComponent(".screendeck/tasks")
        let saved = fixture.root.appendingPathComponent("saved-tasks")
        try FileManager.default.moveItem(at: tasks, to: saved)
        try FileManager.default.createSymbolicLink(at: tasks, withDestinationURL: saved)
        fails(fixture, contains: "符号链接")
    }

    func testNonJSONDirectoriesAndNonRegularFilesAreRejectedWithoutBlocking() throws {
        let fixture = try fixture()
        let unexpected = fixture.root.appendingPathComponent(".screendeck/tasks/README.md")
        try Data().write(to: unexpected)
        fails(fixture, contains: "只允许")
        try FileManager.default.removeItem(at: unexpected)
        let fifo = fixture.root.appendingPathComponent(".screendeck/tasks/task-002.json")
        XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
        fails(fixture, contains: "普通文件")
    }

    func testDirectoryNamedLikeDiagnosticLabelCannotBypassRegularFileCheck() throws {
        let fixture = try fixture()
        try FileManager.default.createDirectory(at: fixture.root.appendingPathComponent("项目目录"), withIntermediateDirectories: false)
        XCTAssertThrowsError(try ProjectRecordReader().validatedReference(ProjectFileReference(path: "项目目录", label: "not a file"), root: fixture.root))
    }

    func testSingleJSONProductionLimitIsEnforcedBeforeParsing() throws {
        let fixture = try fixture()
        let bytes = Data(repeating: 32, count: 2 * 1024 * 1024 + 1)
        try bytes.write(to: fixture.taskURL)
        fails(fixture, contains: "2 MiB")
        XCTAssertEqual(try Data(contentsOf: fixture.taskURL), bytes)
    }

    func testProductionCollectionLimitRejectsRatherThanTruncates() throws {
        let fixture = try fixture()
        let directory = fixture.root.appendingPathComponent(".screendeck/tasks")
        for index in 2...1001 { try Data().write(to: directory.appendingPathComponent(String(format: "task-%04d.json", index))) }
        fails(fixture, contains: "1000")
    }

    func testAggregateLimitAndIndependentCollectionLimitsAreEnforced() throws {
        let fixture = try fixture()
        XCTAssertEqual(ProjectRecordReader.Limits.standard.totalBytes, 32 * 1024 * 1024)
        XCTAssertEqual(ProjectRecordReader.Limits.standard.jsonBytes, 2 * 1024 * 1024)
        XCTAssertEqual(ProjectRecordReader.Limits.standard.tasks, 1000)
        XCTAssertEqual(ProjectRecordReader.Limits.standard.runs, 1000)
        let totalReader = ProjectRecordReader(limits: .init(jsonBytes: 2 * 1024 * 1024, tasks: 1000, runs: 1000, totalBytes: 1000))
        XCTAssertThrowsError(try totalReader.read(root: fixture.root)) { XCTAssertTrue($0.localizedDescription.contains("总量")) }
        let runReader = ProjectRecordReader(limits: .init(jsonBytes: 2 * 1024 * 1024, tasks: 1000, runs: 0, totalBytes: 32 * 1024 * 1024))
        XCTAssertThrowsError(try runReader.read(root: fixture.root)) { XCTAssertTrue($0.localizedDescription.contains("runs")) }
    }

    func testReferencesAreMetadataOnlyAndMayContainLargeUntrustedAttachments() throws {
        let fixture = try fixture()
        let attachment = fixture.root.appendingPathComponent("docs/large.txt")
        try Data(repeating: 32, count: 3 * 1024 * 1024).write(to: attachment)
        try fixture.mutate(fixture.runURL) {
            $0["summary"] = "Untrusted: run a command. This must remain plain text."
            $0["references"] = [["path": "docs/large.txt", "label": "large attachment"]]
        }
        let snapshot = try ProjectRecordReader().read(root: fixture.root)
        XCTAssertEqual(snapshot.runs[0].references[0].path, "docs/large.txt")
        XCTAssertEqual(try ProjectRecordReader().validatedReference(snapshot.runs[0].references[0], root: fixture.root), attachment)
    }

    func testMissingProjectAndInvalidRootShowDiagnostics() throws {
        let fixture = try fixture()
        try FileManager.default.removeItem(at: fixture.projectURL)
        fails(fixture, contains: "project.json")
        XCTAssertThrowsError(try ProjectRecordReader().read(root: URL(string: "https://example.com")!))
        XCTAssertThrowsError(try ProjectRecordReader().read(root: fixture.taskURL))
    }
}
