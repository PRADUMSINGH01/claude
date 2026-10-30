import { makeSkillTools } from '../tools/skill-tools.js';
import { makeRegistryTools, offThemeColours } from '../tools/registry-tools.js';
import { checkGate, makeBashTool, makeFileTools, makeHfTool, makeReviewTools } from '../tools/project-tools.js';
import { fence, rolePrompt } from './common.js';

const BODY = `## How to build
The harness has already: initialised the project, written SPEC.md, plan.json, frame.md and theme.json, and installed every registry item the plan names (see the install report). Build the film the plan describes.

1. Before writing HTML, read the section of format.md you need (skill_outline first). For each installed block, read its block_doc "variables" (or equivalent) section.
2. index.html is the root: it declares the theme as root variables (colours and fonts from theme.json) and holds only scene hosts, media and audio. One scene per sub-composition, timings from plan.json: main scenes back to back; a "background" scene is one host spanning its range under the others (lower z-index, its own track), an "overlay" scene sits above them. Mount a background once, never once per beat.
3. A scene that is a registry block: mount it with the snippet from the install report (data-composition-src, its own composition id, data-start, the plan's data-duration) and set data-variable-values so its copy matches the plan and its colour/font variables use the theme's exact values. Edit the block's file only when variables can't get there.
4. A hand-built scene: compositions/<scene-id>.html, following the contract. Merge installed components into it as their docs say.
   Data: put only figures the request gave on screen. A chart that needs values the request lacks shows fewer points or a different form; never fill gaps with plausible numbers.
5. Audio the plan asks for: media-use resolve (free paths) first; place an <audio> with an id only for a file that now exists. If nothing resolves, leave audio out and say so in known_issues. Never reference a file you have not created.
6. Loop: hf lint after the first pass and after structural changes; then the check tool until it reports 0 errors; then one snapshot to look at your frames and fix what is visibly wrong.
7. Call submit_build. Be honest about anything partial.`;

export const builderHandoff = {
  name: 'submit_build',
  description: 'Hand the built project to the critic.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      scenes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, status: { type: 'string', enum: ['built', 'partial', 'missing'] }, notes: { type: 'string' } },
          required: ['id', 'status'],
          additionalProperties: false,
        },
      },
      known_issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'scenes'],
    additionalProperties: false,
  },
  async validate(b, ctx) {
    const planned = new Set(ctx.plan.scenes.map((s) => s.id));
    const missing = [...planned].filter((id) => !b.scenes.some((s) => s.id === id));
    if (missing.length) return `report every planned scene; missing: ${missing.join(', ')}`;
    const blocks = [...new Set(ctx.plan.scenes.flatMap((s) => [s.block, ...(s.components ?? [])]).filter(Boolean))];
    const unread = blocks.filter((n) => !ctx.blockDocsRead?.has(n));
    if (unread.length) return `read the docs of every installed item before handing off (block_doc with a section, e.g. its variables): ${unread.join(', ')}`;
    const colours = offThemeColours(ctx.ws, ctx.theme, ctx.plan);
    if (colours.length) return `colours outside the theme: ${colours.join('; ')}. Use theme.json values (or var(--…)) only.`;
    return checkGate(ctx);
  },
};

export function builderAgent(ctx, { plan, installReport, theme, requiredBlockDocs = [] }) {
  return {
    role: 'builder',
    system: rolePrompt('builder', ctx.lib, BODY),
    task: [
      fence('plan', JSON.stringify({ ...plan, spec: undefined }, null, 2)),
      fence('theme', JSON.stringify(theme, null, 2)),
      fence('install-report', installReport),
      requiredBlockDocs.length
        ? `Before your first write, also read each installed item's variables (enforced):\n${requiredBlockDocs.map((n) => `- block_doc {name: "${n}", section: "variables"}`).join('\n')}\nEvery content variable the scene shows (titles, labels, series, images) must be set from the plan; demo values left in are a defect.`
        : '',
      'SPEC.md is in the project root. Build the film, then call submit_build.',
    ].filter(Boolean).join('\n\n'),
    tools: [
      ...makeSkillTools(),
      ...makeRegistryTools('builder'),
      ...makeFileTools({ write: true }),
      makeHfTool('builder'),
      makeBashTool(),
      ...makeReviewTools(),
    ],
    handoff: builderHandoff,
  };
}
