import React from 'react';
import type { ProjectSourceDiagnostic } from '../shared/desktop-api';
import type { ProjectWorkspaceResult } from '../projects/types';
import { Notice } from './components';

/** Project diagnostics belong to Tasks, including failures without a readable snapshot. */
export function ProjectNotices({ diagnostics, workspace, selectionNotice, refreshNotice, busy, onChoose }: {
  diagnostics: ProjectSourceDiagnostic[];
  workspace?: ProjectWorkspaceResult;
  selectionNotice: string;
  refreshNotice?: string;
  busy: boolean;
  onChoose: () => void;
}) {
  return <div data-testid="project-notices">
    {diagnostics.map(issue => <div key={issue.sourceID} data-source-id={issue.sourceID}><Notice>
      {issue.label}：{issue.message}
      <button className="text-button" disabled={busy} onClick={onChoose}>重新选择项目</button>
    </Notice></div>)}
    {selectionNotice && <div data-testid="project-operation-notice"><Notice>{selectionNotice}<button className="text-button" disabled={busy} onClick={onChoose}>重新选择项目</button></Notice></div>}
    {refreshNotice && <div data-testid="project-operation-notice"><Notice>{refreshNotice}</Notice></div>}
    {workspace?.diagnostics.map((issue, index) => <Notice key={`${issue.code}-${index}`}>
      {issue.code === 'missing_source' ? '项目记录暂时无法读取，请重新选择项目。' : issue.message}
      {issue.code === 'missing_source' && <button className="text-button" disabled={busy} onClick={onChoose}>重新选择项目</button>}
    </Notice>)}
  </div>;
}
