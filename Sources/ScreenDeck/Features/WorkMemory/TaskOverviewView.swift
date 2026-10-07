import SwiftUI

/// Overview of actual local state, visually matching the approved task inspector.
/// No sample conversation, inferred execution state, or fabricated output is shown here.
struct TaskOverviewView: View {
    let task: LocalTask
    var canEditSubtasks: Bool
    var canOpenDeck: Bool
    var onToggleSubtask: (UUID) -> Void
    var onShowAssignment: () -> Void
    var onOpenDeck: () -> Void

    private var summary: TaskProgressSummary { TaskProgressSummary(task: task) }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle("目标")
                Text(task.title)
                    .font(.system(size: 14))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            progress
            checklist

            if summary.hasPlanDraft {
                Button(action: onShowAssignment) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "list.bullet.clipboard")
                        VStack(alignment: .leading, spacing: 4) {
                            Text("另有 \(summary.plannedStepCount) 项分工草稿").fontWeight(.medium)
                            Text("只记录分工意图，不计入完成进度。")
                                .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right").font(.system(size: 10))
                    }.font(.system(size: 12))
                }.buttonStyle(.plain)
                    .accessibilityLabel("查看分工草稿，共 \(summary.plannedStepCount) 项，尚无执行记录")
            }

            VStack(alignment: .leading, spacing: 7) {
                sectionTitle("当前执行")
                Text("Agent 未连接").font(.system(size: 13, weight: .medium))
                Text("自动执行尚未接入，清单由你手动更新。")
                    .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(13)
            .background(WorkbenchStyle.rail, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(WorkbenchStyle.line))

            VStack(alignment: .leading, spacing: 9) {
                sectionTitle("交付物")
                Label("暂无已关联交付物", systemImage: "doc")
                    .font(.system(size: 13)).foregroundStyle(WorkbenchStyle.muted)
                Text("接续材料单独列在下方，不代表已验收成果。")
                    .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            nextAction
        }
    }

    private var progress: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(summary.totalCount == 0 ? "尚未添加步骤" : "已完成 \(summary.completedCount) / \(summary.totalCount) 步骤")
                    .font(.system(size: 13, weight: .semibold)).monospacedDigit()
                Spacer(minLength: 0)
                Text("手动清单").font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
            }
            if summary.usesSegmentedProgress {
                HStack(spacing: 5) {
                    ForEach(0..<summary.totalCount, id: \.self) { index in
                        Capsule()
                            .fill(index < summary.completedCount ? WorkbenchStyle.ink : WorkbenchStyle.inset)
                            .frame(height: 6)
                    }
                }.accessibilityElement(children: .ignore)
                    .accessibilityLabel("手动子任务进度")
                    .accessibilityValue("\(summary.completedCount) 项完成，共 \(summary.totalCount) 项")
            } else if let fraction = summary.fractionCompleted {
                ProgressView(value: fraction)
                    .tint(WorkbenchStyle.ink)
                    .accessibilityLabel("手动子任务进度")
                    .accessibilityValue("\(summary.completedCount) 项完成，共 \(summary.totalCount) 项")
            }
        }
    }

    private var checklist: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                sectionTitle("执行清单")
                Spacer()
                Button("编辑", action: onShowAssignment)
                    .font(.system(size: 12)).buttonStyle(.plain)
                    .accessibilityLabel("在分工页编辑手动清单")
            }
            if summary.steps.isEmpty {
                Button(action: onShowAssignment) {
                    HStack(spacing: 8) {
                        Image(systemName: "plus.circle")
                        Text("添加第一个步骤")
                        Spacer()
                        Image(systemName: "chevron.right").font(.system(size: 10))
                    }.font(.system(size: 13)).padding(13)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain)
                    .disabled(!canEditSubtasks)
                    .background(WorkbenchStyle.surface, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(WorkbenchStyle.line))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(summary.steps.enumerated()), id: \.element.id) { index, step in
                        Button { onToggleSubtask(step.id) } label: {
                            HStack(alignment: .center, spacing: 10) {
                                Image(systemName: step.completed ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 19, weight: .regular)).frame(width: 20)
                                Text(step.title)
                                    .font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text("你").font(.system(size: 11))
                                    .foregroundStyle(WorkbenchStyle.muted)
                                    .padding(.horizontal, 9).padding(.vertical, 4)
                                    .background(WorkbenchStyle.rail, in: Capsule())
                                Text(step.completed ? "已完成" : "待完成")
                                    .font(.system(size: 11)).foregroundStyle(WorkbenchStyle.muted)
                                    .fixedSize()
                            }.padding(.horizontal, 12).padding(.vertical, 11)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .disabled(!canEditSubtasks)
                            .accessibilityLabel("\(step.title)，执行者：你")
                            .accessibilityValue(step.completed ? "已完成，手动标记" : "待完成")
                            .accessibilityHint(canEditSubtasks ? "切换此步骤的完成状态" : "当前不可编辑步骤")
                        if index < summary.totalCount - 1 { Divider().padding(.leading, 42) }
                    }
                }.background(WorkbenchStyle.surface, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(WorkbenchStyle.line))
            }
        }
    }

    private var nextAction: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: task.completed ? "checkmark.circle" : "person")
                .font(.system(size: 19)).padding(.top, 1)
            VStack(alignment: .leading, spacing: 7) {
                Text(task.completed ? "任务已由你标记完成" : "下一步由你推进")
                    .font(.system(size: 13, weight: .semibold))
                if !task.completed {
                    Text(summary.nextStep ?? "在分工中整理步骤，完成后手动勾选。")
                        .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Button("在 Deck 中继续", action: onOpenDeck)
                        .font(.system(size: 12)).buttonStyle(.plain)
                        .disabled(!canOpenDeck)
                } else {
                    Text("子任务保留原有状态；需要继续时可重新打开任务。")
                        .font(.system(size: 12)).foregroundStyle(WorkbenchStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.padding(13)
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(WorkbenchStyle.line))
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(.system(size: 14, weight: .semibold))
    }
}
