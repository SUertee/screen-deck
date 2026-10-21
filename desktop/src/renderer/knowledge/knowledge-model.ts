import type { KnowledgeText, KnowledgeView } from '../../shared/task-knowledge.js';
export interface KnowledgeDraft extends KnowledgeText { base:KnowledgeView }
export interface KnowledgeMemory {
  query?:string; scope?:'active'|'archived'; source?:'all'|'available'|'unavailable'; selectedID?:string;
  drafts:Map<string,KnowledgeDraft>;
}
export function knowledgeDraft(view:KnowledgeView):KnowledgeDraft {
  return {base:structuredClone(view),title:view.card.title,content:view.card.content,context:view.card.context};
}
export function draftChanged(draft:KnowledgeDraft):boolean {
  return draft.title!==draft.base.card.title||draft.content!==draft.base.card.content||draft.context!==draft.base.card.context;
}
export function filterKnowledge(records:KnowledgeView[],query:string,scope:'active'|'archived',source:'all'|'available'|'unavailable'):KnowledgeView[] {
  const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return records.filter(v=>v.card.archived===(scope==='archived')&&(source==='all'||v.sourceStatus===source)&&words.every(w=>`${v.card.title}\n${v.card.content}\n${v.card.context}`.toLocaleLowerCase().includes(w)));
}
export function knowledgeError(error:unknown):string {
  return (error instanceof Error?error.message:'操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
}
