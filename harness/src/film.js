// One film from a prompt, the token-lean way: plan (a few short calls) → build (code assembles,
// the model writes only hand-built scenes) → render. Same result shape as runJob, so the API
// server can switch between the two. Resumable: a job folder that already has plan.json skips
// straight to the build.
import fs from 'node:fs';
import path from 'node:path';
import { providerForRole } from './config.js';
import { ensureBrowser } from './sandbox.js';
import { Workspace } from './workspace.js';
import { runPlan } from './plan.js';
import { runBuild } from './build/index.js';

const MODE = 'plan-build';

export async function runFilm({ prompt, options = {}, resume, jobsDir, onEvent, signal: outer, look = process.env.BUILD_LOOK !== 'false', render = true } = {}) {
  providerForRole('planner'); // fail fast on missing keys
  providerForRole('builder');
  await ensureBrowser();

  const signals = [AbortSignal.timeout(Number(process.env.JOB_TIMEOUT_MIN ?? 60) * 60_000), outer].filter(Boolean);
  const signal = AbortSignal.any(signals);

  let ws = resume ? Workspace.open(resume) : null;
  const pending = [];
  // Synchronous appends: a log write must never throw into the job (or crash the server).
  const write = (lines) => {
    try {
      fs.appendFileSync(ws.meta('events.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    } catch {
      /* the job folder is gone; the event still reaches onEvent */
    }
  };
  const emit = (ev) => {
    const stamped = { at: new Date().toISOString(), ...ev };
    if (ws) write([stamped]);
    else pending.push(stamped);
    onEvent?.(stamped);
  };

  try {
    if (!ws?.readJson('plan.json')) {
      const request = ws?.readJson('request.json') ?? {};
      const r = await runPlan({
        prompt: prompt ?? request.prompt,
        options: resume ? request.options ?? {} : options,
        dir: ws?.dir,
        jobsDir,
        judge: false,
        mode: MODE,
        signal,
        onEvent: (ev) => {
          // runPlan creates the job folder; start logging there once it exists.
          if (ev.type === 'job_start' && !ws) {
            ws = Workspace.open(ev.dir);
            write(pending.splice(0));
          }
          emit(ev);
        },
      });
      if (r.problems) emit({ type: 'plan_warnings', problems: r.problems.split('\n') });
      ws.setState({ stage: 'planned' });
    } else {
      emit({ type: 'job_start', job: ws.id, dir: ws.dir, resume: true });
    }

    const report = await runBuild(ws.dir, { onEvent: emit, look, render, signal });
    const plan = ws.readJson('plan.json');
    if (!render) {
      ws.setState({ stage: 'built', error: null });
      return { job: ws.id, video: null, project: ws.projectDir, title: plan.title, usage: ws.readJson('usage.json', {}), report };
    }
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
      fallbacks: Object.entries(report.scenes).filter(([, s]) => String(s.result).startsWith('fallback')).map(([id]) => id),
    };
    ws.writeJson('result.json', result);
    ws.setState({ stage: 'done', error: null });
    emit({ type: 'job_done', video: result.video, duration: verify.duration, ok: true });
    return result;
  } catch (err) {
    const message = signal.aborted && !outer?.aborted ? `Job timed out after ${process.env.JOB_TIMEOUT_MIN ?? 60} min` : err.message;
    emit({ type: 'job_failed', error: message });
    ws?.setState({ error: message });
    throw signal.aborted && !outer?.aborted ? new Error(message) : err;
  }
}
