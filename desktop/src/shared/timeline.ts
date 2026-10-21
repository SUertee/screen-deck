import type { ScreenFrame } from './screen-recording.js';
export type TimelineSource = 'model' | 'agent' | 'task-session' | 'task' | 'run' | 'local-plan';
export interface TimelineRef { source: TimelineSource; id: string; projectID?: string }
export interface TimelineItem { id: string; time: string; updatedAt: string; state: string; snippet: string; messageID?: string }
export interface TimelineEvent {
  id: string; ref: TimelineRef; kind: 'task' | 'session'; title: string; sourceLabel: string;
  startedAt: string | null; endedAt: string | null; recordedAt: string;
  projectID?: string; taskID?: string; projectName?: string;
  status: string; snippet: string; messageID?: string; itemCount: number;
  items: TimelineItem[]; related: Array<{ ref: TimelineRef; label: string }>;
}
export interface TimelineQuery {
  day: string; timeZone: string; kind?: 'all' | 'task' | 'session'; projectID?: string; query?: string;
  allDates?: boolean; snapshotID?: string; cursor?: string;
}
export interface TimelinePage {
  snapshotID: string; events: TimelineEvent[]; total: number; nextCursor?: string;
  projects: Array<{ id: string; name: string }>; diagnostics: string[];
  markers: Array<{id:string;time:string;title:string}>; markersSampled: boolean;
  availableDays: string[]; fingerprint: string;
}
export interface TimelineFrame extends Omit<ScreenFrame, 'text'> { snippet: string }
export interface TimelineSceneQuery { day: string; timeZone: string; displayID?: number; app?: string; query?: string; allDates?: boolean; cursor?: string; snapshotID?: string }
export interface TimelineScene {
  snapshotID: string; frames: TimelineFrame[]; total: number; nextCursor?: string;
  points: Array<{id:string;timestamp:string;displayID:number}>; sampled: boolean; start: string; end: string;
  displays: number[]; apps: string[]; availableDays: string[];
}
export interface TimelineAssociation {
  id: string; target: TimelineRef; frameIDs: string[]; createdAt: string; removedAt?: string;
}
export interface TimelineLinks { revision: number; links: TimelineAssociation[] }
export interface TimelineContext { linked: TimelineFrame[]; unavailableCount: number; contemporaneous: TimelineFrame[]; totalContemporaneous: number; revision: number; links: TimelineAssociation[] }
export interface TimelineAPI {
  timelineLocate(input: { snapshotID: string; sceneSnapshotID?: string; timestamp: number }): Promise<{ eventID?: string; frameID?: string }>;
  timelineQuery(input: TimelineQuery): Promise<TimelinePage>;
  timelineDetail(input: { snapshotID: string; eventID: string }): Promise<TimelineEvent>;
  timelineScene(input: TimelineSceneQuery): Promise<TimelineScene>;
  timelineContext(input: { snapshotID: string; eventID: string }): Promise<TimelineContext>;
  timelineAt(input: { frameID: string; timeZone: string }): Promise<{ snapshotID: string; events: TimelineEvent[]; total: number }>;
  timelineFrameRelations(id: string): Promise<{ revision: number; links: Array<{ id: string; event: TimelineEvent | null }> }>;
  timelineFrame(id: string): Promise<TimelineFrame>;
  timelineFrameText(id: string): Promise<string>;
  timelineLinks(): Promise<TimelineLinks>;
  timelineAssociate(input: { target: TimelineRef; frameIDs: string[]; expectedRevision: number }): Promise<TimelineLinks>;
  timelineUnlink(input: { id: string; expectedRevision: number }): Promise<TimelineLinks>;
}
export const timelineRefKey = (r: TimelineRef) => `${r.source}:${r.projectID ?? ''}:${r.id}`;
