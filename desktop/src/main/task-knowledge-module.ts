import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { NativeWorkItemRuntime } from '../core/tasks/native-work-item-runtime.js';
import type { ElectronHost } from './electron-host.js';
import type { KnowledgeSource } from '../shared/task-knowledge.js';
import { TaskKnowledgeService } from './task-knowledge-service.js';
import { taskKnowledgeRouteHandlers } from './task-knowledge-routes.js';
/** Knowledge routes return references only, never raw evidence or Session text. */
export function installTaskKnowledgeModule(root:string,host:ElectronHost,plans:TaskOrchestrator,native:NativeWorkItemRuntime) {
  const sources=async(taskID:string):Promise<KnowledgeSource[]>=>{
    const plan=await plans.loadPlan(taskID);if(!plan||plan.scope)return [];
    return native.owner.withTask({kind:'local',planID:taskID},async tx=>{
      const result:KnowledgeSource[]=[];
      for(const a of await tx.attempts()){
        if(a.input.task.kind!=='local'||a.input.task.planID!==taskID||a.status!=='finished'||a.acceptance?.decision!=='accepted'||!a.sessionID)continue;
        try{const evidence=await native.snapshots.load(a.id,a.acceptance.evidenceDigest);const session=await native.sessions.loadAgentSession(a.sessionID);
          if(!evidence||!session||evidence.inputDigest!==a.inputDigest||evidence.sessionID!==a.sessionID||evidence.turnID!==a.turnID||!session.turns.some(t=>t.turn_id===a.turnID&&t.state==='finished'))continue;
          result.push({taskID,planVersion:a.input.planVersion,attemptID:a.id,sessionID:a.sessionID,evidenceDigest:a.acceptance.evidenceDigest});
        }catch{/* Missing or changed evidence is unavailable. */}
      }
      return result;
    });
  };
  const service=new TaskKnowledgeService(root,async(taskID,attemptID)=>(await sources(taskID)).find(s=>s.attemptID===attemptID));
  for(const [channel,handler] of Object.entries(taskKnowledgeRouteHandlers(plans,service,sources)))host.handle(channel,handler);
  return service;
}
