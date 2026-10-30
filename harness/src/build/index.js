// The build stage: approved plan → rendered film.
//   1 assemble (code) → 2 write scenes (model, 1 call each, parallel) → 3 verify each scene (code + check,
//   ≤2 repairs, else code fallback) → 4 verify the film (check + measured; escalate failing mounts) →
//   5 look (optional, 1 vision call) → 6 render + verify. Hard token cap; every step logged.
import fs from 'node:fs';
import path from 'node:path';
import { config, providerForRole } from '../config.js';
import { imageMessage, chat } from '../llm.js';
import { ask as askJson, parseModelJson } from '../plan.js';
import { SkillLibrary } from '../skills/library.js';
import { Workspace } from '../workspace.js';
import { ensureBrowser, run } from '../sandbox.js';
import { hfJson, quote } from '../hf.js';
import { runCheck } from '../tools/project-tools.js';
import { layerEvidence, renderFinal, verifyOutput } from '../orchestrator.js';
import { assemble, indexHtml } from './assemble.js';
import { findingsFor, sceneFile, staticProblems, writeFallback, writeScene } from './scenes.js';

const MAX_REPAIRS = 2;
const PARALLEL = 3;

async function inBatches(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...(await Promise.all(list.slice(i, i + n).map(fn))));
  return out;
}

export async function runBuild(dir, { onEvent = () => {}, look = false, render = true, maxTokens = Number(process.env.BUILD_MAX_TOKENS ?? 150_000) } = {}) {
  const ws = Workspace.open(dir);
  const plan = ws.readJson('plan.json');
  const brief = ws.readJson('brief.json');
  if (!Array.isArray(plan?.scenes)) throw new Error(`No plan.json with scenes in ${dir}`);
  const provider = providerForRole('builder');
  const lib = new SkillLibrary(config.skillsDir);
  const usage = { input: 0, output: 0, calls: 0 };
  const report = { job: ws.id, provider: `${provider.name}/${provider.model}`, started: new Date().toISOString(), scenes: {}, warnings: [], measured: [], look: null, render: null };
  const emit = (type, data = {}) => onEvent({ type, ...data });
  const t0 = Date.now();

  // Every model call goes through here: token cap, JSON-only replies, usage.
  const ask = async (system, user, { label }) => {
    if (usage.input + usage.output >= maxTokens) {
      emit('cap', { label, used: usage.input + usage.output, maxTokens });
      return null;
    }
    const before = usage.input + usage.output;
    const out = await askJson(provider, system, user, usage).catch((err) => {
      emit('error', { label, error: err.message });
      return null;
    });
    emit('call', { label, tokens: usage.input + usage.output - before });
    return out;
  };

  await ensureBrowser();

  // 1. Assemble
  emit('step', { step: 'assemble' });
  const asm = await assemble(ws, plan, brief, { emit: (_t, d) => emit('assemble', d) });
  report.warnings.push(...asm.warnings);
  const ctx = { format: plan.format, roles: asm.roles, lib, items: asm.items, ask, hasBackground: plan.scenes.some((s) => s.layer === 'background') };
  const scenes = asm.scenes;
  plan.__ground = asm.roles.ground;
  for (const s of scenes) report.scenes[s.id] = { mode: s.mode, item: s.item, attempts: 0, result: s.mode === 'write' ? 'pending' : 'assembled' };
  emit('assembled', { scenes: scenes.map((s) => ({ id: s.id, mode: s.mode, item: s.item })), warnings: asm.warnings });

  const fontCss = fs.readFileSync(path.join(ws.projectDir, 'index.html'), 'utf8').match(/@font-face[^}]*}/g)?.join('\n') ?? '';
  const themeColors = JSON.parse(fs.readFileSync(path.join(ws.projectDir, 'theme.json'), 'utf8')).colors ?? {};
  const rewriteIndex = () => fs.writeFileSync(path.join(ws.projectDir, 'index.html'), indexHtml(plan, scenes, asm.roles, fontCss, themeColors));

  // 2–3. Write and verify the scenes the model has to write.
  const writeAndVerify = async (targets) => {
    // First drafts, in parallel; code checks get one immediate fix.
    await inBatches(targets, PARALLEL, async (s) => {
      emit('scene', { id: s.id, step: 'write' });
      let html = await writeScene(s, ctx);
      report.scenes[s.id].attempts++;
      let problems = html ? staticProblems(html, s.id, s.duration) : ['no html in the reply'];
      if (problems.length && html) {
        emit('scene', { id: s.id, step: 'repair', problems });
        html = (await writeScene(s, ctx, { problems, current: html })) ?? html;
        report.scenes[s.id].attempts++;
        problems = staticProblems(html, s.id, s.duration);
      }
      if (html && !problems.length) fs.writeFileSync(sceneFile(ws, s), html);
      else { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (contract)'; report.scenes[s.id].why = problems; }
    });
    // Browser checks, findings per file, ≤ MAX_REPAIRS rounds.
    for (let round = 1; round <= MAX_REPAIRS; round++) {
      const check = await runCheck(ws);
      const failing = targets.filter((s) => report.scenes[s.id].result === 'pending' && findingsFor(check, s.file).some((f) => f.startsWith('[error]')));
      emit('check', { round, errors: check.errors, warnings: check.warnings, failing: failing.map((s) => s.id) });
      if (!failing.length) break;
      await inBatches(failing, PARALLEL, async (s) => {
        const problems = findingsFor(check, s.file);
        emit('scene', { id: s.id, step: `repair ${round}`, problems });
        const html = await writeScene(s, ctx, { problems, current: fs.readFileSync(sceneFile(ws, s), 'utf8') });
        report.scenes[s.id].attempts++;
        if (html && !staticProblems(html, s.id, s.duration).length) fs.writeFileSync(sceneFile(ws, s), html);
      });
    }
    const check = await runCheck(ws);
    for (const s of targets.filter((x) => report.scenes[x.id].result === 'pending')) {
      const errs = findingsFor(check, s.file).filter((f) => f.startsWith('[error]'));
      if (errs.length) { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (check errors)'; report.scenes[s.id].why = errs; } else report.scenes[s.id].result = 'written';
    }
  };

  emit('step', { step: 'write scenes' });
  await writeAndVerify(scenes.filter((s) => s.mode === 'write'));

  // 4. Verify the film: check + measured. Readability problems count even when check calls them warnings.
  //    A written scene with issues gets one repair; a mounted/block scene is escalated to the writer once.
  emit('step', { step: 'verify film' });
  const issues = await measure(ws, plan, scenes);
  const check = await runCheck(ws);
  const MUST_FIX = /^\[error\]|text_below_floor|contrast|offscreen|clipped|overflow|cut_off/;
  for (const s of scenes) {
    const found = findingsFor(check, s.file).filter((f) => MUST_FIX.test(f));
    if (found.length) issues.push({ id: s.id, problem: found.join('; ') });
  }
  const indexFindings = findingsFor(check, 'index.html').filter((f) => f.startsWith('[error]'));
  if (indexFindings.length) report.warnings.push(...indexFindings.map((f) => `index.html (assembler): ${f}`));
  report.measured = issues;
  emit('measured', { issues });

  const writtenWithIssues = scenes.filter((s) => s.mode === 'write' && !String(report.scenes[s.id].result).startsWith('fallback') && issues.some((i) => i.id === s.id));
  await inBatches(writtenWithIssues, PARALLEL, async (s) => {
    const problems = issues.filter((i) => i.id === s.id).map((i) => i.problem);
    emit('scene', { id: s.id, step: 'film repair', problems });
    const html = await writeScene(s, ctx, { problems, current: fs.readFileSync(sceneFile(ws, s), 'utf8') });
    report.scenes[s.id].attempts++;
    if (html && !staticProblems(html, s.id, s.duration).length) fs.writeFileSync(sceneFile(ws, s), html);
  });
  if (writtenWithIssues.length) {
    const c = await runCheck(ws);
    for (const s of writtenWithIssues) if (findingsFor(c, s.file).some((f) => f.startsWith('[error]'))) { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (film repair broke it)'; }
  }

  const escalate = scenes.filter((s) => s.mode !== 'write' && s.layer !== 'background' && issues.some((i) => i.id === s.id));
  if (escalate.length) {
    for (const s of escalate) {
      s.escalatedFrom = s.item;
      s.escalationReason = issues.filter((i) => i.id === s.id).map((i) => i.problem).join('; ');
      s.mode = 'write';
      s.file = `compositions/${s.id}.html`;
      s.compositionId = s.id;
      s.values = {};
      report.scenes[s.id] = { ...report.scenes[s.id], mode: 'write', escalatedFrom: s.item, result: 'pending', why: s.escalationReason };
      writeFallback(ws, s, ctx);
    }
    rewriteIndex();
    emit('escalate', { scenes: escalate.map((s) => ({ id: s.id, from: s.escalatedFrom, why: s.escalationReason })) });
    await writeAndVerify(escalate);
  }

  // 5. Look (optional): one vision call over the contact sheet; write-mode scenes get one repair.
  if (look) {
    emit('step', { step: 'look' });
    report.look = await lookAtFilm(ws, plan, scenes, provider, usage, maxTokens, emit);
    const toFix = (report.look?.issues ?? []).map((i) => ({ i, s: scenes.find((x) => x.id === i.scene && x.mode === 'write') })).filter((x) => x.s);
    const before = new Map();
    await inBatches(toFix, PARALLEL, async ({ i, s }) => {
      before.set(s.id, fs.readFileSync(sceneFile(ws, s), 'utf8'));
      const html = await writeScene(s, ctx, { problems: [`${i.problem} → ${i.fix}`], current: before.get(s.id) });
      report.scenes[s.id].attempts++;
      if (html && !staticProblems(html, s.id, s.duration).length) fs.writeFileSync(sceneFile(ws, s), html);
    });
    if (toFix.length) {
      const c = await runCheck(ws);
      const blank = await measure(ws, plan, toFix.map(({ s }) => s));
      for (const { s } of toFix) {
        const broke = findingsFor(c, s.file).some((f) => f.startsWith('[error]')) || blank.some((b) => b.id === s.id);
        if (broke) {
          fs.writeFileSync(sceneFile(ws, s), before.get(s.id));
          report.scenes[s.id].lookRepair = 'reverted: the repair broke the scene';
          emit('scene', { id: s.id, step: 'look repair reverted' });
        } else report.scenes[s.id].lookRepair = 'applied';
      }
    }
  }

  // 6. Render + verify.
  if (render) {
    emit('step', { step: 'render' });
    const r = await renderFinal(ws, (t, d) => emit(t, d));
    report.render = r.ok ? await verifyOutput(ws, plan) : { ok: false, log: r.log };
  }

  report.usage = { input: usage.input, output: usage.output, calls: usage.calls, minutes: +((Date.now() - t0) / 60000).toFixed(1) };
  ws.writeJson('build-report.json', report);
  fs.writeFileSync(ws.meta('build-report.md'), reportMarkdown(report, plan));
  const prev = ws.readJson('usage.json', {});
  ws.writeJson('usage.json', { ...prev, builder: { input: usage.input, output: usage.output, turns: usage.calls, runs: 1 } });
  emit('done', { report: ws.meta('build-report.md'), video: report.render?.ok ? path.join(ws.projectDir, 'renders', 'final.mp4') : null, usage: report.usage });
  return report;
}

// Measured checks (no model): a planned background must show; a scene with copy must not be blank.
async function measure(ws, plan, scenes) {
  const issues = [];
  const layers = await layerEvidence(ws, plan);
  for (const i of layers.issues) issues.push({ id: /scene (\S+)/.exec(i.where)?.[1], problem: i.evidence });
  const covers = scenes.filter((s) => s.layer === 'transition');
  if (covers.length) {
    const mids = covers.map((s) => +(s.start + s.duration / 2).toFixed(2));
    const r = await hfJson(ws, ['snapshot', '--at', mids.join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec });
    const byTime = new Map((r.json?.frames ?? []).map((f) => [Number(f.time), f.path]));
    for (const [i, s] of covers.entries()) {
      const file = byTime.get(mids[i]);
      if (!file) continue;
      // Covered = the beat's own ground no longer shows. Sample 5 patches (corners + centre) against it.
      const ground = await groundPatches(ws, file, plan.__ground);
      if (ground >= 3) issues.push({ id: s.id, problem: `at its midpoint (t=${mids[i]}s) the transition does not cover the frame: the ground colour still shows in ${ground} of 5 sampled patches, so the cut is visible` });
    }
  }
  const targets = scenes.filter((s) => !['background', 'transition'].includes(s.layer) && (s.text ?? []).some((t) => String(t).trim()));
  if (!targets.length) return issues;
  // Sample late in each scene, after entrances, before any exit.
  const at = targets.map((s) => +(s.start + s.duration * 0.6).toFixed(2));
  const res = await hfJson(ws, ['snapshot', '--at', at.join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec });
  const byTime = new Map((res.json?.frames ?? []).map((f) => [Number(f.time), f.path]));
  for (const [i, s] of targets.entries()) {
    const file = byTime.get(at[i]);
    if (!file) continue;
    const spread = await lumaSpread(ws, file, s);
    if (spread != null && spread < 4) issues.push({ id: s.id, problem: `at t=${at[i]}s the ${s.layer === 'overlay' ? 'overlay band' : 'frame'} is blank (luma spread ${spread}); its copy should be visible` });
  }
  return issues;
}

const lookTime = (s) => +(s.start + s.duration * 0.9).toFixed(2);

const yuv = (hex) => {
  const h = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.length === 3 ? h[i / 2] + h[i / 2] : h.slice(i, i + 2), 16));
  // Limited range (16–235 / 16–240): what ffmpeg's yuv444p gives for an RGB PNG.
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const u = -0.168736 * r - 0.331264 * g + 0.5 * b;
  const v = 0.5 * r - 0.418688 * g - 0.081312 * b;
  return [16 + (y * 219) / 255, 128 + (u * 224) / 255, 128 + (v * 224) / 255];
};

// How many of 5 small patches (corners + centre) are the theme ground colour.
async function groundPatches(ws, file, groundHex) {
  if (!groundHex) return 0;
  const [gy, gu, gv] = yuv(groundHex);
  const spots = [[0.02, 0.02], [0.9, 0.02], [0.02, 0.88], [0.9, 0.88], [0.46, 0.46]];
  let n = 0;
  for (const [x, y] of spots) {
    const out = await run(ws, `ffmpeg -v info -i ${quote(file)} -vf "crop=iw*0.08:ih*0.08:iw*${x}:ih*${y},format=yuv444p,signalstats,metadata=mode=print" -f null -`, { timeoutSec: 60 });
    const Y = Number(/YAVG=([\d.]+)/.exec(out.output)?.[1]);
    const U = Number(/UAVG=([\d.]+)/.exec(out.output)?.[1]);
    const V = Number(/VAVG=([\d.]+)/.exec(out.output)?.[1]);
    if ([Y, U, V].every(Number.isFinite) && Math.abs(Y - gy) < 14 && Math.abs(U - gu) < 10 && Math.abs(V - gv) < 10) n++;
  }
  return n;
}

async function lumaSpread(ws, file, scene) {
  const crop = scene.layer === 'overlay'
    ? { top: 'crop=iw:ih*0.3:0:0', bottom: 'crop=iw:ih*0.22:0:ih*0.78', corner: 'crop=iw*0.32:ih*0.16:iw*0.65:ih*0.81' }[scene.position ?? 'bottom']
    : 'null';
  const out = await run(ws, `ffmpeg -v info -i ${quote(file)} -vf "${crop},format=yuv444p,signalstats,metadata=mode=print" -f null -`, { timeoutSec: 60 });
  const min = Number(/YMIN=(\d+)/.exec(out.output)?.[1]);
  const max = Number(/YMAX=(\d+)/.exec(out.output)?.[1]);
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : null;
}

const LOOK_SYSTEM = `You review frames of a short video against its plan. The contact sheet shows frames from each scene. For each scene, report only real visible defects: text too small to read or cut off, text overlapping, wrong colours for the plan, empty or broken frames, demo/placeholder content, layout far from the plan. Reply with JSON only: {"issues":[{"scene":"<scene id>","problem":"what is visibly wrong","fix":"one concrete instruction"}]} — an empty list if it looks right.`;

async function lookAtFilm(ws, plan, scenes, provider, usage, maxTokens, emit) {
  if (!provider.vision) return { skipped: 'model has no vision' };
  if (usage.input + usage.output >= maxTokens) return { skipped: 'token cap' };
  // After entrances and reveals have finished (a frame mid-reveal reads as half-typed text).
  const shown = scenes.filter((s) => !['background', 'transition'].includes(s.layer));
  const at = shown.map((s) => lookTime(s));
  const res = await hfJson(ws, ['snapshot', '--at', at.join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec });
  const sheet = res.json?.contactSheets?.[0];
  if (!sheet) return { skipped: 'no contact sheet' };
  const img = await imageMessage(provider, 'Contact sheet, frames in scene order:', [sheet]);
  const planText = JSON.stringify(shown.map((s) => ({ scene: s.id, at: lookTime(s), copy: s.text, build: s.build })), null, 1);
  const { message, usage: u } = await chat(provider, [{ role: 'system', content: LOOK_SYSTEM }, { role: 'user', content: planText }, img].filter(Boolean), null);
  usage.input += u.input;
  usage.output += u.output;
  usage.calls += 1;
  const out = parseModelJson(message.content ?? '') ?? { issues: [] };
  emit('look', { issues: out.issues ?? [] });
  return out;
}

function reportMarkdown(r, plan) {
  const rows = Object.entries(r.scenes).map(([id, s]) => `| ${id} | ${s.mode}${s.escalatedFrom ? ` (escalated from ${s.escalatedFrom})` : ''} | ${s.item ?? '-'} | ${s.attempts} | ${s.result}${s.why ? `: ${[].concat(s.why).join('; ').slice(0, 200)}` : ''} |`);
  return `# Build report: ${plan.title ?? r.job}

- Provider: ${r.provider}
- Tokens: ${r.usage.input} in / ${r.usage.output} out over ${r.usage.calls} calls
- Time: ${r.usage.minutes} min
- Video: ${r.render?.ok ? `renders/final.mp4, ${r.render.duration}s, ${r.render.size}` : r.render ? `render failed or did not verify` : 'not rendered'}

## Scenes

| Scene | How it was made | Item | Model calls | Result |
|---|---|---|---|---|
${rows.join('\n')}

## Measured checks

${r.measured.length ? r.measured.map((i) => `- ${i.id}: ${i.problem}`).join('\n') : '- none failed'}

## Look

${r.look ? (r.look.skipped ? `- skipped: ${r.look.skipped}` : (r.look.issues ?? []).map((i) => `- ${i.scene}: ${i.problem} → ${i.fix}`).join('\n') || '- no issues') : '- off'}

## Warnings

${r.warnings.length ? r.warnings.map((w) => `- ${w}`).join('\n') : '- none'}
`;
}

