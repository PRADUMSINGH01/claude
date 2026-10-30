// Step 1 of the build: everything structural, in code, from the approved plan. No model calls.
//   project · theme tokens + fonts · install blocks/components · decide how each scene is made ·
//   index.html (hosts, timing, layers, z-order, variable values, transparent grounds).
import fs from 'node:fs';
import path from 'node:path';
import { initProject } from '../orchestrator.js';
import { hf } from '../hf.js';
import { applyTheme, registryAdd } from '../tools/registry-tools.js';
import { prepareFonts } from './fonts.js';
import { themeRoles, tokenCss } from './tokens.js';
import { fallbackScene } from './scene-files.js';

const TRACK = { background: 0, main: 1, overlay: 2, transition: 3 };
const Z = { background: 0, main: 10, overlay: 20, transition: 30 };
const GROUND_VAR = /^(background|bg|ground|backdrop|backgroundcolor|bgcolor|base)$/i;

// Where an overlay sits; main scenes and backgrounds fill the frame.
const BOX = {
  top: 'left:0;right:0;top:0;height:30%;',
  bottom: 'left:0;right:0;bottom:0;height:22%;',
  corner: 'right:3%;bottom:3%;width:32%;height:16%;',
  full: 'inset:0;',
};

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');

// Lengthen an item from `from` to `to` seconds: its root and every element timed to run to its old
// end (a .clip with start + duration = from). Clips that end earlier keep their timing. Without the
// inner clips a mounted item disappears at its authored length even though its host runs on.
export function extendItem(src, from, to) {
  let out = src.replace(/(data-composition-duration=")([\d.]+)(")/, (m, a, v, b) => (Math.abs(Number(v) - from) < 0.011 ? `${a}${to}${b}` : m));
  out = out.replace(/<[a-z][^>]*\bdata-duration="([\d.]+)"[^>]*>/gi, (tag, dur) => {
    const start = Number(/\bdata-start="([\d.]+)"/.exec(tag)?.[1] ?? 0);
    if (Math.abs(start + Number(dur) - from) > 0.011) return tag;
    return tag.replace(/\bdata-duration="[\d.]+"/, `data-duration="${+(to - start).toFixed(3)}"`);
  });
  return out;
}

function readItem(ws, name, add) {
  const rel = add.written.find((p) => p.endsWith('.html') && !p.endsWith('SKILL.md'));
  const src = rel ? fs.readFileSync(path.join(ws.projectDir, rel), 'utf8') : '';
  let vars = [];
  try {
    vars = JSON.parse(/data-composition-variables='([^']*)'/.exec(src)?.[1] ?? '[]');
  } catch {
    /* none */
  }
  const compositionId = /data-composition-id="([^"]+)"/.exec(add.snippet ?? '')?.[1] ?? /data-composition-id="([^"]+)"/.exec(src)?.[1] ?? name;
  return {
    name,
    kind: add.kind, // block | component
    file: rel,
    compositionId,
    // A component that ships its own <template> and registers a timeline mounts like a block.
    mountable: add.kind === 'block' || (/<template[\s>]/.test(src) && src.includes(`__timelines["${compositionId}"]`)),
    ownDuration: Number(/data-duration="([\d.]+)"/.exec(src)?.[1] ?? /data-composition-duration="([\d.]+)"/.exec(src)?.[1] ?? 0) || null,
    vars,
    source: src,
  };
}

// Keep only values a variable accepts; report the rest instead of passing them through.
function cleanVars(item, values, warnings, sceneId) {
  const out = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    const def = item.vars.find((d) => d.id === k);
    if (!def) { warnings.push(`${sceneId}: dropped unknown variable ${k} for ${item.name}`); continue; }
    const options = (def.options ?? []).map((o) => (typeof o === 'object' ? o.value : o));
    if (options.length && !options.includes(v)) { warnings.push(`${sceneId}: ${item.name}.${k}="${v}" is not one of ${options.join('|')}; using its default`); continue; }
    out[k] = v;
  }
  return out;
}

// A clean project for this build. A rebuild refreshes the folder in place and keeps renders/: deleting
// the whole folder fails on Windows while a previous video is open in a player.
async function freshProject(ws) {
  if (!fs.existsSync(ws.projectDir) || !fs.readdirSync(ws.projectDir).length) {
    await initProject(ws);
    return;
  }
  const scaffold = path.join(ws.homeDir, 'scaffold');
  fs.rmSync(scaffold, { recursive: true, force: true });
  await hf(ws, ['init', 'scaffold'], { cwd: ws.homeDir, timeoutSec: 300 });
  if (!fs.existsSync(path.join(scaffold, 'index.html'))) throw new Error('hyperframes init failed while refreshing the project');
  for (const entry of fs.readdirSync(ws.projectDir)) {
    if (entry === 'renders') continue;
    fs.rmSync(path.join(ws.projectDir, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(scaffold)) {
    if (['AGENTS.md', 'CLAUDE.md'].includes(entry)) continue;
    fs.cpSync(path.join(scaffold, entry), path.join(ws.projectDir, entry), { recursive: true });
  }
  fs.rmSync(scaffold, { recursive: true, force: true });
}

export async function assemble(ws, plan, brief, { emit = () => {} } = {}) {
  const warnings = [];

  // Project + theme
  await freshProject(ws);
  const themeJson = applyTheme(ws, plan.theme);
  const roles = themeRoles({ ...themeJson, roles: plan.theme.roles });
  const fonts = await prepareFonts(ws, [roles.display, roles.body]);
  roles.display = fonts.map[roles.display] ?? roles.display;
  roles.body = fonts.map[roles.body] ?? roles.body;
  for (const f of fonts.report) if (/NOT FOUND/.test(f.how)) warnings.push(`font ${f.family}: ${f.how}`);
  emit('assemble', { step: 'theme', roles, fonts: fonts.report });

  // Install every registry item once.
  const items = {};
  const names = [...new Set(plan.scenes.flatMap((s) => [s.block, ...(s.components ?? [])]).filter(Boolean))];
  for (const name of names) {
    const add = await registryAdd(ws, name);
    if (!add.ok) { warnings.push(`install ${name} failed: ${add.text.slice(0, 200)}`); continue; }
    items[name] = readItem(ws, name, add);
    emit('assemble', { step: 'install', name, kind: items[name].kind, mountable: items[name].mountable });
  }

  // How each scene is made.
  const hasBackground = plan.scenes.some((s) => s.layer === 'background');
  const overlayPos = Object.fromEntries((brief?.overlays ?? []).map((o) => [o.id, o.position]));
  const norm = (x) => String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const textIdsOf = (item) => item.vars.filter((v) => v.type === 'string' && (v.role ?? 'content') === 'content').map((v) => v.id);
  const scenes = [];
  for (const s of plan.scenes) {
    const layer = s.layer ?? 'main';
    const comps = (s.components ?? []).map((n) => items[n]).filter(Boolean);
    const copy = (s.text ?? []).filter((x) => String(x).trim());
    if (s.block && !items[s.block]) warnings.push(`${s.id}: block ${s.block} is not installed; the scene will be written instead`);
    let mode = 'write';
    let item = s.block && items[s.block] ? items[s.block] : !s.block && comps.length === 1 && comps[0].mountable ? comps[0] : null;
    let values = {};
    let leftover = [];

    if (item) {
      values = cleanVars(item, s.vars, warnings, s.id);
      // The item must carry the scene's copy through its text variables, or it shows its own demo text.
      const textIds = textIdsOf(item);
      const carried = new Set(textIds.map((id) => values[id]).filter((v) => v != null && String(v).trim()).map(norm));
      leftover = copy.filter((c) => !carried.has(norm(c)));
      for (const id of textIds) {
        if (values[id] != null) continue;
        values[id] = leftover.length ? leftover.shift() : '';
        if (values[id] === '') warnings.push(`${s.id}: ${item.name}.${id} not set by the plan; emptied so its demo text does not show`);
      }
      if (item.kind === 'block') {
        mode = 'block'; // copy the block can't carry goes to a companion scene below
      } else if (!leftover.length && (textIds.length || !copy.length)) {
        mode = 'mount';
      } else {
        warnings.push(`${s.id}: ${item.name} cannot carry "${copy.join(' / ')}" through its variables; the scene is written instead`);
        item = null;
        values = {};
        leftover = [];
      }
    }
    if (item) {
      // Over a background layer, a main item's own ground must not cover it.
      if (hasBackground && layer === 'main') {
        for (const d of item.vars) if (GROUND_VAR.test(d.id) && values[d.id] == null) values[d.id] = 'transparent';
      }
      // A host may not run longer than the item's own timeline: extend it, and say so.
      if (item.ownDuration && s.duration > item.ownDuration + 0.01) {
        const abs = path.join(ws.projectDir, item.file);
        fs.writeFileSync(abs, extendItem(fs.readFileSync(abs, 'utf8'), item.ownDuration, s.duration));
        warnings.push(`${s.id}: ${item.name} runs ${item.ownDuration}s on its own; extended to ${s.duration}s (it holds or loops past its authored end)`);
        item.ownDuration = s.duration;
      }
    }
    const file = mode === 'write' ? `compositions/${s.id}.html` : item.file;
    const compositionId = mode === 'write' ? s.id : item.compositionId;
    scenes.push({ ...s, layer, mode, item: item?.name ?? null, file, compositionId, values, position: overlayPos[s.id] ?? null });

    // Copy a mounted block can't carry is never dropped: a written companion scene shows it on top,
    // same time and layer, with the plan's components.
    if (mode === 'block' && leftover.length) {
      const id = `${s.id}-text`;
      warnings.push(`${s.id}: ${item.name} carries only part of the copy; "${leftover.join(' / ')}" goes in a companion scene ${id}`);
      scenes.push({
        ...s, id, text: leftover, block: null, vars: {}, layer, mode: 'write', item: null, values: {},
        file: `compositions/${id}.html`, compositionId: id, position: overlayPos[s.id] ?? null, companionOf: s.id, zBoost: 1,
        build: `${s.build ?? ''}\nThis scene shows ONLY "${leftover.join('" and "')}", layered over the ${item.name} block that already shows "${[...new Set(Object.values(values).filter((v) => typeof v === 'string' && v.trim()))].join(' / ')}". Place it so they don't overlap (e.g. below it). Transparent background.`,
      });
    }
  }

  // Scenes the model will write start as a working fallback, so the film is valid at every step.
  for (const s of scenes.filter((x) => x.mode === 'write')) {
    fs.mkdirSync(path.join(ws.projectDir, 'compositions'), { recursive: true });
    fs.writeFileSync(path.join(ws.projectDir, s.file), fallbackScene(s, plan.format, roles));
  }

  fs.writeFileSync(path.join(ws.projectDir, 'index.html'), indexHtml(plan, scenes, roles, fonts.css, themeJson.colors));
  ws.chownAgentDirs();
  emit('assemble', { step: 'index', scenes: scenes.map((s) => ({ id: s.id, mode: s.mode, item: s.item })) });
  return { roles, fonts: fonts.report, items, scenes, warnings };
}

function host(s, format) {
  const box = s.layer === 'overlay' ? BOX[s.position] ?? BOX.bottom : BOX.full;
  const sized = s.mode !== 'mount'; // a mounted component fills its host box and declares no size
  return [
    '    <div',
    `      id="${s.id}"`,
    `      data-composition-id="${s.compositionId}"`,
    `      data-composition-src="${s.file}"`,
    `      data-start="${s.start}"`,
    `      data-duration="${s.duration}"`,
    `      data-track-index="${TRACK[s.layer] ?? 1}"`,
    sized ? `      data-width="${format.width}"\n      data-height="${format.height}"` : null,
    Object.keys(s.values).length ? `      data-variable-values='${attr(JSON.stringify(s.values))}'` : null,
    `      style="position:absolute;${box}z-index:${(Z[s.layer] ?? 10) + (s.zBoost ?? 0)};"`,
    '    ></div>',
  ].filter(Boolean).join('\n');
}

export function indexHtml(plan, scenes, roles, fontCss, colors) {
  const { width, height, duration } = plan.format;
  const order = [...scenes].sort((a, b) => (Z[a.layer] ?? 10) - (Z[b.layer] ?? 10) || a.start - b.start);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
${fontCss ? `${fontCss.split('\n').map((l) => `      ${l}`).join('\n')}\n` : ''}${tokenCss(roles, colors).split('\n').map((l) => `      ${l}`).join('\n')}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: var(--bg); }
      #root { position: relative; width: 100%; height: 100%; font-family: var(--font-display); color: var(--fg); }
    </style>
  </head>
  <body>
    <!-- Assembled by the harness from plan.json: one host per scene. Layers: background 0, main 1, overlay 2. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${order.map((s) => host(s, plan.format)).join('\n')}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
}
