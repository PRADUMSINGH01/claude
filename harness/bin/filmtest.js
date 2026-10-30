#!/usr/bin/env node
// End-to-end test of runFilm (plan → build → render) with NO real model calls: a fake
// OpenAI-compatible server answers the brief, the plan and each scene. Then a resume of the same
// job must skip planning, and an aborted job must stop. Usage: node bin/filmtest.js [--keep] [--no-render]
// --no-render: for machines whose Chrome can't reach the GSAP CDN the scaffold loads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const keep = process.argv.includes('--keep');
const render = !process.argv.includes('--no-render');
const { config, repoRoot } = await import('../src/config.js');
// Not os.tmpdir(): with the sandbox on, each job's uid must be able to reach its folder.
fs.mkdirSync(path.join(repoRoot, 'jobs'), { recursive: true });
const jobs = fs.mkdtempSync(path.join(repoRoot, 'jobs', 'filmtest-'));
fs.chmodSync(jobs, 0o755);
const { runFilm } = await import('../src/film.js');

const PROMPT = 'A 6 second title film. Beat 1: "Light, in motion". Beat 2: "LUMEN". Dark ground #07101F, type #F0EBDE, accent #5560E5, font Inter. No audio.';
const brief = {
  title: 'Lumen', goal: 'remember the name', kind: 'title',
  format: { width: 1920, height: 1080, fps: 30, duration: 6 }, audio: 'none',
  look: { preset: null, colors: { ground: '#07101F', ink: '#F0EBDE', accent: '#5560E5' }, fonts: ['Inter'], mood: 'calm dark editorial' },
  background: { wanted: false, description: '' },
  beats: [
    { id: 'headline', start: 0, end: 3, copy: ['Light, in motion'], intent: 'kinetic headline' },
    { id: 'wordmark', start: 3, end: 6, copy: ['LUMEN'], intent: 'wordmark hold' },
  ],
  overlays: [], transitions: [], must: [], avoid: ['audio'], assumptions: ['30 fps'],
};
const plan = {
  title: 'Lumen', kind: 'title', format: brief.format,
  theme: { name: 'lumen', colors: { ground: '#07101F', ink: '#F0EBDE', accent: '#5560E5' }, fonts: ['Inter'], rules: [] },
  scenes: brief.beats.map((b) => ({
    id: b.id, layer: 'main', start: b.start, duration: b.end - b.start, purpose: b.intent, text: b.copy,
    block: null, components: [], vars: {}, build: 'centred line, 9% of frame height', motion: 'per-word blur in, hold', sound: '',
  })),
  audio: { music: null, sfx: null, voiceover: null },
  spec: [
    'GOAL:    the viewer remembers the name LUMEN',
    'OUTPUT:  HyperFrames, 1920 x 1080, 30 fps',
    'TIME:    6 s x 30 = 180 frames',
    'LOOK:    ground #07101F flat; ink #F0EBDE; accent #5560E5 on the wordmark only; Inter 700 at 9% of frame height, -2% tracking',
    'MOTION:  enter expo.out 0.4 s; exit power3.in 0.25 s; words 0.067 s apart',
    'SHOTS:   0-90 headline per-word blur in, hold; 90-180 wordmark lands, holds 2 s',
    'BANNED:  glow, particles, fade-and-slide-up on every element',
    'QA:      t=2.5 headline whole; t=5.5 wordmark whole',
  ].join('\n'),
  decisions: [],
};

const calls = { brief: 0, plan: 0, scene: 0, other: 0 };
const reply = (content) => JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    const system = String(msgs[0].content);
    res.setHeader('content-type', 'application/json');
    if (system.startsWith('You turn a video request into a precise brief')) {
      calls.brief++;
      return res.end(reply(JSON.stringify(brief)));
    }
    if (system.startsWith('You plan a HyperFrames video')) {
      calls.plan++;
      return res.end(reply(JSON.stringify(plan)));
    }
    if (system.startsWith('You write ONE HyperFrames scene file')) {
      calls.scene++;
      const id = /data-composition-id="([a-z0-9-]+)"/.exec(msgs[1].content)?.[1] ?? 'x';
      const copy = JSON.parse(/<scene>\n([\s\S]*?)\n<\/scene>/.exec(msgs[1].content)?.[1] ?? '{"scene":{"copy":[]}}').scene.copy ?? [];
      const dur = brief.beats.find((b) => b.id === id) ? 3 : 1;
      const html = `<template>
  <style>#root { position: absolute; inset: 0; container-type: size; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); color: var(--fg); } #root .${id}-t { font-size: 9cqh; }</style>
  <div id="root" data-composition-id="${id}">
    <div id="${id}-t" class="clip ${id}-t" data-start="0" data-duration="${dur}"><span>${copy.join(' ')}</span></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#${id}-t span", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.1);
    window.__timelines["${id}"] = tl;
  </script>
</template>`;
      return res.end(reply(JSON.stringify({ html })));
    }
    calls.other++;
    return res.end(reply('{"issues":[]}'));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '', vision: false };
for (const role of Object.keys(config.roles)) config.roles[role] = 'fake';

const log = (e) => {
  if (['job_start', 'step', 'scene', 'check', 'measured', 'render_done', 'job_done', 'job_failed', 'plan_warnings'].includes(e.type)) console.log(JSON.stringify(e).slice(0, 200));
};

try {
  // 1. A new film.
  const first = await runFilm({ prompt: PROMPT, options: { aspect: '16:9', duration: 6 }, jobsDir: jobs, onEvent: log, render });
  if (render) {
    assert.ok(fs.statSync(first.video).size > 1000, 'final.mp4 should exist');
    assert.ok(Math.abs(first.duration - 6) < 0.2, `duration ${first.duration}`);
  }
  assert.equal(calls.brief, 1);
  assert.equal(calls.plan, 1);
  assert.ok(calls.scene >= 2, 'both hand-built scenes are written');
  const dir = path.join(jobs, first.job);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'harness', 'request.json'), 'utf8'));
  assert.equal(req.mode, 'plan-build', 'the server picks the resume pipeline from request.mode');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'harness', 'state.json'), 'utf8')).stage, render ? 'done' : 'built');
  for (const f of ['brief.json', 'plan.json', 'build-report.md', 'events.jsonl']) assert.ok(fs.existsSync(path.join(dir, 'harness', f)), `missing ${f}`);
  assert.ok(first.usage.planner && first.usage.builder, 'usage.json has planner and builder');
  console.log(`\nok  new film: ${first.video ?? '(not rendered)'}, calls ${JSON.stringify(calls)}`);

  // 2. Resume: plan.json exists, so no brief or plan calls.
  const before = { ...calls };
  const again = await runFilm({ resume: dir, onEvent: log, render });
  assert.equal(calls.brief, before.brief, 'resume must not re-plan');
  assert.equal(calls.plan, before.plan, 'resume must not re-plan');
  assert.equal(again.job, first.job);
  console.log('ok  resume skips planning');

  // 3. Cancelled before planning: fails fast, nothing is asked.
  const n = calls.brief;
  await assert.rejects(runFilm({ prompt: PROMPT, jobsDir: jobs, signal: AbortSignal.abort() }));
  assert.equal(calls.brief, n);
  console.log('ok  an aborted job stops before any model call');
} finally {
  server.close();
  if (!keep) fs.rmSync(jobs, { recursive: true, force: true });
}
