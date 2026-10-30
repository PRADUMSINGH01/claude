#!/usr/bin/env node
// motion run "<prompt>" [--theme coral] [--aspect 9:16] [--duration 20] [--jobs dir]
// motion resume <job-dir>
// motion themes | motion skills <role> | motion providers
import { parseArgs } from 'node:util';
import { config, providerStatus, useProvider } from '../src/config.js';
import { runJob } from '../src/orchestrator.js';
import { runPlan } from '../src/plan.js';
import { runBuild } from '../src/build/index.js';
import { SkillLibrary } from '../src/skills/library.js';
import { skillMap } from '../src/tools/skill-tools.js';
import { listThemes } from '../src/tools/registry-tools.js';
import { PALETTES } from '../src/look.js';
import { consoleLines } from '../src/transcript.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    theme: { type: 'string' },
    palette: { type: 'string' },
    'color-ref': { type: 'string' },
    aspect: { type: 'string' },
    duration: { type: 'string' },
    jobs: { type: 'string' },
    provider: { type: 'string' },
    planner: { type: 'string' },
    builder: { type: 'string' },
    critic: { type: 'string' },
    fixer: { type: 'string' },
    json: { type: 'boolean', default: false },
    look: { type: 'boolean', default: false },
    'no-render': { type: 'boolean', default: false },
    'max-tokens': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [cmd, ...rest] = positionals;
const USAGE = `motion run "<prompt>" [--theme <preset>] [--aspect 16:9|9:16|1:1] [--duration <s>] [--json]
motion resume <job-dir> [--json]
motion plan "<prompt>"           plan only (no video): brief → story → shortlist → plan → rating
                                 [--palette <id>] [--color-ref <image file|https URL>] [--aspect] [--duration] [--theme]
motion palettes                  named colour palettes for --palette
motion build <plan-job-dir>      build an approved plan: assemble → write scenes → verify → render  [--look] [--no-render] [--max-tokens N]
motion providers                 which AI providers have keys, their models, which role uses which
motion themes
motion skills <planner|builder|critic|fixer>

Provider for this run (overrides .env): --provider gemini|openai|claude|azure|glm
One role only:                           --planner X  --builder X  --critic X  --fixer X`;

// Flags beat .env: --provider sets every role, then a role flag sets just that role.
function applyProviderFlags() {
  if (values.provider) useProvider(values.provider);
  for (const role of ['planner', 'builder', 'critic', 'fixer']) if (values[role]) useProvider(values[role], [role]);
}

function printBuildEvent(ev) {
  if (values.json) return console.log(JSON.stringify(ev));
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  switch (ev.type) {
    case 'step': return console.log(`
■ ${ev.step}`);
    case 'assemble':
      if (ev.step === 'theme') return console.log(`  theme: ground ${ev.roles.ground} ink ${ev.roles.ink} accent ${ev.roles.accent} · fonts ${ev.fonts.map((f) => `${f.family} (${f.how})`).join(', ')}`);
      if (ev.step === 'install') return console.log(`  install ${ev.name} (${ev.kind}${ev.kind === 'component' ? (ev.mountable ? ', mountable' : ', snippet') : ''})`);
      return undefined;
    case 'assembled':
      for (const s of ev.scenes) console.log(`  ${s.id}: ${s.mode}${s.item ? ` ${s.item}` : ''}`);
      for (const w of ev.warnings) console.log(`  ⚠ ${w}`);
      return undefined;
    case 'scene': return console.log(`  ${ev.id}: ${ev.step}${ev.problems ? ` — ${[].concat(ev.problems).join(' | ').slice(0, 220)}` : ''}`);
    case 'call': return console.log(`    model: ${ev.label} (${k(ev.tokens)} tokens)`);
    case 'check': return console.log(`  check ${ev.round}: ${ev.errors} errors, ${ev.warnings} warnings${ev.failing.length ? `; failing: ${ev.failing.join(', ')}` : ''}`);
    case 'measured': return console.log(ev.issues.length ? ev.issues.map((i) => `  ✗ ${i.id}: ${String(i.problem).slice(0, 220)}`).join('\n') : '  ✓ measured checks pass');
    case 'escalate': return console.log(ev.scenes.map((s) => `  ↑ ${s.id}: ${s.from} → written scene (${String(s.why).slice(0, 160)})`).join('\n'));
    case 'look': return console.log(ev.issues.length ? ev.issues.map((i) => `  👁 ${i.scene}: ${i.problem} → ${i.fix}`).join('\n') : '  👁 no visible issues');
    case 'cap': return console.log(`  ⛔ token cap reached (${k(ev.used)} of ${k(ev.maxTokens)}): ${ev.label} skipped, fallback used`);
    case 'error': return console.log(`  ✖ ${ev.label}: ${ev.error}`);
    case 'render_done': return console.log(`  render ${ev.ok ? 'ok' : 'FAILED'}`);
    case 'done': return console.log(`
■ done: ${ev.usage.calls} model calls, ${k(ev.usage.input)} in / ${k(ev.usage.output)} out, ${ev.usage.minutes} min
  video: ${ev.video ?? '(none)'}
  report: ${ev.report}`);
    default: return undefined;
  }
}

function printPlanEvent(ev) {
  if (values.json) return console.log(JSON.stringify(ev));
  const k = (n) => `${(n / 1000).toFixed(1)}k`;
  switch (ev.type) {
    case 'step': return console.log(`\n■ ${ev.step}${ev.provider ? `  (${ev.provider})` : ''}`);
    case 'repair': return console.log(`  ↻ repair ${ev.step}: ${ev.errors.join(' | ').slice(0, 300)}`);
    case 'palette': return console.log(`  colours from the ${ev.source}: ${Object.entries(ev.colors).map(([k, v]) => `${k} ${v}`).join(', ')}${ev.swatches ? `\n  swatches: ${ev.swatches.map((x) => `${x.hex} ${Math.round(x.weight * 100)}%`).join(', ')}` : ''}`);
    case 'story':
      if (ev.skipped) return console.log(`  story: skipped (${ev.skipped})`);
      ev.story.storylines.forEach((x, i) => console.log(`  ${i === ev.story.pick ? '★' : ' '} ${x.name}: ${x.device} · ${x.form}`));
      return console.log(`  built: ${ev.story.storylines[ev.story.pick].name} (${ev.story.reason})`);
    case 'brief': {
      const b = ev.brief;
      console.log(`  "${b.title}" — ${b.kind}, ${b.format?.width}x${b.format?.height}, ${b.format?.duration}s, audio ${b.audio}`);
      console.log(`  look: ${b.look?.preset ?? Object.entries(b.look?.colors ?? {}).map(([n, v]) => `${n} ${v}`).join(', ')}  fonts: ${(b.look?.fonts ?? []).join(', ')}`);
      if (b.background?.wanted) console.log(`  background: ${b.background.description}`);
      for (const x of b.beats ?? []) console.log(`  ${String(x.start).padStart(4)}–${x.end}s  ${x.id}: ${(x.copy ?? []).map((c) => `"${c}"`).join(' ') || '(no copy)'}  [${x.intent}]`);
      for (const o of b.overlays ?? []) console.log(`  overlay ${o.start}–${o.end}s ${o.id} (${o.position}): ${(o.copy ?? []).map((c) => `"${c}"`).join(' ')}`);
      for (const a of b.assumptions ?? []) console.log(`  assumed: ${a}`);
      if (ev.errors.length) console.log(`  ⚠ brief still has: ${ev.errors.join(' | ')}`);
      return;
    }
    case 'shortlist':
      for (const [beat, items] of Object.entries(ev.lists.blocks)) {
        const comps = (ev.lists.components[beat] ?? []).map((i) => i.name);
        console.log(`  ${beat}: ${items.map((i) => i.name).join(', ') || '(no block fits → hand-build)'}${comps.length ? `   components: ${comps.join(', ')}` : ''}`);
      }
      return;
    case 'plan': {
      for (const s of ev.plan.scenes) console.log(`  ${(s.layer ?? 'main').padEnd(10)} ${String(s.start).padStart(4)}–${+(s.start + s.duration).toFixed(2)}s  ${s.id}: ${s.block ?? 'hand-built'}${s.components?.length ? ` + ${s.components.join(', ')}` : ''}  ${Object.keys(s.vars ?? {}).length ? `vars ${JSON.stringify(s.vars).slice(0, 90)}` : ''}`);
      console.log(`  theme: ${ev.plan.theme?.preset ?? JSON.stringify(ev.plan.theme?.colors ?? {})}`);
      if (ev.problems) console.log(`  ⚠ plan checks: ${ev.problems.split('\n').join(' | ').slice(0, 400)}`);
      console.log(`\n■ rating ${ev.rating.score}/${ev.rating.max}`);
      for (const i of ev.rating.items) console.log(`  ${i.points === i.max ? '✓' : '✗'} ${i.label} (${+i.points.toFixed(1)}/${i.max}) ${i.note}`);
      console.log(`\n■ tokens: ${ev.usage.calls} calls, ${k(ev.usage.input)} in / ${k(ev.usage.output)} out`);
      return;
    }
    default: return undefined;
  }
}

function printEvent(ev) {
  if (values.json) return console.log(JSON.stringify(ev));
  for (const line of consoleLines(ev)) (ev.type === 'job_failed' ? console.error : console.log)(line);
}

try {
  applyProviderFlags();
  if (values.help || !cmd) {
    console.log(USAGE);
  } else if (cmd === 'build') {
    if (!rest[0]) throw new Error('motion build <plan-job-dir>');
    const r = await runBuild(rest[0], {
      onEvent: printBuildEvent,
      look: values.look,
      render: !values['no-render'],
      maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : undefined,
    });
    if (values.json) console.log(JSON.stringify({ type: 'result', ...r }));
    if (r.render && !r.render.ok) process.exitCode = 2;
  } else if (cmd === 'plan') {
    const options = {};
    if (values.aspect) options.aspect = values.aspect;
    if (values.duration) options.duration = Number(values.duration);
    if (values.theme) options.theme = values.theme;
    if (values.palette) options.palette = values.palette;
    if (values['color-ref']) options.colorRef = values['color-ref'];
    const r = await runPlan({ prompt: rest.join(' '), options, jobsDir: values.jobs, onEvent: printPlanEvent });
    if (values.json) console.log(JSON.stringify({ type: 'result', job: r.job, rating: r.rating, usage: r.usage }));
    else console.log(`\nSaved: ${r.dir}\\harness (brief.json, shortlist.json, plan.json, rating.json)`);
  } else if (cmd === 'providers') {
    for (const p of providerStatus()) {
      const state = p.ready ? 'ready  ' : `no key (${p.keyVar})`;
      console.log(`${p.name.padEnd(7)} ${state.padEnd(30)} ${p.model.padEnd(24)} vision:${p.vision ? 'yes' : 'no '}  ${p.roles.length ? `← ${p.roles.join(', ')}` : ''}`);
    }
  } else if (cmd === 'palettes') {
    for (const p of PALETTES) console.log(`${p.id.padEnd(16)} ${Object.values(p.colors).join(' ')}  ${p.mood}`);
  } else if (cmd === 'themes') {
    for (const t of listThemes()) console.log(`${t.name.padEnd(18)} ${t.fonts.join(' + ')}  ${Object.values(t.colors).slice(0, 5).join(' ')}`);
  } else if (cmd === 'skills') {
    console.log(skillMap(rest[0] ?? 'builder', new SkillLibrary(config.skillsDir)));
  } else if (cmd === 'run' || cmd === 'resume') {
    const options = {};
    if (values.theme) options.theme = values.theme;
    if (values.aspect) options.aspect = values.aspect;
    if (values.duration) options.duration = Number(values.duration);
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    const result = await runJob({
      prompt: cmd === 'run' ? rest.join(' ') : undefined,
      resume: cmd === 'resume' ? rest[0] : undefined,
      options,
      jobsDir: values.jobs,
      onEvent: printEvent,
      signal: ac.signal,
    });
    if (values.json) console.log(JSON.stringify({ type: 'result', ...result }));
    else console.log(`\nVideo: ${result.video ?? '(verification failed — see harness/result.json)'}\nProject: ${result.project}`);
    if (!result.video) process.exitCode = 2;
  } else {
    console.error(USAGE);
    process.exitCode = 64;
  }
} catch (err) {
  if (!values.json) console.error(`\n${err.message}`);
  process.exitCode = 1;
}
