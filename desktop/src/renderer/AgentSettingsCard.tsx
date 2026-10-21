import React from 'react';
import { ChevronDown } from 'lucide-react';
import './agent-settings.css';
export function AgentSettingsCard({ name, icon, state, status, subtitle, actions, children, details, testID, statusTestID, busy }: { name: string; icon: React.ReactNode; state: string; status: string; subtitle: string; actions: React.ReactNode; children?: React.ReactNode; details: React.ReactNode; testID: string; statusTestID?: string; busy: boolean }) {
  return <section className="agent-settings-card" aria-label={`${name} Agent`} data-testid={testID} data-state={state} aria-busy={busy}>
    <header className="agent-settings-card-header">
      <div className="agent-settings-identity"><span className="agent-settings-icon" aria-hidden="true">{icon}</span><div className="agent-settings-name"><div className="agent-settings-title"><h4>{name}</h4><span className="agent-settings-status" role="status" data-testid={statusTestID}><i aria-hidden="true" />{status}</span></div><p title={subtitle}>{subtitle}</p></div></div>
      <div className="agent-settings-actions">{actions}</div>
    </header>
    {children}
    <details className="agent-settings-details" open><summary><span>连接详情</span><ChevronDown size={13} aria-hidden="true" /></summary><div className="agent-settings-details-body">{details}</div></details>
  </section>;
}
