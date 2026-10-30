// The shared tool loop every subagent runs in. A subagent ends by calling its hand-off tool.
import { config, providerForRole } from './config.js';
import { chat, imageMessage } from './llm.js';
import { clip } from './sandbox.js';
import { readingGateMessage, unmetReading } from './skills/access.js';

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'registry_add']);

// The orchestrator can carry on past a builder or fixer that ran out of turns; the work is on disk.
export class OutOfTurnsError extends Error {
  constructor(role, maxTurns, handoffName, usage) {
    super(`${role} ran out of turns (${maxTurns}) before calling ${handoffName}`);
    this.role = role;
    this.usage = usage;
  }
}

const msgChars = (m) => (typeof m.content === 'string' ? m.content.length
  : Array.isArray(m.content) ? m.content.reduce((n, c) => n + (c.text?.length ?? 20_000), 0) : 0)
  + JSON.stringify(m.tool_calls ?? '').length;

// Keep the conversation under budget: old tool results become one-line stubs, old images are dropped.
function compact(messages, ctx, keepRecent = 8) {
  let total = messages.reduce((n, m) => n + msgChars(m), 0);
  if (total <= config.contextCharBudget) return;
  const cutoff = messages.length - keepRecent;
  for (let i = 2; i < cutoff && total > config.contextCharBudget * 0.7; i++) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400 && !m._stub) {
      const before = m.content.length;
      const head = m.content.slice(0, 160).replace(/\s+/g, ' ');
      if (m._skillKey) ctx.compactedReads.add(m._skillKey);
      m.content = `[elided to save context: ${head}… (${before} chars). Re-run the tool if you need it again.]`;
      m._stub = true;
      total -= before - m.content.length;
    } else if (m.role === 'user' && Array.isArray(m.content) && !m._stub) {
      const before = msgChars(m);
      m.content = `${m.content.find((c) => c.type === 'text')?.text ?? 'images'} [images elided]`;
      m._stub = true;
      total -= before - m.content.length;
    }
  }
}

const strip = (messages) => messages.map(({ _stub, _skillKey, ...m }) => m);

/**
 * Run one subagent to completion.
 * @param {object} o
 * @param {'planner'|'builder'|'critic'|'fixer'} o.role
 * @param {string} o.system
 * @param {string} o.task      first user message
 * @param {Array}  o.tools     [{name, description, parameters, run}]
 * @param {object} o.handoff   {name, description, parameters, validate?(args, ctx) -> string|null|Promise, maxRejections?}
 * @param {object} o.ctx       shared tool context (ws, lib, emit, ...)
 */
export async function runAgent({ role, system, task, images = [], tools, handoff, ctx, signal }) {
  const provider = providerForRole(role);
  const maxTurns = config.maxTurns[role];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolDefs = [...tools, handoff].map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: task }];
  const firstImages = await imageMessage(provider, 'Contact sheets for this task:', images);
  if (firstImages) messages.push(firstImages);
  const usage = { input: 0, output: 0, turns: 0 };
  let nudges = 0;
  let rejections = 0;

  ctx.emit('agent_start', { role, provider: provider.name, model: provider.model, skillBudget: ctx.skillBudget?.left ?? null });

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) throw new Error('aborted');
    compact(messages, ctx);
    const lastTurns = maxTurns - turn;
    if (lastTurns === 3) messages.push({ role: 'user', content: `Three turns left. Finish what is essential, then call ${handoff.name}.` });

    const { message, usage: u } = await chatFiltered(provider, messages, toolDefs, { signal, ctx, role });
    usage.input += u.input;
    usage.output += u.output;
    usage.turns = turn;
    ctx.emit('turn', { role, turn, input: u.input, output: u.output });
    const assistant = { role: 'assistant', content: message.content ?? '' };
    if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls;
    messages.push(assistant);
    const thoughtText = (message.reasoning || message.reasoning_content || '').trim();
    if (thoughtText) {
      ctx.emit('agent_text', { role, turn, text: thoughtText.slice(0, 4000) });
    } else if (message.content?.trim()) {
      ctx.emit('agent_text', { role, turn, text: message.content.trim().slice(0, 4000) });
    }

    if (!message.tool_calls?.length) {
      if (++nudges > 3) throw new Error(`${role} stopped without calling ${handoff.name}`);
      messages.push({ role: 'user', content: `Keep working with your tools. When you are done, call ${handoff.name}; plain text is not a hand-off.` });
      continue;
    }

    const pendingImages = [];
    let result = null;
    for (const call of message.tool_calls) {
      const name = call.function?.name;
      let args;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Arguments were not valid JSON. Send them again.' });
        continue;
      }

      // Mandatory reading: no writes and no hand-off until the role's required sections are read.
      // Installed registry items count too: their docs say which variables carry demo content.
      if (name === handoff.name || WRITE_TOOLS.has(name)) {
        const unreadBlocks = (ctx.requiredBlockDocs ?? []).filter((n) => !ctx.blockDocsRead?.has(n));
        const gate = [
          readingGateMessage(role, ctx.readLog, ctx.lib),
          unreadBlocks.length ? `Read each installed item's docs first (they list the demo content you must replace):\n${unreadBlocks.map((n) => `- block_doc {name: "${n}", section: "variables"}`).join('\n')}` : null,
        ].filter(Boolean).join('\n\n');
        if (gate) {
          const unmet = [...unmetReading(role, ctx.readLog, ctx.lib).map((r) => r.what), ...unreadBlocks.map((n) => `${n} docs`)];
          ctx.emit('reading_gate', { role, name, unmet });
          messages.push({ role: 'tool', tool_call_id: call.id, content: `Refused: ${gate}` });
          continue;
        }
      }

      if (name === handoff.name) {
        const problem = (await handoff.validate?.(args, ctx)) ?? null;
        if (problem && ++rejections <= (handoff.maxRejections ?? 4)) {
          ctx.emit('handoff_rejected', { role, name, attempt: rejections, reason: problem.slice(0, 3000) });
          messages.push({ role: 'tool', tool_call_id: call.id, content: `Hand-off rejected: ${problem}` });
          continue;
        }
        // Past the rejection limit the hand-off is accepted but carries what is still wrong.
        if (problem) args._unresolved = problem;
        ctx.emit('handoff', { role, name, payload: args });
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Received.' });
        result = args;
        continue;
      }

      const tool = byName.get(name);
      let content;
      const started = Date.now();
      try {
        if (!tool) throw new Error(`No tool "${name}". Available: ${[...byName.keys()].join(', ')}, ${handoff.name}`);
        const out = await tool.run(args, ctx);
        if (out && typeof out === 'object') {
          content = out.text;
          if (out.images?.length) pendingImages.push(...out.images);
        } else content = String(out ?? '');
      } catch (err) {
        content = `Error: ${err.message}`;
      }
      ctx.emit('tool', { role, turn, name, args: summarizeArgs(args), ms: Date.now() - started, chars: content.length, preview: content.slice(0, 700) });
      const msg = { role: 'tool', tool_call_id: call.id, content: clip(content, config.toolOutputChars * 2) };
      if (name === 'read_skill' && ctx.lastSkillKey) msg._skillKey = ctx.lastSkillKey;
      ctx.lastSkillKey = null;
      messages.push(msg);
    }

    if (result) {
      ctx.emit('agent_done', { role, usage });
      return { result, usage };
    }
    if (pendingImages.length) {
      const img = await imageMessage(provider, 'Frames from the tool call above:', pendingImages);
      messages.push(img ?? { role: 'user', content: `(${pendingImages.length} image(s) captured, but this model cannot see images: rely on check findings and the files.)` });
    }
  }
  throw new OutOfTurnsError(role, maxTurns, handoff.name, usage);
}

// Providers' safety filters sometimes flag harmless content (dense shader code, minified JS).
// Recover instead of failing the job: retry, then withhold recent tool output, then a fallback provider.
const isFiltered = (err) => err?.status === 400 && /flagged|content.?filter|usage policy|content_policy|ResponsibleAI/i.test(err?.message ?? '');

async function chatFiltered(provider, messages, toolDefs, { signal, ctx, role }) {
  try {
    return await chat(provider, strip(messages), toolDefs, { signal });
  } catch (err) {
    if (!isFiltered(err)) throw err;
    ctx.emit('content_filter', { role, step: 'retry' });
  }
  try {
    return await chat(provider, strip(messages), toolDefs, { signal });
  } catch (err) {
    if (!isFiltered(err)) throw err;
  }
  // Withhold the most recent tool outputs, which are the likeliest trigger.
  let withheld = 0;
  for (let i = messages.length - 1; i >= 0 && withheld < 3; i--) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 200) {
      m.content = 'Output withheld: the model provider\'s content filter flagged this request. If you need this content, read a smaller range or a different part.';
      m._stub = true;
      withheld++;
    }
  }
  ctx.emit('content_filter', { role, step: 'withheld', count: withheld });
  try {
    return await chat(provider, strip(messages), toolDefs, { signal });
  } catch (err) {
    if (!isFiltered(err) || !config.fallbackProvider) throw err;
  }
  const fb = { name: config.fallbackProvider, ...config.providers[config.fallbackProvider] };
  if (!fb.apiKey) throw new Error(`Content filter blocked ${role}, and fallback provider "${fb.name}" has no API key`);
  ctx.emit('content_filter', { role, step: 'fallback', provider: fb.name });
  return chat(fb, strip(messages), toolDefs, { signal });
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}… (${v.length})` : v;
  return out;
}
