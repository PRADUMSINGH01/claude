// Free stock photos and footage for scenes that need real imagery: Pexels first, Pixabay as a fallback.
// Code only: the keys stay in the harness process (never in the agents' sandbox). Every file is
// downloaded into the project (renders never fetch; Pixabay forbids hotlinking), cached across jobs, and
// credited in CREDITS.md (both APIs ask apps to show where results come from).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const PEXELS = () => process.env.PEXELS_API_BASE || 'https://api.pexels.com';
const PIXABAY = () => process.env.PIXABAY_API_BASE || 'https://pixabay.com/api';
const MAX_BYTES = 80 * 1024 * 1024;

export const stockEnabled = () => Boolean(process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY);

const orientationOf = ({ width, height }) => (width > height * 1.1 ? 'landscape' : height > width * 1.1 ? 'portrait' : 'square');

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

// The smallest file that still looks sharp as a backdrop under a scrim (two-thirds of the frame's long side,
// e.g. 1280 px for 1920): stock videos are 10-100 MB at full size, and download time is the media step's cost.
export function pickFile(files, format) {
  const need = Math.max(format.width, format.height) * 0.66;
  const ok = files.filter((f) => f.link && Math.max(f.width ?? 0, f.height ?? 0) >= need && /mp4|jpe?g|png|webp/i.test(f.type ?? f.link));
  return ok.sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

// Candidates in the film's orientation, each with the one file to download and its credit.
async function searchPexels({ kind, query, format, minSeconds }) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return [];
  const q = new URLSearchParams({ query, orientation: orientationOf(format), per_page: '15' });
  const headers = { Authorization: key };
  if (kind === 'video') {
    const j = await getJson(`${PEXELS()}/v1/videos/search?${q}`, headers);
    return (j.videos ?? []).filter((v) => v.duration >= minSeconds).map((v) => ({
      source: 'pexels', id: v.id, kind, duration: v.duration, page: v.url,
      credit: { name: v.user?.name ?? 'Pexels', url: v.user?.url ?? v.url },
      file: pickFile((v.video_files ?? []).map((f) => ({ link: f.link, width: f.width, height: f.height, type: f.file_type })), format),
    })).filter((c) => c.file);
  }
  const j = await getJson(`${PEXELS()}/v1/search?${q}&size=large`, headers);
  return (j.photos ?? []).map((p) => ({
    source: 'pexels', id: p.id, kind, page: p.url,
    credit: { name: p.photographer ?? 'Pexels', url: p.photographer_url ?? p.url },
    // large2x is ~1880 px on its long side; original can be 6000+ px, too heavy for a frame.
    file: pickFile([{ link: p.src?.large2x, width: 1880, height: Math.round((1880 * p.height) / p.width), type: 'jpeg' }, { link: p.src?.original, width: p.width, height: p.height, type: 'jpeg' }], format),
  })).filter((c) => c.file);
}

async function searchPixabay({ kind, query, format, minSeconds }) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return [];
  const orientation = { landscape: 'horizontal', portrait: 'vertical' }[orientationOf(format)] ?? 'all';
  const q = new URLSearchParams({ key, q: query.slice(0, 100), per_page: '20', safesearch: 'true' });
  if (kind === 'video') {
    const j = await getJson(`${PIXABAY()}/videos/?${q}`);
    return (j.hits ?? []).filter((v) => v.duration >= minSeconds).map((v) => ({
      source: 'pixabay', id: v.id, kind, duration: v.duration, page: v.pageURL,
      credit: { name: v.user ?? 'Pixabay', url: v.pageURL },
      file: pickFile(Object.values(v.videos ?? {}).map((f) => ({ link: f.url, width: f.width, height: f.height, type: 'mp4' })), format),
    })).filter((c) => c.file);
  }
  q.set('image_type', 'photo');
  q.set('orientation', orientation);
  const j = await getJson(`${PIXABAY()}/?${q}`);
  return (j.hits ?? []).map((p) => ({
    source: 'pixabay', id: p.id, kind, page: p.pageURL,
    credit: { name: p.user ?? 'Pixabay', url: p.pageURL },
    file: pickFile([{ link: p.largeImageURL, width: p.imageWidth, height: p.imageHeight, type: 'jpeg' }], format),
  })).filter((c) => c.file);
}

// Downloads once per file into a cache shared by jobs, then copies it into the project's assets/media/.
async function fetchFile(c, destDir, name) {
  const ext = c.kind === 'video' ? 'mp4' : (/\.png(\?|$)/i.test(c.file.link) ? 'png' : 'jpg');
  const cacheDir = path.join(config.jobsDir, '.cache', 'stock');
  const cached = path.join(cacheDir, `${c.source}-${c.id}-${c.file.width}.${ext}`);
  if (!fs.existsSync(cached)) {
    const res = await fetch(c.file.link, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`file is ${(buf.length / 1e6).toFixed(0)} MB`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(`${cached}.part`, buf);
    fs.renameSync(`${cached}.part`, cached);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, `${name}.${ext}`);
  fs.copyFileSync(cached, file);
  return file;
}

// One scene's media: the first candidate (Pexels, then Pixabay) that downloads. Null when nothing fits.
export async function getStock({ kind = 'video', query, format, minSeconds = 0, projectDir, name }) {
  const errors = [];
  for (const search of [searchPexels, searchPixabay]) {
    let candidates = [];
    try {
      candidates = await search({ kind, query, format, minSeconds });
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    for (const c of candidates.slice(0, 3)) {
      try {
        const abs = await fetchFile(c, path.join(projectDir, 'assets', 'media'), name);
        return { file: path.relative(projectDir, abs).split(path.sep).join('/'), kind, width: c.file.width, height: c.file.height, duration: c.duration ?? null, source: c.source, page: c.page, credit: c.credit, query };
      } catch (err) {
        errors.push(`${c.source} ${c.id}: ${err.message}`);
      }
    }
  }
  return { error: errors.length ? errors.join('; ') : `no ${kind} found for "${query}"` };
}

export function creditsMarkdown(items) {
  const rows = items.map((m) => `- ${m.scene}: ${m.kind} "${m.query}" by [${m.credit.name}](${m.credit.url}) on [${m.source === 'pexels' ? 'Pexels' : 'Pixabay'}](${m.page})`);
  return `# Credits\n\nPhotos and footage from Pexels and Pixabay, free to use under their licences. Show where they come from wherever this film is offered (both APIs ask for it), and credit the creators where possible.\n\n${rows.join('\n')}\n`;
}
