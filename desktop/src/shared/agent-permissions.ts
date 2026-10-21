import type { AgentPermissionMode } from './agent-execution.js';
export const PERMISSION_CHOICES = [
  { value: 'confirm-changes', label: '变更前确认', description: '修改文件前先询问你。' },
  { value: 'auto-edit', label: '自动编辑', description: '自动修改工作区文件，命令按规则确认。' },
  { value: 'full-access', label: '完全访问', description: '放宽文件与命令限制，跳过常规审批。' },
] as const;
export function isNewPermissionMode(value: unknown): value is typeof PERMISSION_CHOICES[number]['value'] { return PERMISSION_CHOICES.some(item => item.value === value); }
export function isStoredPermissionMode(value: unknown): value is AgentPermissionMode { return isNewPermissionMode(value) || value === 'read-only' || value === 'ask'; }
export function permissionLabel(mode: AgentPermissionMode) { return PERMISSION_CHOICES.find(item => item.value === mode)?.label ?? (mode === 'read-only' ? '只读（旧会话）' : '按需审批（旧会话）'); }
/** Thread policy, never a process-wide mutation: old sessions keep their original meaning. */
export function codexPermissionPolicy(mode?: AgentPermissionMode) {
  if (mode === 'full-access') return { approval: 'never', sandbox: 'danger-full-access', type: 'dangerFullAccess' } as const;
  if (mode === 'auto-edit') return { approval: 'untrusted', sandbox: 'workspace-write', type: 'workspaceWrite' } as const;
  if (mode === 'confirm-changes') return { approval: 'untrusted', sandbox: 'read-only', type: 'readOnly' } as const;
  if (mode === 'ask') return { approval: 'on-request', sandbox: 'workspace-write', type: 'workspaceWrite' } as const;
  return { approval: 'never', sandbox: 'read-only', type: 'readOnly' } as const;
}
export function permissionSummary(agentID: string, mode: AgentPermissionMode): string {
  if (mode === 'full-access') return agentID === 'codex' ? '允许广泛文件访问与命令执行，移除本地沙箱并跳过常规审批；系统及 Codex 的强制限制仍适用。' : '现有原生工具的许可请求自动批准，仍保留 OpenCode 的强制拒绝和系统限制；OpenCode 没有 OS 沙箱。';
  if (mode === 'confirm-changes') return agentID === 'codex' ? '文件修改通过 Codex 原生申请确认；非信任命令先确认，命令联网默认受限。读取范围不等于只限工作目录。' : '文件修改、命令及目录外访问由 OpenCode 原生规则请求确认；读取工作区文件无需常规确认。OpenCode 没有 OS 沙箱。';
  if (mode === 'auto-edit') return agentID === 'codex' ? '工作区文件可自动修改，非信任命令仍确认，命令联网默认受限；Codex 自有记忆目录保留原生写入例外。' : '明确位于工作区内的文件编辑许可自动批准；命令、范围外目标和无法确定的编辑仍先确认。OpenCode 没有 OS 沙箱。';
  return agentID === 'codex' ? mode === 'ask' ? '旧会话：workspace-write 与 on-request；范围内操作可直接执行，需要升级时询问。' : '旧会话：原生只读沙箱，不允许提权。' : mode === 'ask' ? '旧会话：原生读取允许，修改与命令询问。OpenCode 没有 OS 沙箱。' : '旧会话：需要许可的操作自动拒绝。OpenCode 没有 OS 沙箱。';
}
