import React, { useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import { JevSettingsPanel } from './JevSettingsPanel';
/** Sibling of the execution-Agent settings, never an Agent selector/list item or chat source. */
export function JevConfigurationArea({ api, autoFocus = false }: { api: DesktopAPI; autoFocus?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    let next: number | undefined;
    const first = requestAnimationFrame(() => { next = requestAnimationFrame(() => {
      region.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      region.current?.focus({ preventScroll: true });
    }); });
    return () => { cancelAnimationFrame(first); if(next!==undefined)cancelAnimationFrame(next); };
  }, [autoFocus]);
  return <section ref={region} tabIndex={-1} aria-label="任务分工判断 / Jev" className="task-content-section task-jev">
    <header className="settings-section-header"><h4>任务分工判断 / Jev</h4><p>独立的 TypeSafe 官方判断服务。</p></header>
    <div className="task-jev-body"><JevSettingsPanel api={api} open={expanded} onToggle={setExpanded}/></div>
  </section>;
}
