import Foundation
import Combine

/// Deck 抽屉状态：收起（=刘海本身）→ 探出（抽屉拉开一条缝）→ 展开（完整面板）
enum DeckState: Equatable {
    case collapsed
    case peeked
    case expanded
}

/// 全局状态：直读 Obsidian vault 的任务数据，驱动 Deck 面板渲染
@MainActor
final class AppState: ObservableObject {
    @Published var tasks: [TaskItem] = []
    @Published var total = 0
    @Published var done = 0
    @Published var sectionTitle = "今日任务"
    @Published var statusMessage = "读取中…"
    @Published var deckState: DeckState = .collapsed

    @Published private(set) var dataAvailable = false

    private let vault: VaultService
    private var timer: Timer?

    init(vault: VaultService? = nil) {
        let envSection = ProcessInfo.processInfo.environment["SCREENDECK_TASK_SECTION"]
        let section = (envSection?.isEmpty == false) ? envSection : "今日主要任务"
        self.vault = vault ?? VaultService(
            vaultPath: ProcessInfo.processInfo.environment["SCREENDECK_VAULT"],
            taskSection: section
        )
    }

    func startPolling() {
        guard timer == nil else { return }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refresh()
            }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    /// 直读今日日记（无 HTTP，文件 IO 很快）
    func refresh() {
        do {
            apply(try vault.fetchTasks())
        } catch {
            dataAvailable = false
            statusMessage = "读取失败：\(error.localizedDescription)"
        }
    }

    /// 勾选/取消任务，直接改写日记文件
    func toggle(_ task: TaskItem) {
        do {
            apply(try vault.toggleTask(line: task.line))
        } catch {
            statusMessage = "切换失败：\(error.localizedDescription)"
        }
    }

    private func apply(_ payload: TasksPayload) {
        dataAvailable = payload.available == true
        tasks = payload.tasks ?? []
        total = payload.total ?? tasks.count
        done = payload.done ?? 0
        if let section = payload.section, !section.isEmpty {
            sectionTitle = section
        }
        if !dataAvailable {
            statusMessage = payload.error ?? "暂无任务数据"
        } else if total == 0 {
            statusMessage = "今天没有任务 🎉"
        }
    }
}
