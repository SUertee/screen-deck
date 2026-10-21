import { useEffect, useState } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import type { PreviewPlan } from '../../shared/types';
import type { AgentExecutionRecord } from '../../shared/agent-execution';
import type { TaskExecutionSnapshot } from './task-board-model';

/** Read-only, bounded polling while the task page is visible. Never refreshes or starts an attempt. */
export function useTaskBoard(api: DesktopAPI, plans: PreviewPlan[], active: boolean) {
  const [snapshots, setSnapshots] = useState<Record<string, TaskExecutionSnapshot>>({});
  const [retry, setRetry] = useState(0);
  const key = plans.filter(p => !p.scope).map(p => `${p.id}:${p.version}`).sort().join('|');
  useEffect(() => {
    if (!active) return;
    let disposed = false, busy = false, rerun = false;
    const ids = plans.filter(p => !p.scope).map(p => p.id);
    const read = async () => {
      if (disposed) return;
      if (busy) { rerun = true; return; }
      busy = true;
      let cursor = 0;
      const next: Record<string, TaskExecutionSnapshot> = {};
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (!disposed && cursor < ids.length) {
          const id = ids[cursor++];
          try {
            const attempts = await api.nativeList({ kind: 'local', planID: id });
            const executions: Record<string, AgentExecutionRecord | undefined> = {};
            for (const attempt of attempts.filter(a => a.status === 'dispatching' && a.sessionID)) {
              const turnID = attempt.turnID ?? (await api.loadAgentSession(attempt.sessionID!))?.turns.at(-1)?.turn_id;
              if (turnID) executions[attempt.id] = await api.getAgentExecution({ sessionID: attempt.sessionID!, turnID });
            }
            next[id] = { state: 'ready', attempts, executions };
          } catch { next[id] = { state: 'error', attempts: [], executions: {} }; }
        }
      }));
      if (!disposed) setSnapshots(next);
      busy = false;
      if (rerun && !disposed) { rerun = false; void read(); }
    };
    // New plan versions must not inherit the previous version's completion label.
    setSnapshots({});
    void read();
    const timer = setInterval(() => void read(), 10_000);
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe(event => {
      if (['agent-execution-updated', 'agent-session-updated', 'plan-updated'].includes(event.type)) {
        clearTimeout(debounce); debounce = setTimeout(() => void read(), 200);
      }
    });
    return () => { disposed = true; clearInterval(timer); clearTimeout(debounce); unsubscribe(); };
  }, [api, key, active, retry]);
  return { snapshots, retry: () => setRetry(v => v + 1) };
}
