// Step 2–3 of the build: the scene writer. One call per scene that code can't assemble, with a
// self-contained "scene packet"; code checks first, then `hyperframes check` findings for that file
// only; at most two repairs; a code fallback if it still fails. No tool loop, no shared history.
import fs from 'node:fs';
import path from 'node:path';
import { readSection } from '../tools/skill-tools.js';
import { fallbackScene, skeleton } from './scene-files.js';

const BOX_SIZE = { top: [1, 0.3], bottom: [1, 0.22], corner: [0.32, 0.16], full: [1, 1] };

const transitionText = (lib) => readSection(lib, 'hyperframes', 'references/motion.md', 'transitions-with-a-cause') ?? '';

function contractText(lib) {
  return [
    readSection(lib, 'hyperframes', 'SKILL.md', 'contract'),
    readSection(lib, 'hyperframes', 'references/format.md', 'shape-of-a-project'),
  ].filter(Boolean).join('\n\n');
}

// Comment header + code of a component, without the demo copy it ships with.
function componentSource(item) {
  return item.source.replace(/data-composition-variables='[^']*'/, 'data-composition-variables=\'(see the variables listed in the comment)\'');
}

export function scenePacket(scene, ctx) {
  const { format, roles, lib, items } = ctx;
  const [bw, bh] = BOX_SIZE[scene.layer === 'overlay' ? scene.position ?? 'bottom' : 'full'];
  const box = { width: Math.round(format.width * bw), height: Math.round(format.height * bh) };
  const comps = [...(scene.components ?? []), ...(scene.escalatedFrom ? [scene.escalatedFrom] : [])].map((n) => items[n]).filter(Boolean);
  const system = `You write ONE HyperFrames scene file (a sub-composition). Reply with JSON only: {"html": "<the whole file>"}.

The file must follow the contract below exactly:
- Everything inside one <template>. Its root element is <div id="root" data-composition-id="${scene.id}">. Style the root as #root (never by class) and give it position:absolute; inset:0.
- One paused GSAP timeline, registered last: window.__timelines["${scene.id}"] = tl. gsap is already loaded globally.
- Every timed element has class="clip", data-start and data-duration in seconds relative to the scene start, inside 0–${scene.duration}s. Animate children of a .clip (or its opacity), never display/visibility/autoAlpha. Use fromTo, never from.
- No Date.now(), Math.random(), fetch, timers, or repeat: -1. Everything visible is a function of timeline time.
- Ids unique and prefixed "${scene.id}-".
- Sizes relative to the box: #root has container-type: size, so use cqw/cqh/cqmin for type and spacing. The box is ${box.width}x${box.height}px.
- Colours and fonts only through the theme tokens: var(--bg) var(--fg) var(--accent) var(--accent-2) var(--font-display) var(--font-body). The ground is ${roles.dark ? 'DARK' : 'LIGHT'}: type in var(--fg) reads; never make text the ground colour. Do not paint a background on #root${scene.layer === 'main' && ctx.hasBackground ? ' (a background layer runs under this scene)' : ' unless the scene asks for one'}.
- On-screen text: exactly the scene's copy, verbatim. No other words.${scene.layer === 'transition' ? `
- THIS SCENE IS A TRANSITION over the cut at ${(scene.duration / 2).toFixed(2)}s (its midpoint). It has no text. It must COVER THE WHOLE FRAME with opaque theme colours at exactly that midpoint (the outgoing beat must not show), and be fully clear again at its start and end (#root transparent, shapes off-frame). Build it from bold shapes: colour blocks, slices, an iris, a flood. Ease in hard, ease out hard; the cover moment is short. Follow the style in the scene's build.` : ''}
- Components: when one is listed, adapt its markup, CSS and script into this file as its comment says (set its text and options in code from the scene's values). Don't load external files.

<contract>
${contractText(lib)}
</contract>${scene.layer === 'transition' ? `

<transitions>
${transitionText(lib)}
</transitions>` : ''}

<skeleton>
${skeleton(scene.id)}
</skeleton>`;

  const task = {
    scene: { id: scene.id, layer: scene.layer, duration: scene.duration, position: scene.position ?? null, copy: scene.text, build: scene.build, motion: scene.motion, values: scene.vars ?? {} },
    film: { width: format.width, height: format.height, fps: format.fps },
    theme: { ground: roles.ground, ink: roles.ink, accent: roles.accent, display_font: roles.display, body_font: roles.body },
    why_written: scene.escalatedFrom ? `The mounted ${scene.escalatedFrom} failed review: ${scene.escalationReason}. Rebuild the scene yourself, adapting its source.` : undefined,
  };
  const user = [
    `<scene>\n${JSON.stringify(task, null, 1)}\n</scene>`,
    ...comps.map((c) => `<component name="${c.name}">\n${componentSource(c)}\n</component>`),
  ].join('\n\n');
  return { system, user };
}

// Code checks that need no browser: catch the common contract breaks before running check.
export function staticProblems(html, id, duration) {
  const p = [];
  if (!/<template[\s>]/.test(html)) p.push('everything must be inside <template>');
  if (!new RegExp(`<div[^>]*id="root"[^>]*data-composition-id="${id}"|<div[^>]*data-composition-id="${id}"[^>]*id="root"`).test(html)) p.push(`root must be <div id="root" data-composition-id="${id}">`);
  if (!html.includes(`__timelines["${id}"]`)) p.push(`register the timeline: window.__timelines["${id}"] = tl`);
  if (/Date\.now|Math\.random|fetch\(|setTimeout|setInterval|repeat:\s*-1/.test(html)) p.push('no Date.now, Math.random, fetch, timers or repeat:-1');
  if (/<link[^>]+href=|<script[^>]+src=/.test(html)) p.push('no external files (link/script src); gsap is already loaded');
  for (const m of html.matchAll(/data-start="([\d.]+)"[^>]*data-duration="([\d.]+)"/g)) {
    if (Number(m[1]) + Number(m[2]) > duration + 0.05) { p.push(`a clip runs to ${Number(m[1]) + Number(m[2])}s, past the scene's ${duration}s`); break; }
  }
  return p;
}

export async function writeScene(scene, ctx, { problems = null, current = null } = {}) {
  const { system, user } = scenePacket(scene, ctx);
  const repair = problems ? `\n\n<problems>\n${problems.map((x) => `- ${x}`).join('\n')}\n</problems>\n\n<current-file>\n${current}\n</current-file>\n\nFix every problem and reply with the whole corrected file.` : '';
  const reply = await ctx.ask(system, user + repair, { label: `${problems ? 'repair' : 'write'} ${scene.id}` });
  const html = typeof reply?.html === 'string' ? reply.html.trim() : null;
  return html;
}

export function findingsFor(check, file) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/');
  return (check.findings ?? []).filter((f) => f.severity !== 'info' && norm(f.sourceFile).endsWith(file))
    .map((f) => `[${f.severity}] ${f.code}: ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ''}`);
}

export const sceneFile = (ws, scene) => path.join(ws.projectDir, scene.file);
export const writeFallback = (ws, scene, ctx) => fs.writeFileSync(sceneFile(ws, scene), fallbackScene(scene, ctx.format, ctx.roles));
