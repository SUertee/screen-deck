import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, lstat, rename, symlink, link, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWriteTool, fileDigest, identityOf, type FileWriteTarget, validateTextBytes, syncFileDirectory } from '../../../src/core/tools/write.js';
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sd-file-tool-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'note.md'), 'old\n');
  const target: FileWriteTarget = { workspaceRoot: root, workspaceIdentity: identityOf(await lstat(root, { bigint: true })), leafName: 'note.md', baseIdentity: identityOf(await lstat(join(root, 'note.md'), { bigint: true })), expectedBaseDigest: fileDigest(Buffer.from('old\n')) };
  const replacement = (s = 'new\n') => ({ bytes: Buffer.from(s), contentDigest: fileDigest(Buffer.from(s)) });
  return { root, target, replacement, read: () => readFile(join(root, 'note.md'), 'utf8') };
}
test('stage is inert; commit preserves UTF8 bytes, empty content and stage identity', async t => {
  for (const text of ['\uFEFF中文\r\n', '']) {
    const f = await fixture(t); const tool = new FileWriteTool(); const s = await tool.stage(f.target, f.replacement(text));
    assert.equal(await f.read(), 'old\n'); assert.equal((await lstat(join(f.root, s.intent.stagedName))).mode & 0o777, 0o600);
    const effect = await tool.commit(s.handle, () => undefined); assert.equal(effect.status, 'applied'); assert.equal(await f.read(), text);
    if (effect.status === 'applied') assert.deepEqual(effect.observedIdentity, s.intent.stagedIdentity);
    await assert.rejects(tool.commit(s.handle, () => undefined), /handle-consumed/);
    assert.equal((await tool.inspect(f.target, f.replacement(text).contentDigest, s.intent, 'unknown')).status, 'unknown');
    assert.equal((await new FileWriteTool().inspect(f.target, f.replacement(text).contentDigest, s.intent, 'stopped')).status, 'applied');
  }
});
test('reject bad UTF8, NUL, oversized buffers, wrong digest, unchanged content and unsafe paths', async t => {
  const f = await fixture(t), tool = new FileWriteTool();
  for (const bytes of [Buffer.from([0xff]), Buffer.from('a\0b'), Buffer.alloc(65537, 65)]) assert.throws(() => validateTextBytes(bytes));
  await assert.rejects(tool.stage(f.target, f.replacement('old\n')), /no-change/);
  await assert.rejects(tool.stage(f.target, { ...f.replacement(), contentDigest: 'a'.repeat(64) }));
  for (const leafName of ['../x', '/x', 'a/b', 'a\\b', '.', 'x\n', '']) await assert.rejects(tool.stage({ ...f.target, leafName }, f.replacement()));
  assert.equal(await f.read(), 'old\n');
});
test('cancel, async gate, changed stage or baseline identity never rename', async t => {
  const f = await fixture(t); let count = 0; const tool = new FileWriteTool({ rename: async (...args) => { count++; return rename(...args); } });
  const a = await tool.stage(f.target, f.replacement()); assert.equal((await tool.commit(a.handle, () => { throw new Error('cancelled'); })).status, 'not-applied');
  const b = await tool.stage(f.target, f.replacement()); assert.equal((await tool.commit(b.handle, (async () => undefined) as never)).status, 'not-applied');
  const c = await tool.stage(f.target, f.replacement()); await writeFile(join(f.root, c.intent.stagedName), 'bad'); assert.equal((await tool.commit(c.handle, () => undefined)).status, 'not-applied');
  const d = await tool.stage(f.target, f.replacement()); await writeFile(join(f.root, 'other'), 'old\n'); await rename(join(f.root, 'other'), join(f.root, 'note.md'));
  assert.equal((await tool.commit(d.handle, () => undefined)).status, 'not-applied'); assert.equal(count, 0);
});
test('symlinks, hardlinks, ancestor aliases and wrong workspace identity are rejected', async t => {
  const f = await fixture(t), tool = new FileWriteTool();
  await link(join(f.root, 'note.md'), join(f.root, 'hard')); await assert.rejects(tool.stage(f.target, f.replacement())); await rm(join(f.root, 'hard'));
  await rename(join(f.root, 'note.md'), join(f.root, 'original')); await symlink(join(f.root, 'original'), join(f.root, 'note.md')); await assert.rejects(tool.stage(f.target, f.replacement())); assert.equal(await readFile(join(f.root, 'original'), 'utf8'), 'old\n');
  await symlink(f.root, join(f.root, 'alias')); await assert.rejects(tool.stage({ ...f.target, workspaceRoot: join(f.root, 'alias') }, f.replacement()));
  await assert.rejects(tool.stage({ ...f.target, workspaceIdentity: { device: '0', inode: '0' } }, f.replacement()));
});
test('instance ownership and synchronous reservation prevent concurrent duplicate commits', async t => {
  const f = await fixture(t); let count = 0; const tool = new FileWriteTool({ rename: async (...args) => { count++; return rename(...args); } }); const s = await tool.stage(f.target, f.replacement());
  await assert.rejects(new FileWriteTool().commit(s.handle, () => undefined));
  const results = await Promise.allSettled([tool.commit(s.handle, () => undefined), tool.commit(s.handle, () => undefined)]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1); assert.equal(count, 1); assert.equal(await f.read(), 'new\n');
});
test('lost rename acknowledgement and sync failures are unknown; inspection never repeats writes', async t => {
  const f = await fixture(t); let count = 0;
  const tool = new FileWriteTool({ rename: async (...args) => { count++; await rename(...args); throw new Error('lost'); } }); const s = await tool.stage(f.target, f.replacement());
  assert.equal((await tool.inspect(f.target, f.replacement().contentDigest, s.intent, 'stopped')).status, 'not-applied');
  assert.equal((await tool.commit(s.handle, () => undefined)).status, 'unknown'); assert.equal(await f.read(), 'new\n');
  assert.equal((await tool.inspect(f.target, f.replacement().contentDigest, s.intent, 'stopped')).status, 'applied');
  await writeFile(join(f.root, 'impostor'), 'new\n'); await rename(join(f.root, 'impostor'), join(f.root, 'note.md'));
  assert.equal((await tool.inspect(f.target, f.replacement().contentDigest, s.intent, 'stopped')).status, 'unknown'); assert.equal(count, 1);
  const g = await fixture(t); let syncs = 0; const broken = new FileWriteTool({ syncDirectory: async root => { if (++syncs === 2) throw new Error('lost'); await syncFileDirectory(root); } });
  const b = await broken.stage(g.target, g.replacement()); assert.equal((await broken.commit(b.handle, () => undefined)).status, 'unknown');
});
test('input mutation cannot alter staged bytes; missing stage and nonregular target fail closed', async t => {
  const f = await fixture(t), tool = new FileWriteTool(), input = f.replacement(); const s = await tool.stage(f.target, input); input.bytes.fill(88);
  assert.equal((await tool.commit(s.handle, () => undefined)).status, 'applied'); assert.equal(await f.read(), 'new\n');
  const g = await fixture(t), b = await tool.stage(g.target, g.replacement()); await rm(join(g.root, b.intent.stagedName)); assert.equal((await tool.commit(b.handle, () => undefined)).status, 'not-applied');
  await rm(join(g.root, 'note.md')); await mkdir(join(g.root, 'note.md')); assert.equal((await tool.inspect(g.target, g.replacement().contentDigest, b.intent, 'stopped')).status, 'unknown');
});
