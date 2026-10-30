import { attachRefs, makeSkillTools } from '../tools/skill-tools.js';
import { makeRegistryTools } from '../tools/registry-tools.js';
import { checkGate, makeBashTool, makeFileTools, makeHfTool, makeReviewTools } from '../tools/project-tools.js';
import { fence, rolePrompt } from './common.js';

const BODY = `## How to fix
Work the issue list in order: blockers, then majors, then minors if they are cheap.
For each: read the file around the location, read the skill section named in skill_ref if you are unsure, make the smallest edit that resolves it (edit_file, not rewrites), and keep the theme and the plan intact.
Never fix by deleting a planned scene, muting audio, or shortening the film unless the issue says so.
After the edits: check until 0 errors, and snapshot the times you touched to confirm. Then call submit_fix with every issue id accounted for.`;

export const fixerHandoff = {
  name: 'submit_fix',
  description: 'Report what you fixed.',
  parameters: {
    type: 'object',
    properties: {
      fixed: { type: 'array', items: { type: 'string' }, description: 'issue ids resolved' },
      not_fixed: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, reason: { type: 'string' } },
          required: ['id', 'reason'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
    },
    required: ['fixed', 'not_fixed'],
    additionalProperties: false,
  },
  async validate(f, ctx) {
    const seen = new Set([...f.fixed, ...f.not_fixed.map((n) => n.id)]);
    const missing = ctx.issues.map((i) => i.id).filter((id) => !seen.has(id));
    if (missing.length) return `account for every issue id; missing: ${missing.join(', ')}`;
    return checkGate(ctx);
  },
};

export function fixerAgent(ctx, { plan, theme, issues, check, reason }) {
  // The sections the critic cited go in with the issues, and count as read.
  const refs = attachRefs(ctx.lib, 'fixer', issues.map((i) => i.skill_ref));
  return {
    role: 'fixer',
    system: rolePrompt('fixer', ctx.lib, BODY),
    readKeys: refs.keys,
    task: [
      reason ? `Context: ${reason}` : '',
      fence('issues', JSON.stringify(issues, null, 2)),
      refs.text,
      fence('check-report', check?.text ?? '(not run)'),
      fence('theme', JSON.stringify(theme, null, 2)),
      fence('scene-plan', JSON.stringify(plan.scenes.map(({ id, start, duration, block, text }) => ({ id, start, duration, block, text })), null, 2)),
      'Fix these, re-check, then call submit_fix.',
    ].filter(Boolean).join('\n\n'),
    tools: [
      ...makeSkillTools(),
      ...makeRegistryTools('fixer'),
      ...makeFileTools({ write: true }),
      makeHfTool('fixer'),
      makeBashTool(),
      ...makeReviewTools(),
    ],
    handoff: fixerHandoff,
  };
}
