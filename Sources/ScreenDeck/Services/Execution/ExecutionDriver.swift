import Foundation

/// Execution port only: no local history, task policy, approval authority, or process ownership.
/// Implementations must reject unavailable capabilities; construction performs no I/O.
protocol ExecutionDriver: Sendable {
    /// Diagnose the explicitly selected connection. A successful report does not authorize sending.
    func connect() async throws -> RuntimeConnectionReport
    func createSession(title: String) async throws -> RuntimeSession
    func session(sessionID: String) async throws -> RuntimeSession
    /// One submission attempt. An unknown outcome must be reconciled, never automatically retried.
    func sendMessage(sessionID: String, clientRequestID: String, text: String, model: ModelSelection) async throws -> RuntimeSubmissionReceipt
    func messages(sessionID: String) async throws -> [RuntimeMessage]
    func status(sessionID: String) async throws -> RuntimeSessionStatus
    /// Requests a stop; callers must query state before recording cancellation.
    func abort(sessionID: String) async throws
    /// Denial only. This contract cannot grant tool permissions.
    func rejectPermission(sessionID: String, requestID: String) async throws
    /// Returns after subscription establishment and response validation, before submission.
    /// Setup failure throws without submitting; cancellation releases setup and stream resources.
    /// Readiness is not a replay or exactly-once delivery guarantee.
    func events(sessionID: String) async throws -> AsyncThrowingStream<RuntimeStreamEvent, Error>
}
