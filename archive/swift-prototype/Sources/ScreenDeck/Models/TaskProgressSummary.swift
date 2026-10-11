import Foundation

/// A read-only projection of persisted manual checklist state.
/// A plan describes intent; neither it nor the parent completion flag is execution evidence.
struct TaskProgressSummary: Equatable {
    struct Step: Identifiable, Equatable {
        let id: UUID
        let title: String
        let completed: Bool
    }

    let steps: [Step]
    let plannedStepCount: Int
    let nextStep: String?

    init(task: LocalTask) {
        steps = (task.subtasks ?? []).map {
            Step(id: $0.id, title: $0.title, completed: $0.completed)
        }
        plannedStepCount = task.executionPlan?.steps.count ?? 0
        let storedNextStep = task.latestResume?.content.nextStep
        nextStep = storedNextStep.flatMap { value in
            value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
        }
    }

    var totalCount: Int { steps.count }
    var completedCount: Int { steps.filter(\.completed).count }
    var hasPlanDraft: Bool { plannedStepCount > 0 }
    var fractionCompleted: Double? {
        totalCount > 0 ? Double(completedCount) / Double(totalCount) : nil
    }
    /// One segment per step remains legible for a small checklist. Larger lists use a bar.
    var usesSegmentedProgress: Bool { (1...8).contains(totalCount) }
}
