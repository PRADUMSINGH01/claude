// Films belong to their owner: lists, status, usage and media show a film only to the account that ordered
// it, ownership survives a restart (it is read back from the job folder), and media links need their key.
// Run: node --test server/test/ownership.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// A finished film on disk, as the pipeline leaves it.
function filmFolder(jobsDir, id, { userId, title }) {
  const dir = path.join(jobsDir, id);
  fs.mkdirSync(path.join(dir, 'harness'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'project', 'renders'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'harness', 'request.json'), JSON.stringify({ prompt: title, options: { duration: 15, ...(userId ? { userId } : {}) }, createdAt: new Date().toISOString(), mode: 'plan-build' }));
  fs.writeFileSync(path.join(dir, 'harness', 'state.json'), JSON.stringify({ stage: 'done' }));
  fs.writeFileSync(path.join(dir, 'harness', 'result.json'), JSON.stringify({ title, duration: 15 }));
  fs.writeFileSync(path.join(dir, 'project', 'renders', 'final.mp4'), Buffer.alloc(4096, 7));
}

async function startServer(t, data, env = {}) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const server = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return { base, stop: () => server.kill() };
}

test('a film is seen only by its owner, across restarts; media needs its key', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-owner-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  let srv = await startServer(t, data);
  t.after(() => srv.stop());

  const signUp = async (email) => {
    const r = await (await fetch(`${srv.base}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'longpassword', name: email }) })).json();
    return { id: r.user.id, auth: { authorization: `Bearer ${r.token}` } };
  };
  const ana = await signUp('ana@example.com');
  const bo = await signUp('bo@example.com');
  const admin = await signUp('admin@example.com');
  // Admins are named by account id (an email is trusted only once verified).
  srv.stop();
  srv = await startServer(t, data, { ADMIN_USER_IDS: admin.id });

  filmFolder(path.join(data, 'jobs'), '20261102100000-aaaaaa', { userId: ana.id, title: 'Ana film' });
  filmFolder(path.join(data, 'jobs'), '20261102100001-bbbbbb', { userId: bo.id, title: 'Bo film' });
  filmFolder(path.join(data, 'jobs'), '20261031100000-legacy', { title: 'Old film' });

  const list = async (who) => (await (await fetch(`${srv.base}/api/videos`, { headers: who?.auth })).json());
  assert.equal((await fetch(`${srv.base}/api/videos`)).status, 401, 'no anonymous lists');
  const anaList = await list(ana);
  assert.deepEqual(anaList.jobs.map((j) => j.title), ['Ana film']);
  assert.deepEqual((await list(bo)).jobs.map((j) => j.title), ['Bo film']);
  assert.deepEqual((await list(admin)).jobs.map((j) => j.title).sort(), ['Old film'], 'owner-less films: admins only');

  // Status of someone else's film is not found.
  const anaJob = anaList.jobs[0];
  assert.equal((await fetch(`${srv.base}/api/prompt/${anaJob.promptId}`, { headers: bo.auth })).status, 404);
  assert.equal((await fetch(`${srv.base}/api/prompt/${anaJob.promptId}`, { headers: ana.auth })).status, 200);

  // Media: the keyed link plays; the bare or a wrong-key link does not.
  const url = anaJob.play[0];
  assert.match(url, /\/final\.mp4\?k=[\w-]{24}$/);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url.replace(/\?k=.*/, ''))).status, 404);
  assert.equal((await fetch(url.replace(/k=[\w-]+/, 'k=AAAAAAAAAAAAAAAAAAAAAAAA'))).status, 404);

  // Usage shows the owner's own films.
  const usage = await (await fetch(`${srv.base}/api/usage`, { headers: ana.auth })).json();
  assert.deepEqual([usage.plan.tier, usage.credits.limit, usage.totals.films, usage.films[0].title], ['free', 15, 1, 'Ana film']);

  // A restart reads ownership back from the job folders.
  srv.stop();
  srv = await startServer(t, data, { ADMIN_USER_IDS: admin.id });
  assert.deepEqual((await list(ana)).jobs.map((j) => j.title), ['Ana film']);
  assert.deepEqual((await list(bo)).jobs.map((j) => j.title), ['Bo film']);
});
