// The pipeline. Deterministic steps (init, theme, installs, check, snapshot, render, verify) are code;
// judgement (plan, build, review, fix) goes to the four subagents.
import fs from 'node:fs';
import path from 'node:path';
import { config, providerForRole } from './config.js';
import { OutOfTurnsError, runAgent } from './agent.js';
import { hf, hfJson, quote } from './hf.js';
import { clip, ensureBrowser, run } from './sandbox.js';
import { SkillLibrary } from './skills/library.js';
import { Workspace } from './workspace.js';
import { Transcript } from './transcript.js';
import { preloadKeys } from './skills/access.js';
import { applyTheme, registryAdd } from './tools/registry-tools.js';
import { runCheck, runSnapshot } from './tools/project-tools.js';
import { plannerAgent } from './roles/planner.js';
import { builderAgent } from './roles/builder.js';
import { criticAgent } from './roles/critic.js';
import { fixerAgent } from './roles/fixer.js';

const STAGES = ['new', 'init', 'planned', 'installed', 'built', 'reviewed', 'rendered', 'done'];
const after = (stage, s) => STAGES.indexOf(stage) >= STAGES.indexOf(s);

export async function runJob({ prompt, options = {}, resume, jobsDir, onEvent, signal: outer } = {}) {
  for (const role of Object.keys(config.roles)) providerForRole(role); // fail fast on missing keys
  await ensureBrowser();

  const ws = resume ? Workspace.open(resume) : Workspace.create(jobsDir);
  if (!resume) ws.writeJson('request.json', { prompt, options, createdAt: new Date().toISOString() });
  const request = ws.readJson('request.json');
  const lib = new SkillLibrary(config.skillsDir);

  const log = fs.createWriteStream(ws.meta('events.jsonl'), { flags: 'a' });
  const transcript = new Transcript(ws.meta('transcript.md'));
  let turn = 0;
  const emit = (type, data = {}) => {
    if (type === 'agent_start') turn = 0;
    if (type === 'turn') turn = data.turn;
    // Tool-level events don't know the turn; stamp the agent's current one.
    const stamp = turn && !('turn' in data) && !['stage', 'job_start', 'agent_start'].includes(type) ? { turn } : {};
    const ev = { at: new Date().toISOString(), type, ...stamp, ...data };
    log.write(`${JSON.stringify(ev)}\n`);
    transcript.write(ev);
    onEvent?.(ev);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.JOB_TIMEOUT_MIN ?? 60) * 60_000);
  outer?.addEventListener('abort', () => controller.abort());
  const signal = controller.signal;

  const usage = ws.readJson('usage.json', {});
  const record = (role, u) => {
    const acc = (usage[role] ??= { input: 0, output: 0, turns: 0, runs: 0 });
    acc.input += u.input;
    acc.output += u.output;
    acc.turns += u.turns;
    acc.runs += 1;
    ws.writeJson('usage.json', usage);
  };
  // fallback(): what to hand on when the agent runs out of turns (its edits are already on disk).
  const agent = async (spec, extraCtx = {}, fallback = null) => {
    const ctx = {
      ws, lib, emit, role: spec.role,
      // Sections already in the prompt (preloads, the fixer's attached refs) count as read.
      readLog: new Set([...preloadKeys(spec.role), ...(spec.readKeys ?? [])]),
      compactedReads: new Set(), seenRegistry: new Set(),
      skillBudget: { left: config.skillBudget[spec.role] },
      ...extraCtx,
    };
    try {
      const { result, usage: u } = await runAgent({ ...spec, ctx, signal });
      record(spec.role, u);
      return result;
    } catch (err) {
      if (!(err instanceof OutOfTurnsError) || !fallback) throw err;
      record(spec.role, err.usage);
      emit('agent_out_of_turns', { role: spec.role, message: err.message });
      return fallback();
    }
  };

  emit('job_start', { job: ws.id, dir: ws.dir, resume: Boolean(resume) });
  try {
    let state = ws.state;

    // 1. Scaffold the project (harness-owned, no agent).
    if (!after(state.stage, 'init')) {
      await initProject(ws);
      state = ws.setState({ stage: 'init' });
      emit('stage', { stage: 'init' });
    }

    // 2. Planner → SPEC.md, plan.json, theme.
    let plan = ws.readJson('plan.json');
    if (!after(state.stage, 'planned')) {
      plan = await agent(plannerAgent({ lib }, { prompt: request.prompt, options: request.options }));
      ws.writeJson('plan.json', plan);
      fs.writeFileSync(path.join(ws.projectDir, 'SPEC.md'), plan.spec);
      fs.writeFileSync(path.join(ws.projectDir, 'plan.json'), `${JSON.stringify({ ...plan, spec: undefined }, null, 2)}\n`);
      applyTheme(ws, plan.theme);
      ws.chownAgentDirs();
      state = ws.setState({ stage: 'planned' });
      emit('stage', { stage: 'planned', title: plan.title, scenes: plan.scenes.length, theme: plan.theme.preset ?? plan.theme.name });
    }
    const theme = JSON.parse(fs.readFileSync(path.join(ws.projectDir, 'theme.json'), 'utf8'));

    // 3. Install every registry item the plan names.
    let installReport = ws.readJson('install.json')?.text;
    if (!after(state.stage, 'installed')) {
      installReport = await installRegistryItems(ws, plan, emit);
      ws.writeJson('install.json', { text: installReport });
      ws.chownAgentDirs();
      state = ws.setState({ stage: 'installed' });
    }

    // 4. Builder.
    let build = ws.readJson('build.json');
    if (!after(state.stage, 'built')) {
      const requiredBlockDocs = [...new Set(plan.scenes.flatMap((s) => [s.block, ...(s.components ?? [])]).filter(Boolean))];
      build = await agent(builderAgent({ lib }, { plan, installReport, theme, requiredBlockDocs }), { plan, theme, requiredBlockDocs }, () => ({
        summary: 'The builder ran out of turns; the review starts from what is on disk.',
        scenes: plan.scenes.map((s) => ({ id: s.id, status: 'partial' })),
        known_issues: ['builder ran out of turns before handing off'],
      }));
      ws.writeJson('build.json', build);
      state = ws.setState({ stage: 'built', round: 0 });
      emit('stage', { stage: 'built', summary: build.summary });
    }

    // 5. Critic ⇄ fixer rounds.
    if (!after(state.stage, 'reviewed')) {
      let previous = ws.readJson(`review-${state.round}.json`);
      for (let round = state.round + 1; round <= config.reviewRounds; round++) {
        const check = await runCheck(ws);
        const snap = await runSnapshot(ws);
        const layers = await layerEvidence(ws, plan);
        emit('check', { round, errors: check.errors, warnings: check.warnings });
        const critic = criticAgent({ lib }, { plan, theme, check, snapshotText: `${snap.text}${layers.text}`, build, round, previous });
        const review = await agent({ ...critic, images: [...snap.images, ...layers.images].slice(0, 6) }, { lastCheck: check });
        // Measured, not judged: a covered background layer is a defect whatever the critic saw.
        for (const [n, issue] of layers.issues.entries()) {
          review.issues.push({ id: `layer-${n + 1}`, ...issue });
          review.verdict = 'fix';
        }
        if (layers.issues.length) emit('layer_hidden', { round, issues: layers.issues.map((i) => i.where) });
        ws.writeJson(`review-${round}.json`, review);
        emit('review', { round, verdict: review.verdict, score: review.score, issues: review.issues.length });
        state = ws.setState({ round });
        if (review.verdict === 'ship') break;

        const issues = review.issues.filter((i) => i.severity !== 'minor' || review.issues.length <= 8);
        const fix = await agent(fixerAgent({ lib }, { plan, theme, issues, check }), { issues }, () => ({
          fixed: [],
          not_fixed: issues.map((i) => ({ id: i.id, reason: 'fixer ran out of turns; the next review re-checks what changed' })),
          notes: 'out of turns',
        }));
        ws.writeJson(`fix-${round}.json`, fix);
        emit('fix', { round, fixed: fix.fixed.length, not_fixed: fix.not_fixed.length });
        previous = { review, fix };
      }
      state = ws.setState({ stage: 'reviewed' });
    }

    // 6. Render (one repair attempt on failure), then verify.
    if (!after(state.stage, 'rendered')) {
      let render = await renderFinal(ws, emit);
      if (!render.ok) {
        const issues = [{ id: 'render-1', severity: 'blocker', category: 'render', where: 'render', evidence: render.log, fix: 'Make the project render: fix the cause shown in the log.' }];
        const check = await runCheck(ws);
        await agent(fixerAgent({ lib }, { plan, theme, issues, check, reason: 'The final render failed.' }), { issues }, () => null);
        render = await renderFinal(ws, emit);
        if (!render.ok) throw new Error(`Render failed twice:\n${render.log}`);
      }
      state = ws.setState({ stage: 'rendered' });
    }

    const verify = await verifyOutput(ws, plan);
    const result = {
      job: ws.id,
      video: verify.ok ? path.join(ws.projectDir, 'renders', 'final.mp4') : null,
      project: ws.projectDir,
      title: plan.title,
      duration: verify.duration,
      expectedDuration: plan.format.duration,
      verify,
      usage,
    };
    ws.writeJson('result.json', result);
    ws.setState({ stage: 'done' });
    emit('job_done', { video: result.video, duration: verify.duration, ok: verify.ok });
    return result;
  } catch (err) {
    emit('job_failed', { error: err.message });
    ws.setState({ error: err.message });
    throw err;
  } finally {
    clearTimeout(timer);
    log.end();
    transcript.end();
  }
}

// For every background/overlay scene, a frame from the middle of each main scene it spans, so the critic
// sees whether the layer is still there (a main scene's opaque ground can hide it).
export async function layerEvidence(ws, plan) {
  const layered = plan.scenes.filter((s) => s.layer && s.layer !== 'main');
  const times = [];
  for (const l of layered) {
    for (const m of plan.scenes.filter((s) => (s.layer ?? 'main') === 'main')) {
      const mid = +(m.start + m.duration / 2).toFixed(2);
      if (mid > l.start && mid < l.start + l.duration) times.push({ t: mid, layer: l.id, over: m.id });
    }
  }
  if (!times.length) return { text: '', images: [], issues: [] };
  const picked = times.slice(0, 6);
  const res = await hfJson(ws, ['snapshot', '--at', picked.map((x) => x.t).join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec });
  const files = (res.json?.files ?? res.json?.frames ?? []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  const sheets = res.json?.contactSheets ?? [];

  // A covered background shows as a perfectly flat band (one luma value) where other frames show texture.
  const issues = [];
  const measured = [];
  for (const [i, x] of picked.entries()) {
    if (!files[i]) continue;
    measured.push({ ...x, spread: await bandSpread(ws, files[i]) });
  }
  for (const l of layered.filter((s) => s.layer === 'background')) {
    const mine = measured.filter((m) => m.layer === l.id && m.spread != null);
    const textured = mine.filter((m) => m.spread >= 20);
    if (!textured.length) continue; // all flat: can't tell a hidden layer from a plain one
    for (const m of mine.filter((f) => f.spread < 4)) {
      issues.push({
        severity: 'major',
        category: 'layout',
        where: `scene ${m.over} at t=${m.t}s`,
        evidence: `Measured by the harness: the ${l.id} background layer is covered here (the top of the frame is one flat colour, luma spread ${m.spread}) while it shows at t=${textured[0].t}s (spread ${textured[0].spread}).`,
        fix: `Make ${m.over}'s own ground transparent so ${l.id} shows through: set its background/ground colour variable to "transparent" in its data-variable-values, or remove the opaque background on its #root/body in its composition file.`,
        skill_ref: 'hyperframes/references/format.md#shape-of-a-project',
      });
    }
  }
  const lines = measured.map((x) => `- t=${x.t}s (${x.over}): ${x.layer} layer ${x.spread >= 20 ? 'visible' : x.spread < 4 ? 'COVERED (flat)' : 'unclear'} (measured)`);
  return { text: `\n\nLayer check frames (measured by the harness; attached after the contact sheets):\n${lines.join('\n')}`, images: sheets.slice(0, 1), issues };
}

// Luma spread (max - min) of the top 30% of a frame: 0 means a flat fill.
async function bandSpread(ws, file) {
  const res = await run(ws, `ffmpeg -v info -i ${quote(file)} -vf "crop=iw:ih*0.3:0:0,format=yuv444p,signalstats,metadata=mode=print" -f null -`, { timeoutSec: 60 });
  const min = Number(/YMIN=(\d+)/.exec(res.output)?.[1]);
  const max = Number(/YMAX=(\d+)/.exec(res.output)?.[1]);
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : null;
}

export async function initProject(ws) {
  await ensureBrowser();
  const scaffold = path.join(ws.homeDir, 'scaffold');
  fs.rmSync(scaffold, { recursive: true, force: true });
  const res = await hf(ws, ['init', 'scaffold'], { cwd: ws.homeDir, timeoutSec: 300 });
  if (!fs.existsSync(path.join(scaffold, 'index.html'))) throw new Error(`hyperframes init failed:\n${clip(res.output, 3000)}`);
  fs.rmSync(ws.projectDir, { recursive: true, force: true });
  fs.renameSync(scaffold, ws.projectDir);
  // Agent-facing instructions come from the harness, not the scaffold's generic notes.
  for (const f of ['AGENTS.md', 'CLAUDE.md']) fs.rmSync(path.join(ws.projectDir, f), { force: true });
  ws.chownAgentDirs();
}

export async function installRegistryItems(ws, plan, emit) {
  const names = [...new Set(plan.scenes.flatMap((s) => [s.block, ...(s.components ?? [])]).filter(Boolean))];
  if (!names.length) return 'No registry items in the plan: every scene is hand-built.';
  const lines = [];
  for (const name of names) {
    const r = await registryAdd(ws, name);
    emit('registry_install', { name, ok: r.ok });
    const usedBy = plan.scenes.filter((s) => s.block === name || s.components?.includes(name)).map((s) => s.id);
    if (!r.ok) {
      lines.push(`## ${name} — FAILED to install (scenes: ${usedBy.join(', ')}). Hand-build these scenes instead.\n${r.text}`);
      continue;
    }
    lines.push([
      `## ${name} (${r.kind}) for scenes: ${usedBy.join(', ')}`,
      `files: ${r.written.join(', ')}`,
      r.snippet ? `mount: ${r.snippet}` : 'component: merge into the scene file',
      `variables: ${r.variables.map((v) => `${v.id}:${v.type}=${JSON.stringify(v.default)}`).join(', ') || 'none'}`,
      r.doc ? `docs: block_doc("${name}")` : '',
    ].filter(Boolean).join('\n'));
  }
  return lines.join('\n\n');
}

export async function renderFinal(ws, emit) {
  const out = 'renders/final.mp4';
  fs.mkdirSync(path.join(ws.projectDir, 'renders'), { recursive: true });
  ws.chownAgentDirs();
  emit('render_start', { quality: config.renderQuality });
  const res = await hf(ws, ['render', '--quality', config.renderQuality, '--output', out], { timeoutSec: config.renderTimeoutSec });
  const file = path.join(ws.projectDir, out);
  const ok = res.code === 0 && fs.existsSync(file) && fs.statSync(file).size > 1000;
  fs.writeFileSync(ws.meta('render.log'), res.output);
  emit('render_done', { ok, code: res.code });
  return { ok, log: clip(res.output, 6000) };
}

export async function verifyOutput(ws, plan) {
  const file = path.join(ws.projectDir, 'renders', 'final.mp4');
  if (!fs.existsSync(file)) return { ok: false, reason: 'no output file' };
  const res = await run(ws, 'ffprobe -v error -show_entries format=duration:stream=codec_type,width,height -of json renders/final.mp4', { timeoutSec: 60 });
  let info = null;
  try {
    info = JSON.parse(res.output);
  } catch {
    return { ok: true, duration: null, note: 'ffprobe unavailable; file exists' };
  }
  const duration = Number(info.format?.duration ?? 0);
  const video = info.streams?.find((s) => s.codec_type === 'video');
  const drift = Math.abs(duration - plan.format.duration);
  return {
    ok: duration > 0 && drift <= Math.max(0.2, 2 / plan.format.fps),
    duration,
    size: video ? `${video.width}x${video.height}` : null,
    hasAudio: Boolean(info.streams?.some((s) => s.codec_type === 'audio')),
    drift,
  };
}
