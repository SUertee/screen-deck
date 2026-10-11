// Native controls preserve focus/disabled behavior; plan disclosure never authorizes execution.
import SwiftUI

struct TaskAssignmentView: View {
    let task: LocalTask
    var canEdit: Bool
    @Binding var childDraft: String
    var onAdd: () -> Void
    var onToggle: (UUID) -> Void
    var onDiscuss: (() -> Void)? = nil
    @State private var disclosure = TaskAssignmentDisclosure()

    private var presentation: TaskAssignmentPresentation { TaskAssignmentPresentation(task: task) }
    private var editingAllowed: Bool { canEdit && !task.completed }
    private var addingAllowed: Bool {
        editingAllowed && !childDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text("工作安排").font(.system(size: 16, weight: .semibold))
                Spacer(minLength: 0)
                if let onDiscuss {
                    Button(action: onDiscuss) {
                        Label("对话调整", systemImage: "bubble.left")
                            .font(.system(size: 12))
                    }.buttonStyle(.borderless).disabled(!editingAllowed)
                        .accessibilityHint("回到对话补充分工要求，不会保存或执行计划")
                }
            }
            if !presentation.plannedSteps.isEmpty {
                plannedSteps
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    Label("尚未保存分工计划", systemImage: "list.bullet")
                        .font(.system(size: 13))
                    Text("可以先整理手动事项。暂无模型分配或执行记录。")
                        .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            manualSteps
        }
        .onChange(of: task.id) { _, _ in disclosure.collapse() }
        .onChange(of: presentation.plannedSteps.map(\.id)) { _, ids in
            disclosure.retainIfAvailable(in: ids)
        }
    }

    private var plannedSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("计划草案 · 待确认")
                .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
            VStack(spacing: 0) {
                ForEach(presentation.plannedSteps) { step in
                    planRow(step)
                    Divider().padding(.leading, 26)
                }
            }
            Label("确认或保存分工不代表开始执行。", systemImage: "info.circle")
                .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func planRow(_ step: TaskAssignmentPresentation.PlannedRow) -> some View {
        let expanded = disclosure.expandedStepID == step.id
        return VStack(alignment: .leading, spacing: 0) {
            Button { disclosure.toggle(step.id) } label: {
                HStack(alignment: .center, spacing: 8) {
                    Image(systemName: step.executorLabel == "你" ? "person" : "cpu")
                        .font(.system(size: 16, weight: .regular)).frame(width: 18)
                    Text(step.title).font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(step.executorLabel).font(.system(size: 11))
                        .foregroundStyle(WorkbenchStyle.muted).frame(width: 36)
                    Text(step.statusLabel).font(.system(size: 11))
                        .foregroundStyle(WorkbenchStyle.muted).fixedSize()
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(WorkbenchStyle.muted).frame(width: 10)
                }
                .padding(.vertical, 15).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(step.title)
            .accessibilityLabel("\(step.title)，计划执行者：\(step.executorLabel)")
            .accessibilityValue("计划草案，\(step.statusLabel)，\(expanded ? "已展开" : "已收起")")
            .accessibilityHint("展开或收起此工作的分配详情，不会启动执行")

            if expanded {
                VStack(alignment: .leading, spacing: 13) {
                    detailRow("理由", value: "尚未记录分配理由", unavailable: true)
                    detailRow("依赖", value: step.dependencyLabels.isEmpty ? "无前置依赖" : step.dependencyLabels.joined(separator: "\n"))
                    // The stored acceptance criteria are not an assigned work item,
                    // expected output, model choice, or evidence of successful execution.
                    detailRow("验收", value: step.acceptance)
                    detailRow("建议", value: "暂无已保存建议", unavailable: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 26).padding(.top, 2).padding(.bottom, 18)
            }
        }
    }

    private func detailRow(_ title: String, value: String, unavailable: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(title).foregroundStyle(WorkbenchStyle.muted).frame(width: 30, alignment: .leading)
            Text(value)
                .foregroundStyle(unavailable ? WorkbenchStyle.muted : WorkbenchStyle.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }.font(.system(size: 12))
    }

    private var manualSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("手动清单").font(.system(size: 14, weight: .semibold))
                Spacer(minLength: 0)
                if !presentation.manualSteps.isEmpty {
                    Text("\(presentation.manualSteps.filter(\.completed).count) / \(presentation.manualSteps.count) 已完成")
                        .font(.system(size: 11)).monospacedDigit().foregroundStyle(WorkbenchStyle.muted)
                }
            }

            if presentation.manualSteps.isEmpty {
                Text(presentation.plannedSteps.isEmpty ? "还没有步骤，先写下一件要做的事。" : "需要手动跟进的事项，可以添加到这里。")
                    .font(.system(size: 13)).foregroundStyle(WorkbenchStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 0) {
                    ForEach(presentation.manualSteps) { step in
                        Button {
                            guard editingAllowed else { return }
                            onToggle(step.id)
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: step.completed ? "checkmark.square" : "square")
                                    .font(.system(size: 16)).frame(width: 18)
                                Text(step.title).font(.system(size: 13))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text("你").font(.system(size: 11))
                                    .foregroundStyle(WorkbenchStyle.muted).frame(width: 36)
                                Text(step.statusLabel).font(.system(size: 11))
                                    .foregroundStyle(WorkbenchStyle.muted).fixedSize()
                            }.padding(.vertical, 12).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!editingAllowed)
                        .accessibilityLabel("\(step.title)，执行者：你")
                        .accessibilityValue("\(step.statusLabel)，手动清单")
                        .accessibilityHint(editingAllowed ? "切换完成状态，不会更改计划步骤" : "当前不可编辑")
                        Divider().padding(.leading, 26)
                    }
                }
            }

            HStack(spacing: 8) {
                TextField("添加一个步骤…", text: $childDraft)
                    .textFieldStyle(.plain).font(.system(size: 13))
                    .accessibilityLabel("新的手动步骤")
                    .onSubmit(addIfAllowed)
                Button(action: addIfAllowed) {
                    Image(systemName: "plus").font(.system(size: 14))
                        .frame(width: 28, height: 28)
                }.buttonStyle(.borderless).disabled(!addingAllowed)
                    .accessibilityLabel("添加手动步骤")
            }
            .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 4)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkbenchStyle.line))
            .disabled(!editingAllowed)

            if task.completed {
                Text("任务已完成，重新打开后可修改清单。")
                    .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
            } else if !childDraft.isEmpty {
                Text("尚未添加；按回车或 + 保存。")
                    .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
            }
        }
    }

    private func addIfAllowed() {
        guard addingAllowed else { return }
        // The caller clears its draft only after storage confirms success.
        onAdd()
    }
}

/// Local disclosure state only; it is neither a persisted plan nor an execution state.
struct TaskAssignmentDisclosure: Equatable {
    private(set) var expandedStepID: UUID?

    mutating func toggle(_ id: UUID) {
        expandedStepID = expandedStepID == id ? nil : id
    }

    mutating func collapse() { expandedStepID = nil }

    mutating func retainIfAvailable(in ids: [UUID]) {
        if let expandedStepID, !ids.contains(expandedStepID) { collapse() }
    }
}
