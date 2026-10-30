// Theme → the CSS custom properties registry items read.
// There is no formal token contract in the registry; items consistently read --bg, --fg, --accent,
// --accent-2, --brand and --font-display (and the presets' caption skins read --cap-*). We set all of
// them from the theme so mounted blocks and components pick the theme up without edits.

import { buildPalette } from './palette.js';

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/i.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

// Relative luminance (WCAG), 0 = black, 1 = white.
export function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const saturation = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const max = Math.max(...rgb) / 255;
  const min = Math.min(...rgb) / 255;
  return max === 0 ? 0 : (max - min) / max;
};

const isHex = (v) => /^#[0-9a-f]{3,8}$/i.test(String(v).trim());

// Which theme colour plays ground, ink and accent. Custom themes name them; presets use their own
// names (coral: coral, cream, black…), so fall back to names, then to luminance and saturation.
export function themeRoles(theme) {
  const colors = Object.fromEntries(Object.entries(theme.colors ?? {}).filter(([, v]) => isHex(v)));
  const roles = { ...(theme.roles ?? {}) };
  const pick = (re) => Object.keys(colors).find((k) => re.test(k));
  const resolve = (v) => (v && colors[v]) || (isHex(v) ? v : null);

  let ground = resolve(roles.ground) ?? colors[pick(/^(ground|bg|background|paper|canvas|base|cream|surface)$/i)];
  let ink = resolve(roles.ink) ?? colors[pick(/^(ink|fg|text|foreground|black|charcoal)$/i)];
  let accent = resolve(roles.accent) ?? colors[pick(/^(accent|brand|primary|highlight)$/i)];

  const byLum = Object.values(colors).filter((c) => luminance(c) != null).sort((a, b) => luminance(b) - luminance(a));
  ground ??= byLum[0];
  ink ??= byLum.at(-1);
  if (ground && ink && ground === ink) ink = luminance(ground) > 0.5 ? '#111111' : '#FFFFFF';
  accent ??= Object.values(colors).filter((c) => c !== ground && c !== ink).sort((a, b) => saturation(b) - saturation(a))[0] ?? ink;
  const accent2 = Object.values(colors).filter((c) => ![ground, ink, accent].includes(c)).sort((a, b) => saturation(b) - saturation(a))[0] ?? accent;

  const fonts = theme.fonts ?? [];
  // The full colour world (palette.js): surface, muted, line, accent-soft, and a real second accent.
  const palette = buildPalette({ ground: ground ?? '#0B0B0B', ink: ink ?? '#FFFFFF', accent: accent ?? '#FFFFFF', accent2: accent2 === accent ? null : accent2 });
  return {
    ground: palette.ground,
    ink: palette.ink,
    accent: palette.accent,
    accent2: palette.accent2,
    surface: palette.surface,
    muted: palette.muted,
    line: palette.line,
    accentSoft: palette.accentSoft,
    paletteWarnings: palette.warnings,
    display: theme.roles?.display ?? fonts[0] ?? 'Inter',
    body: theme.roles?.body ?? fonts[1] ?? fonts[0] ?? 'Inter',
    dark: (luminance(ground ?? '#000') ?? 0) < 0.35,
  };
}

const fontStack = (family, fallback) => `"${family}", ${fallback}`;

export function tokenCss(roles, colors = {}) {
  const named = Object.entries(colors).filter(([, v]) => isHex(v) || /^rgba?\(/i.test(String(v))).map(([k, v]) => `  --color-${k.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}: ${v};`);
  return [
    ':root {',
    `  --bg: ${roles.ground};`,
    `  --ground: ${roles.ground};`,
    `  --fg: ${roles.ink};`,
    `  --ink: ${roles.ink};`,
    `  --accent: ${roles.accent};`,
    `  --brand: ${roles.accent};`,
    `  --accent-2: ${roles.accent2};`,
    `  --surface: ${roles.surface ?? roles.ground};`,
    `  --muted: ${roles.muted ?? roles.ink};`,
    `  --line: ${roles.line ?? roles.ink};`,
    `  --accent-soft: ${roles.accentSoft ?? roles.accent};`,
    `  --font-display: ${fontStack(roles.display, 'system-ui, sans-serif')};`,
    `  --font-body: ${fontStack(roles.body, 'system-ui, sans-serif')};`,
    `  --cap-ink: ${roles.ink};`,
    `  --cap-canvas: ${roles.ground};`,
    `  --cap-accent: ${roles.accent};`,
    `  --cap-accent-2: ${roles.accent2};`,
    ...named,
    '}',
  ].join('\n');
}
