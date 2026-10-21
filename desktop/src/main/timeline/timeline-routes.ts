import type { ElectronHost } from '../electron-host.js';
import { payload,textInput,uuidInput } from '../ipc-validation.js';
import { StorageError } from '../../core/storage/private-storage.js';
import { reference } from './validation.js';
import type { TimelineService } from './timeline-service.js';
export function installTimelineRoutes(host:Pick<ElectronHost,'handle'>,service:TimelineService) {
  host.handle('timeline-locate',input=>{const v=payload(input,['snapshotID','sceneSnapshotID','timestamp']);return service.locate(uuidInput(v.snapshotID),v.sceneSnapshotID===undefined?undefined:uuidInput(v.sceneSnapshotID),v.timestamp as number);});
  host.handle('timeline-query',input=>service.query(input));
  host.handle('timeline-scene',input=>service.scene(input));
  const event=(input:unknown)=>{const v=payload(input,['snapshotID','eventID']);return {snapshotID:uuidInput(v.snapshotID),eventID:textInput(v.eventID,400)};};
  host.handle('timeline-detail',input=>{const v=event(input);return service.detail(v.snapshotID,v.eventID);});
  host.handle('timeline-context',input=>{const v=event(input);return service.context(v.snapshotID,v.eventID);});
  host.handle('timeline-at',input=>{const v=payload(input,['frameID','timeZone']);return service.at(textInput(v.frameID,100),textInput(v.timeZone,100));});
  host.handle('timeline-frame-relations',input=>service.frameRelations(textInput(input,100)));
  host.handle('timeline-frame',input=>service.frame(textInput(input,100)));
  host.handle('timeline-frame-text',input=>service.frameText(textInput(input,100)));
  host.handle('timeline-links',input=>{if(input!==undefined) throw new StorageError('timeline-input','此操作不接受参数。');return service.links.load();});
  host.handle('timeline-associate',input=>{
    const v=payload(input,['target','frameIDs','expectedRevision']);
    if(!Array.isArray(v.frameIDs)||!v.frameIDs.length||v.frameIDs.length>100||new Set(v.frameIDs).size!==v.frameIDs.length) throw new StorageError('timeline-input','请选择 1–100 个不同画面。');
    return service.associate(reference(v.target),v.frameIDs as string[],v.expectedRevision as number);
  });
  host.handle('timeline-unlink',input=>{const v=payload(input,['id','expectedRevision']);return service.links.remove(uuidInput(v.id),v.expectedRevision as number);});
}
