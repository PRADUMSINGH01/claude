// Thin wrapper over the pinned `hyperframes` CLI, run inside the job sandbox.
import { run } from './sandbox.js';

export const quote = (s) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

export function hf(ws, args, opts = {}) {
  return run(ws, `hyperframes ${args.map(quote).join(' ')}`, opts);
}

// CLI JSON is followed by human notes ("skills out of date"); take the first complete JSON value.
export function parseJsonOutput(text) {
  // Candidate starts: a line that begins a JSON object/array (log lines like "[hyperframes] …" fail to parse and are skipped).
  const starts = [];
  for (const m of text.matchAll(/^[ \t]*([{[])/gm)) starts.push(m.index + m[0].length - 1);
  for (const start of starts) {
    const close = text[start] === '{' ? '}' : ']';
    for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* shorter span */
      }
    }
  }
  return null;
}

export async function hfJson(ws, args, opts) {
  const res = await hf(ws, [...args, '--json'], opts);
  return { ...res, json: parseJsonOutput(res.output) };
}

const CHECK_GROUPS = ['lint', 'runtime', 'layout', 'motion', 'contrast', 'craft', 'audio'];

// Condense `check --json` to what an agent can act on.
export function summarizeCheck(report, { maxFindings = 30, includeInfo = false } = {}) {
  if (!report) return { ok: false, errors: 1, warnings: 0, text: 'check produced no JSON report.' };
  let errors = 0;
  let warnings = 0;
  const lines = [];
  const findings = [];
  for (const g of CHECK_GROUPS) {
    const r = report[g];
    if (!r) continue;
    errors += r.errorCount ?? 0;
    warnings += r.warningCount ?? 0;
    const sampled = r.enabled === false ? ' (not run)' : '';
    lines.push(`${g}: ${r.ok ? 'ok' : 'FAIL'} ${r.errorCount ?? 0}E ${r.warningCount ?? 0}W${sampled}`);
    for (const f of r.findings ?? r.issues ?? []) {
      if (f.severity === 'info' && !includeInfo) continue;
      findings.push({ group: g, ...f });
    }
  }
  findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  const shown = findings.slice(0, maxFindings).map((f) => {
    const where = [f.sourceFile, f.selector, f.time != null ? `t=${f.time}` : null].filter(Boolean).join(' ');
    const fix = f.fixHint ?? f.fix ?? f.suggestedColor ?? '';
    return `- [${f.severity}] ${f.group}/${f.code}: ${f.message}${where ? ` @ ${where}` : ''}${fix ? `\n    fix: ${typeof fix === 'string' ? fix : JSON.stringify(fix)}` : ''}`;
  });
  const more = findings.length > maxFindings ? `\n(+${findings.length - maxFindings} more)` : '';
  return {
    ok: Boolean(report.ok) && errors === 0,
    errors,
    warnings,
    findings,
    text: `${report.ok ? 'PASS' : 'FAIL'}: ${errors} errors, ${warnings} warnings\n${lines.join('\n')}${shown.length ? `\n\n${shown.join('\n')}${more}` : ''}`,
  };
}

const rank = (s) => ({ error: 0, warning: 1, info: 2 })[s] ?? 3;
