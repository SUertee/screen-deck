import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import type { AgentExecutionContext } from '../../shared/agent-execution.js';
const inside = (root: string, target: string) => { const relative=path.relative(root,target); return relative === '' || !relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative); };
async function canonicalTarget(target: string): Promise<string> {
  let parent=target; const suffix:string[]=[];
  while(true) {
    try { return path.join(await realpath(parent),...suffix); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; try { await lstat(parent); throw new Error('Existing unresolved path requires confirmation'); } catch(check) { if((check as NodeJS.ErrnoException).code!=='ENOENT')throw check; } const next=path.dirname(parent);if(next===parent)throw error;suffix.unshift(path.basename(parent));parent=next; }
  }
}
/** Only native edit requests with explicit canonical in-workspace targets may auto-pass. Never classify shell text as a safe edit. */
export async function autoApproveOpenCode(context: AgentExecutionContext, value: unknown): Promise<boolean> {
  if(context.mode==='full-access')return true;
  if(context.mode!=='auto-edit' || !value || typeof value!=='object')return false;
  const tool=value as Record<string,unknown>;
  if(tool.kind!=='edit')return false;
  const input=tool.rawInput && typeof tool.rawInput==='object'?tool.rawInput as Record<string,unknown>:{};
  const paths:unknown[]=[input.filePath,input.file_path];
  if(Array.isArray(tool.locations))for(const item of tool.locations)if(item&&typeof item==='object')paths.push((item as Record<string,unknown>).path);
  if(Array.isArray(tool.content))for(const item of tool.content)if(item&&typeof item==='object'&&(item as Record<string,unknown>).type==='diff')paths.push((item as Record<string,unknown>).path);
  const targets=paths.filter(value=>value!==undefined);
  if(!targets.length || targets.some(value=>typeof value!=='string'||!value||/[\0\r\n]/.test(value)))return false;
  try { const root=await realpath(context.workspace.path);for(const target of targets as string[])if(!inside(root,await canonicalTarget(path.resolve(root,target))))return false;return true; }catch{return false;}
}
/** Codex's untrusted policy also asks for patches; only canonical in-workspace changes bypass human confirmation. */
export async function autoApproveCodexChange(context: AgentExecutionContext, changes: unknown): Promise<boolean> {
  if(context.mode !== 'auto-edit' || !Array.isArray(changes) || !changes.length)return false;
  const targets:unknown[]=[];
  for(const change of changes) {
    if(!change || typeof change!=='object' || typeof change.path!=='string')return false;
    targets.push(change.path);
    const kind=change.kind;
    if(kind && typeof kind==='object')for(const key of ['move_path','movePath'])if(kind[key]!==undefined&&kind[key]!==null)targets.push(kind[key]);
  }
  if(targets.some(value=>typeof value!=='string'||!value||/[\0\r\n]/.test(value)))return false;
  try {const root=await realpath(context.workspace.path);for(const target of targets as string[])if(!inside(root,await canonicalTarget(path.resolve(root,target))))return false;return true;}catch{return false;}
}
