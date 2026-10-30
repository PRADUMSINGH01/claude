// Motion Studio Backend API Server
// Connects the Next.js frontend (http://localhost:3000) to the HyperFrames multi-agent harness
// in ../harness without modifying any existing harness files.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

// Import harness modules (read-only consumption; no harness files are modified)
import { runJob } from '../harness/src/orchestrator.js';
import { runFilm } from '../harness/src/film.js';
import { PALETTES, paletteById } from '../harness/src/look.js';
import {
  config,
  providerStatus,
  providerForRole,
  useProvider,
} from '../harness/src/config.js';
import { listThemes } from '../harness/src/tools/registry-tools.js';

const JOBS_DIR = config.jobsDir;
// plan-build (default): plan in a few short calls, then code assembles and the model writes only
// hand-built scenes (~20-60k tokens a film). agents: the older planner/builder/critic/fixer tool
// loops (runJob), roughly 1-2M tokens a film.
const PIPELINE = process.env.PIPELINE === 'agents' ? 'agents' : 'plan-build';
const SKILLS_DIR = config.skillsDir;

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SERVER_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || process.env.API_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Google OAuth 2.0 (real sign-in: auth-code exchange + ID token verification)
// ---------------------------------------------------------------------------
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REDIRECT_URI = (process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_BASE_URL}/api/google/callback`).trim();
const googleClient =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
    : null;
if (!googleClient) {
  console.warn(
    '[server] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google sign-in will use the local dev stub (no real Google verification).'
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Persistent JSON Store (Users, Sessions, Keys, Prompt Mappings, Brand Kits)
// ---------------------------------------------------------------------------

function defaultUser(overrides = {}) {
  const now = new Date().toISOString();
  const nextMonth = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const id = overrides.id || `usr_${crypto.randomBytes(4).toString('hex')}`;
  const email = (overrides.email || 'creator@byreel.io').toLowerCase().trim();
  const displayName = overrides.name || overrides.displayName || 'Pradum Singh';
  const parts = displayName.trim().split(/\s+/);
  const firstName = parts[0] || 'Pradum';
  const lastName = parts.slice(1).join(' ') || 'Singh';
  const tier = overrides.tier || 'pro';
  const billingInterval = overrides.billingInterval || 'annual';

  const tierLimits = {
    free: { generations: 10, renders: 5, apiCalls: 100, storage: 1024 * 1024 * 1024 },
    creator: { generations: 150, renders: 40, apiCalls: 5000, storage: 10 * 1024 * 1024 * 1024 },
    pro: { generations: 600, renders: 100, apiCalls: 50000, storage: 50 * 1024 * 1024 * 1024 },
    enterprise: { generations: 999999, renders: 999999, apiCalls: 999999, storage: 500 * 1024 * 1024 * 1024 },
  }[tier] || { generations: 600, renders: 100, apiCalls: 50000, storage: 50 * 1024 * 1024 * 1024 };

  return {
    id,
    email,
    username: email.split('@')[0] || 'creator',
    passwordHash: overrides.passwordHash || hashPassword(overrides.password || 'Password123!'),
    profile: {
      displayName,
      firstName,
      lastName,
      avatarUrl: overrides.avatarUrl || '/dashboard/user-avatar.jpg',
      company: overrides.company || 'Byreel Motion Studio',
      bio: overrides.bio || 'Lead Creative Director',
      locale: 'en',
      timezone: 'UTC',
    },
    auth: {
      provider: overrides.provider || 'email',
      emailVerified: true,
      role: 'user',
      status: 'active',
      permissions: ['generate', 'render', 'export'],
    },
    plan: {
      tier,
      status: 'active',
      billingInterval,
      startedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: nextMonth,
      features:
        tier === 'pro'
          ? ['600 AI Motion Generations / month', '4K Lossless 60FPS MP4 & ProRes', 'Brand Kit custom fonts & colors']
          : ['150 AI Motion Generations / month', '1080p 60FPS MP4 Export', 'Standard SVG Typography'],
    },
    usage: {
      generations: { daily: 2, monthly: 14, lifetime: 42, limit: tierLimits.generations },
      renders: { daily: 1, monthly: 6, lifetime: 18, limit: tierLimits.renders },
      apiCalls: { daily: 12, monthly: 240, lifetime: 1240, limit: tierLimits.apiCalls },
      storage: { usedBytes: 38 * 1024 * 1024, limitBytes: tierLimits.storage },
      lastResetAt: now,
      nextResetAt: nextMonth,
    },
    preferences: {
      renderCompletionAlerts: true,
      hardwareAcceleration: true,
      productUpdates: false,
    },
    createdAt: now,
    lastLoginAt: now,
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'byreel-studio-jwt-secret-secure-key';

function hashPassword(pw, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(pw, storedHash) {
  if (!storedHash || !pw) return false;
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHash] = parts;
    try {
      const actualHash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
    } catch {
      return false;
    }
  }
  // Backward compatibility with legacy sha256 hash
  try {
    const legacy = crypto.createHash('sha256').update(`byreel_salt_${pw}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(legacy, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function createToken(userId) {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: Date.now(), exp: Date.now() + 14 * 24 * 3600 * 1000 })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, payload, sig] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    const legacySig = crypto.createHmac('sha256', 'byreel-studio-local-secret').update(payload).digest('base64url');

    const matchesCurrent = sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    const matchesLegacy = sig.length === legacySig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(legacySig));
    if (!matchesCurrent && !matchesLegacy) return null;

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (decoded.exp && Date.now() > decoded.exp) return null;
    return decoded;
  } catch {
    return null;
  }
}

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('[server] Failed to parse db.json, initializing fresh store:', err.message);
  }
  const seedUser = defaultUser({
    id: 'usr_94829104',
    email: 'creator@byreel.io',
    name: 'Pradum Singh',
    tier: 'pro',
  });
  const initial = {
    users: [seedUser],
    sessions: {},
    apiKeys: [
      {
        id: 'key_88f9104',
        userId: seedUser.id,
        name: 'Production CLI Render Key',
        prefix: 'byreel_live_sk_89f0',
        environment: 'production',
        scopes: ['render', 'prompt:read', 'prompt:write'],
        rateLimitPerMinute: 60,
        status: 'active',
        createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        lastUsedAt: new Date(Date.now() - 3600000).toISOString(),
        expiresAt: null,
      },
    ],
    promptMap: {}, // promptId -> PromptJob record
    conversations: [],
    brandKits: {},
    assets: {},
  };
  saveDb(initial);
  return initial;
}

function saveDb(data = db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[server] Failed to write db.json:', err.message);
  }
}

const db = loadDb();

function sanitizeUser(u) {
  if (!u) return null;
  const copy = { ...u };
  delete copy.passwordHash;
  return copy;
}

/** Find the user this verified Google identity belongs to, or provision one. Never trusts a client-supplied id. */
function upsertGoogleUser({ googleId, email, name, picture, plan }) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  let user = db.users.find((u) => u.googleId === googleId) || db.users.find((u) => u.email === normalizedEmail);

  if (user) {
    user.googleId = user.googleId || googleId;
    user.auth.provider = user.auth.provider === 'email' ? 'email+google' : 'google';
    user.lastLoginAt = new Date().toISOString();
    if (picture && (!user.profile.avatarUrl || user.profile.avatarUrl.startsWith('/dashboard/'))) {
      user.profile.avatarUrl = picture;
    }
  } else {
    user = defaultUser({
      email: normalizedEmail,
      name: name || normalizedEmail.split('@')[0],
      tier: ['free', 'creator', 'pro', 'enterprise'].includes(plan) ? plan : 'free',
      provider: 'google',
    });
    user.googleId = googleId;
    if (picture) user.profile.avatarUrl = picture;
    db.users.push(user);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Harness Job Indexing & Live Orchestration State
// ---------------------------------------------------------------------------

// In-memory map of promptId -> job state (persisted to db.promptMap)
const jobsByPromptId = new Map();
const jobsByHarnessId = new Map();
const activeAbortControllers = new Map();
const jobQueue = [];
let activeJobCount = 0;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);

function readJsonSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // ignore malformed json
  }
  return null;
}

function aggregateUsageTokens(usageObj) {
  if (!usageObj || typeof usageObj !== 'object') return null;
  let input = 0;
  let output = 0;
  for (const role of Object.values(usageObj)) {
    if (role && typeof role === 'object') {
      input += Number(role.input || 0);
      output += Number(role.output || 0);
    }
  }
  if (input === 0 && output === 0) return null;
  return {
    total: input + output,
    input,
    cachedInput: 0,
    output,
  };
}

function mapHarnessStageToFrontend(harnessStage) {
  switch (harnessStage) {
    case 'init':
      return 'designing';
    case 'planned':
    case 'planned-only':
      return 'planning';
    case 'installed':
      return 'audio';
    case 'built':
    case 'building':
      return 'building';
    case 'reviewed':
      return 'reviewing';
    case 'rendered':
      return 'rendering';
    case 'done':
      return 'done';
    default:
      return 'preparing';
  }
}

function findJobSnapshotPath(jobDir) {
  const snapRoot = path.join(jobDir, 'project', '.hyperframes', 'artifacts', 'snapshots');
  if (!fs.existsSync(snapRoot)) return null;
  try {
    const dirs = fs.readdirSync(snapRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs.reverse()) {
      const sheet = path.join(snapRoot, d.name, 'contact-sheet.jpg');
      if (fs.existsSync(sheet)) return sheet;
    }
  } catch {
    // ignore
  }
  return null;
}

function buildVideoUrl(harnessJobId) {
  return `${PUBLIC_BASE_URL}/api/videos/${encodeURIComponent(harnessJobId)}/final.mp4`;
}

function buildThumbnailUrl(harnessJobId) {
  return `${PUBLIC_BASE_URL}/api/videos/${encodeURIComponent(harnessJobId)}/thumbnail.jpg`;
}

function syncDiskJobs() {
  if (!fs.existsSync(JOBS_DIR)) return;
  const entries = fs.readdirSync(JOBS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());

  for (const ent of entries) {
    const harnessJobId = ent.name;
    const jobDir = path.join(JOBS_DIR, harnessJobId);
    const hDir = path.join(jobDir, 'harness');
    const request = readJsonSafe(path.join(hDir, 'request.json'));
    const state = readJsonSafe(path.join(hDir, 'state.json'));
    const result = readJsonSafe(path.join(hDir, 'result.json'));
    const plan = readJsonSafe(path.join(hDir, 'plan.json')) || readJsonSafe(path.join(jobDir, 'project', 'plan.json'));
    const usage = readJsonSafe(path.join(hDir, 'usage.json')) || result?.usage;
    const videoFile = path.join(jobDir, 'project', 'renders', 'final.mp4');
    const hasVideo = fs.existsSync(videoFile) && fs.statSync(videoFile).size > 1000;

    if (!request && !state && !result) continue;

    // Determine status
    let status = 'failed';
    if (hasVideo || result?.verify?.ok || state?.stage === 'done') {
      status = hasVideo ? 'done' : 'failed';
    } else if (state?.stage === 'planned-only' && request?.mode !== 'plan-build') {
      status = 'done';
    }

    const promptId = request?.promptId || `job-${harnessJobId}`;
    const themeName =
      plan?.theme?.name ||
      request?.options?.theme ||
      null;
    const durationS =
      result?.duration ||
      plan?.format?.duration ||
      request?.options?.duration ||
      15;

    const existing = jobsByHarnessId.get(harnessJobId) || db.promptMap?.[promptId];
    if (existing && (existing.status === 'running' || existing.status === 'queued')) {
      continue; // Don't overwrite an actively running in-memory job
    }

    const record = {
      id: existing?.id || `job_${harnessJobId}`,
      promptId,
      status,
      harnessJobId,
      stage: status === 'done' ? 'done' : mapHarnessStageToFrontend(state?.stage),
      activity:
        status === 'done'
          ? 'Render complete'
          : state?.error
          ? `Stopped at ${state.stage || 'init'}`
          : null,
      theme: themeName,
      title: result?.title || plan?.title || (request?.prompt ? request.prompt.slice(0, 48) : harnessJobId),
      prompt: request?.prompt || '',
      ratio:
        plan?.format?.width && plan?.format?.height
          ? plan.format.width === plan.format.height
            ? '1:1'
            : plan.format.height > plan.format.width
            ? '9:16'
            : '16:9'
          : request?.options?.aspect || '16:9',
      play: hasVideo ? [buildVideoUrl(harnessJobId)] : [],
      durationS,
      error: status === 'failed' ? state?.error || 'Job did not finish rendering final.mp4' : null,
      tokens: aggregateUsageTokens(usage),
      canRetry: status === 'failed',
      createdAt: request?.createdAt || new Date(fs.statSync(jobDir).birthtimeMs || Date.now()).toISOString(),
      updatedAt: state?.updatedAt || new Date(fs.statSync(jobDir).mtimeMs || Date.now()).toISOString(),
    };

    jobsByPromptId.set(promptId, record);
    jobsByPromptId.set(harnessJobId, record);
    jobsByHarnessId.set(harnessJobId, record);
  }

  // Also restore any saved promptId mappings from db.promptMap
  if (db.promptMap && typeof db.promptMap === 'object') {
    for (const [pId, savedJob] of Object.entries(db.promptMap)) {
      if (!savedJob || typeof savedJob !== 'object') continue;
      if (savedJob.harnessJobId && jobsByHarnessId.has(savedJob.harnessJobId)) {
        const diskJob = jobsByHarnessId.get(savedJob.harnessJobId);
        const merged = { ...diskJob, id: savedJob.id || diskJob.id, promptId: pId };
        jobsByPromptId.set(pId, merged);
      } else {
        // If server restarted while job was running, mark it failed + retryable
        if (savedJob.status === 'running' || savedJob.status === 'queued') {
          savedJob.status = 'failed';
          savedJob.error = 'Server restarted while job was in progress. Click retry to resume.';
          savedJob.canRetry = Boolean(savedJob.harnessJobId);
        }
        jobsByPromptId.set(pId, savedJob);
      }
    }
  }
}

syncDiskJobs();

function persistJobRecord(job) {
  if (!job || !job.promptId) return;
  jobsByPromptId.set(job.promptId, job);
  if (job.harnessJobId) {
    jobsByHarnessId.set(job.harnessJobId, job);
    jobsByPromptId.set(job.harnessJobId, job);
  }
  db.promptMap = db.promptMap || {};
  db.promptMap[job.promptId] = job;
  saveDb();
}

function resolveThemeFromJob(themeFromId) {
  if (!themeFromId) return undefined;
  const ref = jobsByHarnessId.get(themeFromId) || jobsByPromptId.get(themeFromId);
  if (ref?.theme && ref.theme !== 'custom' && !ref.theme.endsWith('-custom')) {
    return ref.theme;
  }
  const jobDir = path.join(JOBS_DIR, ref?.harnessJobId || themeFromId);
  const plan = readJsonSafe(path.join(jobDir, 'harness', 'plan.json')) || readJsonSafe(path.join(jobDir, 'project', 'plan.json'));
  const name = plan?.theme?.name;
  if (name && name !== 'custom' && !name.endsWith('-custom')) return name;
  return undefined;
}

const MAX_LOG_LINES = 500;

function pushLog(job, line) {
  if (!job.logs) job.logs = [];
  job.logs.push({ ts: new Date().toISOString(), line });
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
}

function formatLogLine(ev) {
  const role = ev.role ? `[${ev.role}] ` : '';
  switch (ev.type) {
    case 'job_start':
      return `Job started${ev.resume ? ' (resumed)' : ''}: ${ev.job}`;
    case 'stage':
      return `Stage -> ${ev.stage}${ev.theme ? ` theme=${ev.theme}` : ''}${ev.title ? ` title="${ev.title}"` : ''}${
        ev.scenes ? ` scenes=${ev.scenes}` : ''
      }${ev.ok === false ? ` major=${ev.major || 0} minor=${ev.minor || 0}` : ''}`;
    case 'agent_start':
      return `${role}agent started${ev.model ? ` model=${ev.model}` : ''}`;
    case 'tool': {
      const args = ev.args && typeof ev.args === 'object' ? ` ${JSON.stringify(ev.args).slice(0, 220)}` : '';
      return `${role}tool: ${ev.name || 'unknown'}${args}`;
    }
    case 'registry_install':
      return `Installed registry block: ${ev.name}`;
    case 'turn':
      return `${role}turn: +${ev.input || 0} in / +${ev.output || 0} out tokens`;
    case 'render_start':
      return `Render started (${ev.quality || 'looks'} quality)`;
    case 'render_done':
      return `Render ${ev.ok ? 'finished' : 'FAILED'}`;
    case 'step':
      return `Step -> ${ev.step}${ev.provider ? ` (${ev.provider})` : ''}`;
    case 'repair':
      return `Repair ${ev.step}: ${(ev.errors || []).join(' | ').slice(0, 300)}`;
    case 'plan':
      return `Plan ready: ${ev.plan?.scenes?.length || 0} scenes, ${ev.usage?.calls || 0} calls`;
    case 'dedupe':
      return `One copy of each line: ${(ev.moved || []).join('; ')}`;
    case 'palette':
      return `Palette from the ${ev.source}: ${Object.entries(ev.colors || {}).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    case 'story':
      return ev.skipped
        ? `Story: skipped (${ev.skipped})`
        : `Story: built "${ev.story?.storylines?.[ev.story.pick]?.name}" — others: ${(ev.story?.storylines || []).filter((_, i) => i !== ev.story.pick).map((x) => x.name).join(', ')}`;
    case 'plan_warnings':
      return `Plan warnings: ${(ev.problems || []).join(' | ').slice(0, 300)}`;
    case 'call':
      return `model: ${ev.label} (+${ev.input || 0} in / +${ev.output || 0} out tokens)`;
    case 'scene':
      return `scene ${ev.id}: ${ev.step}${ev.problems ? ` — ${[].concat(ev.problems).join(' | ').slice(0, 220)}` : ''}`;
    case 'check':
      return `check ${ev.round ?? ''}: ${ev.errors ?? 0} errors, ${ev.warnings ?? 0} warnings`;
    case 'measured':
      return (ev.issues || []).length ? `measured: ${ev.issues.map((i) => `${i.id}: ${i.problem}`).join(' | ').slice(0, 300)}` : 'measured checks pass';
    case 'error':
      return `${ev.label || 'error'}: ${ev.error || ''}`;
    case 'job_done':
      return `Job done in ${ev.duration || '?'}s`;
    case 'job_failed':
      return `Job FAILED: ${ev.error || 'unknown error'}`;
    default:
      return `${role}${ev.type}`;
  }
}

function createHarnessEventHandler(job) {
  const liveTokens = {
    input: job.tokens?.input || 0,
    output: job.tokens?.output || 0,
  };

  return (ev) => {
    if (!ev || typeof ev !== 'object') return;
    pushLog(job, formatLogLine(ev));

    switch (ev.type) {
      case 'job_start': {
        job.harnessJobId = ev.job;
        job.status = 'running';
        job.stage = 'preparing';
        job.activity = ev.resume ? `Resuming job ${ev.job}...` : 'Initializing HyperFrames workspace...';
        // Write promptId into harness/request.json if present so disk scans remember it
        try {
          const reqPath = path.join(ev.dir, 'harness', 'request.json');
          if (fs.existsSync(reqPath)) {
            const reqData = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
            reqData.promptId = job.promptId;
            fs.writeFileSync(reqPath, JSON.stringify(reqData, null, 2));
          }
        } catch {
          // ignore
        }
        break;
      }

      case 'stage': {
        if (ev.stage === 'init') {
          job.stage = 'designing';
          job.activity = 'Choosing visual style, palette & typography...';
        } else if (ev.stage === 'planned') {
          job.stage = 'audio';
          if (ev.theme) job.theme = ev.theme;
          if (ev.title) job.title = ev.title;
          job.activity = `Storyboard locked (${ev.scenes || 0} scenes). Installing blocks & audio...`;
        } else if (ev.stage === 'installed') {
          job.stage = 'building';
          job.activity = 'Registry blocks installed. Preparing scene builder...';
        } else if (ev.stage === 'built') {
          job.stage = 'checking';
          job.activity = 'Scenes built. Running quality & layout checks...';
        } else if (ev.stage === 'reviewed') {
          job.stage = 'reviewing';
          job.activity = ev.ok ? 'Visual review passed!' : `Refining scenes (${ev.major || 0} major, ${ev.minor || 0} minor items)...`;
        } else if (ev.stage === 'rendered') {
          job.stage = 'rendering';
          job.activity = 'Verifying rendered MP4 master...';
        } else if (ev.stage === 'done') {
          job.stage = 'done';
          job.activity = 'Render complete';
        }
        break;
      }

      case 'agent_start': {
        const modelTag = ev.model ? ` (${ev.model})` : '';
        if (ev.role === 'planner') {
          job.stage = 'planning';
          job.activity = `Planner${modelTag} drafting storyboard & beat sheet...`;
        } else if (ev.role === 'builder') {
          job.stage = 'building';
          job.activity = `Builder${modelTag} coding HTML/CSS/GSAP compositions...`;
        } else if (ev.role === 'critic') {
          job.stage = 'reviewing';
          job.activity = `Critic${modelTag} inspecting rendered frame contact sheets...`;
        } else if (ev.role === 'fixer') {
          job.stage = 'reviewing';
          job.activity = `Fixer${modelTag} polishing motion seams & lint checks...`;
        }
        break;
      }

      case 'agent_text': {
        const snippet = (ev.text || '').replace(/\s+/g, ' ').trim();
        if (snippet) {
          job.thought = snippet.slice(0, 320);
          job.activity = `[${ev.role}] ${snippet.slice(0, 95)}...`;
        }
        break;
      }

      case 'tool': {
        const name = ev.name || '';
        if (ev.role === 'planner') {
          if (name === 'list_themes') {
            job.stage = 'designing';
            job.activity = 'Evaluating curated typography & color themes...';
          } else if (name === 'registry_search' || name === 'registry_inspect') {
            job.stage = 'planning';
            const q = ev.args?.query || (Array.isArray(ev.args?.names) ? ev.args.names.join(', ') : '');
            job.activity = q ? `Searching motion registry: ${q.slice(0, 48)}...` : 'Inspecting motion blocks...';
          } else if (name === 'read_skill' || name === 'skill_outline') {
            job.stage = 'planning';
            job.activity = 'Reading HyperFrames story & layout guidelines...';
          }
        } else if (ev.role === 'builder') {
          if (name === 'media_search' || name === 'media_use') {
            job.stage = 'audio';
            job.activity = 'Selecting & syncing sound / media assets...';
          } else if (name === 'write_file' || name === 'edit_file') {
            job.stage = 'building';
            const target = ev.args?.path ? path.basename(ev.args.path) : 'composition';
            job.activity = `Authoring scene composition: ${target}...`;
          } else if (name === 'check') {
            job.stage = 'checking';
            job.activity = 'Running HyperFrames deterministic lint & layout audit...';
          } else if (name === 'snapshot') {
            job.stage = 'checking';
            job.activity = 'Capturing frame snapshots across beat transitions...';
          }
        } else if (ev.role === 'fixer') {
          if (name === 'edit_file' || name === 'write_file') {
            job.stage = 'reviewing';
            const target = ev.args?.path ? path.basename(ev.args.path) : 'scene';
            job.activity = `Applying polish fix to ${target}...`;
          } else if (name === 'check') {
            job.stage = 'checking';
            job.activity = 'Re-verifying lint, layout & contrast checks...';
          }
        }
        break;
      }

      case 'registry_install': {
        job.stage = 'audio';
        job.activity = `Installed registry motion block: ${ev.name}`;
        break;
      }

      // plan-build pipeline: the plan reports its usage once; each build call reports its own.
      case 'step': {
        const s = {
          understand: ['designing', 'Reading the brief: copy, timing, look...'],
          story: ['designing', 'Writing three storylines and picking one...'],
          palette: ['designing', 'Building the colour palette...'],
          shortlist: ['planning', 'Shortlisting registry blocks for each beat...'],
          plan: ['planning', 'Planning scenes, theme & SPEC...'],
          assemble: ['building', 'Assembling project: theme, fonts, blocks, timeline...'],
          'write scenes': ['building', 'Writing hand-built scenes...'],
          'verify film': ['checking', 'Running HyperFrames checks & measured frame checks...'],
          look: ['reviewing', 'Reviewing frames for visible defects...'],
          render: ['rendering', 'Rendering final MP4...'],
        }[ev.step];
        if (s) [job.stage, job.activity] = s;
        break;
      }

      case 'plan': {
        if (ev.plan?.title) job.title = ev.plan.title;
        const th = ev.plan?.theme;
        if (th) job.theme = th.preset || th.name || job.theme;
        job.activity = `Storyboard locked (${ev.plan?.scenes?.length || 0} scenes).`;
      }
      // falls through: count the plan's tokens
      case 'call':
      case 'turn': {
        const u = ev.type === 'plan' ? ev.usage || {} : ev;
        if (ev.type === 'call') job.activity = `Model: ${ev.label}...`;
        if (u.input || u.output) {
          liveTokens.input += Number(u.input || 0);
          liveTokens.output += Number(u.output || 0);
          job.tokens = {
            total: liveTokens.input + liveTokens.output,
            input: liveTokens.input,
            cachedInput: 0,
            output: liveTokens.output,
          };
        }
        break;
      }

      case 'render_start': {
        job.stage = 'rendering';
        job.activity = `Rendering final MP4 video (${ev.quality || 'looks'} quality)...`;
        break;
      }

      case 'render_done': {
        job.stage = 'rendering';
        job.activity = ev.ok ? 'MP4 encoding finished. Verifying output...' : 'Render command exited with errors.';
        break;
      }

      case 'job_done': {
        job.status = 'done';
        job.stage = 'done';
        job.activity = 'Video ready';
        job.durationS = ev.duration || job.durationS || 15;
        if (job.harnessJobId) {
          job.play = [buildVideoUrl(job.harnessJobId)];
        }
        job.error = null;
        job.canRetry = false;
        break;
      }

      case 'job_failed': {
        job.status = 'failed';
        job.error = ev.error || 'Harness job failed';
        job.activity = null;
        job.canRetry = Boolean(job.harnessJobId);
        break;
      }
    }

    job.updatedAt = new Date().toISOString();
    persistJobRecord(job);
  };
}

function enqueueHarnessExecution(task) {
  jobQueue.push(task);
  drainQueue();
}

async function drainQueue() {
  if (activeJobCount >= MAX_CONCURRENT_JOBS) return;
  const next = jobQueue.shift();
  if (!next) return;

  activeJobCount += 1;
  const { job, mode, options, resumeDir } = next;
  const controller = new AbortController();
  activeAbortControllers.set(job.promptId, controller);

  try {
    job.status = 'running';
    job.stage = mode === 'resume' ? 'preparing' : 'designing';
    job.activity = mode === 'resume' ? 'Resuming interrupted job...' : 'Starting multi-agent motion compiler...';
    job.error = null;
    pushLog(job, job.activity);
    persistJobRecord(job);

    // Apply per-job provider, model, and reasoning effort
    if (job.provider && config.providers[job.provider]) {
      try {
        useProvider(job.provider);
        if (job.model) {
          config.providers[job.provider].model = job.model;
        }
        if (job.effort) {
          config.providers[job.provider].effort = job.effort;
          config.roles.planner = job.provider;
          config.roles.builder = job.provider;
          config.roles.critic = job.provider;
          config.roles.fixer = job.provider;
        }
      } catch (err) {
        console.warn(`[server] Warning: Could not configure provider ${job.provider}: ${err.message}`);
      }
    }

    const onEvent = createHarnessEventHandler(job);
    // A resumed job keeps the pipeline it started with.
    const resumedMode = mode === 'resume' ? readJsonSafe(path.join(resumeDir, 'harness', 'request.json'))?.mode : null;
    const usePlanBuild = mode === 'resume' ? resumedMode === 'plan-build' : PIPELINE === 'plan-build';
    pushLog(job, `Pipeline: ${usePlanBuild ? 'plan + build' : 'agents'}`);
    const result = await (usePlanBuild ? runFilm : runJob)({
      prompt: mode === 'resume' ? undefined : job.prompt,
      options: mode === 'resume' ? {} : options,
      resume: mode === 'resume' ? resumeDir : undefined,
      jobsDir: JOBS_DIR,
      onEvent,
      signal: controller.signal,
    });

    if (result?.job) {
      job.harnessJobId = result.job;
    }
    if (result?.title) {
      job.title = result.title;
    }
    if (result?.duration) {
      job.durationS = result.duration;
    }
    if (result?.usage) {
      job.tokens = aggregateUsageTokens(result.usage) || job.tokens;
    }

    job.status = 'done';
    job.stage = 'done';
    job.activity = 'Video ready';
    job.play = job.harnessJobId ? [buildVideoUrl(job.harnessJobId)] : [];
    job.error = null;
    job.canRetry = false;
    job.updatedAt = new Date().toISOString();
    pushLog(job, 'Video ready');
    persistJobRecord(job);
  } catch (err) {
    console.error(`[server] Harness job failed for promptId=${job.promptId}:`, err?.message || err);
    job.status = 'failed';
    job.error = String(err?.message || err || 'Generation failed');
    job.activity = null;
    job.canRetry = Boolean(job.harnessJobId);
    job.updatedAt = new Date().toISOString();
    pushLog(job, `FAILED: ${job.error}`);
    persistJobRecord(job);
  } finally {
    activeAbortControllers.delete(job.promptId);
    activeJobCount -= 1;
    drainQueue();
  }
}

// ---------------------------------------------------------------------------
// HTTP Helpers (CORS, Cookies, JSON Body Parser, Auth Resolution)
// ---------------------------------------------------------------------------

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || 'http://localhost:3000';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, Range, Accept'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
}

function sendJson(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(req, res, statusCode, message, errorCode = 'BAD_REQUEST', errors = undefined) {
  sendJson(req, res, statusCode, {
    success: false,
    message,
    error: errorCode,
    ...(errors ? { errors } : {}),
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      out[k] = v;
    }
  }
  return out;
}

function setAuthCookies(res, token) {
  const maxAge = 60 * 60 * 24 * 7;
  res.setHeader('Set-Cookie', [
    `token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    `animagent_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [
    'token=; Path=/; Max-Age=0; SameSite=Lax',
    'animagent_token=; Path=/; Max-Age=0; SameSite=Lax',
  ]);
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const cookies = parseCookies(req);
  const token = bearer || cookies.token || cookies.animagent_token || null;

  if (token) {
    // 1. Check if token was explicitly revoked
    if (db.revokedTokens?.[token]) {
      return null;
    }
    // 2. Explicit active session mapping in db.sessions
    const userId = db.sessions?.[token];
    if (userId) {
      const found = db.users.find((u) => u.id === userId);
      if (found) return found;
    }
    // 3. Cryptographic JWT payload check
    const decoded = verifyToken(token);
    if (decoded?.sub) {
      const found = db.users.find((u) => u.id === decoded.sub || u.email === decoded.sub);
      if (found) {
        db.sessions = db.sessions || {};
        db.sessions[token] = found.id;
        return found;
      }
    }
  }

  // 4. API key header (x-api-key)
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader) {
    const keyRec = db.apiKeys.find((k) => k.status === 'active' && apiKeyHeader.startsWith(k.prefix));
    if (keyRec) {
      keyRec.lastUsedAt = new Date().toISOString();
      saveDb();
      return db.users.find((u) => u.id === keyRec.userId) || null;
    }
  }

  return null;
}

function readBody(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ _raw: raw });
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Video Streaming with HTTP Range Support (206 Partial Content)
// ---------------------------------------------------------------------------

function streamVideoFile(req, res, filePath, downloadName = null) {
  setCorsHeaders(req, res);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (!fs.existsSync(filePath)) {
    return sendError(req, res, 404, 'Rendered video file not found', 'VIDEO_NOT_FOUND');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const extraHeaders = {
    'Accept-Ranges': 'bytes',
    'Content-Type': 'video/mp4',
    ...(downloadName
      ? { 'Content-Disposition': `attachment; filename="${downloadName}"` }
      : {}),
  };

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start >= fileSize || end >= fileSize) {
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
      });
      return res.end();
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      ...extraHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      ...extraHeaders,
      'Content-Length': fileSize,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  }
}

// ---------------------------------------------------------------------------
// Procedural SVG Glyph Generator for /api/motion/char-conversion
// ---------------------------------------------------------------------------

function buildGlyphsForText(text, fontSize = 120, effect = 'kinetic_split', physics = {}) {
  const clean = String(text || 'MOTION STUDIO').slice(0, 80);
  const tension = Number(physics?.tension || 180);
  const damping = Number(physics?.damping || 12);
  const glyphs = Array.from(clean).map((char, idx) => {
    const width = char === ' ' ? Math.round(fontSize * 0.32) : Math.round(fontSize * 0.62);
    const height = fontSize;
    const delay = Number((idx * 0.04).toFixed(3));
    const settle = Number((delay + Math.max(0.35, (220 - Math.min(200, tension)) / 240)).toFixed(3));
    const overshoot = Number((1 + Math.max(0.02, (20 - Math.min(19, damping)) * 0.008)).toFixed(3));
    return {
      char,
      svgPath: `M 8 ${height - 12} L ${Math.round(width / 2)} 12 L ${width - 8} ${height - 12} Z`,
      width,
      height,
      effect,
      keyframes: [
        { time: delay, x: 0, y: 42, scale: 0.78, opacity: 0, rotation: -6 },
        { time: Number(((delay + settle) / 2).toFixed(3)), x: 0, y: -4, scale: overshoot, opacity: 1, rotation: 1.5 },
        { time: settle, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
      ],
    };
  });

  return {
    id: `glyph_${crypto.randomBytes(4).toString('hex')}`,
    text: clean,
    glyphs,
    totalDurationMs: Math.max(1800, glyphs.length * 65 + 900),
  };
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCorsHeaders(req, res);
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();

    // =========================================================================
    // 1. HEALTH & HARNESS STATUS ENDPOINTS
    // =========================================================================
    if ((pathname === '/' || pathname === '/health' || pathname === '/api/health') && method === 'GET') {
      syncDiskJobs();
      let activeModels = {};
      for (const role of ['planner', 'builder', 'critic', 'fixer']) {
        try {
          const p = providerForRole(role);
          activeModels[role] = { provider: p.name, model: p.model };
        } catch {
          activeModels[role] = { provider: config.roles?.[role] || 'unconfigured', model: null };
        }
      }
      return sendJson(req, res, 200, {
        success: true,
        status: 'ok',
        service: 'byreel-motion-studio-backend',
        port: PORT,
        jobsDir: JOBS_DIR,
        skillsDir: SKILLS_DIR,
        activeJobCount,
        queuedJobCount: jobQueue.length,
        totalIndexedJobs: jobsByHarnessId.size,
        providers: providerStatus(),
        models: activeModels,
      });
    }

    if ((pathname === '/api/providers' || pathname === '/api/models') && method === 'GET') {
      const statusList = providerStatus();
      const catalog = [
        {
          provider: 'azure',
          name: 'Azure AI',
          ready: statusList.find((p) => p.name === 'azure')?.ready ?? false,
          models: [
            { id: 'gpt-5-mini', name: 'GPT-5 Mini', tag: 'Serverless MaaS', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'max'], description: 'Fast concise reasoning & swift logic' },
            { id: 'qwen--qwen38-27b', name: 'Qwen 3.8 27B', tag: 'A100 GPU · vLLM', defaultEffort: 'xhigh', efforts: ['low', 'medium', 'high', 'xhigh'], description: 'Max reasoning with deep visual & motion planning on 2x A100' },
            { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', tag: 'Serverless MaaS', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'max'], description: 'Fast code generation and animation scripting' }
          ]
        },
        {
          provider: 'glm',
          name: 'Zhipu GLM',
          ready: statusList.find((p) => p.name === 'glm')?.ready ?? false,
          models: [
            { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', tag: 'Ultra Fast', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'High speed Chinese/English multimodal reasoning' },
            { id: 'glm-4.6', name: 'GLM 4.6', tag: 'Standard', defaultEffort: 'low', efforts: ['low', 'medium'], description: 'Standard GLM model' }
          ]
        },
        {
          provider: 'claude',
          name: 'Anthropic Claude',
          ready: statusList.find((p) => p.name === 'claude')?.ready ?? false,
          models: [
            { id: 'claude-sonnet-5-5', name: 'Claude 3.5 Sonnet', tag: 'Top Tier Visuals', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'State of the art layout, typography & canvas aesthetics' }
          ]
        },
        {
          provider: 'openai',
          name: 'OpenAI GPT',
          ready: statusList.find((p) => p.name === 'openai')?.ready ?? false,
          models: [
            { id: 'gpt-5-mini', name: 'GPT-5 Mini', tag: 'Reasoning', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Fast concise reasoning' },
            { id: 'gpt-4o', name: 'GPT-4o', tag: 'Omni', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Multimodal flagship' }
          ]
        },
        {
          provider: 'gemini',
          name: 'Google Gemini',
          ready: statusList.find((p) => p.name === 'gemini')?.ready ?? false,
          models: [
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tag: 'Multimodal', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Long context fast prototyping' }
          ]
        }
      ];

      return sendJson(req, res, 200, {
        success: true,
        current: {
          provider: config.roles.builder || 'azure',
          model: config.providers[config.roles.builder || 'azure']?.model || 'qwen--qwen38-27b',
          effort: config.providers[config.roles.builder || 'azure']?.effort || 'xhigh',
        },
        providers: statusList,
        catalog,
      });
    }

    // Named colour palettes for the app's picker (send its id as "palette" with a prompt).
    if (pathname === '/api/palettes' && method === 'GET') {
      return sendJson(req, res, 200, { success: true, palettes: PALETTES });
    }

    if (pathname === '/api/themes' && method === 'GET') {
      return sendJson(req, res, 200, {
        success: true,
        themes: listThemes(),
      });
    }

    // =========================================================================
    // 2. AUTHENTICATION & USER SESSION ENDPOINTS
    // =========================================================================
    if (pathname === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').toLowerCase().trim();
      const password = String(body.password || '');

      if (!email || !password) {
        return sendError(req, res, 400, 'Email and password are required.', 'VALIDATION_ERROR');
      }

      const user = db.users.find((u) => u.email === email);
      if (!user) {
        return sendError(req, res, 401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
      }

      // Check if account was created via Google and has no password configured
      if (!user.passwordHash) {
        if (user.auth?.provider === 'google' || user.googleId) {
          return sendError(
            req,
            res,
            400,
            'This account was registered using Google Sign-In. Please sign in with Google.',
            'USE_GOOGLE_AUTH'
          );
        }
      }

      if (!verifyPassword(password, user.passwordHash)) {
        return sendError(req, res, 401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
      }

      // Upgrade legacy password hash to modern scrypt hash seamlessly
      if (user.passwordHash && !user.passwordHash.startsWith('scrypt:')) {
        user.passwordHash = hashPassword(password);
      }

      user.lastLoginAt = new Date().toISOString();
      const token = createToken(user.id);
      db.sessions[token] = user.id;
      saveDb();

      setAuthCookies(res, token);
      return sendJson(req, res, 200, {
        success: true,
        message: 'Signed in successfully',
        token,
        user: sanitizeUser(user),
      });
    }

    if (pathname === '/api/register' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').toLowerCase().trim();
      const password = String(body.password || '');
      const name = String(body.name || email.split('@')[0] || 'Studio Creator').trim();
      const plan = String(body.plan || 'pro').toLowerCase();

      if (!email || !password || !name) {
        return sendError(req, res, 400, 'Name, email, and password are required.', 'VALIDATION_ERROR');
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(req, res, 400, 'Please enter a valid email address.', 'INVALID_EMAIL');
      }

      if (password.length < 8) {
        return sendError(req, res, 400, 'Password must be at least 8 characters long.', 'WEAK_PASSWORD');
      }

      const existing = db.users.find((u) => u.email === email);
      if (existing) {
        if (existing.googleId && !existing.passwordHash) {
          return sendError(
            req,
            res,
            409,
            'An account with this email is already registered via Google. Please sign in with Google.',
            'ACCOUNT_EXISTS_GOOGLE'
          );
        }
        return sendError(
          req,
          res,
          409,
          'An account with this email address already exists. Please sign in.',
          'EMAIL_ALREADY_EXISTS'
        );
      }

      const user = defaultUser({
        email,
        name,
        password,
        tier: ['free', 'creator', 'pro', 'enterprise'].includes(plan) ? plan : 'pro',
        provider: 'email',
      });
      user.passwordHash = hashPassword(password);
      db.users.push(user);

      const token = createToken(user.id);
      db.sessions[token] = user.id;
      saveDb();

      setAuthCookies(res, token);
      return sendJson(req, res, 201, {
        success: true,
        message: 'Account created successfully',
        token,
        user: sanitizeUser(user),
      });
    }

    if (pathname === '/api/google/url' && method === 'GET') {
      const origin = parsedUrl.searchParams.get('origin') || 'http://localhost:3000';
      const mode = parsedUrl.searchParams.get('mode') || 'login';
      const plan = parsedUrl.searchParams.get('plan') || 'pro';
      const url = `${PUBLIC_BASE_URL}/api/google/auth?origin=${encodeURIComponent(origin)}&mode=${encodeURIComponent(mode)}&plan=${encodeURIComponent(plan)}&popup=true`;
      return sendJson(req, res, 200, { success: true, url });
    }

    // Where a full-page (non-popup) redirect hands the session to the frontend's own callback page,
    // which reads `token` from the URL and fetches the profile itself (see app/auth/callback).
    function authCallbackUrl(origin, token, user) {
      const name = encodeURIComponent(user?.profile?.displayName || user?.email?.split('@')[0] || 'Creator');
      return `${origin}/auth/callback?token=${encodeURIComponent(token)}&name=${name}`;
    }

    function googlePopupHtml({ type, token, user, message, origin, fallbackUrl }) {
      const payload = type === 'GOOGLE_AUTH_SUCCESS' ? { type, token, user: sanitizeUser(user) } : { type, message };
      return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${type === 'GOOGLE_AUTH_SUCCESS' ? 'Signed in' : 'Sign-in failed'}</title></head>
  <body style="background:#111110;color:#fcfbf7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <script>
      (function() {
        var payload = ${JSON.stringify(payload)};
        if (window.opener) {
          window.opener.postMessage(payload, ${JSON.stringify(origin)});
          window.close();
        } else {
          window.location.href = ${JSON.stringify(fallbackUrl)};
        }
      })();
    </script>
    <p>${type === 'GOOGLE_AUTH_SUCCESS' ? 'Signed in to Motion Studio. Closing window...' : 'Could not sign in with Google. Closing window...'}</p>
  </body>
</html>`;
    }

    if (pathname === '/api/google/auth' && method === 'GET') {
      const origin = parsedUrl.searchParams.get('origin') || 'http://localhost:3000';
      const mode = parsedUrl.searchParams.get('mode') || 'login';
      const plan = parsedUrl.searchParams.get('plan') || 'free';
      const popup = parsedUrl.searchParams.get('popup') === 'true';

      // Real Google OAuth: send the browser to Google's own consent screen.
      if (googleClient) {
        const state = Buffer.from(JSON.stringify({ origin, mode, plan, popup })).toString('base64url');
        const authUrl = googleClient.generateAuthUrl({
          access_type: 'online',
          scope: ['openid', 'email', 'profile'],
          state,
          prompt: 'select_account',
        });
        res.writeHead(302, { Location: authUrl });
        return res.end();
      }

      // No Google credentials configured: local-dev stub so the flow is still testable end-to-end.
      let user = db.users[0];
      if (!user) {
        user = defaultUser({ email: 'creator@byreel.io', name: 'Pradum Singh', tier: plan, provider: 'google' });
        db.users.push(user);
      }
      const token = createToken(user.id);
      db.sessions[token] = user.id;
      saveDb();
      setAuthCookies(res, token);

      if (popup) {
        setCorsHeaders(req, res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          googlePopupHtml({
            type: 'GOOGLE_AUTH_SUCCESS',
            token,
            user,
            origin,
            fallbackUrl: authCallbackUrl(origin, token, user),
          })
        );
      }
      res.writeHead(302, { Location: authCallbackUrl(origin, token, user) });
      return res.end();
    }

    // Google redirects here after the user approves (or cancels) the consent screen.
    if (pathname === '/api/google/callback' && method === 'GET') {
      const code = parsedUrl.searchParams.get('code');
      const oauthError = parsedUrl.searchParams.get('error');
      let state = { origin: 'http://localhost:3000', mode: 'login', plan: 'free', popup: true };
      try {
        state = { ...state, ...JSON.parse(Buffer.from(parsedUrl.searchParams.get('state') || '', 'base64url').toString('utf8')) };
      } catch {
        // malformed state: fall back to defaults above
      }

      const fail = (message) => {
        const errorUrl = `${state.origin}/login?error=${encodeURIComponent(message)}`;
        if (state.popup === false) {
          res.writeHead(302, { Location: errorUrl });
          return res.end();
        }
        setCorsHeaders(req, res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          googlePopupHtml({
            type: 'GOOGLE_AUTH_ERROR',
            message,
            origin: state.origin,
            fallbackUrl: errorUrl,
          })
        );
      };

      if (oauthError) return fail('Google sign-in was cancelled.');
      if (!code || !googleClient) return fail('Google sign-in is not configured on this server.');

      try {
        const { tokens } = await googleClient.getToken(code);
        const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload?.email) return fail('Google did not return an email address.');

        const user = upsertGoogleUser({
          googleId: payload.sub,
          email: payload.email,
          name: payload.name,
          picture: payload.picture,
          plan: state.plan,
        });
        if (payload.email_verified) user.auth.emailVerified = true;

        const token = createToken(user.id);
        db.sessions[token] = user.id;
        saveDb();
        setAuthCookies(res, token);

        const targetCallbackUrl = authCallbackUrl(state.origin, token, user);

        if (state.popup === false) {
          res.writeHead(302, { Location: targetCallbackUrl });
          return res.end();
        }

        setCorsHeaders(req, res);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          googlePopupHtml({
            type: 'GOOGLE_AUTH_SUCCESS',
            token,
            user,
            origin: state.origin,
            fallbackUrl: targetCallbackUrl,
          })
        );
      } catch (err) {
        console.error('[server] Google OAuth callback failed:', err?.message || err);
        return fail('Could not complete Google sign-in.');
      }
    }

    if ((pathname === '/api/google' || pathname === '/api/google/register') && method === 'POST') {
      const body = await readBody(req);
      const plan = body.plan || 'free';

      if (googleClient) {
        if (!body.credential) {
          return sendError(req, res, 400, 'Missing Google credential.', 'VALIDATION_ERROR');
        }
        try {
          const ticket = await googleClient.verifyIdToken({ idToken: body.credential, audience: GOOGLE_CLIENT_ID });
          const payload = ticket.getPayload();
          if (!payload?.email) return sendError(req, res, 401, 'Invalid Google credential.', 'UNAUTHORIZED');

          const user = upsertGoogleUser({
            googleId: payload.sub,
            email: payload.email,
            name: payload.name,
            picture: payload.picture,
            plan,
          });
          if (payload.email_verified) user.auth.emailVerified = true;

          const token = createToken(user.id);
          db.sessions[token] = user.id;
          saveDb();
          setAuthCookies(res, token);
          return sendJson(req, res, 200, {
            success: true,
            message: 'Google authentication successful',
            token,
            user: sanitizeUser(user),
          });
        } catch (err) {
          return sendError(req, res, 401, 'Could not verify Google credential.', 'UNAUTHORIZED');
        }
      }

      // No Google credentials configured: local-dev stub.
      let user = db.users[0];
      if (!user) {
        user = defaultUser({ email: 'creator@byreel.io', name: 'Pradum Singh', tier: plan, provider: 'google' });
        db.users.push(user);
      }
      const token = createToken(user.id);
      db.sessions[token] = user.id;
      saveDb();
      setAuthCookies(res, token);
      return sendJson(req, res, 200, {
        success: true,
        message: 'Google authentication successful',
        token,
        user: sanitizeUser(user),
      });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const authHeader = req.headers.authorization || '';
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const cookies = parseCookies(req);
      const token = bearer || cookies.token || cookies.animagent_token || null;
      if (token) {
        db.revokedTokens = db.revokedTokens || {};
        db.revokedTokens[token] = Date.now();
        if (db.sessions && db.sessions[token]) {
          delete db.sessions[token];
        }
        saveDb();
      }
      clearAuthCookies(res);
      return sendJson(req, res, 200, {
        success: true,
        message: 'Logged out successfully',
      });
    }

    if (pathname === '/api/user/me' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to access your profile.', 'UNAUTHORIZED');
      }
      return sendJson(req, res, 200, {
        success: true,
        user: sanitizeUser(user),
      });
    }

    if (pathname === '/api/user/profile' && method === 'PATCH') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to update your profile.', 'UNAUTHORIZED');
      }

      const body = await readBody(req);

      if (body.displayName && typeof body.displayName === 'string') {
        const trimmed = body.displayName.trim();
        if (trimmed.length > 0) {
          user.profile.displayName = trimmed;
          const parts = trimmed.split(/\s+/);
          user.profile.firstName = parts[0] || '';
          user.profile.lastName = parts.slice(1).join(' ') || '';
        }
      }

      if (body.email && typeof body.email === 'string') {
        const newEmail = body.email.toLowerCase().trim();
        if (newEmail !== user.email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
            return sendError(req, res, 400, 'Please enter a valid email address.', 'VALIDATION_ERROR');
          }
          const existing = db.users.find((u) => u.email === newEmail && u.id !== user.id);
          if (existing) {
            return sendError(req, res, 409, 'An account with this email address already exists.', 'EMAIL_IN_USE');
          }
          user.email = newEmail;
        }
      }

      if (body.company !== undefined) {
        user.profile.company = String(body.company).trim();
      }

      if (body.bio !== undefined || body.role !== undefined) {
        user.profile.bio = String(body.bio ?? body.role ?? '').trim();
      }

      if (body.avatarUrl !== undefined) {
        user.profile.avatarUrl = String(body.avatarUrl).trim() || null;
      }

      // Password change support
      if (body.newPassword) {
        const newPw = String(body.newPassword);
        if (newPw.length < 8) {
          return sendError(req, res, 400, 'New password must be at least 8 characters long.', 'WEAK_PASSWORD');
        }
        if (user.passwordHash) {
          if (!body.currentPassword || !verifyPassword(body.currentPassword, user.passwordHash)) {
            return sendError(req, res, 400, 'Current password is incorrect.', 'INVALID_PASSWORD');
          }
        }
        user.passwordHash = hashPassword(newPw);
      }

      saveDb();
      return sendJson(req, res, 200, {
        success: true,
        message: 'Profile updated successfully',
        user: sanitizeUser(user),
      });
    }

    if (pathname === '/api/user/preferences' && method === 'PATCH') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to update preferences.', 'UNAUTHORIZED');
      }

      const body = await readBody(req);
      user.preferences = {
        ...user.preferences,
        ...(typeof body.renderCompletionAlerts === 'boolean' ? { renderCompletionAlerts: body.renderCompletionAlerts } : {}),
        ...(typeof body.hardwareAcceleration === 'boolean' ? { hardwareAcceleration: body.hardwareAcceleration } : {}),
        ...(typeof body.productUpdates === 'boolean' ? { productUpdates: body.productUpdates } : {}),
      };
      saveDb();
      return sendJson(req, res, 200, {
        success: true,
        message: 'Preferences updated successfully',
        preferences: user.preferences,
      });
    }

    if (pathname === '/api/user/plan' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to manage your plan.', 'UNAUTHORIZED');
      }

      const body = await readBody(req);
      const tier = ['free', 'creator', 'pro', 'enterprise'].includes(body.tier) ? body.tier : 'pro';
      const interval = body.interval === 'monthly' ? 'monthly' : 'annual';
      user.plan.tier = tier;
      user.plan.billingInterval = interval;
      user.plan.status = 'active';
      saveDb();
      return sendJson(req, res, 200, {
        success: true,
        message: `Subscription updated to ${tier.toUpperCase()} (${interval})`,
        user: sanitizeUser(user),
      });
    }

    // =========================================================================
    // 3. PROMPT QUEUE & MULTI-AGENT HARNESS ORCHESTRATION
    // =========================================================================
    if (pathname === '/api/prompt' && method === 'POST') {
      const body = await readBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        return sendError(req, res, 400, 'Field "prompt" is required and must be a non-empty string.', 'EMPTY_PROMPT');
      }

      const promptId =
        typeof body.promptId === 'string' && body.promptId.trim()
          ? body.promptId.trim()
          : `p-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

      // Idempotency check
      if (jobsByPromptId.has(promptId)) {
        const existing = jobsByPromptId.get(promptId);
        return sendJson(req, res, 200, {
          success: true,
          job: existing,
          message: 'Prompt job already exists',
        });
      }

      const ratio = ['16:9', '9:16', '1:1'].includes(body.ratio) ? body.ratio : '16:9';
      const durationS = Number.isFinite(Number(body.length))
        ? Math.max(5, Math.min(60, Math.round(Number(body.length))))
        : 15;
      const inheritedTheme = resolveThemeFromJob(body.themeFrom);

      // Model & Provider selection from frontend
      const validProviders = ['azure', 'glm', 'claude', 'openai', 'gemini'];
      let provider = validProviders.includes(body.provider) ? body.provider : (config.roles.builder || 'azure');
      let model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : (config.providers[provider]?.model || 'qwen--qwen38-27b');
      const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
      let effort = validEfforts.includes(body.effort) ? body.effort : (config.providers[provider]?.effort || 'high');
      if (effort === 'max') effort = 'xhigh';

      // Smart routing: if gpt-5-mini is requested and openai key is absent, use azure deployment
      if (model === 'gpt-5-mini' && provider === 'openai' && !config.providers.openai?.apiKey) {
        provider = 'azure';
      }

      // Colours: a named palette, a colour reference image (https URL or data: URL, <= 8 MB, its
      // palette is extracted in the job sandbox), or exact roles {ground, ink, accent, accent2?}.
      const HEX = /^#[0-9a-f]{6}$/i;
      if (body.palette != null && !paletteById(body.palette)) {
        return sendError(req, res, 400, `Unknown palette "${body.palette}". GET /api/palettes lists them.`, 'BAD_PALETTE');
      }
      if (body.colorRef != null && !(typeof body.colorRef === 'string' && /^(https:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i.test(body.colorRef))) {
        return sendError(req, res, 400, 'Field "colorRef" must be an https image URL or a data:image/...;base64 URL.', 'BAD_COLOR_REF');
      }
      if (body.colors != null && !(body.colors && ['ground', 'ink', 'accent'].every((k) => HEX.test(body.colors[k])) && (body.colors.accent2 == null || HEX.test(body.colors.accent2)))) {
        return sendError(req, res, 400, 'Field "colors" needs ground, ink and accent (and optionally accent2) as #RRGGBB.', 'BAD_COLORS');
      }
      const look = {
        ...(body.colors ? { colors: body.colors } : {}),
        ...(body.colorRef ? { colorRef: body.colorRef } : {}),
        ...(body.palette ? { palette: body.palette } : {}),
      };

      const options = {
        aspect: ratio,
        duration: durationS,
        provider,
        model,
        effort,
        ...(inheritedTheme && !Object.keys(look).length ? { theme: inheritedTheme } : {}),
        ...look,
      };

      const job = {
        id: `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        promptId,
        provider,
        model,
        effort,
        status: activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'running',
        harnessJobId: null,
        stage: activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'preparing',
        activity:
          activeJobCount >= MAX_CONCURRENT_JOBS
            ? `Queued behind ${activeJobCount} active render...`
            : `Initializing HyperFrames with ${provider}/${model} (${effort})...`,
        theme: inheritedTheme || null,
        palette: body.palette || null,
        colors: body.colors || null,
        // An embedded image is not kept in the job record; a retry resumes from the colours it gave.
        colorRef: typeof body.colorRef === 'string' && body.colorRef.startsWith('https://') ? body.colorRef : null,
        title: prompt.slice(0, 56),
        prompt,
        ratio,
        play: [],
        durationS,
        error: null,
        tokens: null,
        canRetry: false,
        logs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      pushLog(job, `Prompt queued: "${prompt.slice(0, 120)}" [${provider}/${model} · ${effort}]`);

      persistJobRecord(job);

      // Update user generation counter
      const user = getAuthenticatedUser(req) || db.users[0];
      if (user?.usage?.generations) {
        user.usage.generations.daily += 1;
        user.usage.generations.monthly += 1;
        user.usage.generations.lifetime += 1;
        saveDb();
      }

      enqueueHarnessExecution({
        job,
        mode: 'run',
        options,
      });

      return sendJson(req, res, 202, {
        success: true,
        job,
        message: 'Prompt submitted to HyperFrames motion harness',
      });
    }

    const promptRetryMatch = /^\/api\/prompt\/([^/]+)\/retry$/.exec(pathname);
    if (promptRetryMatch && method === 'POST') {
      const promptId = decodeURIComponent(promptRetryMatch[1]);
      syncDiskJobs();
      const job = jobsByPromptId.get(promptId) || jobsByHarnessId.get(promptId);

      if (!job) {
        return sendError(req, res, 404, `Job "${promptId}" not found`, 'JOB_NOT_FOUND');
      }

      const resumeDir = job.harnessJobId ? path.join(JOBS_DIR, job.harnessJobId) : null;
      const canResumeOnDisk = resumeDir && fs.existsSync(path.join(resumeDir, 'harness', 'request.json'));

      job.status = activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'running';
      job.stage = 'preparing';
      job.activity = canResumeOnDisk
        ? `Resuming harness job ${job.harnessJobId}...`
        : 'Restarting harness job from prompt...';
      job.error = null;
      job.canRetry = false;
      job.updatedAt = new Date().toISOString();
      pushLog(job, `Retry requested (${canResumeOnDisk ? 'resuming' : 'restarting'})`);
      persistJobRecord(job);

      enqueueHarnessExecution({
        job,
        mode: canResumeOnDisk ? 'resume' : 'run',
        resumeDir: canResumeOnDisk ? resumeDir : undefined,
        options: {
          aspect: job.ratio || '16:9',
          duration: job.durationS || 15,
          provider: job.provider,
          model: job.model,
          effort: job.effort,
          ...(job.theme && job.theme !== 'custom' ? { theme: job.theme } : {}),
          ...(job.colors ? { colors: job.colors } : {}),
          ...(job.colorRef ? { colorRef: job.colorRef } : {}),
          ...(job.palette ? { palette: job.palette } : {}),
        },
      });

      return sendJson(req, res, 200, {
        success: true,
        job,
      });
    }

    const promptStatusMatch = /^\/api\/prompt\/([^/]+)$/.exec(pathname);
    if (promptStatusMatch && method === 'GET') {
      const promptId = decodeURIComponent(promptStatusMatch[1]);
      let job = jobsByPromptId.get(promptId) || jobsByHarnessId.get(promptId);
      if (!job) {
        syncDiskJobs();
        job = jobsByPromptId.get(promptId) || jobsByHarnessId.get(promptId);
      }
      if (!job) {
        return sendError(req, res, 404, `No generation job found for promptId "${promptId}".`, 'PROMPT_NOT_FOUND');
      }
      return sendJson(req, res, 200, {
        success: true,
        job,
      });
    }

    // =========================================================================
    // 4. VIDEO STREAMING, THUMBNAILS, PROJECTS & EXPORTS
    // =========================================================================
    const videoStreamMatch = /^\/api\/videos\/([^/]+)\/final\.mp4$/.exec(pathname);
    if (videoStreamMatch && (method === 'GET' || method === 'HEAD')) {
      const jobId = decodeURIComponent(videoStreamMatch[1]);
      const videoPath = path.join(JOBS_DIR, jobId, 'project', 'renders', 'final.mp4');
      const download = parsedUrl.searchParams.get('download') === '1';
      return streamVideoFile(req, res, videoPath, download ? `motion-${jobId}.mp4` : null);
    }

    const thumbMatch = /^\/api\/videos\/([^/]+)\/thumbnail\.jpg$/.exec(pathname);
    if (thumbMatch && (method === 'GET' || method === 'HEAD')) {
      const jobId = decodeURIComponent(thumbMatch[1]);
      const snapPath = findJobSnapshotPath(path.join(JOBS_DIR, jobId));
      if (!snapPath || !fs.existsSync(snapPath)) {
        return sendError(req, res, 404, 'Thumbnail not found', 'THUMBNAIL_NOT_FOUND');
      }
      setCorsHeaders(req, res);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      const buf = fs.readFileSync(snapPath);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=3600',
      });
      return res.end(method === 'HEAD' ? null : buf);
    }

    if ((pathname === '/api/videos' || pathname === '/api/jobs') && method === 'GET') {
      syncDiskJobs();
      const list = Array.from(jobsByHarnessId.values()).sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
      return sendJson(req, res, 200, {
        success: true,
        jobs: list,
        videos: list.filter((j) => j.play && j.play.length > 0),
      });
    }

    if (pathname === '/api/projects' && method === 'GET') {
      syncDiskJobs();
      const projects = Array.from(jobsByHarnessId.values())
        .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
        .map((j) => ({
          id: j.harnessJobId || j.id,
          title: j.title || 'Motion Composition',
          timecode: `00:${String(Math.round(j.durationS || 15)).padStart(2, '0')}`,
          thumbnail: j.harnessJobId ? buildThumbnailUrl(j.harnessJobId) : null,
          videoUrl: j.play?.[0] || null,
          status: j.status === 'done' ? 'Completed' : j.status === 'running' ? 'Rendering' : 'Draft',
          ratio: j.ratio || '16:9',
          theme: j.theme || 'custom',
          updatedAt: j.updatedAt || j.createdAt,
        }));
      return sendJson(req, res, 200, {
        success: true,
        projects,
      });
    }

    if (pathname === '/api/exports' && method === 'GET') {
      syncDiskJobs();
      const exportsList = [];
      for (const j of jobsByHarnessId.values()) {
        if (!j.harnessJobId) continue;
        const mp4 = path.join(JOBS_DIR, j.harnessJobId, 'project', 'renders', 'final.mp4');
        if (fs.existsSync(mp4)) {
          const stat = fs.statSync(mp4);
          exportsList.push({
            id: `exp_${j.harnessJobId}`,
            jobId: j.harnessJobId,
            title: j.title || `Render ${j.harnessJobId}`,
            format: 'MP4',
            resolution: '1080p',
            fps: 30,
            sizeBytes: stat.size,
            durationS: j.durationS || 15,
            url: buildVideoUrl(j.harnessJobId),
            downloadUrl: `${buildVideoUrl(j.harnessJobId)}?download=1`,
            createdAt: j.updatedAt || j.createdAt,
          });
        }
      }
      exportsList.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      return sendJson(req, res, 200, {
        success: true,
        exports: exportsList,
      });
    }

    if (pathname === '/api/exports' && method === 'POST') {
      const body = await readBody(req);
      const projectId = body.projectId || body.jobId;
      const existing = projectId ? jobsByHarnessId.get(projectId) || jobsByPromptId.get(projectId) : null;
      return sendJson(req, res, 200, {
        success: true,
        export: {
          id: `exp_${Date.now()}`,
          projectId: projectId || 'proj_default',
          resolution: body.resolution || '1080p',
          format: body.format || 'MP4',
          fps: body.fps || 30,
          status: existing?.play?.[0] ? 'done' : 'queued',
          url: existing?.play?.[0] || null,
        },
      });
    }

    // =========================================================================
    // 5. DEVELOPER API KEYS ENDPOINTS
    // =========================================================================
    if (pathname === '/api/keys' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to view your API keys.', 'UNAUTHORIZED');
      }
      const activeKeys = db.apiKeys.filter((k) => k.status === 'active' && k.userId === user.id);
      return sendJson(req, res, 200, {
        success: true,
        keys: activeKeys,
      });
    }

    if (pathname === '/api/keys' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to generate an API key.', 'UNAUTHORIZED');
      }
      const body = await readBody(req);
      const rawSecret = `byreel_live_sk_${crypto.randomBytes(16).toString('hex')}`;
      const prefix = rawSecret.slice(0, 19);
      const expiresInDays = Number(body.expiresInDays || 0);
      const expiresAt =
        expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null;

      const apiKey = {
        id: `key_${crypto.randomBytes(4).toString('hex')}`,
        userId: user.id,
        name: String(body.name || 'Studio CLI Key').trim(),
        prefix,
        environment: body.environment === 'development' ? 'development' : 'production',
        scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['render', 'prompt:read', 'prompt:write'],
        rateLimitPerMinute: 60,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt,
      };

      db.apiKeys.unshift(apiKey);
      saveDb();

      return sendJson(req, res, 201, {
        success: true,
        message: 'API Key created successfully',
        apiKey,
        secretKey: rawSecret,
      });
    }

    const keyDeleteMatch = /^\/api\/keys\/([^/]+)$/.exec(pathname);
    if (keyDeleteMatch && method === 'DELETE') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to revoke an API key.', 'UNAUTHORIZED');
      }
      const keyId = decodeURIComponent(keyDeleteMatch[1]);
      const found = db.apiKeys.find((k) => k.id === keyId && k.userId === user.id);
      if (!found) {
        return sendError(req, res, 404, 'API Key not found', 'KEY_NOT_FOUND');
      }
      found.status = 'revoked';
      saveDb();
      return sendJson(req, res, 200, {
        success: true,
        message: 'API Key revoked successfully',
      });
    }

    // =========================================================================
    // 6. PRODUCT LAUNCH URL SCANNER & GENERATOR
    // =========================================================================
    if (pathname === '/api/launch/scan-url' && method === 'POST') {
      const body = await readBody(req);
      const rawUrl = String(body.url || 'https://linear.app').trim();
      const targetUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
      let domain = 'product.io';
      try {
        domain = new URL(targetUrl).hostname.replace(/^www\./, '');
      } catch {
        // fallback
      }

      const brandTitle =
        domain
          .split('.')[0]
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Studio';

      let tagline = `High-velocity motion launch system for ${brandTitle}.`;
      let keyFeature = 'Deterministic 60 FPS scene compilation with custom typography & shaders.';
      let brandColor = '#5E6AD2';
      let accentColor = '#C5EF26';

      try {
        const resPage = await fetch(targetUrl, {
          headers: { 'User-Agent': 'ByreelStudioBot/1.0' },
          signal: AbortSignal.timeout(4500),
        });
        if (resPage.ok) {
          const html = await resPage.text();
          const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
          const descMatch =
            /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(html) ||
            /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i.exec(html);
          const themeMatch = /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i.exec(html);
          if (titleMatch?.[1]) tagline = titleMatch[1].trim().slice(0, 110);
          if (descMatch?.[1]) keyFeature = descMatch[1].trim().slice(0, 140);
          if (themeMatch?.[1] && /^#[0-9a-f]{3,8}$/i.test(themeMatch[1].trim())) {
            brandColor = themeMatch[1].trim();
          }
        }
      } catch {
        // Use clean fallback metadata if site blocks scraping or is offline
      }

      const product = {
        brandName: brandTitle,
        domain,
        tagline,
        keyFeature,
        brandColor,
        accentColor,
        category: body.category || 'SaaS & Developer Tools',
        techStack: ['HyperFrames', 'GSAP Timeline', 'WebGPU Shaders', 'Variable Fonts'],
        latency: '12ms',
        beats: [
          `00:00 - 00:04: Bold kinetic hook introducing ${brandTitle} over an animated shader ground`,
          `00:04 - 00:09: Feature spotlight — "${keyFeature.slice(0, 68)}"`,
          `00:09 - 00:12: Crisp typographic proof beat with ${brandColor} accent highlights`,
          `00:12 - 00:15: Confident wordmark hold for ${domain} with clean call-to-action`,
        ],
        suggestedPrompt: `A 15 second launch film for ${brandTitle} (${domain}). Hook: "${tagline}". Highlight "${keyFeature}". Palette: deep dark ground #090D16, crisp light ink #F5F2EB, brand accent ${brandColor}. End on a clean ${brandTitle.toUpperCase()} wordmark card.`,
      };

      return sendJson(req, res, 200, {
        success: true,
        product,
      });
    }

    // =========================================================================
    // 7. CONVERSATIONS, BRAND KIT, ASSETS, BILLING & MOTION GLYPHS
    // =========================================================================
    if (pathname === '/api/conversations' && method === 'GET') {
      return sendJson(req, res, 200, {
        success: true,
        conversations: db.conversations || [],
      });
    }

    if (pathname === '/api/conversations' && method === 'POST') {
      const body = await readBody(req);
      const conv = {
        id: `c-${crypto.randomUUID()}`,
        title: String(body.title || 'New video').trim(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
      db.conversations = db.conversations || [];
      db.conversations.unshift(conv);
      saveDb();
      return sendJson(req, res, 201, {
        success: true,
        conversation: conv,
      });
    }

    if (pathname === '/api/brand-kit' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to access your brand kit.', 'UNAUTHORIZED');
      }
      const kit = db.brandKits?.[user.id] || {
        brandName: user.profile?.company || 'Byreel Studio',
        tagline: 'Turn ideas into motion.',
        voice: 'Minimalist & Editorial',
        colors: [
          { id: 'col-1', name: 'Ink', value: '#111110' },
          { id: 'col-2', name: 'Paper', value: '#FCFBF7' },
          { id: 'col-3', name: 'Accent', value: '#C5EF26' },
        ],
        headingFont: 'Instrument Serif',
        bodyFont: 'Geist',
        logoDataUrl: null,
        updatedAt: new Date().toISOString(),
      };
      return sendJson(req, res, 200, { success: true, brandKit: kit });
    }

    if (pathname === '/api/brand-kit' && method === 'PUT') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to update your brand kit.', 'UNAUTHORIZED');
      }
      const body = await readBody(req);
      db.brandKits = db.brandKits || {};
      db.brandKits[user.id] = {
        ...db.brandKits[user.id],
        ...body,
        updatedAt: new Date().toISOString(),
      };
      saveDb();
      return sendJson(req, res, 200, {
        success: true,
        brandKit: db.brandKits[user.id],
      });
    }

    if (pathname === '/api/billing/invoices' && method === 'GET') {
      return sendJson(req, res, 200, {
        success: true,
        invoices: [
          {
            id: 'INV-2026-1001',
            date: 'Oct 01, 2026',
            description: 'Studio Pro - Annual Subscription',
            amount: '$59.00 USD',
            status: 'paid',
          },
          {
            id: 'INV-2026-0901',
            date: 'Sep 01, 2026',
            description: 'Studio Pro - Annual Subscription',
            amount: '$59.00 USD',
            status: 'paid',
          },
        ],
      });
    }

    if (pathname === '/api/motion/char-conversion' && method === 'POST') {
      const body = await readBody(req);
      const result = buildGlyphsForText(
        body.text || 'TURN IDEAS INTO MOTION',
        Number(body.fontSize || 120),
        body.effect || 'kinetic_split',
        body.physics || {}
      );
      return sendJson(req, res, 200, {
        success: true,
        ...result,
      });
    }

    if (pathname === '/api/motion/glyphs' && method === 'GET') {
      const text = parsedUrl.searchParams.get('text') || 'MOTION';
      const result = buildGlyphsForText(text, 120, 'kinetic_split', {});
      return sendJson(req, res, 200, {
        success: true,
        ...result,
      });
    }

    return sendError(req, res, 404, `Endpoint ${method} ${pathname} not found`, 'NOT_FOUND');
  } catch (err) {
    console.error('[server] Unhandled error:', err);
    return sendError(req, res, 500, err?.message || 'Internal server error', 'INTERNAL_ERROR');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[motion-studio-server] Listening on http://localhost:${PORT}`);
  console.log(`[motion-studio-server] Jobs directory: ${JOBS_DIR} (${jobsByHarnessId.size} existing jobs indexed)`);
});
