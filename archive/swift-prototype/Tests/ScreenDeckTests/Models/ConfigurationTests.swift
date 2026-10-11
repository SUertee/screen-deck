import XCTest
import Darwin
@testable import ScreenDeck

final class ConfigurationTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
            .appendingPathComponent("configuration-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    private func bytes(_ text: String) -> Data { Data(text.utf8) }
    private func store(_ root: URL) -> ConfigurationStore {
        ConfigurationStore(userFileURL: root.appendingPathComponent("private/config.toml"))
    }

    func testMissingUserConfigurationReturnsDefaultsWithoutCreatingAnything() throws {
        let root = try directory(), storage = store(root)
        let snapshot = try storage.loadUser()
        XCTAssertEqual(snapshot.configuration, UserConfiguration())
        XCTAssertNil(snapshot.digest)
        XCTAssertNil(snapshot.backupURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("private").path))
    }

    func testMissingProjectConfigurationIsOptionalAndDoesNotInitializeProject() throws {
        let root = try directory()
        XCTAssertNil(try store(root).loadProject(at: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".screendeck").path))
    }

    func testActualTOMLCommentsDottedKeysLiteralStringsAndMultilineArrays() throws {
        let value = try ConfigurationParser.user(bytes("""
        # A real TOML document rather than JSON or a custom line parser.
        config_version = 1
        general.default_pinned = true
        capture.selected_display_ids = [
            17, # primary
            21,
        ]
        capture.interval_seconds = 30
        capture.local_summary_model = '''local-model'''
        model = { executor = "codex", model = 'test-model', effort = "high" }
        """))
        XCTAssertTrue(value.general.defaultPinned)
        XCTAssertEqual(value.capture.selectedDisplayIDs, [17, 21])
        XCTAssertEqual(value.capture.intervalSeconds, 30)
        XCTAssertEqual(value.capture.localSummaryModel, "local-model")
        XCTAssertEqual(value.model.effort, "high")
    }

    func testUserRoundTripAndLegacyCaptureConversion() throws {
        let root = try directory(), storage = store(root)
        let legacy = CapturePreferences(displayIDs: [33, 22], interval: 120, model: "qwen-local")
        var configuration = UserConfiguration(capturePreferences: legacy, defaultPinned: true)
        configuration.model = .init(executor: "api", model: "demo", effort: "medium")
        let saved = try storage.saveUser(configuration, expectedDigest: nil)
        XCTAssertEqual(saved.configuration.capturePreferences, legacy)
        XCTAssertNotNil(saved.digest)
        XCTAssertNil(saved.backupURL)
        XCTAssertEqual(try storage.loadUser().configuration, configuration)
        XCTAssertEqual(try storage.loadUser().digest, saved.digest)
        let text = try String(contentsOf: storage.userFileURL, encoding: .utf8)
        XCTAssertTrue(text.contains("config_version = 1"))
        XCTAssertFalse(text.contains("capture_enabled"))
        XCTAssertFalse(text.contains("api_key"))
    }

    func testChangedSaveMakesExactPrivateBackupIncludingComments() throws {
        let root = try directory(), storage = store(root)
        try FileManager.default.createDirectory(at: storage.userFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = bytes("# My important comment\nconfig_version = 1\n[general]\ndefault_pinned = false\n")
        try original.write(to: storage.userFileURL)
        let old = try storage.loadUser()
        var configuration = old.configuration
        configuration.general.defaultPinned = true
        let saved = try storage.saveUser(configuration, expectedDigest: old.digest)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(saved.backupURL)), original)
        XCTAssertEqual(try storage.loadUser().configuration, configuration)
        let permissions = try FileManager.default.attributesOfItem(atPath: storage.userFileURL.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        let backupPermissions = try FileManager.default.attributesOfItem(atPath: saved.backupURL!.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(backupPermissions?.intValue, 0o600)
    }

    func testNoChangePreservesSourceFormattingAndDoesNotCreateBackup() throws {
        let root = try directory(), storage = store(root)
        try FileManager.default.createDirectory(at: storage.userFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = bytes("config_version=1 # unchanged\n")
        try original.write(to: storage.userFileURL)
        let old = try storage.loadUser()
        let saved = try storage.saveUser(old.configuration, expectedDigest: old.digest)
        XCTAssertNil(saved.backupURL)
        XCTAssertEqual(try Data(contentsOf: storage.userFileURL), original)
    }

    func testExternalEditRejectsOptimisticSaveAndPreservesExternalVersion() throws {
        let root = try directory(), storage = store(root)
        let old = try storage.saveUser(.init(), expectedDigest: nil)
        let external = bytes("config_version = 1\n[general]\ndefault_pinned = true\n")
        try external.write(to: storage.userFileURL)
        XCTAssertThrowsError(try storage.saveUser(old.configuration, expectedDigest: old.digest))
        XCTAssertEqual(try Data(contentsOf: storage.userFileURL), external)
    }

    func testNilDigestCannotOverwriteAnExistingConfiguration() throws {
        let root = try directory(), storage = store(root)
        let original = try storage.saveUser(.init(), expectedDigest: nil)
        XCTAssertThrowsError(try storage.saveUser(.init(), expectedDigest: nil))
        XCTAssertEqual(try storage.loadUser().digest, original.digest)
    }

    func testCorruptionUnknownVersionUnknownKeysNeverUseDefaultsOrOverwrite() throws {
        let root = try directory(), storage = store(root)
        try FileManager.default.createDirectory(at: storage.userFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        for text in ["broken", "", "config_version = true", "config_version = 2", "config_version = 1\nauthorize = true",
                     "config_version = 1\n[general]\ndefault_pinned = true\nunknown = 4"] {
            let original = bytes(text)
            try original.write(to: storage.userFileURL)
            XCTAssertThrowsError(try storage.loadUser(), text)
            XCTAssertThrowsError(try storage.saveUser(.init(), expectedDigest: ConfigurationStore.digest(original)), text)
            XCTAssertEqual(try Data(contentsOf: storage.userFileURL), original)
        }
    }

    func testDuplicateKeysAreRejectedByTOMLParser() {
        XCTAssertThrowsError(try ConfigurationParser.user(bytes("config_version = 1\nconfig_version = 1")))
        XCTAssertThrowsError(try ConfigurationParser.user(bytes("config_version = 1\ngeneral.default_pinned = true\n[general]\ndefault_pinned = false")))
    }

    func testSyntaxDiagnosticsDoNotEchoPotentialSecretsAndNULCannotTruncateAValue() {
        do {
            _ = try ConfigurationParser.user(bytes("config_version = 1\n[model]\nmodel = SecretTokenShouldNotBeDisplayed"))
            XCTFail("Malformed TOML unexpectedly accepted")
        } catch {
            XCTAssertFalse(error.localizedDescription.contains("SecretTokenShouldNotBeDisplayed"))
            XCTAssertTrue(error.localizedDescription.contains("第 3 行"))
        }
        XCTAssertThrowsError(try ConfigurationParser.user(bytes(#"config_version = 1\nmodel.model = "abc\u0000hidden""#.replacingOccurrences(of: "\\n", with: "\n"))))
    }

    func testTypesBoundsAndInvalidCapturePreferencesAreRejected() {
        for suffix in ["[general]\ndefault_pinned = 1", "[general]\ntheme = 'blue'", "[general]\nlanguage = ''",
                       "[capture]\nselected_display_ids = [0]", "[capture]\nselected_display_ids = [1, 1]",
                       "[capture]\nselected_display_ids = [4294967296]", "[capture]\nselected_display_ids = ['1']",
                       "[capture]\ninterval_seconds = 45", "[capture]\ninterval_seconds = nan",
                       "[capture]\nlocal_summary_model = 'cloud-model'", "[capture]\nenabled = true"] {
            XCTAssertThrowsError(try ConfigurationParser.user(bytes("config_version = 1\n" + suffix)), suffix)
        }
    }

    func testUserUnknownCredentialsAndApprovalFieldsAreNotAcceptedInThisVersion() {
        for suffix in ["[model]\napi_key = 'secret'", "[privacy]\ncapture = true", "[approval]\nrequired = false",
                       "[provider]\nbase_url = 'http://example.test'"] {
            XCTAssertThrowsError(try ConfigurationParser.user(bytes("config_version = 1\n" + suffix)))
        }
    }

    func testProjectAllowsOnlyRelativeScopeAndInertCommands() throws {
        let value = try ConfigurationParser.project(bytes("""
        config_version = 1
        [workspace]
        editable_roots = ["Sources", "Tests"]
        protected_paths = [".git", ".screendeck/project.json"]
        ignored_paths = [".build"]
        [validation]
        test_argv = ["swift", "test"]
        build_argv = ["swift", "build", "-c", "release"]
        [documentation]
        directory = "docs"
        [handoff]
        summary_path = "AGENTLOG.md"
        [model]
        executor = "codex"
        model = "example-model"
        effort = "high"
        """))
        XCTAssertEqual(value.workspace.editableRoots, ["Sources", "Tests"])
        XCTAssertEqual(value.validation.testArgv, ["swift", "test"])
        XCTAssertEqual(value.documentationDirectory, "docs")
        XCTAssertEqual(value.model.executor, "codex")
    }

    func testProjectCannotConfigureCredentialsCaptureApprovalTrustOrHooks() {
        for suffix in ["[capture]\nenabled = true", "[approval]\nrequired = false", "trusted = true", "[hooks]\nstart = 'run'",
                       "[model]\napi_key = 'secret'", "[model]\nbase_url = 'https://example.test'", "[general]\ndefault_pinned = true"] {
            XCTAssertThrowsError(try ConfigurationParser.project(bytes("config_version = 1\n" + suffix)), suffix)
        }
    }

    func testProjectScopeRejectsTraversalAbsoluteAndShellExpansionPaths() {
        for path in ["../secret", "/tmp/secret", "~/private", "Sources/../Other", "Sources//Sub", "./Sources",
                     "$(whoami)", "Sources`id`", "C:\\secret", "file:secret", "docs#section", ""] {
            let encoded = String(data: try! JSONEncoder().encode(path), encoding: .utf8)!
            XCTAssertThrowsError(try ConfigurationParser.project(bytes("config_version = 1\n[documentation]\ndirectory = \(encoded)")), path)
        }
    }

    func testProjectRejectsDuplicateScopeAndMalformedCommandArguments() {
        for suffix in ["[workspace]\neditable_roots = ['Sources', 'Sources']", "[validation]\ntest_argv = 'swift test'",
                       "[validation]\ntest_argv = [1]", "[validation]\ntest_argv = ['']",
                       "[handoff]\nsummary_path = false"] {
            XCTAssertThrowsError(try ConfigurationParser.project(bytes("config_version = 1\n" + suffix)))
        }
    }

    func testProjectStoreReadsOnlyExplicitRootAndNoNestedInheritance() throws {
        let root = try directory(), storage = store(root)
        let config = root.appendingPathComponent(".screendeck/config.toml")
        try FileManager.default.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes("config_version = 1\n[documentation]\ndirectory = 'manual'").write(to: config)
        let snapshot = try XCTUnwrap(storage.loadProject(at: root))
        XCTAssertEqual(snapshot.configuration.documentationDirectory, "manual")
        XCTAssertEqual(snapshot.sourceURL, config)
        XCTAssertNil(try storage.loadProject(at: root.appendingPathComponent("nested")))
    }

    func testFileAndDirectorySymlinksAreRejectedWithoutChangingTargets() throws {
        let root = try directory(), target = root.appendingPathComponent("real.toml")
        let original = bytes("config_version = 1\n")
        try original.write(to: target)
        let link = root.appendingPathComponent("link.toml")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let storage = ConfigurationStore(userFileURL: link)
        XCTAssertThrowsError(try storage.loadUser())
        XCTAssertThrowsError(try storage.saveUser(.init(), expectedDigest: ConfigurationStore.digest(original)))
        XCTAssertEqual(try Data(contentsOf: target), original)
        let linkedDirectory = root.appendingPathComponent("linked")
        try FileManager.default.createSymbolicLink(at: linkedDirectory, withDestinationURL: root)
        let directoryStore = ConfigurationStore(userFileURL: linkedDirectory.appendingPathComponent("new/config.toml"))
        XCTAssertThrowsError(try directoryStore.loadUser())
        XCTAssertThrowsError(try directoryStore.saveUser(.init(), expectedDigest: nil))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("new").path))
    }

    func testProjectConfigurationSymlinkIsRejected() throws {
        let root = try directory(), target = root.appendingPathComponent("real.toml")
        try bytes("config_version = 1").write(to: target)
        let config = root.appendingPathComponent(".screendeck/config.toml")
        try FileManager.default.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: config, withDestinationURL: target)
        XCTAssertThrowsError(try store(root).loadProject(at: root))
    }

    func testOversizedNonUTF8AndNULDocumentsAreRejected() throws {
        let root = try directory(), storage = store(root)
        try FileManager.default.createDirectory(at: storage.userFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        for data in [Data(repeating: 0x20, count: ConfigurationParser.maximumBytes + 1), Data([0xff]), bytes("config_version = 1\0") ] {
            try data.write(to: storage.userFileURL)
            XCTAssertThrowsError(try storage.loadUser())
            XCTAssertEqual(try Data(contentsOf: storage.userFileURL), data)
        }
    }

    func testSymlinkLockRejectsSaveWithoutTouchingTarget() throws {
        let root = try directory(), storage = store(root)
        try FileManager.default.createDirectory(at: storage.userFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let target = root.appendingPathComponent("private-target")
        let original = bytes("do not touch")
        try original.write(to: target)
        try FileManager.default.createSymbolicLink(at: storage.userFileURL.deletingLastPathComponent().appendingPathComponent(".config.toml.lock"), withDestinationURL: target)
        XCTAssertThrowsError(try storage.saveUser(.init(), expectedDigest: nil))
        XCTAssertEqual(try Data(contentsOf: target), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: storage.userFileURL.path))
    }

    func testNonFileURLRejectsReadAndWrite() {
        let storage = ConfigurationStore(userFileURL: URL(string: "https://example.test/config.toml")!)
        XCTAssertThrowsError(try storage.loadUser())
        XCTAssertThrowsError(try storage.saveUser(.init(), expectedDigest: nil))
    }
}
