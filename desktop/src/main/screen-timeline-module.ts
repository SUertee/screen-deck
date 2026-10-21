import { StorageError } from '../core/storage/private-storage.js';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { SessionManager } from '../core/sessions/session-manager.js';
import type { ProjectWorkspaceReader } from '../projects/index.js';
import type { ElectronHost } from './electron-host.js';
import type { LocalState } from './local-state.js';
import type { ProjectRegistry } from './project-registry.js';
import type { ScreenCaptureBackend } from './recording/recording-service.js';
import { ChatPreferencesStore } from './chat-preferences.js';
import { TimelineService } from './timeline/timeline-service.js';
import { installTimelineRoutes } from './timeline/timeline-routes.js';
import { ExecutionAcceptanceStore } from '../core/tasks/execution-acceptance-store.js';
import type { TimelineSources } from '../core/timeline/projector.js';
import { RecordingStore } from './recording/recording-store.js';
import { RecordingService } from './recording/recording-service.js';
import { NativeScreenBackend } from './recording/native-backend.js';
import { installRecordingRoutes } from './recording/recording-routes.js';

/** Main-owned assembly seam. Initialization only reads local records; never asks TCC or starts capture. */
export async function installScreenTimelineModule({ previewRoot, nativeBinary, host, manager, local, projects, projectRegistry, diagnostics, openPermissions, backend, plans }: {
  previewRoot: string; nativeBinary: string;
  host: Pick<ElectronHost, 'handle' | 'broadcast'>;
  manager: Pick<SessionManager, 'listSessions' | 'listAgentSessions' | 'listTaskSessions'>;
  local: LocalState;
  plans?: Pick<TaskOrchestrator, 'listPlans'>;
  projects: Pick<ProjectWorkspaceReader, 'list'>;
  projectRegistry: Pick<ProjectRegistry, 'refresh'>;
  diagnostics: string[];
  openPermissions(): Promise<void>;
  /** Trusted dependency seam for isolated tests, never renderer input. */
  backend?: ScreenCaptureBackend;
}) {
  const screenStore = new RecordingStore(previewRoot);
  let recording: RecordingService | undefined = new RecordingService(screenStore, backend ?? new NativeScreenBackend(nativeBinary));
  try { await screenStore.initialize(); }
  catch { diagnostics.push('屏幕记录目录无法读取；屏幕记录暂不可用，聊天仍可使用。'); recording = undefined; }
  if (recording) installRecordingRoutes(host, recording, openPermissions);
  screenStore.onAdded(frameID => host.broadcast({ type: 'screen-frame-added', frameID }));
  screenStore.onRemoved(frameID => host.broadcast({ type: 'screen-frame-removed', frameID }));
  let projectRefreshAt = 0;
  let timelineProjectRead: Promise<void> | undefined;
  const refreshTimelineProjects = async () => {
    if (timelineProjectRead) return timelineProjectRead;
    if (Date.now() - projectRefreshAt < 10_000) return;
    timelineProjectRead = Promise.allSettled(projects.list().flatMap(p => p.project ? [projectRegistry.refresh(p.project.project_id)] : [])).then(() => {}).finally(() => { projectRefreshAt = Date.now(); timelineProjectRead = undefined; });
    return timelineProjectRead;
  };
  const timeline = new TimelineService(previewRoot, async () => {
    await refreshTimelineProjects();
    const reads = await Promise.allSettled([manager.listSessions(), manager.listAgentSessions(), manager.listTaskSessions(), new ExecutionAcceptanceStore(previewRoot).list(), new ChatPreferencesStore(local).load(), plans?.listPlans() ?? Promise.resolve([])]);
    const issues: string[] = [];
    const records = <T>(index: number, label: string): T[] => {
      const result = reads[index];
      if (result.status === 'rejected') { issues.push(`${label}读取失败，时间线覆盖不完整。`); return []; }
      const listing = result.value as unknown as { records: T[]; diagnostics: Array<{reason:string}> };
      if (Array.isArray(result.value)) return result.value as T[];
      if (listing.diagnostics.length) issues.push(`${label}有不可读记录，时间线覆盖不完整。`);
      return listing.records;
    };
    const preferenceRead = reads[4];
    const archived = preferenceRead.status === 'fulfilled' ? Object.entries((preferenceRead.value as import('../shared/chat-management.js').ChatPreferences).entries).filter(([, value]) => value.archived).map(([key]) => key) : [];
    if (preferenceRead.status === 'rejected') issues.push('聊天归档偏好不可读，时间线暂不显示归档标记。');
    const workspaces = projects.list();
    if (workspaces.some(p => p.status === 'error' || p.status === 'stale' || p.diagnostics.some(d => d.severity === 'error'))) issues.push('部分项目记录不可读或快照已过期。');
    return { sources: { plans: records(5, '本地任务'), sessions: records(0,'模型聊天'), agents: records(1,'Agent 聊天'), taskSessions: records(2,'任务会话'), acceptances: records(3,'验收记录'), projects: workspaces, archived } as TimelineSources, diagnostics: issues };
  }, recording ? screenStore : undefined);
  installTimelineRoutes(host, timeline);
  return {
    timeline,
    recording,
    withContextSources: <T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> => {
      if (!recording) return Promise.reject(new StorageError('recording-unavailable', '屏幕来源暂不可用。'));
      return screenStore.withContextSources(ids, operation);
    },
    pause: () => recording?.pause(),
    shutdown: async () => { await recording?.shutdown(); },
    // A's material save endpoint can re-resolve frame IDs without reading all OCR.
    resolveContextSource: (id: string) => {
      const frame = timeline.frame(id);
      return { kind: 'screen-frame' as const, frameID: frame.id, capturedAt: frame.timestamp,
        appName: frame.appName, bundleID: frame.bundleID, displayID: frame.displayID, width: frame.width, height: frame.height };
    },
  };
}
