import { makeSkillTools } from '../tools/skill-tools.js';
import { makeRegistryTools } from '../tools/registry-tools.js';
import { makeFileTools, makeHfTool, makeReviewTools } from '../tools/project-tools.js';
import { fence, rolePrompt } from './common.js';

const BODY = `## How to review
You cannot edit. You judge, with evidence, and hand concrete defects to the fixer.

Check in this order and stop adding issues once the blockers are clear:
1. Contract: every check error is a blocker. Read the condensed check report you were given.
2. Plan fidelity: every planned scene exists with its timing, copy and registry block; nothing invented.
3. Theme: colours and fonts in index.html, scenes and block variables match theme.json exactly. A block left on its demo palette or font is major.
4. Frames: look at the contact sheets. Unreadable or cut-off text, empty or static frames, overlaps, the hero missing, placeholder copy or demo images left from a block (stock photos, sample names, "lorem", text the plan never asked for): major. A block whose look contradicts the brief (e.g. a photo carousel for a type-only title card) is major: say which registry item to use instead, or hand-build.
4b. Layers: a scene with layer "background" (or "overlay") must be visible in every frame of its range. If a main scene paints an opaque ground over a planned background, that is major: name the scene and the element whose background must become transparent. Snapshot a time inside each main scene the layer spans to check.
5. Motion and story against SPEC.md: the one hero move per shot, hand-offs between scenes, eases; read review.md/motion.md sections when needed.
6. Facts: every number, date, name and claim on screen must come from the request. A figure the request did not give (an invented population, a made-up chart value, a guessed date) is a blocker, even when it looks plausible.
7. Audio as planned. Media the sandbox cannot provide (see the media line above) is minor at most, never a blocker; a placeholder or fake media file is a blocker.

Each issue: where (file + selector or time), the evidence you saw, and the fix as an instruction the fixer can carry out, with the skill section it comes from when there is one.
verdict "ship" only when there are no blockers or majors left. Minor polish alone is "ship".`;

const issue = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short id, e.g. i1' },
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    category: { type: 'string', enum: ['contract', 'plan', 'theme', 'registry', 'layout', 'text', 'motion', 'story', 'audio', 'timing', 'render'] },
    where: { type: 'string', description: 'file + selector and/or time in seconds' },
    evidence: { type: 'string' },
    fix: { type: 'string' },
    skill_ref: { type: 'string', description: 'e.g. hyperframes/references/format.md#variables' },
  },
  required: ['id', 'severity', 'category', 'where', 'evidence', 'fix'],
  additionalProperties: false,
};

export const criticHandoff = {
  name: 'submit_review',
  description: 'Hand your verdict and issues to the harness.',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['ship', 'fix'] },
      score: { type: 'integer', minimum: 1, maximum: 10, description: 'overall quality against SPEC.md' },
      issues: { type: 'array', items: issue },
      previous: {
        type: 'array',
        description: 'Round 2+: status of each issue from the previous round',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, status: { type: 'string', enum: ['resolved', 'still-open', 'regressed'] } },
          required: ['id', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'score', 'issues'],
    additionalProperties: false,
  },
  validate(r, ctx) {
    const serious = r.issues.filter((i) => i.severity !== 'minor');
    if (r.verdict === 'fix' && !serious.length) return 'verdict "fix" needs at least one blocker or major issue; otherwise ship';
    if (r.verdict === 'ship' && serious.length) return 'you listed blockers/majors; verdict must be "fix"';
    if (r.verdict === 'ship' && ctx.lastCheck && ctx.lastCheck.errors > 0) return `check still reports ${ctx.lastCheck.errors} error(s); those are blockers`;
    const ids = new Set();
    for (const i of r.issues) {
      if (ids.has(i.id)) return `duplicate issue id ${i.id}`;
      ids.add(i.id);
    }
    return null;
  },
};

export function criticAgent(ctx, { plan, theme, check, snapshotText, build, round, previous }) {
  return {
    role: 'critic',
    system: rolePrompt('critic', ctx.lib, BODY),
    task: [
      `Review round ${round}.`,
      fence('plan', JSON.stringify({ ...plan, spec: undefined }, null, 2)),
      fence('theme', JSON.stringify(theme, null, 2)),
      fence('builder-report', JSON.stringify(build, null, 2)),
      fence('check-report', check.text),
      fence('snapshot', snapshotText),
      previous ? fence('previous-round', JSON.stringify(previous, null, 2)) : '',
      'SPEC.md is in the project root. The contact sheets follow. Review, then call submit_review.',
    ].filter(Boolean).join('\n\n'),
    tools: [...makeSkillTools(), ...makeFileTools({ write: false }), makeHfTool('critic'), ...makeReviewTools(),
      ...makeRegistryTools('critic').filter((t) => t.name === 'block_doc')],
    handoff: criticHandoff,
  };
}
