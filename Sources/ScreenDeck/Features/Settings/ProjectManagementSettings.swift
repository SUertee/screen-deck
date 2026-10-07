// finesse · component: project-management · register=product · tokens: inherited DeckTheme
import SwiftUI
import AppKit

/// Local project locations and configuration inspection. Neither is execution authorization.
struct ProjectManagementSettings: View {
    @ObservedObject var projects: ProjectWorkspaceController
    @State private var configurationDescriptions: [String: String] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("项目文件只保存身份和共享约定；聊天草稿及本机位置由 ScreenDeck 管理。")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !projects.associationsLoaded {
                Button("读取项目关联") { Task { _ = await projects.load() } }.disabled(projects.isLoading)
            } else if projects.associations.isEmpty {
                Text("还没有关联项目。在工作台侧栏的「项目」旁点击 + 打开文件夹。")
                    .foregroundStyle(.secondary)
            }
            ForEach(projects.associations) { project in
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(project.rootPath).font(.caption).textSelection(.enabled)
                        Text(project.projectID).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        if let diagnostic = projects.diagnostics[project.projectID] {
                            Label(diagnostic, systemImage: "exclamationmark.triangle").font(.callout)
                        }
                        if let description = configurationDescriptions[project.projectID] {
                            Text(description).font(.callout).textSelection(.enabled)
                        }
                        HStack {
                            Button("检查配置") { inspect(project) }
                            Button("打开文件夹") { NSWorkspace.shared.open(project.rootURL) }
                            Spacer()
                            Button("移除关联") { remove(project) }
                        }.disabled(projects.isLoading)
                    }.padding(.top, 12)
                } label: { Label(project.name, systemImage: "folder") }
                .padding(12).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
            }
            if let error = projects.error { Label(error, systemImage: "exclamationmark.triangle") }
            if projects.isLoading { ProgressView("正在读取项目…").controlSize(.small) }
        }
    }

    private func inspect(_ project: ProjectAssociation) {
        do {
            let records = try ProjectRecordReader().read(root: project.rootURL)
            guard records.project.projectID == project.projectID else {
                configurationDescriptions[project.projectID] = "项目身份已变化，请在工作台重新关联文件夹。"
                return
            }
            guard let snapshot = try ConfigurationStore(userFileURL: ScreenDeckPaths().config).loadProject(at: project.rootURL) else {
                configurationDescriptions[project.projectID] = "未设置项目配置。可在 .screendeck/config.toml 声明项目约定。"
                return
            }
            let config = snapshot.configuration
            configurationDescriptions[project.projectID] = [
                "可修改目录：\(config.workspace.editableRoots.isEmpty ? "未声明" : config.workspace.editableRoots.joined(separator: "、"))",
                "保护路径：\(config.workspace.protectedPaths.isEmpty ? "未声明" : config.workspace.protectedPaths.joined(separator: "、"))",
                "忽略路径：\(config.workspace.ignoredPaths.isEmpty ? "未声明" : config.workspace.ignoredPaths.joined(separator: "、"))",
                "测试命令：\(config.validation.testArgv.isEmpty ? "未声明" : config.validation.testArgv.joined(separator: " "))",
                "构建命令：\(config.validation.buildArgv.isEmpty ? "未声明" : config.validation.buildArgv.joined(separator: " "))",
                "正式资料：\(config.documentationDirectory) · 可读日志：\(config.summaryPath)",
                "模型偏好：\(config.model.executor ?? "未声明") · \(config.model.model ?? "未声明") · \(config.model.effort ?? "未声明")（非实际运行记录）",
                "配置有效。以上为约定，不会执行命令或授予权限。"
            ].joined(separator: "\n")
        } catch { configurationDescriptions[project.projectID] = error.localizedDescription }
    }
    private func remove(_ project: ProjectAssociation) {
        let alert = NSAlert()
        alert.messageText = "移除 \(project.name) 的本机关联？"
        alert.informativeText = "项目文件、任务记录和聊天草稿都保留。之后可重新打开文件夹。"
        alert.addButton(withTitle: "移除关联"); alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { _ = projects.removeAssociation(projectID: project.projectID) }
    }
}
