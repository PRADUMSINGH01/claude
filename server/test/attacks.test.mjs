// The attacks from the security audit, each against a real server: Google sign-in can't hand a session to
// another site or run script, nobody signs in with a default password, a film runs only on a Studio model and
// within its limits, sign-in guessing and sign-up farming stop, an email change needs the password, and the
// API answers only the app's own sites. Nothing here calls a model: films are kept queued.
// Run: node --test server/test/attacks.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEvent, isAdmin } from '../billing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(here, '..', 'index.mjs');

function startServer(t, env = {}, seed = null) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-attack-'));
  if (seed) fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify(seed));
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [serverFile], {
    // MAX_CONCURRENT_JOBS 0: a film is accepted and stays queued, so no model is ever called.
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, JWT_SECRET: 'attack-test-secret', MAX_CONCURRENT_JOBS: '0', OPENROUTER_MODELS_URL: 'http://127.0.0.1:9/offline', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', RESEND_API_KEY: '', EMAIL_FROM: '', ADMIN_EMAILS: '', ADMIN_USER_IDS: '', ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  const stopped = new Promise((r) => child.once('exit', r));
  t.after(async () => {
    child.kill();
    await stopped;
    fs.rmSync(data, { recursive: true, force: true });
  });
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  })();
  // Each caller can pose as its own network (Caddy's X-Forwarded-For), so per-address limits stay apart.
  const call = async (p, { body, ip = '203.0.113.1', ...opts } = {}) => {
    const res = await fetch(`${base}${p}`, { redirect: 'manual', ...opts, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(opts.headers || {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or empty */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  const signUp = async (email, ip) => {
    const r = await call('/api/register', { method: 'POST', ip, body: { email, password: 'longpassword1', name: email.split('@')[0] } });
    return { ...r.json, auth: { authorization: `Bearer ${r.json?.token}` } };
  };
  return { base, ready, call, signUp, data };
}

const scrypt = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};

test('Google sign-in: only our own sites get the session, the state is signed and tied to the browser, the page runs no injected script', async (t) => {
  const srv = startServer(t, { GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' });
  await srv.ready;

  // An attacker's origin is replaced by the app's own.
  const start = await srv.call(`/api/google/auth?origin=${encodeURIComponent('https://evil.example')}&popup=false`);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.match(state, /^[\w-]+\.[\w-]+$/, 'signed: body.mac');
  assert.equal(JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString()).origin, 'http://localhost:3000');
  const nonceCookie = start.headers.get('set-cookie');
  assert.match(nonceCookie, /g_nonce=[\w-]+;.*HttpOnly/);
  assert.equal((await srv.call('/api/google/url?origin=https%3A%2F%2Fevil.example')).json.url.includes('evil.example'), false);

  // A forged state carrying script: ignored, nothing injected, the message goes only to our site.
  const evil = Buffer.from(JSON.stringify({ origin: '</script><script>alert(1)</script>', popup: true, iat: Date.now() })).toString('base64url');
  const page = await srv.call(`/api/google/callback?state=${evil}.forged&error=access_denied`);
  assert.equal(page.status, 200);
  assert.equal(page.text.includes('<script>alert(1)'), false);
  assert.match(page.text, /postMessage\(payload, "http:\/\/localhost:3000"\)/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);

  // A valid state from another browser (no nonce cookie) can't finish the sign-in.
  const noCookie = await srv.call(`/api/google/callback?state=${state}&code=stolen-code`);
  assert.match(noCookie.headers.get('location') || '', /\/login\?error=This%20sign-in%20link%20has%20expired/);
});

test('production: no Google stub; nobody signs in with the old default password, and those sessions end', async (t) => {
  const google = { id: 'usr_google1', email: 'gina@example.com', passwordHash: scrypt('Password123!'), googleId: 'g-1', profile: { displayName: 'Gina' }, auth: { provider: 'google', emailVerified: true }, plan: { tier: 'free' }, usage: {} };
  const own = { id: 'usr_email1', email: 'ed@example.com', passwordHash: scrypt('Password123!'), profile: { displayName: 'Ed' }, auth: { provider: 'email', emailVerified: true }, plan: { tier: 'free' }, usage: {} };
  const stolen = 'stolen-session-token';
  const secretTag = crypto.createHash('sha256').update('attack-test-secret').digest('hex').slice(0, 16);
  const srv = startServer(t, { NODE_ENV: 'production' }, { users: [google, own], sessions: { [stolen]: google.id }, sessionSecretTag: secretTag, apiKeys: [], promptMap: {}, conversations: [], brandKits: {}, assets: {} });
  await srv.ready;

  const login = (email) => srv.call('/api/login', { method: 'POST', body: { email, password: 'Password123!' } });
  assert.equal((await login('gina@example.com')).json.error, 'USE_GOOGLE_AUTH', 'a Google account has no password');
  assert.equal((await login('ed@example.com')).status, 200, 'a password its owner chose still works');
  assert.equal((await srv.call('/api/user/me', { headers: { authorization: `Bearer ${stolen}` } })).status, 401, 'a session opened with the default password ended');

  const stub = await srv.call('/api/google/auth?popup=false');
  assert.equal(stub.status, 302);
  assert.match(stub.headers.get('location'), /\/login\?error=/, 'no sign-in without Google in production');
  assert.equal((await srv.call('/api/google', { method: 'POST', body: {} })).status, 503);
});

test('films: Studio models only, pricier ones on a paid plan, prompts capped, one film at a time on Free, only failed films retried', async (t) => {
  const srv = startServer(t);
  await srv.ready;
  const ana = await srv.signUp('ana@example.com');
  const film = (body) => srv.call('/api/prompt', { method: 'POST', headers: ana.auth, body: { prompt: 'A 5 second title card.', length: 15, ...body } });

  const unknown = await film({ provider: 'openrouter', model: 'anthropic/claude-opus-pricey' });
  assert.deepEqual([unknown.status, unknown.json.error], [400, 'UNKNOWN_MODEL']);
  assert.deepEqual([(await film({ provider: 'nope', model: 'x' })).status], [400]);
  const paid = await film({ provider: 'claude', model: 'claude-sonnet-5-5' });
  assert.deepEqual([paid.status, paid.json.error], [402, 'PLAN_LIMIT']);
  const long = await film({ prompt: 'x '.repeat(2500) });
  assert.deepEqual([long.status, long.json.error], [400, 'PROMPT_TOO_LONG']);
  const effort = await film({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', effort: 'max', promptId: 'ana-1' });
  assert.equal(effort.status, 202);
  assert.deepEqual([effort.json.job.model, effort.json.job.effort], ['deepseek/deepseek-v4.1-flash', 'medium'], "an effort the model doesn't offer falls back to its default");

  const second = await film({ provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
  assert.deepEqual([second.status, second.json.error], [429, 'TOO_MANY_ACTIVE']);
  const retry = await srv.call('/api/prompt/ana-1/retry', { method: 'POST', headers: ana.auth });
  assert.deepEqual([retry.status, retry.json.error], [409, 'NOT_RETRYABLE'], 'a queued film is not run twice');
});

test('sign-in guessing and sign-up farming are stopped', async (t) => {
  const srv = startServer(t);
  await srv.ready;
  await srv.signUp('bo@example.com', '198.51.100.7');
  const guess = () => srv.call('/api/login', { method: 'POST', ip: `198.51.100.${Math.floor(Math.random() * 200)}`, body: { email: 'bo@example.com', password: 'wrong-guess' } });
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await guess()).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 429], 'eight wrong passwords, then a pause, from any address');
  assert.equal((await srv.call('/api/login', { method: 'POST', body: { email: 'bo@example.com', password: 'longpassword1' } })).status, 429, 'the pause holds for the right password too');

  const made = [];
  for (let i = 0; i < 6; i++) made.push((await srv.call('/api/register', { method: 'POST', ip: '192.0.2.9', body: { email: `farm${i}@example.com`, password: 'longpassword1', name: 'Farm' } })).status);
  assert.deepEqual(made, [201, 201, 201, 201, 201, 429], 'five accounts a day from one address');
});

test('email: a change needs the password and ends other sessions; with a sender, free films wait for the confirmed address', async (t) => {
  const mail = [];
  const inbox = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      mail.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_1"}');
    });
  });
  await new Promise((r) => inbox.listen(0, '127.0.0.1', r));
  t.after(() => inbox.close());
  const srv = startServer(t, { RESEND_API_KEY: 're_test', EMAIL_FROM: 'byreel <hello@byreel.in>', RESEND_API_URL: `http://127.0.0.1:${inbox.address().port}/emails` });
  await srv.ready;

  const cy = await srv.signUp('cy@example.com');
  assert.equal(cy.user.auth.emailVerified, false);
  assert.equal(cy.user.auth.mustVerify, true);
  assert.equal(cy.user.auth.verify, undefined, "the link's hash never leaves the server");
  const film = () => srv.call('/api/prompt', { method: 'POST', headers: cy.auth, body: { prompt: 'A title card.', length: 15 } });
  assert.equal((await film()).json.error, 'EMAIL_UNVERIFIED');

  const link = mail.at(-1).text.match(/http\S+verify-email\S+/)[0];
  assert.equal(mail.at(-1).to, 'cy@example.com');
  const opened = await fetch(link.replace(/to=[^&]+/, `to=${encodeURIComponent('https://evil.example')}`), { redirect: 'manual' });
  assert.equal(opened.headers.get('location'), 'http://localhost:3000/dashboard?verified=1', 'confirmed, and back to our own site only');
  assert.equal((await film()).status, 202);

  // A second session, then an email change: the password is needed, and the other session ends.
  const other = (await srv.call('/api/login', { method: 'POST', body: { email: 'cy@example.com', password: 'longpassword1' } })).json.token;
  const change = (body) => srv.call('/api/user/profile', { method: 'PATCH', headers: cy.auth, body });
  assert.equal((await change({ email: 'admin@example.com' })).json.error, 'INVALID_PASSWORD');
  assert.equal((await change({ email: 'admin@example.com', currentPassword: 'wrong' })).json.error, 'INVALID_PASSWORD');
  const changed = await change({ email: 'cy2@example.com', currentPassword: 'longpassword1' });
  assert.deepEqual([changed.status, changed.json.user.email, changed.json.user.auth.emailVerified], [200, 'cy2@example.com', false]);
  assert.equal(mail.at(-1).to, 'cy2@example.com', 'the new address gets its own link');
  assert.equal((await srv.call('/api/user/me', { headers: { authorization: `Bearer ${other}` } })).status, 401);
  assert.equal((await srv.call('/api/user/me', { headers: cy.auth })).status, 200);
});

test('admins by id, or by a confirmed email; a payment matches an account by email only when it is confirmed', () => {
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.ADMIN_USER_IDS = 'usr_owner';
  try {
    assert.equal(isAdmin({ id: 'usr_owner', email: 'x@example.com', auth: {} }), true);
    assert.equal(isAdmin({ id: 'usr_2', email: 'owner@example.com', auth: { emailVerified: false } }), false, 'an unconfirmed admin email is not enough');
    assert.equal(isAdmin({ id: 'usr_3', email: 'owner@example.com', auth: { emailVerified: true } }), true);
  } finally {
    delete process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_USER_IDS;
  }
  const squatter = { id: 'usr_sq', email: 'payer@example.com', auth: { emailVerified: false }, plan: { tier: 'free' } };
  const db = { users: [squatter] };
  const event = { type: 'subscription.active', data: { customer: { email: 'payer@example.com', customer_id: 'cus_1' }, product_id: 'pdt_x', subscription_id: 'sub_1' } };
  assert.match(applyEvent(db, event), /no user/);
  squatter.auth.emailVerified = true;
  assert.doesNotMatch(applyEvent(db, event), /no user/);
});

test('the API answers only our sites, keeps sessions out of scripts, sends security headers, and hides its internals', async (t) => {
  const srv = startServer(t);
  await srv.ready;
  const evil = await srv.call('/api/models', { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await srv.call('/api/models', { headers: { origin: 'http://localhost:3000' } })).headers.get('access-control-allow-origin'), 'http://localhost:3000');

  const reg = await srv.call('/api/register', { method: 'POST', body: { email: 'di@example.com', password: 'longpassword1', name: 'Di' } });
  assert.match(reg.headers.get('set-cookie'), /HttpOnly/);
  for (const h of ['x-content-type-options', 'x-frame-options', 'content-security-policy']) assert.ok(reg.headers.get(h), h);

  const health = await srv.call('/api/health');
  assert.deepEqual(Object.keys(health.json).sort(), ['service', 'status', 'success'], 'through the proxy: up or not, nothing more');

  assert.equal((await srv.call('/api/conversations')).status, 401);
  assert.equal((await srv.call('/api/conversations', { method: 'POST', body: { title: 'x' } })).status, 401);
  const di = { authorization: `Bearer ${reg.json.token}` };
  await srv.call('/api/conversations', { method: 'POST', headers: di, body: { title: 'Mine' } });
  const ed = await srv.signUp('ed@example.com');
  assert.deepEqual((await srv.call('/api/conversations', { headers: ed.auth })).json.conversations, [], "another account's conversations stay hidden");
  assert.deepEqual((await srv.call('/api/conversations', { headers: di })).json.conversations.map((c) => c.title), ['Mine']);
});
