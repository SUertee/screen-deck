import React, {useId} from 'react';
import type { ScreenDisplay, ScreenRecordingSettings } from '../shared/screen-recording';
import './screen-capture-details.css';
export function ScreenDisplaySelection({settings, displays, loading, error, disabled, onChange, onRefresh}: {
  settings: ScreenRecordingSettings; displays: ScreenDisplay[]; loading: boolean; error: string; disabled?: boolean;
  onChange(value: ScreenRecordingSettings): void; onRefresh(): void;
}) {
  const groupID = useId();
  const explicit = settings.displayIDs !== undefined || settings.displayID !== null;
  const selected = settings.displayIDs ?? (settings.displayID === null ? [] : [settings.displayID]);
  const offline = selected.filter(id => !displays.some(d => d.id === id));
  return <fieldset className="screen-display-selection" disabled={disabled} aria-busy={loading}><legend>采集显示器</legend>
    <label className="screen-display-option"><input type="radio" name={groupID} checked={!explicit} onChange={() => {const {displayIDs: _ids, ...legacy} = settings; onChange({...legacy, displayID: null});}}/><span>主显示器<span className="screen-display-help">沿用原单屏设置</span></span></label>
    <label className="screen-display-option"><input type="radio" name={groupID} checked={explicit} onChange={() => onChange({...settings, displayID: selected[0] ?? null, displayIDs: selected})}/><span>指定显示器<span className="screen-display-help">最多选择 8 个，按顺序逐屏采样</span></span></label>
    {explicit && <div className="screen-display-choices" role="group" aria-label="指定采集显示器">{[...displays, ...offline.map(id => ({id, name: `显示器 ${id}`, width: 0, height: 0}))].map(display => <label className="screen-display-option" key={display.id}>
      <input type="checkbox" aria-label={`采集 ${display.name}`} checked={selected.includes(display.id)} disabled={disabled || (!selected.includes(display.id) && selected.length >= 8)} onChange={event => {const ids = event.target.checked ? [...selected, display.id] : selected.filter(id => id !== display.id);onChange({...settings, displayID: ids[0] ?? null, displayIDs: ids});}}/>
      <span>{display.name}<span className="screen-display-help">ID {display.id}{offline.includes(display.id) ? ' · 未连接，保留选择并等待重连' : ` · ${display.width}×${display.height}`}</span></span>
    </label>)}</div>}
    <p className="screen-display-feedback" role="status">{error || (loading ? '正在检测显示器…' : explicit && !selected.length ? '至少选择一个显示器后再保存。' : offline.length ? '未连接的显示器不会被其他屏幕替代。可取消选择或连接后继续。' : explicit ? `已选择 ${selected.length} 个显示器；不会自动录制新接入的屏幕。` : '仅采集系统主显示器，不自动扩展到其他屏幕。')}</p>
    <button className="text-button" type="button" disabled={disabled || loading} onClick={onRefresh}>重新检测显示器</button>
  </fieldset>;
}
