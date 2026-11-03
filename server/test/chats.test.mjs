// Studio chats live on the server, per account: a chat saved in one browser shows in another, the later edit
// of a chat wins, a deletion reaches every browser, nobody sees another account's chats, and only known
// fields are kept (build logs never are).
// Run: node --test server/test/chats.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('chats follow their owner across browsers; the later edit wins; deletions reach every browser', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-chats-'));
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, JWT_SECRET: 'chats-test' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const stopped = new Promise((r) => child.once('exit', r));
  t.after(async () => {
    child.kill();
    await stopped;
    fs.rmSync(data, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const call = async (p, { method = 'GET', body, auth } = {}) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() };
  };
  const signUp = async (email) => (await call('/api/register', { method: 'POST', body: { email, password: 'longpassword1', name: 'X' } })).json.token;
  const ana = await signUp('ana@example.com');
  // A second browser: a separate sign-in to the same account.
  const anaPhone = (await call('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: 'longpassword1' } })).json.token;
  const bo = await signUp('bo@example.com');

  const chat = (updatedAt, extra = {}) => ({
    id: 'c-1',
    title: 'Launch reel',
    createdAt: '2026-11-03T10:00:00.000Z',
    updatedAt,
    settings: { ratio: '16:9', length: 15, model: 'deepseek/deepseek-v4.1-flash', sound: true, secret: 'dropped' },
    messages: [
      { id: 'm1', role: 'user', content: 'A launch reel.', createdAt: '2026-11-03T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'Your video is ready.', createdAt: '2026-11-03T10:01:00.000Z', promptId: 'p-1', preview: { title: 'Launch reel', url: 'https://x/final.mp4?k=abc' }, logs: [{ ts: 't', line: 'secret build log' }], thought: 'internal' },
    ],
    ...extra,
  });

  assert.equal((await call('/api/chats')).status, 401);
  const saved = await call('/api/chats/c-1', { method: 'PUT', auth: ana, body: chat('2026-11-03T10:02:00.000Z') });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.chat.messages[1].logs, undefined, 'build logs are not kept');
  assert.equal(saved.json.chat.messages[1].thought, undefined);
  assert.equal(saved.json.chat.settings.secret, undefined, 'unknown fields are dropped');

  // The other browser sees it.
  const onPhone = await call('/api/chats', { auth: anaPhone });
  assert.deepEqual(onPhone.json.chats.map((c) => [c.id, c.title, c.messages.length]), [['c-1', 'Launch reel', 2]]);
  assert.deepEqual((await call('/api/chats', { auth: bo })).json.chats, [], "another account's chats stay hidden");

  // A stale copy can't overwrite a newer one; the newer one comes back.
  await call('/api/chats/c-1', { method: 'PUT', auth: anaPhone, body: chat('2026-11-03T10:05:00.000Z', { title: 'Renamed on the phone' }) });
  const stale = await call('/api/chats/c-1', { method: 'PUT', auth: ana, body: chat('2026-11-03T10:03:00.000Z', { title: 'Old title' }) });
  assert.deepEqual([stale.status, stale.json.chat.title], [409, 'Renamed on the phone']);

  // Deleted on one browser: gone everywhere, and an old copy can't bring it back.
  assert.equal((await call('/api/chats/c-1', { method: 'DELETE', auth: anaPhone })).status, 200);
  const after = await call('/api/chats', { auth: ana });
  assert.deepEqual([after.json.chats.length, after.json.deleted], [0, ['c-1']]);
  assert.equal((await call('/api/chats/c-1', { method: 'PUT', auth: ana, body: chat('2026-11-03T11:00:00.000Z') })).status, 410);
  // Undo, right after the delete, brings it back.
  assert.equal((await call('/api/chats/c-1?restore=1', { method: 'PUT', auth: anaPhone, body: chat('2026-11-03T11:01:00.000Z') })).status, 200);
  assert.deepEqual((await call('/api/chats', { auth: ana })).json.chats.map((c) => c.id), ['c-1']);

  // Bad input is refused, not stored.
  assert.equal((await call('/api/chats/c-2', { method: 'PUT', auth: ana, body: { ...chat('2026-11-03T10:00:00.000Z'), id: 'c-other' } })).status, 400);
  assert.equal((await call('/api/chats/c-2', { method: 'PUT', auth: ana, body: { id: 'c-2', messages: [{ id: 'x', role: 'admin' }] } })).status, 400);
  assert.equal((await call('/api/chats/c-3', { method: 'PUT', auth: ana, body: { ...chat('2026-11-03T10:00:00.000Z'), id: 'c-3', messages: [{ id: 'big', role: 'user', content: 'x'.repeat(8000) }].concat(Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, role: 'user', content: 'y'.repeat(7000) }))) } })).status, 400, 'too large');
  assert.ok(fs.existsSync(path.join(data, 'chats')), 'chats live in their own folder, not db.json');
});
