// Edit a finished film from a follow-up request ("make the title bigger", "use our brand colours", "redesign it
// as a brutalist poster"). The film's project is copied into a new job; one planning call revises the plan and
// says what changes in which scene; the build keeps the scenes the change leaves alone exactly as they were,
// rewrites the changed ones from their current file, writes new ones fresh, then checks, looks and renders as
// usual. Only what changes costs tokens. Same result shape as runFilm.
import fs from 'node:fs';
import path from 'node:path';
import { providerForRole, config } from './config.js';
import { ensureBrowser } from './sandbox.js';
import { Workspace } from './workspace.js';
import { SkillLibrary } from './skills/library.js';
import { ask, assignMust, filmGuide, planChecks, planSystem, withFormat } from './plan.js';
import { plannerHandoff } from './roles/planner.js';
import { runBuild } from './build/index.js';

const MODE = 'edit';

const EDIT_REPLY = `{
  "summary": "what changes, one line, in the person's terms",
  "changes": { "<scene id>": "exactly what to change in that scene's file: sizes, colours, copy, motion, timing, in numbers" },
  "must": ["the film's asks after this change: the current must list, updated by the request"],
  "plan": <the whole revised plan, in the plan shape above>
}`;

function editRequest(base, request) {
  return `<current-plan>
${JSON.stringify(base.plan, null, 1)}
</current-plan>

<current-brief>
${JSON.stringify(base.brief, null, 1)}
</current-brief>

<change-request>
${request}
</change-request>

This film is already made. Revise its plan to make the requested change, and reply with JSON only, in this shape (not the plan shape alone):
${EDIT_REPLY}
Rules for an edit:
- Change only what the request asks for. Every scene the request does not touch keeps its id, start, duration, text, build, motion and must exactly as they are, and is not in changes.
- Every scene whose look, copy, motion or timing changes is in changes, with a concrete instruction for its file. A new scene is in changes too ("new scene: …"). A removed scene is simply left out of the plan.
- A restyle or redesign ("make it brutalist", "use our brand colours", "darker", "more playful") changes the theme and the build of every scene it affects: list each of them in changes.
- Copy the request gives is used verbatim. format.duration stays ${base.plan.format?.duration} s: fit the change inside it.
- must is the current list with this request folded in: an ask the request reverses is replaced, a new one added.`;
}

export async function runEdit({ prompt, base: baseDir, options = {}, jobsDir, onEvent, signal: outer, look = process.env.BUILD_LOOK !== 'false', render = true } = {}) {
  const provider = providerForRole('planner');
  providerForRole('builder');
  await ensureBrowser();
  const signals = [AbortSignal.timeout(Number(process.env.JOB_TIMEOUT_MIN ?? 60) * 60_000), outer].filter(Boolean);
  const signal = AbortSignal.any(signals);

  const baseWs = Workspace.open(baseDir);
  const base = { plan: baseWs.readJson('plan.json'), brief: baseWs.readJson('brief.json'), lists: baseWs.readJson('shortlist.json', { blocks: {}, components: {} }) };
  if (!base.plan || !base.brief || !fs.existsSync(baseWs.projectDir)) throw new Error('The film to edit has no plan or project to start from');

  const ws = Workspace.create(jobsDir);
  const emit = (ev) => {
    const stamped = { at: new Date().toISOString(), ...ev };
    try {
      fs.appendFileSync(ws.meta('events.jsonl'), `${JSON.stringify(stamped)}\n`);
    } catch {
      /* the event still reaches onEvent */
    }
    onEvent?.(stamped);
  };

  try {
    ws.writeJson('request.json', { prompt, options, editOf: baseWs.id, createdAt: new Date().toISOString(), mode: MODE });
    emit({ type: 'job_start', job: ws.id, dir: ws.dir, editOf: baseWs.id });
    // The film as it is: its project (renders left behind) and the shortlist it was planned from.
    fs.cpSync(baseWs.projectDir, ws.projectDir, { recursive: true, filter: (src) => !/[\\/]renders([\\/]|$)/.test(src) });
    ws.writeJson('shortlist.json', base.lists);

    // 1. Revise the plan (one call, one repair).
    emit({ type: 'step', step: 'plan edit', provider: `${provider.name}/${provider.model}` });
    const lib = new SkillLibrary(config.skillsDir);
    const usage = { input: 0, output: 0, cachedInput: 0, calls: 0, pricedCalls: 0, cost: 0 };
    const log = (call) => ws.logCall(call);
    const system = planSystem(lib);
    const input = `${editRequest(base, prompt)}\n\n<film-guide>\n${filmGuide(lib, base.brief, `${base.brief.title ?? ''} ${prompt}`)}\n</film-guide>`;
    const ctx = { ws, seenRegistry: new Set([...Object.values(base.lists.blocks ?? {}), ...Object.values(base.lists.components ?? {})].flat().map((i) => i?.name).filter(Boolean)), readLog: new Set() };
    const check = async (reply) => {
      if (!Array.isArray(reply?.plan?.scenes)) return 'reply had no plan with scenes[]: reply with summary, changes, must and the whole plan';
      const brief = { ...base.brief, must: Array.isArray(reply.must) ? reply.must : base.brief.must };
      const errs = [await plannerHandoff.validate(reply.plan, ctx), ...planChecks(reply.plan, brief, base.lists)].filter(Boolean);
      return errs.length ? errs.join('\n') : null;
    };
    let reply = await ask(provider, system, input, usage, { signal, label: 'plan edit', log });
    let problems = await check(reply);
    if (problems) {
      emit({ type: 'repair', step: 'plan edit', errors: problems.split('\n') });
      reply = await ask(provider, system, `${input}\n\nYour previous reply had these problems; fix them and reply with the whole JSON again:\n${problems}\n\nPrevious reply:\n${JSON.stringify(reply)}`, usage, { signal, label: 'plan edit repair', log });
    }
    if (!Array.isArray(reply?.plan?.scenes)) throw new Error('The model did not return a usable edit of the plan');

    const plan = reply.plan;
    plan.format = withFormat(base.plan.format, plan.format); // an edit never changes the film's size or length
    const brief = { ...base.brief, must: Array.isArray(reply.must) ? reply.must : base.brief.must };
    assignMust(plan, brief);
    const changes = Object.fromEntries(Object.entries(reply.changes ?? {}).filter(([id, what]) => plan.scenes.some((s) => s.id === id) && String(what).trim()));
    // Kept: in the film already, not named in changes, same time and copy.
    const was = Object.fromEntries(base.plan.scenes.map((s) => [s.id, s]));
    const same = (a, b) => a && Math.abs(a.start - b.start) < 0.01 && Math.abs(a.duration - b.duration) < 0.01 && JSON.stringify(a.text ?? []) === JSON.stringify(b.text ?? []);
    const keep = plan.scenes.filter((s) => !changes[s.id] && same(was[s.id], s)).map((s) => s.id);
    ws.writeJson('brief.json', brief);
    ws.writeJson('plan.json', plan);
    ws.writeJson('edit.json', { request: prompt, summary: reply.summary ?? '', changes, keep, base: baseWs.id });
    const prev = ws.readJson('usage.json', {});
    const { lastRaw, ...counts } = usage;
    ws.writeJson('usage.json', { ...prev, planner: { ...counts, turns: counts.calls, runs: 1 } });
    emit({ type: 'edit_plan', summary: reply.summary ?? '', changes, keep });
    ws.setState({ stage: 'planned' });

    // 2. Build: kept scenes stay, changed scenes are edited from their files, new ones written.
    const report = await runBuild(ws.dir, { onEvent: emit, look, render, signal, edit: { base: baseWs.projectDir, keep, changes, request: prompt } });
    const fallbacks = Object.entries(report.scenes).filter(([, s]) => String(s.result).startsWith('fallback')).map(([id]) => id);
    if (!render) return { job: ws.id, video: null, project: ws.projectDir, title: plan.title, usage: ws.readJson('usage.json', {}), report, fallbacks };
    const verify = report.render ?? { ok: false, reason: 'not rendered' };
    if (!verify.ok) throw new Error(`Render failed or did not verify${verify.log ? `:\n${verify.log}` : verify.drift ? ` (duration off by ${verify.drift.toFixed(2)}s)` : ''}`);

    const result = {
      job: ws.id,
      video: path.join(ws.projectDir, 'renders', 'final.mp4'),
      project: ws.projectDir,
      title: plan.title,
      duration: verify.duration,
      expectedDuration: plan.format.duration,
      verify,
      usage: ws.readJson('usage.json', {}),
      fallbacks,
      editOf: baseWs.id,
    };
    ws.writeJson('result.json', result);
    ws.setState({ stage: 'done', error: null });
    emit({ type: 'job_done', video: result.video, duration: verify.duration, ok: true });
    return result;
  } catch (err) {
    const message = signal.aborted && !outer?.aborted ? `Job timed out after ${process.env.JOB_TIMEOUT_MIN ?? 60} min` : err.message;
    emit({ type: 'job_failed', error: message });
    ws.setState({ error: message });
    throw signal.aborted && !outer?.aborted ? new Error(message) : err;
  }
}
