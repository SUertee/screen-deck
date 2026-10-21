import { canonicalDigest } from '../core/storage/execution-records.js';
import { ChatCompletionsAdapter } from '../core/providers/chat-completions-adapter.js';
import { ExecutionError } from '../core/sessions/execution-driver.js';
import { randomUUID } from 'node:crypto';
import type { PlanningModel } from '../core/tasks/task-planning-contract.js';
import type { ProviderSettingsStore } from './provider-settings.js';
/** Uses only the current configured generative service. Capture never sends; generate sends once. */
export class ConfiguredTaskPlanningModel implements PlanningModel {
  constructor(private settings: Pick<ProviderSettingsStore, 'prepareRequest' | 'generation'>, private fetch?: typeof globalThis.fetch) {}
  async capture(): ReturnType<PlanningModel['capture']> {
    const snapshot = await this.settings.prepareRequest();
    const model = { provider_id: 'configured-task-planner', model_id: snapshot.modelID };
    const source = { kind: 'chat-completions' as const, requestedModel: model, configDigest: canonicalDigest({ generation: this.settings.generation, baseURL: snapshot.baseURL, modelID: snapshot.modelID }) };
    let used = false;
    return { source, generate: async (prompt, signal) => {
      if (used) throw new ExecutionError('configuration', '该规划提交已使用，未重发。', false); used = true;
      let text = '', complete = false, observedModel: typeof model | undefined;
      await new ChatCompletionsAdapter({ baseURL: snapshot.baseURL, credential: async () => snapshot.credential, fetch: this.fetch, timeoutMs: 90_000 }).execute({ clientRequestID: randomUUID(), model, messages: [{ role: 'user', content: prompt }] }, async event => {
        if (event.type === 'text-delta') { text += event.text; if (Buffer.byteLength(text) > 64 * 1024) throw new ExecutionError('protocol', '规划结果超过容量上限。', true); }
        if (event.type === 'observed-model') observedModel = event.model;
        if (event.type === 'completed') complete = true;
      }, signal);
      if (!complete) throw new ExecutionError('incomplete', '规划结果未确认结束，不会重发。', true);
      return { text, ...(observedModel ? { observedModel } : {}) };
    } };
  }
}
