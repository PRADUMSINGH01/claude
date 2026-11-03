// One chat-completions call through the OpenAI SDK, with per-provider quirks and retries.
import fs from 'node:fs';
import path from 'node:path';
import OpenAI, { APIConnectionError } from 'openai';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from './config.js';

const clients = new Map();

// Reasoning models (GLM thinking, xhigh effort) can take many minutes before the first response
// byte; Node's undici default kills the request at ~300s waiting for headers. Give every provider
// call a dispatcher whose header/body timeouts match the SDK's own.
const dispatcher = new Agent({
  headersTimeout: config.requestTimeoutSec * 1000 + 60_000,
  bodyTimeout: config.requestTimeoutSec * 1000 + 60_000,
});
const longFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher });

function client(p) {
  const key = `${p.name}|${p.baseURL}`;
  if (!clients.has(key)) {
    clients.set(key, new OpenAI({
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      fetch: longFetch,
      // Azure's v1 endpoint authenticates with api-key; OpenRouter shows the app name in its activity log.
      defaultHeaders: p.kind === 'azure' ? { 'api-key': p.apiKey } : p.kind === 'openrouter' ? { 'X-Title': 'Byreel Motion Studio' } : undefined,
      maxRetries: 0,
      timeout: config.requestTimeoutSec * 1000,
    }));
  }
  return clients.get(key);
}

export function requestBody(p, messages, tools, toolChoice, maxOut = config.maxOutputTokens, json = false) {
  const body = { model: p.model, messages };
  // OpenAI, Azure and OpenRouter can guarantee a valid JSON object; a malformed reply otherwise costs a repair
  // call or the job.
  if (json && ['openai', 'azure', 'openrouter'].includes(p.kind)) body.response_format = { type: 'json_object' };
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
  // OpenRouter's unified reasoning setting: low, medium or high ("xhigh"/"max" ask for its highest).
  if (p.kind === 'openrouter' && p.effort) {
    body.reasoning = p.effort === 'none' ? { enabled: false } : { effort: { minimal: 'low', xhigh: 'high', max: 'high' }[p.effort] ?? p.effort };
  }
  if (p.kind === 'openrouter' && p.route) body.provider = openRouterRoute(p.route);
  // OpenRouter reports what each call was billed (usage.cost, USD): films are charged by that, not a guess.
  if (p.kind === 'openrouter') body.usage = { include: true };
  // GLM's thinking is only on or off. Low effort turns it off: thinking can spend a whole 16k–32k output
  // budget before a single line of a scene file is written (seen in real runs).
  if (p.kind === 'glm' && p.effort) body.thinking = { type: ['none', 'minimal', 'low'].includes(p.effort) ? 'disabled' : 'enabled' };
  return body;
}

// OpenRouter's provider routing: a sort orders every provider serving the model; a provider tag pins that one,
// with no fallback to another (the choice is the point: its price, region or quantization).
export function openRouterRoute(route) {
  // "Cheapest" skips 4-bit providers: a real run sorted by price landed on an fp4 DeepSeek host that answered the
  // brief with "{}" and garbled keys, while fp8 hosts at nearly the same price answered it correctly.
  if (route === 'price') return { sort: 'price', quantizations: ['fp8', 'fp16', 'bf16', 'fp32', 'unknown'] };
  if (['throughput', 'latency'].includes(route)) return { sort: route };
  // A comma list: these providers in this order (the first that answers), and no others. A model's vetted cheap
  // hosts, e.g. DeepSeek's "baidu/fp8,morph/fp8,deepinfra/fp8/flex".
  if (route.includes(',')) return { order: route.split(',').map((t) => t.trim()).filter(Boolean), allow_fallbacks: false };
  return { only: [route], allow_fallbacks: false };
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

// One call's tokens: input (cached input is part of it, billed cheaper), output (reasoning included), and the
// billed cost in USD when the provider reports it (null otherwise: the server prices it from its table).
export function callUsage(u) {
  const cost = Number(u?.cost);
  return {
    input: u?.prompt_tokens ?? 0,
    output: u?.completion_tokens ?? 0,
    cachedInput: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cost: Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}

// Adds one call into a running total: tokens, and the cost only while every call so far reported one.
export function addUsage(total, u) {
  total.input += u.input;
  total.output += u.output;
  total.cachedInput = (total.cachedInput ?? 0) + (u.cachedInput ?? 0);
  total.calls += 1;
  total.pricedCalls = (total.pricedCalls ?? 0) + (u.cost == null ? 0 : 1);
  total.cost = (total.cost ?? 0) + (u.cost ?? 0);
  return total;
}

export async function chat(provider, messages, tools, { signal, toolChoice, maxOutputTokens, json } = {}) {
  const body = requestBody(provider, messages, tools, toolChoice, maxOutputTokens, json);
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await client(provider).chat.completions.create(body, { signal });
      const choice = res.choices?.[0];
      if (!choice) throw new Error('Provider returned no choices');
      return {
        message: choice.message,
        finish: choice.finish_reason,
        usage: callUsage(res.usage),
      };
    } catch (err) {
      const status = err?.status ?? 0;
      // APIConnectionTimeoutError extends APIConnectionError; match the class, not the name string.
      const transient = RETRY.has(status) || err instanceof APIConnectionError
        // "terminated": undici's word for a connection the far end closed mid-reply (a MiniMax film on SambaNova
        // lost its story step to one and was not retried).
        || /timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|terminated|other side closed/i.test(String(err?.message ?? ''));
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
