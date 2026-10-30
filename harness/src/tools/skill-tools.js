// Progressive skill reading: map → outline → one section (or its subtree) at a time, inside a per-role budget.
import { config } from '../config.js';
import { canRead, allowedFiles, ROLE_ACCESS } from '../skills/access.js';

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// One line per readable file; this map goes in the system prompt instead of any content.
export function skillMap(role, lib) {
  const bySkill = new Map();
  for (const { skill, rel } of allowedFiles(role, lib)) {
    lib.sections(skill, rel);
    const f = lib.file(skill, rel);
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(`  - ${rel} (${fmtK(f.chars)} chars) ${f.summary ? `— ${f.summary}` : ''}`.trimEnd());
  }
  const out = [];
  for (const [skill, files] of bySkill) {
    out.push(`${skill}: ${lib.get(skill).description.slice(0, 220)}`);
    out.push(...files.sort());
  }
  return out.join('\n');
}

// A section plus every deeper heading under it, so "## Wiring" brings its "### Block" children.
function subtree(sections, id) {
  const i = sections.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const root = sections[i];
  const parts = [root];
  for (let j = i + 1; root.level > 0 && j < sections.length && sections[j].level > root.level; j++) parts.push(sections[j]);
  return parts.map((s) => s.text).join('\n\n');
}

export function readSection(lib, skill, file, section) {
  const sections = lib.sections(skill, file);
  if (!sections) return null;
  return section ? subtree(sections, section) : sections.map((s) => s.text).join('\n\n');
}

function outline(lib, skill, file, readLog) {
  const sections = lib.sections(skill, file);
  return sections
    .map((s) => {
      const indent = '  '.repeat(Math.max(0, s.level - 1));
      const mark = readLog.has(`${skill}/${file}#${s.id}`) ? ' [read]' : '';
      return `${indent}- ${s.title}  {section: "${s.id}", ${fmtK(s.chars)} chars}${mark}`;
    })
    .join('\n');
}

export function makeSkillTools() {
  const locate = (ctx, args) => {
    const { skill, rel } = ctx.lib.resolve(args.skill, args.file ?? 'SKILL.md');
    if (!ctx.lib.get(skill)) return { error: `No skill "${skill}". Call skill_map to see what you can read.` };
    if (!ctx.lib.file(skill, rel)) return { error: `No file "${rel}" in ${skill}. Call skill_map.` };
    if (!canRead(ctx.role, skill, rel)) return { error: `${skill}/${rel} is outside the ${ctx.role}'s reading list. Work from what you can read, or note the gap in your hand-off.` };
    return { skill, rel };
  };

  return [
    {
      name: 'skill_map',
      description: 'List the skill files you may read, with sizes and one-line summaries. Content is not included.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      run: (_args, ctx) => `${skillMap(ctx.role, ctx.lib)}\n\nBudget left: ${fmtK(ctx.skillBudget.left)} chars.`,
    },
    {
      name: 'skill_outline',
      description: 'Show the heading outline of one skill file with section ids and sizes. Read this before read_skill on any file over ~4k chars.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name, e.g. "hyperframes"' },
          file: { type: 'string', description: 'Path inside the skill, e.g. "references/format.md". Defaults to SKILL.md. Links like "../hyperframes-cli/references/x.md" are accepted.' },
        },
        required: ['skill'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const loc = locate(ctx, args);
        if (loc.error) return loc.error;
        return `${loc.skill}/${loc.rel}\n${outline(ctx.lib, loc.skill, loc.rel, ctx.readLog)}`;
      },
    },
    {
      name: 'read_skill',
      description: 'Read ONE section of a skill file (with its sub-headings). Pass the section id from skill_outline. Omit section only for small files. Spends your skill-reading budget.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          file: { type: 'string', description: 'Defaults to SKILL.md' },
          section: { type: 'string', description: 'Section id from skill_outline' },
          part: { type: 'integer', minimum: 1, description: 'For a section longer than one read, the part to return (1-based)' },
        },
        required: ['skill'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const loc = locate(ctx, args);
        if (loc.error) return loc.error;
        const { skill, rel } = loc;
        const f = ctx.lib.file(skill, rel);
        ctx.lib.sections(skill, rel);
        if (!args.section && f.chars > config.skillReadChars) {
          return `${skill}/${rel} is ${fmtK(f.chars)} chars; read it by section.\n${outline(ctx.lib, skill, rel, ctx.readLog)}`;
        }
        const text = readSection(ctx.lib, skill, rel, args.section);
        if (text == null) return `No section "${args.section}" in ${skill}/${rel}.\n${outline(ctx.lib, skill, rel, ctx.readLog)}`;

        const key = `${skill}/${rel}#${args.section ?? '*'}`;
        const size = config.skillReadChars;
        const parts = Math.max(1, Math.ceil(text.length / size));
        const part = Math.min(args.part ?? 1, parts);
        const partKey = `${key}@${part}`;
        if (ctx.readLog.has(partKey) && !ctx.compactedReads.has(partKey)) {
          return `Already read ${key}${parts > 1 ? ` part ${part}` : ''} earlier in this conversation; it is still above.`;
        }
        if (ctx.skillBudget.left <= 0) return 'Skill-reading budget spent. Work from what you have read, and name any gap in your hand-off.';

        const chunk = text.slice((part - 1) * size, part * size);
        ctx.skillBudget.left -= chunk.length;
        ctx.readLog.add(partKey);
        if (args.section) ctx.readLog.add(`${skill}/${rel}#${args.section}`);
        ctx.compactedReads.delete(partKey);
        ctx.lastSkillKey = partKey;
        ctx.emit('skill_read', { role: ctx.role, skill, file: rel, section: args.section ?? null, part, parts, chars: chunk.length, budgetLeft: ctx.skillBudget.left });
        const more = part < parts ? `\n\n[part ${part}/${parts}; call again with part: ${part + 1} for the rest]` : '';
        return `[${skill}/${rel}${args.section ? `#${args.section}` : ''}]\n${chunk}${more}`;
      },
    },
    {
      name: 'search_skills',
      description: 'Keyword search across the skill files you may read. Returns the best matching sections with ids and a snippet, not full text.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A few English keywords, e.g. "data-variable-values block colour"' } },
        required: ['query'],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const terms = String(args.query).toLowerCase().split(/[^a-z0-9-]+/).filter((t) => t.length > 2);
        if (!terms.length) return 'Give a few English keywords.';
        const hits = [];
        for (const { skill, rel } of allowedFiles(ctx.role, ctx.lib)) {
          for (const s of ctx.lib.sections(skill, rel)) {
            const hay = s.text.toLowerCase();
            const title = s.title.toLowerCase();
            let score = 0;
            for (const t of terms) {
              const n = hay.split(t).length - 1;
              if (n) score += Math.min(n, 5) + (title.includes(t) ? 4 : 0);
            }
            const covered = terms.filter((t) => hay.includes(t)).length;
            if (covered) hits.push({ skill, rel, s, score: score * (covered / terms.length) });
          }
        }
        hits.sort((a, b) => b.score - a.score);
        if (!hits.length) return 'No matches. Try other words, or call skill_map.';
        return hits.slice(0, 8).map(({ skill, rel, s }) => {
          const idx = s.text.toLowerCase().indexOf(terms.find((t) => s.text.toLowerCase().includes(t)));
          const snip = s.text.slice(Math.max(0, idx - 80), idx + 160).replace(/\s+/g, ' ');
          return `- ${skill} / ${rel} {section: "${s.id}"} "${s.title}" (${fmtK(s.chars)}): …${snip}…`;
        }).join('\n');
      },
    },
  ];
}

export function preloadText(role, lib) {
  const blocks = [];
  for (const p of ROLE_ACCESS[role].preload ?? []) {
    const text = readSection(lib, p.skill, p.file, p.section);
    if (text) blocks.push(`<skill-excerpt source="${p.skill}/${p.file}#${p.section}">\n${text}\n</skill-excerpt>`);
    else throw new Error(`Preload section missing: ${p.skill}/${p.file}#${p.section}`);
  }
  return blocks.join('\n\n');
}

// For check finding codes, name the skill sections (this role may read) that mention them.
export function pointersFor(lib, role, codes) {
  const out = [];
  for (const code of new Set(codes)) {
    for (const { skill, rel } of allowedFiles(role, lib)) {
      const hit = lib.sections(skill, rel).find((s) => s.text.includes(code));
      if (hit) {
        out.push(`${code} → read_skill {skill: "${skill}", file: "${rel}", section: "${hit.id}"}`);
        break;
      }
    }
  }
  return out;
}

// Resolve "skill/file#section" references (from critic issues) into text the role may read.
export function attachRefs(lib, role, refs, maxChars = 9000) {
  const blocks = [];
  const keys = [];
  let used = 0;
  for (const ref of new Set(refs.filter(Boolean))) {
    const m = /^([a-z0-9-]+)\/([^#]+)#(.+)$/.exec(String(ref).trim());
    if (!m) continue;
    const [, skill, file, section] = m;
    if (!canRead(role, skill, file)) continue;
    const text = readSection(lib, skill, file, section);
    if (!text || used + text.length > maxChars) continue;
    used += text.length;
    keys.push(`${skill}/${file}#${section}`);
    blocks.push(`<skill-excerpt source="${skill}/${file}#${section}">\n${text}\n</skill-excerpt>`);
  }
  return { text: blocks.join('\n\n'), keys };
}
