import { config } from '../config.js';
import { ROLE_ACCESS, preloadKeys, readingChecklist } from '../skills/access.js';
import { preloadText, skillMap } from '../tools/skill-tools.js';

// Skills are written for an interactive session with a person. The harness runs unattended.
export const HARNESS_RULES = `You are one stage of an unattended video pipeline (planner → builder → critic → fixer → render).
There is no person to ask and no one watching a preview. Where a skill says to ask, offer, wait or show the person, decide yourself and record the decision in your hand-off.
- Never run: render, preview, present, publish, cloud, lambda, cloudrun, open, upgrade, skills, feedback, usage, auth. The harness renders.
- Media in this sandbox: ${config.heygen
    ? 'HeyGen is enabled (music, images, voices, avatars through media-use).'
    : 'HeyGen is NOT available, so media-use cannot get music beds, stock images, HeyGen voices or avatars. Available: sound effects (bundled + Openverse), logos, media-treatment on files you have.'
  } Plan and build only with media you can actually get; a film without music is fine, a missing or fake file is not.${config.allowNetworkMedia ? '' : ' Network media is off: pass --local-only.'}
- The project root is your working folder. Paths are relative to it. Skill scripts live under $HF_SKILLS_DIR.
- Skills are read in pieces: skill_outline → read_skill one section → act. Read what the next step needs, not whole files. Your reading budget is limited.
- Prefer registry blocks and components to hand-building, and keep every colour and font on the theme.
- Narrate: with each tool call, write one short sentence saying what you are doing and why. It is logged for the operator.`;

export function rolePrompt(role, lib, body) {
  const access = ROLE_ACCESS[role];
  return [
    `# Role: ${role}`,
    `Your job: ${access.purpose}.`,
    HARNESS_RULES,
    body,
    '## Required reading (enforced: writes and your hand-off are refused until every box is ticked)',
    'Do these first, one call each. Then read further sections only as the work needs them.',
    readingChecklist(role, new Set(preloadKeys(role)), lib),
    '## Skill files you may read (content not loaded; use skill_outline / read_skill / search_skills)',
    skillMap(role, lib),
    '## Already loaded for you',
    preloadText(role, lib),
  ].join('\n\n');
}

export const fence = (label, text) => `<${label}>\n${String(text ?? '').trim()}\n</${label}>`;
