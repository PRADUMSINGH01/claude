// What each subagent may read from the skills, and what it starts with in its prompt.
// Agents see only a map (file names + one-line summaries); content arrives one section at a time.

const HF = 'hyperframes';
const CLI = 'hyperframes-cli';
const REG = 'hyperframes-registry';
const MEDIA = 'media-use';

// Files no role should spend budget on: upstream contribution, hosted rendering, telemetry, plugin plumbing.
const NEVER = [
  /plugin-installation\.md$/, /skill-lifecycle\.md$/, /cloud(run)?\.md$/, /lambda\.md$/, /feedback\.md$/,
  /contributing\.md$/, /templates\.md$/, /component-quality-bar\.md$/, /demo-html-pattern\.md$/,
  /telemetry-dashboard\.md$/, /upgrade-info-misc\.md$/, /CREDITS\.md$/, /setup-providers\.md$/,
];

export const ROLE_ACCESS = {
  planner: {
    purpose: 'turn the request into SPEC.md and a scene plan built from registry blocks and one theme',
    allow: {
      [HF]: [/^SKILL\.md$/, /^references\/(story|spec|look|storyboard|storyboard-format|sound|captions|overlays)\.md$/, /^references\/types\//, /^assets\/frame-presets\/[^/]+\/FRAME\.md$/],
      [REG]: [/^SKILL\.md$/, /^references\/(discovery|search|wiring-blocks|placeholder-material)\.md$/],
      [MEDIA]: [/^SKILL\.md$/, /^references\/(resolve|audio)\.md$/, /^audio\/references\/(bgm|sfx|tts)\.md$/],
    },
    preload: [
      { skill: HF, file: 'references/spec.md', section: 'the-template' },
    ],
  },
  builder: {
    purpose: 'write the HyperFrames composition from the plan, mounting the installed registry blocks',
    allow: {
      [HF]: [/^SKILL\.md$/, /^references\/(format|motion|film|sound|captions|overlays|runtimes|look|spec)\.md$/, /^references\/types\//],
      [CLI]: [/^SKILL\.md$/, /^references\/(init-and-scaffold|lint-validate-inspect|conventions|beats|doctor-browser)\.md$/],
      [REG]: [/^SKILL\.md$/, /^references\/(wiring-blocks|wiring-components|install-locations|search|discovery|placeholder-material)\.md$/, /^examples\//],
      [MEDIA]: [/^SKILL\.md$/, /^references\/(resolve|audio|local|mixing|grading|media-treatments|operations)\.md$/, /^audio\/references\//],
    },
    preload: [
      { skill: HF, file: 'SKILL.md', section: 'contract' },
      { skill: HF, file: 'SKILL.md', section: 'keep-it-editable' },
      { skill: HF, file: 'references/format.md', section: 'shape-of-a-project' },
      { skill: REG, file: 'SKILL.md', section: 'wiring' },
    ],
  },
  critic: {
    purpose: 'judge the built film against SPEC.md and the HyperFrames contract; list concrete defects',
    allow: {
      [HF]: [/^SKILL\.md$/, /^references\/(review|spec|look|motion|story|format|sound|captions)\.md$/, /^references\/types\//],
      [CLI]: [/^SKILL\.md$/, /^references\/lint-validate-inspect\.md$/],
      [REG]: [/^SKILL\.md$/, /^references\/wiring-(blocks|components)\.md$/],
    },
    preload: [
      { skill: HF, file: 'references/review.md', section: '2-what-to-look-for' },
    ],
  },
  fixer: {
    purpose: 'resolve the critic\'s issues with the smallest correct edits, then re-check',
    allow: {
      [HF]: [/^SKILL\.md$/, /^references\/(format|motion|film|sound|captions|overlays|runtimes|look|review)\.md$/],
      [CLI]: [/^SKILL\.md$/, /^references\/(lint-validate-inspect|conventions|doctor-browser|preview-render)\.md$/],
      [REG]: [/^SKILL\.md$/, /^references\/wiring-(blocks|components)\.md$/, /^references\/install-locations\.md$/],
      [MEDIA]: [/^SKILL\.md$/, /^references\/(mixing|media-treatments|local)\.md$/],
    },
    preload: [
      { skill: HF, file: 'SKILL.md', section: 'contract' },
      { skill: HF, file: 'references/format.md', section: 'shape-of-a-project' },
      { skill: CLI, file: 'SKILL.md', section: 'when-a-command-fails' },
    ],
  },
};

// Mandatory reading. An entry is met when any of its refs has been read: "skill/file#section", or a
// "skill/dir/" prefix (any section under it). Preloaded and attached sections count; so does an ancestor heading.
export const REQUIRED = {
  planner: [
    { what: 'the one thing the film says', refs: ['hyperframes/references/story.md#1-the-one-thing'] },
    { what: 'how the look becomes numbers', refs: ['hyperframes/references/look.md#the-look-line'] },
    { what: 'the guide for this kind of film (pick the matching file)', refs: ['hyperframes/references/types/'] },
  ],
  builder: [
    { what: 'variables (how block colours, fonts and copy are set)', refs: ['hyperframes/references/format.md#variables'] },
    { what: 'timing and the timeline', refs: ['hyperframes/references/format.md#timing-and-the-timeline'] },
    { what: 'fonts (theme faces need @font-face)', refs: ['hyperframes/references/format.md#fonts'] },
    { what: 'motion craft', refs: ['hyperframes/references/motion.md#motion-craft'] },
  ],
  critic: [
    { what: 'how to measure, then look', refs: ['hyperframes/references/review.md#1-measure-then-look'] },
    { what: 'how to write notes a fixer can act on', refs: ['hyperframes/references/review.md#3-notes-and-fixes'] },
  ],
  fixer: [
    { what: 'the lint errors and their fixes', refs: ['hyperframes/references/format.md#lint-errors-you-ll-meet-first'] },
  ],
};

function refMet(ref, readLog, lib) {
  const keys = [...readLog];
  if (ref.endsWith('/')) return keys.some((k) => k.startsWith(ref));
  if (readLog.has(ref)) return true;
  const [file, section] = ref.split('#');
  if (keys.some((k) => k.startsWith(`${file}#*@`))) return true;
  const [skill, ...rest] = file.split('/');
  const sections = lib.sections(skill, rest.join('/')) ?? [];
  const i = sections.findIndex((s) => s.id === section);
  // Reading an ancestor heading returned this section too.
  for (let j = i - 1, level = sections[i]?.level ?? 0; j >= 0 && level > 1; j--) {
    if (sections[j].level < level) {
      if (readLog.has(`${file}#${sections[j].id}`)) return true;
      level = sections[j].level;
    }
  }
  return false;
}

export function unmetReading(role, readLog, lib) {
  return (REQUIRED[role] ?? []).filter((r) => !r.refs.some((ref) => refMet(ref, readLog, lib)));
}

const callFor = (ref) => {
  if (ref.endsWith('/')) {
    const [skill, ...rest] = ref.slice(0, -1).split('/');
    return `skill_outline {skill: "${skill}", file: "${rest.join('/')}/<file>.md"} then read_skill one section`;
  }
  const [file, section] = ref.split('#');
  const [skill, ...rest] = file.split('/');
  return `read_skill {skill: "${skill}", file: "${rest.join('/')}", section: "${section}"}`;
};

export function readingChecklist(role, readLog, lib) {
  return (REQUIRED[role] ?? []).map((r) => {
    const done = r.refs.some((ref) => refMet(ref, readLog, lib));
    return `- [${done ? 'x' : ' '}] ${r.what}: ${done ? 'already provided' : callFor(r.refs[0])}`;
  }).join('\n');
}

export function readingGateMessage(role, readLog, lib) {
  const unmet = unmetReading(role, readLog, lib);
  if (!unmet.length) return null;
  return `Required reading is not done. Read these first (one call each), then retry:\n${unmet.map((r) => `- ${r.what}: ${callFor(r.refs[0])}`).join('\n')}`;
}

// Keys for sections already in the prompt, so they count as read.
export function preloadKeys(role) {
  return (ROLE_ACCESS[role].preload ?? []).map((p) => `${p.skill}/${p.file}#${p.section}`);
}

export function canRead(role, skill, rel) {
  if (NEVER.some((re) => re.test(rel))) return false;
  const rules = ROLE_ACCESS[role]?.allow[skill];
  return Boolean(rules?.some((re) => re.test(rel)));
}

export function allowedFiles(role, lib) {
  const out = [];
  for (const skill of Object.keys(ROLE_ACCESS[role].allow)) {
    const s = lib.get(skill);
    if (!s) continue;
    for (const rel of s.files.keys()) if (canRead(role, skill, rel)) out.push({ skill, rel });
  }
  return out;
}
