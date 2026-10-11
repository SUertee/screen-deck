import SwiftUI
import AppKit

struct ResumeEditorView: View {
    @ObservedObject var state: AppState
    let task: LocalTask
    let onClose: () -> Void
    @State private var progress: String
    @State private var nextStep: String
    @State private var materials: String
    @State private var requestID = UUID()
    @State private var confirmDiscard = false

    init(state: AppState, task: LocalTask, onClose: @escaping () -> Void) {
        self.state = state
        self.task = task
        self.onClose = onClose
        let content = task.latestResume?.content ?? ResumeContent()
        _progress = State(initialValue: content.progress)
        _nextStep = State(initialValue: content.nextStep)
        _materials = State(initialValue: content.materials.joined(separator: "\n"))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(task.title).font(.headline)
            Text("编辑中 · 尚未暂存").font(.caption).foregroundStyle(.secondary)
            field("上次做到哪", placeholder: "例如：已整理产品 A 的功能", text: $progress)
            field("下一步", placeholder: "例如：核实产品 B 的免费版限制", text: $nextStep)
            field("相关材料 · 每行一个网页链接", placeholder: "https://…", text: $materials)
            HStack {
                Button("取消") { confirmDiscard = true }
                Spacer()
                Button("暂存") {
                    let content = ResumeContent(progress: progress, nextStep: nextStep,
                                                materials: materials.components(separatedBy: .newlines))
                    if state.saveResume(taskID: task.id, content: content, requestID: requestID) { onClose() }
                }.buttonStyle(.borderedProminent)
            }
            Text("仅点击暂存后写入本地；未暂存输入不会在重启后恢复。")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .confirmationDialog("放弃未暂存的修改？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive, action: onClose)
            Button("继续编辑", role: .cancel) {}
        }
    }

    private func field(_ title: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(placeholder, text: text, axis: .vertical)
                .lineLimit(2...5).textFieldStyle(.roundedBorder).accessibilityLabel(title)
        }
    }
}

struct ResumeCardView: View {
    @ObservedObject var state: AppState
    let task: LocalTask
    let onEdit: () -> Void
    @State private var continued = false
    @State private var openError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let record = task.latestResume {
                if !record.content.progress.isEmpty {
                    Text("上次做到这里").font(.caption).foregroundStyle(.secondary)
                    Text(record.content.progress).font(.system(size: 12)).textSelection(.enabled)
                }
                if !record.content.nextStep.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("下一步").font(.caption).foregroundStyle(.secondary)
                        Text(record.content.nextStep).font(.system(size: 13, weight: .medium)).foregroundStyle(DeckTheme.accent)
                            .textSelection(.enabled)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                }
                ForEach(Array(record.content.materials.enumerated()), id: \.offset) { _, value in
                    Button {
                        guard let url = ResumeContent.materialURL(value) else {
                            openError = "无法打开此材料地址。"; return
                        }
                        openError = NSWorkspace.shared.open(url) ? nil : "打开失败，请检查默认浏览器后重试。"
                    } label: {
                        Label(value, systemImage: "arrow.up.right").font(.caption).lineLimit(2)
                    }.help(value)
                }
                Text("已暂存 \(record.savedAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption2).foregroundStyle(.secondary)
                HStack {
                    Button("更新进度", action: onEdit)
                    Spacer()
                    Button("接着做") { continued = state.resumeTask(id: task.id) }
                }
                if continued {
                    Text("已继续当前任务，可点击材料接着工作。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Button("记录进度并暂存", action: onEdit)
            }
            if let openError { Text(openError).font(.caption).foregroundStyle(.orange) }
        }
        .buttonStyle(.borderless)
        .onChange(of: task.latestResume?.id) { _, _ in continued = false; openError = nil }
    }
}
