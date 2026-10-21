import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { projectTimeline } from '../../src/core/timeline/projector.js';
import { reference } from '../../src/main/timeline/validation.js';
import type { PreviewPlan } from '../../src/shared/types.js';
test('local tasks retain stable timeline identity and manual completion is not Agent acceptance',()=>{
  const plan:PreviewPlan={schema_version:3,kind:'electron_preview_plan',id:randomUUID(),title:'Local task',version:2,created_at:'2026-10-21T01:00:00Z',updated_at:'2026-10-22T04:00:00Z',task:{goal:'Unique goal',completion_conditions:['Review result'],materials:[],chat_refs:[]},work_items:[]};
  const source={plans:[plan],sessions:[],agents:[],taskSessions:[],projects:[],acceptances:[]};
  const first=projectTimeline(source,'UTC','Unique goal')[0];assert.equal(first.ref.source,'local-plan');assert.equal(first.projectID,undefined);assert.equal(first.startedAt,plan.created_at);assert.equal(first.status,'planned');
  const second=projectTimeline({...source,plans:[{...plan,version:3,work_items:[{id:randomUUID(),title:'Manual progress',kind:'implementation',assignee:'human',expected_result:'done',dependencies:[],status:'completed'}]}]},'UTC')[0];
  assert.equal(second.id,first.id);assert.equal(second.status,'manual-completed');assert.deepEqual(second.items,[]);
  assert.deepEqual(reference({source:'local-plan',id:plan.id}),{source:'local-plan',id:plan.id});
  assert.throws(()=>reference({source:'local-plan',id:plan.id,projectID:'project-'+randomUUID()}));
});
