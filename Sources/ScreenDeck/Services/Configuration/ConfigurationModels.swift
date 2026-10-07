import Foundation

/// Preferences are declarations, never evidence that a model ran or capture was authorized.
struct UserConfiguration: Equatable {
    struct General: Equatable {
        var defaultPinned = false
    }
    struct Capture: Equatable {
        var selectedDisplayIDs: [UInt32] = []
        var intervalSeconds: Double = 60
        var localSummaryModel = ""
    }
    struct ModelPreferences: Equatable {
        // Inert declarations until an executor adapter is connected. These
        // values must never be reported as an actual run's model or effort.
        var executor: String?
        var model: String?
        var effort: String?
    }
    var configVersion = 1
    var general = General()
    var capture = Capture()
    var model = ModelPreferences()

    init() {}
    init(capturePreferences: CapturePreferences, defaultPinned: Bool = false) {
        general.defaultPinned = defaultPinned
        capture = Capture(selectedDisplayIDs: capturePreferences.displayIDs.sorted(),
                          intervalSeconds: capturePreferences.interval,
                          localSummaryModel: capturePreferences.model)
    }
    var capturePreferences: CapturePreferences {
        CapturePreferences(displayIDs: Set(capture.selectedDisplayIDs),
                           interval: capture.intervalSeconds, model: capture.localSummaryModel)
    }
}

/// Project-owned TOML can only declare relative scope, inert validation commands and preferences.
/// It cannot grant permissions, configure credentials/providers or turn on capture.
struct ProjectConfiguration: Equatable {
    struct Workspace: Equatable {
        var editableRoots: [String] = []
        var protectedPaths: [String] = []
        var ignoredPaths: [String] = []
    }
    struct Validation: Equatable {
        var testArgv: [String] = []
        var buildArgv: [String] = []
    }
    var configVersion = 1
    var workspace = Workspace()
    var validation = Validation()
    var documentationDirectory = "docs"
    var summaryPath = "AGENTLOG.md"
    var model = UserConfiguration.ModelPreferences()
}

struct UserConfigurationSnapshot: Equatable {
    let configuration: UserConfiguration
    /// nil means no file existed. Defaults are only returned for that missing-file case.
    let digest: String?
    let sourceURL: URL
    let backupURL: URL?
}

struct ProjectConfigurationSnapshot: Equatable {
    let configuration: ProjectConfiguration
    let digest: String
    let sourceURL: URL
}

struct ConfigurationError: LocalizedError, Equatable {
    let field: String
    let reason: String
    var errorDescription: String? { "配置 \(field)：\(reason)" }
}
