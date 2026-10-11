import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, DesktopEvent } from '../shared/desktop-api.js';
const invoke = <T>(channel: string, input?: unknown): Promise<T> => ipcRenderer.invoke(`screendeck:${channel}`, input);
const api: DesktopAPI = {
  bootstrap: () => invoke('bootstrap'),
  createSession: input => invoke('create-session', input),
  loadSession: id => invoke('load-session', id),
  sendMessage: input => invoke('send-message', input),
  stopGeneration: id => invoke('stop-generation', id),
  retryPendingWrites: id => invoke('retry-pending-writes', id),
  getSettings: () => invoke('get-settings'),
  saveSettings: input => invoke('save-settings', input),
  chooseProject: () => invoke('choose-project'),
  refreshProject: id => invoke('refresh-project', id),
  previewArtifact: input => invoke('preview-artifact', input),
  createPlan: input => invoke('create-plan', input),
  savePlan: input => invoke('save-plan', input),
  recommendations: id => invoke('recommendations', id),
  saveDraft: input => invoke('save-draft', input),
  loadDraft: key => invoke('load-draft', key),
  openDeck: (sessionID?: string) => invoke('open-deck', sessionID),
  showWorkbench: () => invoke('show-workbench'),
  subscribe: callback => {
    const handler = (_event: unknown, value: DesktopEvent) => callback(value);
    ipcRenderer.on('screendeck:event', handler);
    return () => { ipcRenderer.removeListener('screendeck:event', handler); };
  }
};
contextBridge.exposeInMainWorld('screendeck', Object.freeze(api));
