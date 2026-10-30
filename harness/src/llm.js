// One chat-completions call through the OpenAI SDK, with per-provider quirks and retries.
import fs from 'node:fs';
import path from 'node:path';
import OpenAI, { APIConnectionError } from 'openai';
import { config } from './config.js';

const clients = new Map();

function client(p) {
  const key = `${p.name}|${p.baseURL}`;
  if (!clients.has(key)) {
    clients.set(key, new OpenAI({
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      // Azure's v1 endpoint authenticates with api-key; harmless elsewhere.
      defaultHeaders: p.kind === 'azure' ? { 'api-key': p.apiKey } : undefined,
      maxRetries: 0,
      timeout: config.requestTimeoutSec * 1000,
    }));
  }
  return clients.get(key);
}

function requestBody(p, messages, tools, toolChoice, maxOut = config.maxOutputTokens) {
  const body = { model: p.model, messages };
  if (tools?.length) {
    body.tools = p.kind === 'gemini' ? tools.map((t) => ({ ...t, function: { ...t.function, parameters: geminiSchema(t.function.parameters) } })) : tools;
    body.tool_choice = toolChoice ?? 'auto';
  }
  if (p.kind === 'azure' || p.kind === 'openai') {
    body.max_completion_tokens = maxOut;
    if (p.effort) {
      body.reasoning_effort = (p.effort === 'high' && /qwen/i.test(p.model)) ? 'xhigh' : p.effort;
    }
    if (tools?.length) body.parallel_tool_calls = true;
  } else {
    body.max_tokens = maxOut;
  }
  if (p.kind === 'gemini' && p.effort) body.reasoning_effort = p.effort === 'minimal' ? 'low' : p.effort;
  if (p.kind === 'glm' && p.effort) body.thinking = { type: p.effort === 'none' ? 'disabled' : 'enabled' };
  return body;
}

// Gemini's function declarations take an OpenAPI subset: no additionalProperties, no type unions,
// no minItems/maxItems/minimum/maximum. Keep the shape, drop the keywords.
export function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['additionalProperties', 'minItems', 'maxItems', 'minimum', 'maximum', '$schema'].includes(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      out.type = v.find((t) => t !== 'null') ?? 'string';
      if (v.includes('null')) out.nullable = true;
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    } else out[k] = typeof v === 'object' ? geminiSchema(v) : v;
  }
  return out;
}

const RETRY = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export async function chat(provider, messages, tools, { signal, toolChoice, maxOutputTokens } = {}) {
  const body = requestBody(provider, messages, tools, toolChoice, maxOutputTokens);
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await client(provider).chat.completions.create(body, { signal });
      const choice = res.choices?.[0];
      if (!choice) throw new Error('Provider returned no choices');
      return {
        message: choice.message,
        finish: choice.finish_reason,
        usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
      };
    } catch (err) {
      const status = err?.status ?? 0;
      // APIConnectionTimeoutError extends APIConnectionError; match the class, not the name string.
      const transient = RETRY.has(status) || err instanceof APIConnectionError
        || /timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(String(err?.message ?? ''));
      const took = ((Date.now() - started) / 1000).toFixed(0);
      if (!transient || attempt >= 5 || signal?.aborted) {
        console.error(`[llm] ${provider.name}/${provider.model} failed after ${took}s (attempt ${attempt + 1}): ${status || ''} ${String(err?.message ?? err).slice(0, 200)}`);
        throw err;
      }
      const wait = Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000;
      // Visible in the log: a timeout loop (slow model vs. REQUEST_TIMEOUT_SEC) shows up as repeated lines.
      console.error(`[llm] ${provider.name}/${provider.model} attempt ${attempt + 1} failed after ${took}s: ${status || ''} ${String(err?.message ?? err).slice(0, 160)} — retrying in ${(wait / 1000).toFixed(0)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Images go in a user message (tool messages can't carry them in chat completions).
export async function imageMessage(provider, label, paths) {
  if (!provider.vision || !paths.length) return null;
  const parts = [{ type: 'text', text: label }];
  const missing = [];
  for (const p of paths.slice(0, 6)) {
    const url = await toDataUrl(p);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
    else missing.push(path.basename(p));
  }
  if (missing.length) parts[0].text += ` (could not load: ${missing.join(', ')})`;
  return parts.length > 1 ? { role: 'user', content: parts } : null;
}

// Remote images are fetched by the harness, so one dead URL can't make the provider reject the whole request.
async function toDataUrl(p) {
  try {
    if (/^https:\/\//.test(p)) {
      const res = await fetch(p, { signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= 8 * 1024 * 1024 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
    }
    const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
    const buf = fs.readFileSync(p);
    return buf.length <= 8 * 1024 * 1024 ? `data:image/${ext};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}
