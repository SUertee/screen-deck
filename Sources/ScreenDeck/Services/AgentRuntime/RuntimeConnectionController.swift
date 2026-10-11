import Foundation
import Combine

enum RuntimeConnectionState: Equatable { case disconnected, connecting, connected, failed }

/// Connecting inspects a local service. It never launches a process or submits a prompt.
@MainActor
final class RuntimeConnectionController: ObservableObject {
    typealias ClientFactory = (OpenCodeConnectionSettings, String) throws -> any ExecutionDriver
    @Published private(set) var status: RuntimeConnectionState = .disconnected
    @Published private(set) var report: RuntimeConnectionReport?
    @Published private(set) var settings: OpenCodeConnectionSettings?
    @Published private(set) var error: String?
    private(set) var generation = UUID()
    private(set) var client: (any ExecutionDriver)?
    var permitsChange: () -> Bool = { true }
    var onReset: () -> Void = {}
    private let factory: ClientFactory
    var providers: [LLMProviderConfig] { report?.providers ?? [] }
    var canSend: Bool { status == .connected && report?.safety.canSend == true && client != nil }

    init(factory: @escaping ClientFactory = { settings, password in
        try OpenCodeClient(settings: settings, password: password)
    }) { self.factory = factory }

    func connect(settings: OpenCodeConnectionSettings, password: String) async {
        guard permitsChange(), status != .connecting else {
            error = "请先停止或核对当前回复，再更换连接。"; return
        }
        generation = UUID()
        onReset()
        let attempt = generation
        self.settings = nil; report = nil; client = nil; error = nil; status = .connecting
        do {
            let candidate = try factory(settings, password)
            let inspected = try await candidate.connect()
            guard generation == attempt else { return }
            self.settings = settings; self.report = inspected; self.client = candidate; status = .connected
        } catch {
            guard generation == attempt else { return }
            // Never display arbitrary transport bodies: they can contain secrets or provider content.
            self.error = (error as? OpenCodeError)?.localizedDescription ?? "连接未完成，请检查本机服务与认证。"
            status = .failed
        }
    }

    func disconnect() {
        guard permitsChange() else { error = "当前回复仍在核对中，不能更换连接。"; return }
        generation = UUID(); client = nil; settings = nil; report = nil; error = nil; status = .disconnected
        onReset()
    }
}
