#!/usr/bin/env node
// End-to-end test of runFilm (plan → build → render) with NO real model calls: a fake
// OpenAI-compatible server answers the brief, the plan and each scene. Then a resume of the same
// job must skip planning, and an aborted job must stop. A 20 s unscripted film gets the story step
// (three storylines, the picked one reshapes the beats); a storyline that drops the request's copy is
// rejected and the brief kept. Usage: node bin/filmtest.js [--keep] [--no-render]
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
const { runPlan } = await import('../src/plan.js');

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
// The plan follows whatever brief it is given: one hand-built scene per beat.
const planFor = (brief) => ({
  title: brief.title, kind: brief.kind, format: brief.format,
  theme: { name: 'test', colors: brief.look.colors, fonts: brief.look.fonts, rules: [] },
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
  // Hand-built on purpose: the test drives the scene writer, so each scene says why it skips the registry.
  decisions: brief.beats.map((b) => `${b.id}: no registry item fits because this test hand-builds every scene`),
});

const FERRY = 'A 20 second launch film for Ferry, an app that books ferry tickets. On screen: "Ferry" and "Book the boat, not the queue".';
const ferryBrief = {
  title: 'Ferry', goal: 'book a ferry in the app', kind: 'launch',
  format: { width: 1920, height: 1080, fps: 30, duration: 20 }, audio: 'none',
  look: { preset: null, colors: { ground: '#0B5563', ink: '#F4EFE6', accent: '#F2A541' }, fonts: ['Oswald'], mood: 'bright harbour morning' },
  background: { wanted: false, description: '' },
  beats: [
    { id: 'name', start: 0, end: 10, copy: ['Ferry'], intent: 'wordmark reveal' },
    { id: 'claim', start: 10, end: 20, copy: ['Book the boat, not the queue'], intent: 'kinetic claim' },
  ],
  overlays: [], transitions: [], must: [], avoid: [], assumptions: [],
};
// The picked storyline: the old way first, then the name, the claim and an end line.
const storyBeats = [
  { id: 'queue', start: 0, end: 5, copy: ['Still in line'], intent: 'queue snakes off frame' },
  { id: 'name', start: 5, end: 10, copy: ['Ferry'], intent: 'ticket becomes wordmark' },
  { id: 'claim', start: 10, end: 16, copy: ['Book the boat, not the queue'], intent: 'per word claim' },
  { id: 'end', start: 16, end: 20, copy: ['See you on deck'], intent: 'boat leaves frame' },
];
let storyMode = 'good';
const storyReply = () => ({
  one_thing: 'you can book a ferry without queueing', remember: 'skip the ticket line', spine: 'one commuter, one 8:10 crossing',
  storylines: ['The queue', 'Harbour map', 'Ticket chain'].map((name) => ({ name, device: 'life before and after', form: 'object-to-object chain', sees_feels: 'x', first_two_seconds: 'x', beats: 'x', look: 'x', sound: 'x' })),
  pick: 0, reason: 'a stranger knows a queue',
  // "bad": the rewrite drops the request's own line "Ferry".
  brief: { ...ferryBrief, beats: storyMode === 'good' ? storyBeats : storyBeats.map((b) => (b.id === 'name' ? { ...b, copy: ['Tickets, sorted'] } : b)), assumptions: ['added copy: Still in line', 'added copy: See you on deck'] },
});

const calls = { brief: 0, story: 0, plan: 0, scene: 0, other: 0 };
let planSawStoryline = false;
const reply = (content) => JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const msgs = JSON.parse(body).messages;
    const system = String(msgs[0].content);
    res.setHeader('content-type', 'application/json');
    const user = String(msgs[1].content);
    if (system.startsWith('You turn a video request into a precise brief')) {
      calls.brief++;
      return res.end(reply(JSON.stringify(user.includes('Ferry') ? ferryBrief : brief)));
    }
    if (system.startsWith('You are the story editor')) {
      calls.story++;
      assert.match(system, /# Story/, 'the story guide is in the prompt');
      assert.match(system, /# Launch, promo and feature films/, 'the launch type guide is in the prompt');
      return res.end(reply(JSON.stringify(storyReply())));
    }
    if (system.startsWith('You plan a HyperFrames video')) {
      calls.plan++;
      planSawStoryline ||= user.includes('<storyline>');
      return res.end(reply(JSON.stringify(planFor(JSON.parse(/<brief>\n([\s\S]*?)\n<\/brief>/.exec(user)[1])))));
    }
    if (system.startsWith('You write ONE HyperFrames scene file')) {
      calls.scene++;
      const id = /data-composition-id="([a-z0-9-]+)"/.exec(msgs[1].content)?.[1] ?? 'x';
      const copy = JSON.parse(/<scene>\n([\s\S]*?)\n<\/scene>/.exec(msgs[1].content)?.[1] ?? '{"scene":{"copy":[]}}').scene.copy ?? [];
      const dur = Number(JSON.parse(/<scene>\n([\s\S]*?)\n<\/scene>/.exec(msgs[1].content)?.[1] ?? '{"scene":{}}').scene.duration) || 1;
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

  // 4. Story: a 20 s unscripted launch gets three storylines; the picked one reshapes the beats.
  assert.equal(calls.story, 0, 'the 6 s scripted title film skips the story step');
  const ferry = await runFilm({ prompt: FERRY, jobsDir: jobs, onEvent: log, render });
  const fdir = path.join(jobs, ferry.job);
  assert.equal(calls.story, 1);
  assert.ok(planSawStoryline, 'the plan call is given the picked storyline');
  const fb = JSON.parse(fs.readFileSync(path.join(fdir, 'harness', 'brief.json'), 'utf8'));
  assert.deepEqual(fb.beats.map((b) => b.id), ['queue', 'name', 'claim', 'end']);
  for (const f of ['STORYLINES.md', 'SPEC.md']) assert.ok(fs.existsSync(path.join(fdir, 'project', f)), `project/${f}`);
  assert.match(fs.readFileSync(path.join(fdir, 'project', 'STORYLINES.md'), 'utf8'), /★ 1\. The queue \(built\)/);
  console.log('ok  story step: three storylines, the picked one shapes the beats, STORYLINES.md + SPEC.md in the project');

  // 5. A storyline that drops the request's copy is repaired once, then rejected: the brief stands.
  storyMode = 'bad';
  const before5 = calls.story;
  const kept = await runPlan({ prompt: FERRY, jobsDir: jobs, judge: false });
  assert.equal(calls.story, before5 + 2, 'one repair');
  assert.deepEqual(kept.brief.beats.map((b) => b.id), ['name', 'claim']);
  assert.ok(!fs.existsSync(path.join(kept.dir, 'harness', 'STORYLINES.md')));
  console.log('ok  a storyline that loses the request\'s copy is rejected');

  // 6. A palette picked in the app: its colours go into the brief exactly, whatever the model wrote.
  const picked = await runPlan({ prompt: PROMPT, options: { palette: 'teal-orange' }, jobsDir: jobs, judge: false });
  assert.deepEqual(picked.brief.look.colors, { ground: '#0F3B40', ink: '#F3EDE4', accent: '#F28C38', accent2: '#6CC3C1' });
  assert.equal(picked.brief.look.preset, null);
  const saved = JSON.parse(fs.readFileSync(path.join(picked.dir, 'harness', 'request.json'), 'utf8')).options;
  assert.equal(saved.colors.ground, '#0F3B40', 'resolved colours are saved for a resume');
  console.log('ok  a picked palette sets the brief\'s colours');
} finally {
  server.close();
  if (!keep) fs.rmSync(jobs, { recursive: true, force: true });
}
