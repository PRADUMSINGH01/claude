// What each registry item did in past builds, shared across jobs: kept as planned, or escalated to a
// written scene / broke the render. The shortlist ranks by it and retires items that keep failing,
// so one bad pick (a block that ignores the theme, shows demo data, stalls the renderer) is not
// offered to every film after it.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const file = () => path.join(config.jobsDir, 'registry-stats.json');

export function readStats() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

// outcomes: [{ name, ok, why }]. Read-modify-write: concurrent builds may lose a count, never corrupt.
export function recordOutcomes(outcomes) {
  if (!outcomes.length) return;
  const stats = readStats();
  for (const { name, ok, why } of outcomes) {
    const s = (stats[name] ??= { kept: 0, failed: 0, why: [] });
    if (ok) s.kept++;
    else {
      s.failed++;
      if (why) s.why = [String(why).slice(0, 200), ...s.why].slice(0, 3);
    }
  }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(stats, null, 2));
  } catch {
    /* stats are advisory */
  }
}

// Failed at least twice and more often than kept.
export const retired = (s) => Boolean(s && s.failed >= 2 && s.failed > s.kept);

// Positive for items that keep working, negative for ones that keep failing.
export const standing = (s) => (s ? s.kept - 2 * s.failed : 0);
