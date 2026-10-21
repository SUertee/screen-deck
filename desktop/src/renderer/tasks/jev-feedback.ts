export const DEFAULT_JEV_MODEL = 'jev-latest';
export const JEV_CONSOLE_URL = 'https://console.typesafe.ai';
export const isJevModelID = (value: string) => /^jev-[a-zA-Z0-9.-]{1,96}$/.test(value);
export interface JevFeedback { message: string; action: 'settings' | 'preview' | 'wait'; uncertain: boolean }
/** Whitelisted messages only: never render provider bodies, keys or arbitrary Electron errors. */
export function jevFeedback(error: unknown): JevFeedback {
  const raw = error instanceof Error ? error.message : '';
  const code = /Jev[：:]\s*([a-z-]+)/.exec(raw)?.[1];
  const feedback: Record<string, JevFeedback> = {
    authentication: { message: 'TypeSafe 拒绝了认证。请在“Agent 设置 → 任务分工判断 / Jev”中核对或替换 Jev 专用密钥。保存成功仅代表本机已保存。', action: 'settings', uncertain: false },
    'not-configured': { message: '尚未配置 Jev。请在官方控制台创建 API 密钥，再填写该区域的专用密码框。请勿在聊天中粘贴密钥。', action: 'settings', uncertain: false },
    timeout: { message: 'Jev 请求超时，无法确认服务是否已处理或计费。不会自动重发；需要再次调用时，请重新预览并确认费用。', action: 'preview', uncertain: true },
    network: { message: '连接中断，无法确认 Jev 是否已收到或计费。需要再次调用时，请重新预览并确认费用。', action: 'preview', uncertain: true },
    cancelled: { message: '已停止等待；已送出的请求仍可能处理或计费。再次调用前请重新预览并确认费用。', action: 'preview', uncertain: true },
    'model-mismatch': { message: '服务报告的模型与指定版本不符，本次建议未采用。请核对模型版本；不会自动切换模型。', action: 'settings', uncertain: false },
    'request-rejected': { message: 'TypeSafe 拒绝了请求或模型参数。请核对模型 ID（可使用 jev-latest），以及任务摘要大小；修改后重新预览。', action: 'settings', uncertain: false },
    'rate-limited': { message: 'TypeSafe 当前限流。请稍后重新预览并确认本次费用；不会自动重试。', action: 'wait', uncertain: false },
    overloaded: { message: 'TypeSafe 当前过载。请稍后重新预览；不会自动重试。', action: 'wait', uncertain: false },
    'settings-changed': { message: 'Jev 设置已变化，旧建议未采用。请重新预览。', action: 'preview', uncertain: false },
    'stale-draft': { message: '任务或候选已变化，请重新预览后再获取建议。', action: 'preview', uncertain: false },
    'invalid-response': { message: 'Jev 响应未通过格式校验，未保存建议。请核对模型 ID 和固定版本是否匹配；重新调用仍需预览和费用确认。', action: 'settings', uncertain: false },
    'storage-failed': { message: '无法读取或保存本机 Jev 设置。请检查本地数据状态后重试保存；尚不能确认配置成功。', action: 'settings', uncertain: false },
  };
  if (code && feedback[code]) return feedback[code];
  if (/Jev 专用密钥/.test(raw)) return feedback['not-configured'];
  if (/模型版本|模型配置/.test(raw)) return feedback['request-rejected'];
  if (/过期|请重新预览|任务、模型或候选已变化/.test(raw)) return feedback['stale-draft'];
  if (/请先连接一个 Agent/.test(raw)) return { message: '请先连接可用 Agent，或为讨论项配置直接模型，才能比较分工候选。Jev 自身不执行文件或命令。', action: 'settings', uncertain: false };
  return { message: 'Jev 操作未完成，未自动重试。请检查设置；需要再次调用时，重新预览并确认费用。', action: 'preview', uncertain: true };
}
