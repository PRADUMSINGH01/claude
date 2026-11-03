// The build stage: approved plan → rendered film.
//   1 assemble (code) → 2 write scenes (model, 1 call each, parallel) → 3 verify each scene (code + check,
//   ≤2 repairs, else code fallback) → 4 verify the film (check + measured; escalate failing mounts) →
//   5 look (optional, 1 vision call) → 6 render + verify. Hard token cap; every step logged.
import fs from 'node:fs';
import path from 'node:path';
import { config, providerForRole } from '../config.js';
import { addUsage, imageMessage, chat } from '../llm.js';
import { ask as askJson, filmGuide, parseModelJson } from '../plan.js';
import { SkillLibrary } from '../skills/library.js';
import { Workspace } from '../workspace.js';
import { ensureBrowser, run } from '../sandbox.js';
import { hfJson, quote } from '../hf.js';
import { runCheck } from '../tools/project-tools.js';
import { layerEvidence, renderFinal, verifyOutput } from '../orchestrator.js';
import { assemble, indexHtml } from './assemble.js';
import { creditsMarkdown, getStock } from '../media/stock.js';
import { figuresIn, findingsFor, needsGpu, sceneFile, staticProblems, writeFallback, writeScene } from './scenes.js';

const MAX_REPAIRS = 2;
// Scene writes are network-bound: run several at once (BUILD_PARALLEL), as a pool so one slow scene never
// holds back the rest.
const PARALLEL = Math.max(1, Number(process.env.BUILD_PARALLEL) || 6);

async function pool(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }));
  return out;
}

// edit: building an edit of a finished film: { base: the finished project dir, keep: scene ids whose files stay as
// they were, changes: { sceneId: what to change } } (see edit.js).
export async function runBuild(dir, { onEvent = () => {}, look = false, render = true, maxTokens = Number(process.env.BUILD_MAX_TOKENS ?? 300_000), signal, edit = null } = {}) {
  const ws = Workspace.open(dir);
  const plan = ws.readJson('plan.json');
  const brief = ws.readJson('brief.json');
  if (!Array.isArray(plan?.scenes)) throw new Error(`No plan.json with scenes in ${dir}`);
  const provider = providerForRole('builder');
  const lib = new SkillLibrary(config.skillsDir);
  const usage = { input: 0, output: 0, cachedInput: 0, calls: 0, pricedCalls: 0, cost: 0 };
  const report = { job: ws.id, provider: `${provider.name}/${provider.model}`, started: new Date().toISOString(), scenes: {}, warnings: [], measured: [], look: null, render: null };
  const emit = (type, data = {}) => onEvent({ type, ...data });
  const t0 = Date.now();

  // Every model call goes through here: token cap, the reply parsed to its shape (JSON unless parse says
  // otherwise), usage, and the calls/ archive.
  // effort: this call only, at another reasoning effort (a retry that must answer rather than think).
  const ask = async (system, user, { label, parse, effort }) => {
    if (usage.input + usage.output >= maxTokens) {
      emit('cap', { label, used: usage.input + usage.output, maxTokens });
      return null;
    }
    const [inBefore, outBefore] = [usage.input, usage.output];
    const out = await askJson(effort ? { ...provider, effort } : provider, system, user, usage, { signal, parse, label, log: (call) => ws.logCall(call) }).catch((err) => {
      if (signal?.aborted) throw err;
      // No credits, a bad key, no access: every later call fails the same way, and a film of placeholder
      // scenes is worse than a clear stop.
      if ([401, 402, 403].includes(err?.status)) throw new Error(`${provider.name}/${provider.model}: ${err.status} ${err.message}`);
      emit('error', { label, error: err.message });
      return null;
    });
    const [input, output] = [usage.input - inBefore, usage.output - outBefore];
    emit('call', { label, tokens: input + output, input, output });
    return out;
  };

  // The look step judges pixels, so it runs on the critic's provider: CRITIC can be a vision model while a
  // cheaper text model writes the scenes. Say up front when it can't see, rather than skip it quietly.
  const looker = look ? lookProvider() : null;
  if (looker && (looker.error || !looker.vision)) {
    report.warnings.push(looker.error
      ? `look step skipped: ${looker.error}`
      : `look step skipped: ${looker.name}/${looker.model} cannot see images. Set CRITIC to a provider with vision (or ${looker.name.toUpperCase()}_VISION=true if this model accepts images).`);
    emit('warning', { message: report.warnings.at(-1) });
  }

  // Where the time goes, measured: seconds per step, and count + seconds per kind of slow call (each check or
  // snapshot starts a browser). In build-report.md, so speed work starts from numbers.
  report.timings = { steps: {}, calls: {} };
  const time = async (kind, work) => {
    const t = Date.now();
    try {
      return await work;
    } finally {
      const c = (report.timings.calls[kind] ??= { count: 0, seconds: 0 });
      c.count += 1;
      c.seconds = +(c.seconds + (Date.now() - t) / 1000).toFixed(1);
    }
  };
  let current = null;
  const closeStep = () => {
    if (current) report.timings.steps[current.name] = +((Date.now() - current.at) / 1000).toFixed(1);
  };

  await ensureBrowser();
  ws.setState({ stage: 'building' });
  const step = (name) => {
    signal?.throwIfAborted();
    closeStep();
    current = { name, at: Date.now() };
    emit('step', { step: name });
  };

  // 1. Assemble
  step('assemble');
  const asm = await assemble(ws, plan, brief, { emit: (_t, d) => emit('assemble', d) });
  report.warnings.push(...asm.warnings);
  // Every scene writer also gets what the request rules out, and the guide for this kind of film.
  const request = ws.readJson('request.json', {});
  // Every figure the film may show: the request's and its copy's (staticProblems flags any other).
  const figures = new Set(figuresIn(`${request.prompt ?? ''} ${(plan.scenes ?? []).flatMap((s) => s.text ?? []).join(' ')}`).flatMap((f) => [f, f.replace('%', '')]));
  const ctx = { format: plan.format, roles: asm.roles, lib, items: asm.items, ask, hasBackground: plan.scenes.some((s) => s.layer === 'background'), avoid: brief?.avoid ?? [], figures, filmGuide: filmGuide(lib, brief, request.prompt ?? '') };
  const scenes = asm.scenes;
  plan.__ground = asm.roles.ground;
  for (const s of scenes) report.scenes[s.id] = { mode: s.mode, item: s.item, attempts: 0, result: s.mode === 'write' ? 'pending' : 'assembled' };
  emit('assembled', { scenes: scenes.map((s) => ({ id: s.id, mode: s.mode, item: s.item })), warnings: asm.warnings });

  const fontCss = fs.readFileSync(path.join(ws.projectDir, 'index.html'), 'utf8').match(/@font-face[^}]*}/g)?.join('\n') ?? '';
  const themeColors = JSON.parse(fs.readFileSync(path.join(ws.projectDir, 'theme.json'), 'utf8')).colors ?? {};
  // The full check (every sample and the contrast pass) is slow and runs once, when the film is verified.
  // Repair loops only need contract errors in the scenes they touched: sample just those scenes' time span
  // and skip contrast (measured about 3x faster). Static lint still covers the whole project.
  const quickCheck = (list) => {
    const range = list.length ? `${Math.min(...list.map((s) => s.start))},${Math.max(...list.map((s) => s.start + s.duration))}` : null;
    return time('quick check', runCheck(ws, ['--no-contrast', ...(range ? ['--range', range] : [])]));
  };
  const measureFilm = (list) => measure(ws, plan, list, time);
  const rewriteIndex = () => fs.writeFileSync(path.join(ws.projectDir, 'index.html'), indexHtml(plan, scenes, asm.roles, fontCss, themeColors, asm.sfx));
  report.sfx = asm.sfx;

  // The file a scene had in the film being edited, or null.
  const baseFile = (s) => {
    const f = edit?.base && path.join(edit.base, s.file);
    return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };

  // 2–3. Write and verify the scenes the model has to write.
  const writeAndVerify = async (targets) => {
    // First drafts, in parallel; code checks get one immediate fix.
    await pool(targets, PARALLEL, async (s) => {
      const before = edit?.changes?.[s.id] ? baseFile(s) : null;
      emit('scene', { id: s.id, step: before ? 'edit' : 'write' });
      let html = before ? await writeScene(s, ctx, { change: `${edit.request}\nIn this scene: ${edit.changes[s.id]}`, current: before }) : await writeScene(s, ctx);
      report.scenes[s.id].attempts++;
      if (!html) { // nothing usable came back (cut off, refused, no file in it): one fresh try before a fallback,
        // with reasoning off: real DeepSeek runs, even at low effort, thought ~29k tokens and were cut off before the
        // file (or a few lines into it), twice. Each provider's lowest setting ("none" is rejected by GPT-5 Mini).
        emit('scene', { id: s.id, step: 'write again', problems: ['no scene file in the reply'] });
        html = await writeScene(s, ctx, { effort: ['openrouter', 'glm'].includes(provider.kind) ? 'none' : provider.kind === 'gemini' ? 'low' : 'minimal' });
        report.scenes[s.id].attempts++;
      }
      let problems = html ? staticProblems(html, s.id, s.duration, s.text, s.stock?.file, ctx.figures) : ['no html in the reply'];
      if (problems.length && html) {
        emit('scene', { id: s.id, step: 'repair', problems });
        html = (await writeScene(s, ctx, { problems, current: html })) ?? html;
        report.scenes[s.id].attempts++;
        problems = staticProblems(html, s.id, s.duration, s.text, s.stock?.file, ctx.figures);
      }
      if (html && !problems.length) fs.writeFileSync(sceneFile(ws, s), html);
      else { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (contract)'; report.scenes[s.id].why = problems; }
    });
    // Browser checks, findings per file, ≤ MAX_REPAIRS rounds.
    let check = null;
    for (let round = 1; round <= MAX_REPAIRS; round++) {
      check = await quickCheck(targets);
      const failing = targets.filter((s) => report.scenes[s.id].result === 'pending' && findingsFor(check, s.file).some((f) => f.startsWith('[error]')));
      emit('check', { round, errors: check.errors, warnings: check.warnings, failing: failing.map((s) => s.id) });
      if (!failing.length) break;
      await pool(failing, PARALLEL, async (s) => {
        const problems = findingsFor(check, s.file);
        emit('scene', { id: s.id, step: `repair ${round}`, problems });
        const html = await writeScene(s, ctx, { problems, current: fs.readFileSync(sceneFile(ws, s), 'utf8') });
        report.scenes[s.id].attempts++;
        if (html && !staticProblems(html, s.id, s.duration, s.text, s.stock?.file, ctx.figures).length) fs.writeFileSync(sceneFile(ws, s), html);
      });
      check = null; // the files changed since: check again
    }
    check ??= await quickCheck(targets);
    for (const s of targets.filter((x) => report.scenes[x.id].result === 'pending')) {
      const errs = findingsFor(check, s.file).filter((f) => f.startsWith('[error]'));
      if (errs.length) { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (check errors)'; report.scenes[s.id].why = errs; } else report.scenes[s.id].result = 'written';
    }
  };

  // 1b. Media: free stock footage or photos for scenes whose plan asks for real imagery (Pexels, then
  // Pixabay), all at once. A scene with nothing found stays type only, and says so.
  const wantMedia = scenes.filter((s) => s.media?.query && s.mode === 'write');
  if (wantMedia.length) {
    step('media');
    const got = await Promise.all(wantMedia.map((s) => time('stock', getStock({
      kind: s.media.kind === 'photo' ? 'photo' : 'video', query: s.media.query, format: plan.format,
      minSeconds: s.duration, projectDir: ws.projectDir, name: s.id,
    }))));
    const credits = [];
    for (const [i, s] of wantMedia.entries()) {
      if (got[i].error) {
        report.warnings.push(`${s.id}: no stock ${s.media.kind} for "${s.media.query}" (${got[i].error}); the scene is type only`);
        continue;
      }
      s.stock = got[i];
      credits.push({ scene: s.id, ...got[i] });
      writeFallback(ws, s, ctx); // the starting file shows the media too
    }
    report.media = credits;
    if (credits.length) fs.writeFileSync(path.join(ws.projectDir, 'CREDITS.md'), creditsMarkdown(credits));
    ws.chownAgentDirs();
    emit('media', { items: credits.map((m) => ({ id: m.scene, kind: m.kind, source: m.source, by: m.credit.name, file: m.file })), missing: wantMedia.filter((s) => !s.stock).map((s) => s.id) });
  }

  // No GPU on this host: WebGPU blocks and lit three.js 3D render in software, too slowly for the capture (a real
  // film stalled at frame 60 on a WebGPU blob, then at frame 180 on a three.js carousel with shadows), so the
  // writer rebuilds those scenes with CSS 3D transforms, canvas 2D or SVG in the first pass.
  if (!config.renderGpu) {
    const gpuOnly = scenes.filter((s) => s.mode !== 'write' && needsGpu(fs.readFileSync(path.join(ws.projectDir, s.file), 'utf8')));
    for (const s of gpuOnly) {
      s.escalatedFrom = s.item;
      s.escalationReason = 'needs a GPU (WebGPU or three.js 3D), which this host lacks: rebuild the effect with CSS 3D transforms, canvas 2D or SVG';
      delete s.scale;
      s.mode = 'write';
      s.file = `compositions/${s.id}.html`;
      s.compositionId = s.id;
      s.values = {};
      report.scenes[s.id] = { ...report.scenes[s.id], mode: 'write', escalatedFrom: s.item, result: 'pending', why: s.escalationReason };
      writeFallback(ws, s, ctx);
    }
    if (gpuOnly.length) {
      rewriteIndex();
      emit('escalate', { scenes: gpuOnly.map((s) => ({ id: s.id, from: s.escalatedFrom, why: s.escalationReason })) });
    }
  }

  // An edit keeps the scenes the change leaves alone exactly as they were.
  if (edit) {
    for (const s of scenes.filter((x) => x.mode === 'write' && edit.keep?.includes(x.id) && baseFile(x) != null)) {
      fs.writeFileSync(sceneFile(ws, s), baseFile(s));
      report.scenes[s.id].result = 'kept';
    }
    emit('edit', { kept: scenes.filter((s) => report.scenes[s.id].result === 'kept').map((s) => s.id), changed: Object.keys(edit.changes ?? {}) });
  }

  step('write scenes');
  await writeAndVerify(scenes.filter((s) => s.mode === 'write' && report.scenes[s.id].result === 'pending'));

  // 4. Verify the film: check + measured. Readability problems count even when check calls them warnings.
  //    A written scene with issues gets one repair; a mounted/block scene is escalated to the writer once.
  step('verify film');
  // The measured frames and the full check are independent browser runs (~20 s just to start each): together.
  const [measured, check] = await Promise.all([measureFilm(scenes), time('full check', runCheck(ws))]);
  let issues = measured;
  // A block or mounted item whose only problem is its size is scaled in code; a written scene is told to.
  // No check of its own: the scale keeps the copy inside the 5% margin, and look and render show the result.
  const scaled = [];
  for (const s of scenes.filter((x) => x.mode !== 'write')) {
    const mine = issues.filter((i) => i.id === s.id);
    const fit = mine.length === 1 && mine[0].kind === 'small' ? fitScale(mine[0].ink) : null;
    if (!fit) continue;
    s.scale = fit;
    scaled.push(s);
    issues = issues.filter((i) => i !== mine[0]);
  }
  if (scaled.length) {
    rewriteIndex();
    for (const s of scaled) report.warnings.push(`${s.id}: ${s.item} drew its copy too small; its host is scaled ${s.scale.k}x around the copy`);
    emit('scaled', { scenes: scaled.map((s) => ({ id: s.id, k: s.scale.k })) });
  }
  const MUST_FIX = /^\[error\]|text_below_floor|contrast|offscreen|clipped|overflow|cut_off/;
  for (const s of scenes) {
    // The check saw a scaled scene before its scale: its type-size findings are what the scale answers.
    const found = findingsFor(check, s.file).filter((f) => MUST_FIX.test(f) && !(s.scale && /text_below_floor/.test(f)));
    if (found.length) issues.push({ id: s.id, problem: found.join('; ') });
  }
  const indexFindings = findingsFor(check, 'index.html').filter((f) => f.startsWith('[error]'));
  if (indexFindings.length) report.warnings.push(...indexFindings.map((f) => `index.html (assembler): ${f}`));
  report.measured = issues;
  emit('measured', { issues });

  // Repairing written scenes and rewriting escalated items touch different files, so they run side by side.
  const writtenWithIssues = scenes.filter((s) => s.mode === 'write' && !String(report.scenes[s.id].result).startsWith('fallback') && issues.some((i) => i.id === s.id));
  const repairWritten = async () => {
    if (!writtenWithIssues.length) return;
    await pool(writtenWithIssues, PARALLEL, async (s) => {
      const problems = issues.filter((i) => i.id === s.id).map((i) => i.problem);
      emit('scene', { id: s.id, step: 'film repair', problems });
      const html = await writeScene(s, ctx, { problems, current: fs.readFileSync(sceneFile(ws, s), 'utf8') });
      report.scenes[s.id].attempts++;
      if (html && !staticProblems(html, s.id, s.duration, s.text, s.stock?.file, ctx.figures).length) fs.writeFileSync(sceneFile(ws, s), html);
    });
    const c = await quickCheck(writtenWithIssues);
    for (const s of writtenWithIssues) if (findingsFor(c, s.file).some((f) => f.startsWith('[error]'))) { writeFallback(ws, s, ctx); report.scenes[s.id].result = 'fallback (film repair broke it)'; }
  };

  const escalate = scenes.filter((s) => s.mode !== 'write' && s.layer !== 'background' && issues.some((i) => i.id === s.id));
  const rewriteEscalated = async () => {
    if (!escalate.length) return;
    for (const s of escalate) {
      s.escalatedFrom = s.item;
      s.escalationReason = issues.filter((i) => i.id === s.id).map((i) => i.problem).join('; ');
      delete s.scale; // the scale was for the item's drawing; a written scene sizes itself
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
  };
  await Promise.all([repairWritten(), rewriteEscalated()]);

  // 5. Look (optional): one vision call over the contact sheet; write-mode scenes get one repair.
  if (look) {
    step('look');
    report.look = await lookAtFilm(ws, plan, scenes, looker, usage, maxTokens, emit, time);
    if (report.look?.skipped) emit('look', { skipped: report.look.skipped, issues: [] });
    // An issue that names no problem is no instruction: a real run "repaired" a scene from one and shrank its copy.
    const toFix = (report.look?.issues ?? []).filter((i) => String(i.problem ?? '').trim().length > 8).map((i) => ({ i, s: scenes.find((x) => x.id === i.scene && x.mode === 'write') })).filter((x) => x.s);
    const before = new Map();
    await pool(toFix, PARALLEL, async ({ i, s }) => {
      before.set(s.id, fs.readFileSync(sceneFile(ws, s), 'utf8'));
      const html = await writeScene(s, ctx, { problems: [`${i.problem} → ${i.fix}`], current: before.get(s.id) });
      report.scenes[s.id].attempts++;
      if (html && !staticProblems(html, s.id, s.duration, s.text, s.stock?.file, ctx.figures).length) fs.writeFileSync(sceneFile(ws, s), html);
    });
    if (toFix.length) {
      // A repair that leaves a measured problem the scene did not have before is undone (made it small, blank, cut).
      const wasSmall = new Set(report.measured.filter((i) => i.kind === 'small').map((i) => i.id));
      const [c, blank] = await Promise.all([quickCheck(toFix.map(({ s }) => s)), measureFilm(toFix.map(({ s }) => s))]);
      for (const { s } of toFix) {
        const broke = findingsFor(c, s.file).some((f) => f.startsWith('[error]')) || blank.some((b) => b.id === s.id && (b.kind !== 'small' || !wasSmall.has(s.id)));
        if (broke) {
          fs.writeFileSync(sceneFile(ws, s), before.get(s.id));
          report.scenes[s.id].lookRepair = 'reverted: the repair broke the scene';
          emit('scene', { id: s.id, step: 'look repair reverted' });
        } else report.scenes[s.id].lookRepair = 'applied';
      }
    }
  }

  // A scene that ended as the code placeholder is said out loud: the film is not what was asked there.
  const fellBack = scenes.filter((s) => String(report.scenes[s.id]?.result ?? '').startsWith('fallback'));
  if (fellBack.length) {
    emit('warning', {
      userFacing: true,
      message: `${fellBack.length === 1 ? 'One scene' : `${fellBack.length} scenes`} (${fellBack.map((s) => s.id).join(', ')}) could not be built as described and ${fellBack.length === 1 ? 'shows' : 'show'} a simple version. Send the prompt again to rebuild it.`,
    });
  }

  // 6. Render + verify.
  if (render) {
    step('render');
    const r = await time('render', renderFinal(ws, (t, d) => emit(t, d)));
    report.render = r.ok ? await verifyOutput(ws, plan) : { ok: false, log: r.log };
  }

  closeStep();
  report.usage = { input: usage.input, output: usage.output, calls: usage.calls, minutes: +((Date.now() - t0) / 60000).toFixed(1) };
  ws.writeJson('build-report.json', report);
  fs.writeFileSync(ws.meta('build-report.md'), reportMarkdown(report, plan));
  const prev = ws.readJson('usage.json', {});
  ws.writeJson('usage.json', { ...prev, builder: { input: usage.input, output: usage.output, cachedInput: usage.cachedInput, calls: usage.calls, pricedCalls: usage.pricedCalls, cost: usage.cost, turns: usage.calls, runs: 1 } });
  emit('done', { report: ws.meta('build-report.md'), video: report.render?.ok ? path.join(ws.projectDir, 'renders', 'final.mp4') : null, usage: report.usage, timings: report.timings });
  return report;
}

// Measured checks (no model): a planned background must show; a scene with copy must not be blank.
async function measure(ws, plan, scenes, time = (_kind, work) => work) {
  const issues = [];
  // Only a background layer can be covered by an opaque scene; the layer frames cost a snapshot, so skip them
  // when there is none (transitions and overlays used to trigger it for nothing).
  const layers = scenes.some((s) => s.layer === 'background') ? await time('snapshot', layerEvidence(ws, plan)) : { issues: [] };
  for (const i of layers.issues) issues.push({ id: /scene (\S+)/.exec(i.where)?.[1], problem: i.evidence });
  const covers = scenes.filter((s) => s.layer === 'transition');
  const mids = covers.map((s) => +(s.start + s.duration / 2).toFixed(2));
  const targets = scenes.filter((s) => !['background', 'transition'].includes(s.layer) && (s.text ?? []).some((t) => String(t).trim()));
  // A scene's last moment must still show its copy (an exit may only start in its last 0.3 s), whoever
  // built it: a written scene or a mounted item that ends early leaves dead air before the cut or the end
  // of the film. Not where a cover transition hides the cut, nor where the plan asks to end on an empty frame.
  const covered = (t) => scenes.some((x) => x.layer === 'transition' && t >= x.start && t <= x.start + x.duration);
  const tailAt = (s) => +(s.start + s.duration - 0.25).toFixed(2);
  const tails = targets.filter((s) => s.layer === 'main' && s.duration >= 1.2 && !covered(tailAt(s))
    && !/fades? (out )?to (black|empty|nothing|the ground)|ends? (on|with) an? empty/i.test(`${s.motion ?? ''} ${s.build ?? ''}`));
  const hasBackground = scenes.some((s) => s.layer === 'background');
  // Sample late in each scene, after entrances, before any exit.
  const at = targets.map((s) => +(s.start + s.duration * 0.6).toFixed(2));
  // One snapshot for every frame below: each snapshot call starts a browser (~20 s), so never two.
  const times = [...new Set([...mids, ...at, ...tails.map(tailAt)])];
  if (!times.length) return issues;
  const res = await time('snapshot', hfJson(ws, ['snapshot', '--at', times.join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec }));
  const byTime = new Map((res.json?.frames ?? []).map((f) => [Number(f.time), f.path]));
  const pct = (x) => `${Math.round(x * 100)}%`;
  // The frames are measured in parallel: each measurement is its own short ffmpeg run.
  await Promise.all([
    ...covers.map(async (s, i) => {
      const file = byTime.get(mids[i]);
      if (!file) return;
      // Covered = the beat's own ground no longer shows. Sample 5 patches (corners + centre) against it.
      const ground = await groundPatches(ws, file, plan.__ground);
      if (ground >= 3) issues.push({ id: s.id, problem: `at its midpoint (t=${mids[i]}s) the transition does not cover the frame: the ground colour still shows in ${ground} of 5 sampled patches, so the cut is visible` });
    }),
    ...targets.map(async (s, i) => {
      const file = byTime.get(at[i]);
      if (!file) return;
      const spread = await lumaSpread(ws, file, s);
      if (spread != null && spread < 4) {
        issues.push({ id: s.id, problem: `at t=${at[i]}s the ${s.layer === 'overlay' ? 'overlay band' : 'frame'} is blank (luma spread ${spread}); its copy should be visible` });
        return;
      }
      // The hero fills at least 40% of the frame's width or height (the scene writer's own rule), measured so
      // ready-made blocks are held to it too. Not over a background layer, whose texture hides the copy's box.
      if (s.layer !== 'main' || hasBackground || s.stock) return; // footage fills the frame: no copy box to measure
      const ink = await inkBox(ws, file);
      // Copy that touches the frame's edge is cut off ("Saturdays. 6 A" in a real run): text belongs in the
      // central 80%, content in the central 90%.
      // Cut copy touches the edge along a glyph's height (readable type is at least 2.6% of the frame); a
      // full-bleed hairline (a sonar line in a real run) touches over a pixel or two and is design, not cut text.
      const off = ink && Object.entries(ink.edges).filter(([, along]) => along >= 0.015).map(([side]) => side);
      if (off?.length) {
        issues.push({ id: s.id, problem: `at t=${at[i]}s the copy runs off the frame's ${off.join(' and ')} edge, so it is cut off: keep all text inside the central 80% of the frame` });
        return;
      }
      if (ink && Math.max(ink.w, ink.h) < 0.4) {
        issues.push({ id: s.id, kind: 'small', ink, problem: `at t=${at[i]}s the copy spans only ${pct(ink.w)} of the frame's width and ${pct(ink.h)} of its height; the hero must fill at least 40% of the width or the height` });
      }
    }),
    ...tails.map(async (s) => {
      const file = byTime.get(tailAt(s));
      const spread = file ? await lumaSpread(ws, file, s) : null;
      if (spread != null && spread < 4) issues.push({ id: s.id, problem: `the frame is blank at t=${tailAt(s)}s, just before the scene ends at ${+(s.start + s.duration).toFixed(2)}s: the copy leaves too early. Keep it on screen until the scene's last 0.3 s` });
    }),
  ]);
  return issues;
}

// Where the copy is: the bounding box of every pixel that differs clearly from the ground, as fractions of
// the frame. The frame is shrunk to 384x216 greys and the most common grey is taken as the ground.
let inkFiles = 0;
async function inkBox(ws, file) {
  const [W, H] = [384, 216];
  const out = path.join(ws.tmpDir, `ink-${process.pid}-${++inkFiles}.gray`);
  await run(ws, `ffmpeg -v error -y -i ${quote(file)} -vf "scale=${W}:${H},format=gray" -f rawvideo ${quote(out)}`, { timeoutSec: 60 });
  let px;
  try {
    px = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
  } catch {
    return null;
  }
  if (px.length !== W * H) return null;
  const counts = new Array(256).fill(0);
  for (const v of px) counts[v]++;
  const ground = counts.indexOf(Math.max(...counts));
  let [x1, x2, y1, y2] = [W, -1, H, -1];
  // How far along each edge ink touches it (2 px deep): a hairline rule bleeding off the frame touches over 1-2
  // px, a glyph cut by the edge over its whole height.
  const touch = { left: [H, -1], right: [H, -1], top: [W, -1], bottom: [W, -1] };
  const reach = (t, v) => { t[0] = Math.min(t[0], v); t[1] = Math.max(t[1], v); };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (Math.abs(px[y * W + x] - ground) <= 30) continue;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
      if (x < 2) reach(touch.left, y);
      if (x >= W - 2) reach(touch.right, y);
      if (y < 2) reach(touch.top, x);
      if (y >= H - 2) reach(touch.bottom, x);
    }
  }
  const span = ([a, b], n) => (b < 0 ? 0 : (b - a + 1) / n);
  const edges = { left: span(touch.left, H), right: span(touch.right, H), top: span(touch.top, W), bottom: span(touch.bottom, W) };
  return x2 < 0 ? null : { x: x1 / W, y: y1 / H, w: (x2 - x1 + 1) / W, h: (y2 - y1 + 1) / H, edges };
}

// A ready-made block can't be told a size: scale its host around its copy, to about 45% of the frame on the
// copy's long side, at most 2.5x, and never past the 5% safe margin. Null when it would barely change.
export function fitScale(ink) {
  const cx = ink.x + ink.w / 2;
  const cy = ink.y + ink.h / 2;
  const room = Math.min((Math.min(cx, 1 - cx) - 0.05) / (ink.w / 2), (Math.min(cy, 1 - cy) - 0.05) / (ink.h / 2));
  const k = +Math.min(2.5, 0.45 / Math.max(ink.w, ink.h), room).toFixed(2);
  return k >= 1.15 ? { k, ox: +(cx * 100).toFixed(1), oy: +(cy * 100).toFixed(1) } : null;
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

const LOOK_SYSTEM = `You review frames of a short video against its plan. The contact sheet shows frames from each scene. For each scene, report only real visible defects: text too small to read or cut off, text overlapping, wrong colours for the plan, empty or broken frames, demo/placeholder content, layout far from the plan, and any of the scene's asks a still frame should show that is missing (a fog, a light from behind, a texture, a colour, an object). Motion asks (shake, jitter, a scare) cannot be judged from one frame: skip those. Not defects (a real run's repairs for these broke the scene): copy shown in capitals by a capitals-only typeface or a CSS text-transform; a text colour lighter or darker than a hex named in build, since the text colour is chosen to read on the ground. Reply with JSON only: {"issues":[{"scene":"<scene id>","problem":"what is visibly wrong","fix":"one concrete instruction"}]} — an empty list if it looks right.`;

function lookProvider() {
  try {
    return providerForRole('critic');
  } catch (err) {
    return { error: err.message };
  }
}

async function lookAtFilm(ws, plan, scenes, provider, usage, maxTokens, emit, time = (_kind, work) => work) {
  if (provider.error) return { skipped: provider.error };
  if (!provider.vision) return { skipped: `${provider.name}/${provider.model} cannot see images; set CRITIC to a provider with vision` };
  if (usage.input + usage.output >= maxTokens) return { skipped: 'token cap' };
  // After entrances and reveals have finished (a frame mid-reveal reads as half-typed text).
  const shown = scenes.filter((s) => !['background', 'transition'].includes(s.layer));
  const at = shown.map((s) => lookTime(s));
  const res = await time('snapshot', hfJson(ws, ['snapshot', '--at', at.join(','), '--no-end'], { timeoutSec: config.commandTimeoutSec }));
  const sheet = res.json?.contactSheets?.[0];
  if (!sheet) return { skipped: 'no contact sheet' };
  const img = await imageMessage(provider, 'Contact sheet, frames in scene order:', [sheet]);
  const planText = JSON.stringify(shown.map((s) => ({ scene: s.id, at: lookTime(s), copy: s.text, asks: s.must ?? [], build: s.build })), null, 1);
  const started = Date.now();
  const { message, finish, usage: u } = await chat(provider, [{ role: 'system', content: LOOK_SYSTEM }, { role: 'user', content: planText }, img].filter(Boolean), null, { json: true });
  addUsage(usage, u);
  ws.logCall({ label: 'look', provider: `${provider.name}/${provider.model}`, at: new Date(started).toISOString(), seconds: +((Date.now() - started) / 1000).toFixed(1), finish, usage: u, system: LOOK_SYSTEM, user: planText, image: sheet, reply: message.content ?? '' });
  const out = parseModelJson(message.content ?? '') ?? { issues: [] };
  emit('look', { issues: out.issues ?? [] });
  return out;
}

// "write scenes 50s · verify film 117s … | full check 1× 41s · snapshot 2× 38s …"
export function timingLine(t) {
  if (!t) return '';
  const steps = Object.entries(t.steps).map(([k, v]) => `${k} ${Math.round(v)}s`).join(' · ');
  const calls = Object.entries(t.calls).map(([k, v]) => `${k} ${v.count}× ${Math.round(v.seconds)}s`).join(' · ');
  return [steps, calls].filter(Boolean).join(' | ');
}

function reportMarkdown(r, plan) {
  const rows = Object.entries(r.scenes).map(([id, s]) => `| ${id} | ${s.mode}${s.escalatedFrom ? ` (escalated from ${s.escalatedFrom})` : ''} | ${s.item ?? '-'} | ${s.attempts} | ${s.result}${s.why ? `: ${[].concat(s.why).join('; ').slice(0, 200)}` : ''} |`);
  return `# Build report: ${plan.title ?? r.job}

- Provider: ${r.provider}
- Tokens: ${r.usage.input} in / ${r.usage.output} out over ${r.usage.calls} calls
- Time: ${r.usage.minutes} min (${timingLine(r.timings)})
- Video: ${r.render?.ok ? `renders/final.mp4, ${r.render.duration}s, ${r.render.size}` : r.render ? `render failed or did not verify` : 'not rendered'}

## Scenes

| Scene | How it was made | Item | Model calls | Result |
|---|---|---|---|---|
${rows.join('\n')}

## Media

${(r.media ?? []).length ? r.media.map((m) => `- ${m.scene}: ${m.kind} "${m.query}" by ${m.credit.name} (${m.source}) → ${m.file}`).join('\n') : '- none'}

## Measured checks

${r.measured.length ? r.measured.map((i) => `- ${i.id}: ${i.problem}`).join('\n') : '- none failed'}

## Look

${r.look ? (r.look.skipped ? `- skipped: ${r.look.skipped}` : (r.look.issues ?? []).map((i) => `- ${i.scene}: ${i.problem} → ${i.fix}`).join('\n') || '- no issues') : '- off'}

## Sound effects

${(r.sfx ?? []).length ? r.sfx.map((c) => `- ${c.start}s ${c.name} (${c.duration}s, volume ${c.volume})`).join('\n') : '- none'}

## Warnings

${r.warnings.length ? r.warnings.map((w) => `- ${w}`).join('\n') : '- none'}
`;
}

