// Tools that touch the job's HyperFrames project: files, the CLI, shell, check and snapshots.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { hf, hfJson, summarizeCheck } from '../hf.js';
import { clip, confine, dirSizeMb, run } from '../sandbox.js';
import { pointersFor } from './skill-tools.js';

const HF_COMMANDS = {
  planner: ['capture', 'catalog', 'docs'],
  builder: ['lint', 'check', 'snapshot', 'catalog', 'add', 'info', 'compositions', 'timeline', 'docs', 'media-use', 'media-treatment',
    'tts', 'transcribe', 'beats', 'normalize-audio', 'remove-background', 'keyframes', 'audio', 'compare', 'capture', 'doctor', 'browser'],
  critic: ['lint', 'check', 'snapshot', 'info', 'compositions', 'timeline', 'keyframes', 'audio', 'docs'],
  fixer: ['lint', 'check', 'snapshot', 'catalog', 'add', 'info', 'compositions', 'timeline', 'docs', 'media-use', 'media-treatment',
    'tts', 'beats', 'normalize-audio', 'keyframes', 'audio', 'doctor', 'browser'],
};

const rel = (ws, abs) => path.relative(ws.projectDir, abs).split(path.sep).join('/');
const IMAGE = /\.(png|jpe?g|webp)$/i;
const TEXT_LIMIT = 400_000;
const BINARY = /\.(mp3|wav|m4a|aac|ogg|flac|mp4|mov|webm|mkv|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|glb|gltf|zip)$/i;

function chown(ws, abs) {
  if (!ws.uid) return;
  let p = abs;
  while (p.startsWith(ws.projectDir)) {
    fs.lchownSync(p, ws.uid, ws.uid);
    if (p === ws.projectDir) break;
    p = path.dirname(p);
  }
}

export function makeFileTools({ write }) {
  const tools = [
    {
      name: 'list_files',
      description: 'List files in the project (or a folder of it), with sizes. Skips node_modules and .hyperframes.',
      parameters: { type: 'object', properties: { dir: { type: 'string', description: 'Folder relative to the project root; default "."' } }, additionalProperties: false },
      run: (args, ctx) => {
        const root = confine(ctx.ws.projectDir, args.dir ?? '.');
        const out = [];
        const stack = [root];
        while (stack.length && out.length < 400) {
          const d = stack.pop();
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (['node_modules', '.hyperframes', '.git'].includes(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) out.push(`${rel(ctx.ws, p)}  ${fs.statSync(p).size}B`);
          }
        }
        return out.sort().join('\n') || '(empty)';
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file from the project by line range. Line numbers are shown. Large files: read in ranges.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start: { type: 'integer', minimum: 1, description: 'First line (1-based), default 1' },
          lines: { type: 'integer', minimum: 1, maximum: 800, description: 'How many lines, default 300' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const abs = confine(ctx.ws.projectDir, args.path);
        if (!fs.existsSync(abs)) return `No such file: ${args.path}`;
        if (IMAGE.test(abs)) return 'That is an image; use view_image.';
        const all = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
        const start = args.start ?? 1;
        const end = Math.min(all.length, start - 1 + (args.lines ?? 300));
        const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
        return `${args.path} lines ${start}-${end} of ${all.length}\n${clip(body, 30_000)}`;
      },
    },
  ];
  if (!write) return tools;
  return tools.concat([
    {
      name: 'write_file',
      description: 'Create or overwrite a text file in the project (HTML, CSS, JS, JSON, MD).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
      run: (args, ctx) => {
        if (args.content.length > TEXT_LIMIT) return `Refused: ${args.content.length} chars is more than one file should hold.`;
        if (BINARY.test(args.path)) {
          return 'Refused: write_file makes text files only. Media and fonts must be real files: get them with hf media-use / tts / add, or leave them out and report it. Never write a placeholder.';
        }
        const abs = confine(ctx.ws.projectDir, args.path);
        if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) return 'Refused: target is a symlink.';
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content);
        chown(ctx.ws, abs);
        ctx.emit('file_write', { path: rel(ctx.ws, abs), chars: args.content.length });
        return `Wrote ${rel(ctx.ws, abs)} (${args.content.split('\n').length} lines).`;
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact snippet in a project file. old_text must match exactly once unless replace_all is true. Prefer this over rewriting whole files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const abs = confine(ctx.ws.projectDir, args.path);
        if (!fs.existsSync(abs)) return `No such file: ${args.path}`;
        if (fs.lstatSync(abs).isSymbolicLink()) return 'Refused: target is a symlink.';
        const src = fs.readFileSync(abs, 'utf8');
        const oldText = stripLineNumbers(args.old_text);
        const count = oldText ? src.split(oldText).length - 1 : 0;
        if (count > 1 && !args.replace_all) return `old_text matches ${count} places; add surrounding lines to make it unique, or set replace_all.`;
        let next;
        let how = 'exact';
        if (count) {
          next = args.replace_all ? src.split(oldText).join(args.new_text) : src.replace(oldText, () => args.new_text);
        } else {
          // Models often get indentation or line breaks wrong; match ignoring whitespace differences.
          const spans = looseMatches(src, oldText);
          if (spans.length !== 1) return notFound(src, oldText, spans.length);
          const [start, end] = spans[0];
          next = src.slice(0, start) + args.new_text + src.slice(end);
          how = 'whitespace-tolerant';
        }
        fs.writeFileSync(abs, next);
        ctx.emit('file_edit', { path: rel(ctx.ws, abs), replaced: args.replace_all ? count : 1, how });
        return `Edited ${rel(ctx.ws, abs)} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''}${how === 'exact' ? '' : ', matched ignoring whitespace'}).`;
      },
    },
  ]);
}

// read_file prefixes lines with "  123  "; drop that if a model pasted it into old_text.
function stripLineNumbers(text) {
  const lines = String(text ?? '').split('\n');
  return lines.every((l) => /^\s*\d+ {2}/.test(l) || !l.trim()) ? lines.map((l) => l.replace(/^\s*\d+ {2}/, '')).join('\n') : String(text ?? '');
}

export function looseMatches(src, oldText) {
  const tokens = oldText.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const re = new RegExp(tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
  return [...src.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

function notFound(src, oldText, loose) {
  if (loose > 1) return `old_text matches ${loose} places (ignoring whitespace); include more surrounding lines.`;
  const first = oldText.split('\n').map((l) => l.trim()).find((l) => l.length > 6) ?? oldText.trim();
  const probe = first.slice(0, 24);
  const near = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(probe)).slice(0, 3);
  return `old_text not found, even ignoring whitespace.${near.length
    ? ` Lines containing "${probe}":\n${near.map(([n, l]) => `${String(n).padStart(5)}  ${l}`).join('\n')}\nCopy from these lines exactly (without the line numbers).`
    : ' Read the region again with read_file and copy it without the line numbers.'}`;
}

export function makeHfTool(role) {
  const allowed = HF_COMMANDS[role];
  return {
    name: 'hf',
    description: `Run the HyperFrames CLI in the project folder. Allowed subcommands for you: ${allowed.join(', ')}. `
      + 'Pass arguments as an array, e.g. ["lint"] or ["snapshot","--at","1.5,4","--json"]. Rendering is done by the harness, not by you.',
    parameters: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['args'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const [cmd, ...rest] = args.args;
      if (!allowed.includes(cmd)) return `"${cmd}" is not available to the ${ctx.role}. Allowed: ${allowed.join(', ')}.`;
      if (cmd === 'media-use' && !config.allowNetworkMedia && !rest.includes('--local-only')) rest.push('--local-only');
      if (cmd === 'browser' && rest[0] && !['path', 'ensure'].includes(rest[0])) return 'Only "browser path" and "browser ensure" are allowed.';
      ctx.emit('hf', { args: [cmd, ...rest] });
      const res = await hf(ctx.ws, [cmd, ...rest]);
      const note = guardDisk(ctx);
      return `exit ${res.code}${res.timedOut ? ' (timed out)' : ''}\n${clip(res.output)}${note}`;
    },
  };
}

export function makeBashTool() {
  return {
    name: 'bash',
    description: 'Run a shell command in the project folder (sandboxed, no secrets, time-limited). Use for ffprobe, ls, node on skill scripts ($HF_SKILLS_DIR), small file moves. Use the hf tool for HyperFrames commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_sec: { type: 'integer', minimum: 5, maximum: 1200 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      if (/\bhyperframes\s+(render|preview|present|publish|cloud|lambda|cloudrun|upgrade|skills|feedback|open)\b/.test(args.command)) {
        return 'That HyperFrames command is reserved for the harness.';
      }
      ctx.emit('bash', { command: args.command });
      const res = await run(ctx.ws, args.command, { timeoutSec: Math.min(args.timeout_sec ?? 300, config.commandTimeoutSec) });
      const note = guardDisk(ctx);
      return `exit ${res.code}${res.timedOut ? ' (timed out)' : ''}\n${clip(res.output)}${note}`;
    },
  };
}

function guardDisk(ctx) {
  const mb = dirSizeMb(ctx.ws.projectDir);
  if (mb > config.jobDiskMb) throw new Error(`Job folder is ${mb.toFixed(0)} MB, over the ${config.jobDiskMb} MB limit.`);
  return removeFakeMedia(ctx);
}

// What a real file of each media type starts with. A file whose bytes don't match its extension is a fake.
const MAGIC = [
  [/\.mp3$/i, (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  [/\.wav$/i, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE'],
  [/\.(m4a|aac|mp4|mov)$/i, (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' || (b[0] === 0xff && (b[1] & 0xf6) === 0xf0)],
  [/\.ogg$/i, (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
  [/\.flac$/i, (b) => b.subarray(0, 4).toString('latin1') === 'fLaC'],
  [/\.webm|\.mkv$/i, (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  [/\.png$/i, (b) => b.readUInt32BE(0) === 0x89504e47],
  [/\.jpe?g$/i, (b) => b[0] === 0xff && b[1] === 0xd8],
  [/\.gif$/i, (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  [/\.webp$/i, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  [/\.woff2$/i, (b) => b.subarray(0, 4).toString('latin1') === 'wOF2'],
  [/\.woff$/i, (b) => b.subarray(0, 4).toString('latin1') === 'wOFF'],
  [/\.(ttf|otf)$/i, (b) => ['true', 'OTTO', 'ttcf'].includes(b.subarray(0, 4).toString('latin1')) || b.readUInt32BE(0) === 0x00010000],
];

function removeFakeMedia(ctx) {
  const notes = [];
  const fonts = new Map();
  const stack = [ctx.ws.projectDir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.hyperframes', '.git', '.thumbnails'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const rule = MAGIC.find(([re]) => re.test(e.name));
      if (!rule) continue;
      const head = Buffer.alloc(16);
      const fd = fs.openSync(p, 'r');
      const n = fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      if (n < 12 || !rule[1](head)) {
        fs.rmSync(p);
        notes.push(`${rel(ctx.ws, p)} was not a real ${path.extname(p).slice(1)} file (placeholder bytes); the harness deleted it`);
        continue;
      }
      // A font copied in under another family's name is a fake too.
      if (/\.(woff2?|ttf|otf)$/i.test(e.name)) {
        const hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
        const twin = fonts.get(hash);
        if (twin && path.basename(twin).split(/[-_.]/)[0].toLowerCase() !== e.name.split(/[-_.]/)[0].toLowerCase()) {
          fs.rmSync(p);
          notes.push(`${rel(ctx.ws, p)} was ${rel(ctx.ws, twin)} renamed; a font file must be the family it claims to be, so the harness deleted it`);
        } else fonts.set(hash, p);
      }
    }
  }
  if (!notes.length) return '';
  ctx.emit('fake_media_removed', { role: ctx.role, files: notes });
  return `\n\nHARNESS: ${notes.join('; ')}. Remove any reference to these files, or get a real file (hf media-use, a bundled font by name).`;
}

export async function runCheck(ws, extra = []) {
  const res = await hfJson(ws, ['check', ...extra], { timeoutSec: config.commandTimeoutSec });
  const summary = summarizeCheck(res.json);
  if (!res.json) summary.text = `check failed to produce JSON (exit ${res.code}):\n${clip(res.output, 4000)}`;
  return summary;
}

// Point each finding at the skill section that explains it; after three identical failing checks, say so plainly.
export function withGuidance(ctx, s) {
  const codes = s.findings.filter((f) => f.severity !== 'info').map((f) => f.code);
  const errorKey = s.findings.filter((f) => f.severity === 'error').map((f) => f.code).sort().join(',');
  ctx.checkHistory ??= [];
  ctx.checkHistory.push(errorKey);
  const pointers = pointersFor(ctx.lib, ctx.role, codes);
  let text = s.text;
  if (pointers.length) text += `\n\nSkill sections for these findings:\n${pointers.join('\n')}`;
  const last = ctx.checkHistory.slice(-3);
  if (errorKey && last.length === 3 && last.every((k) => k === errorKey)) {
    ctx.emit('stuck', { role: ctx.role, codes: errorKey });
    text += `\n\nSTUCK: the same error(s) (${errorKey}) survived three checks. Stop editing by trial. Read the fix line above literally, re-read the "Shape of a project" excerpt in your instructions${pointers.length ? ' and the sections listed' : ''}, then make one deliberate change.`;
  }
  return text;
}

// Hand-off gate for builder and fixer: their word that check passes is not enough.
export async function checkGate(ctx) {
  const check = await runCheck(ctx.ws);
  ctx.lastCheck = check;
  ctx.emit('gate_check', { role: ctx.role, errors: check.errors, warnings: check.warnings });
  if (check.errors > 0) return `The harness ran hyperframes check: ${check.errors} error(s) remain. Fix them, re-run check, then hand off again.\n${withGuidance(ctx, check)}`;
  return null;
}

export async function runSnapshot(ws, extra = ['--review']) {
  const res = await hfJson(ws, ['snapshot', ...extra], { timeoutSec: config.commandTimeoutSec });
  const j = res.json;
  if (!j) return { ok: false, text: `snapshot failed (exit ${res.code}):\n${clip(res.output, 4000)}`, images: [] };
  const sheets = j.contactSheets ?? [];
  const frames = (j.files ?? j.frames ?? []).map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  const notes = j.review?.notes ?? [];
  const scenes = (j.review?.scenes ?? []).map((s) => `${s.id} ${s.start}-${s.end}s`).join(', ');
  const images = sheets.length ? sheets : frames.slice(0, 6);
  return {
    ok: true,
    images,
    text: [`snapshot: ${frames.length} frames${scenes ? `; scenes: ${scenes}` : ''}`,
      ...images.map((p) => `image: ${rel(ws, p)}`), ...notes.map((n) => `note: ${n}`)].join('\n'),
  };
}

export function makeReviewTools() {
  return [
    {
      name: 'check',
      description: 'Run `hyperframes check` (lint, runtime, layout, motion, contrast, craft, audio) and get a condensed report with fix hints.',
      parameters: { type: 'object', properties: { composition: { type: 'string', description: 'Optional data-composition-id to scope to' } }, additionalProperties: false },
      run: async (args, ctx) => {
        ctx.emit('check_run', { composition: args.composition ?? null });
        const s = await runCheck(ctx.ws, args.composition ? ['--composition', args.composition] : []);
        return withGuidance(ctx, s);
      },
    },
    {
      name: 'snapshot',
      description: 'Capture frames and look at them. Default is the review set (each scene start+middle, seams, phone strip). Or pass times in seconds.',
      parameters: {
        type: 'object',
        properties: {
          at: { type: 'array', items: { type: 'number' }, maxItems: 8, description: 'Exact times in seconds' },
          composition: { type: 'string' },
        },
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        const extra = args.at?.length ? ['--at', args.at.join(',')] : ['--review'];
        // The CLI takes one of --at / --composition; exact times win.
        if (args.composition && !args.at?.length) extra.push('--composition', args.composition);
        ctx.emit('snapshot', { at: args.at ?? null, composition: args.composition ?? null });
        const s = await runSnapshot(ctx.ws, extra);
        return { text: s.text, images: s.images };
      },
    },
    {
      name: 'view_image',
      description: 'Look at an image file from the project (a snapshot PNG, a contact sheet, an asset).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      run: (args, ctx) => {
        const abs = confine(ctx.ws.projectDir, args.path);
        if (!fs.existsSync(abs) || !IMAGE.test(abs)) return `No image at ${args.path}`;
        return { text: `image: ${args.path}`, images: [abs] };
      },
    },
  ];
}
