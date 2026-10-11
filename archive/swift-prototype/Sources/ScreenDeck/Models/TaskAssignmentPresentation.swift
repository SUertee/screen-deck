import Foundation

/// Read-only display data. Assignment intent is kept separate from manual execution facts.
struct TaskAssignmentPresentation: Equatable {
    struct PlannedRow: Identifiable, Equatable {
        let id: UUID
        let title: String
        let executorLabel: String
        let acceptance: String
        let dependencyLabels: [String]

        // PlannedStep has no approval or execution state. Never infer one from a task
        // completion flag, a same-named checklist item, or the assigned executor.
        var statusLabel: String { "待确认" }
    }

    struct ManualRow: Identifiable, Equatable {
        let id: UUID
        let title: String
        let completed: Bool

        var statusLabel: String { completed ? "已完成" : "待完成" }
    }

    let planVersion: Int?
    let plannedSteps: [PlannedRow]
    let manualSteps: [ManualRow]

    init(task: LocalTask) {
        let planSteps = task.executionPlan?.steps ?? []
        planVersion = task.executionPlan?.version
        plannedSteps = planSteps.map { step in
            PlannedRow(id: step.id, title: step.title,
                       executorLabel: step.executor == .human ? "你" : "Agent",
                       acceptance: step.acceptance,
                       dependencyLabels: step.dependencies.map { dependencyID in
                           guard let index = planSteps.firstIndex(where: { $0.id == dependencyID }) else {
                               return "依赖步骤不可用"
                           }
                           // Position disambiguates repeated titles without exposing internal IDs.
                           return "步骤 \(index + 1) · \(planSteps[index].title)"
                       })
        }
        manualSteps = (task.subtasks ?? []).map {
            ManualRow(id: $0.id, title: $0.title, completed: $0.completed)
        }
    }
}
