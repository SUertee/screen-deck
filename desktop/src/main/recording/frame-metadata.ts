import type { ScreenBounds, ScreenDisplay, ScreenFrame, ScreenWindowContext } from '../../shared/screen-recording.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n;
export function validBounds(v: unknown): v is ScreenBounds {
  return object(v) && exact(v, ['x', 'y', 'width', 'height']) && ['x', 'y', 'width', 'height'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]) && Math.abs(v[k] as number) <= 1e7) && (v.width as number) > 0 && (v.height as number) > 0;
}
export function validDisplay(v: unknown): v is ScreenDisplay {
  return object(v) && exact(v, ['id', 'name', 'width', 'height', 'uuid', 'bounds']) && positive(v.id) && text(v.name, 200) && positive(v.width) && positive(v.height) && (v.uuid === undefined || typeof v.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.uuid)) && (v.bounds === undefined || validBounds(v.bounds));
}
export function validWindowContext(v: unknown): v is ScreenWindowContext {
  if (!object(v) || !exact(v, ['kind', 'observedAt', 'appIsFrontmost', 'windowFocus', 'window']) || !text(v.observedAt, 64) || !Number.isFinite(Date.parse(v.observedAt)) || ![true, false, null].includes(v.appIsFrontmost as boolean | null) || v.windowFocus !== 'unknown') return false;
  if (v.kind === 'unattributed') return v.window === undefined && v.appIsFrontmost === null;
  return v.kind === 'topmost-window-on-display' && object(v.window) && exact(v.window, ['id', 'title', 'bounds']) && positive(v.window.id) && text(v.window.title, 1000) && validBounds(v.window.bounds);
}
export function validFrameMetadata(v: { displayID: number; display?: unknown; context?: unknown }): boolean {
  return (v.display === undefined || validDisplay(v.display) && v.display.id === v.displayID) && (v.context === undefined || validWindowContext(v.context));
}
export const frameSearchText = (frame: Pick<ScreenFrame, 'text' | 'appName' | 'bundleID' | 'context'>) => `${frame.text}\n${frame.appName}\n${frame.bundleID}\n${frame.context?.window?.title ?? ''}`;
