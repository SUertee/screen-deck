// Local GUI fixture only: never imports OpenCode or contacts a provider.
// The smoke copies this file to a temporary executable with an absolute Node shebang.
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { accessSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const root = path.dirname(process.argv[1]);
const countsFile = path.join(root, 'runtime-counts.json');
let counts;
try { counts = JSON.parse(readFileSync(countsFile, 'utf8')); } catch { counts = { versionChecks: 0, runtimeStarts: 0, sessionCreates: 0, eventConnections: 0, promptSubmissions: 0, aborts: 0, externalModelRequests: 0, unexpectedRoutes: 0, directoryMismatches: 0, stopped: 0 }; }
const save = () => { writeFileSync(countsFile + '.tmp', JSON.stringify(counts)); renameSync(countsFile + '.tmp', countsFile); };
if (process.argv.includes('--version')) { counts.versionChecks++; save(); console.log('1.19.0'); process.exit(0); }

const directory = process.cwd();
const runtimeRoot = path.dirname(directory);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT.replace(/\{env:SCREENDECK_LLM_API_KEY\}/g, () => process.env.SCREENDECK_LLM_API_KEY));
// The fixed official version normalizes these two empty values.
config.command = {}; config.agent.build = { options: {}, ...config.agent.build };
let configurationWritable = false;
try { accessSync(process.env.OPENCODE_CONFIG_DIR, constants.W_OK); configurationWritable = true; } catch { /* required */ }
counts.runtimeStarts++;
counts.controls = {
  independentHome: process.env.HOME.startsWith(runtimeRoot + path.sep),
  independentXDG: ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].every(key => process.env[key]?.startsWith(runtimeRoot + path.sep)),
  configurationWritable,
  discoveryDisabled: ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE'].every(key => process.env[key] === 'true'),
  inheritedSensitiveEnvironment: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'BUN_OPTIONS', 'HTTPS_PROXY', 'OPENCODE_CONFIG'].some(key => process.env[key] !== undefined),
  providerURL: config.provider.screendeck.options.baseURL,
};
save();
// An accidental provider fetch from this fixture is always a failure, never an external call.
globalThis.fetch = async () => { counts.externalModelRequests++; save(); throw new Error('GUI fixture forbids model and external network calls.'); };
const authorization = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const sessions = new Map(), streams = new Set(); let serial = 0;
const emit = (type, properties = {}) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ id: `evt_${++serial}`, type, properties })}\n\n`); };
const nativeID = prefix => `${prefix}_${Date.now().toString(16)}${randomBytes(7).toString('hex')}`;
const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
  const requestedDirectory = url.searchParams.get('directory') ?? decodeURIComponent(request.headers['x-opencode-directory'] ?? '');
  if (requestedDirectory !== directory) { counts.directoryMismatches++; save(); json(response, {}, 400); return; }
  const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  let body;
  try { if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString()); } catch { json(response, {}, 400); return; }
  if (url.pathname === '/global/health') { json(response, { healthy: true, version: '1.19.0' }); return; }
  if (url.pathname === '/config') { json(response, { ...config, mode: {} }); return; }
  if (url.pathname === '/provider') {
    const modelID = config.model.slice('screendeck/'.length);
    json(response, { all: [{ id: 'screendeck', models: { [modelID]: { id: modelID, api: { npm: '@ai-sdk/openai-compatible', url: config.provider.screendeck.api } } } }], connected: ['screendeck'], default: { screendeck: modelID } }); return;
  }
  if (url.pathname === '/event') {
    counts.eventConnections++; save();
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); streams.add(response);
    response.write(`data: ${JSON.stringify({ id: `evt_${++serial}`, type: 'server.connected', properties: {} })}\n\n`);
    response.on('close', () => streams.delete(response)); return;
  }
  if (url.pathname === '/session' && request.method === 'POST') {
    if (JSON.stringify(body?.permission) !== JSON.stringify([{ permission: '*', pattern: '*', action: 'deny' }])) { json(response, {}, 400); return; }
    const record = { id: nativeID('ses'), directory, permission: body.permission };
    sessions.set(record.id, { record, messages: [], status: 'idle' }); counts.sessionCreates++; save(); json(response, record); return;
  }
  if (url.pathname === '/session/status') { json(response, Object.fromEntries([...sessions].filter(([, entry]) => entry.status !== 'idle').map(([id, entry]) => [id, { type: entry.status }]))); return; }
  const match = /^\/session\/(ses_[A-Za-z0-9]+)(?:\/(message|prompt_async|abort))?$/.exec(url.pathname);
  const entry = match && sessions.get(match[1]);
  if (entry && !match[2]) { json(response, entry.record); return; }
  if (entry && match[2] === 'message') { json(response, entry.messages); return; }
  if (entry && match[2] === 'abort') { counts.aborts++; save(); json(response, true); return; }
  if (entry && match[2] === 'prompt_async' && request.method === 'POST') {
    if (entry.messages.length || JSON.stringify(body?.tools) !== JSON.stringify({ '*': false }) || body?.model?.providerID !== 'screendeck' || body?.model?.modelID !== config.model.slice('screendeck/'.length) || !Array.isArray(body?.parts) || body.parts.length !== 1 || body.parts[0].type !== 'text') { json(response, {}, 409); return; }
    const sessionID = entry.record.id, messageID = body.messageID, created = Date.now(), assistantID = nativeID('msg');
    const user = { info: { id: messageID, sessionID, role: 'user', time: { created }, model: body.model }, parts: [{ id: nativeID('prt'), sessionID, messageID, type: 'text', text: body.parts[0].text }] };
    const assistant = { info: { id: assistantID, sessionID, role: 'assistant', parentID: messageID, providerID: body.model.providerID, modelID: body.model.modelID, time: { created: created + 1 } }, parts: [{ id: nativeID('prt'), sessionID, messageID: assistantID, type: 'text', text: '' }] };
    entry.messages = [user, assistant]; entry.status = 'busy'; counts.promptSubmissions++;
    counts.prompt = { messageID, model: body.model, tools: body.tools, input: body.parts[0].text, partCount: body.parts.length };
    save(); response.writeHead(204); response.end();
    setTimeout(() => {
      assistant.parts[0].text = 'GUI 夹具文本成果：建议先明确目标和验收条件。这里没有发生真实模型或工具调用。';
      assistant.info.time.completed = Date.now(); assistant.info.finish = 'stop'; entry.status = 'idle';
      emit('message.updated', { sessionID, info: assistant.info }); emit('session.idle', { sessionID });
    }, 250); return;
  }
  counts.unexpectedRoutes++; save(); json(response, {}, 404);
});
process.on('SIGTERM', () => { counts.stopped++; save(); for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(() => process.exit(0)); });
server.listen(0, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
