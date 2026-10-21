import { createHash } from 'node:crypto';
import type { DecisionContext, DecisionRecommendation } from '../../../shared/types.js';
import type { DecisionProvider } from '../decision-engine.js';
import { isUUID, validateModel } from '../../sessions/session-schema.js';

/** This module contains no HTTP client, credentials, persistence, or execution hooks. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export type JevAdviceErrorCode = 'invalid-input' | 'unavailable' | 'budget-unconfirmed' | 'cancelled' | 'timeout' | 'transport-failed' | 'invalid-response' | 'stale-draft';
export class JevAdviceError extends Error {
  constructor(readonly code: JevAdviceErrorCode, readonly delivery: 'not-sent' | 'unknown' | 'received' = 'not-sent') {
    super(`Jev advice: ${code}`); this.name = 'JevAdviceError';
  }
}
export interface JevChoiceRequest {
  model: string;
  state: { title: string; kind: string; expected_result: string; risk: string; capabilities: string[] };
  questions: { assignee: { type: 'choice'; instructions: string; criteria: { human: string; chat: string } } };
}
/** Trusted main-process injection seam, NOT a renderer-facing remote API. No implementation ships here. */
export interface JevTransport {
  readonly provenance: 'test-fixture' | 'typesafe-api';
  systemOne(request: JevChoiceRequest, options: { signal: AbortSignal }): Promise<unknown>;
}
export interface JevAdviceDraft extends DecisionRecommendation {
  source: { provider: 'jev'; transport: JevTransport['provenance']; endpoint: typeof JEV_ENDPOINT; requestedModel: string; reportedModel: string };
  base: { planID: string; planVersion: number; workItemID: string; contextDigest: string };
  evidence: { choice: 'human' | 'chat'; confidence: number; probabilities: { human: number; chat: number }; usage: { input_tokens: number; output_tokens: number } };
  reasonSource: 'application-explanation';
  /** Intent only. A chat assignment still needs an explicitly selected model at save time. */
  candidateChanges: Array<{ kind: 'suggest-assignee'; workItemID: string; candidate: 'human' | 'chat' }>;
  requiresConfirmation: true;
}
interface Options { planID: string; model: string; minimumConfidence: number; timeoutMs: number; transport?: JevTransport }
const fail = (code: JevAdviceErrorCode, delivery: JevAdviceError['delivery'] = 'not-sent'): never => { throw new JevAdviceError(code, delivery); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function keys(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!record(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail('invalid-input');
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const probability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function validateContext(v: unknown): asserts v is DecisionContext {
  keys(v, ['planVersion', 'workItem', 'risk', 'capabilities'], ['budgetAvailable']);
  if (!Number.isSafeInteger(v.planVersion) || (v.planVersion as number) < 1 || !['low', 'medium', 'high'].includes(v.risk as string) || v.budgetAvailable !== undefined && typeof v.budgetAvailable !== 'boolean' || !Array.isArray(v.capabilities) || v.capabilities.length > 64 || !v.capabilities.every(c => text(c, 100)) || new Set(v.capabilities).size !== v.capabilities.length) fail('invalid-input');
  const w = v.workItem;
  keys(w, ['id', 'title', 'kind', 'assignee', 'expected_result', 'dependencies', 'status'], ['agentID', 'model']);
  if (!isUUID(w.id) || !text(w.title, 600) || !['discussion', 'implementation', 'validation'].includes(w.kind as string) || !['human', 'chat', 'unassigned', 'agent'].includes(w.assignee as string) || typeof w.expected_result !== 'string' || w.expected_result.length > 4096 || !['planned', 'completed'].includes(w.status as string) || !Array.isArray(w.dependencies) || w.dependencies.length > 1000 || !w.dependencies.every(d => isUUID(d) && d !== w.id) || new Set(w.dependencies).size !== w.dependencies.length) fail('invalid-input');
  if (w.assignee === 'agent' ? typeof w.agentID !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(w.agentID) : w.agentID !== undefined) fail('invalid-input');
  if (w.assignee === 'chat' && (w.kind !== 'discussion' || w.model === undefined)) fail('invalid-input');
  if (w.model !== undefined) {
    if (w.assignee !== 'chat' && w.assignee !== 'agent') fail('invalid-input');
    try { validateModel(w.model); } catch { fail('invalid-input'); }
  }
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (record(v)) return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const digest = (context: DecisionContext) => createHash('sha256').update(canonical(context)).digest('hex');

/** Exact subset of the official Choice response used by this adapter, not a full SDK schema. */
export function validateJevChoiceResponse(value: unknown): JevAdviceDraft['evidence'] & { model: string } {
  try {
    keys(value, ['model', 'answers', 'usage']);
    if (!text(value.model, 100) || !/^jev-[a-zA-Z0-9.-]+$/.test(value.model)) fail('invalid-input');
    keys(value.answers, ['assignee']); const answer = value.answers.assignee;
    keys(answer, ['type', 'choice', 'confidence', 'probabilities']);
    keys(answer.probabilities, ['human', 'chat']); const p = answer.probabilities;
    if (answer.type !== 'choice' || !['human', 'chat'].includes(answer.choice as string) || !probability(answer.confidence) || !probability(p.human) || !probability(p.chat) || Math.abs(p.human + p.chat - 1) > 0.000001 || (p[answer.choice as string] as number) < Math.max(p.human, p.chat)) fail('invalid-input');
    keys(value.usage, ['input_tokens', 'output_tokens']);
    if (!counter(value.usage.input_tokens) || !counter(value.usage.output_tokens)) fail('invalid-input');
    return structuredClone({ model: value.model as string, choice: answer.choice as 'human' | 'chat', confidence: answer.confidence as number, probabilities: { human: p.human as number, chat: p.chat as number }, usage: { input_tokens: value.usage.input_tokens as number, output_tokens: value.usage.output_tokens as number } });
  } catch { return fail('invalid-response', 'received'); }
}

/** Plan-scoped provider. The default application still uses RuleDecisionProvider. */
export class JevDecisionProvider implements DecisionProvider {
  private readonly options: Options;
  constructor(options: Options) {
    keys(options, ['planID', 'model', 'minimumConfidence', 'timeoutMs'], ['transport']);
    if (!isUUID(options.planID) || !text(options.model, 100) || !/^jev-[a-zA-Z0-9.-]+$/.test(options.model) || !probability(options.minimumConfidence) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000 || options.transport !== undefined && (!['test-fixture', 'typesafe-api'].includes(options.transport.provenance) || typeof options.transport.systemOne !== 'function')) fail('invalid-input');
    this.options = { ...options, transport: options.transport && { provenance: options.transport.provenance, systemOne: options.transport.systemOne.bind(options.transport) } };
  }
  async recommend(context: DecisionContext, signal?: AbortSignal): Promise<JevAdviceDraft> {
    validateContext(context);
    const frozen = structuredClone(context); const options = this.options; const transport = options.transport;
    if (signal?.aborted) fail('cancelled');
    if (!transport) return fail('unavailable');
    if (frozen.budgetAvailable !== true) fail('budget-unconfirmed');
    const controller = new AbortController();
    const request: JevChoiceRequest = {
      model: options.model,
      state: { title: frozen.workItem.title, kind: frozen.workItem.kind, expected_result: frozen.workItem.expected_result, risk: frozen.risk, capabilities: [...frozen.capabilities] },
      questions: { assignee: { type: 'choice', instructions: 'Which proposed handling mode fits this work item? This is advice only, never authorization.', criteria: { human: 'Human review or work; choose for uncertainty, non-low risk, implementation, validation, or unavailable chat capability.', chat: 'Low-risk discussion that can be handled by stateless text chat, without tools or execution.' } } },
    };
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
    try {
      // Race even an uncooperative transport. Late results are ignored; no implicit retry or fallback.
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(new JevAdviceError('cancelled', sent ? 'unknown' : 'not-sent')); };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new JevAdviceError('timeout', sent ? 'unknown' : 'not-sent')); }, options.timeoutMs);
      });
      const raw = await Promise.race([interrupted, Promise.resolve().then(() => {
        if (controller.signal.aborted) return fail('cancelled');
        sent = true;
        return transport.systemOne(structuredClone(request), { signal: controller.signal });
      })]);
      if (signal?.aborted) fail('cancelled', 'unknown');
      const result = validateJevChoiceResponse(raw);
      // A pinned version must not be silently replaced; aliases may resolve to a versioned ID.
      if (/^jev-\d/.test(options.model) && result.model !== options.model) fail('invalid-response', 'received');
      const policyReview = result.confidence < options.minimumConfidence || frozen.risk !== 'low' || frozen.workItem.kind !== 'discussion' || !frozen.capabilities.includes('stateless-chat');
      const candidate = policyReview ? 'human' : result.choice;
      const { model, ...evidence } = result;
      return {
        candidate, reasons: [policyReview ? '应用策略要求人工核对：置信度、风险、工作类型或可用能力未满足建议条件。' : `Jev 在固定候选中选择了 ${candidate}；此说明由应用生成，并非模型推理过程。`], advisory: true,
        source: { provider: 'jev', transport: transport.provenance, endpoint: JEV_ENDPOINT, requestedModel: options.model, reportedModel: model },
        base: { planID: options.planID, planVersion: frozen.planVersion, workItemID: frozen.workItem.id, contextDigest: digest(frozen) },
        evidence, reasonSource: 'application-explanation',
        candidateChanges: [{ kind: 'suggest-assignee', workItemID: frozen.workItem.id, candidate }], requiresConfirmation: true,
      };
    } catch (error) {
      if (error instanceof JevAdviceError) throw error;
      // Do not surface arbitrary HTTP error bodies, credentials, input echoes, or provider messages.
      throw new JevAdviceError('transport-failed', 'unknown');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
}

/** Call again on the current saved snapshot before presenting an explicit save command. Does not save. */
export function assertJevDraftCurrent(draft: JevAdviceDraft, planID: string, context: DecisionContext): void {
  validateContext(context);
  if (!draft || draft.base?.planID !== planID || draft.base.planVersion !== context.planVersion || draft.base.workItemID !== context.workItem.id || draft.base.contextDigest !== digest(context)) fail('stale-draft');
}
