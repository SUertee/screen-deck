export interface TaskHandoff {
  schema_version:1; id:string; taskID:string; planVersion:number; createdAt:string;
  source:'manual'|'attempt'; summary:string; next:string;
  attemptID?:string; workItemID?:string; sessionID?:string; turnID?:string;
  state?:string; evidenceDigest?:string;
}
export interface TaskHandoffAPI {
  taskHandoffs(planID:string):Promise<TaskHandoff[]>;
  saveTaskHandoff(input:{planID:string;expectedVersion:number;summary:string;next:string}):Promise<TaskHandoff>;
  exportTaskHandoffs(planID:string):Promise<{saved:boolean}>;
}
