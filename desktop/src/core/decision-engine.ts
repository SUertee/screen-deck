import type { DecisionContext, DecisionRecommendation } from '../shared/types.js';

export interface DecisionProvider { recommend(context: DecisionContext): Promise<DecisionRecommendation> }

/** Suggestions do not save a plan, grant permission, or invoke a model. */
export class RuleDecisionProvider implements DecisionProvider {
  async recommend(context: DecisionContext): Promise<DecisionRecommendation> {
    if (context.risk !== 'low') return { candidate: 'human', reasons: ['此工作项需要人工核对风险与范围。'], advisory: true };
    if (context.budgetAvailable === false) return { candidate: 'human', reasons: ['上下文表明当前预算不允许模型调用。'], advisory: true };
    if (context.workItem.kind !== 'discussion') return { candidate: 'human', reasons: ['当前执行器仅支持无工具讨论，不能实施或验收工作项。'], advisory: true };
    if (!context.capabilities.includes('stateless-chat')) return { candidate: 'human', reasons: ['当前没有可用的无工具聊天能力。'], advisory: true };
    return { candidate: 'chat', reasons: ['工作项为低风险讨论，具备无工具聊天能力。', context.budgetAvailable === true ? '上下文表明预算允许；建议仍需由人决定是否发送。' : '预算未确认；建议仍需由人决定是否发送。'], advisory: true };
  }
}

export class DecisionEngine {
  constructor(private readonly provider: DecisionProvider = new RuleDecisionProvider()) {}
  async recommend(context: DecisionContext): Promise<DecisionRecommendation> {
    if (!Number.isSafeInteger(context.planVersion) || context.planVersion < 1) throw new Error('计划版本无效。');
    const result = await this.provider.recommend(structuredClone(context));
    if (!['human', 'chat'].includes(result.candidate) || result.advisory !== true || !Array.isArray(result.reasons) || !result.reasons.every(reason => typeof reason === 'string' && reason.length > 0)) throw new Error('判断来源返回了无效建议。');
    return structuredClone(result);
  }
}
