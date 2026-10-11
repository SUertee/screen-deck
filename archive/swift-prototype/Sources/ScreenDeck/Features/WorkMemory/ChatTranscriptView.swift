import SwiftUI

/// Native, read-only presentation of submitted conversation facts.
/// Rendering never connects, sends, restores an external session or changes task state.
@MainActor
struct ChatTranscriptView: View {
    let conversation: Session
    let isGenerating: Bool
    let needsReconciliation: Bool
    var onReconcile: () -> Void = {}
    @State private var followsLatest = true
    private let bottomID = "chat-transcript-bottom"

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 30) {
                        ForEach(conversation.turns) { turn in
                            turnContent(turn)
                        }
                        if needsReconciliation {
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("这轮状态需要核对").fontWeight(.medium)
                                    Text("读取已有消息后再继续，不会重新发送。")
                                        .font(.caption).foregroundStyle(WorkbenchStyle.muted)
                                    Button("核对会话状态", action: onReconcile)
                                        .buttonStyle(.borderless).disabled(isGenerating)
                                }
                                Spacer(minLength: 0)
                            }.padding(14)
                                .background(WorkbenchStyle.rail, in: RoundedRectangle(cornerRadius: 10))
                        }
                        Color.clear.frame(height: 1)
                            .id(bottomID)
                            .background(GeometryReader { bottom in
                                Color.clear.preference(key: ChatTranscriptBottomKey.self,
                                                       value: bottom.frame(in: .named("chat-transcript")).maxY)
                            })
                    }.frame(maxWidth: 760, alignment: .leading)
                        .padding(.horizontal, 24).padding(.vertical, 28)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .coordinateSpace(name: "chat-transcript")
                .onPreferenceChange(ChatTranscriptBottomKey.self) { bottom in
                    followsLatest = bottom <= geometry.size.height + 80
                }
                .onAppear { proxy.scrollTo(bottomID, anchor: .bottom) }
                .onChange(of: conversation.messages.map(\.messageID)) { _, _ in
                    if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
                }
                .onChange(of: conversation.messages.map(\.text)) { _, _ in
                    if followsLatest { proxy.scrollTo(bottomID, anchor: .bottom) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !followsLatest {
                        Button {
                            followsLatest = true
                            proxy.scrollTo(bottomID, anchor: .bottom)
                        } label: {
                            Label("查看最新回复", systemImage: "arrow.down")
                                .font(.caption).padding(.horizontal, 12).padding(.vertical, 8)
                                .background(WorkbenchStyle.surface, in: Capsule())
                                .overlay(Capsule().stroke(WorkbenchStyle.line))
                        }.buttonStyle(.plain).padding(14)
                    }
                }
            }
        }
    }

    private func turnContent(_ turn: Turn) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(conversation.messages.filter { $0.turnID == turn.turnID && $0.role == .user }) { message in
                HStack {
                    Spacer(minLength: 48)
                    Text(message.text).textSelection(.enabled)
                        .lineSpacing(5).padding(.horizontal, 17).padding(.vertical, 13)
                        .background(WorkbenchStyle.inset, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            let response = conversation.messages.filter { $0.turnID == turn.turnID && $0.role == .assistant }
                .map(\.text).joined()
            if !response.isEmpty {
                Text(response).textSelection(.enabled).lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            turnStatus(turn)
        }
    }

    @ViewBuilder private func turnStatus(_ turn: Turn) -> some View {
        switch turn.state {
        case .prepared, .submitting, .streaming, .cancelling:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(statusLabel(turn.state))
            }.font(.caption).foregroundStyle(WorkbenchStyle.muted)
        case .failed:
            Label(turn.failure ?? "这轮回复未完成。", systemImage: "exclamationmark.triangle")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted).textSelection(.enabled)
        case .cancelled:
            Label("已停止", systemImage: "stop.circle")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted)
        case .unknown:
            Label(turn.failure ?? "回复状态尚未确认，不会自动重发。", systemImage: "exclamationmark.circle")
                .font(.caption).foregroundStyle(WorkbenchStyle.muted).textSelection(.enabled)
        case .finished:
            EmptyView()
        }
    }

    private func statusLabel(_ state: TurnState) -> String {
        switch state {
        case .prepared: return "正在准备这轮消息…"
        case .submitting: return "正在提交…"
        case .streaming: return "正在回复…"
        case .cancelling: return "正在停止，等待服务确认…"
        default: return ""
        }
    }
}

private struct ChatTranscriptBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
