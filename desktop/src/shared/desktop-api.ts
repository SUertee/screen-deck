import type { PreviewPlan, PreviewPlanScope, SessionEvent, SessionRecord, SessionScope, SendResult, DecisionRecommendation, ModelSelection } from './types.js';
import type { ArtifactPreview, ProjectWorkspaceResult } from '../projects/types.js';
import type { AgentChatAPI, AgentSessionEvent, AgentSessionRecord } from './agent-chat.js';
import type { TaskExecutionAPI, TaskSessionRecord } from './task-execution.js';

export interface LLMProviderConfig { baseURL: string; modelID: string }
export interface ProviderSettings extends LLMProviderConfig {
  hasKey: boolean;
  credentialStorage: 'locked' | 'encrypted' | 'memory' | 'none';
}
export interface SettingsInput { baseURL: string; modelID: string; apiKey?: string; rememberKey: boolean; forgetKey?: boolean }
export type OpenCodeStatus = { state: 'stopped' } | { state: 'ready'; version: string; model: ModelSelection; requiresRestart: boolean };
/** Metadata-only discovery; no process/version probe until explicit connection. */
export interface OpenCodeBinaryCandidate { id: string; path: string; source: 'remembered' | 'manual' | 'path' | 'standard' }
export interface OpenCodeInstallation { candidates: OpenCodeBinaryCandidate[]; preferredID?: string }
export interface BootstrapResult {
  settings: ProviderSettings;
  sessions: SessionRecord[];
  taskSessions?: TaskSessionRecord[];
  agentSessions?: AgentSessionRecord[];
  projects: ProjectWorkspaceResult[];
  plans: PreviewPlan[];
  diagnostics: string[];
  dataRootLabel: string;
}
export type DesktopEvent = SessionEvent | AgentSessionEvent | { type: 'settings-updated'; settings: ProviderSettings };
export interface DesktopAPI extends TaskExecutionAPI, AgentChatAPI {
  bootstrap(): Promise<BootstrapResult>;
  createSession(input: { title: string; scope?: SessionScope }): Promise<SessionRecord>;
  loadSession(sessionID: string): Promise<SessionRecord | undefined>;
  sendMessage(input: { sessionID: string; text: string }): Promise<SendResult>;
  stopGeneration(sessionID: string): Promise<void>;
  retryPendingWrites(sessionID: string): Promise<void>;
  getSettings(): Promise<ProviderSettings>;
  saveSettings(input: SettingsInput): Promise<ProviderSettings>;
  getOpenCodeStatus(): Promise<OpenCodeStatus>;
  getOpenCodeInstallation(): Promise<OpenCodeInstallation>;
  chooseOpenCodeBinary(): Promise<OpenCodeBinaryCandidate | undefined>;
  openOpenCodeInstallGuide(): Promise<void>;
  startOpenCode(input?: { candidateID: string }): Promise<OpenCodeStatus>;
  stopOpenCode(): Promise<OpenCodeStatus>;
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
