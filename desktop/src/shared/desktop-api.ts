import type { ChatTaskAPI } from './chat-task';
import type { TaskIntegrationsAPI } from './task-integrations.js';
import type { ConfirmTaskContextInput, ConfirmTaskContextReceipt } from './task-context.js';
import type { TimelineAPI } from './timeline.js';
import type { ScreenRecordingAPI } from './screen-recording.js';
import type { AgentExecutionAPI, AgentExecutionRecord } from './agent-execution.js';
import type { PreviewPlan, PreviewPlanScope, TaskReference, SessionEvent, SessionRecord, SessionScope, SendResult, DecisionRecommendation, ModelSelection } from './types.js';
import type { ArtifactPreview, ProjectWorkspaceResult } from '../projects/types.js';
import type { AgentChatAPI, AgentSessionEvent, AgentSessionRecord } from './agent-chat.js';
import type { TaskExecutionAPI, TaskSessionRecord } from './task-execution.js';
import type { ChatManagementAPI, ChatPreferences } from './chat-management.js';

export interface LLMProviderConfig { baseURL: string; modelID: string }
export interface ProviderSettings extends LLMProviderConfig {
  hasKey: boolean;
  credentialStorage: 'file' | 'memory' | 'none';
}
export interface SettingsInput { baseURL: string; modelID: string; apiKey?: string; rememberKey?: boolean; forgetKey?: boolean }
export type ProviderModelsResult = { kind: 'available'; modelIDs: string[] } | { kind: 'unsupported' };
/** Last saved model choices; a cached list is not a model health guarantee. */
export interface ProviderModelCatalog { baseURL: string; modelIDs: string[] }
export type CodexStatus = { state: 'stopped' } | { state: 'login-required' | 'logging-in'; version: string } | { state: 'ready'; version: string; account: string; model: string };
export type OpenCodeStatus = { state: 'stopped' } | { state: 'ready'; version: string; model: ModelSelection; requiresRestart: boolean };
/** Metadata-only discovery; no process/version probe until explicit connection. */
export interface OpenCodeBinaryCandidate { id: string; path: string; source: 'remembered' | 'manual' | 'path' | 'standard' }
export interface OpenCodeInstallation { candidates: OpenCodeBinaryCandidate[]; preferredID?: string }
export interface ProjectSourceDiagnostic { sourceID: string; label: string; code: string; message: string }
export interface DeckContext { revision: number; sessionID?: string; planID?: string }
export interface DeckPresentation {
  revision: number;
  mode: 'floating' | 'notch';
  state: 'collapsed' | 'peeked' | 'expanded';
  notchWidth: number;
  notchHeight: number;
}
export interface BootstrapResult {
  settings: ProviderSettings;
  sessions: SessionRecord[];
  taskSessions?: TaskSessionRecord[];
  agentSessions?: AgentSessionRecord[];
  chatPreferences?: ChatPreferences;
  projects: ProjectWorkspaceResult[];
  projectDiagnostics?: ProjectSourceDiagnostic[];
  plans: PreviewPlan[];
  taskNavigation?: { revision: number; planID: string; reference?: TaskReference };
  diagnostics: string[];
  dataRootLabel: string;
}
export type DesktopEvent = { type: 'task-handoffs-updated' } | { type: 'screen-frame-added'; frameID: string } | { type: 'screen-frame-removed'; frameID: string } | { type: 'workbench-task-requested'; revision: number; planID: string; reference?: TaskReference } | { type: 'deck-presentation-updated'; presentation: DeckPresentation } | { type: 'plan-updated'; plan: PreviewPlan } | ({ type: 'deck-context-updated' } & DeckContext) | { type: 'agent-execution-updated'; execution: AgentExecutionRecord } | { type: 'agent-sources-updated' } | SessionEvent | AgentSessionEvent | { type: 'settings-updated'; settings: ProviderSettings } | { type: 'chat-preferences-updated'; preferences: ChatPreferences } | { type: 'project-diagnostics-updated'; diagnostics: ProjectSourceDiagnostic[] };
export interface DesktopAPI extends ChatTaskAPI, TaskIntegrationsAPI, TimelineAPI, ScreenRecordingAPI, TaskExecutionAPI, AgentChatAPI, ChatManagementAPI, AgentExecutionAPI {
  confirmTaskContext(input: ConfirmTaskContextInput): Promise<ConfirmTaskContextReceipt>;
  bootstrap(): Promise<BootstrapResult>;
  createSession(input: { title: string; scope?: SessionScope }): Promise<SessionRecord>;
  loadSession(sessionID: string): Promise<SessionRecord | undefined>;
  sendMessage(input: { sessionID: string; text: string }): Promise<SendResult>;
  stopGeneration(sessionID: string): Promise<void>;
  retryPendingWrites(sessionID: string): Promise<void>;
  getSettings(): Promise<ProviderSettings>;
  saveSettings(input: SettingsInput): Promise<ProviderSettings>;
  getProviderModels(): Promise<ProviderModelCatalog>;
  listProviderModels(input: { baseURL: string; apiKey?: string }): Promise<ProviderModelsResult>;
  selectProviderModel(input: { modelID: string }): Promise<ProviderSettings>;
  getCodexStatus(): Promise<CodexStatus>;
  startCodex(): Promise<CodexStatus>;
  chooseCodex(): Promise<CodexStatus>;
  loginCodex(): Promise<CodexStatus>;
  cancelCodexLogin(): Promise<CodexStatus>;
  refreshCodex(): Promise<CodexStatus>;
  stopCodex(): Promise<CodexStatus>;
  getOpenCodeStatus(): Promise<OpenCodeStatus>;
  getOpenCodeInstallation(): Promise<OpenCodeInstallation>;
  chooseOpenCodeBinary(): Promise<OpenCodeBinaryCandidate | undefined>;
  openOpenCodeInstallGuide(): Promise<void>;
  startOpenCode(input?: { candidateID: string }): Promise<OpenCodeStatus>;
  stopOpenCode(): Promise<OpenCodeStatus>;
  chooseProject(): Promise<ProjectWorkspaceResult | null>;
  refreshProject(projectID: string): Promise<ProjectWorkspaceResult>;
  previewArtifact(input: { projectID: string; referenceID: string }): Promise<ArtifactPreview>;
  createPlan(input: { title: string; scope?: PreviewPlanScope; schemaVersion?: 1 | 2 | 3 }): Promise<PreviewPlan>;
  savePlan(input: { plan: PreviewPlan; expectedVersion: number }): Promise<PreviewPlan>;
  recommendations(planID: string): Promise<Array<{ workItemID: string; recommendation: DecisionRecommendation }>>;
  saveDraft(input: { key: string; text: string }): Promise<void>;
  loadDraft(key: string): Promise<string>;
  openDeck(sessionID?: string, planID?: string): Promise<void>;
  getDeckContext(): Promise<DeckContext>;
  getDeckPresentation(): Promise<DeckPresentation>;
  setDeckInteraction(input: { busy: boolean }): Promise<void>;
  setDeckCollapsed(collapsed: boolean): Promise<void>;
  showWorkbench(planID?: string): Promise<void>;
  subscribe(callback: (event: DesktopEvent) => void): () => void;
}
declare global { interface Window { screendeck?: DesktopAPI } }
