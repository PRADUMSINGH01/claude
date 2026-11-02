// OpenRouter in the Studio: free, value and top models, and a film's choice of provider. A provider must serve
// the model with tool calls (OpenRouter's endpoints list, here a stand-in); top models need a paid plan.
// Nothing calls a model: films are kept queued.
// Run: node --test server/test/models.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// OpenRouter's endpoints list for one model: two providers with tool calls, one without.
const endpoints = {
  data: {
    id: 'deepseek/deepseek-v4.1-flash',
    endpoints: [
      { tag: 'novita/fp8', provider_name: 'Novita', quantization: 'fp8', pricing: { prompt: '0.0000002', completion: '0.00000078' }, context_length: 1048576, uptime_last_1d: 99.5, supported_parameters: ['tools', 'reasoning'] },
      { tag: 'baidu/fp8', provider_name: 'Baidu', quantization: 'fp8', pricing: { prompt: '0.00000003', completion: '0.00000014' }, context_length: 1048576, uptime_last_1d: 100, supported_parameters: ['tools'] },
      { tag: 'notools', provider_name: 'No Tools', quantization: 'unknown', pricing: { prompt: '0', completion: '0' }, context_length: 8192, supported_parameters: ['reasoning'] },
    ],
  },
};

test('OpenRouter: free, value and top models; a film picks a provider that really serves its model', async (t) => {
  const asked = [];
  const openrouter = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(req.url.endsWith('/deepseek/deepseek-v4.1-flash/endpoints') ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(endpoints));
  });
  await new Promise((r) => openrouter.listen(0, '127.0.0.1', r));
  t.after(() => openrouter.close());

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-models-'));
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'), PUBLIC_API_URL: `http://127.0.0.1:${port}`, JWT_SECRET: 'models-test', MAX_CONCURRENT_JOBS: '0', OPENROUTER_API_KEY: 'sk-or-test', OPENROUTER_MODELS_URL: `http://127.0.0.1:${openrouter.address().port}/api/v1/models` },
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
  const call = async (p, { body, headers, ip = `203.0.113.${Math.floor(Math.random() * 250)}`, method } = {}) => {
    const res = await fetch(`${base}${p}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() };
  };

  const catalog = (await call('/api/models')).json.catalog.filter((g) => g.provider === 'openrouter');
  assert.deepEqual(catalog.map((g) => g.name), ['OpenRouter · Free', 'OpenRouter · Value', 'OpenRouter · Top']);
  assert.ok(catalog[0].models.every((m) => m.id.endsWith(':free')));
  assert.ok(catalog[2].models.every((m) => m.paid), 'top models need a paid plan');
  assert.ok(catalog.every((g) => g.ready));

  // The picker's list: providers with tool calls only, cheapest first, prices per million tokens.
  const routes = (await call('/api/models/routes?model=deepseek/deepseek-v4.1-flash')).json;
  assert.deepEqual(routes.providers.map((p) => [p.tag, p.inputPerM, p.outputPerM]), [['baidu/fp8', 0.03, 0.14], ['novita/fp8', 0.2, 0.78]]);
  assert.deepEqual(routes.sorts, ['price', 'throughput', 'latency']);
  assert.equal((await call('/api/models/routes?model=evil/model')).status, 404, 'only Studio models are looked up');
  await call('/api/models/routes?model=deepseek/deepseek-v4.1-flash');
  assert.equal(asked.length, 1, 'the list is cached');

  const signUp = async (email) => {
    const r = await call('/api/register', { body: { email, password: 'longpassword1', name: 'X' } });
    return { authorization: `Bearer ${r.json.token}` };
  };
  const film = (who, body) => call('/api/prompt', { headers: who, body: { prompt: 'A title card.', length: 15, provider: 'openrouter', ...body } });

  const ana = await signUp('ana@example.com');
  const pinned = await film(ana, { model: 'deepseek/deepseek-v4.1-flash', route: 'baidu/fp8', promptId: 'ana-1' });
  assert.equal(pinned.status, 202);
  assert.deepEqual([pinned.json.job.model, pinned.json.job.route], ['deepseek/deepseek-v4.1-flash', 'baidu/fp8']);

  const bo = await signUp('bo@example.com');
  const noTools = await film(bo, { model: 'deepseek/deepseek-v4.1-flash', route: 'notools' });
  assert.deepEqual([noTools.status, noTools.json.error], [400, 'UNKNOWN_ROUTE'], "a provider that can't make tool calls is refused");
  assert.deepEqual([(await film(bo, { model: 'deepseek/deepseek-v4.1-flash', route: 'made-up/tag' })).json.error], ['UNKNOWN_ROUTE']);
  const top = await film(bo, { model: 'anthropic/claude-opus-5.5' });
  assert.deepEqual([top.status, top.json.error], [402, 'PLAN_LIMIT']);
  const free = await film(bo, { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', route: 'price' });
  assert.equal(free.status, 202);
  assert.deepEqual([free.json.job.route, free.json.job.vision], ['price', false], 'a sort needs no lookup; a text-only model is marked');
});
