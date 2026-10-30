#!/usr/bin/env node
// End-to-end build test with NO model calls: a fake OpenAI-compatible server plays the scene writer.
// Its first reply for each scene breaks the contract (no registered timeline) so the repair path runs;
// the second is valid. Usage: node bin/buildtest.js <plan-job-dir-to-copy> [--render]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const [src] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const renderToo = process.argv.includes('--render');
if (!src) throw new Error('usage: node bin/buildtest.js <plan-job-dir> [--render]');

const jobs = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-buildtest-'));
process.env.JOBS_DIR = jobs;
const { config } = await import('../src/config.js');
const { Workspace } = await import('../src/workspace.js');
const { runBuild } = await import('../src/build/index.js');

const ws = Workspace.create(jobs);
for (const f of ['plan.json', 'brief.json']) fs.copyFileSync(path.join(src, 'harness', f), ws.meta(f));

const seen = new Map();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    const id = /data-composition-id="([a-z0-9-]+)"/.exec(msgs[1].content)?.[1] ?? 'x';
    const copy = JSON.parse(/<scene>\n([\s\S]*?)\n<\/scene>/.exec(msgs[1].content)?.[1] ?? '{"scene":{"copy":[]}}').scene.copy ?? [];
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const timeline = n === 1 ? '' : `window.__timelines["${id}"] = tl;`;
    const html = `<template>
  <style>#root { position: absolute; inset: 0; container-type: size; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); color: var(--fg); } #root .${id}-t { font-size: 12cqmin; }</style>
  <div id="root" data-composition-id="${id}">
    <div id="${id}-t" class="clip ${id}-t" data-start="0" data-duration="1"><span>${copy.join(' ')}</span></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#${id}-t span", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.1);
    ${timeline}
  </script>
</template>`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ html }) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '', vision: false };
config.roles.builder = 'fake';

const events = [];
const report = await runBuild(ws.dir, { render: renderToo, onEvent: (e) => { events.push(e); if (['step', 'scene', 'check', 'measured', 'escalate', 'assembled'].includes(e.type)) console.log(JSON.stringify(e).slice(0, 220)); } });
server.close();

console.log('\nscenes:', JSON.stringify(report.scenes, null, 1));
const written = Object.entries(report.scenes).filter(([, s]) => s.mode === 'write');
assert.ok(written.length > 0, 'the plan should need written scenes');
for (const [id, s] of written) {
  assert.ok(s.attempts >= 2, `${id}: the broken first draft should have been repaired`);
  assert.match(s.result, /^written|^fallback/, `${id}: ${s.result}`);
}
assert.ok(fs.existsSync(ws.meta('build-report.md')));
console.log(`\nOK: ${written.length} written scene(s), report at ${ws.meta('build-report.md')}`);
if (!renderToo) fs.rmSync(jobs, { recursive: true, force: true });
