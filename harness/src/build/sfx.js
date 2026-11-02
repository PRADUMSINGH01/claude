// Sound effects from the library bundled with the media-use skill (21 Pixabay sounds: commercial use, no
// credit required). The plan names a few cues per scene ({name, at}: the moment in the scene the sound should
// hit); code places each so its loudest moment lands there, keeps it inside the film, spaces cues apart and
// caps how many play. A plan with no cues gets a plain default: a whoosh on each cut, a hit on the end card.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const SFX_DIR = () => path.join(config.skillsDir, 'media-use', 'audio', 'assets', 'sfx');

// Measured from the files, not taken from their descriptions: [loudest moment, audible end] in seconds. The
// riser's description says it builds for 10 s, but it peaks at 3.0 s and is silent after 4.2 s; timed by the
// description it would crest seven seconds before the reveal. A selftest re-measures these.
export const SHAPE = {
  chime: [0.49, 2.21], click: [0.07, 0.2], 'click-soft': [0.07, 0.2], error: [0.76, 0.94],
  'glitch-1': [0.81, 2.61], 'glitch-2': [1.19, 3.5], 'glitch-3': [0.67, 1.97],
  'impact-bass-1': [0.1, 2.11], 'impact-bass-2': [1.83, 2.59], 'key-press': [0.1, 0.13],
  notification: [0.26, 1.15], ping: [0.34, 0.77], pop: [0.14, 0.23], riser: [3.02, 4.22],
  sparkle: [0.04, 1.23], typing: [0.47, 1.44], whoosh: [0.17, 0.36],
  'whoosh-cinematic': [2.9, 4.37], 'whoosh-short': [0.17, 0.36],
};

// Effects sit under everything else (the skill's ~0.35); hits a little louder, keys and clicks a little softer.
const VOLUME = { 'impact-bass-1': 0.5, 'impact-bass-2': 0.5, riser: 0.4, 'whoosh-cinematic': 0.4, typing: 0.28, 'key-press': 0.28, click: 0.3, 'click-soft': 0.3 };
const BUILD_UPS = new Set(['riser', 'whoosh-cinematic', 'impact-bass-2']); // need room before the hit
// Sounds of different families layer on one moment (a whoosh into an impact is the classic trailer hit); two
// of the same family that close together are one sound twice, and three on a moment are noise.
const FAMILY = (name) => name.replace(/-(\d|short|cinematic|soft|bass)+$/, '').replace(/^(click|pop|key-press|ping)$/, 'ui');
const MIN_GAP = 0.25; // seconds that count as the same moment
const PER_MOMENT = 2;

export function sfxLibrary() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SFX_DIR(), 'manifest.json'), 'utf8'));
    return Object.entries(manifest)
      .filter(([name]) => SHAPE[name])
      .map(([name, m]) => ({ name, file: m.file, duration: m.duration, description: m.description }));
  } catch {
    return [];
  }
}

/** The library as the planner reads it: name, when to use it. */
export function sfxMenu(library = sfxLibrary()) {
  return library.map((s) => `${s.name}: ${String(s.description).split(/ — |\. /)[1] ?? s.description}`.slice(0, 110)).join('\n');
}

const slug = (s) => String(s ?? '').toLowerCase().trim().replace(/\.mp3$/, '').replace(/[\s_]+/g, '-');

// Without cues from the plan: a whoosh on every cut between main scenes, a bass hit as the last scene lands.
function defaultCues(plan) {
  const main = (plan.scenes ?? []).filter((s) => (s.layer ?? 'main') === 'main').sort((a, b) => a.start - b.start);
  const cues = main.slice(1).map((s) => ({ name: 'whoosh', t: s.start }));
  if (main.length > 1) cues.push({ name: 'impact-bass-1', t: main.at(-1).start + 0.3, end: true });
  return cues;
}

/**
 * Where each sound plays: [{ id, name, file, start, duration, volume, fadeOut }], absolute seconds. Cues come
 * from each scene's `sound` ([{name, at}]); unknown names, cues that can't build up before their hit, hits
 * too close together and anything past the cap are dropped.
 */
export function placeSfx(plan, library = sfxLibrary()) {
  const total = plan.format?.duration ?? 0;
  const known = new Map(library.map((s) => [s.name, s]));
  let cues = [];
  const lastMain = (plan.scenes ?? []).filter((s) => (s.layer ?? 'main') === 'main').sort((a, b) => b.start - a.start)[0];
  for (const s of plan.scenes ?? []) {
    for (const c of Array.isArray(s.sound) ? s.sound : []) {
      const at = Math.min(Math.max(Number(c?.at) || 0, 0), s.duration ?? 0);
      cues.push({ name: slug(c?.name), t: (s.start ?? 0) + at, end: s === lastMain });
    }
  }
  if (!cues.length) cues = defaultCues(plan);

  // The cap counts moments, not sounds: a layered hit is one moment, and a cap on sounds in time order would
  // cut the end card's logo hit first (a real plan lost it that way).
  const maxMoments = Math.max(2, Math.ceil(total / 1.2));
  let moments = 0;
  const placed = [];
  for (const c of cues.filter((x) => known.has(x.name)).sort((a, b) => Number(Boolean(b.end)) - Number(Boolean(a.end)) || a.t - b.t)) {
    const [peak, audible] = SHAPE[c.name];
    let start = c.t - peak;
    if (start < 0) {
      if (BUILD_UPS.has(c.name)) continue; // no room to build up before its hit
      start = 0;
    }
    const together = placed.filter((p) => Math.abs(p.hit - c.t) < MIN_GAP);
    if (together.length >= PER_MOMENT || together.some((p) => FAMILY(p.name) === FAMILY(c.name))) continue;
    if (!together.length && moments >= maxMoments) continue;
    if (BUILD_UPS.has(c.name) && placed.some((p) => BUILD_UPS.has(p.name) && start < p.start + p.duration)) continue; // one build-up at a time
    const duration = +Math.min(audible, total - start).toFixed(2);
    if (duration < 0.1) continue;
    if (!together.length) moments += 1;
    placed.push({ name: c.name, hit: c.t, start: +start.toFixed(2), duration, fadeOut: duration < audible - 0.05 ? 0.2 : 0 });
  }
  return placed.sort((a, b) => a.start - b.start).map((p, i) => ({
    id: `sfx-${i + 1}`,
    name: p.name,
    file: `assets/sfx/${known.get(p.name).file}`,
    start: p.start,
    duration: p.duration,
    volume: VOLUME[p.name] ?? 0.35,
    fadeOut: p.fadeOut,
  }));
}

/** Copy the sounds a film uses into its project, with the library's licence note. */
export function copySfx(projectDir, cues) {
  if (!cues.length) return;
  const dir = path.join(projectDir, 'assets', 'sfx');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of new Set(cues.map((c) => path.basename(c.file)))) fs.copyFileSync(path.join(SFX_DIR(), file), path.join(dir, file));
  const credits = path.join(SFX_DIR(), 'CREDITS.md');
  if (fs.existsSync(credits)) fs.copyFileSync(credits, path.join(dir, 'CREDITS.md'));
}

/** The <audio> clips for index.html: each its own lane, under the picture's tracks. */
export function sfxMarkup(cues) {
  return cues
    .map(
      (c, i) =>
        `    <audio id="${c.id}" class="clip" src="${c.file}" data-start="${c.start}" data-duration="${c.duration}" data-track-index="${20 + i}" data-volume="${c.volume}"${c.fadeOut ? ` data-fade-out="${c.fadeOut}"` : ''}></audio>`
    )
    .join('\n');
}
