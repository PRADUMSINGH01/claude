import { makeSkillTools } from '../tools/skill-tools.js';
import { inspectItem, makeRegistryTools, listThemes } from '../tools/registry-tools.js';
import { makeFileTools, makeHfTool } from '../tools/project-tools.js';
import { fence, rolePrompt } from './common.js';

const BODY = `## How to plan
1. Read the request. Classify the film (explainer, launch, data, music, vertical, 3D, character, title card). Read the matching types/ file's key section if there is one.
2. Pick the theme: a preset from list_themes only when the request names one (presets are slide-deck looks, never the fallback for a film: look.md#presets). Otherwise a custom theme with exact hex colours and named fonts, taken from the brand, a reference, or the subject's own world (look.md#the-look-line); Inter, Space Grotesk, Instrument Serif, Geist and JetBrains Mono only when the brand uses them. Never leave colours or fonts as adjectives.
3. Beat by beat, search the registry (registry_search) for a block that IS the scene, or components that make it. Search with what the beat should do or look like, in 2–4 words ("aurora background", "bar chart race", "lower third"). Use only names the search returned. Then registry_inspect your candidates: a scene with copy needs an item with text variables; an item with image variables needs images you actually have. The harness rejects plans that break this.
4. Write SPEC.md content following the template already loaded below (GOAL, OUTPUT, TIME, LOOK, OBJECTS, MOTION, SHOTS, BANNED, QA), with numbers where you would write adjectives.
5. Data and facts: plan only charts and counters the request's own figures can fill. If a block needs data you were not given (a ranking, a time series), choose a form that shows only the given facts.
6. Call submit_plan. Main scenes are back to back from 0 and their durations add up to the film's duration. A background that runs under several beats (or an overlay over them) is its own scene with layer "background"/"overlay" and any range inside the film; mount it once, not per beat. A registry block's scene should be close to the block's own duration unless you note how to trim it.

Defaults unless the request says otherwise: 1920x1080, 30 fps; 15–30 s for a short piece. Music and sound for a film over ~15 s that tells something (sound.md). No voiceover or captions unless asked.`;

const scene = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short kebab-case id, unique' },
    layer: {
      type: 'string',
      enum: ['main', 'background', 'overlay', 'transition'],
      description: 'main scenes play back to back from 0; a background (under) or overlay (over) scene may span any range of the film, e.g. a background for the whole film',
    },
    start: { type: 'number' },
    duration: { type: 'number' },
    purpose: { type: 'string', description: 'what the viewer must take from this scene' },
    text: { type: 'array', items: { type: 'string' }, description: 'exact on-screen copy' },
    block: { type: ['string', 'null'], description: 'registry block name that becomes this scene, or null' },
    components: { type: 'array', items: { type: 'string' }, description: 'registry components merged into the scene' },
    vars: { type: 'object', description: 'values for the block\'s variables (copy, and theme colours/fonts)' },
    build: { type: 'string', description: 'how to adapt the block or hand-build the scene: layout, objects, numbers' },
    motion: { type: 'string', description: 'the one hero move, eases, entrances/exits, hand-off to next scene' },
    sound: { type: 'string' },
  },
  required: ['id', 'start', 'duration', 'purpose', 'text', 'block', 'components', 'build', 'motion'],
  additionalProperties: false,
};

// Main scenes whose own ground would paint over the background layer.
export function opaqueOverBackground(plan) {
  const bg = plan.scenes.find((s) => s.layer === 'background');
  if (!bg) return [];
  return plan.scenes
    .filter((s) => (s.layer ?? 'main') === 'main' && s.start < bg.start + bg.duration && s.start + s.duration > bg.start)
    .filter((s) => Object.entries(s.vars ?? {}).some(([k, v]) => /^(background|bg|ground|backgroundcolor|bgcolor|base)$/i.test(k) && !/^(transparent|none|rgba\([^)]*,\s*0\s*\))$/i.test(String(v).trim())))
    .map((s) => s.id);
}

export const plannerHandoff = {
  name: 'submit_plan',
  description: 'Hand the finished plan to the builder.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      kind: { type: 'string', description: 'explainer | launch | data | music | vertical | 3d | character | title | other' },
      format: {
        type: 'object',
        properties: { width: { type: 'integer' }, height: { type: 'integer' }, fps: { type: 'integer' }, duration: { type: 'number' } },
        required: ['width', 'height', 'fps', 'duration'],
        additionalProperties: false,
      },
      theme: {
        type: 'object',
        description: 'Either {preset} or a custom {name, colors, fonts, rules}. Optional roles maps ground/ink/accent to colour keys.',
        properties: {
          preset: { type: 'string' },
          name: { type: 'string' },
          colors: { type: 'object', additionalProperties: { type: 'string' } },
          fonts: { type: 'array', items: { type: 'string' } },
          rules: { type: 'array', items: { type: 'string' } },
          roles: { type: 'object', properties: { ground: { type: 'string' }, ink: { type: 'string' }, accent: { type: 'string' }, display: { type: 'string' }, body: { type: 'string' } }, additionalProperties: false },
        },
        additionalProperties: false,
      },
      scenes: { type: 'array', items: scene, minItems: 1 },
      audio: {
        type: 'object',
        properties: { music: { type: ['string', 'null'] }, sfx: { type: ['string', 'null'] }, voiceover: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
      spec: { type: 'string', description: 'Full SPEC.md text' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'choices you made where the request was silent' },
    },
    required: ['title', 'kind', 'format', 'theme', 'scenes', 'spec'],
    additionalProperties: false,
  },
  async validate(p, ctx) {
    const errs = [];
    const { width, height, fps, duration } = p.format ?? {};
    if (!(width >= 240 && height >= 240 && fps >= 12 && duration > 0 && duration <= 300)) errs.push('format needs sane width/height/fps and 0 < duration ≤ 300');
    const ids = new Set();
    let t = 0;
    for (const s of p.scenes ?? []) {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(s.id ?? '')) errs.push(`scene id "${s.id}" must be short kebab-case`);
      if (ids.has(s.id)) errs.push(`duplicate scene id ${s.id}`);
      ids.add(s.id);
      if (!(s.duration > 0)) errs.push(`scene ${s.id} needs a positive duration`);
      if ((s.layer ?? 'main') === 'main') {
        if (Math.abs(s.start - t) > 0.051) errs.push(`main scene ${s.id} starts at ${s.start}s but the previous main scene ends at ${t.toFixed(2)}s (a scene that runs under or over others needs layer "background" or "overlay")`);
        t = s.start + s.duration;
      } else if (s.start < 0 || (duration && s.start + s.duration > duration + 0.051)) {
        errs.push(`${s.layer} scene ${s.id} must sit inside 0–${duration}s`);
      }
      for (const n of [s.block, ...(s.components ?? [])].filter(Boolean)) {
        if (!ctx.seenRegistry.has(n)) errs.push(`"${n}" (scene ${s.id}) did not come from registry_search; search for it or hand-build`);
      }
    }
    if (duration && Math.abs(t - duration) > 0.051) errs.push(`main scenes end at ${t.toFixed(2)}s but format.duration is ${duration}s`);
    const th = p.theme ?? {};
    if (th.preset && !listThemes().some((x) => x.name === th.preset)) errs.push(`theme preset "${th.preset}" does not exist; call list_themes`);
    if (!th.preset && !(Object.keys(th.colors ?? {}).length >= 2 && th.fonts?.length)) errs.push('a custom theme needs at least 2 hex colours and 1 font');
    for (const [k, v] of Object.entries(th.colors ?? {})) if (!/^#[0-9a-f]{3,8}$|^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i.test(v)) errs.push(`theme colour ${k} must be hex or rgb()/rgba(), got ${v}`);
    // SPEC.md may only use the theme's colours.
    // A preset may be extended with extra colours; both count.
    const presetColors = th.preset ? (listThemes().find((x) => x.name === th.preset)?.colors ?? {}) : {};
    const palette = new Set([...Object.values(presetColors), ...Object.values(th.colors ?? {})].map((c) => c.toUpperCase()));
    const neutral = new Set(['#FFFFFF', '#000000']);
    const stray = [...new Set((p.spec ?? '').match(/#[0-9a-f]{6}\b/gi) ?? [])].filter((c) => palette.size && !palette.has(c.toUpperCase()) && !neutral.has(c.toUpperCase()));
    if (stray.length) {
      errs.push(th.preset
        ? `SPEC.md uses colours outside the "${th.preset}" preset (${stray.join(', ')}). Either use only ${[...palette].join(', ')}, or, if the film needs your colours (e.g. a dark look on a light preset), drop the preset and give a custom theme {name, colors, fonts} with them.`
        : `SPEC.md uses colours outside your theme (${stray.join(', ')}); add them to theme.colors or use only: ${[...palette].join(', ')}`);
    }
    if ((p.spec ?? '').length < 300) errs.push('spec is too thin; fill the SPEC.md template');
    if (errs.length) return errs.join('\n');

    // Fit check: the item must be able to carry this scene's content without rewriting its script.
    for (const s of p.scenes ?? []) {
      if (!s.block || !ctx.ws) continue;
      const info = await inspectItem(ctx.ws, s.block);
      if (!info.ok) continue;
      const shown = (s.text ?? []).filter((t) => String(t).trim());
      if (shown.length && (s.layer ?? 'main') === 'main' && !info.textVars.length) {
        errs.push(`${s.block} (scene ${s.id}) has no text variables: its copy is hard-coded, so "${shown[0]}" can't be set. Pick an item with text variables (registry_inspect), or hand-build the scene with a component.`);
      }
      const missing = info.imageVars.filter((v) => !s.vars?.[v]);
      if (missing.length) {
        errs.push(`${s.block} (scene ${s.id}) shows ${missing.length} image(s) (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}) that default to demo photos, and the plan supplies none. Pick another item.`);
      }
    }
    const covering = opaqueOverBackground(p);
    if (covering.length) errs.push(`the background layer would be hidden: ${covering.join(', ')} set an opaque background/ground variable; set it to "transparent"`);
    return errs.length ? errs.join('\n') : null;
  },
};

export function plannerAgent(ctx, { prompt, options }) {
  const registry = makeRegistryTools('planner');
  // Remember which names searches returned, so the plan can't invent items.
  const search = registry.find((t) => t.name === 'registry_search');
  const run = search.run;
  search.run = async (args, c) => {
    const out = await run(args, c);
    const text = typeof out === 'string' ? out : out.text;
    for (const m of text.matchAll(/^- ([a-z0-9-]+) \[/gm)) c.seenRegistry.add(m[1]);
    return out;
  };
  return {
    role: 'planner',
    system: rolePrompt('planner', ctx.lib, BODY),
    task: [
      fence('request', prompt),
      options && Object.keys(options).length ? fence('options', JSON.stringify(options, null, 2)) : '',
      'Plan this film. Call submit_plan when done.',
    ].filter(Boolean).join('\n\n'),
    tools: [...makeSkillTools(), ...registry, makeHfTool('planner'), ...makeFileTools({ write: false })],
    handoff: plannerHandoff,
  };
}
