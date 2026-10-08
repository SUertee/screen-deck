import SwiftUI
import AppKit

/// Explicit connection form. Passwords stay in memory and are cleared when the form closes.
@MainActor
struct ChatConnectionView: View {
    @ObservedObject var connection: RuntimeConnectionController
    @State private var endpointText: String
    @State private var directoryText: String
    @State private var username: String
    @State private var password = ""
    @State private var formError: String?

    init(connection: RuntimeConnectionController) {
        self.connection = connection
        _endpointText = State(initialValue: connection.settings?.endpoint.absoluteString ?? "http://127.0.0.1:4096")
        _directoryText = State(initialValue: connection.settings?.directory ?? "")
        _username = State(initialValue: connection.settings?.username ?? "opencode")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("连接 OpenCode").font(.headline)
                Spacer()
                if connection.status == .connecting { ProgressView().controlSize(.small) }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("服务地址").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                TextField("http://127.0.0.1:4096", text: $endpointText)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("OpenCode 回环服务地址")
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("运行时专用目录").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                HStack {
                    TextField("选择隔离目录，不默认使用项目文件夹", text: $directoryText)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("OpenCode 运行时专用目录")
                    Button("选择…", action: chooseDirectory).buttonStyle(.borderless)
                }
            }
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("用户名").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                    TextField("opencode", text: $username).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("OpenCode 服务用户名")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("服务密码").font(.caption).foregroundStyle(WorkbenchStyle.muted)
                    SecureField("仅本次连接使用", text: $password).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("OpenCode 服务密码")
                }
            }
            if let report = connection.report {
                HStack {
                    Text("OpenCode \(report.version)")
                    Spacer()
                    Text(connection.canSend ? "可聊天" : "仅诊断")
                }.font(.caption).foregroundStyle(WorkbenchStyle.muted)
                Label(report.safety.diagnostic,
                      systemImage: report.safety.canSend ? "checkmark.shield" : "exclamationmark.shield")
                    .font(.caption).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if let error = formError ?? connection.error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            Text("服务在本机不代表模型在本机。发送时，消息会交给你选择的模型提供商。")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                if connection.status == .connected {
                    Button("断开连接") { connection.disconnect(); password = "" }
                        .buttonStyle(.borderless)
                }
                Spacer()
                Button(connection.status == .connecting ? "正在连接…" : "连接", action: connect)
                    .buttonStyle(.borderedProminent)
                    .disabled(connection.status == .connecting || directoryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(20).frame(width: 390)
            .foregroundStyle(WorkbenchStyle.ink).tint(WorkbenchStyle.ink)
            .onDisappear { password = "" }
    }

    private func connect() {
        formError = nil
        guard let endpoint = URL(string: endpointText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            formError = "请输入有效的回环服务地址。"; return
        }
        let settings = OpenCodeConnectionSettings(endpoint: endpoint,
                                                   directory: directoryText.trimmingCharacters(in: .whitespacesAndNewlines),
                                                   username: username.trimmingCharacters(in: .whitespacesAndNewlines))
        let connectionPassword = password
        Task { @MainActor in
            await connection.connect(settings: settings, password: connectionPassword)
            password = ""
        }
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = "选择 OpenCode 运行时专用目录"
        panel.message = "这个目录用于隔离聊天运行时，不会初始化项目或执行模型请求。"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let directory = panel.url { directoryText = directory.path }
    }
}
