import type { PreviewPlan, PreviewPlanScope, SessionEvent, SessionRecord, SessionScope, SendResult, DecisionRecommendation } from './types.js';
import type { ArtifactPreview, ProjectWorkspaceResult } from '../projects/types.js';

export interface ProviderSettings {
  baseURL: string;
  modelID: string;
  hasKey: boolean;
  credentialStorage: 'locked' | 'encrypted' | 'memory' | 'none';
}
export interface SettingsInput { baseURL: string; modelID: string; apiKey?: string; rememberKey: boolean; forgetKey?: boolean }
export interface BootstrapResult {
  settings: ProviderSettings;
  sessions: SessionRecord[];
  projects: ProjectWorkspaceResult[];
  plans: PreviewPlan[];
  diagnostics: string[];
  dataRootLabel: string;
}
export type DesktopEvent = SessionEvent | { type: 'settings-updated'; settings: ProviderSettings };
export interface DesktopAPI {
  bootstrap(): Promise<BootstrapResult>;
  createSession(input: { title: string; scope?: SessionScope }): Promise<SessionRecord>;
  loadSession(sessionID: string): Promise<SessionRecord | undefined>;
  sendMessage(input: { sessionID: string; text: string }): Promise<SendResult>;
  stopGeneration(sessionID: string): Promise<void>;
  retryPendingWrites(sessionID: string): Promise<void>;
  getSettings(): Promise<ProviderSettings>;
  saveSettings(input: SettingsInput): Promise<ProviderSettings>;
  chooseProject(): Promise<ProjectWorkspaceResult | null>;
  refreshProject(projectID: string): Promise<ProjectWorkspaceResult>;
  previewArtifact(input: { projectID: string; referenceID: string }): Promise<ArtifactPreview>;
  createPlan(input: { title: string; scope?: PreviewPlanScope }): Promise<PreviewPlan>;
  savePlan(input: { plan: PreviewPlan; expectedVersion: number }): Promise<PreviewPlan>;
  recommendations(planID: string): Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>;
  saveDraft(input: { key: string; text: string }): Promise<void>;
  loadDraft(key: string): Promise<string>;
  openDeck(sessionID?: string): Promise<void>;
  showWorkbench(): Promise<void>;
  subscribe(callback: (event: DesktopEvent) => void): () => void;
}
declare global { interface Window { screendeck?: DesktopAPI } }
