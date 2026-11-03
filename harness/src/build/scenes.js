// Step 2–3 of the build: the scene writer. One call per scene that code can't assemble, with a
// self-contained "scene packet"; code checks first, then `hyperframes check` findings for that file
// only; at most two repairs; a code fallback if it still fails. No tool loop, no shared history.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { parseModelJson } from '../plan.js';
import { requireSection } from '../tools/skill-tools.js';
import { fallbackScene, mediaMarkup, skeleton } from './scene-files.js';

const BOX_SIZE = { top: [1, 0.3], bottom: [1, 0.22], corner: [0.32, 0.16], full: [1, 1] };

const transitionText = (lib) => requireSection(lib, 'hyperframes', 'references/motion.md', 'transitions-with-a-cause');

function contractText(lib) {
  return [
    requireSection(lib, 'hyperframes', 'SKILL.md', 'contract'),
    requireSection(lib, 'hyperframes', 'references/format.md', 'shape-of-a-project'),
  ].join('\n\n');
}

// How a scene should look and move, not only what makes it valid: motion craft, composition numbers,
// the defaults that make a film read as generated, and what survives compression.
function designText(lib) {
  return [
    ...['motion-craft', 'the-right-mechanism', 'seeing-motion', 'common-faults'].map((id) => requireSection(lib, 'hyperframes', 'references/motion.md', id)),
    requireSection(lib, 'hyperframes', 'references/spec.md', 'composition-numbers'),
    requireSection(lib, 'hyperframes', 'references/spec.md', 'banned-by-default'),
    requireSection(lib, 'hyperframes', 'references/look.md', 'video-facts'),
  ].join('\n\n');
}

// The runtimes a scene may reach for (GSAP traps, canvas and SVG, the seek protocol): fog, light, grain and
// glitch are drawn, and the writer needs to know how to keep them seek-safe.
const runtimeText = (lib) => ['gsap-facts-that-bite', 'other-runtimes', 'the-seek-protocol'].map((id) => requireSection(lib, 'hyperframes', 'references/runtimes.md', id)).join('\n\n');

// The system prompt is the same for every scene (and every film), so providers that cache a repeated
// prompt prefix reuse it; everything about this scene goes in the user message.
const systemCache = new WeakMap();
function sceneSystem(lib) {
  if (systemCache.has(lib)) return systemCache.get(lib);
  const text = `You write ONE HyperFrames scene file (a sub-composition). Reply with the whole file in a single \`\`\`html code block, and nothing after it.

The file must follow the contract below exactly:
- Everything inside one <template>. Its root element is <div id="root" data-composition-id="<scene id>">. Style the root as #root (never by class) and give it position:absolute; inset:0.
- One paused GSAP timeline, registered last: window.__timelines["<scene id>"] = tl. gsap is already loaded globally.
- Every timed element has class="clip", data-start and data-duration in seconds relative to the scene start, inside the scene's duration. Animate children of a .clip (or its opacity), never display/visibility/autoAlpha. Use fromTo, never from.
- No Date.now(), Math.random(), fetch, timers, or repeat: -1. Everything visible is a function of timeline time.
- Ids unique and prefixed "<scene id>-".
- Sizes relative to the box: #root has container-type: size, so use cqw/cqh/cqmin for type and spacing (the box size is in the task).
- Colours and fonts only through the theme tokens: var(--bg) var(--fg) var(--accent) var(--accent-2) var(--font-display) var(--font-body). Never make text the ground colour.
- On-screen text: exactly the scene's copy, verbatim, written as text in the HTML. No other words: remove a component's demo labels, counters and percentages. One exception: a product interface you draw (an editor, a dashboard, an invoice, a phone screen) may carry short generic interface labels so it reads as that product: field names, button words, column heads, currency codes (Invoice, Client, Due, Send, USD). Never invented names, claims or figures: an empty mock-up box reads as nothing.
- A number that counts up (0 → 85%) is written in the HTML at its final value; the timeline's onUpdate rewrites it while it counts (seek-safe, from the timeline's progress).
- Words split into separate elements keep their spaces: put them in a block or inline container, never a flex or grid row without a gap (flex drops the spaces, so "Roasted on" reads "Roastedon").
- Components and adapted blocks: each <component> below is source to adapt, not to mount. Keep its technique (the typing, the shatter, the reveal) and rewrite its markup, CSS and script into this file's skeleton with the scene's copy, timing and theme tokens; none of its demo text survives. Don't load external files.

What the scene must deliver:
- The scene's <asks> are what the person asked for: every one is visible in the finished scene (the fog is there, the light glows from behind, the shake runs, the scare lands on its second). They win over every default below. Nothing from <avoid> appears.
- A component or adapted block is a technique to start from, not the scene: rewrite it until the scene delivers its asks.

How it looks and moves (the design rules below, in numbers):
- The scene's asks, build and motion win where they are specific; the rules below fill every gap.
- Text that must be read: at least 2.6cqmin. Type is sized by its role: the hero words of a title card, a quote or an end card are the picture and fill at least 40% of the box's width (a one-line title is usually 12-20cqh; a quote wraps to more lines rather than shrink); a headline beside other content 6-9cqh; labels 2.6-4cqmin. Real films made every title far too small. At most one word in var(--accent), the word that carries the meaning; when the asks name an accent word or colour, use it.
- The hero fills at least 40% of the box's width or height. Keep content inside the central 90% of the box, text inside 80%.
- One hero move; secondary moves travel 50-70% as far and start 0.1-0.2 s after it; everything else holds still. A landed title holds still until it leaves, unless the scene asks for life in it (jitter, wiggle, flicker, glitch, breathing, drift): then that motion runs through the whole hold.
- Ease by role (expo.out or power4.out to arrive, power2.inOut to move, power3.in to leave), never one ease on everything. Pick one title entrance from the motion craft list; never fade-and-slide-up on every element.
- Nothing from the BANNED list: no glow, particles, glass cards, corner labels, frame borders or three cards in a row unless the scene's asks or build call for them.

<contract>
${contractText(lib)}
</contract>

<design>
${designText(lib)}
</design>

<runtimes>
${runtimeText(lib)}
</runtimes>`;
  systemCache.set(lib, text);
  return text;
}

function componentSource(item) {
  return item.source.replace(/data-composition-variables='[^']*'/, 'data-composition-variables=\'(see the variables listed in the comment)\'');
}

export function scenePacket(scene, ctx) {
  const { format, roles, lib, items } = ctx;
  const [bw, bh] = BOX_SIZE[scene.layer === 'overlay' ? scene.position ?? 'bottom' : 'full'];
  const box = { width: Math.round(format.width * bw), height: Math.round(format.height * bh) };
  const comps = [...new Set([...(scene.components ?? []), ...(scene.adapt ?? []), ...(scene.escalatedFrom ? [scene.escalatedFrom] : [])])].map((n) => items[n]).filter(Boolean);
  const rules = [
    `- Root: <div id="root" data-composition-id="${scene.id}">; register window.__timelines["${scene.id}"] = tl; ids prefixed "${scene.id}-"; every clip inside 0-${scene.duration}s.`,
    `- The box is ${box.width}x${box.height}px.`,
    `- The ground is ${roles.dark ? 'DARK' : 'LIGHT'}: type in var(--fg) reads. Do not paint a background on #root${scene.layer === 'main' && ctx.hasBackground ? ' (a background layer runs under this scene)' : ' unless the scene asks for one'}.`,
    scene.stock ? `- MEDIA: this scene's backdrop is the stock ${scene.stock.kind} ${scene.stock.file} (${scene.stock.width}x${scene.stock.height}${scene.stock.duration ? `, ${scene.stock.duration}s` : ''}, "${scene.stock.query}"). Put it first inside #root exactly like this, then a scrim, then the copy above both (position:relative; z-index:1):\n  ${mediaMarkup(scene).replace(/\n\s*/g, '\n  ')}\n  The ${scene.stock.kind} element is the timed clip: never put it inside another .clip, never play/pause/seek it, no CSS filter on it. A slow push-in (scale 1 → 1.06 over the scene) may go on an untimed wrapper around it. Tune the scrim's opacity (0.35-0.7) so the copy reads; the copy stays the hero.` : null,
    scene.layer === 'transition' ? `- THIS SCENE IS A TRANSITION over the cut at ${(scene.duration / 2).toFixed(2)}s (its midpoint). It has no text. It must COVER THE WHOLE FRAME with opaque theme colours at exactly that midpoint (the outgoing beat must not show), and be fully clear again at its start and end (#root transparent, shapes off-frame). Build it from bold shapes: colour blocks, slices, an iris, a flood. Ease in hard, ease out hard; the cover moment is short. Follow the style in the scene's build.` : null,
  ].filter(Boolean);

  const task = {
    scene: { id: scene.id, layer: scene.layer, duration: scene.duration, position: scene.position ?? null, copy: scene.text, build: scene.build, motion: scene.motion, values: scene.vars ?? {} },
    film: { width: format.width, height: format.height, fps: format.fps },
    theme: { ground: roles.ground, ink: roles.ink, accent: roles.accent, display_font: roles.display, body_font: roles.body },
    why_written: scene.escalatedFrom ? `The mounted ${scene.escalatedFrom} failed review: ${scene.escalationReason}. Rebuild the scene yourself, adapting its source.` : undefined,
  };
  const asks = (Array.isArray(scene.must) ? scene.must : []).filter((m) => String(m).trim());
  const user = [
    `<this-scene>\n${rules.join('\n')}\n</this-scene>`,
    asks.length ? `<asks>\nWhat the person asked for that this scene delivers; each one is visible in the finished scene:\n${asks.map((m) => `- ${m}`).join('\n')}\n</asks>` : null,
    ctx.avoid?.length ? `<avoid>\n${ctx.avoid.map((m) => `- ${m}`).join('\n')}\n</avoid>` : null,
    ctx.filmGuide ? `<film-guide>\n${ctx.filmGuide}\n</film-guide>` : null,
    scene.layer === 'transition' ? `<transitions>\n${transitionText(lib)}\n</transitions>` : null,
    `<skeleton>\n${skeleton(scene.id)}\n</skeleton>`,
    `<scene>\n${JSON.stringify(task, null, 1)}\n</scene>`,
    ...comps.map((c) => `<component name="${c.name}">\n${componentSource(c)}\n</component>`),
  ].filter(Boolean).join('\n\n');
  return { system: sceneSystem(lib), user };
}

// Code checks that need no browser: catch the common contract breaks before running check.
// The words a viewer can read: markup text without scripts, styles, comments, tags or attributes (an
// aria-label is not on screen). Compared without spaces or case, since type is often split into per-word or
// per-letter spans and set in capitals by CSS.
const ENTITIES = { nbsp: ' ', '#160': ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", rsquo: "'", lsquo: "'", '#8217': "'", ldquo: '"', rdquo: '"' };
export const visibleText = (html) => String(html)
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
const squash = (s) => String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, '');

export function staticProblems(html, id, duration, copy = [], mediaFile = null) {
  const p = [];
  if (mediaFile && !html.includes(mediaFile)) p.push(`the scene's backdrop ${mediaFile} is missing: put it first inside #root as the MEDIA rule shows`);
  // Copy is the one thing that must be exact. A real run wrote "Mornin<span>g</span>" and kept the "s" only
  // in an aria-label, so the film said "Slow Morning".
  const shown = squash(visibleText(html));
  // Every word of every line, each whole: a chart puts "2019" under a bar and "22%" above it, and a real run's
  // chart was thrown away because the line was not one contiguous run of text.
  for (const line of copy.filter((c) => String(c).trim())) {
    const missing = String(line).split(/\s+/).filter((w) => squash(w) && !shown.includes(squash(w)));
    if (missing.length) p.push(`the copy "${line}" is not all in the markup (${missing.map((w) => `"${w}"`).join(', ')} missing): write every word as visible text in the HTML, every letter (not built by script, not only in an attribute); a number that counts up is written at its final value and the timeline rewrites it while it counts`);
  }
  if (!/<template[\s>]/.test(html)) p.push('everything must be inside <template>');
  if (!new RegExp(`<div[^>]*id="root"[^>]*data-composition-id="${id}"|<div[^>]*data-composition-id="${id}"[^>]*id="root"`).test(html)) p.push(`root must be <div id="root" data-composition-id="${id}">`);
  if (!html.includes(`__timelines["${id}"]`)) p.push(`register the timeline: window.__timelines["${id}"] = tl`);
  if (/Date\.now|Math\.random|fetch\(|setTimeout|setInterval|repeat:\s*-1/.test(html)) p.push('no Date.now, Math.random, fetch, timers or repeat:-1');
  if (/<link[^>]+href=|<script[^>]+src=/.test(html)) p.push('no external files (link/script src); gsap is already loaded');
  // A real chart made its "tick sound on each bar" with Web Audio in its script: the renderer refused the film.
  if (/AudioContext|new\s+Audio\s*\(|\.play\s*\(\s*\)/.test(html)) p.push('no Web Audio, new Audio() or play(): a scene makes no sound itself; its sound effects are placed on the film\'s sound track from the plan, so remove the audio code');
  if (!config.renderGpu && needsGpu(html)) p.push('this host has no GPU: build the effect with CSS 3D transforms, canvas 2D or SVG, without WebGPU, three.js or data-requires-webgpu');
  for (const m of html.matchAll(/data-start="([\d.]+)"[^>]*data-duration="([\d.]+)"/g)) {
    if (Number(m[1]) + Number(m[2]) > duration + 0.05) { p.push(`a clip runs to ${Number(m[1]) + Number(m[2])}s, past the scene's ${duration}s`); break; }
  }
  return p;
}

// The scene file from a reply: the ```html block we ask for, else the older {"html": "…"} JSON shape,
// else a bare <template>…</template>. Code is never asked for inside a JSON string: escaping a whole
// HTML+JS file there is where long replies break.
export function extractHtml(text) {
  const s = String(text ?? '').trim();
  const fromJson = (t) => {
    const v = parseModelJson(t);
    return typeof v?.html === 'string' && v.html.trim() ? v.html.trim() : null;
  };
  for (const [, body] of s.matchAll(/```[\w-]*[ \t]*\r?\n([\s\S]*?)```/g)) {
    const b = body.trim();
    if (b.startsWith('{')) {
      const html = fromJson(b);
      if (html) return html;
    } else if (/<template[\s>]/.test(b)) return b;
  }
  if (s.startsWith('{')) return fromJson(s);
  const a = s.indexOf('<template');
  const z = s.lastIndexOf('</template>');
  return a >= 0 && z > a ? s.slice(a, z + '</template>'.length) : null;
}

// change: an edit of a finished scene (what the person asked to change, and the scene's file as it is now).
export async function writeScene(scene, ctx, { problems = null, current = null, effort, change = null } = {}) {
  const { system, user } = scenePacket(scene, ctx);
  if (change) {
    const ask = `\n\n<change>\n${change}\n</change>\n\n<current-file>\n${current}\n</current-file>\n\nThis scene is already made. Make the change above, keep everything else in the file as it is (its timing, ids and whatever the change does not touch), and reply with the whole edited file in one \`\`\`html block.`;
    return ctx.ask(system, user + ask, { label: `edit ${scene.id}`, parse: extractHtml, effort });
  }
  const repair = problems ? `\n\n<problems>\n${problems.map((x) => `- ${x}`).join('\n')}\n</problems>\n\n<current-file>\n${current}\n</current-file>\n\nFix every problem and reply with the whole corrected file in one \`\`\`html block.` : '';
  return ctx.ask(system, user + repair, { label: `${problems ? 'repair' : 'write'} ${scene.id}`, parse: extractHtml, effort });
}

/** Markup that needs a GPU to render in time: WebGPU, or three.js 3D (lit WebGL scenes). */
export const needsGpu = (html) => /data-requires-webgpu|navigator\.gpu|three\.module(\.min)?\.js|from\s+["']three["']|"three"\s*:/.test(String(html));

// One line per distinct finding with its count: the check reports each element, and a real run's repair prompt
// carried the same text_occluded line thirty-one times.
export function findingsFor(check, file) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/');
  const lines = (check.findings ?? []).filter((f) => f.severity !== 'info' && norm(f.sourceFile).endsWith(file))
    .map((f) => `[${f.severity}] ${f.code}: ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ''}`);
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} (${n} elements)` : l));
}

export const sceneFile = (ws, scene) => path.join(ws.projectDir, scene.file);
export const writeFallback = (ws, scene, ctx) => fs.writeFileSync(sceneFile(ws, scene), fallbackScene(scene, ctx.format, ctx.roles));
