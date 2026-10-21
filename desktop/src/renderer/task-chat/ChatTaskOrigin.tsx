import React from 'react';
import type { PreviewPlan } from '../../shared/types';
/** Immutable source IDs remain visible in both task page and reused chat detail. */
export function ChatTaskOrigin({ plan }: { plan: PreviewPlan }) {
  const origin = plan.task?.chat_origin;
  if (!origin) return null;
  return <details className="task-content-section" style={{ overflowWrap: 'anywhere', minWidth: 0 }} aria-label="任务聊天创建来源"><summary>从聊天消息创建 · 查看来源</summary><p>Task {plan.id}</p><p>{origin.source === 'agent' ? 'Agent 聊天' : '模型聊天'} · Session {origin.sessionID}</p><p>Message {origin.messageID}</p><p>原消息指纹：{origin.messageDigest}</p></details>;
}
