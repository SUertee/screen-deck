import type { PreviewPlan } from './types.js';
export interface KnowledgeSource {
  taskID:string; planVersion:number; attemptID:string; sessionID:string; evidenceDigest:string;
}
export interface KnowledgeText { title:string; content:string; context:string }
export interface KnowledgeCard extends KnowledgeText {
  schema_version:1; kind:'screendeck_knowledge'; id:string; revision:number;
  createdAt:string; updatedAt:string; archived:boolean; source:KnowledgeSource;
}
export interface KnowledgeView { card:KnowledgeCard; sourceStatus:'available'|'unavailable' }
export interface TaskKnowledgeAPI {
  knowledgeSources(taskID:string):Promise<KnowledgeSource[]>;
  searchKnowledge(input:{query:string;includeArchived:boolean}):Promise<KnowledgeView[]>;
  saveKnowledge(input:KnowledgeText & ({id:string;expectedRevision:number;archived:boolean}|{taskID:string;attemptID:string;confirmed:true})):Promise<KnowledgeView>;
  useKnowledge(input:{id:string;expectedRevision:number;taskID:string;expectedVersion:number}):Promise<PreviewPlan>;
}
