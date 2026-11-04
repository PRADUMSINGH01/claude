// Motion Studio Backend API Server
// Connects the Next.js frontend (http://localhost:3000) to the HyperFrames multi-agent harness
// in ../harness without modifying any existing harness files.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';

// Import harness modules (read-only consumption; no harness files are modified)
import { runJob } from '../harness/src/orchestrator.js';
import { runFilm } from '../harness/src/film.js';
import { runEdit } from '../harness/src/edit.js';
import {
  config,
  providerStatus,
  providerForRole,
  withRunSettings,
} from '../harness/src/config.js';
import { listThemes } from '../harness/src/tools/registry-tools.js';
import { applyEvent, BillingError, billingConfigured, charge, credits, creditsForCost, effectiveTier, estimateCredits, isAdmin, listPlans, measuredCost, paywall, PLANS, portalLink, refund, settle, startCheckout, syncFromDodo, verifyWebhook } from './billing.mjs';

const JOBS_DIR = config.jobsDir;
// plan-build (default): plan in a few short calls, then code assembles and the model writes only
// hand-built scenes (~20-60k tokens a film). agents: the older planner/builder/critic/fixer tool
// loops (runJob), roughly 1-2M tokens a film.
const PIPELINE = process.env.PIPELINE === 'agents' ? 'agents' : 'plan-build';
const SKILLS_DIR = config.skillsDir;

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SERVER_DATA_DIR || path.join(SERVER_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || process.env.API_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// The sites this API serves. A sign-in hands its session only to one of them, browsers may call the API only
// from them, and payment pages return only to them; an address taken from the request is never trusted.
const ALLOWED_ORIGINS = [
  ...new Set(
    [
      ...String(process.env.FRONTEND_URL || '').split(','),
      ...String(process.env.ALLOWED_ORIGINS || '').split(','),
      ...(IS_PRODUCTION ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']),
      'https://www.byreel.in',
      'https://byreel.in',
    ]
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  ),
];
const allowedOrigin = (origin) => (ALLOWED_ORIGINS.includes(String(origin || '').replace(/\/+$/, '')) ? String(origin).replace(/\/+$/, '') : null);
// The app's own address for this request: the caller's site when it is one of ours, else the main one.
const appOrigin = (origin) => allowedOrigin(origin) || ALLOWED_ORIGINS[0];

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
    IS_PRODUCTION
      ? '[server] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google sign-in is off.'
      : '[server] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google sign-in will use the local dev stub (no real Google verification).'
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Studio chats: one file per account (data/chats/<userId>.json), apart from db.json, which is rewritten whole
// on every change. A chat holds prompts, each take's result and the settings it used; build logs and live
// progress are not kept (a running take's progress comes from its job).
// ---------------------------------------------------------------------------
const CHATS_DIR = path.join(DATA_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });
const MAX_CHATS = 300;
const MAX_CHAT_BYTES = 256 * 1024;
const TOMBSTONE_DAYS = 90;
const chatStorePath = (userId) => path.join(CHATS_DIR, `${String(userId).replace(/[^\w-]/g, '')}.json`);

function readChatStore(userId) {
  try {
    const data = JSON.parse(fs.readFileSync(chatStorePath(userId), 'utf8'));
    return { chats: data.chats ?? {}, deleted: data.deleted ?? {} };
  } catch {
    return { chats: {}, deleted: {} };
  }
}

// Written to a temporary file and renamed: a crash mid-write never leaves half a file.
function writeChatStore(userId, store) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, at] of Object.entries(store.deleted)) if (Date.parse(at) < cutoff) delete store.deleted[id];
  const file = chatStorePath(userId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file);
}

// Past MAX_CHATS, the least recently used chats go (as deletions, so browsers drop them too).
function trimChatStore(store) {
  const ids = Object.keys(store.chats);
  if (ids.length <= MAX_CHATS) return;
  ids.sort((a, b) => String(store.chats[b].updatedAt).localeCompare(String(store.chats[a].updatedAt)));
  for (const id of ids.slice(MAX_CHATS)) {
    delete store.chats[id];
    store.deleted[id] = new Date().toISOString();
  }
}

// A chat as the app sends it, keeping only known fields of known types. Throws with the reason.
function cleanChat(body, id) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
  if (!body || typeof body !== 'object' || body.id !== id) throw new Error('The chat id in the body must match the URL.');
  if (!Array.isArray(body.messages) || body.messages.length > 400) throw new Error('A chat needs a messages list (at most 400).');
  const messages = body.messages.map((m) => {
    if (!m || typeof m.id !== 'string' || !['user', 'assistant'].includes(m.role)) throw new Error('Each message needs an id and a role.');
    return pick({
      id: str(m.id, 100),
      role: m.role,
      content: str(m.content, 8000) ?? '',
      createdAt: iso(m.createdAt) ?? new Date().toISOString(),
      promptId: str(m.promptId, 100),
      harnessJobId: str(m.harnessJobId, 100),
      preview: m.preview && typeof m.preview === 'object' ? pick({ title: str(m.preview.title, 200), url: str(m.preview.url, 2000) }) : undefined,
      stages: Array.isArray(m.stages) ? m.stages.slice(0, 12).map((s) => pick({ id: str(s?.id, 40), label: str(s?.label, 80), state: ['pending', 'running', 'done'].includes(s?.state) ? s.state : 'pending' })) : undefined,
      isStreaming: m.isStreaming === true ? true : undefined,
      isError: m.isError === true ? true : undefined,
      paywall: ['PLAN_LIMIT', 'CREDITS_EXHAUSTED'].includes(m.paywall) ? m.paywall : undefined,
      tokens: num(m.tokens),
      tokenDetails: m.tokenDetails && typeof m.tokenDetails === 'object' ? pick({ total: num(m.tokenDetails.total), input: num(m.tokenDetails.input), cachedInput: num(m.tokenDetails.cachedInput), output: num(m.tokenDetails.output) }) : undefined,
      provider: str(m.provider, 40),
      model: str(m.model, 120),
      effort: str(m.effort, 20),
      route: str(m.route, 80),
      ratio: ['16:9', '9:16', '1:1'].includes(m.ratio) ? m.ratio : undefined,
      length: num(m.length),
      notes: Array.isArray(m.notes) ? m.notes.slice(0, 5).map((n) => str(n, 300)).filter(Boolean) : undefined,
    });
  });
  const s = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const chat = pick({
    id,
    title: str(body.title, 200) ?? 'Untitled video',
    createdAt: iso(body.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(body.updatedAt) ?? new Date().toISOString(),
    messages,
    settings: pick({ ratio: ['16:9', '9:16', '1:1'].includes(s.ratio) ? s.ratio : undefined, length: num(s.length), provider: str(s.provider, 40), model: str(s.model, 120), effort: str(s.effort, 20), route: str(s.route, 80), sound: typeof s.sound === 'boolean' ? s.sound : undefined }),
    theme: body.theme && typeof body.theme === 'object' && typeof body.theme.jobId === 'string' ? { jobId: str(body.theme.jobId, 100), name: str(body.theme.name, 100) ?? '' } : undefined,
  });
  if (Buffer.byteLength(JSON.stringify(chat)) > MAX_CHAT_BYTES) throw new Error('This chat is too large to save.');
  return chat;
}
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
  // Every account starts free; only a verified Dodo webhook gives it a paid plan (billing.mjs).
  const tier = overrides.tier || 'free';
  const billingInterval = overrides.billingInterval || 'monthly';

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
    // No password given (a Google sign-up) means no password: never a default anyone could type.
    passwordHash: overrides.passwordHash || (overrides.password ? hashPassword(overrides.password) : null),
    profile: {
      displayName,
      firstName,
      lastName,
      avatarUrl: overrides.avatarUrl || null,
      company: overrides.company || '',
      bio: overrides.bio || '',
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
      generations: { daily: 0, monthly: 0, lifetime: 0, limit: tierLimits.generations },
      renders: { daily: 0, monthly: 0, lifetime: 0, limit: tierLimits.renders },
      apiCalls: { daily: 0, monthly: 0, lifetime: 0, limit: tierLimits.apiCalls },
      storage: { usedBytes: 0, limitBytes: tierLimits.storage },
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

// Signs sign-in tokens and media links. The fallback is public (it is in this file), so production refuses to
// start without a real one: with it anyone could sign a token for any user.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'byreel-studio-jwt-secret-secure-key');
if (!JWT_SECRET) {
  console.error('[motion-studio-server] JWT_SECRET is not set. Refusing to start in production: sign-ins could be forged. Set a long random JWT_SECRET in .env.');
  process.exit(1);
}

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
    // Only the configured secret: a second, built-in "legacy" secret let anyone who read this file sign in as
    // any user.
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    if (!(sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig)))) return null;

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
  const initial = {
    users: [],
    sessions: {},
    apiKeys: [],
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

// Sessions belong to the secret they were signed under. When it changes (set for the first time, or rotated
// after a leak) every session ends, including any token forged with an old public secret and saved here.
const sessionSecretTag = crypto.createHash('sha256').update(JWT_SECRET).digest('hex').slice(0, 16);
if (db.sessionSecretTag !== sessionSecretTag) {
  db.sessions = {};
  db.sessionSecretTag = sessionSecretTag;
  saveDb();
}

// Accounts made without a password (Google sign-ups, and the account this file used to seed) were given a fixed
// default one, so anyone who knew the email could sign in with it. Once: they lose it, and their sessions end in
// case one was opened that way. Their owners sign in with Google again.
db.migrations ??= {};
if (!db.migrations.noDefaultPasswords) {
  let cleared = 0;
  for (const u of db.users) {
    const madeWithout = u.auth?.provider === 'google' || u.id === 'usr_94829104';
    if (!madeWithout || !u.passwordHash || !verifyPassword('Password123!', u.passwordHash)) continue;
    u.passwordHash = null;
    db.revokedTokens ??= {};
    for (const [token, id] of Object.entries(db.sessions ?? {})) {
      if (id !== u.id) continue;
      db.revokedTokens[token] = true;
      delete db.sessions[token];
    }
    cleared += 1;
  }
  db.migrations.noDefaultPasswords = new Date().toISOString();
  saveDb();
  if (cleared) console.warn(`[server] removed the default password from ${cleared} account(s) and ended their sessions`);
}
// Accounts were made with a stock photo, "Byreel Motion Studio" and "Lead Creative Director" as their own
// profile. Once: those placeholders go, so a profile shows only what its owner (or Google) gave.
if (!db.migrations.noPlaceholderProfiles) {
  for (const u of db.users) {
    if (!u.profile) continue;
    if (u.profile.avatarUrl === '/dashboard/user-avatar.jpg') u.profile.avatarUrl = null;
    if (u.profile.company === 'Byreel Motion Studio') u.profile.company = '';
    if (u.profile.bio === 'Lead Creative Director') u.profile.bio = '';
  }
  db.migrations.noPlaceholderProfiles = new Date().toISOString();
  saveDb();
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Fixed-window counters in memory (one server process): sign-in guessing, sign-up farming, email resends.
const rateWindows = new Map();
function rateHit(key, windowMs, now = Date.now()) {
  const w = rateWindows.get(key);
  if (!w || now - w.start >= windowMs) {
    rateWindows.set(key, { start: now, n: 1, windowMs });
    return 1;
  }
  return (w.n += 1);
}
const rateCount = (key, now = Date.now()) => {
  const w = rateWindows.get(key);
  return w && now - w.start < w.windowMs ? w.n : 0;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of rateWindows) if (now - w.start >= w.windowMs) rateWindows.delete(k);
}, 10 * 60 * 1000).unref();

// The caller's address. Caddy is the only way in and sets X-Forwarded-For to the client it saw; its last entry
// is the one Caddy added.
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || 'unknown';

// Email verification, on once a sender is configured (Resend: RESEND_API_KEY and EMAIL_FROM). An email sign-up
// then gets its free films only after confirming the address, so throwaway accounts can't farm free credits.
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails'; // tests point it at a stand-in
const emailVerificationOn = Boolean(RESEND_API_KEY && EMAIL_FROM);
const mustVerifyEmail = (user) => emailVerificationOn && user?.auth?.emailVerified === false && !isAdmin(user);

async function sendVerificationEmail(user, origin) {
  if (!emailVerificationOn) return false;
  const token = crypto.randomBytes(24).toString('base64url');
  user.auth.verify = { hash: sha256(token), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
  saveDb();
  const link = `${PUBLIC_BASE_URL}/api/verify-email?token=${token}&to=${encodeURIComponent(appOrigin(origin))}`;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: user.email,
        subject: 'Confirm your email for byreel',
        text: `Confirm your email to start making films:\n\n${link}\n\nThe link works for 24 hours. If you didn't sign up, ignore this email.`,
        html: `<p>Confirm your email to start making films:</p><p><a href="${link}">Confirm my email</a></p><p>The link works for 24 hours. If you didn't sign up, ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.error(`[server] verification email failed: ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error('[server] verification email failed:', err?.message || err);
    return false;
  }
}

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, failedFilms, ...copy } = u;
  // The verification link's hash stays here; the app learns only whether the email still needs confirming.
  const { verify, ...auth } = u.auth ?? {};
  copy.auth = { ...auth, hasPassword: Boolean(passwordHash), mustVerify: mustVerifyEmail(u) };
  // The app shows the plan the user really has (a tier stored without a Dodo payment is not one) and the
  // credits left this period.
  copy.plan = { ...u.plan, tier: effectiveTier(u), storedTier: u.plan?.tier ?? null };
  copy.usage = { ...u.usage, credits: { ...credits(u) } };
  return copy;
}

/** Find the user this verified Google identity belongs to, or provision one. Never trusts a client-supplied id. */
// An existing account is joined by email only when Google has verified that email: otherwise a Google account
// carrying someone else's address would sign in as them.
function upsertGoogleUser({ googleId, email, emailVerified, name, picture, plan }) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  let user = db.users.find((u) => u.googleId === googleId);
  if (!user) {
    const byEmail = db.users.find((u) => u.email === normalizedEmail);
    if (byEmail && !emailVerified) return null;
    user = byEmail;
  }

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
      provider: 'google',
    });
    // The plan picked on the pricing page is remembered for checkout, never granted.
    if (['creator', 'pro', 'enterprise'].includes(plan)) user.plan.intended = plan;
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
  let cachedInput = 0;
  for (const role of Object.values(usageObj)) {
    if (role && typeof role === 'object') {
      input += Number(role.input || 0);
      output += Number(role.output || 0);
      cachedInput += Number(role.cachedInput || 0);
    }
  }
  if (input === 0 && output === 0) return null;
  return {
    total: input + output,
    input,
    cachedInput,
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

// Media links carry an unguessable key (an HMAC of the job id), so a <video> tag on another domain plays a
// film without cookies while nobody can fetch one by guessing its id. Only the owner is ever sent the link.
function mediaKey(harnessJobId) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`media:${harnessJobId}`).digest('base64url').slice(0, 24);
}

function validMediaKey(harnessJobId, key) {
  const expected = Buffer.from(mediaKey(harnessJobId));
  const given = Buffer.from(String(key || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function buildVideoUrl(harnessJobId) {
  return `${PUBLIC_BASE_URL}/api/videos/${encodeURIComponent(harnessJobId)}/final.mp4?k=${mediaKey(harnessJobId)}`;
}

function buildThumbnailUrl(harnessJobId) {
  return `${PUBLIC_BASE_URL}/api/videos/${encodeURIComponent(harnessJobId)}/thumbnail.jpg?k=${mediaKey(harnessJobId)}`;
}

// A film belongs to the account that ordered it. Films from before accounts were attached have no owner and
// are shown to admins only.
function canSeeJob(user, job) {
  if (!user || !job) return false;
  return job.userId ? job.userId === user.id : isAdmin(user);
}

// What a client is sent for a film: its media links rebuilt with their keys (older records hold bare links).
function presentJob(job) {
  if (!job) return job;
  const { costUsd, ...shown } = job;
  const playable = Boolean(job.harnessJobId && job.play?.length);
  return { ...shown, play: playable ? [buildVideoUrl(job.harnessJobId)] : job.play ?? [], poster: playable ? buildThumbnailUrl(job.harnessJobId) : null };
}

// A still of a finished film: the most representative frame of its later part (ffmpeg's thumbnail filter picks
// the frame closest to the average, so the settled look the film holds, not a build-up's empty first frame or a
// moment mid-transition where two lines of words overlap). Made once and kept next to the render; concurrent
// requests share one run.
const posterRuns = new Map();
function filmPoster(jobDir, seconds) {
  const video = path.join(jobDir, 'project', 'renders', 'final.mp4');
  const poster = path.join(jobDir, 'project', 'renders', 'poster.jpg');
  if (fs.existsSync(poster)) return Promise.resolve(poster);
  if (!fs.existsSync(video)) return Promise.resolve(null);
  if (posterRuns.has(poster)) return posterRuns.get(poster);
  const grab = (input) =>
    new Promise((resolve) => {
      execFile('ffmpeg', ['-v', 'error', '-y', ...input, '-frames:v', '1', '-q:v', '4', poster], { timeout: 30_000 }, (err) =>
        resolve(!err && fs.existsSync(poster) ? poster : null)
      );
    });
  // The last 65% of the film, sampled 5 times a second (a few dozen 720p frames in memory at most).
  const d = Math.max(1, Number(seconds) || 5);
  const later = ['-ss', (d * 0.35).toFixed(2), '-t', (d * 0.65).toFixed(2), '-i', video, '-vf', `fps=5,scale=720:-2,thumbnail=${Math.ceil(d * 0.65 * 5)}`];
  // A seek past the end (an unknown length) writes nothing; the first frame is better than no still.
  const run = grab(later)
    .then((made) => made || grab(['-i', video, '-vf', 'scale=720:-2']))
    .finally(() => posterRuns.delete(poster));
  posterRuns.set(poster, run);
  return run;
}

function syncDiskJobs({ startup = false } = {}) {
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
      // Owner and charge survive a re-read from disk (they used to be dropped, which broke refunds too).
      userId: existing?.userId ?? request?.options?.userId ?? null,
      credits: existing?.credits ?? null,
      creditsRefunded: existing?.creditsRefunded ?? false,
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
        const merged = {
          ...diskJob,
          id: savedJob.id || diskJob.id,
          promptId: pId,
          userId: savedJob.userId ?? diskJob.userId ?? null,
          credits: savedJob.credits ?? diskJob.credits ?? null,
          creditsRefunded: savedJob.creditsRefunded ?? diskJob.creditsRefunded ?? false,
          // What it ran on and how often it was retried: a retry after a restart keeps both.
          ...Object.fromEntries(['provider', 'model', 'effort', 'route', 'vision', 'retries'].filter((k) => savedJob[k] !== undefined).map((k) => [k, savedJob[k]])),
        };
        jobsByPromptId.set(pId, merged);
        jobsByHarnessId.set(savedJob.harnessJobId, merged); // the lists read this map: same record, same owner
      } else {
        // A film the last server left running or queued: failed, and retryable. Only at startup: this runs on
        // many requests too, and a film queued right now has no folder yet but is not failed (marking it so let
        // it be retried, and run twice).
        if (startup && (savedJob.status === 'running' || savedJob.status === 'queued')) {
          savedJob.status = 'failed';
          savedJob.error = 'Server restarted while job was in progress. Click retry to resume.';
          savedJob.canRetry = Boolean(savedJob.harnessJobId);
        }
        jobsByPromptId.set(pId, savedJob);
      }
    }
  }
}

syncDiskJobs({ startup: true });

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

// The theme of one of the caller's own films. The id is looked up, never joined into a path as given: a
// "../" in it reached plan files outside the jobs folder.
function resolveThemeFromJob(themeFromId, user) {
  if (typeof themeFromId !== 'string' || !themeFromId) return undefined;
  const ref = jobsByHarnessId.get(themeFromId) || jobsByPromptId.get(themeFromId);
  if (!ref || !canSeeJob(user, ref)) return undefined;
  if (ref.theme && ref.theme !== 'custom' && !ref.theme.endsWith('-custom')) {
    return ref.theme;
  }
  if (!/^[\w-]+$/.test(ref.harnessJobId || '')) return undefined;
  const jobDir = path.join(JOBS_DIR, ref.harnessJobId);
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
    case 'warning':
      return `Warning: ${ev.message || ''}`;
    case 'cut_off':
      return `${role}reply cut off at the output limit; retrying with ${ev.maxOutputTokens} tokens`;
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

      // What the person should know about the finished film (a scene that fell back to a simple version).
      case 'warning': {
        if (ev.userFacing && ev.message) job.notes = [...(job.notes ?? []), String(ev.message).slice(0, 300)].slice(-5);
        break;
      }
      case 'edit_plan': {
        // What an edit changes, in the person's words: shown with the finished video (it says when a size asked
        // for couldn't fit and what was done instead).
        if (ev.summary) job.editSummary = String(ev.summary).slice(0, 400);
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

    // This film's provider, model and reasoning effort, for every role and only for this film: films run side
    // by side (MAX_CONCURRENT_JOBS), and none changes another's settings.
    const settings = config.providers[job.provider]
      ? { provider: job.provider, model: job.model || undefined, effort: job.effort, route: job.route || undefined, vision: job.vision }
      : { effort: job.effort };

    const onEvent = createHarnessEventHandler(job);
    // A resumed job keeps the pipeline it started with.
    const resumedMode = mode === 'resume' ? readJsonSafe(path.join(resumeDir, 'harness', 'request.json'))?.mode : null;
    const usePlanBuild = mode === 'resume' ? resumedMode === 'plan-build' : PIPELINE === 'plan-build';
    pushLog(job, `Pipeline: ${mode === 'edit' ? `edit of ${job.editOf}` : usePlanBuild ? 'plan + build' : 'agents'}`);
    const result = mode === 'edit'
      ? await withRunSettings(settings, () => runEdit({ prompt: job.prompt, base: path.join(JOBS_DIR, job.editOf), options, jobsDir: JOBS_DIR, onEvent, signal: controller.signal }))
      : await withRunSettings(settings, () => (usePlanBuild ? runFilm : runJob)({
      prompt: mode === 'resume' ? undefined : job.brand ? `${job.prompt}\n\n${job.brand}` : job.prompt,
      options: mode === 'resume' ? {} : options,
      resume: mode === 'resume' ? resumeDir : undefined,
      jobsDir: JOBS_DIR,
      onEvent,
      signal: controller.signal,
    }));

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
    // Charged what it measured, not what it held: model spend (billed cost, or tokens at the model's price)
    // plus render time.
    const owner = db.users.find((u) => u.id === job.userId);
    if (owner && result?.usage && job.credits && !job.creditsSettled) {
      const cost = measuredCost(result.usage, await modelPrice(job.provider, job.model).catch(() => null));
      if (cost != null) {
        const charged = settle(owner, job, creditsForCost(cost, job.durationS || 15));
        job.costUsd = +cost.toFixed(5);
        pushLog(job, `Charged ${charged} credits for what it used (held ${job.creditsHeld})`);
        saveDb();
      }
    }
    persistJobRecord(job);
  } catch (err) {
    console.error(`[server] Harness job failed for promptId=${job.promptId}:`, err?.message || err);
    job.status = 'failed';
    job.error = String(err?.message || err || 'Generation failed');
    job.activity = null;
    job.canRetry = Boolean(job.harnessJobId);
    job.updatedAt = new Date().toISOString();
    pushLog(job, `FAILED: ${job.error}`);
    // A film that failed costs nothing; failures are counted, since each one spent model money.
    const owner = db.users.find((u) => u.id === job.userId);
    if (owner) owner.failedFilms = [...recentFailures(owner), new Date().toISOString()];
    if (refund(owner, job)) {
      pushLog(job, `Refunded ${job.credits} credits`);
    }
    saveDb();
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

// Browsers may call the API with credentials only from the app's own sites. Server-to-server callers with an
// API key send no Origin and need no CORS.
function setCorsHeaders(req, res) {
  res.setHeader('Vary', 'Origin');
  const origin = allowedOrigin(req.headers.origin);
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
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

// Session cookies page scripts can't read, sent only over HTTPS when the API is served over it.
const COOKIE_FLAGS = `Path=/; SameSite=Lax; HttpOnly${PUBLIC_BASE_URL.startsWith('https://') ? '; Secure' : ''}`;

function setAuthCookies(res, token, extra = []) {
  const maxAge = 60 * 60 * 24 * 7;
  res.setHeader('Set-Cookie', [
    `token=${encodeURIComponent(token)}; Max-Age=${maxAge}; ${COOKIE_FLAGS}`,
    `animagent_token=${encodeURIComponent(token)}; Max-Age=${maxAge}; ${COOKIE_FLAGS}`,
    ...extra,
  ]);
}

function clearAuthCookies(res) {
  res.setHeader('Set-Cookie', [`token=; Max-Age=0; ${COOKIE_FLAGS}`, `animagent_token=; Max-Age=0; ${COOKIE_FLAGS}`]);
}

// Google sign-in state: signed so its origin and plan can't be swapped, and short-lived. Its nonce must match
// the cookie set when this browser started the sign-in.
const GOOGLE_STATE_TTL_MS = 15 * 60 * 1000;
const googleStateMac = (body) => crypto.createHmac('sha256', JWT_SECRET).update(`google-state:${body}`).digest('base64url');

function signGoogleState(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${googleStateMac(body)}`;
}

function readGoogleState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(googleStateMac(body));
  const given = Buffer.from(mac);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Date.now() - Number(data.iat) < GOOGLE_STATE_TTL_MS ? data : null;
  } catch {
    return null;
  }
}

const googleNonceCookie = (nonce, maxAgeS) => `g_nonce=${nonce}; Max-Age=${Math.round(maxAgeS)}; ${COOKIE_FLAGS}`;

// The session token a request carries: a bearer header, or the session cookie.
function currentToken(req) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const cookies = parseCookies(req);
  return bearer || cookies.token || cookies.animagent_token || null;
}

function getAuthenticatedUser(req) {
  const token = currentToken(req);

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
  // The whole key, checked against its stored hash. Matching only the prefix let anyone who guessed four hex
  // characters (or read the seeded one in this file) act as the key's owner. A key made before hashes were
  // stored has none and no longer signs in: its owner makes a new one.
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader) {
    const hash = sha256(apiKeyHeader);
    const keyRec = db.apiKeys.find((k) => k.status === 'active' && k.secretHash === hash && (!k.expiresAt || Date.parse(k.expiresAt) > Date.now()));
    if (keyRec) {
      keyRec.lastUsedAt = new Date().toISOString();
      saveDb();
      return db.users.find((u) => u.id === keyRec.userId) || null;
    }
  }

  return null;
}

// The body exactly as sent: a webhook's signature covers these bytes, not a re-serialised JSON.
function readRawBody(req, maxBytes = 1024 * 1024) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Where the browser app lives, for checkout and portal return links.
function frontendUrl(req) {
  return appOrigin(req.headers.origin);
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

// The models a film may run on: what the Studio picker offers. A model id from the request alone could be any
// model on the owner's keys, at any price, so nothing outside this list (or the provider's configured default)
// runs. The pricier ones need a paid plan.
const MODEL_CATALOG = [
  {
    provider: 'azure',
    name: 'Azure AI',
    models: [
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', tag: 'Serverless MaaS', priceAs: 'openai/gpt-5-mini', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'max'], description: 'Fast concise reasoning & swift logic' },
      { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', priceAs: 'deepseek/deepseek-v4-pro', tag: 'Serverless MaaS', defaultEffort: 'high', efforts: ['low', 'medium', 'high', 'max'], description: 'Fast code generation and animation scripting' }
    ]
  },
  {
    provider: 'glm',
    name: 'Zhipu GLM',
    models: [
      // GLM 5 always thinks: low or high (medium would be the same as high). GLM 4.6 was offered here but the
      // account has no package for it (every call answered 429 "Insufficient balance", 2026-11-04).
      { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', priceAs: 'z-ai/glm-5.3-flash', tag: 'Ultra Fast', defaultEffort: 'low', efforts: ['low', 'high'], description: 'High speed Chinese/English multimodal reasoning' }
    ]
  },
  {
    provider: 'claude',
    name: 'Anthropic Claude',
    models: [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', priceAs: 'anthropic/claude-sonnet-5.5', paid: true, tag: 'Top Tier Visuals', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'State of the art layout, typography & canvas aesthetics' }
    ]
  },
  {
    provider: 'openai',
    name: 'OpenAI GPT',
    models: [
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', tag: 'Reasoning', priceAs: 'openai/gpt-5-mini', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Fast concise reasoning' },
      { id: 'gpt-4o', name: 'GPT-4o', priceAs: 'openai/gpt-4o', paid: true, tag: 'Omni', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Multimodal flagship' }
    ]
  },
  // OpenRouter: one key, many labs. Free models cost nothing but share a daily request limit across the whole
  // site; Top models cost about $0.3–2 a film, so they need a paid plan. vision: false for a model that can't
  // take images (the build's look step is skipped for it).
  {
    provider: 'openrouter',
    name: 'OpenRouter · Free',
    models: [
      { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL', tag: 'Free', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Free and sees images; shared daily limit, so it can be busy' },
      { id: 'thinkingmachines/inkling:free', name: 'Inkling', tag: 'Free', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Free, long context; shared daily limit, so it can be busy' },
      { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', tag: 'Free', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Free and compact; shared daily limit, so it can be busy' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', tag: 'Free · text only', vision: false, defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Free and large; works without checking its frames' }
    ]
  },
  {
    provider: 'openrouter',
    name: 'OpenRouter · Value',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', tag: 'Fast · low cost', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Strong motion code for cents a film; low is quickest, high thinks longest' },
      { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', tag: 'Fast · low cost', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Claude quality at a small-model price' },
      { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', tag: 'Lowest cost', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'The cheapest capable model here' },
      { id: 'minimax/minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', tag: 'Low cost', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Long outputs for big multi-scene films' },
      { id: 'qwen/qwen3.8-flash', name: 'Qwen 3.8 Flash', tag: 'Low cost', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Quick and steady with layout and type' },
      { id: 'inclusionai/ling-3.0-flash-vl', name: 'Ling 3.0 Flash VL', tag: 'Vision · experimental', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Cheaper and sees images; one upstream provider, so it can be rate-limited' }
    ]
  },
  {
    provider: 'openrouter',
    name: 'OpenRouter · Top',
    models: [
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', paid: true, tag: 'Top', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Best all-round design taste and motion code' },
      { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', paid: true, tag: 'Top · slowest', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'The most careful builder, for hero films' },
      { id: 'openai/gpt-6.1-terra', name: 'GPT-6.1 Terra', paid: true, tag: 'Top', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: "OpenAI's latest, strong at precise layouts" },
      { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon', paid: true, tag: 'Top', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: "Google's flagship, strong with images and long briefs" },
      { id: 'x-ai/grok-4.7', name: 'Grok 4.7', paid: true, tag: 'Top', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: "xAI's flagship" },
      { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', paid: true, tag: 'Top', defaultEffort: 'medium', efforts: ['low', 'medium', 'high'], description: 'Strong agentic coder' }
    ]
  },
  {
    provider: 'gemini',
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', priceAs: 'google/gemini-2.5-flash', tag: 'Multimodal', defaultEffort: 'low', efforts: ['low', 'medium', 'high'], description: 'Long context fast prototyping' }
    ]
  }
];

// The providers serving an OpenRouter model, from OpenRouter's public endpoints list, cached an hour: the Studio
// offers them, and a film's provider choice must be one of them. Only providers that take tool calls (the
// build needs them), cheapest first.
const OPENROUTER_ROUTE_SORTS = ['price', 'throughput', 'latency'];
const openRouterProviderCache = new Map();
const OPENROUTER_MODELS_URL = (process.env.OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models').replace(/\/+$/, ''); // tests point it at a stand-in
async function openRouterProviders(model) {
  const hit = openRouterProviderCache.get(model);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.providers;
  const res = await fetch(`${OPENROUTER_MODELS_URL}/${model.split('/').map(encodeURIComponent).join('/')}/endpoints`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const per1M = (v) => Math.round(Number(v || 0) * 1e8) / 100;
  const metric = (v) => (typeof v === 'number' ? v : typeof v?.p50 === 'number' ? v.p50 : null);
  const providers = ((await res.json())?.data?.endpoints ?? [])
    .filter((e) => e.tag && (e.supported_parameters ?? []).includes('tools'))
    .map((e) => ({
      tag: e.tag,
      name: e.provider_name || e.tag,
      quantization: e.quantization && e.quantization !== 'unknown' ? e.quantization : null,
      inputPerM: per1M(e.pricing?.prompt),
      outputPerM: per1M(e.pricing?.completion),
      contextLength: e.context_length ?? null,
      uptime: typeof e.uptime_last_1d === 'number' ? Math.round(e.uptime_last_1d * 10) / 10 : null,
      throughput: metric(e.throughput_last_30m),
      latency: metric(e.latency_last_30m),
    }))
    .sort((a, b) => a.inputPerM + a.outputPerM - (b.inputPerM + b.outputPerM));
  openRouterProviderCache.set(model, { at: Date.now(), providers });
  return providers;
}

// Price per million tokens { in, out, cacheRead } for a film's model: OpenRouter's list price for it, or for
// the same model when a provider bills it directly (priceAs in the catalog). From OpenRouter's public model
// list, cached a day; null when unknown (the film then holds and pays the flat rate).
let priceList = { at: 0, byId: null };
async function openRouterPrices() {
  if (priceList.byId && Date.now() - priceList.at < 24 * 60 * 60 * 1000) return priceList.byId;
  const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const per1M = (v) => Number(v) * 1e6;
  const byId = new Map();
  for (const m of (await res.json())?.data ?? []) {
    const p = m?.pricing;
    if (!m?.id || !p || !Number.isFinite(per1M(p.prompt)) || !Number.isFinite(per1M(p.completion))) continue;
    byId.set(m.id, { in: per1M(p.prompt), out: per1M(p.completion), cacheRead: Number.isFinite(per1M(p.input_cache_read)) ? per1M(p.input_cache_read) : per1M(p.prompt) });
  }
  priceList = { at: Date.now(), byId };
  return byId;
}

async function modelPrice(provider, model) {
  const id = provider === 'openrouter' ? model : catalogEntry(provider, model)?.priceAs;
  if (!id) return null;
  const list = await openRouterPrices().catch(() => null);
  return list?.get(id) ?? null;
}

// What films of a few lengths typically cost on the default model, for the plan and billing pages (each film is
// charged what it measures).
// On the Studio's default model (the app's DEFAULT_SETTINGS), which is what a film uses unless changed.
const STUDIO_DEFAULT_MODEL = { provider: 'glm', model: 'glm-5.3-flash' };
async function typicalCredits() {
  const price = await modelPrice(STUDIO_DEFAULT_MODEL.provider, STUDIO_DEFAULT_MODEL.model);
  return Object.fromEntries([9, 15, 30, 60].map((s) => [s, estimateCredits(price, s)]));
}

// The cheapest hosts for an OpenRouter model that answer well: 8-bit or better (a 4-bit DeepSeek host answered the
// brief with "{}" and garbled keys), up at least 98% of the last day, ordered by what a film spends (output weighs
// most). Up to three, tried in order with no others; null when the list can't be read (OpenRouter then balances).
async function cheapestRoute(model) {
  const providers = await openRouterProviders(model).catch(() => null);
  const good = (providers ?? []).filter((p) => !/^(fp4|fp6|int4)$/i.test(p.quantization ?? '') && (p.uptime == null || p.uptime >= 98));
  const cost = (p) => 0.4 * p.inputPerM + 0.6 * p.outputPerM;
  const picked = good.sort((a, b) => cost(a) - cost(b)).slice(0, 3);
  return picked.length ? picked.map((p) => p.tag).join(',') : null;
}

const catalogEntry = (provider, model) => MODEL_CATALOG.filter((g) => g.provider === provider).flatMap((g) => g.models).find((m) => m.id === model);

// The provider, model, effort and (OpenRouter) provider route a film request may run on, or why not.
async function chooseModel(user, body) {
  const provider = body.provider || config.roles.builder || 'azure';
  const groups = MODEL_CATALOG.filter((g) => g.provider === provider);
  if (!groups.length) return { status: 400, code: 'UNKNOWN_MODEL', message: `Unknown provider "${String(provider).slice(0, 40)}".` };
  const configured = config.providers[provider]?.model;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : configured || groups[0].models[0].id;
  const entry = catalogEntry(provider, model);
  if (!entry && model !== configured) {
    return { status: 400, code: 'UNKNOWN_MODEL', message: `"${model.slice(0, 60)}" is not one of the Studio's models.` };
  }
  if (entry?.paid && effectiveTier(user) === 'free') {
    return { status: 402, code: 'PLAN_LIMIT', message: `${entry.name} needs a paid plan.`, tier: 'free', upgradeUrl: '/pricing' };
  }
  const efforts = entry?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  let effort = efforts.includes(body.effort) ? body.effort : entry?.defaultEffort || config.providers[provider]?.effort || 'high';
  if (effort === 'max') effort = 'xhigh';

  // OpenRouter only: "auto" (OpenRouter balances), a sort (cheapest, fastest), or one provider by its tag.
  let route = null;
  if (provider === 'openrouter' && typeof body.route === 'string' && body.route && body.route !== 'auto') {
    if (OPENROUTER_ROUTE_SORTS.includes(body.route)) route = body.route;
    else {
      const providers = await openRouterProviders(model).catch(() => null);
      if (!providers) return { status: 503, code: 'ROUTES_UNAVAILABLE', message: "Couldn't check OpenRouter's providers right now. Pick Auto, or try again shortly." };
      if (!providers.some((p) => p.tag === body.route)) {
        return { status: 400, code: 'UNKNOWN_ROUTE', message: `"${body.route.slice(0, 40)}" doesn't serve ${entry?.name ?? model} with tool calls. Pick another provider or Auto.` };
      }
      route = body.route;
    }
  }
  // Auto: the cheapest hosts that answer well, read live (prices move; one DeepSeek host went 10x in a day).
  if (provider === 'openrouter' && !route) route = await cheapestRoute(model);
  return { provider, model, effort, route, vision: entry?.vision };
}

// Limits that keep one account from crowding out everyone else or spending model money on films that are
// refunded: films running or queued at once, and failed (refunded) films a day. Admins are exempt.
const MAX_PROMPT_CHARS = 4000;
const ACTIVE_FILMS = { free: 1, creator: 2, pro: 3, enterprise: 3 };
const FAILED_FILMS_PER_DAY = 6;
const MAX_RETRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const recentFailures = (user, now = Date.now()) => (user.failedFilms ?? []).filter((t) => now - Date.parse(t) < DAY_MS);

function filmLimit(user) {
  if (isAdmin(user)) return null;
  if (mustVerifyEmail(user) && effectiveTier(user) === 'free') {
    return { status: 403, code: 'EMAIL_UNVERIFIED', message: `Confirm your email to make films: open the link we sent to ${user.email}.` };
  }
  let active = 0;
  for (const j of jobsByPromptId.values()) if (j.userId === user.id && (j.status === 'running' || j.status === 'queued')) active += 1;
  const max = ACTIVE_FILMS[effectiveTier(user)] ?? 1;
  if (active >= max) return { status: 429, code: 'TOO_MANY_ACTIVE', message: `You have ${active} film${active === 1 ? '' : 's'} in progress. Wait for ${active === 1 ? 'it' : 'one'} to finish.` };
  if (recentFailures(user).length >= FAILED_FILMS_PER_DAY) return { status: 429, code: 'TOO_MANY_FAILURES', message: 'Too many films failed today. Try again tomorrow, or contact support.' };
  return null;
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

// On every response. The API serves JSON, media and the sign-in popup page (which sets its own script policy):
// nothing may frame it, guess its content types, or load anything into its responses.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  ...(PUBLIC_BASE_URL.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

const server = http.createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
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
      // Public: up or not. Folders, keys' providers, models and the queue are for admins, and for a call from
      // inside the container (deploy scripts), which comes from loopback without a proxy header.
      const local = ['::1', '127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
      if (!local && !isAdmin(getAuthenticatedUser(req))) {
        return sendJson(req, res, 200, { success: true, status: 'ok', service: 'byreel-motion-studio-backend' });
      }
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

    // What a film should cost before it starts: the credits it holds (it is charged what it measures).
    if (pathname === '/api/billing/estimate' && method === 'GET') {
      const seconds = Math.max(1, Math.min(60, Math.round(Number(parsedUrl.searchParams.get('length')) || 15)));
      const provider = parsedUrl.searchParams.get('provider') || config.roles.builder || 'azure';
      const model = parsedUrl.searchParams.get('model') || config.providers[provider]?.model || '';
      const price = await modelPrice(provider, model);
      return sendJson(req, res, 200, { success: true, seconds, credits: estimateCredits(price, seconds), measured: Boolean(price) });
    }

    // The providers that can serve one of the Studio's OpenRouter models, for the provider picker.
    if (pathname === '/api/models/routes' && method === 'GET') {
      const model = parsedUrl.searchParams.get('model') || '';
      if (!catalogEntry('openrouter', model)) return sendError(req, res, 404, 'Not one of the Studio\'s OpenRouter models.', 'UNKNOWN_MODEL');
      try {
        const providers = await openRouterProviders(model);
        return sendJson(req, res, 200, { success: true, model, sorts: OPENROUTER_ROUTE_SORTS, providers });
      } catch {
        return sendError(req, res, 503, "Couldn't reach OpenRouter right now.", 'ROUTES_UNAVAILABLE');
      }
    }

    if ((pathname === '/api/providers' || pathname === '/api/models') && method === 'GET') {
      const statusList = providerStatus();
      const catalog = MODEL_CATALOG.map((group) => ({ ...group, ready: statusList.find((p) => p.name === group.provider)?.ready ?? false }));

      return sendJson(req, res, 200, {
        success: true,
        current: {
          provider: config.roles.builder || 'azure',
          model: config.providers[config.roles.builder || 'azure']?.model || 'gpt-5-mini',
          effort: config.providers[config.roles.builder || 'azure']?.effort || 'xhigh',
        },
        providers: statusList,
        catalog,
      });
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
      const body = await readBody(req, 64 * 1024);
      const email = String(body.email || '').toLowerCase().trim();
      const password = String(body.password || '');

      if (!email || !password) {
        return sendError(req, res, 400, 'Email and password are required.', 'VALIDATION_ERROR');
      }
      // Password guessing: a handful of wrong passwords per account, and a cap per network, per 15 minutes.
      const loginWindowMs = 15 * 60 * 1000;
      if (rateHit(`login:${clientIp(req)}`, loginWindowMs) > 30 || rateCount(`login-fail:${email}`) >= 8) {
        return sendError(req, res, 429, 'Too many sign-in attempts. Please wait 15 minutes and try again.', 'TOO_MANY_ATTEMPTS');
      }
      const failed = () => {
        rateHit(`login-fail:${email}`, loginWindowMs);
        return sendError(req, res, 401, 'Invalid email or password.', 'INVALID_CREDENTIALS');
      };

      const user = db.users.find((u) => u.email === email);
      if (!user || password.length > 200) return failed();

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

      if (!verifyPassword(password, user.passwordHash)) return failed();

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
      const body = await readBody(req, 64 * 1024);
      const email = String(body.email || '').toLowerCase().trim();
      const password = String(body.password || '');
      const name = String(body.name || email.split('@')[0] || 'Studio Creator').trim();
      const plan = String(body.plan || 'pro').toLowerCase();

      // Sign-ups from one address: a few accounts a day, so free credits can't be farmed by script.
      const ip = clientIp(req);
      if (rateHit(`register:${ip}`, 60 * 60 * 1000) > 20 || rateCount(`accounts:${ip}`) >= 5) {
        return sendError(req, res, 429, 'Too many sign-ups from this network. Please try again later.', 'TOO_MANY_ATTEMPTS');
      }

      if (!email || !password || !name) {
        return sendError(req, res, 400, 'Name, email, and password are required.', 'VALIDATION_ERROR');
      }
      if (email.length > 254 || name.length > 80 || password.length > 200) {
        return sendError(req, res, 400, 'Name, email or password is too long.', 'VALIDATION_ERROR');
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

      const user = defaultUser({ email, name, password, provider: 'email' });
      // The plan picked on the pricing page is remembered for checkout, never granted.
      if (['creator', 'pro', 'enterprise'].includes(plan)) user.plan.intended = plan;
      // Unconfirmed until the owner clicks the emailed link (an admin email or a payment's email match needs it).
      user.auth.emailVerified = false;
      db.users.push(user);
      rateHit(`accounts:${ip}`, 24 * 60 * 60 * 1000);

      const token = createToken(user.id);
      db.sessions[token] = user.id;
      saveDb();
      const sent = await sendVerificationEmail(user, req.headers.origin);

      setAuthCookies(res, token);
      return sendJson(req, res, 201, {
        success: true,
        message: sent ? 'Account created. Check your inbox to confirm your email.' : 'Account created successfully',
        token,
        user: sanitizeUser(user),
      });
    }

    // The link in the verification email: confirms the address, then returns to the app.
    if (pathname === '/api/verify-email' && method === 'GET') {
      const token = parsedUrl.searchParams.get('token') || '';
      const to = appOrigin(parsedUrl.searchParams.get('to'));
      const hash = sha256(token);
      const user = token && db.users.find((u) => u.auth?.verify?.hash === hash && Date.parse(u.auth.verify.expiresAt) > Date.now());
      if (!user) {
        res.writeHead(302, { Location: `${to}/login?error=${encodeURIComponent('This confirmation link has expired. Sign in to get a new one.')}` });
        return res.end();
      }
      user.auth.emailVerified = true;
      delete user.auth.verify;
      saveDb();
      res.writeHead(302, { Location: `${to}/dashboard?verified=1` });
      return res.end();
    }

    if (pathname === '/api/verify-email/resend' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in first.', 'UNAUTHORIZED');
      if (!mustVerifyEmail(user)) return sendJson(req, res, 200, { success: true, message: 'Your email is already confirmed.' });
      if (rateHit(`verify-resend:${user.id}`, 60 * 60 * 1000) > 3) {
        return sendError(req, res, 429, 'We sent a few links already. Check your inbox and spam, or try again in an hour.', 'TOO_MANY_ATTEMPTS');
      }
      const sent = await sendVerificationEmail(user, req.headers.origin);
      if (!sent) return sendError(req, res, 502, 'Could not send the email right now. Please try again shortly.', 'EMAIL_FAILED');
      return sendJson(req, res, 200, { success: true, message: `We sent a new link to ${user.email}.` });
    }

    if (pathname === '/api/google/url' && method === 'GET') {
      const origin = appOrigin(parsedUrl.searchParams.get('origin'));
      const mode = parsedUrl.searchParams.get('mode') || 'login';
      const plan = parsedUrl.searchParams.get('plan') || 'pro';
      const url = `${PUBLIC_BASE_URL}/api/google/auth?origin=${encodeURIComponent(origin)}&mode=${encodeURIComponent(mode)}&plan=${encodeURIComponent(plan)}&popup=true`;
      return sendJson(req, res, 200, { success: true, url });
    }

    // Where a full-page (non-popup) redirect hands the session to the frontend's own callback page, which
    // reads `token` and fetches the profile itself (see app/auth/callback). The token rides in the fragment,
    // which browsers never send to a server or put in a Referer.
    function authCallbackUrl(origin, token, user) {
      const name = encodeURIComponent(user?.profile?.displayName || user?.email?.split('@')[0] || 'Creator');
      return `${origin}/auth/callback#token=${encodeURIComponent(token)}&name=${name}`;
    }

    // JSON that is safe inside a <script>: a "</script>" in a name or message can't end the block.
    const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

    // The page the sign-in popup ends on. Its one inline script runs by nonce; nothing else may load.
    function sendPopup(res, opts, headers = {}) {
      const nonce = crypto.randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
        ...headers,
      });
      return res.end(googlePopupHtml({ ...opts, nonce }));
    }

    function googlePopupHtml({ type, token, user, message, origin, fallbackUrl, nonce }) {
      const payload = type === 'GOOGLE_AUTH_SUCCESS' ? { type, token, user: sanitizeUser(user) } : { type, message };
      return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${type === 'GOOGLE_AUTH_SUCCESS' ? 'Signed in' : 'Sign-in failed'}</title></head>
  <body style="background:#111110;color:#fcfbf7;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <script nonce="${nonce}">
      (function() {
        var payload = ${scriptJson(payload)};
        if (window.opener) {
          window.opener.postMessage(payload, ${scriptJson(origin)});
          window.close();
        } else {
          window.location.href = ${scriptJson(fallbackUrl)};
        }
      })();
    </script>
    <p>${type === 'GOOGLE_AUTH_SUCCESS' ? 'Signed in to Motion Studio. Closing window...' : 'Could not sign in with Google. Closing window...'}</p>
  </body>
</html>`;
    }

    if (pathname === '/api/google/auth' && method === 'GET') {
      const origin = appOrigin(parsedUrl.searchParams.get('origin'));
      const mode = parsedUrl.searchParams.get('mode') || 'login';
      const plan = parsedUrl.searchParams.get('plan') || 'free';
      const popup = parsedUrl.searchParams.get('popup') === 'true';

      // Real Google OAuth: send the browser to Google's own consent screen. The state is signed, and its nonce
      // is also left in this browser as a cookie, so a callback finishes only the sign-in this browser began.
      if (googleClient) {
        const nonce = crypto.randomBytes(16).toString('base64url');
        const authUrl = googleClient.generateAuthUrl({
          access_type: 'online',
          scope: ['openid', 'email', 'profile'],
          state: signGoogleState({ origin, mode, plan, popup, nonce, iat: Date.now() }),
          prompt: 'select_account',
        });
        res.writeHead(302, { Location: authUrl, 'Set-Cookie': googleNonceCookie(nonce, GOOGLE_STATE_TTL_MS / 1000) });
        return res.end();
      }
      if (IS_PRODUCTION) {
        res.writeHead(302, { Location: `${origin}/login?error=${encodeURIComponent('Google sign-in is not available right now.')}` });
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
        return sendPopup(res, {
          type: 'GOOGLE_AUTH_SUCCESS',
          token,
          user,
          origin,
          fallbackUrl: authCallbackUrl(origin, token, user),
        });
      }
      res.writeHead(302, { Location: authCallbackUrl(origin, token, user) });
      return res.end();
    }

    // Google redirects here after the user approves (or cancels) the consent screen.
    if (pathname === '/api/google/callback' && method === 'GET') {
      const code = parsedUrl.searchParams.get('code');
      const oauthError = parsedUrl.searchParams.get('error');
      const signed = readGoogleState(parsedUrl.searchParams.get('state'));
      // A forged, stale or tampered state is ignored entirely; its origin in particular is never used.
      const state = { mode: 'login', plan: 'free', popup: true, ...(signed || {}), origin: appOrigin(signed?.origin) };
      const nonceCookie = parseCookies(req).g_nonce;
      const sameBrowser = Boolean(signed?.nonce && nonceCookie && nonceCookie === signed.nonce);

      const fail = (message) => {
        const errorUrl = `${state.origin}/login?error=${encodeURIComponent(message)}`;
        if (state.popup === false) {
          res.writeHead(302, { Location: errorUrl, 'Set-Cookie': googleNonceCookie('', 0) });
          return res.end();
        }
        return sendPopup(res, { type: 'GOOGLE_AUTH_ERROR', message, origin: state.origin, fallbackUrl: errorUrl }, { 'Set-Cookie': googleNonceCookie('', 0) });
      };

      if (oauthError) return fail('Google sign-in was cancelled.');
      if (!code || !googleClient) return fail('Google sign-in is not configured on this server.');
      if (!sameBrowser) return fail('This sign-in link has expired. Please start again.');

      try {
        const { tokens } = await googleClient.getToken(code);
        const ticket = await googleClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload?.email) return fail('Google did not return an email address.');

        const user = upsertGoogleUser({
          googleId: payload.sub,
          email: payload.email,
          emailVerified: payload.email_verified === true,
          name: payload.name,
          picture: payload.picture,
          plan: state.plan,
        });
        if (!user) return fail('This email already has an account. Sign in with your password.');
        if (payload.email_verified) user.auth.emailVerified = true;

        const token = createToken(user.id);
        db.sessions[token] = user.id;
        saveDb();
        setAuthCookies(res, token, [googleNonceCookie('', 0)]);

        const targetCallbackUrl = authCallbackUrl(state.origin, token, user);

        if (state.popup === false) {
          res.writeHead(302, { Location: targetCallbackUrl });
          return res.end();
        }

        return sendPopup(res, {
          type: 'GOOGLE_AUTH_SUCCESS',
          token,
          user,
          origin: state.origin,
          fallbackUrl: targetCallbackUrl,
        });
      } catch (err) {
        console.error('[server] Google OAuth callback failed:', err?.message || err);
        return fail('Could not complete Google sign-in.');
      }
    }

    if ((pathname === '/api/google' || pathname === '/api/google/register') && method === 'POST') {
      const body = await readBody(req, 64 * 1024);
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
            emailVerified: payload.email_verified === true,
            name: payload.name,
            picture: payload.picture,
            plan,
          });
          if (!user) return sendError(req, res, 409, 'This email already has an account. Sign in with your password.', 'EMAIL_IN_USE');
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
      if (IS_PRODUCTION) return sendError(req, res, 503, 'Google sign-in is not available right now.', 'GOOGLE_NOT_CONFIGURED');

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

    // Deleting an account removes everything it owns: profile, sessions and API keys, its films (records and
    // files) and its chats. It needs the password (an account without one types its email), and it waits while
    // a paid plan would still renew or a film is still being made.
    if (pathname === '/api/user/me' && method === 'DELETE') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to delete your account.', 'UNAUTHORIZED');
      const body = await readBody(req);
      const windowMs = 15 * 60 * 1000;
      if (rateCount(`delete-fail:${user.id}`) >= 8) {
        return sendError(req, res, 429, 'Too many attempts. Please wait 15 minutes and try again.', 'TOO_MANY_ATTEMPTS');
      }
      const confirmed = user.passwordHash
        ? verifyPassword(String(body.password || ''), user.passwordHash)
        : String(body.confirm || '').trim().toLowerCase() === String(user.email || '').toLowerCase();
      if (!confirmed) {
        rateHit(`delete-fail:${user.id}`, windowMs);
        return sendError(req, res, 403, user.passwordHash ? 'That password is not right.' : 'Type your email address to confirm.', 'NOT_CONFIRMED');
      }
      const p = user.plan;
      if (p?.source === 'dodo' && ['active', 'past_due'].includes(p.status) && !p.cancelAtPeriodEnd) {
        return sendError(req, res, 409, 'Cancel your plan in Billing first, so you are not charged again. Then delete the account.', 'PLAN_ACTIVE');
      }
      const owned = Array.from(jobsByPromptId.values()).filter((j, i, all) => j.userId === user.id && all.indexOf(j) === i);
      if (owned.some((j) => j.status === 'queued' || j.status === 'running')) {
        return sendError(req, res, 409, 'A video is still being made. Delete the account once it has finished.', 'FILM_RUNNING');
      }

      for (const j of owned) {
        jobsByPromptId.delete(j.promptId);
        if (j.harnessJobId) {
          jobsByPromptId.delete(j.harnessJobId);
          jobsByHarnessId.delete(j.harnessJobId);
          if (/^[\w-]+$/.test(j.harnessJobId)) fs.rmSync(path.join(JOBS_DIR, j.harnessJobId), { recursive: true, force: true });
        }
        if (db.promptMap) delete db.promptMap[j.promptId];
      }
      db.revokedTokens ??= {};
      for (const [token, id] of Object.entries(db.sessions ?? {})) {
        if (id !== user.id) continue;
        db.revokedTokens[token] = true;
        delete db.sessions[token];
      }
      const current = currentToken(req);
      if (current) db.revokedTokens[current] = true;
      db.apiKeys = (db.apiKeys ?? []).filter((k) => k.userId !== user.id);
      for (const store of ['brandKits', 'assets']) if (db[store]) delete db[store][user.id];
      if (Array.isArray(db.conversations)) db.conversations = db.conversations.filter((c) => c.userId !== user.id);
      db.users = db.users.filter((u) => u.id !== user.id);
      fs.rmSync(chatStorePath(user.id), { force: true });
      saveDb();
      console.warn(`[server] account ${user.id} deleted by its owner (${owned.length} film(s))`);
      clearAuthCookies(res);
      return sendJson(req, res, 200, { success: true, message: 'Your account and everything in it has been deleted.' });
    }

    if (pathname === '/api/user/profile' && method === 'PATCH') {
      const user = getAuthenticatedUser(req);
      if (!user) {
        return sendError(req, res, 401, 'Please sign in to update your profile.', 'UNAUTHORIZED');
      }

      const body = await readBody(req);

      // A new email or password needs the current password: a stolen session alone can't take the account. The
      // checks come before any change, so a refused request changes nothing.
      const newEmail = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
      const changingEmail = Boolean(newEmail) && newEmail !== user.email;
      if (changingEmail || body.newPassword) {
        if (!user.passwordHash) {
          return sendError(req, res, 400, 'This account signs in with Google, so its email and password come from Google.', 'USE_GOOGLE_AUTH');
        }
        if (!body.currentPassword || !verifyPassword(String(body.currentPassword), user.passwordHash)) {
          return sendError(req, res, 400, 'Current password is incorrect.', 'INVALID_PASSWORD');
        }
      }
      if (changingEmail) {
        if (newEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
          return sendError(req, res, 400, 'Please enter a valid email address.', 'VALIDATION_ERROR');
        }
        if (db.users.some((u) => u.email === newEmail && u.id !== user.id)) {
          return sendError(req, res, 409, 'An account with this email address already exists.', 'EMAIL_IN_USE');
        }
      }
      if (body.newPassword && (String(body.newPassword).length < 8 || String(body.newPassword).length > 200)) {
        return sendError(req, res, 400, 'New password must be 8 to 200 characters long.', 'WEAK_PASSWORD');
      }

      if (body.displayName && typeof body.displayName === 'string') {
        const trimmed = body.displayName.trim().slice(0, 80);
        if (trimmed.length > 0) {
          user.profile.displayName = trimmed;
          const parts = trimmed.split(/\s+/);
          user.profile.firstName = parts[0] || '';
          user.profile.lastName = parts.slice(1).join(' ') || '';
        }
      }

      if (changingEmail) {
        user.email = newEmail;
        // A new address is unconfirmed until its owner clicks the link sent to it.
        user.auth.emailVerified = false;
      }

      if (body.company !== undefined) {
        user.profile.company = String(body.company).trim().slice(0, 120);
      }

      if (body.bio !== undefined || body.role !== undefined) {
        user.profile.bio = String(body.bio ?? body.role ?? '').trim().slice(0, 500);
      }

      if (body.avatarUrl !== undefined) {
        user.profile.avatarUrl = String(body.avatarUrl).trim() || null;
      }

      if (body.newPassword) user.passwordHash = hashPassword(String(body.newPassword));

      // A new email or password ends every other session of this account.
      if (changingEmail || body.newPassword) {
        const current = currentToken(req);
        db.revokedTokens ??= {};
        for (const [token, id] of Object.entries(db.sessions ?? {})) {
          if (id !== user.id || token === current) continue;
          db.revokedTokens[token] = true;
          delete db.sessions[token];
        }
      }

      saveDb();
      if (changingEmail) await sendVerificationEmail(user, req.headers.origin);
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

      // This endpoint used to set any tier for free. Plans now change only through Dodo: checkout for a new or
      // different plan, the customer portal to cancel.
      return sendError(req, res, 402, 'Plans change through checkout: use POST /api/billing/checkout, or the billing portal to cancel.', 'USE_CHECKOUT');
    }

    // =========================================================================
    // 3. PROMPT QUEUE & MULTI-AGENT HARNESS ORCHESTRATION
    // =========================================================================
    if (pathname === '/api/prompt' && method === 'POST') {
      // Films cost credits, so they need an account (this used to bill anonymous requests to the first user).
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to make a video.', 'UNAUTHORIZED');
      const body = await readBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) {
        return sendError(req, res, 400, 'Field "prompt" is required and must be a non-empty string.', 'EMPTY_PROMPT');
      }
      if (prompt.length > MAX_PROMPT_CHARS) {
        return sendError(req, res, 400, `Keep the request under ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters (this one has ${prompt.length.toLocaleString('en-US')}).`, 'PROMPT_TOO_LONG');
      }

      const promptId =
        typeof body.promptId === 'string' && body.promptId.trim()
          ? body.promptId.trim()
          : `p-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

      // Idempotency check
      if (jobsByPromptId.has(promptId)) {
        const existing = jobsByPromptId.get(promptId);
        if (!canSeeJob(user, existing)) return sendError(req, res, 409, 'This prompt id is taken; send a new one.', 'PROMPT_ID_TAKEN');
        return sendJson(req, res, 200, {
          success: true,
          job: presentJob(existing),
          message: 'Prompt job already exists',
        });
      }

      const ratio = ['16:9', '9:16', '1:1'].includes(body.ratio) ? body.ratio : '16:9';
      const durationS = Number.isFinite(Number(body.length))
        ? Math.max(1, Math.min(60, Math.round(Number(body.length))))
        : 15;
      const inheritedTheme = resolveThemeFromJob(body.themeFrom, user);
      // An edit of one of this user's finished films: its project is the starting point (see harness edit.js).
      let editOf = null;
      if (typeof body.editOf === 'string' && body.editOf) {
        const base = jobsByPromptId.get(body.editOf) || jobsByHarnessId.get(body.editOf);
        if (!base || !canSeeJob(user, base)) return sendError(req, res, 404, 'The video to edit was not found.', 'EDIT_NOT_FOUND');
        if (base.status !== 'done' || !/^[\w-]+$/.test(base.harnessJobId || '') || !fs.existsSync(path.join(JOBS_DIR, base.harnessJobId, 'harness', 'plan.json'))) {
          return sendError(req, res, 409, 'Only a finished video can be edited.', 'EDIT_NOT_READY');
        }
        editOf = base.harnessJobId;
      }
      // The Studio's brand kit, as a short guide the model reads after the request. It stays out of the prompt
      // (the 4,000-character budget and the title are the person's own words); an edit keeps its film's look.
      const brand = !editOf && typeof body.brand === 'string' ? body.brand.trim().slice(0, 800) : '';

      // Only a model from the Studio list, and the pricier ones only on a paid plan.
      const choice = await chooseModel(user, body);
      if (choice.code) {
        const { status, ...rest } = choice;
        return sendJson(req, res, status, { success: false, error: choice.code, ...rest });
      }
      let { provider, model, effort, route, vision } = choice;

      const limited = filmLimit(user);
      if (limited) return sendError(req, res, limited.status, limited.message, limited.code);

      // The paywall: the plan's longest film, and the credits left for what this film should use. It holds that
      // estimate and is charged what it measures when it finishes.
      const estimate = estimateCredits(await modelPrice(provider, model), durationS);
      const blocked = paywall(user, durationS, Date.now(), estimate);
      if (blocked) {
        saveDb();
        return sendJson(req, res, 402, { success: false, error: blocked.code, ...blocked });
      }

      // Smart routing: if gpt-5-mini is requested and openai key is absent, use azure deployment
      if (model === 'gpt-5-mini' && provider === 'openai' && !config.providers.openai?.apiKey) {
        provider = 'azure';
      }

      const options = {
        aspect: ratio,
        duration: durationS,
        provider,
        model,
        effort,
        ...(route ? { route } : {}),
        // Sound effects are on unless the app turned them off.
        ...(body.sound === false ? { sound: false } : {}),
        // Saved in the job folder's request.json, so the film keeps its owner across restarts.
        userId: user.id,
        ...(inheritedTheme ? { theme: inheritedTheme } : {}),
      };

      const job = {
        id: `job_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        promptId,
        provider,
        model,
        effort,
        ...(route ? { route } : {}),
        ...(vision !== undefined ? { vision } : {}),
        status: activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'running',
        harnessJobId: null,
        stage: activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'preparing',
        activity:
          activeJobCount >= MAX_CONCURRENT_JOBS
            ? `Queued behind ${activeJobCount} active render...`
            : `Initializing HyperFrames with ${provider}/${model} (${effort})...`,
        theme: inheritedTheme || null,
        title: prompt.slice(0, 56),
        prompt,
        ...(brand ? { brand } : {}),
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
      pushLog(job, `Prompt queued: "${prompt.slice(0, 120)}" [${provider}/${model} · ${effort}${route ? ` · via ${route}` : ''}]`);

      // Held on submit, settled to the measured cost when it finishes, refunded if it fails.
      charge(user, job, durationS, estimate);
      persistJobRecord(job);
      if (user.usage?.generations) {
        user.usage.generations.daily += 1;
        user.usage.generations.monthly += 1;
        user.usage.generations.lifetime += 1;
      }
      saveDb();

      if (editOf) {
        job.editOf = editOf;
        pushLog(job, `Editing ${editOf}`);
      }
      enqueueHarnessExecution({
        job,
        mode: editOf ? 'edit' : 'run',
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

      // A retry is a new attempt by the job's owner: it pays again, since a failed film was refunded.
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to retry.', 'UNAUTHORIZED');
      if (!job || !canSeeJob(user, job)) {
        return sendError(req, res, 404, `Job "${promptId}" not found`, 'JOB_NOT_FOUND');
      }
      // Only a failed film is retried: one that is running or done would run again without paying.
      if (job.status !== 'failed') return sendError(req, res, 409, 'Only a failed film can be retried.', 'NOT_RETRYABLE');
      if ((job.retries ?? 0) >= MAX_RETRIES && !isAdmin(user)) {
        return sendError(req, res, 429, `This film was retried ${MAX_RETRIES} times. Start a new one.`, 'TOO_MANY_RETRIES');
      }
      const limited = filmLimit(user);
      if (limited) return sendError(req, res, limited.status, limited.message, limited.code);
      if (!job.credits || job.creditsRefunded) {
        const estimate = estimateCredits(await modelPrice(job.provider, job.model), job.durationS || 15);
        const blocked = paywall(user, job.durationS || 15, Date.now(), estimate);
        if (blocked) return sendJson(req, res, 402, { success: false, error: blocked.code, ...blocked });
        charge(user, job, job.durationS || 15, estimate);
        saveDb();
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
      job.retries = (job.retries ?? 0) + 1;
      job.updatedAt = new Date().toISOString();
      pushLog(job, `Retry requested (${canResumeOnDisk ? 'resuming' : 'restarting'})`);
      persistJobRecord(job);

      enqueueHarnessExecution({
        job,
        mode: job.editOf ? 'edit' : canResumeOnDisk ? 'resume' : 'run',
        resumeDir: canResumeOnDisk ? resumeDir : undefined,
        options: {
          aspect: job.ratio || '16:9',
          duration: job.durationS || 15,
          provider: job.provider,
          model: job.model,
          effort: job.effort,
          ...(job.route ? { route: job.route } : {}),
          userId: job.userId,
          ...(job.theme && job.theme !== 'custom' ? { theme: job.theme } : {}),
        },
      });

      return sendJson(req, res, 200, {
        success: true,
        job: presentJob(job),
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
      // Someone else's film is "not found", never "forbidden": its id says nothing about whether it exists.
      if (!job || !canSeeJob(getAuthenticatedUser(req), job)) {
        return sendError(req, res, 404, `No generation job found for promptId "${promptId}".`, 'PROMPT_NOT_FOUND');
      }
      return sendJson(req, res, 200, {
        success: true,
        job: presentJob(job),
      });
    }

    // =========================================================================
    // 4. VIDEO STREAMING, THUMBNAILS, PROJECTS & EXPORTS
    // =========================================================================
    const videoStreamMatch = /^\/api\/videos\/([^/]+)\/final\.mp4$/.exec(pathname);
    if (videoStreamMatch && (method === 'GET' || method === 'HEAD')) {
      const jobId = decodeURIComponent(videoStreamMatch[1]);
      if (!validMediaKey(jobId, parsedUrl.searchParams.get('k'))) return sendError(req, res, 404, 'Video not found', 'VIDEO_NOT_FOUND');
      const videoPath = path.join(JOBS_DIR, jobId, 'project', 'renders', 'final.mp4');
      const download = parsedUrl.searchParams.get('download') === '1';
      return streamVideoFile(req, res, videoPath, download ? `motion-${jobId}.mp4` : null);
    }

    const thumbMatch = /^\/api\/videos\/([^/]+)\/thumbnail\.jpg$/.exec(pathname);
    if (thumbMatch && (method === 'GET' || method === 'HEAD')) {
      const jobId = decodeURIComponent(thumbMatch[1]);
      if (!validMediaKey(jobId, parsedUrl.searchParams.get('k'))) return sendError(req, res, 404, 'Thumbnail not found', 'THUMBNAIL_NOT_FOUND');
      const jobDir = path.join(JOBS_DIR, path.basename(jobId));
      const snapPath = (await filmPoster(jobDir, jobsByHarnessId.get(jobId)?.durationS)) || findJobSnapshotPath(jobDir);
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
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your videos.', 'UNAUTHORIZED');
      syncDiskJobs();
      const list = Array.from(jobsByHarnessId.values()).filter((j) => canSeeJob(user, j)).map(presentJob).sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
      return sendJson(req, res, 200, {
        success: true,
        jobs: list,
        videos: list.filter((j) => j.play && j.play.length > 0),
      });
    }

    if (pathname === '/api/projects' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your projects.', 'UNAUTHORIZED');
      syncDiskJobs();
      const projects = Array.from(jobsByHarnessId.values())
        .filter((j) => canSeeJob(user, j))
        .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
        .map((j) => ({
          id: j.harnessJobId || j.id,
          title: j.title || 'Motion Composition',
          timecode: `00:${String(Math.round(j.durationS || 15)).padStart(2, '0')}`,
          thumbnail: j.harnessJobId ? buildThumbnailUrl(j.harnessJobId) : null,
          videoUrl: presentJob(j).play?.[0] || null,
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
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your exports.', 'UNAUTHORIZED');
      syncDiskJobs();
      const exportsList = [];
      for (const j of jobsByHarnessId.values()) {
        if (!j.harnessJobId || !canSeeJob(user, j)) continue;
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
            downloadUrl: `${buildVideoUrl(j.harnessJobId)}&download=1`,
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
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to export.', 'UNAUTHORIZED');
      const body = await readBody(req);
      const projectId = body.projectId || body.jobId;
      const found = projectId ? jobsByHarnessId.get(projectId) || jobsByPromptId.get(projectId) : null;
      const existing = canSeeJob(user, found) ? presentJob(found) : null;
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
      const activeKeys = db.apiKeys.filter((k) => k.status === 'active' && k.userId === user.id).map(({ secretHash, ...k }) => k);
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
        secretHash: sha256(rawSecret),
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
        apiKey: { ...apiKey, secretHash: undefined },
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
    // The Studio's chats, so they follow their owner to any browser. GET returns them all (newest first) with
    // the ids deleted elsewhere; PUT keeps the newer copy of a chat; DELETE leaves a tombstone so another
    // browser drops its copy instead of uploading it again.
    if (pathname === '/api/chats' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your chats.', 'UNAUTHORIZED');
      const store = readChatStore(user.id);
      const chats = Object.values(store.chats).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return sendJson(req, res, 200, { success: true, chats, deleted: Object.keys(store.deleted) });
    }

    const chatMatch = /^\/api\/chats\/([\w-]{1,100})$/.exec(pathname);
    if (chatMatch && (method === 'PUT' || method === 'DELETE')) {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to save chats.', 'UNAUTHORIZED');
      const id = chatMatch[1];
      const store = readChatStore(user.id);
      if (method === 'DELETE') {
        delete store.chats[id];
        store.deleted[id] = new Date().toISOString();
        writeChatStore(user.id, store);
        return sendJson(req, res, 200, { success: true });
      }
      // ?restore=1 is Undo right after a delete; otherwise a deleted chat stays deleted.
      if (store.deleted[id]) {
        if (parsedUrl.searchParams.get('restore') !== '1') return sendError(req, res, 410, 'This chat was deleted.', 'CHAT_DELETED');
        delete store.deleted[id];
      }
      let chat;
      try {
        chat = cleanChat(await readBody(req, MAX_CHAT_BYTES * 2), id);
      } catch (err) {
        return sendError(req, res, 400, err.message, 'INVALID_CHAT');
      }
      const stored = store.chats[id];
      // Two browsers editing one chat: the later edit wins, and the other gets it back to show.
      if (stored && String(stored.updatedAt) > chat.updatedAt) return sendJson(req, res, 409, { success: false, error: 'CHAT_NEWER', chat: stored });
      store.chats[id] = chat;
      trimChatStore(store);
      writeChatStore(user.id, store);
      return sendJson(req, res, 200, { success: true, chat });
    }

    // Each account sees and adds only its own conversations.
    if (pathname === '/api/conversations' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your conversations.', 'UNAUTHORIZED');
      return sendJson(req, res, 200, {
        success: true,
        conversations: (db.conversations || []).filter((c) => c.userId === user.id),
      });
    }

    if (pathname === '/api/conversations' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to start a conversation.', 'UNAUTHORIZED');
      if ((db.conversations || []).filter((c) => c.userId === user.id).length >= 500) {
        return sendError(req, res, 429, 'You have 500 conversations. Delete some to start another.', 'TOO_MANY_CONVERSATIONS');
      }
      const body = await readBody(req);
      const conv = {
        id: `c-${crypto.randomUUID()}`,
        userId: user.id,
        title: String(body.title || 'New video').trim().slice(0, 120),
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

    // =========================================================================
    // BILLING: Dodo Payments checkout, customer portal, webhooks, invoices (billing.mjs)
    // =========================================================================
    if (pathname === '/api/billing/invoices' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your invoices.', 'UNAUTHORIZED');
      const invoices = (user.billing?.invoices ?? []).map((i) => ({
        id: i.id,
        date: new Date(i.createdAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
        description: `Byreel ${user.plan?.tier ?? ''} subscription`.replace(/\s+/g, ' ').trim(),
        amount: `${i.currency === 'USD' ? '$' : ''}${i.amount.toFixed(2)} ${i.currency}`,
        status: i.status,
      }));
      return sendJson(req, res, 200, { success: true, invoices });
    }

    if (pathname === '/api/billing/checkout' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to subscribe.', 'UNAUTHORIZED');
      const body = await readBody(req);
      try {
        const r = await startCheckout({
          user,
          tier: String(body.tier || '').toLowerCase(),
          interval: body.interval === 'annual' ? 'annual' : 'monthly',
          returnUrl: `${frontendUrl(req)}/billing?checkout=success`,
        });
        return sendJson(req, res, 200, { success: true, ...r });
      } catch (err) {
        if (err instanceof BillingError) return sendError(req, res, err.status, err.message, err.code);
        throw err;
      }
    }

    if (pathname === '/api/billing/portal' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to manage billing.', 'UNAUTHORIZED');
      try {
        const url = await portalLink({ user, returnUrl: `${frontendUrl(req)}/billing` });
        return sendJson(req, res, 200, { success: true, url });
      } catch (err) {
        if (err instanceof BillingError) return sendError(req, res, err.status, err.message, err.code);
        throw err;
      }
    }

    // Pull the user's subscription from Dodo (the app calls this on return from checkout): the plan is right
    // even when a webhook is late or was never sent.
    if (pathname === '/api/billing/sync' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in.', 'UNAUTHORIZED');
      try {
        const r = await syncFromDodo(db, user);
        saveDb();
        for (const line of r.applied) console.log(`[billing] sync ${line}`);
        return sendJson(req, res, 200, { success: true, user: sanitizeUser(user), ...r });
      } catch (err) {
        if (err instanceof BillingError) return sendError(req, res, err.status, err.message, err.code);
        throw err;
      }
    }

    // The membership and usage dashboard: the plan, this period's credits, and the films that used them.
    if (pathname === '/api/usage' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendError(req, res, 401, 'Please sign in to see your usage.', 'UNAUTHORIZED');
      syncDiskJobs();
      const c = credits(user);
      const since = Date.parse(c.periodStart);
      const seen = new Set();
      const films = [...jobsByHarnessId.values(), ...jobsByPromptId.values()]
        .filter((j) => j.userId === user.id && !seen.has(j.promptId) && seen.add(j.promptId))
        .filter((j) => Date.parse(j.createdAt) >= since)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .map((j) => ({
          promptId: j.promptId,
          title: j.title,
          status: j.status,
          createdAt: j.createdAt,
          durationS: j.durationS ?? null,
          ratio: j.ratio ?? null,
          credits: j.credits ?? 0,
          refunded: Boolean(j.creditsRefunded),
          thumbnail: j.harnessJobId && j.status === 'done' ? buildThumbnailUrl(j.harnessJobId) : null,
          videoUrl: presentJob(j).play?.[0] ?? null,
        }));
      const p = user.plan ?? {};
      return sendJson(req, res, 200, {
        success: true,
        plan: {
          tier: c.tier,
          status: p.source === 'dodo' ? p.status : 'active',
          interval: p.source === 'dodo' ? p.billingInterval : null,
          renewsAt: p.source === 'dodo' ? p.currentPeriodEnd : null,
          cancelAtPeriodEnd: Boolean(p.cancelAtPeriodEnd),
          manageable: Boolean(p.customerId),
        },
        credits: { used: c.used, limit: c.limit, remaining: c.remaining, periodStart: c.periodStart, periodEnd: c.periodEnd },
        limits: { maxSeconds: PLANS[c.tier].maxSeconds, creditsPerFilm: await typicalCredits() },
        totals: {
          films: films.length,
          completed: films.filter((f) => f.status === 'done').length,
          failed: films.filter((f) => f.status === 'failed').length,
          seconds: films.filter((f) => f.status === 'done').reduce((n, f) => n + (f.durationS ?? 0), 0),
          creditsCharged: films.reduce((n, f) => n + (f.refunded ? 0 : f.credits), 0),
          creditsRefunded: films.reduce((n, f) => n + (f.refunded ? f.credits : 0), 0),
        },
        films: films.slice(0, 100),
      });
    }

    if (pathname === '/api/billing/status' && method === 'GET') {
      return sendJson(req, res, 200, { success: true, configured: billingConfigured() });
    }

    // Public: the pricing page reads plans, credits and real prices from here (the same Dodo products checkout
    // sells), and what a film costs in credits.
    if (pathname === '/api/billing/plans' && method === 'GET') {
      return sendJson(req, res, 200, {
        success: true,
        configured: billingConfigured(),
        plans: await listPlans(),
        creditsPerFilm: await typicalCredits(),
      });
    }

    // Dodo calls this. The signature is checked on the exact bytes received; each event is applied once.
    if (pathname === '/api/billing/webhook' && method === 'POST') {
      const raw = await readRawBody(req);
      if (!verifyWebhook(raw, req.headers)) {
        console.warn(`[billing] webhook rejected: ${req.headers['webhook-signature'] ? 'signature does not match DODO_PAYMENTS_WEBHOOK_KEY, or the timestamp is over 5 min old' : 'no webhook signature headers'}`);
        return sendError(req, res, 401, 'Invalid webhook signature.', 'INVALID_SIGNATURE');
      }
      const id = String(req.headers['webhook-id']);
      db.webhookIds ??= [];
      if (db.webhookIds.includes(id)) return sendJson(req, res, 200, { success: true, duplicate: true });
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return sendError(req, res, 400, 'Webhook body is not JSON.', 'BAD_REQUEST');
      }
      const result = applyEvent(db, event);
      db.webhookIds.push(id);
      if (db.webhookIds.length > 1000) db.webhookIds.splice(0, db.webhookIds.length - 1000);
      saveDb();
      console.log(`[billing] ${result}`);
      return sendJson(req, res, 200, { success: true });
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
