// Generated Node executable for isolated tests only. No OpenCode, model or tools.
// The smoke embeds the stable SDK entry URL in its generated executable.
import { accessSync, constants, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

const countsFile = path.join(path.dirname(process.argv[1]), 'runtime-counts.json');
let counts;
try { counts = JSON.parse(readFileSync(countsFile, 'utf8')); } catch {
  counts = { versionChecks: 0, configChecks: 0, acpStarts: 0, initializes: 0, sessionCreates: 0, modelSelections: 0, promptSubmissions: 0, promptCompletions: 0, cancelNotifications: 0, cancelledResponses: 0, failures: 0, refusals: 0, disconnects: 0, loadCalls: 0, externalModelRequests: 0, legacyBindingSeen: false, stopped: 0, protocolProblems: [] };
}
const save = () => { writeFileSync(countsFile + '.tmp', JSON.stringify(counts)); renameSync(countsFile + '.tmp', countsFile); };
if (process.argv.includes('--version')) { counts.versionChecks++; save(); console.log('1.19.0'); process.exit(0); }
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT.replace(/\{env:SCREENDECK_LLM_API_KEY\}/g, () => process.env.SCREENDECK_LLM_API_KEY));
config.command = {};
config.agent.build = { options: {}, ...config.agent.build };
config.mode = {};
if (process.argv.includes('debug') && process.argv.includes('config')) {
  counts.configChecks++; save();
  const redacted = structuredClone(config);
  redacted.provider.screendeck.options.apiKey = '***';
  console.log(JSON.stringify(redacted)); process.exit(0);
}
if (!process.argv.includes('acp')) throw new Error('ACP GUI fixture only accepts version, debug config or acp.');
const directory = process.cwd(), runtimeRoot = path.dirname(directory);
let configurationWritable = false;
try { accessSync(process.env.OPENCODE_CONFIG_DIR, constants.W_OK); configurationWritable = true; } catch { /* expected */ }
counts.acpStarts++;
counts.controls = {
  independentHome: process.env.HOME?.startsWith(runtimeRoot + path.sep) === true,
  independentXDG: ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].every(key => process.env[key]?.startsWith(runtimeRoot + path.sep)),
  configurationWritable,
  toolPolicyDenied: config.permission?.['*'] === 'deny' && config.agent.build.permission?.['*'] === 'deny',
  titleDisabled: config.agent.title.disable === true,
  discoveryDisabled: ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE'].every(key => process.env[key] === 'true'),
  inheritedSensitiveEnvironment: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'BUN_OPTIONS', 'HTTPS_PROXY', 'OPENCODE_CONFIG'].some(key => process.env[key] !== undefined),
  providerURL: config.provider.screendeck.options.baseURL,
};
save();
globalThis.fetch = async () => { counts.externalModelRequests++; save(); throw new Error('ACP GUI fixture forbids network.'); };
const { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } = await import(globalThis.__SCREENDECK_ACP_FIXTURE_SDK_URL ?? '@agentclientprotocol/sdk');
if (PROTOCOL_VERSION !== 1) throw new Error('ACP fixture requires the stable v1 SDK entry.');
const sessions = new Map(), pending = new Map();
const modelOptions = () => [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: config.model, options: [{ value: config.model, name: config.model }] }];
const modes = { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] };
const noteID = id => { if (typeof id === 'string' && id.startsWith('legacy_')) { counts.legacyBindingSeen = true; save(); } };
const getSession = id => { noteID(id); const session = sessions.get(id); if (!session) throw new RequestError(-32602, 'Unknown fixture session.'); return session; };
const chunk = async (ctx, sessionId, text) => ctx.client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: sessions.get(sessionId)?.messageID, content: { type: 'text', text } } });
let connection;
const app = agent({ name: 'screendeck-acp-gui-fixture' })
  .onRequest(methods.agent.initialize, ctx => {
    counts.initializes++; counts.clientCapabilities = ctx.params.clientCapabilities ?? {}; save();
    if (ctx.params.protocolVersion !== 1) throw new RequestError(-32602, 'Stable ACP v1 required.');
    return { protocolVersion: 1, agentInfo: { name: 'OpenCode', version: '1.19.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } }, authMethods: [] };
  })
  .onRequest(methods.agent.session.new, ctx => {
    if (ctx.params.cwd !== directory || ctx.params.mcpServers.length !== 0) { counts.protocolProblems.push('Unexpected session directory or MCP.'); save(); throw new RequestError(-32602, 'Uncontrolled session.'); }
    const sessionId = 'acp_fixture_' + randomUUID();
    sessions.set(sessionId, { output: '', selected: false }); counts.sessionCreates++; save();
    return { sessionId, modes, configOptions: modelOptions() };
  })
  .onRequest(methods.agent.session.setConfigOption, ctx => {
    const session = getSession(ctx.params.sessionId);
    if (ctx.params.configId !== 'model' || ctx.params.value !== config.model) throw new RequestError(-32602, 'Unexpected fixture model.');
    session.selected = true; counts.modelSelections++; save();
    return { configOptions: modelOptions() };
  })
  .onRequest(methods.agent.session.load, async ctx => {
    counts.loadCalls++; save(); const session = getSession(ctx.params.sessionId);
    if (session.output) await chunk(ctx, ctx.params.sessionId, session.output);
    return { modes, configOptions: modelOptions() };
  })
  .onRequest(methods.agent.session.prompt, async ctx => {
    const session = getSession(ctx.params.sessionId);
    if (!session.selected || !Array.isArray(ctx.params.prompt) || ctx.params.prompt.length !== 1 || ctx.params.prompt[0].type !== 'text' || pending.has(ctx.params.sessionId)) {
      counts.protocolProblems.push('Unexpected prompt shape, model or concurrency.'); save(); throw new RequestError(-32602, 'Invalid fixture prompt.');
    }
    const text = ctx.params.prompt[0].text;
    session.messageID = 'assistant_' + randomUUID();
    counts.prompts ??= []; counts.prompts.push({ sessionID: ctx.params.sessionId, text });
    counts.promptSubmissions++; counts.lastPrompt = { input: text, partCount: ctx.params.prompt.length, model: config.model, hasMessageID: 'messageId' in ctx.params || 'messageID' in ctx.params }; save();
    if (text.includes('[fixture:refusal]')) { counts.refusals++; counts.promptCompletions++; save(); return { stopReason: 'refusal' }; }
    if (text.includes('[fixture:failure]')) { counts.failures++; save(); throw new RequestError(-32603, 'Synthetic ACP failure ' + config.provider.screendeck.options.apiKey); }
    if (text.includes('[fixture:disconnect]')) {
      await chunk(ctx, ctx.params.sessionId, 'ACP 断线前的合成片段。');
      counts.disconnects++; save(); setTimeout(() => { connection.close(); process.stdin.destroy(); process.stdout.end(() => process.exit(0)); }, 20);
      return new Promise(() => {});
    }
    if (text.includes('[fixture:hold]')) {
      await chunk(ctx, ctx.params.sessionId, 'ACP 等待取消的合成片段。');
      const stopReason = await new Promise(resolve => pending.set(ctx.params.sessionId, resolve));
      pending.delete(ctx.params.sessionId); counts.cancelledResponses++; counts.promptCompletions++; save();
      return { stopReason };
    }
    session.output = 'ACP GUI 夹具文本成果：建议先明确目标和验收条件。这里没有真实模型、文件或命令调用。';
    await chunk(ctx, ctx.params.sessionId, session.output);
    counts.promptCompletions++; save(); return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, ctx => {
    noteID(ctx.params.sessionId); counts.cancelNotifications++; save();
    pending.get(ctx.params.sessionId)?.('cancelled');
  });
connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
let stopping = false;
const stop = () => { if (stopping) return; stopping = true; counts.stopped++; save(); connection.close(); process.stdin.destroy(); };
process.on('SIGTERM', stop);
await connection.closed;
stop(); process.exit(0);
