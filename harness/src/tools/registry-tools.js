// Registry (≈450 blocks/components) and theme (frame presets) tools.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { hfJson } from '../hf.js';
import { splitSections } from '../skills/library.js';
import { clip } from '../sandbox.js';

export const PRESETS_DIR = () => path.join(config.skillsDir, 'hyperframes', 'assets', 'frame-presets');

async function catalogQuery(ws, query, type, tag) {
  const args = ['catalog', '--query', query];
  if (type) args.push('--type', type);
  if (tag) args.push('--tag', tag);
  const res = await hfJson(ws, args, { timeoutSec: 120 });
  return res.json ? { results: res.json.results ?? [], meta: res.json } : { error: `catalog failed (exit ${res.code}): ${clip(res.output, 1500)}` };
}

const STOP = new Set(['the', 'and', 'with', 'for', 'that', 'this', 'from', 'into', 'over', 'under', 'loop', 'style', 'animated', 'animation', 'scene']);

export async function catalogSearch(ws, { query, type, tag, limit = 12 }) {
  let { results, meta, error } = await catalogQuery(ws, query, type, tag);
  if (error) return { items: [], text: error };
  let note = '';
  // The word tier wants items that share the query's words; a long query often matches nothing.
  // Retry each keyword and rank items by how many keywords found them.
  if (!results.length) {
    const words = [...new Set(String(query).toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 3 && !STOP.has(w)))].slice(0, 6);
    const score = new Map();
    for (const w of words) {
      const r = await catalogQuery(ws, w, type, tag);
      for (const [i, item] of (r.results ?? []).slice(0, 15).entries()) {
        const s = score.get(item.name) ?? { item, n: 0, rank: 0 };
        s.n += 1;
        s.rank += i;
        score.set(item.name, s);
      }
    }
    results = [...score.values()].sort((a, b) => b.n - a.n || a.rank - b.rank).map((s) => s.item);
    if (results.length) note = `\n(no item matched the whole query; these matched its keywords: ${words.join(', ')})`;
  }
  const items = results.slice(0, limit).map((r) => ({
    name: r.name, type: r.type, title: r.title, description: r.description, tags: r.tags ?? [],
    duration: r.duration ?? null, size: r.dimensions ? `${r.dimensions.width}x${r.dimensions.height}` : null,
    poster: r.preview?.poster ?? null,
  }));
  const text = items.length
    ? items.map((r) => `- ${r.name} [${r.type}${r.duration ? `, ${r.duration}s` : ''}${r.size ? `, ${r.size}` : ''}] ${r.description} (tags: ${r.tags.slice(0, 6).join(', ')})`).join('\n')
      + (note || `\n(${meta.shown ?? items.length} matched of ${meta.total ?? '?'}; tier ${meta.tier})`)
    : `No registry match for "${query}" or its keywords. Try other words (what it looks like: "aurora", "gradient", "particles"), or hand-build.`;
  return { items, text };
}

// ---- Inspect before planning ------------------------------------------------

// Installs an item into a scratch project (not the film's) to read what it exposes. Cached per job.
// Each item's registry-item.json (a few KB) lists its variables; no install, no asset downloads.
// What a written scene may not contain (scenes.js contract): renders must repeat frame for frame.
export const NONDETERMINISTIC = /Date\.now|Math\.random|fetch\(|setTimeout|setInterval|repeat:\s*-1/;

async function fetchManifest(name) {
  const safe = String(name).replace(/[^a-z0-9-]/gi, '');
  for (const dir of ['blocks', 'components']) {
    try {
      const base = `${config.registryRawUrl}/${dir}/${safe}`;
      const res = await fetch(`${base}/registry-item.json`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const m = await res.json();
      // The composition file: variables when the manifest omits them, and whether its script is
      // deterministic (a component's source is merged into written scenes, which must be).
      const comp = (m.files ?? []).find((f) => f.type === 'hyperframes:composition' || /\.html$/.test(f.path));
      if (comp) {
        const html = await fetch(`${base}/${comp.path}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (html?.ok) {
          const src = await html.text();
          m.nondeterministic = NONDETERMINISTIC.test(src);
          if (!m.variables) {
            try {
              m.variables = JSON.parse(/data-composition-variables='([^']*)'/.exec(src)?.[1] ?? '[]');
            } catch {
              m.variables = [];
            }
          }
        }
      }
      return m.variables ? m : null;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

// Fallback: install into a scratch project (not the film's) and read the HTML.
async function scratchManifest(ws, name) {
  const scratch = path.join(ws.homeDir, 'inspect');
  if (!fs.existsSync(path.join(scratch, 'index.html'))) await hfJson(ws, ['init', 'inspect'], { cwd: ws.homeDir, timeoutSec: 300 });
  const res = await hfJson(ws, ['add', name], { cwd: scratch, timeoutSec: 300 });
  if (!res.json?.ok) return { error: clip(res.output, 600) };
  const html = (res.json.written ?? []).find((p) => p.endsWith('.html'));
  const src = html && fs.existsSync(html) ? fs.readFileSync(html, 'utf8') : '';
  let variables = [];
  try {
    variables = JSON.parse(/data-composition-variables='([^']*)'/.exec(src)?.[1] ?? '[]');
  } catch {
    /* none */
  }
  return { type: res.json.type, duration: Number(/data-duration="([\d.]+)"/.exec(src)?.[1] ?? 0) || null, variables, nondeterministic: NONDETERMINISTIC.test(src) };
}

// Options come as plain values or as { value, label }; the plan sets values.
const optionValues = (opts) => (Array.isArray(opts) ? opts.map((o) => (o && typeof o === 'object' ? o.value : o)) : null);

export async function inspectItem(ws, name) {
  const cachePath = ws.meta('inspect-cache.json');
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  if (cache[name]) return cache[name];
  const m = (await fetchManifest(name)) ?? (await scratchManifest(ws, name));
  if (m.error) return { name, ok: false, error: m.error };
  const vars = m.variables ?? [];
  const info = {
    name,
    ok: true,
    kind: String(m.type ?? '').replace('hyperframes:', ''),
    duration: m.duration ?? null,
    textVars: vars.filter((v) => v.type === 'string').map((v) => v.id),
    imageVars: vars.filter((v) => v.type === 'image' || v.type === 'video').map((v) => v.id),
    colorVars: vars.filter((v) => v.type === 'color').map((v) => v.id),
    otherVars: vars.filter((v) => !['string', 'image', 'video', 'color'].includes(v.type)).map((v) => v.id),
    // Behaviour controls with their defaults, so a plan can set them instead of inventing motion.
    controls: vars.filter((v) => !['string', 'image', 'video', 'color'].includes(v.type)).map((v) => ({ id: v.id, type: v.type, default: v.default, options: optionValues(v.options ?? v.enum) })),
    // Fonts the item ships: it animates with these, so a theme font may not apply to it.
    fonts: [...new Set((m.files ?? []).map((f) => f.path ?? f).filter((p) => /\.(woff2?|ttf|otf)$/i.test(p)).map((p) => p.split('/').pop().replace(/[-_](wght|slnt|latin|regular|variable|vf).*$/i, '').replace(/\.(woff2?|ttf|otf)$/i, '')))],
    tags: m.tags ?? [],
    // Pictures the item ships and shows whatever the film is (leaves, a coffee cup): its demo look.
    bakedMedia: (m.files ?? []).map((f) => f.path ?? f).filter((p) => /\.(webp|png|jpe?g|gif|avif|mp4|webm|mov|glb|gltf)$/i.test(p)),
    // three.js / WebGL scenes: software rendering (no GPU) stalls on them.
    needsGpu: (m.tags ?? []).some((t) => /^(three-js|webgl|3d-object)$/i.test(t)),
    nondeterministic: Boolean(m.nondeterministic),
    description: m.description ?? '',
  };
  cache[name] = info;
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  return info;
}

export function describeInspect(i) {
  if (!i.ok) return `- ${i.name}: could not inspect (${i.error})`;
  const parts = [
    i.textVars.length ? `text vars: ${i.textVars.join(', ')}` : 'NO text variables (its copy is hard-coded in the script)',
    i.imageVars.length ? `image/video vars: ${i.imageVars.join(', ')} (demo photos unless you supply files)` : null,
    i.colorVars.length ? `colour vars: ${i.colorVars.join(', ')}` : 'no colour variables (theme only by editing its CSS)',
  ].filter(Boolean);
  return `- ${i.name} [${i.kind}${i.duration ? `, ${i.duration}s` : ''}]: ${parts.join('; ')}`;
}

export async function registryAdd(ws, name, vars) {
  const args = ['add', name];
  if (vars && Object.keys(vars).length) args.push('--vars', JSON.stringify(vars));
  // Item files are fetched on every install; the registry host times out now and then.
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await hfJson(ws, args, { timeoutSec: 300 });
    if (res.json?.ok || !/timeout|could not download|ECONNRESET|fetch failed/i.test(res.output)) break;
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
  const j = res.json;
  if (!j?.ok) return { ok: false, text: `add ${name} failed (exit ${res.code}): ${clip(res.output, 2000)}` };
  const written = (j.written ?? []).map((p) => path.relative(ws.projectDir, p).split(path.sep).join('/'));
  return {
    ok: true,
    name: j.name,
    kind: String(j.type ?? '').replace('hyperframes:', ''),
    snippet: j.snippet,
    written,
    doc: written.find((p) => p.endsWith('/SKILL.md')) ?? null,
    variables: blockVariables(ws, written),
    text: `Installed ${j.name} (${j.type}).\nFiles: ${written.join(', ')}\nMount snippet:\n${j.snippet ?? '(component: merge its markup into a scene)'}${j.warnings?.length ? `\nWarnings: ${j.warnings.join('; ')}` : ''}`,
  };
}

// Variables declared by an installed block, so the builder can point colours/fonts at the theme.
export function blockVariables(ws, written) {
  const html = written.find((p) => p.endsWith('.html'));
  if (!html) return [];
  const src = fs.readFileSync(path.join(ws.projectDir, html), 'utf8');
  const m = /data-composition-variables='([^']*)'/.exec(src);
  try {
    return m ? JSON.parse(m[1]).map((v) => ({ id: v.id, type: v.type, default: v.default })) : [];
  } catch {
    return [];
  }
}

// ---- Themes -------------------------------------------------------------

export function listThemes() {
  const dir = PRESETS_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'FRAME.md'))).map((name) => {
    const text = fs.readFileSync(path.join(dir, name, 'FRAME.md'), 'utf8');
    return { name, ...themeTokens(text) };
  });
}

// Pull colours and font families out of FRAME.md frontmatter (flat YAML subset, enough for presets).
export function themeTokens(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const colors = {};
  const block = /^colors:\s*\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(fm)?.[1] ?? '';
  for (const line of block.split(/\r?\n/)) {
    const kv = /^\s+([A-Za-z0-9_-]+):\s*["']?(#[0-9A-Fa-f]{3,8}|rgba?\([^)]*\))["']?/.exec(line);
    if (kv) colors[kv[1]] = kv[2];
  }
  const fonts = [...new Set([...fm.matchAll(/fontFamily:\s*["']([^"']+)["']/g)].map((m) => m[1]))];
  const desc = /description:\s*>?\s*\r?\n?([\s\S]*?)\r?\n[a-z]+:/m.exec(fm)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return { colors, fonts, description: desc.slice(0, 300) };
}

// Install a theme into the project: frame.md (the design spec HyperFrames reads first) + theme.json for agents.
export function applyTheme(ws, theme) {
  let tokens;
  let frame;
  if (theme.preset) {
    const file = path.join(PRESETS_DIR(), theme.preset, 'FRAME.md');
    if (!fs.existsSync(file)) throw new Error(`Unknown theme preset "${theme.preset}"`);
    frame = fs.readFileSync(file, 'utf8');
    tokens = themeTokens(frame);
    // Extra colours/fonts the plan adds on top of the preset.
    tokens.colors = { ...tokens.colors, ...(theme.colors ?? {}) };
    tokens.fonts = [...new Set([...tokens.fonts, ...(theme.fonts ?? [])])];
    if (theme.colors && Object.keys(theme.colors).length) {
      frame += `\n\n## Project additions\n\n${Object.entries(theme.colors).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n`;
    }
  } else {
    tokens = { colors: theme.colors ?? {}, fonts: theme.fonts ?? [], description: theme.description ?? '' };
    frame = [
      '---',
      `name: ${theme.name ?? 'custom'}`,
      'colors:',
      ...Object.entries(tokens.colors).map(([k, v]) => `  ${k}: "${v}"`),
      'typography:',
      ...tokens.fonts.map((f, i) => `  ${i === 0 ? 'display' : `face-${i}`}: { fontFamily: "${f}" }`),
      '---',
      '',
      `# ${theme.name ?? 'Custom theme'}`,
      '',
      theme.description ?? '',
      '',
      ...(theme.rules ?? []).map((r) => `- ${r}`),
      '',
    ].join('\n');
  }
  fs.writeFileSync(path.join(ws.projectDir, 'frame.md'), frame);
  const out = { preset: theme.preset ?? null, ...tokens, roles: theme.roles ?? {} };
  fs.writeFileSync(path.join(ws.projectDir, 'theme.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

export function makeRegistryTools(role) {
  const tools = [
    {
      name: 'registry_search',
      description: 'Search the HyperFrames registry (blocks = whole scenes with their own timeline; components = snippets merged into a scene). Query in English with what the beat should DO.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          type: { type: 'string', enum: ['block', 'component'] },
          tag: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 25 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        ctx.emit('registry_search', { query: args.query, type: args.type ?? null });
        const r = await catalogSearch(ctx.ws, args);
        // The planner judges candidates by how they look, not by their names: attach the top posters.
        const shown = role === 'planner' ? r.items.filter((i) => i.poster).slice(0, 6) : [];
        if (!shown.length) return r.text;
        return {
          text: `${r.text}\n\nPreview posters follow, in this order: ${shown.map((i, n) => `${n + 1}. ${i.name}`).join(', ')}. Pick by what they show; a block whose look fights the theme or the subject is the wrong block even when its name fits.`,
          images: shown.map((i) => i.poster),
        };
      },
    },
    {
      name: 'block_doc',
      description: 'Read an installed block or component\'s own SKILL.md (its variables, timing, how to mount it). Omit section for its outline.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, section: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const doc = findBlockDoc(ctx.ws, args.name);
        const sections = doc
          ? splitSections(fs.readFileSync(doc, 'utf8').replace(/^---[\s\S]*?---\r?\n/, ''))
          : docFromHtml(ctx.ws, args.name);
        if (!sections) return `${args.name} is not installed in this project. Install it with registry_add first.`;
        if (!args.section) return sections.map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.title} {section: "${s.id}", ${s.chars} chars}`).join('\n');
        const i = sections.findIndex((s) => s.id === args.section);
        if (i < 0) return `No section "${args.section}".`;
        (ctx.blockDocsRead ??= new Set()).add(args.name);
        ctx.emit('block_doc_read', { role: ctx.role, name: args.name, section: args.section });
        const parts = [sections[i]];
        for (let j = i + 1; j < sections.length && sections[j].level > sections[i].level; j++) parts.push(sections[j]);
        return clip(parts.map((s) => s.text).join('\n\n'), config.skillReadChars);
      },
    },
  ];
  if (role === 'planner') {
    tools.push({
      name: 'registry_inspect',
      description: 'Before choosing a registry item, see what it exposes: its text, image and colour variables. An item with no text variables has its copy hard-coded; one with image variables shows demo photos unless you supply files.',
      parameters: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 } },
        required: ['names'],
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        const out = [];
        for (const n of args.names) out.push(describeInspect(await inspectItem(ctx.ws, n)));
        ctx.emit('registry_inspect', { names: args.names });
        return out.join('\n');
      },
    });
    tools.push({
      name: 'list_themes',
      description: 'List the theme presets (frame presets) with their palette and fonts. Read one preset\'s FRAME.md with read_skill (skill "hyperframes", file "assets/frame-presets/<name>/FRAME.md") only if you need its rules.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: () => listThemes().map((t) => `- ${t.name}: fonts ${t.fonts.join(' + ') || '?'}; colours ${Object.entries(t.colors).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}\n    ${t.description.slice(0, 200)}`).join('\n'),
    });
  }
  if (role === 'builder' || role === 'fixer') {
    tools.push({
      name: 'registry_add',
      description: 'Install a registry item into the project. Prints the files written, the mount snippet and the item\'s variables. Then read its block_doc.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, vars: { type: 'object', description: 'Optional variable values for this mount' } },
        required: ['name'],
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        ctx.emit('registry_add', { name: args.name });
        const r = await registryAdd(ctx.ws, args.name, args.vars);
        ctx.ws.chownAgentDirs();
        return r.ok ? `${r.text}\nVariables: ${r.variables.map((v) => `${v.id}:${v.type}=${JSON.stringify(v.default)}`).join(', ') || 'none'}` : r.text;
      },
    });
  }
  return tools;
}

// Hex colours in the root and the hand-built scenes must come from the theme (black and white always allowed).
export function offThemeColours(ws, theme, plan) {
  const allowed = new Set([...Object.values(theme.colors ?? {}), '#000000', '#FFFFFF'].map((c) => String(c).toUpperCase()));
  const files = ['index.html', ...plan.scenes.filter((s) => !s.block).map((s) => `compositions/${s.id}.html`)];
  const bad = [];
  for (const f of files) {
    const abs = path.join(ws.projectDir, f);
    if (!fs.existsSync(abs)) continue;
    const found = [...new Set(fs.readFileSync(abs, 'utf8').match(/#[0-9a-fA-F]{6}\b/g) ?? [])].filter((c) => !allowed.has(c.toUpperCase()));
    if (found.length) bad.push(`${f}: ${found.join(', ')}`);
  }
  return bad;
}

export function findBlockHtml(ws, name) {
  const safe = String(name).replace(/[^a-z0-9-]/gi, '');
  for (const p of [`compositions/${safe}/${safe}.html`, `compositions/${safe}.html`, `compositions/components/${safe}.html`, `compositions/components/${safe}/${safe}.html`]) {
    const abs = path.join(ws.projectDir, p);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// Items that ship no SKILL.md still declare their variables in the HTML; present those as the item's docs.
function docFromHtml(ws, name) {
  const html = findBlockHtml(ws, name);
  if (!html) return null;
  const src = fs.readFileSync(html, 'utf8');
  const file = path.relative(ws.projectDir, html).split(path.sep).join('/');
  const id = /data-composition-id="([^"]+)"/.exec(src)?.[1] ?? name;
  const duration = /data-duration="([^"]+)"/.exec(src)?.[1] ?? '?';
  let vars = [];
  try {
    vars = JSON.parse(/data-composition-variables='([^']*)'/.exec(src)?.[1] ?? '[]');
  } catch {
    /* no variables */
  }
  const lines = vars.map((v) => `- ${v.id} (${v.type}${v.role ? `, ${v.role}` : ''}): ${v.label ?? ''}${v.description ? ` — ${v.description}` : ''} [default ${JSON.stringify(v.default).slice(0, 80)}]`);
  const placeholders = vars.filter((v) => v.type === 'image' || v.role === 'content').map((v) => v.id);
  const make = (sid, title, text) => ({ id: sid, title, level: 2, text: `## ${title}\n${text}`, chars: text.length });
  return [
    make('overview', 'Overview', `File: ${file}\nComposition id: ${id}\nOwn duration: ${duration}s\nNo SKILL.md ships with this item; this is generated from its HTML.`),
    make('variables', 'Variables', `${lines.join('\n') || 'none'}${placeholders.length ? `\n\nContent variables (${placeholders.join(', ')}) default to demo material: set every one the scene shows, or the film shows the demo.` : ''}`),
  ];
}

export function findBlockDoc(ws, name) {
  const safe = String(name).replace(/[^a-z0-9-]/gi, '');
  for (const p of [`compositions/${safe}/SKILL.md`, `compositions/components/${safe}/SKILL.md`, `compositions/components/${safe}.md`]) {
    const abs = path.join(ws.projectDir, p);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}
