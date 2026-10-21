import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, RequestError, type ClientConnection, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse, type AnyMessage } from '@agentclientprotocol/sdk';
import type { OpenCodeConnection } from '../core/agents/opencode/opencode-adapter.js';
import type { OpenCodeAcpConnection, OpenCodeAcpEvent } from '../core/agents/opencode/opencode-acp-connection.js';
export type { OpenCodeConnection } from '../core/agents/opencode/opencode-adapter.js';

export const OPENCODE_VERSION = '1.19.0';
const PROVIDER_ID = 'screendeck';
const SDK = '@ai-sdk/openai-compatible';
const MAX_RESPONSE = 256 * 1024;

export interface OpenCodeStartInput {
  binaryPath: string;
  provider: { baseURL: string; modelID: string; credential: string };
  /** Only an explicitly enabled loopback fixture may use HTTP. */
  allowLocalProvider?: boolean;
}
interface RuntimeOptions { nativeTools?: boolean; root?: string; startTimeoutMs?: number; shutdownTimeoutMs?: number }
interface LogSink { directory: string; file: string; directoryID: string; linkID: string; deviceID: string }
interface OwnedProcess {
  child: ChildProcess;
  closed: Promise<void>;
  abort: AbortController;
  root: string;
  configDirectory: string;
  connection?: OpenCodeConnection;
  input: OpenCodeStartInput;
  failed: boolean;
  exited: boolean;
  logSink: LogSink;
  rpc?: ClientConnection;
  subscribers?: Set<(event: OpenCodeAcpEvent) => Promise<void>>;
}

export class OpenCodeRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OpenCodeRuntimeError'; }
}
const fail = (code: string, message: string): never => { throw new OpenCodeRuntimeError(code, message); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('runtime-contract', '执行器返回的初始化记录无效。');
  return value as Record<string, unknown>;
};
const equals = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const bounded = (value: number | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 20 || value > 30_000) return fail('runtime-input', '执行器等待时间无效。');
  return value;
};

function validated(input: OpenCodeStartInput): OpenCodeStartInput {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['binaryPath', 'provider', 'allowLocalProvider'].includes(key)) || typeof input.binaryPath !== 'string' || !path.isAbsolute(input.binaryPath) || input.binaryPath.includes('\0')) return fail('runtime-input', '请选择确切的执行器文件。');
  const provider = object(input.provider);
  if (Object.keys(provider).length !== 3 || Object.keys(provider).some(key => !['baseURL', 'modelID', 'credential'].includes(key)) || typeof provider.baseURL !== 'string' || Buffer.byteLength(provider.baseURL) > 4096 || typeof provider.modelID !== 'string' || typeof provider.credential !== 'string' || !provider.credential.trim() || Buffer.byteLength(provider.credential) > 8192 || /[\r\n\0]/.test(provider.credential) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(provider.modelID) || input.allowLocalProvider !== undefined && typeof input.allowLocalProvider !== 'boolean') return fail('runtime-input', '模型连接快照无效。');
  // OpenCode performs config substitutions even after replacing an env token.
  if ([provider.baseURL, provider.modelID, provider.credential].some(value => /\{(?:env|file):/i.test(value))) return fail('runtime-input', '连接快照不能包含配置替换指令。');
  let url: URL;
  try { url = new URL(provider.baseURL); } catch { return fail('runtime-input', '模型地址无效。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || input.allowLocalProvider === true && local && url.protocol === 'http:')) return fail('runtime-input', '模型地址必须使用 HTTPS；测试例外仅允许本机地址。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { binaryPath: input.binaryPath, provider: { baseURL: url.toString().replace(/\/$/, ''), modelID: provider.modelID, credential: provider.credential }, ...(input.allowLocalProvider === true ? { allowLocalProvider: true } : {}) };
}

/** Fixed v1.19.0 managed.ts also reads macOS MDM outside HOME/XDG. Never read its contents. */
async function rejectManagedConfiguration(): Promise<void> {
  const locations = process.platform === 'darwin'
    ? ['/Library/Application Support/opencode', '/Library/Managed Preferences/ai.opencode.managed.plist', path.join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist')]
    : process.platform === 'linux' ? ['/etc/opencode'] : [];
  if (!['darwin', 'linux'].includes(process.platform)) fail('runtime-platform', '本版受控执行器尚未验证这个系统。');
  for (const location of locations) {
    try { await lstat(location); fail('runtime-managed-config', '检测到系统托管执行器配置，本版不开放该连接。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; if (error instanceof OpenCodeRuntimeError) throw error; fail('runtime-managed-config', '无法确认系统托管配置边界，本版不开放该连接。'); }
  }
}

function controlledConfig(input: OpenCodeStartInput, disableTitle = false, nativeTools = false) {
  return {
    username: 'ScreenDeck', model: `${PROVIDER_ID}/${input.provider.modelID}`, small_model: `${PROVIDER_ID}/${input.provider.modelID}`,
    enabled_providers: [PROVIDER_ID], plugin: [], mcp: {}, instructions: [], skills: { paths: [], urls: [] },
    permission: nativeTools ? { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'ask' } : { '*': 'deny' }, agent: { build: { permission: nativeTools ? { '*': 'ask', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', external_directory: 'ask' } : { '*': 'deny' } }, ...(disableTitle ? { title: { disable: true } } : {}) },
    share: 'disabled', autoupdate: false, compaction: { auto: false, prune: false }, lsp: false, formatter: false,
    provider: { [PROVIDER_ID]: {
      npm: SDK, name: 'ScreenDeck', api: input.provider.baseURL,
      options: { baseURL: input.provider.baseURL, apiKey: '{env:SCREENDECK_LLM_API_KEY}' },
      models: { [input.provider.modelID]: { id: input.provider.modelID, name: input.provider.modelID, tool_call: nativeTools, modalities: { input: ['text'], output: ['text'] }, limit: { context: 16_384, output: 4096 } } },
    } },
  };
}

/** Both transports must prove the same fixed effective policy before publishing. */
function inspectConfig(value: unknown, input: OpenCodeStartInput, acp = false, nativeTools = false): void {
  const cfg = object(value), expected = controlledConfig(input, acp, nativeTools);
  const keys = new Set([...Object.keys(expected), 'mode', 'command', '$schema']);
  const agents = object(cfg.agent), build = object(agents.build);
  // ConfigAgentV1.normalize adds empty options and permission even to disable:true.
  // Accept only those empty defaults, never another title policy or extra agent.
  const title = acp ? object(agents.title) : undefined;
  const safeTitle = !acp || title?.disable === true && Object.keys(title).every(key => ['disable', 'options', 'permission'].includes(key)) && (title.options === undefined || Object.keys(object(title.options)).length === 0) && (title.permission === undefined || Object.keys(object(title.permission)).length === 0);
  const safeAgent = Object.keys(agents).length === (acp ? 2 : 1) && Object.keys(agents).every(key => key === 'build' || acp && key === 'title') && safeTitle && Object.keys(build).every(key => ['permission', 'options'].includes(key)) && equals(build.permission, expected.agent.build.permission) && (build.options === undefined || Object.keys(object(build.options)).length === 0);
  const safeCommands = cfg.command === undefined || Object.keys(object(cfg.command)).length === 0;
  if (Object.keys(cfg).some(key => !keys.has(key)) || !safeAgent || !safeCommands || Object.keys(cfg.mode ? object(cfg.mode) : {}).length || cfg.model !== expected.model || cfg.small_model !== expected.small_model || cfg.username !== expected.username || !equals(cfg.enabled_providers, expected.enabled_providers) || !equals(cfg.plugin, []) || !equals(cfg.mcp, {}) || !equals(cfg.instructions, []) || !equals(cfg.skills, expected.skills) || !equals(cfg.permission, expected.permission) || cfg.share !== 'disabled' || cfg.autoupdate !== false || cfg.lsp !== false || cfg.formatter !== false || !equals(cfg.compaction, expected.compaction)) fail('runtime-config', '执行器有效配置超出本次受控范围，连接已拒绝。');
  const providers = object(cfg.provider), provider = object(providers[PROVIDER_ID]);
  const options = object(provider.options), models = object(provider.models);
  if (Object.keys(providers).length !== 1 || provider.npm !== SDK || provider.api !== input.provider.baseURL || !equals(models, expected.provider.screendeck.models) || options.baseURL !== input.provider.baseURL || options.apiKey !== (acp ? '***' : input.provider.credential) || Object.keys(options).some(key => !['baseURL', 'apiKey'].includes(key))) fail('runtime-provider', '执行器模型配置与本次快照不一致。');
}

const acpFailure = () => new OpenCodeRuntimeError('runtime-acp', 'ACP 协议或连接无法确认，连接已关闭；不会重发原请求。');
const acpID = (value: unknown) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 200 && !/[\x00-\x1f]/.test(value);
function notification(value: unknown): SessionNotification {
  const params = object(value), update = object(params.update);
  if (!acpID(params.sessionId) || !acpID(update.sessionUpdate)) throw acpFailure();
  return params as unknown as SessionNotification;
}
function permission(value: unknown): RequestPermissionRequest {
  const params = object(value), call = object(params.toolCall);
  if (!acpID(params.sessionId) || !acpID(call.toolCallId) || !Array.isArray(params.options) || params.options.length > 16 || params.options.some(value => {
    const option = object(value);
    return !acpID(option.optionId) || !['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(String(option.kind));
  })) throw acpFailure();
  return params as unknown as RequestPermissionRequest;
}

/** SDK 1.8 can log raw malformed messages. Verify stdout before SDK dispatch. */
function acpTransport(child: ChildProcess) {
  const pendingIDs = new Set<string | number | null>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  const frame = (line: string): void => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_RESPONSE) throw acpFailure();
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw acpFailure(); }
    const value = object(parsed);
    if (value.jsonrpc !== '2.0') throw acpFailure();
    const hasID = Object.hasOwn(value, 'id');
    if (hasID && !(value.id === null || typeof value.id === 'string' && Buffer.byteLength(value.id) <= 200 || typeof value.id === 'number' && Number.isSafeInteger(value.id))) throw acpFailure();
    if (Object.hasOwn(value, 'method')) {
      if (typeof value.method !== 'string') throw acpFailure();
      if (!hasID) {
        if (value.method === 'session/update') notification(value.params);
        else if (value.method !== '$/cancel_request') throw acpFailure();
      } else if (value.method === 'session/request_permission') permission(value.params);
      else if (!['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill'].includes(value.method)) throw acpFailure();
    } else {
      if (!hasID || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error') || !pendingIDs.delete(value.id as string | number | null)) throw acpFailure();
    }
  };
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const verified = input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      try {
        buffered += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); frame(line); }
        if (Buffer.byteLength(buffered) > MAX_RESPONSE) throw acpFailure();
        controller.enqueue(chunk);
      } catch { throw acpFailure(); }
    },
    flush() { buffered += decoder.decode(); if (buffered.trim()) throw acpFailure(); },
  }));
  const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, verified, { maxMessageBytes: MAX_RESPONSE });
  return {
    readable: stream.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        if ('method' in message && 'id' in message) { if (pendingIDs.size >= 2000) throw acpFailure(); pendingIDs.add(message.id); }
        const writer = stream.writable.getWriter();
        try { await writer.write(message); } finally { writer.releaseLock(); }
      },
    }),
  };
}

const fileID = (value: { dev: number; ino: number; rdev: number }) => `${value.dev}:${value.ino}:${value.rdev}`;

async function verifyLogSink(sink: LogSink): Promise<void> {
  try {
    const [directory, link, device, target, names, devicePath] = await Promise.all([
      lstat(sink.directory), lstat(sink.file), stat('/dev/null'), readlink(sink.file), readdir(sink.directory), realpath(sink.file),
    ]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o222) !== 0 || fileID(directory) !== sink.directoryID || !link.isSymbolicLink() || fileID(link) !== sink.linkID || !device.isCharacterDevice() || fileID(device) !== sink.deviceID || target !== '/dev/null' || devicePath !== '/dev/null' || !equals(names, ['opencode.log']) || fileID(await stat(sink.file)) !== sink.deviceID) throw new Error('invalid log sink');
    await access(sink.file, constants.W_OK);
    try { await access(sink.directory, constants.W_OK); throw new OpenCodeRuntimeError('runtime-log-sink', '无法禁止执行器创建或替换日志文件。'); }
    catch (error) { if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  } catch { fail('runtime-log-sink', '无法确认执行器的受控日志出口，本版不开放该连接。'); }
}

async function prepareLogSink(data: string): Promise<LogSink> {
  try {
    // Fixed v1.19.0 Logging.fileLogger always appends here, even without PRINT_LOGS.
    // A read-only parent blocks ordinary file creation/replacement, while append
    // follows this single link to the verified null device. This is not a sandbox:
    // a malicious same-user executable could chmod its own directory.
    const directory = path.join(data, 'opencode', 'log'), file = path.join(directory, 'opencode.log');
    const device = await lstat('/dev/null');
    if (!device.isCharacterDevice() || device.isSymbolicLink() || await realpath('/dev/null') !== '/dev/null') throw new Error('invalid null device');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await symlink('/dev/null', file);
    await chmod(directory, 0o500);
    const sink = { directory, file, directoryID: fileID(await lstat(directory)), linkID: fileID(await lstat(file)), deviceID: fileID(device) };
    await verifyLogSink(sink);
    return sink;
  } catch { return fail('runtime-log-sink', '无法建立执行器的受控日志出口，本版不开放该连接。'); }
}

async function environment(root: string, input: OpenCodeStartInput, password: string, disableTitle = false, nativeTools = false): Promise<{ env: NodeJS.ProcessEnv; logSink: LogSink }> {
  const directories = Object.fromEntries(['home', 'data', 'cache', 'config', 'state', 'tmp', 'managed', 'directory'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(directory => mkdir(directory, { mode: 0o700 })));
  const logSink = await prepareLogSink(directories.data);
  const configDirectory = path.join(directories.config, 'opencode');
  await mkdir(configDirectory, { mode: 0o700 });
  await writeFile(path.join(configDirectory, '.gitignore'), '*\n', { mode: 0o600, flag: 'wx' });
  // config.ts unconditionally calls Npm.install for config directories. In this
  // version npm.ts returns before reify when the directory is not writable.
  await chmod(configDirectory, 0o500);
  try { await access(configDirectory, constants.W_OK); fail('runtime-config-writable', '无法禁止执行器初始化安装，本版不开放该连接。'); }
  catch (error) { if (error instanceof OpenCodeRuntimeError) throw error; if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) fail('runtime-config-writable', '无法确认执行器配置目录权限。'); }
  const models = path.join(root, 'models.json');
  await writeFile(models, '{}\n', { mode: 0o400, flag: 'wx' });
  return { logSink, env: {
    // Deliberately do not copy process.env: no proxy, token, NODE_OPTIONS,
    // BUN_OPTIONS, user HOME, OTEL, npm config, or credential discovery.
    PATH: nativeTools ? process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' : '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8',
    HOME: directories.home, OPENCODE_TEST_HOME: directories.home,
    XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache, XDG_CONFIG_HOME: directories.config, XDG_STATE_HOME: directories.state,
    TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp,
    OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_TEST_MANAGED_CONFIG_DIR: directories.managed,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(controlledConfig(input, disableTitle, nativeTools)),
    SCREENDECK_LLM_API_KEY: JSON.stringify(input.provider.credential).slice(1, -1),
    OPENCODE_SERVER_USERNAME: 'screendeck', OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_MODELS_PATH: models, OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_PURE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_FFF: 'true', OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_AUTOCOMPACT: 'true', OPENCODE_DISABLE_PRUNE: 'true',
  } };
}

/** Owns only children it creates. These controls are not an OS sandbox. */
export class OpenCodeRuntime {
  private readonly options: RuntimeOptions;
  private readonly startTimeout: number;
  private readonly shutdownTimeout: number;
  private queue: Promise<unknown> = Promise.resolve();
  private owned?: OwnedProcess;
  private startupAbort?: AbortController;
  private connection?: OpenCodeConnection;
  private acpConnection?: OpenCodeAcpConnection;
  private stopping = false;
  private monitor?: ReturnType<typeof setInterval>;

  constructor(options: RuntimeOptions = {}) {
    this.options = options;
    this.startTimeout = bounded(options.startTimeoutMs, 15_000);
    this.shutdownTimeout = bounded(options.shutdownTimeoutMs, 1000);
  }
  getConnection(): OpenCodeConnection | undefined { return this.connection && !this.stopping && !this.owned?.failed ? structuredClone(this.connection) : undefined; }
  getACPConnection(): OpenCodeAcpConnection | undefined { return this.acpConnection && !this.stopping && !this.owned?.failed && !this.acpConnection.rpc.signal.aborted ? this.acpConnection : undefined; }
  assertCurrent(connection: OpenCodeConnection): void {
    if (!this.connection || this.stopping || this.owned?.failed || !equals(this.connection, connection)) fail('runtime-stale', '执行器连接已失效，请明确重新连接；不会重发原请求。');
  }
  async start(raw: OpenCodeStartInput): Promise<OpenCodeConnection> {
    const input = validated(raw);
    return this.serial(async () => {
      if (this.stopping) return fail('runtime-stopping', '执行器正在关闭。');
      if (this.acpConnection) return fail('runtime-conflict', '当前使用 ACP 连接，请先明确关闭后再切换传输方式。');
      if (this.connection && this.owned) {
        if (!equals(input, this.owned.input)) return fail('runtime-conflict', '当前连接使用另一份模型快照，请先断开。');
        this.assertCurrent(this.connection); return structuredClone(this.connection);
      }
      if (this.owned) await this.closeOwned(this.owned);
      const { binary, root } = await this.allocate(input);
      const abort = new AbortController(); this.startupAbort = abort;
      const deadline = Date.now() + this.startTimeout;
      const timer = setTimeout(() => abort.abort(), this.startTimeout);
      const password = randomBytes(32).toString('base64url');
      try {
        const { env, logSink } = await environment(root, input, password);
        if (abort.signal.aborted || this.stopping) return fail('runtime-cancelled', '执行器连接准备已取消。');
        await this.verifyVersion(binary, env, root, input, logSink, abort);
        if (abort.signal.aborted) return fail('runtime-cancelled', '执行器连接准备已取消。');
        await verifyLogSink(logSink);
        const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--mdns=false'], { cwd: path.join(root, 'directory'), env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const owned = this.trackOwned(child, root, input, logSink, abort);
        child.stderr?.resume(); // Never expose child logs: they can contain credentials.
        const baseURL = await this.listener(owned, abort.signal);
        const runtimeID = randomUUID(), connectionGeneration = randomUUID();
        const connection: OpenCodeConnection = {
          baseURL, authorization: `Basic ${Buffer.from(`screendeck:${password}`).toString('base64')}`,
          runtimeID, connectionGeneration, directory: path.join(root, 'directory'), version: OPENCODE_VERSION,
          configDigest: createHash('sha256').update(JSON.stringify({ version: OPENCODE_VERSION, baseURL: input.provider.baseURL, modelID: input.provider.modelID, runtimeID, connectionGeneration })).digest('hex'),
          model: { provider_id: PROVIDER_ID, model_id: input.provider.modelID },
        };
        while (true) {
          try { await this.health(connection, abort.signal); break; }
          catch (error) { if (error instanceof OpenCodeRuntimeError && ['runtime-version', 'runtime-auth'].includes(error.code)) throw error; if (abort.signal.aborted || owned.failed || Date.now() >= deadline) throw error; await delay(40); }
        }
        await this.inspect(connection, input, abort.signal);
        await verifyLogSink(logSink);
        await rejectManagedConfiguration();
        if (abort.signal.aborted || owned.failed || this.stopping) return fail('runtime-cancelled', '执行器连接准备已取消或失效。');
        owned.connection = connection; this.connection = connection;
        let checking = false;
        this.monitor = setInterval(() => {
          if (checking || this.owned !== owned || !this.connection) return;
          checking = true;
          void Promise.all([this.health(connection, AbortSignal.timeout(1000)), verifyLogSink(logSink)]).catch(() => { this.invalidate(owned); void this.serial(async () => { if (this.owned === owned) await this.closeOwned(owned); }).catch(() => { /* Failed ownership is retained for an explicit stop retry. */ }); }).finally(() => { checking = false; });
        }, 1000);
        this.monitor.unref();
        return structuredClone(connection);
      } catch (error) {
        this.connection = undefined;
        if (this.owned?.root === root) {
          if (!(error instanceof OpenCodeRuntimeError && error.code === 'runtime-cleanup')) await this.closeOwned(this.owned);
        }
        else await this.removeRoot(root);
        if (error instanceof OpenCodeRuntimeError) throw error;
        return fail('runtime-start', '执行器初始化未通过，连接已关闭。');
      } finally { clearTimeout(timer); if (this.startupAbort === abort) this.startupAbort = undefined; }
    });
  }
  async startACP(raw: OpenCodeStartInput): Promise<OpenCodeAcpConnection> {
    const input = validated(raw);
    return this.serial(async () => {
      if (this.stopping) return fail('runtime-stopping', '执行器正在关闭。');
      if (this.connection) return fail('runtime-conflict', '当前使用 HTTP 连接，请先明确关闭后再切换传输方式。');
      if (this.acpConnection && this.owned && !this.owned.failed && !this.acpConnection.rpc.signal.aborted) {
        if (!equals(input, this.owned.input)) return fail('runtime-conflict', '当前连接使用另一份模型快照，请先断开。');
        return this.acpConnection;
      }
      if (this.owned) await this.closeOwned(this.owned);
      const { binary, root } = await this.allocate(input);
      const abort = new AbortController(); this.startupAbort = abort;
      const timer = setTimeout(() => abort.abort(), this.startTimeout);
      try {
        const { env, logSink } = await environment(root, input, randomBytes(32).toString('base64url'), true, this.options.nativeTools);
        if (abort.signal.aborted || this.stopping) return fail('runtime-cancelled', '执行器连接准备已取消。');
        await this.verifyVersion(binary, env, root, input, logSink, abort);
        if (abort.signal.aborted || this.stopping) return fail('runtime-cancelled', '执行器连接准备已取消。');
        const configText = await this.probe(binary, ['debug', 'config'], env, root, input, logSink, abort, MAX_RESPONSE, 'config');
        let config: unknown;
        try { config = JSON.parse(configText); } catch { return fail('runtime-config', '执行器有效配置预检未返回受控记录。'); }
        inspectConfig(config, input, true, this.options.nativeTools);
        await verifyLogSink(logSink);
        await rejectManagedConfiguration();
        if (abort.signal.aborted || this.stopping) return fail('runtime-cancelled', '执行器连接准备已取消。');
        const directory = path.join(root, 'directory');
        const child = spawn(binary, ['acp', '--cwd', directory, '--hostname', '127.0.0.1', '--port', '0', '--mdns=false'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        const owned = this.trackOwned(child, root, input, logSink, abort);
        child.stderr?.resume();
        child.stdin?.on('error', () => this.invalidate(owned));
        const subscribers = owned.subscribers = new Set<(event: OpenCodeAcpEvent) => Promise<void>>();
        let eventQueue = Promise.resolve();
        const publish = (event: OpenCodeAcpEvent): Promise<void> => {
          const next = eventQueue.then(async () => {
            for (const listener of subscribers) {
              if (owned.failed) return;
              await listener(structuredClone(event));
            }
          });
          eventQueue = next.catch(() => {});
          return next;
        };
        const permissions = new Set<(request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | undefined>();
        const app = client({ name: 'ScreenDeck' })
          .onNotification('session/update', notification, async ({ params }) => {
            try { await publish({ type: 'session-update', notification: params }); }
            catch { this.invalidate(owned); }
          })
          .onRequest('session/request_permission', permission, async ({ params }) => {
            if (this.options.nativeTools) {
              for (const handler of permissions) { const answer = handler(params); if (answer) return answer; }
              return { outcome: { outcome: 'cancelled' as const } };
            }
            const rejected = params.options.find(option => option.kind === 'reject_once');
            try { await publish({ type: 'forbidden-permission', request: params }); }
            catch { this.invalidate(owned); }
            return { outcome: rejected ? { outcome: 'selected' as const, optionId: rejected.optionId } : { outcome: 'cancelled' as const } };
          });
        for (const method of ['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'terminal/output', 'terminal/release', 'terminal/wait_for_exit', 'terminal/kill']) {
          app.onRequest(method, value => value, () => { throw new RequestError(-32601, 'ScreenDeck does not provide file or terminal access.'); });
        }
        const rpc = owned.rpc = app.connect(acpTransport(child));
        const disconnected = () => {
          this.invalidate(owned);
          void this.serial(async () => { if (this.owned === owned) await this.closeOwned(owned); }).catch(() => {});
        };
        rpc.signal.addEventListener('abort', disconnected, { once: true });
        const initialized = await this.beforeAbort(rpc.agent.request('initialize', {
          protocolVersion: 1, clientInfo: { name: 'ScreenDeck', version: '0.2.0-preview.1' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }), abort.signal);
        const info = object(initialized.agentInfo), capabilities = object(initialized.agentCapabilities);
        if (initialized.protocolVersion !== 1 || info.name !== 'OpenCode' || info.version !== OPENCODE_VERSION || capabilities.loadSession !== true) return fail('runtime-acp-version', 'ACP 版本或所需能力不匹配，本版仅支持 OpenCode 1.19.0 / ACP v1。');
        await verifyLogSink(logSink);
        await rejectManagedConfiguration();
        if (owned.failed || rpc.signal.aborted || abort.signal.aborted || this.stopping) throw acpFailure();
        const runtimeID = randomUUID(), connectionGeneration = randomUUID();
        const connection: OpenCodeAcpConnection = Object.freeze({
          nativeTools: this.options.nativeTools === true,
          onPermission: (handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse> | undefined) => { permissions.add(handler); return () => { permissions.delete(handler); }; },
          runtimeID, connectionGeneration, directory, version: OPENCODE_VERSION,
          configDigest: createHash('sha256').update(JSON.stringify({ transport: 'acp', version: OPENCODE_VERSION, baseURL: input.provider.baseURL, modelID: input.provider.modelID, runtimeID, connectionGeneration })).digest('hex'),
          model: Object.freeze({ provider_id: PROVIDER_ID, model_id: input.provider.modelID }), rpc,
          subscribe: (listener: (event: OpenCodeAcpEvent) => Promise<void>) => {
            if (this.owned !== owned || owned.failed || rpc.signal.aborted || typeof listener !== 'function' || subscribers.size >= 32) throw acpFailure();
            subscribers.add(listener);
            return () => { subscribers.delete(listener); };
          },
        });
        this.acpConnection = connection;
        let checking = false;
        this.monitor = setInterval(() => {
          if (checking || this.owned !== owned || !this.acpConnection) return;
          checking = true;
          void verifyLogSink(logSink).catch(disconnected).finally(() => { checking = false; });
        }, 1000);
        this.monitor.unref();
        return connection;
      } catch (error) {
        this.acpConnection = undefined;
        if (this.owned?.root === root) {
          if (!(error instanceof OpenCodeRuntimeError && error.code === 'runtime-cleanup')) await this.closeOwned(this.owned);
        } else await this.removeRoot(root);
        if (error instanceof OpenCodeRuntimeError) throw error;
        throw acpFailure();
      } finally { clearTimeout(timer); if (this.startupAbort === abort) this.startupAbort = undefined; }
    });
  }
  private async allocate(input: OpenCodeStartInput): Promise<{ binary: string; root: string }> {
    await rejectManagedConfiguration();
    const binary = await realpath(input.binaryPath).catch(() => fail('runtime-binary', '执行器文件不可读。'));
    const stat = await lstat(input.binaryPath).catch(() => fail('runtime-binary', '执行器文件不可读。'));
    if (!stat.isFile() || stat.isSymbolicLink() || binary !== input.binaryPath) return fail('runtime-binary', '执行器必须是确切的普通文件。');
    await access(binary, constants.X_OK).catch(() => fail('runtime-binary', '执行器文件不可执行。'));
    const parent = this.options.root ? await realpath(this.options.root) : await realpath(tmpdir());
    const root = await mkdtemp(path.join(parent, 'screendeck-opencode-'));
    await chmod(root, 0o700);
    return { binary, root };
  }
  private async beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let cancelled!: () => void;
    const cancellation = new Promise<never>((_, reject) => { cancelled = () => reject(new OpenCodeRuntimeError('runtime-cancelled', '执行器初始化已取消或超时。')); signal.addEventListener('abort', cancelled, { once: true }); if (signal.aborted) cancelled(); });
    try { return await Promise.race([operation, cancellation]); }
    finally { signal.removeEventListener('abort', cancelled); }
  }
  stop(): Promise<void> {
    this.stopping = true; this.connection = undefined; this.acpConnection = undefined; this.startupAbort?.abort(); this.owned?.abort.abort();
    return this.serial(async () => { try { if (this.owned) await this.closeOwned(this.owned); } finally { this.stopping = false; } });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.catch(() => {}); return result; }
  private invalidate(owned: OwnedProcess) {
    owned.failed = true;
    owned.subscribers?.clear();
    if (owned.rpc && !owned.rpc.signal.aborted) owned.rpc.close(acpFailure());
    if (this.owned === owned) { this.connection = undefined; this.acpConnection = undefined; if (this.monitor) clearInterval(this.monitor); this.monitor = undefined; }
  }
  private trackOwned(child: ChildProcess, root: string, input: OpenCodeStartInput, logSink: LogSink, abort: AbortController): OwnedProcess {
    let finished!: () => void;
    const closed = new Promise<void>(resolve => { finished = resolve; });
    const owned: OwnedProcess = { child, closed, abort, root, configDirectory: path.join(root, 'config', 'opencode'), input, failed: false, exited: false, logSink };
    this.owned = owned;
    child.once('exit', () => { owned.exited = true; finished(); this.invalidate(owned); });
    child.on('error', () => {
      // A failed spawn has no PID; a later kill error does not confirm exit.
      if (child.pid === undefined) { owned.exited = true; finished(); }
      this.invalidate(owned);
    });
    return owned;
  }
  private async removeRoot(root: string) {
    await chmod(path.join(root, 'config', 'opencode'), 0o700).catch(() => {});
    await chmod(path.join(root, 'data', 'opencode', 'log'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => fail('runtime-cleanup', '执行器已关闭，但临时目录清理尚未确认。'));
  }
  private async closeOwned(owned: OwnedProcess) {
    this.invalidate(owned); owned.abort.abort();
    if (!owned.exited) {
      owned.child.kill('SIGTERM');
      await Promise.race([owned.closed, delay(this.shutdownTimeout)]);
      if (!owned.exited) { owned.child.kill('SIGKILL'); await Promise.race([owned.closed, delay(this.shutdownTimeout)]); }
    }
    if (!owned.exited) return fail('runtime-cleanup', '执行器进程退出尚未确认；临时目录已保留，请重试关闭。');
    await this.removeRoot(owned.root);
    if (this.owned === owned) this.owned = undefined;
  }
  private async verifyVersion(binary: string, env: NodeJS.ProcessEnv, root: string, input: OpenCodeStartInput, logSink: LogSink, abort: AbortController) {
    const text = await this.probe(binary, ['--version'], env, root, input, logSink, abort, 256, 'version');
    if (text.trim() !== OPENCODE_VERSION) return fail('runtime-version', '执行器版本不匹配，本版仅支持 1.19.0。');
  }
  private async probe(binary: string, args: string[], env: NodeJS.ProcessEnv, root: string, input: OpenCodeStartInput, logSink: LogSink, abort: AbortController, maximum: number, kind: 'version' | 'config'): Promise<string> {
    const signal = abort.signal;
    const child = spawn(binary, args, { cwd: path.join(root, 'directory'), env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const owned = this.trackOwned(child, root, input, logSink, abort);
    child.stderr?.resume();
    let text = '';
    let cancel: (() => void) | undefined;
    try { await new Promise<void>((resolve, reject) => {
      cancel = () => { child.kill('SIGKILL'); reject(new OpenCodeRuntimeError('runtime-cancelled', '执行器初始化预检已取消或超时。')); };
      signal.addEventListener('abort', cancel, { once: true });
      child.stdout?.on('data', chunk => { if (Buffer.byteLength(text) + chunk.length > maximum) { child.kill('SIGKILL'); reject(new OpenCodeRuntimeError('runtime-output', '执行器初始化预检输出超过限制。')); return; } text += String(chunk); });
      child.once('error', () => reject(new OpenCodeRuntimeError('runtime-binary', '执行器初始化预检失败。')));
      child.once('exit', code => { if (code === 0) resolve(); else reject(new OpenCodeRuntimeError(kind === 'version' ? 'runtime-version' : 'runtime-config', '执行器初始化预检未通过。')); });
      if (signal.aborted) cancel();
    }); return text; } finally {
      if (cancel) signal.removeEventListener('abort', cancel);
      if (!owned.exited) { child.kill('SIGKILL'); await Promise.race([owned.closed, delay(this.shutdownTimeout)]); }
      if (!owned.exited) { this.invalidate(owned); return fail('runtime-cleanup', kind === 'version' ? '执行器版本探针退出尚未确认；临时目录已保留，请重试关闭。' : '执行器配置探针退出尚未确认；临时目录已保留，请重试关闭。'); }
      if (this.owned === owned) this.owned = undefined;
    }
  }
  private listener(owned: OwnedProcess, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let text = '';
      const finish = (error?: Error, url?: string) => { signal.removeEventListener('abort', cancel); owned.child.stdout?.removeListener('data', receive); owned.child.stdout?.resume(); owned.child.removeListener('exit', exit); owned.child.removeListener('error', exit); if (error) reject(error); else resolve(url!); };
      const cancel = () => finish(new OpenCodeRuntimeError('runtime-cancelled', '执行器启动已取消或超时。'));
      const exit = () => finish(new OpenCodeRuntimeError('runtime-exit', '执行器在连接就绪前退出。'));
      const receive = (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (Buffer.byteLength(text) > 32_768) return finish(new OpenCodeRuntimeError('runtime-output', '执行器启动输出超过限制。'));
        const match = /(?:^|\n)opencode server listening on (http:\/\/127\.0\.0\.1:([0-9]+))\s*(?:\n|$)/.exec(text);
        if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) finish(undefined, match[1]);
      };
      signal.addEventListener('abort', cancel, { once: true }); owned.child.once('exit', exit); owned.child.once('error', exit); owned.child.stdout?.on('data', receive);
      if (signal.aborted) cancel(); else if (owned.failed) exit();
    });
  }
  private async request(connection: OpenCodeConnection, route: string, signal: AbortSignal, authenticate = true): Promise<{ status: number; value: unknown }> {
    const response = await fetch(`${connection.baseURL}${route}`, { signal, redirect: 'error', headers: { Accept: 'application/json', 'x-opencode-directory': encodeURIComponent(connection.directory), ...(authenticate ? { Authorization: connection.authorization } : {}) } });
    const reader = response.body?.getReader(); let length = 0, text = '';
    try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > MAX_RESPONSE) return fail('runtime-contract', '执行器初始化记录超过容量限制。'); text += Buffer.from(chunk.value).toString('utf8'); } }
    finally { await reader?.cancel().catch(() => {}); }
    if (!authenticate) return { status: response.status, value: undefined };
    if (response.status !== 200) return fail('runtime-response', '执行器初始化请求未获确认。');
    try { return { status: response.status, value: JSON.parse(text) }; } catch { return fail('runtime-contract', '执行器初始化记录无效。'); }
  }
  private async health(connection: OpenCodeConnection, signal: AbortSignal) {
    const value = object((await this.request(connection, '/global/health', signal)).value);
    if (value.version !== OPENCODE_VERSION) fail('runtime-version', '执行器健康检查版本不匹配。');
    if (value.healthy !== true) fail('runtime-response', '执行器尚未就绪。');
  }
  private async inspect(connection: OpenCodeConnection, input: OpenCodeStartInput, signal: AbortSignal) {
    if ((await this.request(connection, '/global/health', signal, false)).status !== 401) fail('runtime-auth', '执行器未强制认证，连接已拒绝。');
    inspectConfig((await this.request(connection, '/config', signal)).value, input);
    const available = object((await this.request(connection, '/provider', signal)).value);
    const all = available.all;
    if (!Array.isArray(all) || all.length !== 1 || !equals(available.connected, [PROVIDER_ID])) return fail('runtime-provider', '执行器未确认唯一的受控模型连接。');
    const active = object(all[0]), activeModels = object(active.models), model = object(activeModels[input.provider.modelID]);
    if (active.id !== PROVIDER_ID || Object.keys(activeModels).length !== 1 || model.id !== input.provider.modelID || object(model.api).npm !== SDK) fail('runtime-provider', '执行器模型能力与受控配置不一致。');
  }
}
