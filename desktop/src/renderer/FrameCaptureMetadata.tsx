import React from 'react';
import type { ScreenFrame } from '../shared/screen-recording';
import './screen-capture-details.css';
export function FrameCaptureMetadata({frame}: {frame: Omit<ScreenFrame, 'text'>}) {
  const context = frame.context;
  return <section className="screen-capture-facts" aria-label="画面来源说明"><dl>
    <div><dt>显示器</dt><dd>{frame.display?.name ?? `显示器 ${frame.displayID}`} · ID {frame.displayID}</dd></div>
    {frame.display?.uuid && <div><dt>显示器标识</dt><dd>{frame.display.uuid}</dd></div>}
    <div><dt>应用归属</dt><dd>{!context ? '旧记录只保存全局前台应用，未确认它属于本屏。' : context.kind === 'unattributed' ? '未找到本屏可归属的普通窗口。' : '本屏最上层普通窗口的应用；整屏可能同时包含其他应用。'}</dd></div>
    {context?.window && <div><dt>窗口标题</dt><dd>{context.window.title || '系统未提供标题'}</dd></div>}
    <div><dt>聚焦状态</dt><dd>{!context ? '旧记录未报告窗口焦点。' : context.appIsFrontmost === true ? '采样时属于前台应用；具体窗口焦点未知。' : context.appIsFrontmost === false ? '采样时该应用不在前台；具体窗口焦点未知。' : '前台应用归属未确认；具体窗口焦点未知。'}</dd></div>
  </dl>{context && <p>窗口元数据是采样时的观察，可能与画面略有时间差；不据此推断任务归属。</p>}</section>;
}
