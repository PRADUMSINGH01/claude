// The film's colour world, from the few colours a theme gives (hyperframes references/look.md: palette
// roles, a rationed accent, atmosphere at 15–25%; the Higgsfield approach: one palette for every
// shot, taken from the theme). Code, not the model: every colour on screen comes from here.
// Maths in OKLCH so lightening, mixing and hue turns look even to the eye.

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

const toHex = (rgb) => `#${rgb.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch([r, g, b]) {
  [r, g, b] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

function oklchToRgb([L, C, H]) {
  const A = C * Math.cos((H * Math.PI) / 180);
  const B = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(gam);
}

// Out-of-gamut colours lose chroma until they fit, so a hue turn never clips to a different hue.
function fromOklch([L, C, H]) {
  for (let c = C; c >= 0; c -= 0.005) {
    const rgb = oklchToRgb([L, c, H]);
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return toHex(rgb);
  }
  return toHex(oklchToRgb([L, 0, H]));
}

export const oklch = (hex) => rgbToOklch(hexToRgb(hex) ?? [0, 0, 0]);

export function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a) ?? 0, luminance(b) ?? 0].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Mix in OKLab (perceptually even), t = share of b.
export function mix(a, b, t) {
  const [L1, C1, H1] = oklch(a);
  const [L2, C2, H2] = oklch(b);
  const toAB = (C, H) => [C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  const [a1, b1] = toAB(C1, H1);
  const [a2, b2] = toAB(C2, H2);
  const [A, B] = [a1 + (a2 - a1) * t, b1 + (b2 - b1) * t];
  return fromOklch([L1 + (L2 - L1) * t, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]);
}

// Move a colour's lightness away from the ground until it reaches the contrast it needs.
export function ensureContrast(fg, bg, min) {
  if (contrast(fg, bg) >= min) return fg.toUpperCase();
  const [L, C, H] = oklch(fg);
  const up = (luminance(bg) ?? 0) < 0.18;
  for (let i = 1; i <= 100; i++) {
    const cand = fromOklch([clamp01(L + (up ? 1 : -1) * i * 0.01), C, H]);
    if (contrast(cand, bg) >= min) return cand;
  }
  return up ? '#FFFFFF' : '#000000';
}

const distance = (a, b) => {
  const [L1, C1, H1] = oklch(a);
  const [L2, C2, H2] = oklch(b);
  const dh = Math.min(Math.abs(H1 - H2), 360 - Math.abs(H1 - H2)) / 180;
  return Math.hypot(L1 - L2, (C1 - C2) * 2, dh * Math.min(C1, C2) * 3);
};

export function nearest(hex, candidates) {
  return candidates.filter(Boolean).reduce((best, c) => (distance(hex, c) < distance(hex, best) ? c : best));
}

// Text roles read hard against the ground: ink 7:1, accents 4.5:1 (they carry headline words).
export const INK_CONTRAST = 7;
export const ACCENT_CONTRAST = 4.5;

// Every role a scene or block may need, from ground, ink and one or two accents.
// - Given colours stay exactly as given in the theme's named colours (look.md: quote hex values
//   exactly), so shapes and fills can use them; the text roles (ink, accents) are moved in lightness,
//   hue kept, until they read at INK_CONTRAST / ACCENT_CONTRAST, and the change is reported.
// - A missing second accent is the first turned 35° in hue (away from violet), not a copy of it.
// - surface, muted, line and accent-soft are mixes, so they stay inside the colour world; the derived
//   ones that carry text are lifted until they read.
export function buildPalette({ ground, ink, accent, accent2 }) {
  const dark = (luminance(ground) ?? 0) < 0.18;
  const warnings = [];
  const lift = (role, hex, min) => {
    const out = ensureContrast(hex, ground, min);
    if (out !== hex.toUpperCase()) warnings.push(`${role} ${hex} on ground ${ground} was ${contrast(hex, ground).toFixed(1)}:1; text uses ${out} (${contrast(out, ground).toFixed(1)}:1)`);
    return out;
  };
  ink = lift('ink', ink, INK_CONTRAST);
  accent = lift('accent', accent, ACCENT_CONTRAST);
  let acc2 = accent2 && accent2.toUpperCase() !== accent.toUpperCase() ? lift('accent2', accent2, ACCENT_CONTRAST) : null;
  if (!acc2) {
    const [L, C, H] = oklch(accent);
    // Turn away from the violet band (spec.md BANNED: purple and blue gradients) when +35° lands in it.
    const turned = [(H + 35) % 360, (H + 325) % 360].find((h) => h < 285 || h > 330) ?? (H + 35) % 360;
    acc2 = ensureContrast(C < 0.04 ? mix(accent, ink, 0.5) : fromOklch([L, C, turned]), ground, ACCENT_CONTRAST);
  }
  return {
    ground: ground.toUpperCase(),
    ink: ink.toUpperCase(),
    accent: accent.toUpperCase(),
    accent2: acc2,
    surface: mix(ground, ink, dark ? 0.08 : 0.05),
    muted: ensureContrast(mix(ink, ground, 0.35), ground, 4.5),
    line: mix(ground, ink, 0.22),
    accentSoft: mix(ground, accent, 0.22),
    dark,
    warnings,
  };
}

// A registry item's colour variable → the palette role its name says it plays; otherwise the
// palette colour nearest to the item's own default, so its design keeps its light and dark parts.
const ROLE_BY_NAME = [
  [/(^|[-_])(bg|background|ground|backdrop|base|canvas|paper)([-_]|$)/i, 'ground'],
  [/(^|[-_])(text|ink|fg|foreground|title|headline|label|copy|font)([-_]|$)/i, 'ink'],
  [/(secondary|accent[-_]?2|alt|tertiary)/i, 'accent2'],
  [/(accent|highlight|primary|brand|main|hero|key)/i, 'accent'],
  [/(muted|sub|caption|meta|dim|faint)/i, 'muted'],
  [/(line|stroke|border|grid|rule|outline|divider)/i, 'line'],
  [/(surface|card|panel|fill|box|bubble|chip)/i, 'surface'],
];

export function roleColour(id, fallbackHex, palette) {
  for (const [re, role] of ROLE_BY_NAME) if (re.test(id)) return palette[role];
  if (!hexToRgb(fallbackHex)) return palette.accent;
  // A saturated default was a colour accent in the item's design; a neutral one was ground, text or a tint.
  return oklch(fallbackHex)[1] > 0.08
    ? nearest(fallbackHex, [palette.accent, palette.accent2])
    : nearest(fallbackHex, [palette.ink, palette.muted, palette.line, palette.surface, palette.ground]);
}

// Shader colours (the bundled shaders library: <canvas data-shader="Name"> reads data-shader-props).
// props: [name, default]. Background-like names take the ground; a neutral default (black borders,
// white highlights) takes the nearest neutral; the colourful ones walk the accent ramp in order.
export function shaderColours(props, palette) {
  const ramp = [palette.accent, palette.accent2, mix(palette.accent, palette.accent2, 0.5), mix(palette.accent, palette.ink, 0.4)];
  const out = {};
  let i = 0;
  for (const [name, def] of props) {
    if (/(bg|background|base|sky|night)/i.test(name)) out[name] = palette.ground;
    else if (hexToRgb(def) && oklch(def)[1] < 0.04) out[name] = nearest(def, [palette.ground, palette.line, palette.muted, palette.ink]);
    else out[name] = ramp[i++ % ramp.length];
  }
  return out;
}
