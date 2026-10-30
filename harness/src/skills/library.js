// Indexes the skills directory without loading it into any prompt.
// Each markdown file is split into heading-delimited sections so agents can read one section at a time.
import fs from 'node:fs';
import path from 'node:path';

const MD = /\.md$/i;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

const slug = (s) => s.toLowerCase().replace(/[`*_[\]()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Splits markdown into sections at every heading (ignoring headings inside code fences).
export function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let current = { id: 'intro', title: '(intro)', level: 0, lines: [] };
  let fence = false;
  const seen = new Map();
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (current.lines.join('').trim()) sections.push(current);
      let id = slug(h[2]) || `section-${sections.length}`;
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      current = { id, title: h[2], level: h[1].length, lines: [line] };
    } else current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);
  return sections.map((s) => {
    const text = s.lines.join('\n').trim();
    return { id: s.id, title: s.title, level: s.level, text, chars: text.length };
  });
}

function firstLine(text) {
  return (text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('**Plugin')) ?? '').trim().slice(0, 160);
}

export class SkillLibrary {
  constructor(root) {
    this.root = root;
    this.skills = new Map(); // name -> { name, description, dir, files: Map(rel -> fileInfo) }
    this.load();
  }

  load() {
    if (!fs.existsSync(this.root)) throw new Error(`Skills directory not found: ${this.root}`);
    for (const ent of fs.readdirSync(this.root, { withFileTypes: true })) {
      const dir = path.join(this.root, ent.name);
      const skillMd = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const { meta } = parseFrontmatter(fs.readFileSync(skillMd, 'utf8'));
      const files = new Map();
      for (const rel of walk(dir)) {
        if (!MD.test(rel) || /(^|\/)(node_modules|test-corpus)\//.test(rel)) continue;
        files.set(rel, { rel, abs: path.join(dir, rel), _sections: null });
      }
      this.skills.set(meta.name || ent.name, { name: meta.name || ent.name, description: meta.description ?? '', dir, files });
    }
  }

  get(name) {
    return this.skills.get(name) ?? null;
  }

  file(skill, rel) {
    return this.get(skill)?.files.get(rel) ?? null;
  }

  sections(skill, rel) {
    const f = this.file(skill, rel);
    if (!f) return null;
    if (!f._sections) {
      const { body } = parseFrontmatter(fs.readFileSync(f.abs, 'utf8'));
      f._sections = splitSections(body);
      f.chars = f._sections.reduce((n, s) => n + s.chars, 0);
      f.title = f._sections.find((s) => s.level === 1)?.title ?? rel;
      f.summary = firstLine(f._sections.find((s) => s.level <= 1)?.text ?? '');
    }
    return f._sections;
  }

  // Resolves a path as written inside a skill ("references/x.md", "../hyperframes/references/y.md",
  // "hyperframes/references/y.md") into { skill, rel }.
  resolve(fromSkill, ref) {
    const clean = String(ref).replace(/\\/g, '/').replace(/#.*$/, '').replace(/^\.\//, '').replace(/^\//, '');
    if (clean.startsWith('../')) {
      const [skill, ...rest] = clean.slice(3).split('/');
      return { skill, rel: rest.join('/') || 'SKILL.md' };
    }
    const [head, ...rest] = clean.split('/');
    if (this.skills.has(head) && head !== fromSkill && rest.length) return { skill: head, rel: rest.join('/') };
    if (this.skills.has(head) && !rest.length) return { skill: head, rel: 'SKILL.md' };
    return { skill: fromSkill, rel: clean || 'SKILL.md' };
  }
}

function* walk(dir, base = '') {
  for (const ent of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) yield* walk(dir, rel);
    else yield rel;
  }
}
