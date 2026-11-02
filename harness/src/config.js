import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const harnessRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(harnessRoot, '..');

const str = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const int = (name, fallback) => {
  const n = Number.parseInt(str(name), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (name, fallback) => {
  const v = str(name).toLowerCase();
  return v ? ['1', 'true', 'yes', 'on'].includes(v) : fallback;
};

// Every provider is reached through the OpenAI SDK's chat-completions API.
const providers = {
  claude: {
    kind: 'claude',
    apiKey: str('ANTHROPIC_API_KEY'),
    baseURL: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1/'),
    model: str('CLAUDE_MODEL', 'claude-sonnet-5-5'),
    effort: str('CLAUDE_EFFORT', ''),
    vision: bool('CLAUDE_VISION', true),
  },
  glm: {
    kind: 'glm',
    apiKey: str('GLM_API_KEY'),
    baseURL: str('GLM_BASE_URL', 'https://api.z.ai/api/paas/v4/'),
    model: str('GLM_MODEL', 'glm-4.6'),
    effort: str('GLM_EFFORT', ''),
    vision: bool('GLM_VISION', false),
  },
  // One key for many vendors' models (OpenAI-compatible). Ids are "vendor/model"; a bare "deepseek-v4.1-flash"
  // gets its vendor from its first word. OPENROUTER_* and OPEN_ROUTER_* names both work.
  openrouter: {
    kind: 'openrouter',
    apiKey: str('OPENROUTER_API_KEY', str('OPEN_ROUTER_API_KEY')),
    baseURL: str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1/'),
    model: ((m) => (m.includes('/') ? m : `${m.split('-')[0]}/${m}`))(str('OPENROUTER_MODEL', str('OPEN_ROUTER_MODEL', 'deepseek/deepseek-v4.1-flash'))),
    effort: str('OPENROUTER_EFFORT', str('OPEN_ROUTER_EFFORT', '')),
    vision: bool('OPENROUTER_VISION', bool('OPEN_ROUTER_VISION', true)),
  },
  azure: {
    kind: 'azure',
    apiKey: str('AZURE_OPENAI_API_KEY'),
    baseURL: str('AZURE_OPENAI_BASE_URL'),
    model: str('AZURE_OPENAI_DEPLOYMENT', 'gpt-5-mini'),
    effort: str('AZURE_EFFORT', 'low'),
    vision: bool('AZURE_VISION', true),
  },
  openai: {
    kind: 'openai',
    apiKey: str('OPENAI_API_KEY'),
    baseURL: str('OPENAI_BASE_URL', 'https://api.openai.com/v1/'),
    model: str('OPENAI_MODEL', 'gpt-5-mini'),
    effort: str('OPENAI_EFFORT', 'low'),
    vision: bool('OPENAI_VISION', true),
  },
  // Google's OpenAI-compatible endpoint.
  gemini: {
    kind: 'gemini',
    apiKey: str('GEMINI_API_KEY', str('GOOGLE_API_KEY')),
    baseURL: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai/'),
    model: str('GEMINI_MODEL', 'gemini-2.5-flash'),
    effort: str('GEMINI_EFFORT', 'low'),
    vision: bool('GEMINI_VISION', true),
  },
};

export const PROVIDER_NAMES = Object.keys(providers);

// PROVIDER switches every role at once; PLANNER/BUILDER/CRITIC/FIXER override single roles.
const base = str('PROVIDER', str('BUILDER', 'azure'));
const builder = str('BUILDER', base);

export const config = {
  skillsDir: path.resolve(repoRoot, str('SKILLS_DIR', '.agents/skills')),
  registryRawUrl: str('REGISTRY_RAW_URL', 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry'),
  jobsDir: path.resolve(repoRoot, str('JOBS_DIR', 'jobs')),
  hyperframesBin: str('HYPERFRAMES_BIN', path.join(harnessRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'hyperframes.cmd' : 'hyperframes')),
  shimsDir: path.join(harnessRoot, 'shims'),

  // Which provider plays each role: the role's own setting, else PROVIDER (else BUILDER, for older .env files).
  roles: {
    planner: str('PLANNER', base),
    builder,
    critic: str('CRITIC', base),
    fixer: str('FIXER', base),
  },
  providers,

  // Loop limits
  maxTurns: {
    planner: int('PLANNER_MAX_TURNS', 24),
    builder: int('BUILDER_MAX_TURNS', 90),
    critic: int('CRITIC_MAX_TURNS', 24),
    fixer: int('FIXER_MAX_TURNS', 50),
  },
  reviewRounds: int('REVIEW_ROUNDS', 2),
  maxOutputTokens: int('MAX_OUTPUT_TOKENS', 16000),
  // Per model request. Reasoning models (GLM with thinking) can take several minutes on a full plan;
  // a dropped connection still ends here and is retried (each retry is logged).
  requestTimeoutSec: int('REQUEST_TIMEOUT_SEC', 600),
  contextCharBudget: int('CONTEXT_CHAR_BUDGET', 120_000),

  // Skill reading: a single read returns at most this much; each role has a total budget.
  skillReadChars: int('SKILL_READ_CHARS', 7000),
  skillBudget: {
    planner: int('PLANNER_SKILL_BUDGET', 60_000),
    builder: int('BUILDER_SKILL_BUDGET', 110_000),
    critic: int('CRITIC_SKILL_BUDGET', 45_000),
    fixer: int('FIXER_SKILL_BUDGET', 60_000),
  },

  // Tools and sandbox
  toolOutputChars: int('TOOL_OUTPUT_CHARS', 12_000),
  commandTimeoutSec: int('COMMAND_TIMEOUT_SEC', 600),
  renderTimeoutSec: int('RENDER_TIMEOUT_SEC', 1800),
  jobDiskMb: int('JOB_DISK_MB', 4096),
  renderQuality: str('RENDER_QUALITY', 'looks'), // draft | looks | delivery
  // The render host has a GPU. Without one, plans skip WebGPU-only registry items and a render that still
  // needs WebGPU runs it in software (slow, but it finishes).
  renderGpu: bool('RENDER_GPU', false),
  allowNetworkMedia: bool('ALLOW_NETWORK_MEDIA', true),
  heygen: bool('HEYGEN_ENABLED', Boolean(process.env.HEYGEN_API_BASE)),
  // Provider to use for a turn the main provider's content filter keeps blocking (optional).
  fallbackProvider: str('FALLBACK_PROVIDER'),
  sandboxEnabled: bool('SANDBOX_ENABLED', typeof process.getuid === 'function' && process.getuid() === 0),
  sandboxUidBase: int('SANDBOX_UID_BASE', 20000),
  sandboxMaxProcs: int('SANDBOX_MAX_PROCS', 1024),
};

// Building and fixing need more deliberate reasoning than the provider default.
const ROLE_EFFORT = {
  planner: str('PLANNER_EFFORT'),
  builder: str('BUILDER_EFFORT', 'medium'),
  critic: str('CRITIC_EFFORT'),
  fixer: str('FIXER_EFFORT', 'medium'),
};

// An effort chosen for one run (--effort, or a film's setting in the app) wins over the role defaults above:
// without it a film set to "low" still wrote its scenes at the builder's "medium".
export function useEffort(effort) {
  config.runEffort = effort || '';
}

// One film's provider, model and effort, seen by everything that film runs (its async work included) and by
// nothing else: the server runs films side by side, and a shared setting would let one film's choice
// overwrite another's mid-run.
const runSettings = new AsyncLocalStorage();
export const withRunSettings = (settings, fn) => runSettings.run(settings ?? {}, fn);

export function providerForRole(role) {
  const run = runSettings.getStore() ?? {};
  const name = run.provider || config.roles[role];
  const base = config.providers[name];
  const p = base && { ...base, model: (run.provider && run.model) || base.model, effort: run.effort || config.runEffort || ROLE_EFFORT[role] || base.effort };
  if (!p) throw new Error(`Unknown provider "${name}" for ${role}; use one of ${Object.keys(providers).join(', ')}`);
  if (!p.apiKey) throw new Error(`Provider "${name}" (${role}) has no API key; set ${KEY_VAR[name] ?? 'its key'} in .env`);
  if (!p.baseURL) throw new Error(`Provider "${name}" (${role}) has no base URL`);
  return { name, ...p };
}

const KEY_VAR = { claude: 'ANTHROPIC_API_KEY', glm: 'GLM_API_KEY', openrouter: 'OPENROUTER_API_KEY', azure: 'AZURE_OPENAI_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

// --provider on the CLI: every role, this run only.
export function useProvider(name, roles = Object.keys(config.roles)) {
  if (!config.providers[name]) throw new Error(`Unknown provider "${name}"; use one of ${PROVIDER_NAMES.join(', ')}`);
  for (const r of roles) config.roles[r] = name;
}

export function providerStatus() {
  return PROVIDER_NAMES.map((name) => {
    const p = config.providers[name];
    const roles = Object.entries(config.roles).filter(([, v]) => v === name).map(([r]) => r);
    return { name, ready: Boolean(p.apiKey && p.baseURL), keyVar: KEY_VAR[name], model: p.model, vision: p.vision, effort: p.effort, roles };
  });
}
