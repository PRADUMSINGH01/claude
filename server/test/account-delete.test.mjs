// Deleting an account needs its password, then removes the account and what it owns (sessions, API keys,
// chats) and nobody else's. Run: node --test server/test/account-delete.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('an account is deleted only with its password, and takes only its own data with it', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-delete-'));
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, JWT_SECRET: 'delete-test' },
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
  const call = async (p, { method = 'GET', body, auth, key } = {}) => {
    const headers = { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(key ? { 'x-api-key': key } : {}) };
    const res = await fetch(`${base}${p}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const signUp = async (email) => (await call('/api/register', { method: 'POST', body: { email, password: 'longpassword1', name: 'X' } })).json.token;

  const ana = await signUp('ana@example.com');
  const anaPhone = (await call('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: 'longpassword1' } })).json.token;
  const bo = await signUp('bo@example.com');
  const chat = { id: 'c-1', title: 'Reel', createdAt: '2026-11-03T10:00:00.000Z', updatedAt: '2026-11-03T10:00:00.000Z', settings: { ratio: '16:9', length: 15 }, messages: [] };
  assert.equal((await call('/api/chats/c-1', { method: 'PUT', auth: ana, body: chat })).status, 200);
  assert.equal((await call('/api/chats/c-1', { method: 'PUT', auth: bo, body: chat })).status, 200);
  const key = (await call('/api/keys', { method: 'POST', auth: ana, body: { name: 'ci' } })).json;
  const secret = key.secretKey;
  assert.ok(secret, 'an API key was made');
  assert.equal((await call('/api/user/me', { key: secret })).status, 200, 'the key works before');

  assert.equal((await call('/api/user/me', { method: 'DELETE' })).status, 401, 'signed out');
  assert.equal((await call('/api/user/me', { method: 'DELETE', auth: ana, body: { password: 'wrong-password' } })).status, 403, 'wrong password');
  assert.equal((await call('/api/user/me')).status, 401);
  assert.equal((await call('/api/user/me', { auth: ana })).status, 200, 'a wrong password deletes nothing');

  const done = await call('/api/user/me', { method: 'DELETE', auth: ana, body: { password: 'longpassword1' } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await call('/api/user/me', { auth: ana })).status, 401, 'this session ended');
  assert.equal((await call('/api/user/me', { auth: anaPhone })).status, 401, 'every session ended');
  assert.equal((await call('/api/user/me', { key: secret })).status, 401, 'API keys stop working');
  assert.equal((await call('/api/login', { method: 'POST', body: { email: 'ana@example.com', password: 'longpassword1' } })).status, 401, 'the account is gone');

  // Bo is untouched, and the address can be used again.
  assert.equal((await call('/api/user/me', { auth: bo })).status, 200);
  assert.equal((await call('/api/chats', { auth: bo })).json.chats.length, 1);
  const again = await signUp('ana@example.com');
  assert.ok(again, 'the email can sign up again');
  assert.equal((await call('/api/chats', { auth: again })).json.chats.length, 0, 'a new account starts empty');
});
