#!/usr/bin/env node
// Exercises everything except real model calls: skills access, progressive reads, sandbox confinement,
// the HyperFrames CLI (init, catalog, add, theme, check, snapshot), and the agent loop against a fake
// OpenAI-compatible server. Usage: npm run selftest [-- --quick]  (--quick skips the CLI steps)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const quick = process.argv.includes('--quick');
const tmpJobs = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-selftest-'));
process.env.JOBS_DIR = tmpJobs;

const { config } = await import('../src/config.js');
const { SkillLibrary } = await import('../src/skills/library.js');
const { ROLE_ACCESS, canRead } = await import('../src/skills/access.js');
const { makeSkillTools, preloadText, skillMap } = await import('../src/tools/skill-tools.js');
const { confine } = await import('../src/sandbox.js');
const { Workspace } = await import('../src/workspace.js');
const { plannerHandoff } = await import('../src/roles/planner.js');

let passed = 0;
const step = async (name, fn) => {
  const t = Date.now();
  await fn();
  passed++;
  console.log(`ok  ${name} (${Date.now() - t}ms)`);
};

const lib = new SkillLibrary(config.skillsDir);
const ctxFor = (role, ws) => ({
  role, lib, ws, emit: () => {}, readLog: new Set(), compactedReads: new Set(), seenRegistry: new Set(),
  skillBudget: { left: config.skillBudget[role] },
});

await step('skill library indexes the installed skills', () => {
  for (const s of ['hyperframes', 'hyperframes-cli', 'hyperframes-registry', 'media-use']) assert.ok(lib.get(s), `missing skill ${s}`);
});

await step('every role preload section exists and stays small', () => {
  for (const role of Object.keys(ROLE_ACCESS)) {
    const text = preloadText(role, lib);
    assert.ok(text.length > 100 && text.length < 12_000, `${role} preload is ${text.length} chars`);
  }
});

await step('system-prompt skill maps carry no content', () => {
  for (const role of Object.keys(ROLE_ACCESS)) {
    const map = skillMap(role, lib);
    assert.ok(map.length < 9000, `${role} map is ${map.length} chars`);
    assert.ok(!map.includes('cloud.md'), `${role} map lists cloud.md`);
  }
});

await step('providers: one switch for all roles, per-role override, gemini-safe tool schemas', async () => {
  const { useProvider, providerStatus, PROVIDER_NAMES } = await import('../src/config.js');
  const { geminiSchema } = await import('../src/llm.js');
  assert.deepEqual(PROVIDER_NAMES.sort(), ['azure', 'claude', 'gemini', 'glm', 'openai', 'openrouter']);
  const saved = { ...config.roles };
  useProvider('gemini');
  assert.ok(Object.values(config.roles).every((r) => r === 'gemini'));
  useProvider('azure', ['critic']);
  assert.equal(config.roles.critic, 'azure');
  assert.equal(config.roles.builder, 'gemini');
  assert.deepEqual(providerStatus().find((p) => p.name === 'gemini').roles, ['planner', 'builder', 'fixer']);
  assert.throws(() => useProvider('nope'), /Unknown provider/);
  Object.assign(config.roles, saved);
  // Gemini rejects these keywords and type unions in tool schemas.
  const { plannerHandoff } = await import('../src/roles/planner.js');
  const g = JSON.stringify(geminiSchema(plannerHandoff.parameters));
  assert.ok(!/additionalProperties|minItems|maxItems|"minimum"|"maximum"|"type":\[/.test(g), g.slice(0, 300));
  assert.match(g, /"nullable":true/);
});

await step('plan-only: brief check catches lost copy; rating scores a plan against the brief', async () => {
  const { checkBrief, ratePlan } = await import('../src/plan.js');
  const prompt = 'Beat 1: headline "Light, in motion". Beat 2: "Design that moves". dark ground #07101F, animated aurora background';
  const brief = {
    format: { width: 1920, height: 1080, fps: 30, duration: 10 }, audio: 'none',
    look: { colors: { ground: '#07101F' } }, background: { wanted: true },
    beats: [{ id: 'b1', start: 0, end: 5, copy: ['Light, in motion'] }, { id: 'b2', start: 5, end: 10, copy: ['Design that move'] }],
  };
  assert.match(checkBrief(brief, prompt).join(), /"Design that moves" from the request is missing/);
  brief.beats[1].copy = ['Design that moves'];
  assert.deepEqual(checkBrief(brief, prompt), []);
  const plan = {
    format: brief.format, theme: { name: 'x', colors: { ground: '#07101F' } }, audio: {},
    scenes: [
      { id: 'bg', layer: 'background', start: 0, duration: 10, text: [] },
      { id: 'b1', start: 0, duration: 5, text: ['Light, in motion'] },
      { id: 'b2', start: 5, duration: 5, text: ['Design that moves'] },
    ],
  };
  const goodJudge = { scenes: [{ id: 'bg', fit: 5, motion_matches: true }, { id: 'b1', fit: 5, motion_matches: true }, { id: 'b2', fit: 5, motion_matches: true }] };
  assert.equal(ratePlan(plan, brief, null).score, 8); // unjudged: block fit scores 0/2
  assert.equal(ratePlan(plan, brief, null, { judge: goodJudge }).score, 10);
  const badJudge = { scenes: [{ id: 'b2', fit: 1, motion_matches: false, why: 'a diagram block for a wordmark' }] };
  assert.match(ratePlan(plan, brief, null, { judge: badJudge }).items.at(-1).note, /b2 fit 1\/5: a diagram block/);
  // A block that animates with its bundled font, told to use the theme font.
  const fontPlan = { ...plan, theme: { ...plan.theme, fonts: ['Inter'] }, scenes: plan.scenes.map((s) => (s.id === 'b1' ? { ...s, block: 'weight-wave', build: 'Inter 120px', motion: 'wave' } : s)) };
  const lists = { blocks: { b1: [{ name: 'weight-wave', fonts: ['Recursive'] }] }, components: {} };
  assert.match(ratePlan(fontPlan, brief, null, { lists }).items.find((i) => /fonts/.test(i.label)).note, /weight-wave animates with Recursive/);
  // A main block with a solid ground hides the background layer: rated down and rejected by the plan check.
  const covered = { ...plan, scenes: plan.scenes.map((s) => (s.id === 'b1' ? { ...s, vars: { background: '#07101F' } } : s)) };
  assert.match(ratePlan(covered, brief, null).items.find((i) => /background/.test(i.label)).note, /covered by an opaque ground in: b1/);
  const { opaqueOverBackground } = await import('../src/roles/planner.js');
  assert.deepEqual(opaqueOverBackground(covered), ['b1']);
  assert.deepEqual(opaqueOverBackground({ ...covered, scenes: covered.scenes.map((s) => ({ ...s, vars: { background: 'transparent' } })) }), []);
  const worse = ratePlan({ ...plan, scenes: plan.scenes.slice(1, 2) }, brief, 'blocks do not fit');
  assert.ok(worse.score < 5, JSON.stringify(worse));
});

await step('plan-only checks: instructions are not copy, readable timing, real vars, preset, background only when asked', async () => {
  const { checkBrief, planChecks, readFloor } = await import('../src/plan.js');
  const base = { format: { duration: 4 }, look: {}, background: { wanted: false } };
  // instruction words in copy; a 1 s beat for a 9-word line
  const b1 = { ...base, beats: [{ id: 'a', start: 0, end: 3, copy: ['Hello'] }, { id: 'end', start: 3, end: 4, copy: ['source: UN 2024, show the source on screen'] }] };
  const e1 = checkBrief(b1, 'Hello').join('\n');
  assert.match(e1, /reads like an instruction/);
  assert.match(e1, /needs 3\.\dsto be read|needs \d\.\ds to be read/);
  assert.equal(readFloor(['one two three']), 2);
  // "dark background" is a colour, not a layer
  assert.match(checkBrief({ ...base, background: { wanted: true }, beats: [{ id: 'a', start: 0, end: 4, copy: [] }] }, 'kinetic type on a dark background').join(), /only names a background colour/);
  assert.equal(checkBrief({ ...base, background: { wanted: true }, beats: [{ id: 'a', start: 0, end: 4, copy: [] }] }, 'an animated aurora background').length, 0);
  // planChecks against a shortlist
  const sl = { blocks: { a: [{ name: 'data-chart', textVars: [], imageVars: [], colorVars: [], otherVars: [] }], background: [{ name: 'aurora', textVars: [], imageVars: [], colorVars: [], otherVars: [] }] }, components: {} };
  const plan = { theme: { name: 'x', colors: {} }, scenes: [
    { id: 'a', start: 0, duration: 0.5, text: ['A quote of several words here'], block: 'data-chart', vars: { chartStyle: 'minimal' } },
    { id: 'bg', layer: 'background', start: 0, duration: 4, text: [], block: 'data-chart', vars: {} },
  ] };
  const e2 = planChecks(plan, { look: { preset: 'coral' }, background: { wanted: false } }, sl).join('\n');
  assert.match(e2, /has no variable\(s\) chartStyle/);
  assert.match(e2, /too short to read/);
  assert.match(e2, /background layer must use a block from the background shortlist/);
  assert.match(e2, /theme must be \{"preset": "coral"\}/);
  assert.match(e2, /wants no background layer/);
});

await step('plan-only A–E: judge every scene, component vars, brand items, no split/repeated copy, overlays', async () => {
  const { checkBrief, planChecks, ratePlan, blockedForPrompt } = await import('../src/plan.js');
  // C: explicit brand list, matched to real catalog names
  assert.equal(blockedForPrompt('x-follow-card', 'handle "@dailyframes" at the bottom'), true);
  assert.equal(blockedForPrompt('x-follow-card', 'our X account'), false);
  assert.equal(blockedForPrompt('chatgpt-exchange', 'a note-taking app'), true);
  assert.equal(blockedForPrompt('yt-lcd-background', 'anything'), false); // "yt-" is a collection prefix
  assert.equal(blockedForPrompt('store-badge-lockup', 'Free on iOS and Android'), false);
  // D: a quote split into fragments, and a line repeated in a hold beat
  const base = { format: { duration: 12 }, look: {}, background: { wanted: false } };
  const split = { ...base, beats: [
    { id: 'a', start: 0, end: 4, copy: ['Small steps every'] }, { id: 'b', start: 4, end: 8, copy: ['day beat big plans'] }, { id: 'c', start: 8, end: 12, copy: ['someday.'] }] };
  assert.match(checkBrief(split, 'quote: "Small steps every day beat big plans someday."').join(), /split into fragments/);
  const repeated = { ...base, beats: [{ id: 'a', start: 0, end: 6, copy: ['Design is how it works.'] }, { id: 'b', start: 6, end: 12, copy: ['Design is how it works.'] }] };
  const e = checkBrief(repeated, 'Quote: "Design is how it works."').join();
  assert.match(e, /appears in 2 beats/);
  assert.match(e, /repeated in a and b/);
  // E + B: overlays and variables of components / hand-built scenes
  const brief = { ...base, beats: [{ id: 'q', start: 0, end: 12, copy: ['Quote'] }], overlays: [{ id: 'handle', start: 0, end: 12, copy: ['@me'] }] };
  const sl = { blocks: { q: [] }, components: { q: [{ name: 'per-word-rise', textVars: ['text'], imageVars: [], colorVars: [], otherVars: ['cues'] }] } };
  const plan = { theme: {}, scenes: [
    { id: 'q', start: 0, duration: 12, text: ['Quote'], block: null, components: ['per-word-rise'], vars: { text: 'Quote', layoutWidth: '60%' } },
    { id: 'logo', layer: 'overlay', start: 0, duration: 12, text: [], block: null, components: [], vars: { size: 10 } },
  ] };
  const e2 = planChecks(plan, brief, sl).join('\n');
  assert.match(e2, /per-word-rise has no variable\(s\) layoutWidth/);
  assert.match(e2, /logo: a hand-built scene with no components has no variables/);
  assert.match(e2, /overlay handle from the brief is missing/);
  assert.match(e2, /overlay logo is not in the brief/);
  plan.scenes[0].vars = { text: 'Quote', cues: '' };
  plan.scenes[1] = { id: 'handle', layer: 'overlay', start: 0, duration: 12, text: ['@me'], block: null, components: [], vars: {} };
  assert.deepEqual(planChecks(plan, brief, sl), []);
  // A: the judge covers every scene; one it skips counts as fit 1 and is named
  const r = ratePlan({ ...plan, format: { duration: 12 }, audio: {} }, brief, null, { lists: sl, judge: { scenes: [{ id: 'q', fit: 5, motion_matches: true }] } });
  const j = r.items.find((i) => /judge/.test(i.label));
  assert.match(j.note, /handle not judged/);
  assert.ok(j.points < 1.5, JSON.stringify(j));
  assert.equal(r.items.find((i) => /timing/.test(i.label)).note, '2/2');
});

await step('model JSON: whole reply or nothing (a cut-off plan must not parse as one inner scene)', async () => {
  const { parseModelJson } = await import('../src/plan.js');
  assert.deepEqual(parseModelJson('```json\n{"scenes":[{"id":"a"}]}\n```'), { scenes: [{ id: 'a' }] });
  assert.equal(parseModelJson('{"title":"x","scenes":[{"id":"a","vars":{"k":1}},{"id":"b"'), null);
  assert.equal(parseModelJson('no json here'), null);
  assert.equal(parseModelJson('[1,2]'), null);
  // Arithmetic a model left in a value is worked out; the same text inside a string is not touched.
  assert.deepEqual(parseModelJson('{"start": 3 - 0.6 / 2, "d": -1 + 4*2, "s": "at: 3 - 1,"}'), { start: 2.7, d: 7, s: 'at: 3 - 1,' });
});

await step('transitions: on seams, cover scenes centred and text-free, handoffs need no scene', async () => {
  const { checkBrief, planChecks } = await import('../src/plan.js');
  const beats = [{ id: 'a', start: 0, end: 3, copy: ['DESIGN'] }, { id: 'b', start: 3, end: 6, copy: ['IN MOTION'] }];
  const brief = { format: { duration: 6 }, look: {}, background: { wanted: false }, beats,
    transitions: [{ id: 't-1', at: 3, kind: 'cover', style: 'colour block wipe', duration: 0.6 }] };
  assert.deepEqual(checkBrief(brief, 'transitions please'), []);
  assert.match(checkBrief({ ...brief, transitions: [{ id: 't-1', at: 2.5, kind: 'cover', duration: 0.6 }] }, 'x').join(), /not on a seam/);
  assert.match(checkBrief({ ...brief, transitions: [{ id: 't-1', at: 3, kind: 'fade', duration: 3 }] }, 'x').join(), /duration must be|kind must be/);
  const sl = { blocks: {}, components: {} };
  const scenes = [{ id: 'a', start: 0, duration: 3, text: ['DESIGN'] }, { id: 'b', start: 3, duration: 3, text: ['IN MOTION'] }];
  assert.match(planChecks({ theme: {}, scenes }, brief, sl).join(), /cover transition t-1 from the brief is missing/);
  const off = [...scenes, { id: 't-1', layer: 'transition', start: 3, duration: 0.6, text: [] }];
  assert.match(planChecks({ theme: {}, scenes: off }, brief, sl).join(), /must be centred on the seam/);
  const ok = [...scenes, { id: 't-1', layer: 'transition', start: 2.7, duration: 0.6, text: [] }];
  assert.deepEqual(planChecks({ theme: {}, scenes: ok }, brief, sl), []);
  const handoff = { ...brief, transitions: [{ id: 't-1', at: 3, kind: 'handoff', style: 'whip', duration: 0.3 }] };
  assert.deepEqual(planChecks({ theme: {}, scenes }, handoff, sl), []);
  assert.match(planChecks({ theme: {}, scenes: ok }, handoff, sl).join(), /not a cover transition/);
});

await step('brief keeps every colour the request gives (code check, not a prompt rule)', async () => {
  const { checkBrief } = await import('../src/plan.js');
  const prompt = 'ground #0E0B1F, violet #7B5CFF, coral #FF5A5F, lime #C6FF4A, white #FFFFFF. Beat: "GO"';
  const base = { format: { duration: 3 }, background: { wanted: false }, beats: [{ id: 'a', start: 0, end: 3, copy: ['GO'] }] };
  const lost = checkBrief({ ...base, look: { colors: { ground: '#0E0B1F', ink: '#FFFFFF', accent: '#7B5CFF' } } }, prompt).join();
  assert.match(lost, /missing from look\.colors: #FF5A5F, #C6FF4A/);
  const kept = { ground: '#0E0B1F', ink: '#FFFFFF', accent: '#7B5CFF', coral: '#FF5A5F', lime: '#C6FF4A' };
  assert.deepEqual(checkBrief({ ...base, look: { colors: kept } }, prompt), []);
  assert.deepEqual(checkBrief({ ...base, look: { preset: 'coral', colors: {} } }, 'theme: coral, "GO"'), []);
});

await step('story step: only for unscripted films over 15 s; figures on screen come from the request', async () => {
  const { storyApplies, checkBrief, storylinesMarkdown } = await import('../src/plan.js');
  const brief = (duration, kind = 'launch') => ({ kind, format: { duration } });
  assert.equal(storyApplies(brief(30), 'A launch film for Ferry, a ferry booking app').applies, true);
  assert.equal(storyApplies(brief(10), 'A launch film for Ferry').applies, false);
  assert.equal(storyApplies(brief(30, 'title'), 'A title card').applies, false);
  assert.equal(storyApplies(brief(30), 'Beat 1: "Hello". Beat 2: "World"').applies, false);
  assert.equal(storyApplies(brief(30), 'headline 0-5 s, logo 5-10 s').applies, false);
  const one = (copy) => ({ format: { duration: 4 }, background: { wanted: false }, beats: [{ id: 'a', start: 0, end: 4, copy: [copy] }] });
  const said = 'Builds went from 40 min to 2 min for 1,200 teams';
  assert.deepEqual(checkBrief(one('40 min to 2 min'), said), []);
  assert.deepEqual(checkBrief(one('1200 teams'), said), []);
  assert.match(checkBrief(one('20x faster'), said).join(), /shows 20, which the request never gives/);
  const md = storylinesMarkdown({ one_thing: 'x', remember: 'y', spine: 'z', pick: 1, reason: 'r', storylines: ['A', 'B', 'C'].map((name) => ({ name, device: 'd', form: 'f' })) });
  assert.match(md, /## ★ 2\. B \(built\)/);
  assert.match(md, /## 1\. A\n/);
});

await step('access rules', () => {
  assert.equal(canRead('builder', 'hyperframes-cli', 'references/cloud.md'), false);
  assert.equal(canRead('planner', 'hyperframes', 'assets/frame-presets/coral/FRAME.md'), true);
  assert.equal(canRead('critic', 'media-use', 'SKILL.md'), false);
  assert.equal(canRead('fixer', 'hyperframes', 'references/format.md'), true);
});

await step('progressive reads: outline → section → dedupe → budget', () => {
  const tools = Object.fromEntries(makeSkillTools().map((t) => [t.name, t]));
  const ctx = ctxFor('builder');
  const outline = tools.skill_outline.run({ skill: 'hyperframes', file: 'references/format.md' }, ctx);
  assert.match(outline, /section: "variables"/);
  const whole = tools.read_skill.run({ skill: 'hyperframes', file: 'references/format.md' }, ctx);
  assert.match(whole, /read it by section/);
  const sec = tools.read_skill.run({ skill: 'hyperframes', file: 'references/format.md', section: 'variables' }, ctx);
  assert.match(sec, /^\[hyperframes\/references\/format\.md#variables\]/);
  assert.ok(sec.length < config.skillReadChars + 300);
  assert.match(tools.read_skill.run({ skill: 'hyperframes', file: 'references/format.md', section: 'variables' }, ctx), /Already read/);
  assert.match(tools.read_skill.run({ skill: 'hyperframes-cli', file: 'references/cloud.md' }, ctx), /outside the builder/);
  const viaLink = tools.skill_outline.run({ skill: 'hyperframes-registry', file: '../hyperframes/references/format.md' }, ctx);
  assert.match(viaLink, /^hyperframes\/references\/format\.md/);
  ctx.skillBudget.left = 0;
  assert.match(tools.read_skill.run({ skill: 'hyperframes', file: 'references/motion.md', section: 'intro' }, ctx), /budget spent|No section/);
  assert.match(tools.search_skills.run({ query: 'data-variable-values block colour' }, ctxFor('builder')), /section:/);
});

await step('mandatory reading: every required section exists, gate blocks then clears', async () => {
  const { REQUIRED, readingGateMessage, preloadKeys } = await import('../src/skills/access.js');
  for (const [role, reqs] of Object.entries(REQUIRED)) {
    for (const r of reqs) {
      for (const ref of r.refs) {
        if (ref.endsWith('/')) continue;
        const [file, section] = ref.split('#');
        const [skill, ...rest] = file.split('/');
        assert.ok(lib.sections(skill, rest.join('/'))?.some((s) => s.id === section), `${role}: ${ref} does not exist`);
        assert.ok(canRead(role, skill, rest.join('/')), `${role} cannot read its own required ${ref}`);
      }
    }
  }
  const log = new Set(preloadKeys('builder'));
  assert.match(readingGateMessage('builder', log, lib), /format\.md", section: "variables"/);
  for (const s of ['variables', 'timing-and-the-timeline', 'fonts']) log.add(`hyperframes/references/format.md#${s}`);
  assert.match(readingGateMessage('builder', log, lib), /motion craft/);
  log.add('hyperframes/references/motion.md#motion'); // the h1 covers motion-craft
  assert.equal(readingGateMessage('builder', log, lib), null);
  const p = new Set();
  p.add('hyperframes/references/story.md#1-the-one-thing').add('hyperframes/references/look.md#*@1');
  assert.match(readingGateMessage('planner', p, lib), /kind of film/);
  p.add('hyperframes/references/types/launch.md#the-end-card');
  assert.equal(readingGateMessage('planner', p, lib), null);
});

await step('planner hand-off validation', async () => {
  const ctx = ctxFor('planner');
  ctx.seenRegistry.add('canopy-part-title');
  const good = {
    title: 't', kind: 'title', format: { width: 1920, height: 1080, fps: 30, duration: 12 },
    theme: { preset: 'coral' },
    scenes: [{ id: 'open', start: 0, duration: 12, purpose: 'p', text: ['Hi'], block: 'canopy-part-title', components: [], build: 'b', motion: 'm' }],
    spec: 'x'.repeat(400),
  };
  assert.equal(await plannerHandoff.validate(good, ctx), null);
  assert.match(await plannerHandoff.validate({ ...good, spec: `${good.spec} ground #FFF5F3` }, ctx), /outside the "coral" preset \(#FFF5F3\)/);
  // A preset extended with the plan's own colours is fine.
  assert.equal(await plannerHandoff.validate({ ...good, theme: { preset: 'coral', colors: { blush: '#FFF5F3' } }, spec: `${good.spec} ground #FFF5F3` }, ctx), null);
  const bad = { ...good, scenes: [{ ...good.scenes[0], block: 'made-up-block', duration: 10 }] };
  const msg = await plannerHandoff.validate(bad, ctx);
  assert.match(msg, /made-up-block/);
  assert.match(msg, /format.duration/);
});

const ws = Workspace.create(tmpJobs);
await step('sandbox path confinement', () => {
  fs.mkdirSync(ws.projectDir, { recursive: true });
  assert.throws(() => confine(ws.projectDir, '../harness/state.json'), /outside the project/);
  assert.throws(() => confine(ws.projectDir, '/etc/passwd'), /outside the project/);
  assert.ok(confine(ws.projectDir, 'compositions/a.html').endsWith(path.join('compositions', 'a.html')));
});

await step('edit_file tolerates whitespace and pasted line numbers; write_file refuses fake media', async () => {
  const { makeFileTools } = await import('../src/tools/project-tools.js');
  const tools = Object.fromEntries(makeFileTools({ write: true }).map((t) => [t.name, t]));
  const ctx = { ...ctxFor('builder', ws), emit: () => {} };
  fs.writeFileSync(path.join(ws.projectDir, 'a.html'), '<style>\n    #t {\n      font-size: 132px;\n    }\n</style>\n');
  assert.match(tools.edit_file.run({ path: 'a.html', old_text: '#t {\n  font-size: 132px;', new_text: '#t {\n      font-size: 160px;' }, ctx), /ignoring whitespace/);
  assert.match(fs.readFileSync(path.join(ws.projectDir, 'a.html'), 'utf8'), /160px/);
  assert.match(tools.edit_file.run({ path: 'a.html', old_text: '    3        font-size: 160px;', new_text: 'font-size: 170px;' }, ctx), /Edited/);
  assert.match(tools.edit_file.run({ path: 'a.html', old_text: 'font-size: 999px;', new_text: 'x' }, ctx), /not found/);
  assert.match(tools.write_file.run({ path: 'assets/audio/bed.mp3', content: 'placeholder' }, ctx), /^Refused: write_file makes text files only/);
});

await step('fake media made through bash is detected and deleted', async () => {
  const { makeBashTool } = await import('../src/tools/project-tools.js');
  const bash = makeBashTool();
  const ctx = { ...ctxFor('fixer', ws), emit: () => {} };
  const out = await bash.run({ command: 'mkdir -p assets/audio assets/fonts && printf "placeholder: whoosh" > assets/audio/whoosh.mp3 && printf "wOF2realish-bytes-0000" > assets/fonts/Inter.woff2 && cp assets/fonts/Inter.woff2 assets/fonts/BebasNeue-Regular.woff2' }, ctx);
  assert.match(out, /whoosh\.mp3 was not a real mp3/);
  assert.match(out, /BebasNeue-Regular\.woff2 was assets\/fonts\/Inter\.woff2 renamed|Inter\.woff2 was assets\/fonts\/BebasNeue-Regular\.woff2 renamed/);
  assert.ok(!fs.existsSync(path.join(ws.projectDir, 'assets/audio/whoosh.mp3')));
});

await step('content-filter false positive: retry, withhold recent output, carry on', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls++;
      const parsed = JSON.parse(body);
      const flaggedBody = JSON.stringify(parsed.messages).includes('SHADER-SOUP');
      res.setHeader('content-type', 'application/json');
      if (flaggedBody) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.', type: 'invalid_request_error' } }));
      }
      const hasTool = parsed.messages.some((m) => m.role === 'tool');
      const call = hasTool ? { name: 'submit_test', args: { answer: 'ok' } } : { name: 'read_file', args: { path: 'shader.html' } };
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '', vision: false };
  config.roles.critic = 'fake';
  fs.writeFileSync(path.join(ws.projectDir, 'shader.html'), `${'SHADER-SOUP '.repeat(40)}\n`);
  const { runAgent } = await import('../src/agent.js');
  const { makeFileTools } = await import('../src/tools/project-tools.js');
  const events = [];
  const ctx = { ...ctxFor('critic', ws), emit: (type, d) => events.push({ type, ...d }) };
  ctx.readLog = new Set(['hyperframes/references/review.md#1-measure-then-look', 'hyperframes/references/review.md#3-notes-and-fixes']);
  const out = await runAgent({
    role: 'critic', system: 'sys', task: 'task', tools: makeFileTools({ write: false }), ctx,
    handoff: { name: 'submit_test', description: 'd', parameters: { type: 'object', properties: { answer: { type: 'string' } } } },
  });
  server.close();
  assert.equal(out.result.answer, 'ok');
  assert.deepEqual(events.filter((e) => e.type === 'content_filter').map((e) => e.step), ['retry', 'withheld']);
});

await step('agent loop against a fake OpenAI-compatible server', async () => {
  const script = [
    { name: 'submit_test', args: { answer: 'too early' } },
    { name: 'skill_outline', args: { skill: 'hyperframes', file: 'references/look.md' } },
    { name: 'read_skill', args: { skill: 'hyperframes', file: 'references/look.md', section: 'the-look-line' } },
    { name: 'read_skill', args: { skill: 'hyperframes', file: 'references/story.md', section: '1-the-one-thing' } },
    { name: 'read_skill', args: { skill: 'hyperframes', file: 'references/types/launch.md', section: 'the-end-card' } },
    { name: 'submit_test', args: { answer: 'coral' } },
  ];
  let i = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      const s = script[Math.min(i++, script.length - 1)];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: `c${i}`, object: 'chat.completion', created: 0, model: parsed.model,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call${i}`, type: 'function', function: { name: s.name, arguments: JSON.stringify(s.args) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '', vision: false };
  config.roles.planner = 'fake';
  const { runAgent } = await import('../src/agent.js');
  const ctx = ctxFor('planner', ws);
  const out = await runAgent({
    role: 'planner', system: 'sys', task: 'task', tools: makeSkillTools(), ctx,
    handoff: { name: 'submit_test', description: 'd', parameters: { type: 'object', properties: { answer: { type: 'string' } } } },
  });
  server.close();
  assert.equal(out.result.answer, 'coral');
  assert.equal(out.usage.turns, 6);
  const toolMsgs = seen[5].messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /^Refused: Required reading is not done/);
  assert.match(toolMsgs[2].content, /hyperframes\/references\/look\.md#the-look-line/);
  assert.ok(seen[0].tools.some((t) => t.function.name === 'read_skill'));
});

await step('every pipeline prompt builds from the installed skills (a moved section fails here, not quietly in a film)', async () => {
  const { planSystem, storyGuides } = await import('../src/plan.js');
  const { scenePacket } = await import('../src/build/scenes.js');
  const { requireSection } = await import('../src/tools/skill-tools.js');
  assert.match(planSystem(lib), /<spec-template>\n\S[\s\S]*<look-line>\n\S/);
  const guides = storyGuides(lib, { kind: 'launch', format: { width: 1080, height: 1920 } });
  assert.ok(guides.story.length > 1000 && guides.types.length > 500, 'the story guide plus the launch and vertical type guides');
  const ctx = { format: { width: 1920, height: 1080, fps: 30 }, roles: { dark: true, ground: '#101014', ink: '#F2EDE4', accent: '#E8B14E', display: 'Inter', body: 'Inter' }, lib, items: {}, hasBackground: false };
  assert.match(scenePacket({ id: 'a', layer: 'main', duration: 3, text: ['Hi'] }, ctx).system, /<contract>\n\S[\s\S]*<design>\n\S/);
  assert.match(scenePacket({ id: 't-1', layer: 'transition', duration: 0.6, text: [] }, ctx).user, /<transitions>\n\S/);
  assert.throws(() => requireSection(lib, 'hyperframes', 'references/look.md', 'no-such-section'), /Skill section missing: hyperframes\/references\/look\.md#no-such-section/);
});

await step('scene writer replies: a fenced html block, the older JSON shape, or a bare template', async () => {
  const { extractHtml } = await import('../src/build/scenes.js');
  const file = '<template>\n  <div id="root" data-composition-id="a"></div>\n  <script>const s = `x`;</script>\n</template>';
  assert.equal(extractHtml(`Here is the scene.\n\`\`\`html\n${file}\n\`\`\`\n`), file);
  assert.equal(extractHtml(JSON.stringify({ html: file })), file);
  assert.equal(extractHtml(`\`\`\`json\n${JSON.stringify({ html: file })}\n\`\`\``), file);
  assert.equal(extractHtml(`Sure:\n${file}\nDone.`), file);
  assert.equal(extractHtml('```html\n<template>\n  <div id="root">cut off mid-'), null);
  assert.equal(extractHtml('I cannot help with that.'), null);
});

await step('tool arguments are checked against the tool schema: precise errors, lossless fixes, unknown keys dropped', async () => {
  const { checkArgs } = await import('../src/agent.js');
  const schema = {
    type: 'object',
    properties: {
      skill: { type: 'string' }, part: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'b'] }, on: { type: 'boolean' },
      list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    },
    required: ['skill'],
    additionalProperties: false,
  };
  assert.deepEqual(checkArgs(schema, { skill: 'x', part: 2 }), []);
  assert.deepEqual(checkArgs(schema, { file: 'y' }), ['args.skill is required']);
  const fixed = { skill: 'x', part: '2', on: 'true', note: 'extra' };
  assert.deepEqual(checkArgs(schema, fixed), []);
  assert.deepEqual(fixed, { skill: 'x', part: 2, on: true });
  assert.match(checkArgs(schema, { skill: 'x', part: 'two' }).join(), /args\.part must be integer, not string/);
  assert.match(checkArgs(schema, { skill: 'x', kind: 'c' }).join(), /args\.kind must be one of "a", "b"/);
  assert.match(checkArgs(schema, { skill: 'x', list: [{}] }).join(), /args\.list\[0\]\.id is required/);
  // The real case from a run: read_skill without its skill reached the tool as "undefined".
  const readSkill = makeSkillTools().find((t) => t.name === 'read_skill');
  assert.deepEqual(checkArgs(readSkill.parameters, { file: 'references/review.md', section: '3-notes-and-fixes' }), ['args.skill is required']);
});

await step('agent loop: a reply cut off at the output limit runs none of its tool calls and gets more room', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push(JSON.parse(body));
      const first = seen.length === 1;
      const fn = first
        ? { name: 'write_file', arguments: '{"path":"big.html","content":"<template>\\n  <div id=\\"root\\">' }
        : { name: 'submit_test', arguments: JSON.stringify({ answer: 'ok' }) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: first ? 'length' : 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${seen.length}`, type: 'function', function: fn }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '', vision: false };
  config.roles.fixer = 'fake';
  const { runAgent } = await import('../src/agent.js');
  const { makeFileTools } = await import('../src/tools/project-tools.js');
  const events = [];
  const ctx = { ...ctxFor('fixer', ws), emit: (type, d) => events.push({ type, ...d }) };
  ctx.readLog = new Set(['hyperframes/references/format.md#lint-errors-you-ll-meet-first']);
  const out = await runAgent({
    role: 'fixer', system: 'sys', task: 'task', tools: makeFileTools({ write: true }), ctx,
    handoff: { name: 'submit_test', description: 'd', parameters: { type: 'object', properties: { answer: { type: 'string' } } } },
  });
  server.close();
  assert.equal(out.result.answer, 'ok');
  assert.ok(!fs.existsSync(path.join(ws.projectDir, 'big.html')), 'the half-written file must not be written');
  assert.equal(seen[1].max_completion_tokens, seen[0].max_completion_tokens * 2);
  assert.match(String(seen[1].messages.at(-1).content), /cut off at the output limit/);
  assert.ok(events.some((e) => e.type === 'cut_off'));
});

await step('GLM: low effort turns thinking off, medium and up turn it on', async () => {
  const { requestBody } = await import('../src/llm.js');
  const glm = (effort) => requestBody({ kind: 'glm', model: 'glm', effort }, [], null).thinking?.type;
  assert.deepEqual(['none', 'low', 'medium', 'xhigh'].map(glm), ['disabled', 'disabled', 'enabled', 'enabled']);
  assert.equal(glm(''), undefined, 'no effort: the provider default');
});

await step('JSON replies: JSON mode on OpenAI/Azure, and one fresh ask when a reply is not valid JSON', async () => {
  const { requestBody } = await import('../src/llm.js');
  const { ask } = await import('../src/plan.js');
  assert.deepEqual(requestBody({ kind: 'azure', model: 'm' }, [], null, undefined, 100, true).response_format, { type: 'json_object' });
  assert.equal(requestBody({ kind: 'glm', model: 'm' }, [], null, undefined, 100, true).response_format, undefined);
  // What GPT-5 mini sent once: "description": "": "" — the job used to fail on it.
  const replies = ['{"background": {"description": "": ""}, "beats": []}', '{"beats": [{"id": "a"}]}'];
  let n = 0;
  const server = http.createServer((req, res) => {
    req.resume().on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'fake', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: replies[n++] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fake = { name: 'fake', kind: 'openai', apiKey: 'x', baseURL: `http://127.0.0.1:${server.address().port}/v1/`, model: 'fake', effort: '' };
  const usage = { input: 0, output: 0, calls: 0 };
  const out = await ask(fake, 'Reply with JSON only', 'brief', usage, { label: 'understand' });
  server.close();
  assert.deepEqual(out, { beats: [{ id: 'a' }] });
  assert.equal(usage.calls, 2);
});

await step('a scene must show its copy whole as visible text (not only in an attribute or split by a typo)', async () => {
  const { staticProblems } = await import('../src/build/scenes.js');
  const ok = '<template><div id="root" data-composition-id="a"><div class="clip" data-start="0" data-duration="2"><span>Slow</span> <span>Mornings</span></div></div><script>window.__timelines["a"] = tl;</script></template>';
  assert.deepEqual(staticProblems(ok, 'a', 2, ['Slow Mornings']), []);
  // The real case: the "s" lived only in aria-label.
  const lost = ok.replace('<span>Slow</span> <span>Mornings</span>', '<div aria-label="Slow Mornings">Slow&nbsp;Mornin<span>g</span></div>');
  assert.match(staticProblems(lost, 'a', 2, ['Slow Mornings']).join(), /"Slow Mornings" is not in the markup whole/);
  // Per-letter spans, capitals by CSS and HTML entities still count as the copy.
  const letters = ok.replace('<span>Slow</span> <span>Mornings</span>', 'SLOW&nbsp;<b>M</b><b>O</b>RNINGS &amp; co');
  assert.deepEqual(staticProblems(letters, 'a', 2, ['Slow Mornings & co']), []);
});

await step('stock media: lightest sharp file, downloaded and credited; scenes and fallbacks use it by the contract', async () => {
  const { getStock, pickFile, creditsMarkdown } = await import('../src/media/stock.js');
  const { fallbackScene } = await import('../src/build/scene-files.js');
  const { scenePacket, staticProblems } = await import('../src/build/scenes.js');
  const files = [{ link: 'a', width: 3840, height: 2160, type: 'video/mp4' }, { link: 'b', width: 1280, height: 720, type: 'video/mp4' }, { link: 'c', width: 640, height: 360, type: 'video/mp4' }];
  assert.equal(pickFile(files, { width: 1920, height: 1080 }).link, 'b', 'the smallest file that is still sharp');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith('/v1/videos/search')) {
      assert.equal(req.headers.authorization, 'test-key');
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ videos: [
        { id: 7, duration: 2, url: 'p7', user: { name: 'Short', url: 'u7' }, video_files: [{ link: `${base}/f/7.mp4`, width: 1920, height: 1080, file_type: 'video/mp4' }] },
        { id: 8, duration: 12, url: 'https://www.pexels.com/video/8', user: { name: 'Ana', url: 'https://www.pexels.com/@ana' }, video_files: [{ link: `${base}/f/8-4k.mp4`, width: 3840, height: 2160, file_type: 'video/mp4' }, { link: `${base}/f/8-hd.mp4`, width: 1280, height: 720, file_type: 'video/mp4' }] },
      ] }));
    }
    if (req.url === '/f/8-hd.mp4') return res.end(Buffer.from('00000020ftypisom-fake-video', 'latin1'));
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = { key: process.env.PEXELS_API_KEY, base: process.env.PEXELS_API_BASE, pix: process.env.PIXABAY_API_KEY };
  Object.assign(process.env, { PEXELS_API_KEY: 'test-key', PEXELS_API_BASE: `http://127.0.0.1:${server.address().port}` });
  delete process.env.PIXABAY_API_KEY;
  try {
    const m = await getStock({ kind: 'video', query: 'surf at dawn', format: { width: 1920, height: 1080 }, minSeconds: 4, projectDir: ws.projectDir, name: 'wave' });
    assert.equal(m.file, 'assets/media/wave.mp4', JSON.stringify(m));
    assert.deepEqual([m.width, m.credit.name, m.source], [1280, 'Ana', 'pexels'], 'too-short clips are skipped; the HD file is chosen');
    assert.ok(fs.existsSync(path.join(ws.projectDir, 'assets/media/wave.mp4')));
    assert.match(creditsMarkdown([{ scene: 'wave', ...m }]), /wave: video "surf at dawn" by \[Ana\]\(https:\/\/www\.pexels\.com\/@ana\) on \[Pexels\]/);
    const scene = { id: 'wave', layer: 'main', duration: 4, text: ['Is it worth paddling out?'], stock: m };
    const fb = fallbackScene(scene, { width: 1920, height: 1080 }, { dark: true });
    assert.deepEqual(staticProblems(fb, 'wave', 4, scene.text, m.file), [], 'the code fallback keeps the footage and passes the contract');
    assert.match(fb, /<video id="wave-media" class="clip" data-start="0" data-duration="4" src="assets\/media\/wave\.mp4" muted playsinline/);
    assert.match(staticProblems(fb.replace(m.file, 'x.mp4'), 'wave', 4, scene.text, m.file).join(), /backdrop assets\/media\/wave\.mp4 is missing/);
    const ctx = { format: { width: 1920, height: 1080, fps: 30 }, roles: { dark: true, ground: '#0E2A33', ink: '#F3EFE6', accent: '#FF7A45', display: 'Inter', body: 'Inter' }, lib, items: {}, hasBackground: false };
    assert.match(scenePacket(scene, ctx).user, /MEDIA: this scene's backdrop is the stock video assets\/media\/wave\.mp4/);
  } finally {
    server.close();
    for (const [k, v] of [['PEXELS_API_KEY', saved.key], ['PEXELS_API_BASE', saved.base], ['PIXABAY_API_KEY', saved.pix]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

await step('a beat the brief gives footage must get media in the plan', async () => {
  const { planChecks } = await import('../src/plan.js');
  const saved = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = 'test-key';
  try {
    const brief = { beats: [{ id: 'hook', start: 0, end: 4, copy: ['Is it worth paddling out?'], footage: 'surfer paddling out at dawn' }, { id: 'name', start: 4, end: 7, copy: ['Tidepool'], footage: '' }] };
    const sl = { blocks: {}, components: {} };
    const scenes = [{ id: 'hook', start: 0, duration: 4, text: ['Is it worth paddling out?'], block: null }, { id: 'name', start: 4, duration: 3, text: ['Tidepool'], block: null }];
    assert.match(planChecks({ theme: {}, scenes }, brief, sl).join(), /hook: the brief gives this beat footage/);
    scenes[0].media = { kind: 'video', query: 'surfer paddling out at dawn, empty beach' };
    assert.deepEqual(planChecks({ theme: {}, scenes }, brief, sl), []);
  } finally {
    if (saved === undefined) delete process.env.PEXELS_API_KEY; else process.env.PEXELS_API_KEY = saved;
  }
});

await step('sound effects land their loudest moment on the cue, inside the film, spaced and capped', async () => {
  const { placeSfx, sfxLibrary, sfxMarkup } = await import('../src/build/sfx.js');
  const lib = sfxLibrary();
  assert.ok(lib.length >= 19, `the bundled library is there (${lib.length} sounds)`);
  const plan = (scenes) => ({ format: { duration: 12 }, scenes });
  const scene = (id, start, duration, sound, layer = 'main') => ({ id, start, duration, sound, layer });

  // A whoosh peaks 0.17 s in: cued at 4.0 s, it starts at 3.83 s. An impact peaks at once.
  let cues = placeSfx(plan([scene('a', 0, 4, []), scene('b', 4, 8, [{ name: 'whoosh', at: 0 }, { name: 'Impact Bass 1', at: 1 }])]), lib);
  assert.deepEqual(cues.map((c) => [c.name, c.start]), [['whoosh', 3.83], ['impact-bass-1', 4.9]]);
  assert.match(sfxMarkup(cues), /<audio id="sfx-1" class="clip" src="assets\/sfx\/whoosh\.mp3" data-start="3\.83" data-duration="0\.36" data-track-index="20" data-volume="0\.35"><\/audio>/);

  // The riser peaks 3.02 s in: a hit at 1 s has no room to build up, a hit at 5 s does.
  assert.deepEqual(placeSfx(plan([scene('a', 0, 12, [{ name: 'riser', at: 1 }])]), lib), []);
  assert.equal(placeSfx(plan([scene('a', 0, 12, [{ name: 'riser', at: 5 }])]), lib)[0].start, 1.98);

  // Unknown names and hits closer than 0.25 s are dropped; a sound cut off by the film's end fades out.
  cues = placeSfx(plan([scene('a', 0, 12, [{ name: 'explosion', at: 1 }, { name: 'pop', at: 2 }, { name: 'click', at: 2.1 }, { name: 'chime', at: 11.5 }])]), lib);
  assert.deepEqual(cues.map((c) => c.name), ['pop', 'chime']);
  assert.ok(cues[1].start + cues[1].duration <= 12 && cues[1].fadeOut > 0, 'trimmed at the end, with a fade');

  // Different families layer on one moment (whoosh into impact), at most two; the same family there is dropped.
  cues = placeSfx(plan([scene('a', 0, 12, [{ name: 'whoosh', at: 3 }, { name: 'impact-bass-1', at: 3.02 }, { name: 'sparkle', at: 3.05 }, { name: 'whoosh-short', at: 6 }, { name: 'whoosh', at: 6.1 }])]), lib);
  assert.deepEqual(cues.map((c) => c.name), ['whoosh', 'impact-bass-1', 'whoosh-short']);

  // Too many moments: the cap (one per 1.2 s) keeps the end card's hit and drops later middle ones.
  const busy = Array.from({ length: 10 }, (_, i) => ({ name: i % 2 ? 'pop' : 'click', at: i * 0.5 }));
  cues = placeSfx({ format: { duration: 6 }, scenes: [scene('a', 0, 5, busy), scene('end', 5, 1, [{ name: 'impact-bass-1', at: 0.2 }])] }, lib);
  assert.equal(cues.length, 5, 'five moments in six seconds');
  assert.equal(cues.at(-1).name, 'impact-bass-1', 'the closing hit survives the cap');
  assert.deepEqual(cues.map((c) => c.start), [...cues.map((c) => c.start)].sort((x, y) => x - y), 'in time order');

  // No cues in the plan: a whoosh on each cut, a hit as the last scene lands. Overlays don't count as cuts.
  cues = placeSfx(plan([scene('a', 0, 4, undefined), scene('b', 4, 4, undefined), scene('c', 8, 4, undefined), scene('o', 2, 3, undefined, 'overlay')]), lib);
  assert.deepEqual(cues.map((c) => c.name), ['whoosh', 'whoosh', 'impact-bass-1']);
});

await step('the sound shapes match the files (loudest moment re-measured with ffmpeg)', async () => {
  const { SFX_DIR, SHAPE } = await import('../src/build/sfx.js');
  const { execFileSync } = await import('node:child_process');
  for (const name of ['riser', 'whoosh-cinematic', 'impact-bass-1', 'whoosh']) {
    let pcm;
    try {
      pcm = execFileSync(process.env.HYPERFRAMES_FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(SFX_DIR(), `${name}.mp3`), '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 26 });
    } catch {
      return; // no ffmpeg here: nothing to compare against
    }
    const win = 400;
    let best = 0;
    let at = 0;
    for (let s = 0; s + win <= pcm.length / 2; s += 80) {
      let e = 0;
      for (let i = s; i < s + win; i++) e += pcm.readInt16LE(i * 2) ** 2;
      if (e > best) [best, at] = [e, s];
    }
    const peak = (at + win / 2) / 8000;
    assert.ok(Math.abs(peak - SHAPE[name][0]) < 0.15, `${name}: measured peak ${peak.toFixed(2)} s, table says ${SHAPE[name][0]} s`);
  }
});

await step('without a GPU, a written scene that uses WebGPU is sent back to be rebuilt', async () => {
  const { staticProblems } = await import('../src/build/scenes.js');
  const { config } = await import('../src/config.js');
  const scene = (body) => `<template><div id="root" data-composition-id="s" ${body}></div><script>window.__timelines["s"] = gsap.timeline({ paused: true });</script></template>`;
  const saved = config.renderGpu;
  try {
    config.renderGpu = false;
    assert.match(staticProblems(scene('data-requires-webgpu'), 's', 3).join(), /no GPU: build the effect with CSS 3D transforms, canvas 2D or SVG/);
    assert.deepEqual(staticProblems(scene(''), 's', 3), []);
    // three.js 3D stalls software rendering too (a carousel with shadows stopped a real render at frame 180).
    const { needsGpu } = await import('../src/build/scenes.js');
    assert.equal(needsGpu('<script type="importmap">{"imports": {"three": "./assets/three.module.min.js"}}</script>'), true);
    assert.equal(needsGpu('<script type="module">import * as THREE from "three";</script>'), true);
    assert.equal(needsGpu('<div style="transform: perspective(800px) rotateY(20deg)"></div>'), false, 'CSS 3D is fine');
    config.renderGpu = true;
    assert.deepEqual(staticProblems(scene('data-requires-webgpu'), 's', 3), [], 'a host with a GPU keeps it');
  } finally {
    config.renderGpu = saved;
  }
});

await step('a composition that needs WebGPU is found, so a GPU-less host renders it in software', async () => {
  const { requiresWebgpu } = await import('../src/orchestrator.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgpu-'));
  try {
    fs.mkdirSync(path.join(dir, 'compositions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'compositions', 'title.html'), '<template><div></div></template>');
    assert.equal(requiresWebgpu(dir), false);
    fs.writeFileSync(path.join(dir, 'compositions', 'blob.html'), '<template><div data-requires-webgpu></div></template>');
    assert.equal(requiresWebgpu(dir), false, 'an installed block nothing plays (its scene was rebuilt) does not count');
    fs.writeFileSync(path.join(dir, 'index.html'), '<div id="root"><div data-composition-src="compositions/blob.html"></div></div>');
    assert.equal(requiresWebgpu(dir), true, 'a WebGPU block the film plays');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await step('registry items the request names can be adapted into a hand-built scene', async () => {
  const { planChecks, namedCandidates } = await import('../src/plan.js');
  // The names come from the request's own words (a corrupted \b once made this find nothing).
  assert.deepEqual(namedCandidates('Adapt the code-typing and vfx-shatter registry blocks.'), ['code-typing', 'vfx-shatter']);
  const typing = { name: 'code-typing', type: 'block', description: 'Token-streamed typing reveal', textVars: [], imageVars: [], colorVars: [], otherVars: [] };
  const sl = { blocks: { term: [] }, components: {}, requested: [typing] };
  const brief = { beats: [{ id: 'term', start: 0, end: 4, copy: ['npx skills add heygen-com/hyperframes'] }] };
  const scene = { id: 'term', start: 0, duration: 4, text: brief.beats[0].copy, block: null, components: [], adapt: ['code-typing'], vars: {} };
  assert.deepEqual(planChecks({ theme: {}, scenes: [scene] }, brief, sl), []);
  assert.match(planChecks({ theme: {}, scenes: [{ ...scene, block: 'code-typing' }] }, brief, sl).join(), /adapts an item is hand-built/);
  assert.match(planChecks({ theme: {}, scenes: [{ ...scene, adapt: ['made-up'] }] }, brief, sl).join(), /adapt names made-up/);
  assert.match(planChecks({ theme: {}, scenes: [{ ...scene, adapt: [], components: ['code-terminal-run'] }] }, brief, sl).join(), /the request names code-typing: use it/, 'a look-alike does not count');
});

await step('a film is never longer than the length chosen in the app', async () => {
  const { checkSettings, planChecks, withFormat } = await import('../src/plan.js');
  // A plan or brief that leaves its format out gets it filled (a real run stopped on "runs undefined s").
  assert.deepEqual(withFormat(undefined, { width: 1920, duration: 15 }), { width: 1920, duration: 15 });
  assert.deepEqual(withFormat({ width: 1080, duration: null }, { width: 1920, duration: 15 }), { width: 1080, duration: 15 });
  const brief = (duration) => ({ format: { width: 1920, height: 1080, fps: 30, duration }, audio: 'sfx', beats: [] });
  // A free user picks 15 s and writes "make it 45 seconds": the brief must come back to 15.
  assert.match(checkSettings(brief(45), { aspect: '16:9', duration: 15 }).join(), /format.duration must be 15/);
  assert.deepEqual(checkSettings(brief(15), { aspect: '16:9', duration: 15 }), []);
  // Every problem is reported at once: the brief gets one repair round.
  assert.equal(checkSettings({ ...brief(45), format: { width: 1080, height: 1920, duration: 45 } }, { aspect: '16:9', duration: 15, sound: false }).length, 3);
  assert.match(planChecks({ format: { duration: 45 }, scenes: [] }, brief(15), { blocks: {}, components: {} }).join(), /format.duration must be 15/);
});

await step('an effort chosen for the run reaches every role, scene writing included', async () => {
  const { config, providerForRole, useEffort } = await import('../src/config.js');
  const roles = { ...config.roles };
  config.providers.fake = { kind: 'openai', apiKey: 'x', baseURL: 'http://127.0.0.1:9/v1/', model: 'fake', effort: '', vision: false };
  try {
    for (const r of Object.keys(roles)) config.roles[r] = 'fake';
    useEffort('low');
    assert.deepEqual(['planner', 'builder', 'critic', 'fixer'].map((r) => providerForRole(r).effort), ['low', 'low', 'low', 'low']);
    useEffort('');
    assert.equal(providerForRole('builder').effort, process.env.BUILDER_EFFORT || 'medium', 'cleared: back to the role default');
    // Two films at once on the server: each sees only its own provider, model and effort, across awaits.
    const { withRunSettings } = await import('../src/config.js');
    config.providers.fake2 = { ...config.providers.fake, model: 'fake2-default' };
    const film = (settings) => withRunSettings(settings, async () => {
      await new Promise((r) => setTimeout(r, 5));
      const p = providerForRole('builder');
      return [p.name, p.model, p.effort];
    });
    assert.deepEqual(await Promise.all([film({ provider: 'fake', model: 'm-a', effort: 'low' }), film({ provider: 'fake2', effort: 'high' })]),
      [['fake', 'm-a', 'low'], ['fake2', 'fake2-default', 'high']]);
    assert.equal(providerForRole('builder').model, 'fake', 'outside a film, the shared settings are untouched');
  } finally {
    useEffort('');
    Object.assign(config.roles, roles);
  }
});

await step("a film's OpenRouter provider choice and image support reach the request", async () => {
  const { config, providerForRole, withRunSettings } = await import('../src/config.js');
  const { requestBody } = await import('../src/llm.js');
  config.providers.fakeor = { kind: 'openrouter', apiKey: 'x', baseURL: 'http://127.0.0.1:9/v1/', model: 'vendor/default', effort: '', vision: true, route: '' };
  try {
    const film = (settings) => withRunSettings({ provider: 'fakeor', ...settings }, async () => providerForRole('builder'));
    const pinned = await film({ model: 'deepseek/deepseek-v4.1-flash', route: 'baidu/fp8', vision: false });
    assert.deepEqual([pinned.route, pinned.vision], ['baidu/fp8', false]);
    // The user's own example: only that provider, no fallback.
    assert.deepEqual(requestBody(pinned, []).provider, { only: ['baidu/fp8'], allow_fallbacks: false });
    assert.deepEqual(requestBody(await film({ route: 'price' }), []).provider, { sort: 'price' });
    const auto = await film({});
    assert.equal(requestBody(auto, []).provider, undefined, 'no choice: OpenRouter balances');
    assert.equal(auto.vision, true, "a model with no vision flag keeps the provider's");
    assert.equal(requestBody({ ...config.providers.fakeor, kind: 'azure', route: 'baidu/fp8' }, []).provider, undefined, 'only OpenRouter takes a route');
  } finally {
    delete config.providers.fakeor;
  }
});

await step('ids a model leaves out are filled in code, never "undefined"', async () => {
  const { fillIds } = await import('../src/plan.js');
  // What GLM's story step returned: transitions with no id.
  const b = fillIds({ beats: [{ id: 'three-apps' }, { id: 'The Question' }, {}], transitions: [{ at: 4, kind: 'cover' }, { id: '', at: 8, kind: 'handoff' }] });
  assert.deepEqual(b.beats.map((x) => x.id), ['three-apps', 'the-question', 'beat-3']);
  assert.deepEqual(b.transitions.map((x) => x.id), ['t-1', 't-2']);
  assert.equal(fillIds(null), null);
});

await step('a block that draws its copy too small is scaled around it, inside the safe margin', async () => {
  const { fitScale } = await import('../src/build/index.js');
  // The Kernwerk wordmark: 14% wide, centred → 2.5x (the cap).
  assert.deepEqual(fitScale({ x: 0.43, y: 0.47, w: 0.14, h: 0.06 }), { k: 2.5, ox: 50, oy: 50 });
  // Near the left edge: the margin limits the scale, so the copy stays inside 5–95%.
  assert.deepEqual(fitScale({ x: 0.1, y: 0.45, w: 0.2, h: 0.1 }), { k: 1.5, ox: 20, oy: 50 });
  assert.equal(fitScale({ x: 0.06, y: 0.45, w: 0.2, h: 0.1 }), null, 'hard against the edge: no room to grow');
  // Already big enough: left alone.
  assert.equal(fitScale({ x: 0.25, y: 0.45, w: 0.5, h: 0.1 }), null);
});

await step('plan and build model calls are archived, each system prompt once', () => {
  ws.logCall({ label: 'write headline', system: 'SYS', user: 'u1', reply: 'r1' });
  ws.logCall({ label: 'repair headline', system: 'SYS', user: 'u2', reply: 'r2' });
  const files = fs.readdirSync(ws.meta('calls')).sort();
  assert.equal(files.filter((f) => f.startsWith('system-')).length, 1);
  assert.deepEqual(files.filter((f) => /^\d/.test(f)), ['001-write-headline.json', '002-repair-headline.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.meta('calls'), '002-repair-headline.json'), 'utf8')).reply, 'r2');
});

if (!quick) {
  const { initProject, installRegistryItems } = await import('../src/orchestrator.js');
  const { applyTheme, catalogSearch, listThemes } = await import('../src/tools/registry-tools.js');
  const { runCheck, runSnapshot } = await import('../src/tools/project-tools.js');

  await step('hyperframes init into the job project', async () => {
    await initProject(ws);
    assert.ok(fs.existsSync(path.join(ws.projectDir, 'index.html')));
    assert.ok(!fs.existsSync(path.join(ws.projectDir, 'AGENTS.md')));
  });

  await step('themes: list and apply a preset', () => {
    const themes = listThemes();
    assert.ok(themes.length >= 10);
    const coral = themes.find((t) => t.name === 'coral');
    assert.equal(coral.colors.coral, '#E85D5D');
    assert.ok(coral.fonts.includes('Bebas Neue'));
    const applied = applyTheme(ws, { preset: 'coral' });
    assert.ok(fs.existsSync(path.join(ws.projectDir, 'frame.md')));
    assert.equal(applied.colors.cream, '#F5F0E8');
  });

  await step('registry: catalog search and install a block', async () => {
    const r = await catalogSearch(ws, { query: 'headline reveal title card', type: 'block', limit: 5 });
    assert.ok(r.items.length > 0, r.text);
    const plan = { scenes: [{ id: 'open', block: r.items[0].name, components: [] }] };
    const report = await installRegistryItems(ws, plan, () => {});
    assert.match(report, /mount: <div data-composition-id=/);
    assert.match(report, /variables: /);
  });

  await step('registry: long queries fall back to keywords; inspect reports what an item exposes', async () => {
    const { inspectItem } = await import('../src/tools/registry-tools.js');
    const r = await catalogSearch(ws, { query: 'animated aurora background shader gradient field background loop', type: 'block', limit: 8 });
    assert.ok(r.items.some((i) => /aurora|gradient|shader/.test(i.name + i.tags.join(' '))), r.text);
    const carousel = await inspectItem(ws, 'carousel-text-circle-1');
    assert.ok(carousel.ok && carousel.imageVars.length >= 6, JSON.stringify(carousel));
    const title = await inspectItem(ws, 'canopy-part-title');
    assert.ok(title.textVars.includes('headline1'), JSON.stringify(title));
    assert.ok(JSON.parse(fs.readFileSync(path.join(config.jobsDir, '.cache', 'registry-inspect.json'), 'utf8'))['canopy-part-title'], 'cached across jobs');
    assert.ok(title.media.length > 0, 'canopy-part-title ships leaf pictures: the shortlist must skip it');
  });

  await step('check and snapshot produce agent-sized summaries', async () => {
    const c = await runCheck(ws);
    assert.match(c.text, /^(PASS|FAIL): \d+ errors/);
    const s = await runSnapshot(ws);
    assert.ok(s.ok, s.text);
    assert.ok(s.images.length > 0);
  });
}

fs.rmSync(tmpJobs, { recursive: true, force: true });
console.log(`\n${passed} checks passed${quick ? ' (quick: CLI steps skipped)' : ''}`);
