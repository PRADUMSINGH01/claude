// Planning, on its own and cheap: understand → story (films over ~15 s) → shortlist (code) → plan → rate.
// No tool loops and nothing re-sent: a few short model calls (plus one repair per step if invalid).
import fs from 'node:fs';
import { config, providerForRole } from './config.js';
import { chat } from './llm.js';
import { SkillLibrary } from './skills/library.js';
import { readSection } from './tools/skill-tools.js';
import { catalogSearch, inspectItem, listThemes } from './tools/registry-tools.js';
import { opaqueOverBackground, plannerHandoff } from './roles/planner.js';
import { Workspace } from './workspace.js';

// ---- 1. Understand -----------------------------------------------------------

// Where generated design lands when nothing is decided (hyperframes references/look.md#the-look-line).
export const GENERATED_FONTS = ['Inter', 'Space Grotesk', 'Instrument Serif', 'Geist', 'JetBrains Mono'];

const BRIEF_SHAPE = `{
  "title": "short name",
  "goal": "what the viewer should feel or remember, one sentence",
  "kind": "title | explainer | launch | data | music | vertical | 3d | character | other",
  "format": { "width": 1920, "height": 1080, "fps": 30, "duration": <seconds> },
  "audio": "none | sfx | music",
  "look": { "preset": "<preset name or null>", "colors": { "ground": "#hex", "ink": "#hex", "accent": "#hex", "<more names, e.g. coral, lime>": "#hex" }, "fonts": ["Family"], "mood": "3-6 words" },
  "background": { "wanted": true|false, "description": "what it should look like, or empty" },
  "beats": [ { "id": "kebab-id", "start": 0, "end": 5, "copy": ["exact on-screen text"], "intent": "what it does visually, 2-5 words, for a registry search" } ],
  "overlays": [ { "id": "kebab-id", "start": 0, "end": 12, "copy": ["exact text"], "position": "top | bottom | corner", "intent": "2-5 words" } ],
  "transitions": [ { "id": "t-1", "at": 3, "kind": "cover | handoff", "style": "e.g. colour flood, block wipe, iris, slice wipe, whip, blur swap", "duration": 0.6 } ],
  "must": ["hard requirements from the prompt"],
  "avoid": ["things the prompt rules out"],
  "assumptions": ["what you decided where the prompt was silent"]
}`;

const UNDERSTAND_SYSTEM = `You turn a video request into a precise brief. Reply with JSON only, in this shape:
${BRIEF_SHAPE}
Rules:
- copy holds only the words that appear on screen, verbatim (same words, punctuation and case). Never invent copy the request did not give, except a title card when there is no copy at all (say so in assumptions).
- Instructions are not copy. "show the source on screen" means the source itself goes in copy (e.g. "Source: UN World Population Prospects 2024"), never the words "show … on screen".
- Beats are back to back from 0 and end at format.duration. Use the request's timings when given. Otherwise give every beat time to be read: at least 2 s, and 1 s + 0.3 s per word of its copy.
- One sentence or line of copy lives in ONE beat, whole. Never split it into fragments across beats; a word-by-word or line-by-line reveal is one beat (its intent says "word by word reveal"). Never repeat copy in a later beat: a hold is part of the same beat, so make that beat longer.
- transitions: one per seam between beats when the request asks for transitions (else []). "at" is exactly the seam (a beat's end). kind "cover" = an overlay that covers the whole frame at its midpoint and hides the cut (colour flood, block/slice wipe, iris); kind "handoff" = the outgoing beat leaves and the next arrives with matching motion (whip, blur swap, push). Vary the styles; duration 0.3–1.2 s. Plain crossfades only if asked.
- overlays: only text the request keeps on screen WHILE other beats play (e.g. "keep the logo in the corner", "the source stays at the bottom", "the hook stays at the top"). Give it its time range and position. Text shown in sequence ("then…") is a beat, not an overlay. Usually overlays is [].
- Colours: put EVERY colour the request gives into look.colors, hex exactly as written: ground, ink and accent for the main roles, then one named key per extra colour (e.g. "coral": "#FF5A5F"). If it names a theme preset, set look.preset and leave colors empty. Fonts as named.
- look.preset only when the request (or the app settings) names a preset: presets are slide-deck looks, never the fallback for a film. Otherwise leave it null and fill look.colors and look.fonts.
- When the request gives no colours or fonts, take them from the subject's own world (its era, its materials, where it would be shown), never from habit. Avoid the defaults generated video lands on unless the request asks for them: ${GENERATED_FONTS.join(', ')} as fonts; a near-black or navy void as the ground; purple or blue gradients; a cream-paper ground with a serif display. Fonts are real Google Fonts families.
- Defaults when silent: 1920x1080, 30 fps, 15 s, audio "none". Record every default you applied in assumptions.
- background.wanted is true only when the request asks for a visual background layer (a shader, gradient, aurora, texture, pattern, footage) running under the beats. A background colour ("dark background", "white space") is look.colors.ground, not a layer.`;

const INSTRUCTION_WORDS = /\b(show|display|on[- ]screen|use only|make sure|should|add a|include)\b/i;
const LAYER_WORDS = /(animat|shader|aurora|gradient|texture|pattern|particle|noise|footage|moving|alive|living|evolving|loop|grid)/i;
export const readFloor = (copy) => {
  const words = copy.join(' ').trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.max(2, 1 + 0.3 * words) : 0;
};

export function checkBrief(brief, prompt, options = {}) {
  const errs = [];
  const holders = [...(brief.beats ?? []), ...(brief.overlays ?? [])];
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  // Double-quoted text is on-screen copy; single quotes usually just name things ('Lumen').
  // Each quoted line must appear whole, in exactly one beat or overlay.
  const quoted = [...String(prompt).matchAll(/["“]([^"”]{2,120})["”]/g)].map((m) => m[1].trim());
  for (const q of quoted) {
    const inHolders = holders.filter((h) => norm((h.copy ?? []).join(' \n ')).includes(norm(q)));
    const words = norm(q).split(' ');
    const allCopy = norm(holders.flatMap((h) => h.copy ?? []).join(' '));
    if (!inHolders.length) {
      errs.push(words.length > 2 && words.every((w) => allCopy.includes(w))
        ? `"${q}" is split into fragments across beats; keep it whole in one beat (a word-by-word reveal is one beat)`
        : `on-screen text "${q}" from the request is missing (copy it verbatim)`);
    } else if (inHolders.length > 1) {
      errs.push(`"${q}" appears in ${inHolders.length} beats (${inHolders.map((h) => h.id).join(', ')}); show it once: a hold is part of the same beat`);
    }
  }
  const seen = new Map();
  for (const h of holders) {
    for (const c of h.copy ?? []) {
      const k = norm(c);
      if (k && seen.has(k) && seen.get(k) !== h.id) errs.push(`copy "${c}" is repeated in ${seen.get(k)} and ${h.id}; show it once`);
      seen.set(k, h.id);
    }
  }
  for (const o of brief.overlays ?? []) {
    if (!(o.start >= 0 && o.end <= (brief.format?.duration ?? Infinity) + 0.051 && o.end > o.start)) errs.push(`overlay ${o.id} must sit inside 0–${brief.format?.duration}s`);
    for (const c of o.copy ?? []) if (INSTRUCTION_WORDS.test(c)) errs.push(`overlay ${o.id} copy "${c}" reads like an instruction, not on-screen text`);
    const floor = readFloor(o.copy ?? []);
    if (floor && o.end - o.start < floor - 0.01) errs.push(`overlay ${o.id} is too short to read (needs ${floor.toFixed(1)}s)`);
  }
  const seams = (brief.beats ?? []).slice(0, -1).map((b) => b.end);
  for (const tr of brief.transitions ?? []) {
    if (!seams.some((s) => Math.abs(s - tr.at) < 0.051)) errs.push(`transition ${tr.id} at ${tr.at}s is not on a seam between beats (${seams.join(', ')})`);
    if (!(tr.duration >= 0.2 && tr.duration <= 1.5)) errs.push(`transition ${tr.id} duration must be 0.2–1.5 s`);
    if (!['cover', 'handoff'].includes(tr.kind)) errs.push(`transition ${tr.id} kind must be cover or handoff`);
  }
  let t = 0;
  for (const b of brief.beats ?? []) {
    if (Math.abs(b.start - t) > 0.051) errs.push(`beat ${b.id} starts at ${b.start}s, previous ends at ${t}s`);
    t = b.end;
  }
  if (brief.format?.duration && Math.abs(t - brief.format.duration) > 0.051) errs.push(`beats end at ${t}s but duration is ${brief.format.duration}s`);
  for (const [k, v] of Object.entries(brief.look?.colors ?? {})) if (v && !/^#[0-9a-f]{3,8}$/i.test(v)) errs.push(`look.colors.${k} must be hex`);
  // Every hex the request gives must survive into the brief (the plan can only use theme colours).
  const briefHex = new Set(Object.values(brief.look?.colors ?? {}).map((v) => String(v).toUpperCase()));
  const missingHex = [...new Set((String(prompt).match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi) ?? []).map((h) => h.toUpperCase()))].filter((h) => !briefHex.has(h));
  if (missingHex.length && !brief.look?.preset) errs.push(`colours from the request are missing from look.colors: ${missingHex.join(', ')}; add each under its own name`);
  if (brief.look?.preset && !listThemes().some((x) => x.name === brief.look.preset)) errs.push(`unknown preset "${brief.look.preset}"`);
  // Real numbers only (story.md §1): every figure on screen appears in the request.
  const digits = (t) => String(t).replace(/(\d),(\d)/g, '$1$2');
  const said = digits(`${prompt} ${options.duration ?? ''}`);
  for (const h of holders) {
    for (const c of h.copy ?? []) {
      const invented = (digits(c).match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(said));
      if (invented.length) errs.push(`${h.id} copy "${c}" shows ${invented.join(', ')}, which the request never gives; use only the request's figures`);
    }
  }
  // Presets and the generated-default fonts only when asked for (code check, not a prompt rule).
  const asked = (name) => new RegExp(`\\b${String(name).replace(/[-\s]+/g, '[-\\s]?')}\\b`, 'i').test(`${prompt} ${options.theme ?? ''}`);
  if (brief.look?.preset && !asked(brief.look.preset)) errs.push(`look.preset "${brief.look.preset}" was not asked for: presets are slide-deck looks; set look.preset null and give colours and fonts from the subject`);
  for (const f of brief.look?.fonts ?? []) if (GENERATED_FONTS.some((g) => g.toLowerCase() === String(f).toLowerCase()) && !asked(f)) errs.push(`font "${f}" is a generated-video default the request did not ask for; pick a family from the subject's world`);
  for (const b of brief.beats ?? []) {
    for (const c of b.copy ?? []) if (INSTRUCTION_WORDS.test(c)) errs.push(`beat ${b.id} copy "${c}" reads like an instruction, not on-screen text; put only the words the viewer sees`);
    const floor = readFloor(b.copy ?? []);
    if (floor && b.end - b.start < floor - 0.01) errs.push(`beat ${b.id} is ${+(b.end - b.start).toFixed(2)}s but its copy needs ${floor.toFixed(1)}s to be read; lengthen it (take time from other beats) or merge it`);
  }
  if (brief.background?.wanted && !LAYER_WORDS.test(prompt)) {
    errs.push('background.wanted is true but the request only names a background colour; set it in look.colors.ground and set background.wanted false');
  }
  return errs;
}

// ---- 1b. Story ------------------------------------------------------------------
// hyperframes references/story.md: a film over ~15 s that tells something gets three storylines that
// are three different films (device × form), one picked, and beats shaped by it. With no one to ask,
// the recommendation is built and the other two are saved (STORYLINES.md) so a later turn can switch.

const TYPE_FILES = { launch: 'launch', explainer: 'explainer', data: 'data', music: 'music', vertical: 'vertical', '3d': '3d', character: 'character' };
// A request that already gives its beats, shots or timings is followed, not re-told.
const SCRIPTED = /\b(beat|scene|shot)\s*\d|\b\d+(\.\d+)?\s*[-–]\s*\d+(\.\d+)?\s*s\b|storyboard|\bscript\s*:/i;

export function storyApplies(brief, prompt) {
  if (SCRIPTED.test(prompt)) return { applies: false, why: 'the request gives its own beats; following them' };
  if ((brief.format?.duration ?? 0) < 15) return { applies: false, why: 'under 15 s: the request is the story' };
  if (brief.kind === 'title') return { applies: false, why: 'a title card: one idea' };
  return { applies: true };
}

function storyGuides(lib, brief) {
  const whole = (rel) => {
    const f = lib.file('hyperframes', rel);
    return f ? fs.readFileSync(f.abs, 'utf8').trim() : '';
  };
  const types = [TYPE_FILES[brief.kind], brief.format?.height > brief.format?.width && brief.kind !== 'vertical' ? 'vertical' : null].filter(Boolean);
  return { story: whole('references/story.md'), types: types.map((t) => whole(`references/types/${t}.md`)).filter(Boolean).join('\n\n') };
}

const STORY_SHAPE = `{
  "one_thing": "what it is, in one line", "remember": "the one thing the viewer remembers, in their words",
  "spine": "one viewer doing one real task, and the one piece of data that travels through it",
  "storylines": [ { "name": "", "device": "", "form": "", "sees_feels": "two sentences", "first_two_seconds": "exactly what is on screen",
    "beats": "hook → … → end, one line", "look": "ground, type, the one material, one line", "sound": "one line" } ],
  "pick": 0, "reason": "one clause",
  "brief": <the whole brief, rewritten to tell the picked storyline, same shape as the input brief>
}`;

function storySystem(guides) {
  return `You are the story editor for a short film. Follow the story guide below. Reply with JSON only, in this shape:
${STORY_SHAPE}
Rules:
- Exactly three storylines that are three different films: each its own world, device and form (from the guide's tables). Sketch more in your head, keep the three that differ most, one of them the bold one. Put your recommendation in "pick" (0, 1 or 2): the one a stranger would follow and remember.
- The rewritten brief keeps format, audio, must and avoid exactly as given, and keeps every colour and font the request gave. Colours and fonts the request left open may come from the picked storyline's look.
- Every line of copy from the input brief stays verbatim, in exactly one beat or overlay. Keep any timings the request gives.
- You may add short on-screen lines (at most 6 words, no trailing period) where the storyline needs them (a hook, a claim, an end line). Added lines make no claims: no numbers, names, dates or facts the request does not give. List each in assumptions as "added copy: …".
- Beats run back to back from 0 to format.duration, shaped by the picked storyline and the guide's beat shares scaled to the length. Each beat is readable (at least 2 s, and 1 s + 0.3 s a word of its copy) and something new happens every 2–4 s. Each intent says what the beat does visually in 2–5 words, from the storyline's device and form, for a registry search (never "title card" for every beat).
- transitions: one per seam where the picked form carries the cut ("cover": colour flood, block/slice wipe, iris; "handoff": whip, blur swap, match cut, push), "at" exactly on the seam, duration 0.3–1.2 s, varied; at most a third of the seams are plain cuts (no entry). Keep the input brief's overlays.
- Nothing from the guide's tells (§8) or the BANNED defaults: no three cards in a row, no logo alone on frame 0, no "Introducing" opener.

<story-guide>
${guides.story}
</story-guide>${guides.types ? `

<type-guide>
${guides.types}
</type-guide>` : ''}`;
}

export function storylinesMarkdown(story) {
  const lines = (story.storylines ?? []).map((x, i) => [
    `## ${i === story.pick ? '★ ' : ''}${i + 1}. ${x.name}${i === story.pick ? ' (built)' : ''}`,
    `- device: ${x.device} · form: ${x.form}`,
    `- ${x.sees_feels}`,
    `- first two seconds: ${x.first_two_seconds}`,
    `- beats: ${x.beats}`,
    `- look: ${x.look}`,
    `- sound: ${x.sound}`,
  ].join('\n'));
  return `# Storylines\n\nThe one thing: ${story.one_thing}\nRemember: ${story.remember}\nSpine: ${story.spine}\n\nBuilt: ${story.storylines?.[story.pick]?.name} (${story.reason})\n\n${lines.join('\n\n')}\n`;
}

// The story pass may reshape beats and fill an open look; it may not change what the request fixed.
function storyProblems(story, brief, prompt, options) {
  const b = story?.brief;
  if (!Array.isArray(story?.storylines) || story.storylines.length !== 3) return ['give exactly three storylines'];
  if (!Number.isInteger(story.pick) || !story.storylines[story.pick]) return ['pick must be 0, 1 or 2'];
  if (!Array.isArray(b?.beats)) return ['brief must be the whole rewritten brief with beats[]'];
  const errs = [...checkBrief(b, prompt, options), ...checkSettings(b, options)];
  for (const k of ['width', 'height', 'fps', 'duration']) if (b.format?.[k] !== brief.format?.[k]) errs.push(`brief.format.${k} must stay ${brief.format?.[k]}`);
  if (b.audio !== brief.audio) errs.push(`brief.audio must stay "${brief.audio}"`);
  for (const [k, v] of Object.entries(brief.look?.colors ?? {})) if (b.look?.colors?.[k] !== v) errs.push(`brief.look.colors.${k} must stay ${v}`);
  return errs;
}

async function storyPass(askP, lib, brief, request, prompt, options, onEvent) {
  const system = storySystem(storyGuides(lib, brief));
  const input = `${request}\n\n<brief>\n${JSON.stringify(brief, null, 1)}\n</brief>`;
  let story = await askP(system, input);
  let errs = storyProblems(story, brief, prompt, options);
  if (errs.length) {
    onEvent({ type: 'repair', step: 'story', errors: errs });
    story = await askP(system, `${input}\n\nYour previous reply had these problems; fix them and reply with the whole JSON:\n- ${errs.join('\n- ')}\n\nPrevious reply:\n${JSON.stringify(story)}`);
    errs = storyProblems(story, brief, prompt, options);
  }
  return { story, errs };
}

// ---- 2. Shortlist (code only) ------------------------------------------------

// Registry items that recreate a specific company's product, UI or account (checked against the
// catalog, 448 items). Each is offered only when the request names that product. "yt-" is just a
// collection prefix and "Apple-style" a look, so those are not listed.
const BRAND_ITEMS = {
  'chatgpt-exchange': /chatgpt|openai/i,
  'claude-exchange': /claude|anthropic/i,
  'instagram-follow': /instagram/i,
  'tiktok-follow': /tiktok/i,
  'reddit-post': /reddit/i,
  'slack-notification-ad': /slack/i,
  'spotify-card': /spotify/i,
  'x-post': /\bx\b|twitter|tweet/i,
  'x-follow-card': /\bx\b|twitter|tweet/i,
  'blue-sweater-intro-video': /blue[_ ]?sweater/i,
  'yt-lower-third': /youtube|subscribe/i,
  'vpn-youtube-spot': /youtube|vpn/i,
  'ios26-liquid-glass': /\bios\b|iphone/i,
  'vfx-iphone-device': /iphone|macbook|\bapple\b/i,
  'store-badge-lockup': /\bios\b|android|app store|google play/i,
};
export const blockedForPrompt = (name, prompt) => Boolean(BRAND_ITEMS[name] && !BRAND_ITEMS[name].test(prompt));

const BACKGROUND_KIND = /(background|backdrop|shader|gradient|texture|aurora|noise|pattern|sky|particles)/i;

async function shortlistFor(ws, query, { needsText, type, prompt, background = false, max = 4 }) {
  const found = await catalogSearch(ws, { query, type, limit: 10 });
  const out = [];
  for (const item of found.items) {
    if (blockedForPrompt(item.name, prompt)) continue; // someone else's product UI, not asked for
    if (background && !BACKGROUND_KIND.test(`${item.name} ${item.tags.join(' ')} ${item.description}`)) continue;
    const info = await inspectItem(ws, item.name);
    if (!info.ok) continue;
    if (info.imageVars.length) continue; // would show demo photos
    if (needsText && !info.textVars.length) continue; // copy is hard-coded
    out.push({ name: item.name, type: item.type, description: item.description, tags: item.tags, ...info });
    if (out.length >= max) break;
  }
  return out;
}

export async function shortlist(ws, brief, prompt) {
  const lists = {};
  const components = {};
  for (const b of brief.beats) {
    const query = b.intent || b.copy.join(' ');
    const hasCopy = b.copy.some((c) => c.trim());
    lists[b.id] = await shortlistFor(ws, query, { needsText: hasCopy, type: 'block', prompt });
    // Components (text effects, captions, props) merge into a hand-built scene and take the scene's own copy.
    if (hasCopy) components[b.id] = await shortlistFor(ws, query, { needsText: false, type: 'component', prompt, max: 3 });
  }
  for (const o of brief.overlays ?? []) {
    const query = o.intent || `${o.position ?? ''} text overlay`;
    lists[o.id] = await shortlistFor(ws, query, { needsText: true, type: 'block', prompt, max: 3 });
    components[o.id] = await shortlistFor(ws, query, { needsText: false, type: 'component', prompt, max: 3 });
  }
  for (const tr of (brief.transitions ?? []).filter((x) => x.kind === 'cover')) {
    const found = await shortlistFor(ws, `${tr.style} transition`, { needsText: false, type: 'block', prompt, max: 6 });
    lists[tr.id] = found.filter((i) => /overlay transition|covers? the frame|backstop/i.test(i.description) && !/showcase|shader transition/i.test(i.description)).slice(0, 3);
  }
  if (brief.background?.wanted) {
    lists.background = await shortlistFor(ws, `${brief.background.description || ''} background`.trim(), { needsText: false, type: 'block', prompt, background: true });
  }
  return { blocks: lists, components };
}

// ---- 3. Plan -----------------------------------------------------------------

const PLAN_SHAPE = `{
  "title": "", "kind": "",
  "format": { "width": 1920, "height": 1080, "fps": 30, "duration": 15 },
  "theme": { "preset": "<name>" } OR { "name": "", "colors": { "ground": "#hex", "ink": "#hex", "accent": "#hex" }, "fonts": ["Family"], "rules": [] },
  "scenes": [ {
    "id": "kebab-id", "layer": "main | background | overlay | transition", "start": 0, "duration": 5,
    "purpose": "what the viewer takes from it", "text": ["exact copy"],
    "block": "<registry name from the shortlist, or null to hand-build>", "components": [],
    "vars": { "<variable id of the block or its components>": "<value>" },
    "build": "layout and objects in numbers (px, %, hex)", "motion": "the one hero move, eases, hand-off", "sound": ""
  } ],
  "audio": { "music": null, "sfx": null, "voiceover": null },
  "spec": "SPEC.md text following the template",
  "decisions": ["choices you made"]
}`;

function planSystem(lib) {
  const template = readSection(lib, 'hyperframes', 'references/spec.md', 'the-template') ?? '';
  const lookLine = readSection(lib, 'hyperframes', 'references/look.md', 'the-look-line') ?? '';
  return `You plan a HyperFrames video from a brief and a shortlist of registry blocks. Reply with JSON only, in this shape:
${PLAN_SHAPE}
Rules:
- One main scene per beat, same id, start and duration as the brief. Each brief overlay is ONE scene with layer "overlay", same id and time range. A background the brief wants is ONE scene with layer "background" spanning the whole film; add no background or overlay the brief does not have.
- Each brief transition of kind "cover" is ONE scene with layer "transition", same id, start = at - duration/2, that duration, no text: it covers the whole frame at its midpoint (hiding the cut) in theme colours and uncovers into the next beat. Use a block from its shortlist only if one fits, else hand-build (build says the shapes, colours and direction).
- For a "handoff" transition there is no scene: the outgoing beat's motion ends with the exit and the next beat's motion starts with the matching entrance (e.g. whip: smear out 0.2 s / land blurred and sharpen 0.13 s). Say this in both scenes' motion.
- vars holds only variable ids that the chosen block or components list. A hand-built scene with no components has empty vars: its layout, sizes and fonts go in build.
- For each scene pick a block from that beat's shortlist BY ITS DESCRIPTION: what it shows must match the beat's intent AND the brief's look.mood (no 3D spectacle for a calm editorial piece, no diagram plates for a wordmark, no chat UI for a headline). If nothing fits, use null and hand-build.
- A hand-built scene may use components from that beat's component shortlist (list them in components); the scene supplies the copy.
- Never name a block or component outside the shortlists.
- motion and build describe what the chosen block actually does (from its description) and how you tune it: set its behaviour controls in vars. Do not invent effects the block does not have.
- If a block animates with its bundled font, keep that font for that scene and say so in decisions; the theme font applies to hand-built scenes.
- Repeating a block for two beats is fine; vary its controls (e.g. direction) so the beats differ.
- Add no effects the brief did not ask for (grain, vignette, glow, extra copy).
- Set the chosen block's text variables to the beat's copy exactly, and its colour variables to theme colours. Only use variable ids the shortlist lists for that block.
- With a background layer, every main block must let it show through: set its background/ground variable to "transparent" (never a solid colour), and say in build to clear any opaque ground in its CSS.
- Theme: if the brief names a preset, theme is exactly {"preset": "<that name>"} (its own colours and fonts apply). Otherwise a custom theme with the brief's colours and fonts. SPEC.md may use only theme colours (#FFFFFF/#000000 allowed). Colour variables take colours, never "transparent" (only background/ground variables may be transparent).
- spec follows the template below, with numbers instead of adjectives.

<spec-template>
${template}
</spec-template>
<look-line>
${lookLine}
</look-line>`;
}

// What each candidate IS and DOES, not just its variable names: the plan picks by this.
function describeCandidate(i) {
  const ctl = (i.controls ?? []).map((c) => `${c.id}=${JSON.stringify(c.default)}${c.options ? ` (${c.options.join('|')})` : ''}`).join(', ');
  return [
    `- ${i.name} [${i.duration ?? '?'}s]: ${i.description || '(no description)'}`,
    `    text vars: ${i.textVars.join(', ') || 'none'} | colour vars: ${i.colorVars.join(', ') || 'none'}`,
    ctl ? `    behaviour controls (set these to shape its motion): ${ctl}` : null,
    i.fonts?.length ? `    animates with its bundled font: ${i.fonts.join(', ')} (the theme font will not drive this effect)` : null,
  ].filter(Boolean).join('\n');
}

function shortlistText({ blocks, components }) {
  return Object.entries(blocks).map(([beat, items]) => {
    const comps = components[beat] ?? [];
    return [
      `${beat} blocks:`,
      items.length ? items.map(describeCandidate).join('\n') : '- (no fitting block: hand-build)',
      comps.length ? `${beat} components (for a hand-built scene):\n${comps.map(describeCandidate).join('\n')}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

const allItems = (sl) => [...Object.values(sl.blocks ?? {}), ...Object.values(sl.components ?? {})].flat();

// Checks only the shortlist can answer: real variable ids, a background block for the background
// layer, the brief's preset, readable timing.
export function planChecks(plan, brief, sl) {
  const errs = [];
  const info = Object.fromEntries(allItems(sl).map((i) => [i.name, i]));
  const varsOf = (i) => [...i.textVars, ...i.imageVars, ...i.colorVars, ...i.otherVars];
  for (const s of plan.scenes ?? []) {
    // Variables must belong to what the scene uses: its block, or its components.
    const used = [s.block, ...(s.components ?? [])].filter(Boolean).map((n) => info[n]).filter(Boolean);
    const known = new Set(used.flatMap(varsOf));
    const given = Object.keys(s.vars ?? {});
    if (!s.block && !(s.components ?? []).length && given.length) {
      errs.push(s.id + ': a hand-built scene with no components has no variables; move ' + given.join(', ') + ' into build');
    } else if (used.length) {
      const unknown = given.filter((k) => !known.has(k));
      if (unknown.length) errs.push(s.id + ': ' + used.map((i) => i.name).join(' + ') + ' has no variable(s) ' + unknown.join(', ') + '; it has ' + ([...known].join(', ') || 'none'));
    }
    for (const i of used) {
      for (const k of i.colorVars) {
        if (/transparent/i.test(String(s.vars?.[k] ?? '')) && !/background|ground|bg|backdrop/i.test(k)) errs.push(s.id + ': ' + k + ' is a colour, not a ground; give it a theme colour');
      }
    }
    if (s.layer === 'background' && s.block && !(sl.blocks.background ?? []).some((x) => x.name === s.block)) {
      errs.push(s.id + ': the background layer must use a block from the background shortlist, not ' + s.block);
    }
    if ((s.layer ?? 'main') !== 'background') {
      const floor = readFloor(s.text ?? []);
      if (floor && s.duration < floor - 0.01) errs.push(s.id + ': ' + s.duration + 's is too short to read its copy (needs ' + floor.toFixed(1) + 's)');
    }
  }
  // Overlays: exactly the brief's, same time range.
  const overlays = (plan.scenes ?? []).filter((s) => s.layer === 'overlay');
  for (const o of brief.overlays ?? []) {
    const s = overlays.find((x) => x.id === o.id);
    if (!s) errs.push('overlay ' + o.id + ' from the brief is missing; add it as a scene with layer "overlay"');
    else if (Math.abs(s.start - o.start) > 0.11 || Math.abs(s.start + s.duration - o.end) > 0.11) errs.push('overlay ' + o.id + ' must run ' + o.start + '–' + o.end + 's as in the brief');
  }
  for (const s of overlays) if (!(brief.overlays ?? []).some((o) => o.id === s.id)) errs.push('overlay ' + s.id + ' is not in the brief; remove it');
  const transitions = (plan.scenes ?? []).filter((s) => s.layer === 'transition');
  for (const tr of (brief.transitions ?? []).filter((x) => x.kind === 'cover')) {
    const s = transitions.find((x) => x.id === tr.id);
    if (!s) errs.push('cover transition ' + tr.id + ' from the brief is missing; add it as a scene with layer "transition"');
    else if (Math.abs(s.start + s.duration / 2 - tr.at) > 0.06) errs.push('transition ' + tr.id + ' must be centred on the seam at ' + tr.at + 's');
    else if ((s.text ?? []).some((x) => String(x).trim())) errs.push('transition ' + tr.id + ' has no text');
  }
  for (const s of transitions) if (!(brief.transitions ?? []).some((x) => x.id === s.id && x.kind === 'cover')) errs.push('transition ' + s.id + ' is not a cover transition in the brief; remove it');
  if (brief.look?.preset && plan.theme?.preset !== brief.look.preset) errs.push('theme must be {"preset": "' + brief.look.preset + '"} as the brief asks');
  if (!brief.background?.wanted && plan.scenes?.some((s) => s.layer === 'background')) errs.push('the brief wants no background layer; remove it and use the theme ground');
  return errs;
}

// ---- 4. Rate --------------------------------------------------------------------
// 10 points: copy 2, timing 1, plan checks 1, theme+audio 1, background 2, fonts 1, block fit 2 (judge).

export function ratePlan(plan, brief, validation, { lists = { blocks: {}, components: {} }, judge = null } = {}) {
  const items = [];
  const add = (points, max, label, note) => items.push({ points: Math.max(0, Math.min(max, points)), max, label, note });

  const holders = [...brief.beats, ...(brief.overlays ?? [])];
  const planText = plan.scenes.flatMap((s) => s.text ?? []).join(' \n ');
  const copy = holders.flatMap((b) => b.copy ?? []).filter(Boolean);
  const kept = copy.filter((c) => planText.includes(c));
  add(copy.length ? (2 * kept.length) / copy.length : 2, 2, 'copy kept verbatim', `${kept.length}/${copy.length}${kept.length < copy.length ? `; missing: ${copy.filter((c) => !kept.includes(c)).join(' | ')}` : ''}`);

  const mains = plan.scenes.filter((s) => (s.layer ?? 'main') === 'main');
  const timedScene = (h, layer) => plan.scenes.some((s) => (s.layer ?? 'main') === layer && Math.abs(s.start - h.start) < 0.11 && Math.abs(s.start + s.duration - h.end) < 0.11);
  const timed = [...brief.beats.filter((b) => timedScene(b, 'main')), ...(brief.overlays ?? []).filter((o) => timedScene(o, 'overlay'))];
  add(timed.length / holders.length, 1, 'beat and overlay timing match the brief', `${timed.length}/${holders.length}`);

  add(validation ? 0 : 1, 1, 'passes plan checks (blocks exist and fit, layers)', validation ? validation.split('\n')[0] : 'ok');

  const wantColors = Object.values(brief.look?.colors ?? {}).filter(Boolean).map((c) => c.toUpperCase());
  const haveColors = Object.values(plan.theme?.colors ?? {}).map((c) => String(c).toUpperCase());
  const themeOk = brief.look?.preset ? plan.theme?.preset === brief.look.preset : wantColors.every((c) => haveColors.includes(c));
  const audioOk = brief.audio !== 'none' || (!plan.audio?.music && !plan.audio?.voiceover);
  add((themeOk ? 0.5 : 0) + (audioOk ? 0.5 : 0), 1, 'theme and audio as requested',
    [themeOk ? null : `theme: wanted ${brief.look?.preset ?? wantColors.join(', ')}`, audioOk ? null : 'plans audio the brief ruled out'].filter(Boolean).join('; ') || 'ok');

  const bg = plan.scenes.find((s) => s.layer === 'background');
  const covering = bg ? opaqueOverBackground(plan) : [];
  const bgOk = brief.background?.wanted
    ? Boolean(bg && bg.start <= 0.05 && bg.start + bg.duration >= plan.format.duration - 0.05) && !covering.length
    : !bg;
  add(bgOk ? 2 : 0, 2, 'background layer as requested and visible', bgOk ? 'ok'
    : !brief.background?.wanted ? 'added though not asked'
      : covering.length ? `covered by an opaque ground in: ${covering.join(', ')}` : 'missing or not full length');

  // A block that animates with its own font must not be told to use the theme font.
  const info = Object.fromEntries(allItems(lists).map((i) => [i.name, i]));
  const themeFonts = (plan.theme?.fonts ?? brief.look?.fonts ?? []).map((f) => f.toLowerCase());
  const fontClash = mains.filter((s) => {
    const bundled = (info[s.block]?.fonts ?? []).map((f) => f.toLowerCase());
    if (!bundled.length) return false;
    const text = `${s.build} ${s.motion}`.toLowerCase();
    const keepsBundled = bundled.some((f) => text.includes(f) || (plan.decisions ?? []).join(' ').toLowerCase().includes(f));
    return !keepsBundled && themeFonts.some((f) => text.includes(f));
  }).map((s) => `${s.id} (${s.block} animates with ${info[s.block].fonts.join(', ')})`);
  add(fontClash.length ? 0 : 1, 1, 'fonts work with the chosen blocks', fontClash.length ? `theme font set on: ${fontClash.join('; ')}` : 'ok');

  // Judge: every scene (block, components or hand-built) — does what it shows suit the beat and the mood,
  // and does the motion describe what the chosen items actually do? A scene the judge skipped counts as fit 1.
  const judged = new Map((judge?.scenes ?? []).map((s) => [s.id, s]));
  const expected = plan.scenes.map((s) => s.id);
  if (judged.size) {
    const fits = expected.map((id) => Number(judged.get(id)?.fit) || 1);
    const avg = fits.reduce((a, b) => a + b, 0) / fits.length;
    const mismatched = [...judged.values()].filter((s) => s.motion_matches === false);
    const weak = [...judged.values()].filter((s) => (Number(s.fit) || 0) <= 2);
    const skipped = expected.filter((id) => !judged.has(id));
    add(((avg - 1) / 4) * 1.5 + (mismatched.length ? 0 : 0.5), 2, 'scenes suit their beats and the mood (judge)',
      [...weak.map((s) => `${s.id} fit ${s.fit}/5: ${s.why}`), ...mismatched.map((s) => `${s.id} motion doesn't match what it uses`), ...skipped.map((id) => `${id} not judged`)].join(' | ') || `avg fit ${avg.toFixed(1)}/5`);
  } else {
    add(0, 2, 'scenes suit their beats and the mood (judge)', 'judge failed');
  }

  const score = +items.reduce((n, i) => n + i.points, 0).toFixed(1);
  return { score, max: 10, items };
}

const JUDGE_SYSTEM = `You review every scene of a video plan. A scene uses a registry block, registry components, or is hand-built (its build describes the design). For EVERY scene, judge:
- fit: 1-5, how well what the scene SHOWS (the descriptions of what it uses, or its build) suits the beat's intent, its copy AND the film's look/mood. 5 = made for it, 3 = workable, 1 = wrong kind of thing (a diagram block for a wordmark, a chat UI for a headline, a sign-up form for an end card, a gauge with no data, 3D spectacle in a calm editorial piece, another company's product UI in someone's own promo).
- motion_matches: true if the plan's motion/build describe what the used items actually do (hand-built: plausible from its build); false if it invents effects they do not have.
Reply with JSON only, one entry per scene id: {"scenes":[{"id":"","fit":1,"motion_matches":true,"why":"one short sentence"}]}`;

async function judgePlan(provider, plan, brief, lists, usage, prompt) {
  const info = Object.fromEntries(allItems(lists).map((i) => [i.name, i]));
  const holders = [...brief.beats, ...(brief.overlays ?? []), ...(brief.transitions ?? []).map((x) => ({ id: x.id, intent: `${x.kind} transition: ${x.style}` }))];
  const rows = plan.scenes.map((s) => {
    const beat = holders.find((b) => b.id === s.id);
    const uses = [s.block, ...(s.components ?? [])].filter(Boolean);
    return {
      id: s.id, layer: s.layer ?? 'main', intent: beat?.intent ?? (s.layer === 'background' ? brief.background?.description : '') ?? '', copy: s.text,
      uses: uses.length ? uses.map((n) => ({ name: n, does: info[n]?.description ?? '(unknown)' })) : 'hand-built',
      plan_motion: s.motion, plan_build: s.build,
    };
  });
  if (!rows.length) return null;
  const film = { request: prompt, look_mood: brief.look?.mood ?? '', avoid: brief.avoid ?? [] };
  return ask(provider, JUDGE_SYSTEM, `${JSON.stringify(film, null, 1)}

Scenes:
${JSON.stringify(rows, null, 1)}`, usage);
}

// ---- Pipeline ----------------------------------------------------------------------

export async function ask(provider, system, user, usage, { signal } = {}) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let max = config.maxOutputTokens;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const { message, finish, usage: u } = await chat(provider, messages, null, { maxOutputTokens: max, signal });
    usage.input += u.input;
    usage.output += u.output;
    usage.calls += 1;
    // Reasoning models spend output tokens thinking; a reply cut off mid-JSON gets one retry with more room.
    if (finish === 'length' && attempt === 0 && max < 64_000) {
      console.error(`[plan] ${provider.name} reply was cut off at ${max} output tokens; retrying with ${max * 2}`);
      max *= 2;
      continue;
    }
    const raw = message.content ?? '';
    usage.lastRaw = raw;
    return parseModelJson(raw);
  }
}

// The reply's one top-level object, or null. Never an inner fragment of a broken reply.
export function parseModelJson(text) {
  const s = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Settings picked in the app (aspect, length, theme) arrive as options, not prompt text.
const ASPECT = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };

function settingsText(options = {}) {
  const lines = [];
  if (ASPECT[options.aspect]) lines.push(`- Aspect ${options.aspect}: ${ASPECT[options.aspect].join('x')}.`);
  if (options.duration) lines.push(`- Duration: ${options.duration} s, unless the request itself gives a length.`);
  if (options.theme && listThemes().some((t) => t.name === options.theme)) lines.push(`- Theme preset: ${options.theme} (set look.preset).`);
  return lines.length ? `\n\nSettings chosen in the app:\n${lines.join('\n')}` : '';
}

export function checkSettings(brief, options = {}) {
  const want = ASPECT[options.aspect];
  if (want && (brief.format?.width !== want[0] || brief.format?.height !== want[1])) return [`format must be ${want.join('x')} (aspect ${options.aspect} was chosen in the app)`];
  return [];
}

// dir: re-plan inside an existing job folder (a resumed job) instead of creating one.
// judge: false skips the rating call (it only scores the plan; the build does not need it).
export async function runPlan({ prompt, options = {}, onEvent = () => {}, jobsDir, dir, judge: withJudge = true, signal, mode = 'plan-only' } = {}) {
  const provider = providerForRole('planner');
  const ws = dir ? Workspace.open(dir) : Workspace.create(jobsDir);
  const lib = new SkillLibrary(config.skillsDir);
  const usage = { input: 0, output: 0, calls: 0 };
  const prior = ws.readJson('request.json', {});
  ws.writeJson('request.json', { ...prior, prompt, options, createdAt: prior.createdAt ?? new Date().toISOString(), mode });
  onEvent({ type: 'job_start', job: ws.id, dir: ws.dir, resume: Boolean(dir) });
  const askP = (system, user) => ask(provider, system, user, usage, { signal });
  const request = `${prompt}${settingsText(options)}`;
  const briefProblems = (b) => (Array.isArray(b?.beats) ? [...checkBrief(b, prompt, options), ...checkSettings(b, options)] : ['reply was not a brief object with beats[] (cut off or invalid JSON)']);

  // 1. Understand
  onEvent({ type: 'step', step: 'understand', provider: `${provider.name}/${provider.model}` });
  let brief = await askP(UNDERSTAND_SYSTEM, request);
  let briefErrs = briefProblems(brief);
  if (briefErrs.length) {
    onEvent({ type: 'repair', step: 'understand', errors: briefErrs });
    brief = await askP(UNDERSTAND_SYSTEM, `${request}\n\nYour previous brief had these problems; fix them:\n- ${briefErrs.join('\n- ')}\n\nPrevious brief:\n${JSON.stringify(brief)}`);
    briefErrs = briefProblems(brief);
  }
  if (!Array.isArray(brief?.beats)) {
    ws.writeJson('brief.raw.json', { raw: usage.lastRaw ?? null });
    throw new Error(`The model did not return a usable brief (raw reply saved to ${ws.meta('brief.raw.json')})`);
  }
  ws.writeJson('brief.json', brief);
  onEvent({ type: 'brief', brief, errors: briefErrs });

  // 1b. Story: three storylines, build the recommended one (falls back to the brief if it can't keep it intact).
  let storyline = null;
  const gate = storyApplies(brief, prompt);
  if (gate.applies) {
    onEvent({ type: 'step', step: 'story' });
    const { story, errs } = await storyPass(askP, lib, brief, request, prompt, options, onEvent);
    if (!errs.length) {
      ws.writeJson('brief.original.json', brief);
      brief = story.brief;
      storyline = story.storylines[story.pick];
      ws.writeJson('brief.json', brief);
      ws.writeJson('story.json', story);
      fs.writeFileSync(ws.meta('STORYLINES.md'), storylinesMarkdown(story));
      onEvent({ type: 'story', story, brief });
    } else {
      onEvent({ type: 'story', skipped: `the storyline broke the brief: ${errs.join('; ')}` });
    }
  } else {
    onEvent({ type: 'story', skipped: gate.why });
  }

  // 2. Shortlist (code)
  onEvent({ type: 'step', step: 'shortlist' });
  const lists = await shortlist(ws, brief, prompt);
  ws.writeJson('shortlist.json', lists);
  onEvent({ type: 'shortlist', lists });

  // 3. Plan
  onEvent({ type: 'step', step: 'plan' });
  const system = planSystem(lib);
  const input = [
    `<brief>\n${JSON.stringify(brief, null, 1)}\n</brief>`,
    storyline ? `<storyline>\nThe film tells this storyline; SPEC.md, each scene's build and motion follow it.\n${JSON.stringify(storyline, null, 1)}\n</storyline>` : null,
    `<shortlist>\n${shortlistText(lists)}\n</shortlist>`,
  ].filter(Boolean).join('\n\n');
  const ctx = { ws, seenRegistry: new Set(allItems(lists).map((i) => i.name)), readLog: new Set() };
  const validate = async (p) => {
    if (!Array.isArray(p?.scenes)) return 'reply was not a plan object with scenes[] (cut off or invalid JSON); reply with the whole plan';
    const errs = [await plannerHandoff.validate(p, ctx), ...planChecks(p, brief, lists)].filter(Boolean);
    return errs.length ? errs.join('\n') : null;
  };
  let plan = await askP(system, input);
  let problems = await validate(plan);
  if (problems) {
    onEvent({ type: 'repair', step: 'plan', errors: problems.split('\n') });
    plan = await askP(system, `${input}\n\nYour previous plan had these problems; fix them and reply with the whole plan:\n${problems}\n\nPrevious plan:\n${JSON.stringify(plan)}`, usage);
    problems = await validate(plan);
  }
  if (!Array.isArray(plan?.scenes)) {
    ws.writeJson('plan.raw.json', { raw: usage.lastRaw ?? null });
    throw new Error(`The model did not return a usable plan (raw reply saved to ${ws.meta('plan.raw.json')})`);
  }
  ws.writeJson('plan.json', plan);

  // 4. Rate (code)
  if (withJudge) onEvent({ type: 'step', step: 'judge' });
  const judge = withJudge ? await judgePlan(provider, plan, brief, lists, usage, prompt).catch(() => null) : null;
  ws.writeJson('judge.json', judge);
  const rating = ratePlan(plan, brief, problems, { lists, judge });
  ws.writeJson('rating.json', rating);
  const { lastRaw, ...counts } = usage;
  ws.writeJson('usage.json', { planner: { ...counts, turns: counts.calls, runs: 1 } });
  ws.setState({ stage: 'planned-only' });
  onEvent({ type: 'plan', plan, problems, rating, usage });
  return { job: ws.id, dir: ws.dir, brief, lists, plan, problems, rating, usage };
}


