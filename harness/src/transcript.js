// Human-readable account of what each agent did: what it said, which skill sections it read,
// which tools it called and what came back, and what it handed off.
import fs from 'node:fs';

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const one = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function handoffSummary(role, p) {
  switch (role) {
    case 'planner':
      return [`"${p.title}" (${p.kind}), ${p.format?.width}x${p.format?.height} ${p.format?.duration}s, theme ${p.theme?.preset ?? p.theme?.name ?? 'custom'}`,
        ...(p.scenes ?? []).map((s) => `  ${s.id} ${s.start}-${+(s.start + s.duration).toFixed(2)}s  ${s.block ? `block ${s.block}` : 'hand-built'}${s.components?.length ? ` + ${s.components.join(', ')}` : ''}  — ${one(s.purpose, 90)}`)];
    case 'builder':
      return [one(p.summary, 300), ...(p.scenes ?? []).map((s) => `  ${s.id}: ${s.status}${s.notes ? ` — ${one(s.notes, 100)}` : ''}`),
        ...(p.known_issues ?? []).map((i) => `  known issue: ${one(i, 140)}`)];
    case 'critic':
      return [`verdict ${p.verdict}, score ${p.score}/10, ${p.issues?.length ?? 0} issues`,
        ...(p.issues ?? []).map((i) => `  ${i.id} [${i.severity}/${i.category}] ${one(i.where, 60)} — ${one(i.evidence, 120)}`),
        ...(p.previous ?? []).map((x) => `  previous ${x.id}: ${x.status}`)];
    case 'fixer':
      return [`fixed: ${(p.fixed ?? []).join(', ') || 'none'}`, ...(p.not_fixed ?? []).map((n) => `  not fixed ${n.id}: ${one(n.reason, 140)}`), p.notes ? `  ${one(p.notes, 200)}` : ''].filter(Boolean);
    default:
      return [one(JSON.stringify(p), 300)];
  }
}

// Console lines for one event (empty array = nothing to show).
export function consoleLines(ev) {
  const t = ev.turn ? `t${ev.turn}`.padStart(4) : '    ';
  switch (ev.type) {
    case 'job_start': return [`job ${ev.job}  ${ev.dir}`];
    case 'stage': return [`■ stage ${ev.stage}${ev.title ? `: ${ev.title}` : ''}${ev.theme ? ` (theme ${ev.theme})` : ''}`];
    case 'agent_start': return ['', `━━ ${ev.role.toUpperCase()}  ${ev.provider}/${ev.model}${ev.skillBudget ? `  skill budget ${k(ev.skillBudget)}` : ''}`];
    case 'agent_text': return [`${t}  💬 ${one(ev.text, 220)}`];
    case 'skill_read': return [`${t}  📖 ${ev.skill}/${ev.file}${ev.section ? `#${ev.section}` : ''}${ev.parts > 1 ? ` part ${ev.part}/${ev.parts}` : ''}  ${k(ev.chars)} chars  (budget left ${k(ev.budgetLeft)})`];
    case 'tool':
      if (ev.name === 'read_skill') return ev.preview.startsWith('[') ? [] : [`${t}  📖✗ ${one(JSON.stringify(ev.args), 120)} → ${one(ev.preview, 140)}`];
      return [`${t}  🔧 ${ev.name} ${one(JSON.stringify(ev.args), 140)}  ${(ev.ms / 1000).toFixed(1)}s → ${one(ev.preview, 160)}`];
    case 'handoff_rejected': return [`${t}  ⛔ ${ev.name} rejected (${ev.attempt}): ${one(ev.reason, 260)}`];
    case 'handoff': return [`      ✅ ${ev.name}`, ...handoffSummary(ev.role, ev.payload).map((l) => `      ${l}`), ...(ev.payload?._unresolved ? [`      ⚠ accepted with unresolved: ${one(ev.payload._unresolved, 200)}`] : [])];
    case 'agent_done': return [`      done: ${ev.usage.turns} turns, ${k(ev.usage.input)} in / ${k(ev.usage.output)} out tokens`];
    case 'gate_check': return [`      🔍 harness check for ${ev.role}: ${ev.errors} errors, ${ev.warnings} warnings`];
    case 'fake_media_removed': return ev.files.map((f) => `${t}  🧹 ${f}`);
    case 'agent_out_of_turns': return [`      ⏱ ${ev.message}; continuing with what is on disk`];
    case 'reading_gate': return [`${t}  📕 ${ev.name} refused — required reading not done: ${ev.unmet.join('; ')}`];
    case 'content_filter': return [`${t}  🛡 provider content filter flagged ${ev.role}'s request → ${ev.step}${ev.count != null ? ` (${ev.count} tool outputs withheld)` : ''}${ev.provider ? ` via ${ev.provider}` : ''}`];
    case 'layer_hidden': return ev.issues.map((w) => `◆ harness measured a covered background layer: ${w}`);
    case 'stuck': return [`${t}  🌀 stuck on ${ev.codes}: told to stop guessing and read the skill`];
    case 'registry_install': return [`■ registry add ${ev.name}: ${ev.ok ? 'ok' : 'FAILED'}`];
    case 'check': return [`■ round ${ev.round} check: ${ev.errors} errors, ${ev.warnings} warnings`];
    case 'review': return [`◆ review ${ev.round}: ${ev.verdict} (score ${ev.score}, ${ev.issues} issues)`];
    case 'fix': return [`✎ fix ${ev.round}: ${ev.fixed} fixed, ${ev.not_fixed} not fixed`];
    case 'render_start': return [`● render (${ev.quality})`];
    case 'render_done': return [`● render ${ev.ok ? 'ok' : `FAILED (exit ${ev.code})`}`];
    case 'job_done': return [`✔ ${ev.ok ? 'done' : 'rendered, but verification failed'}: ${ev.video ?? ''} (${ev.duration ?? '?'}s)`];
    case 'job_failed': return [`✖ failed: ${ev.error}`];
    default: return [];
  }
}

// transcript.md: the console view plus tool output previews and full hand-off payloads.
export class Transcript {
  constructor(file) {
    this.out = fs.createWriteStream(file, { flags: 'a' });
  }

  write(ev) {
    const lines = [];
    if (ev.type === 'agent_start') lines.push('', `## ${ev.role} — ${ev.provider}/${ev.model} — ${ev.at}`, '');
    else if (ev.type === 'agent_text') lines.push(`**t${ev.turn} says:** ${ev.text}`, '');
    else if (ev.type === 'skill_read') lines.push(`- t${ev.turn ?? ''} 📖 \`${ev.skill}/${ev.file}${ev.section ? `#${ev.section}` : ''}\`${ev.parts > 1 ? ` part ${ev.part}/${ev.parts}` : ''} — ${ev.chars} chars, budget left ${ev.budgetLeft}`);
    else if (ev.type === 'tool' && ev.name !== 'read_skill') {
      lines.push(`- t${ev.turn} 🔧 \`${ev.name}\` \`${one(JSON.stringify(ev.args), 300)}\` (${ev.ms} ms, ${ev.chars} chars)`, '', '  ```', ...ev.preview.split('\n').slice(0, 14).map((l) => `  ${l}`), '  ```', '');
    } else if (ev.type === 'handoff') {
      lines.push('', `### ${ev.name}`, '', '```json', JSON.stringify(ev.payload, null, 2).slice(0, 8000), '```', '');
    } else {
      const c = consoleLines(ev).filter(Boolean);
      if (c.length) lines.push(...c.map((l) => (ev.type === 'stage' || ev.type === 'job_start' ? `\n# ${l.trim()}` : `- ${l.trim()}`)));
    }
    if (lines.length) this.out.write(`${lines.join('\n')}\n`);
  }

  end() {
    this.out.end();
  }
}
