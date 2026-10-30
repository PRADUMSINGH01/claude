// Fonts the theme names → something that actually renders.
// Bundled families resolve by name (hyperframes references/format.md#fonts). Any other family needs a
// real file in the project and an @font-face, so we fetch it from Google Fonts in code; if that fails we
// fall back to a bundled family and say so. Never a fake file.
import fs from 'node:fs';
import path from 'node:path';

export const BUNDLED = ['Inter', 'Montserrat', 'Outfit', 'Nunito', 'Oswald', 'League Gothic', 'Archivo Black', 'Space Mono', 'IBM Plex Mono',
  'JetBrains Mono', 'EB Garamond', 'Playfair Display', 'Source Code Pro', 'Noto Sans JP', 'Roboto', 'Open Sans', 'Lato', 'Poppins'];
// The compiler swaps these for the nearest bundled family, so they need nothing either.
const SYSTEM = ['Helvetica', 'Helvetica Neue', 'Arial', 'Times', 'Times New Roman', 'Georgia', 'Menlo', 'Courier', 'Courier New', 'system-ui', 'sans-serif', 'serif', 'monospace'];

const WEIGHT_WORDS = { thin: 100, extralight: 200, light: 300, regular: 400, book: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900, heavy: 900 };

// "Montserrat Bold" → { family: "Montserrat", weight: 700 }
export function cleanFamily(name) {
  const parts = String(name).trim().split(/\s+/);
  const last = parts.at(-1)?.toLowerCase().replace(/[^a-z]/g, '');
  if (parts.length > 1 && WEIGHT_WORDS[last]) return { family: parts.slice(0, -1).join(' '), weight: WEIGHT_WORDS[last] };
  return { family: parts.join(' '), weight: null };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function googleFontFaces(family, weights) {
  const q = `${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights.join(';')}`;
  for (const url of [`https://fonts.googleapis.com/css2?family=${q}&display=swap`, `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}&display=swap`]) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const css = await res.text();
      // Keep the latin subset of each weight.
      const blocks = [...css.matchAll(/\/\*\s*latin\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
      const faces = blocks.map((b) => ({
        weight: Number(/font-weight:\s*(\d+)/.exec(b)?.[1] ?? 400),
        style: /font-style:\s*(\w+)/.exec(b)?.[1] ?? 'normal',
        url: /url\((https:[^)]+\.woff2)\)/.exec(b)?.[1],
      })).filter((f) => f.url && f.style === 'normal');
      if (faces.length) return faces;
    } catch {
      /* next url */
    }
  }
  return [];
}

export async function prepareFonts(ws, names) {
  const css = [];
  const report = [];
  const map = {};
  for (const name of [...new Set(names.filter(Boolean))]) {
    const { family, weight } = cleanFamily(name);
    map[name] = family;
    if (BUNDLED.some((b) => b.toLowerCase() === family.toLowerCase())) { report.push({ family, how: 'bundled' }); continue; }
    if (SYSTEM.some((b) => b.toLowerCase() === family.toLowerCase())) { report.push({ family, how: 'system (compiler swaps to nearest bundled)' }); continue; }
    const faces = await googleFontFaces(family, [...new Set([400, 700, weight].filter(Boolean))].sort());
    if (!faces.length) {
      map[name] = 'Inter';
      report.push({ family, how: 'NOT FOUND: using Inter instead' });
      continue;
    }
    const dir = path.join(ws.projectDir, 'assets', 'fonts');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of faces) {
      const file = `${family.replace(/[^a-z0-9]+/gi, '-')}-${f.weight}.woff2`;
      const res = await fetch(f.url, { signal: AbortSignal.timeout(20_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || buf.subarray(0, 4).toString('latin1') !== 'wOF2') continue; // only real woff2
      fs.writeFileSync(path.join(dir, file), buf);
      css.push(`@font-face { font-family: "${family}"; src: url("assets/fonts/${file}") format("woff2"); font-weight: ${f.weight}; font-style: normal; font-display: block; }`);
    }
    report.push({ family, how: `downloaded from Google Fonts (${faces.map((f) => f.weight).join(', ')})` });
  }
  return { css: css.join('\n'), report, map };
}
