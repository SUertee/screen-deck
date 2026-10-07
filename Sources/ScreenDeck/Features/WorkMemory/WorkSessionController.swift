import Foundation
import Combine

@MainActor
final class WorkSessionController: ObservableObject {
    @Published private(set) var sessions: [WorkSession] = []
    @Published private(set) var activeID: UUID?
    @Published private(set) var displays: [CaptureDisplay] = []
    @Published private(set) var error: String?
    @Published private(set) var loadingDisplays = false
    @Published private(set) var capturing = false
    @Published private(set) var loaded = false
    @Published var selectedDisplays = Set<UInt32>()
    @Published var interval: TimeInterval = 60
    @Published private(set) var preferences = CapturePreferences()
    @Published private(set) var preferencesError: String?
    @Published private(set) var preferencesLoaded = false
    @Published private(set) var permissionGranted = false
    private let preferencesStore: CapturePreferencesStore
    private let configurationStore: ConfigurationStore?
    private var configurationSnapshot: UserConfigurationSnapshot?
    let store: WorkSessionStore
    private let captureService: any DesktopCapturing
    private var loop: Task<Void, Never>?
    var activeSession: WorkSession? { sessions.first { $0.id == activeID } }
    var hasPermission: Bool { captureService.hasPermission }
    var configurationFileURL: URL? { configurationStore?.userFileURL }

    init(root: URL, captureService: (any DesktopCapturing)? = nil, configurationFile: URL? = nil) {
        self.store = WorkSessionStore(root: root)
        self.captureService = captureService ?? DesktopCapture()
        self.preferencesStore = CapturePreferencesStore(url: root.appendingPathComponent("capture-preferences.json"))
        self.configurationStore = configurationFile.map { ConfigurationStore(userFileURL: $0) }
        loadPreferences()
    }

    func loadPreferences() {
        do {
            if let configurationStore {
                let snapshot = try configurationStore.loadUser()
                preferences = snapshot.configuration.capturePreferences
                configurationSnapshot = snapshot
            } else { preferences = try preferencesStore.load() }
            selectedDisplays = preferences.displayIDs
            interval = preferences.interval
            preferencesLoaded = true
            preferencesError = nil
        } catch {
            preferencesLoaded = false
            preferencesError = "设置读取失败，未覆盖原文件：\(error.localizedDescription)"
        }
        refreshPermission()
    }

    @discardableResult
    func savePreferences(_ value: CapturePreferences) -> Bool {
        guard preferencesLoaded, activeID == nil else { return false }
        do {
            let value = try value.validated()
            if let configurationStore, let prior = configurationSnapshot {
                let current = try configurationStore.loadUser()
                // Other preferences can change independently; never replace externally changed capture settings.
                guard current.configuration.capture == prior.configuration.capture else {
                    throw ConfigurationError(field: "capture", reason: "已在外部修改，请重新读取设置后再保存")
                }
                var proposed = current.configuration
                proposed.capture = UserConfiguration(capturePreferences: value).capture
                configurationSnapshot = try configurationStore.saveUser(proposed, expectedDigest: current.digest)
            } else { try preferencesStore.save(value) }
            preferences = value; selectedDisplays = value.displayIDs; interval = value.interval
            preferencesError = nil
            return true
        } catch {
            preferencesError = "设置未保存：\(error.localizedDescription)"
            return false
        }
    }

    func refreshPermission() { permissionGranted = captureService.hasPermission }

    func load() {
        guard activeID == nil else { return }
        do {
            var values = try store.load()
            for index in values.indices where values[index].status == .recording {
                values[index].status = .interrupted
                values[index].endedAt = max(values[index].evidence.last?.capturedAt ?? values[index].startedAt, values[index].startedAt)
                values[index].note = "上次会话未正常结束。已停止记录，不会自动恢复采集。"
                try store.save(values[index])
            }
            sessions = values
            loaded = true
            error = nil
        } catch { self.error = "工作记录读取失败：\(error.localizedDescription)"; loaded = false }
    }

    func requestPermission() { captureService.requestPermission(); refreshPermission() }

    func refreshDisplays() async {
        guard !loadingDisplays else { return }
        loadingDisplays = true
        refreshPermission()
        defer { loadingDisplays = false }
        do {
            displays = try await captureService.displays()
            // Retain missing selections so a disconnected display cannot silently narrow consent.
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    @discardableResult
    func start(task: LocalTask, now: Date = Date(), automaticSampling: Bool = true) -> Bool {
        guard loaded, preferencesLoaded, activeID == nil, !task.completed else { return false }
        guard captureService.hasPermission else { error = CaptureFailure.permission.localizedDescription; return false }
        let selected = displays.filter { selectedDisplays.contains($0.id) }
        guard !selected.isEmpty else { error = CaptureFailure.noSelection.localizedDescription; return false }
        guard Set(selected.map(\.id)) == selectedDisplays else { error = CaptureFailure.missingDisplay.localizedDescription; return false }
        let session = WorkSession(taskID: task.id, taskTitle: task.title, startedAt: now, displayIDs: selected.map(\.id))
        do {
            try store.save(session)
            sessions.insert(session, at: 0)
            activeID = session.id
            error = nil
            if automaticSampling {
                let delay = min(300, max(15, interval))
                loop = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, self.activeID == session.id else { return }
                        await self.captureOnce()
                        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    }
                }
            }
            return true
        } catch { self.error = "无法开始：\(error.localizedDescription)"; return false }
    }

    func captureOnce() async {
        guard !capturing, let session = activeSession else { return }
        capturing = true
        defer { capturing = false }
        for id in session.displayIDs {
            guard activeID == session.id, !Task.isCancelled else { return }
            do {
                guard let display = displays.first(where: { $0.id == id }) else { throw CaptureFailure.missingDisplay }
                let frame = try await captureService.capture(display: display)
                guard activeID == session.id, !Task.isCancelled,
                      let index = sessions.firstIndex(where: { $0.id == session.id }) else { return }
                guard captureService.hasPermission else { throw CaptureFailure.permission }
                if sessions[index].evidence.count >= 240 {
                    _ = pause(note: "本次会话已达到 240 条记录上限；已暂停以控制本地存储。")
                    return
                }
                let evidenceID = UUID()
                let evidence = WorkEvidence(id: evidenceID, capturedAt: frame.capturedAt,
                                            displayID: id, displayName: display.name, appName: frame.appName,
                                            text: frame.text, imageName: "\(evidenceID.uuidString).jpg")
                guard let imageURL = store.imageURL(sessionID: session.id, evidence: evidence) else { throw WorkspaceError.invalidData }
                try frame.jpeg.write(to: imageURL, options: .atomic)
                var updated = sessions[index]
                updated.evidence.append(evidence)
                do { try store.save(updated) }
                catch {
                    // Only remove the just-created, unreferenced asset on failed commit.
                    try? FileManager.default.removeItem(at: imageURL)
                    throw error
                }
                sessions[index] = updated
                error = nil
            } catch is CancellationError { return }
            catch {
                let message = "采集已停止：\(error.localizedDescription)"
                let stopped = pause(note: message)
                self.error = stopped == nil ? "\(message)\n\(self.error ?? "会话结束未保存。")" : message
                return
            }
        }
    }

    @discardableResult
    func pause(now: Date = Date(), note: String? = nil) -> WorkSession? {
        loop?.cancel()
        loop = nil
        guard let id = activeID, let index = sessions.firstIndex(where: { $0.id == id }) else { return nil }
        // Stop immediately even if the final persistence fails; never keep recording to retry a save.
        activeID = nil
        var updated = sessions[index]
        updated.status = .paused
        updated.endedAt = max(now, updated.evidence.last?.capturedAt ?? updated.startedAt)
        updated.note = note
        do { try store.save(updated); sessions[index] = updated; error = nil; return updated }
        catch {
            // Reflect that recording really stopped, without claiming persistence succeeded.
            updated.note = "采集已停止，会话结束尚未保存。"
            sessions[index] = updated
            self.error = "已停止采集，但会话结束保存失败。重启后会标记为中断：\(error.localizedDescription)"
            return nil
        }
    }

    func setExcluded(sessionID: UUID, evidenceID: UUID, excluded: Bool) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }),
              let item = sessions[index].evidence.firstIndex(where: { $0.id == evidenceID }) else { return }
        var updated = sessions[index]
        updated.evidence[item].excluded = excluded
        do { try store.save(updated); sessions[index] = updated; error = nil }
        catch { self.error = "修改未保存：\(error.localizedDescription)" }
    }

    func trashSession(_ id: UUID) {
        guard activeID != id, !capturing, sessions.contains(where: { $0.id == id }) else { return }
        do {
            // UUID-derived exact session directory, never an arbitrary caller-supplied path.
            try FileManager.default.trashItem(at: store.folder(id), resultingItemURL: nil)
            sessions.removeAll { $0.id == id }
            error = nil
        } catch { self.error = "无法移到废纸篓，原记录未从列表移除：\(error.localizedDescription)" }
    }
}
