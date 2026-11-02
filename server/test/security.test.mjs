// Sign-in can't be forged: tokens verify only under the configured secret, a new secret ends every session,
// production won't start without one, and an API key works only whole.
// Run: node --test server/test/security.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, '..', 'index.mjs');

function startServer(data, env = {}) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();
  const stopped = new Promise((r) => child.once('exit', r));
  return { base, ready, stop: async () => { child.kill(); await stopped; } };
}

// A token as the server makes them, signed with any secret.
const tokenFor = (sub, secret) => {
  const payload = Buffer.from(JSON.stringify({ sub, iat: Date.now(), exp: Date.now() + 3600_000 })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
};

test('tokens verify only under the configured secret, and a new secret ends every session', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-sec-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  let srv = startServer(data, { JWT_SECRET: 'first-secret-for-tests' });
  t.after(() => srv.stop());
  await srv.ready;

  const reg = await (await fetch(`${srv.base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ana@example.com', password: 'longpassword', name: 'Ana' }) })).json();
  const me = (token) => fetch(`${srv.base}/api/user/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  assert.equal(await me(reg.token), 200);
  for (const secret of ['byreel-studio-local-secret', 'byreel-studio-jwt-secret-secure-key']) {
    assert.equal(await me(tokenFor(reg.user.id, secret)), 401, `a token signed with the public "${secret}" is refused`);
    assert.equal(await me(tokenFor('ana@example.com', secret)), 401);
  }

  await srv.stop();
  srv = startServer(data, { JWT_SECRET: 'second-secret-for-tests' });
  await srv.ready;
  assert.equal(await me(reg.token), 401, 'a session from the old secret ended with it');
});

test('production refuses to start without JWT_SECRET', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-sec-'));
  try {
    const child = spawn(process.execPath, [serverFile], { env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', PORT: '0', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs') }, stdio: 'ignore' });
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 1);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('an API key signs in only whole, never by its prefix', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-sec-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const srv = startServer(data, { JWT_SECRET: 'key-test-secret' });
  t.after(() => srv.stop());
  await srv.ready;

  const reg = await (await fetch(`${srv.base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bo@example.com', password: 'longpassword', name: 'Bo' }) })).json();
  const made = await (await fetch(`${srv.base}/api/keys`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ name: 'cli' }) })).json();
  assert.equal(made.apiKey.secretHash, undefined, 'the hash stays on the server');
  const withKey = (key) => fetch(`${srv.base}/api/user/me`, { headers: { 'x-api-key': key } }).then((r) => r.status);
  assert.equal(await withKey(made.secretKey), 200);
  assert.equal(await withKey(made.apiKey.prefix), 401, 'the prefix alone');
  assert.equal(await withKey(`${made.apiKey.prefix}${'0'.repeat(32)}`), 401, 'the prefix plus a guess');
  assert.equal(await withKey('byreel_live_sk_89f0'), 401, 'the key that used to be seeded');
  const listed = await (await fetch(`${srv.base}/api/keys`, { headers: { authorization: `Bearer ${reg.token}` } })).json();
  assert.ok(listed.keys.every((k) => !('secretHash' in k)));
});
