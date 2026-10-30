// Runs commands for agents: scrubbed environment (no API keys), per-job uid when running as root,
// process-group kill on timeout, bounded output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HYPERFRAMES_FFMPEG_PATH', 'HYPERFRAMES_FFPROBE_PATH', 'PRODUCER_HEADLESS_SHELL_PATH', 'PRODUCER_BROWSER_GPU_MODE', 'HEYGEN_API_BASE',
  // Windows needs these for networking and Chrome; they never hold secrets.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'TEMP', 'TMP'];

let browserPath = null;

export function getBashBin() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'D:\\Donwload-main\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'bash';
}

// The pinned Chrome lives in the harness user's cache; agents get its path, not that user's HOME.
export async function ensureBrowser() {
  if (browserPath) return browserPath;
  if (process.env.PRODUCER_HEADLESS_SHELL_PATH) return (browserPath = process.env.PRODUCER_HEADLESS_SHELL_PATH);
  const bin = config.hyperframesBin;
  const call = (args) => new Promise((resolve) => {
    const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' };
    // Windows can only start the .cmd shim through a shell; args here are fixed literals.
    const child = process.platform === 'win32'
      ? spawn(`"${bin}" ${args.join(' ')}`, { shell: true, env })
      : spawn(bin, args, { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
  await call(['browser', 'ensure']);
  const line = (await call(['browser', 'path'])).split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
  browserPath = line ?? null;
  return browserPath;
}

export function sandboxEnv(ws, extra = {}) {
  const env = {};
  for (const k of PASS_ENV) {
    const v = process.env[k] ?? process.env[Object.keys(process.env).find((n) => n.toUpperCase() === k) ?? ''];
    if (v) env[k] = v;
  }
  const binDir = path.dirname(config.hyperframesBin);
  env.PATH = [config.shimsDir, binDir, env.PATH].filter(Boolean).join(path.delimiter);
  env.HOME = ws.homeDir;
  env.USERPROFILE = ws.homeDir;
  if (process.platform !== 'win32') env.TMPDIR = ws.tmpDir;
  env.npm_config_cache = path.join(ws.homeDir, '.npm');
  env.npm_config_update_notifier = 'false';
  env.HYPERFRAMES_NO_TELEMETRY = '1';
  env.HYPERFRAMES_NO_UPDATE_CHECK = '1';
  env.HYPERFRAMES_SKIP_SKILLS = '1';
  env.HYPERFRAMES_CLIENT = 'motion-studio-harness';
  env.HF_SKILLS_DIR = config.skillsDir;
  env.HYPERFRAMES_FONT_CACHE_DIR = path.join(ws.homeDir, '.cache', 'fonts');
  if (browserPath) env.PRODUCER_HEADLESS_SHELL_PATH = browserPath;
  env.CI = '1';
  return { ...env, ...extra };
}

export function run(ws, command, { cwd = ws.projectDir, timeoutSec = config.commandTimeoutSec, env, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const limits = isWin ? '' : `ulimit -u ${config.sandboxMaxProcs} -f ${config.jobDiskMb * 1024} 2>/dev/null; `;
    const opts = { cwd, env: env ?? sandboxEnv(ws), detached: !isWin, windowsHide: true };
    if (config.sandboxEnabled && ws.uid) Object.assign(opts, { uid: ws.uid, gid: ws.uid });
    const child = spawn(getBashBin(), ['-c', `${limits}${command}`], opts);

    let out = '';
    let bytes = 0;
    let truncated = false;
    const collect = (d) => {
      bytes += d.length;
      if (out.length < maxBytes) out += d.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `spawn failed: ${err.message}`, timedOut: false, truncated });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, output: out, timedOut, truncated, bytes });
    });
  });
}

function kill(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

// Strip ANSI and progress-bar noise, keep head and tail.
export function clip(text, max = config.toolOutputChars) {
  const clean = String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop())
    .filter((l) => !/^npm notice/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  if (clean.length <= max) return clean;
  const head = Math.floor(max * 0.35);
  return `${clean.slice(0, head)}\n\n[… ${clean.length - max} chars cut …]\n\n${clean.slice(-(max - head))}`;
}

// Resolve a user path inside a root; refuse anything that escapes it, including through symlinks.
export function confine(root, p) {
  const abs = path.resolve(root, String(p ?? '.'));
  const realRoot = fs.realpathSync(root);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path "${p}" is outside the project.`);
  return real;
}

export function dirSizeMb(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  }
  return total / 1024 / 1024;
}
