// One job = one folder: the HyperFrames project, the agents' private home, and the harness's own records.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export class Workspace {
  constructor(dir) {
    this.dir = dir;
    this.id = path.basename(dir);
    this.projectDir = path.join(dir, 'project');
    this.homeDir = path.join(dir, 'home');
    this.tmpDir = path.join(dir, 'home', 'tmp');
    this.metaDir = path.join(dir, 'harness');
    this.uid = config.sandboxEnabled ? config.sandboxUidBase + (Number.parseInt(this.id.replace(/\D/g, '').slice(-6) || '0', 10) % 40000) : null;
  }

  static create(jobsDir = config.jobsDir) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const ws = new Workspace(path.join(jobsDir, `${stamp}-${crypto.randomBytes(3).toString('hex')}`));
    for (const d of [ws.projectDir, ws.tmpDir, ws.metaDir]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(ws.dir, 0o711);
    fs.chmodSync(ws.metaDir, 0o700);
    ws.chownAgentDirs();
    return ws;
  }

  static open(dir) {
    const ws = new Workspace(path.resolve(dir));
    if (!fs.existsSync(ws.metaDir)) throw new Error(`Not a job folder: ${dir}`);
    return ws;
  }

  // Agent commands run as the job's uid; give it the project and its home, never the harness folder.
  chownAgentDirs() {
    if (!this.uid) return;
    for (const root of [this.projectDir, this.homeDir]) {
      const stack = [root];
      while (stack.length) {
        const p = stack.pop();
        fs.lchownSync(p, this.uid, this.uid);
        if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
      }
      fs.chmodSync(root, 0o700);
    }
  }

  meta(name) {
    return path.join(this.metaDir, name);
  }

  readJson(name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.meta(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(name, data) {
    fs.writeFileSync(this.meta(name), `${JSON.stringify(data, null, 2)}\n`);
  }

  get state() {
    return this.readJson('state.json', { stage: 'new', round: 0, history: [] });
  }

  setState(patch) {
    const next = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    this.writeJson('state.json', next);
    return next;
  }

  // Every model call of the plan and build steps, to see exactly what a model was asked and answered, or
  // to replay one call with a changed prompt: calls/NNN-<label>.json, each distinct system prompt stored
  // once beside them. A log write must never break the job.
  logCall({ label = 'call', system = '', ...rest }) {
    try {
      const dir = this.meta('calls');
      fs.mkdirSync(dir, { recursive: true });
      const sys = `system-${crypto.createHash('sha1').update(system).digest('hex').slice(0, 10)}.md`;
      if (!fs.existsSync(path.join(dir, sys))) fs.writeFileSync(path.join(dir, sys), system);
      const n = fs.readdirSync(dir).filter((f) => /^\d+-/.test(f)).length + 1;
      const name = `${String(n).padStart(3, '0')}-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.json`;
      fs.writeFileSync(path.join(dir, name), `${JSON.stringify({ label, system: sys, ...rest }, null, 2)}\n`);
    } catch {
      /* the archive is for people; the film goes on without it */
    }
  }
}
