import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, List, Plug, RefreshCw, Sparkles, Terminal } from 'lucide-react';
import type { DesktopAPI } from '../shared/desktop-api';
import type { AgentChatSourceInfo } from '../shared/agent-chat';
import { OpenCodeSettings } from './OpenCodeSettings';
import { CodexSettings } from './CodexSettings';
import './agent-settings.css';
// Add a configuration panel here when a registered Agent has specific settings.
const panels = {
  opencode: { Icon: Terminal, render: (api: DesktopAPI, dirty: boolean, edit: () => void) => <OpenCodeSettings api={api} settingsDirty={dirty} onEditModel={edit} /> },
  codex: { Icon: Sparkles, render: (api: DesktopAPI) => <CodexSettings api={api} /> },
};
export function AgentSettings({ api, settingsDirty, onEditModel }: { api: DesktopAPI; settingsDirty: boolean; onEditModel(): void }) {
  const [sources, setSources] = useState<AgentChatSourceInfo[]>([]), [selected, setSelected] = useState(''), [loading, setLoading] = useState(true), [error, setError] = useState(''), [menu, setMenu] = useState(false);
  const epoch = useRef(0), selector = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), buttons = useRef(new Map<string, HTMLButtonElement>());
  const refresh = async () => {
    const token = ++epoch.current; setLoading(true);
    try { const data = await api.getAgentSources(); if (token !== epoch.current) return; setSources(data); setSelected(old => data.some(source => source.agentID === old) ? old : data.find(source => source.state === 'ready')?.agentID ?? data[0]?.agentID ?? ''); setError(''); }
    catch { if (token === epoch.current) setError('无法读取 Agent 列表，请刷新重试。'); }
    finally { if (token === epoch.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); const unsubscribe = api.subscribe(event => { if (event.type === 'agent-sources-updated' || event.type === 'settings-updated') void refresh(); }); return () => { epoch.current++; unsubscribe(); }; }, [api]);
  useEffect(() => {
    if (!menu) return;
    selector.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!selector.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const panelFor = (id: string) => panels[id as keyof typeof panels];
  const choose = (id: string) => { setSelected(id); setMenu(false); };
  return <div className="agent-browser" data-testid="agent-browser" aria-busy={loading}>
    <aside className="agent-browser-rail">
      <div className="agent-browser-selector" ref={selector}>
        <button type="button" className="agent-browser-list-button" ref={trigger} title="选择 Agent" aria-label="选择 Agent" aria-haspopup="menu" aria-expanded={menu} disabled={!sources.length} onClick={() => setMenu(old => !old)}><List size={17} /><ChevronDown size={10} /></button>
        {menu && <div className="agent-browser-menu" role="menu" aria-label="Agent 列表" onKeyDown={event => {
          const items = [...(selector.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(false); trigger.current?.focus(); }
          else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
          else if (event.key === 'Tab') setMenu(false);
        }}>{sources.map(source => { const Icon = panelFor(source.agentID)?.Icon ?? Plug; return <button type="button" key={source.agentID} role="menuitemradio" aria-checked={source.agentID === selected} onClick={() => { choose(source.agentID); trigger.current?.focus(); }}><Icon size={16} /><span>{source.name}</span>{source.state === 'ready' && <i className="agent-browser-ready" aria-label="已连接" />}</button>; })}</div>}
      </div>
      <div role="tablist" aria-label="Agent 配置" aria-orientation="vertical" className="agent-browser-tabs" onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = sources.findIndex(source => source.agentID === selected), next = sources[event.key === 'Home' ? 0 : event.key === 'End' ? sources.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + sources.length) % sources.length];
        if (next) { choose(next.agentID); buttons.current.get(next.agentID)?.focus(); }
      }}>{sources.map(source => { const Icon = panelFor(source.agentID)?.Icon ?? Plug; return <button type="button" key={source.agentID} ref={button => { if (button) buttons.current.set(source.agentID, button); else buttons.current.delete(source.agentID); }} role="tab" id={'agent-config-tab-' + source.agentID} aria-controls={'agent-config-panel-' + source.agentID} aria-selected={source.agentID === selected} tabIndex={source.agentID === selected ? 0 : -1} title={source.name} aria-label={source.name} onClick={() => choose(source.agentID)}><Icon size={19} />{source.state === 'ready' && <i className="agent-browser-ready" aria-hidden="true" />}</button>; })}</div>
    </aside>
    <div className="agent-browser-content">
      {error && <div className="agent-browser-feedback" role="alert"><span>{error}</span><button type="button" className="icon-button" title="刷新 Agent 列表" aria-label="刷新 Agent 列表" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} /></button></div>}
      {!sources.length && !error && <p className="agent-browser-empty" role="status">{loading ? '正在读取 Agent…' : '暂无已接入的 Agent'}</p>}
      {sources.map(source => <div role="tabpanel" key={source.agentID} id={'agent-config-panel-' + source.agentID} aria-labelledby={'agent-config-tab-' + source.agentID} hidden={selected !== source.agentID}>
        {panelFor(source.agentID)?.render(api, settingsDirty, onEditModel) ?? <section className="agent-browser-generic"><h4>{source.name}</h4><dl className="agent-settings-facts"><dt>连接状态</dt><dd>{source.state === 'ready' ? '已连接' : '未连接'}</dd><dt>接入协议</dt><dd>{source.protocol}</dd></dl><p>此 Agent 尚无专用配置面板。</p></section>}
      </div>)}
    </div>
  </div>;
}
