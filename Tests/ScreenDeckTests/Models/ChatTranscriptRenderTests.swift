import XCTest
import SwiftUI
import AppKit
@testable import ScreenDeck

final class ChatTranscriptRenderTests: XCTestCase {
    @MainActor
    func testConnectionFormRenderingDoesNotCreateAClientOrConnect() async throws {
        var factoryCalls = 0
        let connection = RuntimeConnectionController(factory: { _, _ in
            factoryCalls += 1
            throw OpenCodeError.invalidEndpoint
        })
        try await render(ChatConnectionView(connection: connection), size: CGSize(width: 430, height: 640))
        XCTAssertEqual(factoryCalls, 0)
        XCTAssertEqual(connection.status, .disconnected)
        XCTAssertNil(connection.report)
        XCTAssertNil(connection.settings)
        XCTAssertFalse(connection.canSend)
    }

    @MainActor
    func testSubmittedChatRendersWithoutInvokingReconciliation() async throws {
        var conversation = makeConversation(state: .streaming)
        let original = conversation
        var reconciliationRequests = 0
        for size in [CGSize(width: 380, height: 560), CGSize(width: 900, height: 700)] {
            try await render(ChatTranscriptView(conversation: conversation, isGenerating: true,
                                                needsReconciliation: false,
                                                onReconcile: { reconciliationRequests += 1 }), size: size)
        }
        XCTAssertEqual(conversation, original)
        XCTAssertEqual(reconciliationRequests, 0)
        conversation.turns[0].state = .unknown
        try await render(ChatTranscriptView(conversation: conversation, isGenerating: false,
                                            needsReconciliation: true,
                                            onReconcile: { reconciliationRequests += 1 }),
                         size: CGSize(width: 380, height: 560))
        XCTAssertEqual(reconciliationRequests, 0, "Rendering a pending turn must not query or resend it")
    }

    @MainActor
    func testFailedAndCancelledTurnsKeepTheirActualStatesAfterRendering() async throws {
        for state in [TurnState.failed, .cancelled] {
            let conversation = makeConversation(state: state)
            try await render(ChatTranscriptView(conversation: conversation, isGenerating: false,
                                                needsReconciliation: false),
                             size: CGSize(width: 380, height: 560))
            XCTAssertEqual(conversation.turns[0].state, state)
        }
    }

    private func makeConversation(state: TurnState) -> Session {
        let turn = Turn(requestedModel: ModelSelection(providerID: "fixture", modelID: "fixture-model"),
                            state: state, failure: state == .failed ? "测试服务未完成回复。" : nil)
        return Session(title: "仅用于原生渲染测试", scope: .localChat(UUID()), turns: [turn], messages: [
            Message(turnID: turn.turnID, role: .user, text: "这是一份临时测试消息，不会发送给模型。"),
            Message(turnID: turn.turnID, role: .assistant, text: String(repeating: "这是测试数据中的已有回复。\n", count: 8))
        ])
    }

    @MainActor
    private func render<V: View>(_ view: V, size: CGSize) async throws {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = host
        defer { window.contentView = nil }
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(50))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        XCTAssertGreaterThan(bitmap.pixelsWide, 0)
        XCTAssertEqual(host.bounds.size, size)
    }
}
