import Foundation

/// Persisted planning data only. A valid plan is not permission to execute it.
struct ExecutionPlan: Codable, Equatable {
    var version: Int
    var steps: [PlannedStep]

    func validate() throws {
        guard version > 0, !steps.isEmpty else { throw PlanError.invalidPlan }
        let ids = Set(steps.map(\.id))
        guard ids.count == steps.count else { throw PlanError.invalidPlan }
        for step in steps {
            guard !step.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !step.acceptance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  Set(step.dependencies).count == step.dependencies.count,
                  !step.dependencies.contains(step.id),
                  step.dependencies.allSatisfy({ ids.contains($0) })
            else { throw PlanError.invalidPlan }
        }
        // Kahn's algorithm avoids recursive traversal of user/model-provided plans.
        var remaining = Dictionary(uniqueKeysWithValues: steps.map { ($0.id, $0.dependencies.count) })
        var dependents: [UUID: [UUID]] = [:]
        for step in steps {
            for dependency in step.dependencies {
                dependents[dependency, default: []].append(step.id)
            }
        }
        var ready = steps.filter { $0.dependencies.isEmpty }.map(\.id)
        var index = 0
        while index < ready.count {
            let id = ready[index]
            index += 1
            for dependent in dependents[id] ?? [] {
                remaining[dependent, default: 0] -= 1
                if remaining[dependent] == 0 { ready.append(dependent) }
            }
        }
        guard ready.count == steps.count else { throw PlanError.cyclicDependencies }
    }
}

struct PlannedStep: Codable, Identifiable, Equatable {
    var id = UUID()
    var title: String
    var executor: PlannedExecutor
    var acceptance: String
    var dependencies: [UUID] = []
}

/// Assignment intent, not a selected tool, supported capability or execution grant.
enum PlannedExecutor: String, Codable {
    case human, agent
}

enum PlanError: LocalizedError {
    case invalidPlan, cyclicDependencies

    var errorDescription: String? {
        switch self {
        case .invalidPlan: return "计划不完整：请检查版本、步骤、验收条件和依赖。"
        case .cyclicDependencies: return "步骤存在循环依赖，请调整执行顺序。"
        }
    }
}
