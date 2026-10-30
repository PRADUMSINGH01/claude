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
  assert.deepEqual(PROVIDER_NAMES.sort(), ['azure', 'claude', 'gemini', 'glm', 'openai']);
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

await step('scene writer: a missing or misnamed timeline registration is fixed in code', async () => {
  const { ensureRegistered, staticProblems } = await import('../src/build/scenes.js');
  const draft = '<template><div id="root" data-composition-id="a"></div><script>\n const tl = gsap.timeline({ paused: true });\n</script></template>';
  assert.deepEqual(staticProblems(ensureRegistered(draft, 'a'), 'a', 3), []);
  assert.match(ensureRegistered(draft.replace('</script>', 'window.__timelines["root"] = tl;</script>'), 'a'), /__timelines\["a"\] = tl/);
  assert.equal(ensureRegistered('<template><script>1</script></template>', 'a'), '<template><script>1</script></template>');
});

await step('palette: full colour world from the theme; given colours kept; blocks and shaders take it', async () => {
  const { buildPalette, roleColour, shaderColours, oklch, contrast } = await import('../src/build/palette.js');
  const { shaderProps } = await import('../src/build/assemble.js');
  const p = buildPalette({ ground: '#07101F', ink: '#F0EBDE', accent: '#5560E5' });
  assert.equal(p.accent, '#5560E5');
  assert.equal(p.ink, '#F0EBDE');
  assert.notEqual(p.accent2, p.accent, 'a missing second accent is derived, not a copy');
  const h = oklch(p.accent2)[2];
  assert.ok(h < 285 || h > 330, `second accent hue ${h} is out of the violet band`);
  assert.ok(contrast(p.muted, p.ground) >= 4.5 && contrast(p.accent2, p.ground) >= 3);
  assert.match(buildPalette({ ground: '#FFFFFF', ink: '#BBBBBB', accent: '#FFE600' }).warnings.join(), /1\.9:1.*4\.5:1/);
  assert.equal(roleColour('bgColor', '#000000', p), p.ground);
  assert.equal(roleColour('titleColor', '#ffffff', p), p.ink);
  assert.ok([p.accent, p.accent2].includes(roleColour('c1', '#22ee88', p)), 'a saturated default maps to an accent');
  assert.deepEqual(Object.keys(shaderColours([['colorA', '#a533f8'], ['colorB', '#22ee88'], ['colorBorder', '#000000']], p)), ['colorA', 'colorB', 'colorBorder']);
  assert.equal(shaderColours([['colorBorder', '#000000']], p).colorBorder, p.ground);
  const bundle = 'x,Aurora",role:"generator",props:{colorA:{default:"#a533f8",x:1},speed:{default:5},colorB:{default:"#22ee88"}},y,role:"other",colorZ:{default:"#ffffff"}';
  assert.deepEqual(shaderProps(bundle, 'Aurora'), [['colorA', '#a533f8'], ['colorB', '#22ee88']]);
});

await step('look: named palettes read; a colour reference image gives ground, ink and accents', async () => {
  const { PALETTES, clusterColours, rolesFromSwatches } = await import('../src/look.js');
  const { contrast } = await import('../src/build/palette.js');
  for (const p of PALETTES) {
    const c = p.colors;
    assert.ok(contrast(c.ink, c.ground) >= 4.5, `${p.id}: ink`);
    assert.ok(contrast(c.accent, c.ground) >= 3 && contrast(c.accent2, c.ground) >= 3, `${p.id}: accents`);
  }
  // 60% green ground, 20% cream, 10% orange, 10% teal.
  const px = [];
  const put = (rgb, n) => { for (let i = 0; i < n; i++) px.push(...rgb); };
  put([0x1f, 0x3d, 0x2b], 1380); put([0xf2, 0xe8, 0xd5], 460); put([0xe8, 0x76, 0x2c], 230); put([0x2b, 0xa6, 0xa0], 234);
  const sw = clusterColours(Buffer.from(px));
  assert.equal(sw[0].hex, '#1F3D2B');
  assert.deepEqual(rolesFromSwatches(sw), { ground: '#1F3D2B', ink: '#F2E8D5', accent: '#E8762C', accent2: '#2BA6A0' });
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
    assert.ok(fs.existsSync(ws.meta('inspect-cache.json')));
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
