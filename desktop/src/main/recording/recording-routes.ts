import type { ElectronHost } from '../electron-host.js';
import { StorageError } from '../../core/storage/private-storage.js';
import type { RecordingService } from './recording-service.js';
export function installRecordingRoutes(host: Pick<ElectronHost, 'handle'>, service: RecordingService, openPermissions: () => Promise<void>) {
  const none = (input: unknown) => { if (input !== undefined) throw new StorageError('recording-input', '此操作不接受参数。'); };
  host.handle('screen-status', input => { none(input); return service.status(); });
  host.handle('screen-displays', input => { none(input); return service.backend.displays(); });
  host.handle('screen-start', input => { none(input); return service.start(); });
  host.handle('screen-stop', input => { none(input); return service.stop(); });
  host.handle('screen-settings', input => service.saveSettings(input));
  host.handle('screen-search', input => service.store.search(input));
  host.handle('screen-image', input => service.store.image(input));
  host.handle('screen-delete', input => service.delete(input));
  host.handle('screen-clear', input => { none(input); return service.clear(); });
  host.handle('screen-permissions', input => { none(input); return openPermissions(); });
}
