// Where a film's colours come from when the request doesn't give them: a named palette mood the
// person picked, or a colour reference image (Higgsfield's "Soul Hex": the palette of a film still,
// a brand asset or a screenshot, taken in code and used for every shot). The result is four exact
// colours (ground, ink, accent, accent2) that planning must use; build/palette.js derives the rest.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { quote } from './hf.js';
import { run } from './sandbox.js';
import { buildPalette, contrast, ensureContrast, hexToRgb, oklch } from './build/palette.js';

// Named moods for motion graphics, after the colour-grade vocabulary film tools use (warm nostalgia,
// cold thriller, documentary, noir…). Each is a ground with a hue, never the generated defaults
// (spec.md BANNED: navy void, purple gradients, cream paper); every ink reads at 4.5:1 and every
// accent at 3:1 on its ground (selftest checks).
export const PALETTES = [
  { id: 'film-stock', label: 'Film stock', mood: 'natural, organic, slightly faded film', colors: { ground: '#2F3A33', ink: '#EFE6D6', accent: '#E0913F', accent2: '#8DB3A8' } },
  { id: 'golden-hour', label: 'Golden hour', mood: 'warm nostalgia, low contrast, amber light', colors: { ground: '#3A2416', ink: '#FBE9CF', accent: '#F4A340', accent2: '#E57B5C' } },
  { id: 'teal-orange', label: 'Teal and orange', mood: 'cinematic, cool shadows, warm highlights', colors: { ground: '#0F3B40', ink: '#F3EDE4', accent: '#F28C38', accent2: '#6CC3C1' } },
  { id: 'jewel', label: 'Jewel tones', mood: 'rich, epic, deep emerald and gold', colors: { ground: '#1D3B2A', ink: '#F5EFE0', accent: '#E3B23C', accent2: '#E07A8E' } },
  { id: 'lime-jam', label: 'Lime jam', mood: 'fresh, green, bright and outdoorsy', colors: { ground: '#E6F4C3', ink: '#1E2B14', accent: '#2F7A12', accent2: '#B85C00' } },
  { id: 'candy-pink', label: 'Candy pink', mood: 'warm pinks, peach, playful pop', colors: { ground: '#FFD6E0', ink: '#3B0F1E', accent: '#C2185B', accent2: '#B84A1A' } },
  { id: 'nostalgic-blue', label: 'Nostalgic blue', mood: 'faded blue, quiet, melancholic', colors: { ground: '#C9D6DF', ink: '#1D2B36', accent: '#2F5D80', accent2: '#9C4F36' } },
  { id: 'sage-soft', label: 'Soft sage', mood: 'muted, airy, minimal contrast', colors: { ground: '#E4E9E2', ink: '#2E3430', accent: '#4F6B45', accent2: '#8A5A44' } },
  { id: 'ice-lab', label: 'Ice lab', mood: 'cold, clinical, sci-fi white light', colors: { ground: '#E8F1F5', ink: '#0E1A22', accent: '#00739A', accent2: '#56707D' } },
  { id: 'documentary', label: 'Documentary', mood: 'neutral, natural, one red mark', colors: { ground: '#F4F4F2', ink: '#1A1A1A', accent: '#C8102E', accent2: '#5A5A5A' } },
  { id: 'black-gloss', label: 'Black gloss', mood: 'high contrast, graphic, deep blacks', colors: { ground: '#0E0E0E', ink: '#FFFFFF', accent: '#FF3B30', accent2: '#FFD60A' } },
  { id: 'noir', label: 'Noir', mood: 'black and white, hard light, near-monochrome', colors: { ground: '#151515', ink: '#F2F2F2', accent: '#BDBDBD', accent2: '#8A8A8A' } },
];

export const paletteById = (id) => PALETTES.find((p) => p.id === id) ?? null;

// ---- Colour reference image → palette ---------------------------------------

const MAX_BYTES = 8 * 1024 * 1024;

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

// The image as bytes. Accepts a data: URL, a public https URL (no private hosts, images only, size
// capped), or, for the CLI, a local file path. The API server only passes the first two.
async function loadImage(ref) {
  const data = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(ref);
  if (data) {
    const buf = Buffer.from(data[2], 'base64');
    if (buf.length > MAX_BYTES) throw new Error('colour reference image is over 8 MB');
    return buf;
  }
  if (/^https:\/\//i.test(ref)) {
    const url = new URL(ref);
    const { address } = await dns.lookup(url.hostname);
    if (privateAddress(address)) throw new Error('colour reference URL points at a private address');
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    if (!res.ok || !/^https:/.test(res.url)) throw new Error(`colour reference URL answered ${res.status}`);
    if (!/^image\//.test(res.headers.get('content-type') ?? '')) throw new Error('colour reference URL is not an image');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('colour reference image is over 8 MB');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('colour reference image is over 8 MB');
    return buf;
  }
  if (/^[a-z]+:/i.test(ref)) throw new Error('colour reference must be an https URL, a data: URL or a file');
  return fs.readFileSync(ref);
}

// Deterministic k-means in OKLab over a 48x48 thumbnail: the colours an eye would name, weighted by area.
export function clusterColours(rgb, k = 6) {
  const px = [];
  for (let i = 0; i + 2 < rgb.length; i += 3) px.push([rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255]);
  const hex = (p) => `#${p.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  const lab = px.map((p) => {
    const [L, C, H] = oklch(hex(p));
    return [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  });
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Farthest-point start from the mean: no randomness, same palette every run.
  const mean = [0, 1, 2].map((j) => lab.reduce((n, p) => n + p[j], 0) / lab.length);
  const centres = [lab.reduce((best, p) => (d2(p, mean) < d2(best, mean) ? p : best))];
  while (centres.length < Math.min(k, lab.length)) centres.push(lab.reduce((best, p) => (Math.min(...centres.map((c) => d2(p, c))) > Math.min(...centres.map((c) => d2(best, c))) ? p : best)));
  let assign = [];
  for (let it = 0; it < 12; it++) {
    assign = lab.map((p) => centres.reduce((bi, c, i) => (d2(p, c) < d2(p, centres[bi]) ? i : bi), 0));
    for (let i = 0; i < centres.length; i++) {
      const mine = lab.filter((_, j) => assign[j] === i);
      if (mine.length) centres[i] = [0, 1, 2].map((j) => mine.reduce((n, p) => n + p[j], 0) / mine.length);
    }
  }
  return centres.map((c, i) => {
    const mine = px.filter((_, j) => assign[j] === i);
    const avg = [0, 1, 2].map((j) => mine.reduce((n, p) => n + p[j], 0) / Math.max(1, mine.length));
    return { hex: hex(avg), weight: mine.length / px.length };
  }).filter((c) => c.weight > 0).sort((a, b) => b.weight - a.weight);
}

// Roles from the swatches: the dominant colour is the ground; ink is the swatch that reads best on
// it (lifted to 4.5:1 if none does); the accents are the most colourful swatches, distinct in hue.
export function rolesFromSwatches(swatches) {
  const ground = swatches[0].hex;
  const rest = swatches.slice(1);
  const inkSrc = rest.reduce((best, s) => (contrast(s.hex, ground) > contrast(best, ground) ? s.hex : best), rest[0]?.hex ?? ground);
  const ink = ensureContrast(inkSrc, ground, 4.5);
  const colourful = rest.filter((s) => s.hex !== inkSrc && oklch(s.hex)[1] > 0.05)
    .sort((a, b) => oklch(b.hex)[1] * (0.5 + b.weight) - oklch(a.hex)[1] * (0.5 + a.weight));
  const accent = ensureContrast(colourful[0]?.hex ?? inkSrc, ground, 3);
  const hueGap = (a, b) => {
    const d = Math.abs(oklch(a)[2] - oklch(b)[2]);
    return Math.min(d, 360 - d);
  };
  const second = colourful.slice(1).find((s) => hueGap(s.hex, accent) >= 30);
  return { ground, ink, accent, ...(second ? { accent2: ensureContrast(second.hex, ground, 3) } : {}) };
}

export async function paletteFromImage(ws, ref) {
  const buf = await loadImage(ref);
  // Decode in the job sandbox, never in the server process: the image is untrusted input.
  const dir = ws.homeDir;
  fs.writeFileSync(path.join(dir, 'colorref.img'), buf);
  ws.chownAgentDirs();
  const res = await run(ws, `ffmpeg -v error -i colorref.img -frames:v 1 -vf "scale=48:48:flags=area" -f rawvideo -pix_fmt rgb24 -y ${quote('colorref.rgb')}`, { cwd: dir, timeoutSec: 60 });
  const raw = path.join(dir, 'colorref.rgb');
  if (!fs.existsSync(raw) || fs.statSync(raw).size < 48 * 48 * 3) throw new Error(`could not read the colour reference image: ${res.output.slice(0, 300)}`);
  const swatches = clusterColours(fs.readFileSync(raw));
  return { colors: rolesFromSwatches(swatches), swatches };
}

// ---- What planning gets ------------------------------------------------------

const HEX_ROLES = ['ground', 'ink', 'accent', 'accent2'];
const validColors = (c) => c && typeof c === 'object' && ['ground', 'ink', 'accent'].every((k) => hexToRgb(c[k]));

// options.colors (exact roles, e.g. resolved on an earlier run or picked in the app) win, then a
// colour reference, then a named palette. Returns null when the request's own words decide.
export async function resolveLook(ws, options = {}) {
  let look = null;
  if (validColors(options.colors)) look = { source: options.colorsSource ?? 'app', colors: options.colors };
  else if (options.colorRef) {
    const { colors, swatches } = await paletteFromImage(ws, options.colorRef);
    look = { source: 'colour reference', colors, swatches };
  } else if (options.palette) {
    const p = paletteById(options.palette);
    if (!p) throw new Error(`unknown palette "${options.palette}"; one of ${PALETTES.map((x) => x.id).join(', ')}`);
    look = { source: `palette ${p.id}`, colors: p.colors, mood: p.mood };
  }
  if (!look) return null;
  look.colors = Object.fromEntries(HEX_ROLES.filter((k) => look.colors[k]).map((k) => [k, String(look.colors[k]).toUpperCase()]));
  look.palette = buildPalette({ ...look.colors });
  return look;
}
