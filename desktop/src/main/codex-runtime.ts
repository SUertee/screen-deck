import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCodexExecutable } from './codex-discovery.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CodexStatus } from '../shared/desktop-api.js';
import { codexObject, codexID, type CodexConnection } from '../core/agents/codex/codex-connection.js';
import { checkDirectories, readBytes, atomicReplace, withExclusiveLock } from '../core/storage/private-storage.js';
import { CodexRPC } from './codex-rpc.js';
export const CODEX_VERSION = '0.133.0';
export const CODEX_TEXT_MODEL = 'gpt-5.5';
/** Fixed 0.133.0 text profile; not an entitlement claim or a replacement for native coding mode. */
export function codexTextCatalog(modelID = CODEX_TEXT_MODEL) {
  return { models: [{ slug: modelID, display_name: modelID, description: 'ScreenDeck text chat', shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 0, availability_nux: null, upgrade: null, base_instructions: 'You are Codex in ScreenDeck. Answer the user in text. This connection has no file, command, web or agent tools. Do not claim to have accessed local files.', supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }], default_reasoning_level: 'medium', supports_reasoning_summaries: true, support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null, truncation_policy: { mode: 'tokens', limit: 10000 }, supports_parallel_tool_calls: false, experimental_supported_tools: [], supports_search_tool: false, input_modalities: ['text'] }] };
}

const exec = promisify(execFile);
/** Explicit connection only. Native Codex owns OAuth in this app's separate CODEX_HOME. */
export class CodexRuntime {
  private rpc?: CodexRPC;
  private connection?: CodexConnection;
  private status: CodexStatus = { state: 'stopped' };
  private loginID?: string;
  private active = false;
  private generation = 0;
  private refreshing?: Promise<CodexStatus>;
  private binary?: string;
  private textRuntime?: CodexRuntime;
  private textParent?: CodexConnection;
  private textStarting?: Promise<void>;
  constructor(private root: string, private changed: () => void, private openLogin: (url: string) => Promise<void>, private options: { nativeTools?: boolean; credentialHome?: string; textModelID?: string } = {}) {}
  getStatus(): CodexStatus { return structuredClone(this.status); }
  getConnection(): CodexConnection | undefined { return this.connection; }
  getTextConnection(): CodexConnection | undefined { return this.connection && this.textParent === this.connection ? this.textRuntime?.getConnection() : undefined; }
  prepareText(): Promise<void> {
    if (this.getTextConnection()) return Promise.resolve();
    if (this.textStarting) return this.textStarting;
    const operation = this.startText(); this.textStarting = operation;
    void operation.finally(() => { if (this.textStarting === operation) this.textStarting = undefined; }).catch(() => {});
    return operation;
  }
  private async startText(): Promise<void> {
    const parent = this.connection, status = this.getStatus();
    if (!this.options.nativeTools || !parent || !this.binary || status.state !== 'ready') throw new Error('请先连接并登录 Codex。');
    await this.textRuntime?.stop();
    const child = new CodexRuntime(path.join(this.root, 'text-profile'), this.changed, async () => { throw new Error('聊天通道不单独发起登录。'); }, { credentialHome: path.join(this.root, 'home'), textModelID: parent.model.model_id });
    this.textRuntime = child;
    try {
      const actual = await child.start(this.binary);
      if (this.connection !== parent || actual.state !== 'ready' || actual.account !== status.account || actual.model !== parent.model.model_id) throw new Error('Codex 聊天连接未确认，请刷新或重新连接。');
      this.textParent = parent;
    } catch (error) { await child.stop(); throw error; }
  }
  private update(status: CodexStatus): void { this.status = status; this.changed(); }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('正在处理 Codex 连接，请稍后重试。');
    this.active = true; try { return await fn(); } finally { this.active = false; }
  }
  async start(binaryPath: string): Promise<CodexStatus> {
    return this.exclusive(async () => {
      if (this.rpc) return this.getStatus();
      const generation = ++this.generation;
      if (!path.isAbsolute(binaryPath) || binaryPath.includes('\0')) throw new Error('请选择 Codex 可执行文件。');
      const binary = await resolveCodexExecutable(binaryPath);
      this.binary = binary;
      const home = this.options.credentialHome ?? path.join(this.root, 'home'), directory = path.join(this.root, 'workspace');
      for (const dir of [this.root, home, directory, path.join(this.root, 'host-home')]) await checkDirectories(dir, true);
      // Allow only process essentials/proxy/cert settings, never inherited API keys, CODEX_HOME or startup hooks.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key];
      env.CODEX_HOME = home; env.HOME = path.join(this.root, 'host-home');
      env.XDG_CONFIG_HOME = path.join(env.HOME, '.config'); env.XDG_DATA_HOME = path.join(env.HOME, '.local/share'); env.XDG_CACHE_HOME = path.join(env.HOME, '.cache');
      const version = await exec(binary, ['--version'], { env, cwd: directory, timeout: 5000, maxBuffer: 4096 }).catch(() => { throw new Error('Codex 程序无法运行，请检查安装位置。'); });
      if (generation !== this.generation) throw new Error('Codex 连接准备已取消。');
      if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error(`当前接入支持 Codex CLI ${CODEX_VERSION}，请指定兼容版本。`);
      const catalogPath = path.join(this.root, 'text-models.json');
      if (!this.options.nativeTools) await withExclusiveLock(catalogPath + '.lock', async () => { const prior = await readBytes(catalogPath, 128_000); await atomicReplace(catalogPath, Buffer.from(JSON.stringify(codexTextCatalog(this.options.textModelID ?? CODEX_TEXT_MODEL))), prior, 128_000); });
      // Dedicated profile: no inherited user config, MCP, hooks, apps, skills or project instructions.
      const args = ['app-server', ...(this.options.nativeTools ? [] : ['-c', `model_catalog_json=${JSON.stringify(catalogPath)}`]), '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"', '-c', `approval_policy="${this.options.nativeTools ? 'on-request' : 'never'}"`, '-c', `sandbox_mode="${this.options.nativeTools ? 'workspace-write' : 'read-only'}"`, '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'tools.view_image=false', '-c', 'mcp_servers={}', '-c', 'skills.config=[]', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.network_access=false'];
      for (const key of ['shell_tool', 'shell_snapshot', 'apps', 'plugins', 'hooks', 'plugin_hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'image_generation', 'goals', 'code_mode', 'code_mode_only', 'artifact', 'workspace_dependencies', 'skill_mcp_dependency_install', 'request_permissions_tool', 'tool_suggest']) args.push('-c', `features.${key}=${this.options.nativeTools && key === 'shell_tool' ? 'true' : 'false'}`);
      const child = spawn(binary, args, { env, cwd: directory, stdio: 'pipe', shell: false });
      const rpc = new CodexRPC(child, () => { if (this.rpc === rpc) { this.rpc = undefined; this.connection = undefined; this.loginID = undefined; void this.textRuntime?.stop(); this.update({ state: 'stopped' }); } });
      this.rpc = rpc;
      rpc.subscribe(event => {
        if (event.method === 'account/login/completed' && event.params.loginId === this.loginID) {
          this.loginID = undefined;
          void this.refresh().catch(() => this.update({ state: 'login-required', version: CODEX_VERSION }));
        } else if (event.method === 'account/updated') {
          void this.textRuntime?.stop();
          this.connection = undefined;
          void this.refresh().catch(() => { if (this.rpc === rpc) this.update({ state: 'login-required', version: CODEX_VERSION }); });
        }
      });
      try {
        await rpc.request('initialize', { clientInfo: { name: 'screendeck', title: 'ScreenDeck', version: '0.2.0' }, capabilities: null }); rpc.notify('initialized');
        this.update({ state: 'login-required', version: CODEX_VERSION }); await this.refresh();
      } catch { rpc.close(); throw new Error('Codex app-server 初始化失败，请检查程序版本。'); }
      return this.getStatus();
    });
  }
  refresh(): Promise<CodexStatus> {
    if (this.refreshing) return this.refreshing;
    const rpc = this.rpc;
    const operation = this.readAccount().catch(error => { if (rpc && rpc === this.rpc) { this.connection = undefined; this.update({ state: 'login-required', version: CODEX_VERSION }); } throw error; });
    this.refreshing = operation;
    void operation.finally(() => { if (this.refreshing === operation) this.refreshing = undefined; }).catch(() => {});
    return operation;
  }
  private async readAccount(): Promise<CodexStatus> {
    const rpc = this.rpc; if (!rpc) return this.getStatus();
    const result = codexObject(await rpc.request('account/read', { refreshToken: false }));
    if (rpc !== this.rpc) return this.getStatus();
    if (result.account === null) {
      this.connection = undefined;
      this.update({ state: this.loginID ? 'logging-in' : 'login-required', version: CODEX_VERSION }); return this.getStatus();
    }
    const account = codexObject(result.account);
    if (account.type !== 'chatgpt') { this.connection = undefined; throw new Error('此接入仅使用 ChatGPT 登录，请在独立 Codex 目录中登录。'); }
    if (typeof account.email !== 'string' || account.email.length > 320 || /[\x00-\x1f]/.test(account.email)) throw new Error('Codex 账户响应无效。');
    const models = codexObject(await rpc.request('model/list', { includeHidden: false }));
    if (!Array.isArray(models.data)) throw new Error('Codex 模型列表无效。');
    const list = models.data.map(codexObject), chosen = list.find(model => model.isDefault === true && model.hidden !== true) ?? list.find(model => model.hidden !== true);
    if (!chosen) throw new Error('当前 Codex 账户未提供可用模型。');
    const modelID = codexID(chosen.model);
    if (!this.options.nativeTools && modelID !== (this.options.textModelID ?? CODEX_TEXT_MODEL)) throw new Error('Codex 实际文本模型不匹配，请重新连接。');
    if (rpc !== this.rpc) return this.getStatus();
    const email = account.email, digest = createHash('sha256').update(JSON.stringify({ version: CODEX_VERSION, email, modelID, profile: this.options.nativeTools ? 'native-v1' : 'text-v1' })).digest('hex');
    const previous = this.connection;
    this.connection = previous?.configDigest === digest ? previous : { runtimeID: previous?.runtimeID ?? randomUUID(), connectionGeneration: previous?.configDigest === digest ? previous.connectionGeneration : randomUUID(), configDigest: digest, ownedWriteRoots: [path.join(this.root, 'home', 'memories')], directory: path.join(this.root, 'workspace'), model: { provider_id: 'openai', model_id: modelID }, request: (method, params) => rpc.request(method, params), subscribe: rpc.subscribe, onServerRequest: rpc.onServerRequest };
    this.loginID = undefined;
    this.update({ state: 'ready', version: CODEX_VERSION, account: email, model: modelID });
    return this.getStatus();
  }
  async login(): Promise<CodexStatus> {
    return this.exclusive(async () => {
      const rpc = this.rpc; if (!rpc) throw new Error('请先连接 Codex。');
      if (this.connection || this.loginID) return this.getStatus();
      const response = codexObject(await rpc.request('account/login/start', { type: 'chatgpt' }));
      if (response.type !== 'chatgpt') throw new Error('Codex 登录响应无效。');
      const loginID = codexID(response.loginId); let url: URL;
      try { url = new URL(String(response.authUrl)); } catch { throw new Error('Codex 登录地址无效。'); }
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname) || url.port || url.username || url.password || url.href.length > 16_384) { await rpc.request('account/login/cancel', { loginId: loginID }); throw new Error('Codex 返回了非官方登录地址。'); }
      this.loginID = loginID; this.update({ state: 'logging-in', version: CODEX_VERSION });
      try { await this.openLogin(url.href); }
      catch { await this.cancelLogin(); throw new Error('登录页面未能打开，请重新登录。'); }
      return this.getStatus();
    });
  }
  async cancelLogin(): Promise<CodexStatus> {
    const rpc = this.rpc, loginId = this.loginID;
    if (rpc && loginId) await rpc.request('account/login/cancel', { loginId });
    this.loginID = undefined; if (rpc) await this.refresh(); return this.getStatus();
  }
  async stop(): Promise<CodexStatus> { this.generation++; const rpc = this.rpc; rpc?.close(); await this.textRuntime?.stop(); await this.textStarting?.catch(() => {}); if (rpc) await rpc.shutdown(); return this.getStatus(); }
}
