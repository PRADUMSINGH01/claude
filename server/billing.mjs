// Plans, credits and Dodo Payments. A paid plan exists only because a verified Dodo webhook said so:
// nothing a browser sends (a register form, a ?plan= link, POST /api/user/plan) can set one.
import crypto from 'node:crypto';

// Monthly credits per plan, as on the pricing page; the longest film each plan may order.
export const PLANS = {
  free: { credits: 15, maxSeconds: 15 },
  creator: { credits: 200, maxSeconds: 60 },
  pro: { credits: 600, maxSeconds: 60 },
  enterprise: { credits: 2500, maxSeconds: 60 },
};
export const PAID_TIERS = ['creator', 'pro', 'enterprise'];
const INTERVALS = ['monthly', 'annual'];
const MONTH_MS = 30 * 24 * 3600 * 1000;

// The flat rate: a credit per 3 seconds, at least 2. Used only when a film's model has no known price (so a
// price lookup that fails never blocks or undercharges a film).
export const creditCost = (seconds) => Math.max(2, Math.ceil(Number(seconds || 15) / 3));

// ---- Measured credits -----------------------------------------------------------------------------------
// A film is charged by what it used, not by its length alone: the model's cost in USD (OpenRouter reports
// what each call was billed; a model billed directly is priced at the same model's OpenRouter list price) plus
// its render time, at CREDIT_USD a credit. A short title on a cheap model costs 1-2 credits; a long film on a
// top model costs what it really did.
const positive = (name, fallback) => {
  const v = Number(env(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
export const creditUsd = () => positive('CREDIT_USD', 0.01);
export const renderUsdPerSecond = () => positive('RENDER_USD_PER_SECOND', 0.0005);

// What a film of this length typically uses, planning and building together (the middle of real 15 s films: about
// 75k tokens in and 100k out; a title card uses less, a 7-beat explainer twice that). Only for the estimate a film
// holds when it starts: it is charged what it measures.
export const typicalTokens = (seconds) => ({ input: 30_000 + 3_000 * seconds, cachedInput: 0, output: 25_000 + 5_000 * seconds });

// USD for these tokens at a price per million tokens { in, out, cacheRead }. Cached input is part of input.
export function tokenCost(tokens, price) {
  const input = Number(tokens?.input) || 0;
  const cached = Math.min(Number(tokens?.cachedInput) || 0, input);
  return ((input - cached) * price.in + cached * (price.cacheRead ?? price.in) + (Number(tokens?.output) || 0) * price.out) / 1e6;
}

export const creditsForCost = (costUsd, seconds) => Math.max(1, Math.ceil((Number(costUsd) + Number(seconds || 0) * renderUsdPerSecond()) / creditUsd() - 1e-9));

// What a film should hold when it starts: the typical use of this length at this model's price, or the flat
// rate when the price is unknown.
export const estimateCredits = (price, seconds) => (price ? creditsForCost(tokenCost(typicalTokens(seconds), price), seconds) : creditCost(seconds));

/**
 * What a finished film measured, in USD, from its usage.json ({ planner, builder }: input, output, cachedInput,
 * calls, pricedCalls, cost). A role whose every call reported its billed cost counts that; any other role is
 * priced from its tokens. null when a role can be neither (no price known).
 */
export function measuredCost(usage, price) {
  let total = 0;
  let any = false;
  for (const role of Object.values(usage ?? {})) {
    if (!role || typeof role !== 'object' || !((role.input ?? 0) + (role.output ?? 0))) continue;
    any = true;
    if (role.calls && role.pricedCalls === role.calls && Number.isFinite(role.cost)) total += role.cost;
    else if (price) total += tokenCost(role, price);
    else return null;
  }
  return any ? total : null;
}

const env = (name) => (process.env[name] ?? '').trim();
// Dodo documents DODO_PAYMENTS_API_KEY; DODO_API_KEY is accepted too.
const apiKey = () => env('DODO_PAYMENTS_API_KEY') || env('DODO_API_KEY');
export const billingConfigured = () => Boolean(apiKey());
const apiBase = () => env('DODO_PAYMENTS_BASE_URL') || (env('DODO_PAYMENTS_ENVIRONMENT') === 'live_mode' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com');

// Dodo products, one per tier and interval: DODO_PRODUCT_CREATOR_MONTHLY, DODO_PRODUCT_PRO_ANNUAL, ...
export const productFor = (tier, interval) => env(`DODO_PRODUCT_${String(tier).toUpperCase()}_${String(interval).toUpperCase()}`) || null;
export function planForProduct(productId) {
  for (const tier of PAID_TIERS) for (const interval of INTERVALS) if (productId && productFor(tier, interval) === productId) return { tier, interval };
  return null;
}

// Owners and testers work without paying: by account id (ADMIN_USER_IDS), or by email (ADMIN_EMAILS) only once
// that email is verified, since anyone can sign up with, or change to, an address that isn't theirs.
const listEnv = (name) => env(name).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
export const isAdmin = (user) =>
  Boolean(user) && (listEnv('ADMIN_USER_IDS').includes(String(user.id).toLowerCase()) || (user.auth?.emailVerified === true && listEnv('ADMIN_EMAILS').includes(String(user.email).toLowerCase())));

// The tier a user gets right now. A paid tier counts only when it came from Dodo and the subscription is in
// good standing: active, in its renewal grace period, or cancelled but paid until the period ends.
export function effectiveTier(user, now = Date.now()) {
  if (isAdmin(user)) return 'enterprise';
  const p = user?.plan;
  if (!p || p.source !== 'dodo' || !PAID_TIERS.includes(p.tier)) return 'free';
  if (p.status === 'active' || p.status === 'past_due') return p.tier;
  if (p.status === 'cancelled' && p.currentPeriodEnd && now < Date.parse(p.currentPeriodEnd)) return p.tier;
  return 'free';
}

// The credit ledger for the current period. A paid period is renewed by its webhook; a free one (or a paid
// one whose renewal is late) rolls over every 30 days.
export function credits(user, now = Date.now()) {
  user.usage ??= {};
  const c = (user.usage.credits ??= { used: 0, periodStart: new Date(now).toISOString(), periodEnd: new Date(now + MONTH_MS).toISOString() });
  if (now >= Date.parse(c.periodEnd)) {
    c.used = 0;
    c.periodStart = new Date(now).toISOString();
    c.periodEnd = new Date(now + MONTH_MS).toISOString();
  }
  const tier = effectiveTier(user, now);
  c.limit = PLANS[tier].credits;
  c.tier = tier;
  c.remaining = Math.max(0, c.limit - c.used);
  return c;
}

// The paywall: may this user order a film this long, holding this many credits? Returns null, or the 402.
export function paywall(user, seconds, now = Date.now(), cost = creditCost(seconds)) {
  const c = credits(user, now);
  const plan = PLANS[c.tier];
  if (seconds > plan.maxSeconds) {
    return { code: 'PLAN_LIMIT', message: `The ${c.tier} plan makes films up to ${plan.maxSeconds} s. Upgrade for longer films.`, tier: c.tier, maxSeconds: plan.maxSeconds, upgradeUrl: '/pricing' };
  }
  if (c.remaining < cost) {
    return { code: 'CREDITS_EXHAUSTED', message: `This film needs ${cost} credits and you have ${c.remaining} left this period.`, tier: c.tier, required: cost, remaining: c.remaining, resetsAt: c.periodEnd, upgradeUrl: '/pricing' };
  }
  return null;
}

// A film starts: it holds its estimate (settled when it finishes, refunded if it fails).
export function charge(user, job, seconds, cost = creditCost(seconds)) {
  const c = credits(user);
  job.userId = user.id;
  job.credits = cost;
  job.creditsHeld = cost;
  job.creditsRefunded = false;
  job.creditsSettled = false;
  c.used += job.credits;
  c.remaining = Math.max(0, c.limit - c.used);
}

/**
 * A film finished: its hold becomes what it measured. Less than held is given back; more is charged as far as
 * the credits left allow (a film already made is never taken away). Once per film; returns the credits charged.
 */
export function settle(user, job, measured) {
  if (!user || !job.credits || job.creditsSettled || job.creditsRefunded || !Number.isFinite(measured)) return null;
  const c = credits(user);
  const held = job.credits;
  const extra = Math.min(Math.max(0, measured - held), c.remaining);
  const back = Math.max(0, held - measured);
  c.used = Math.max(0, c.used + extra - back);
  c.remaining = Math.max(0, c.limit - c.used);
  job.credits = held + extra - back;
  job.creditsMeasured = measured;
  job.creditsSettled = true;
  return job.credits;
}

// A film that failed costs nothing. Once per job.
export function refund(user, job) {
  if (!user || !job.credits || job.creditsRefunded) return false;
  const c = credits(user);
  c.used = Math.max(0, c.used - job.credits);
  c.remaining = Math.max(0, c.limit - c.used);
  job.creditsRefunded = true;
  return true;
}

export class BillingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function dodo(method, pathname, body) {
  const res = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new BillingError(502, `Dodo Payments ${res.status}: ${String(json?.message ?? text).slice(0, 300)}`, 'PAYMENT_PROVIDER_ERROR');
  return json ?? {};
}

// A new subscriber goes to Dodo's hosted checkout. A subscriber in good standing changes plan instead (no
// second subscription); Dodo answers a change that needs a payment with a payment link.
export async function startCheckout({ user, tier, interval, returnUrl }) {
  if (!billingConfigured()) throw new BillingError(503, 'Payments are not set up on this server yet.', 'BILLING_NOT_CONFIGURED');
  if (!PAID_TIERS.includes(tier) || !INTERVALS.includes(interval)) throw new BillingError(400, 'Choose creator, pro or enterprise, monthly or annual.', 'INVALID_PLAN');
  const product = productFor(tier, interval);
  if (!product) throw new BillingError(503, `The ${tier} ${interval} plan has no Dodo product configured (DODO_PRODUCT_${tier.toUpperCase()}_${interval.toUpperCase()}).`, 'BILLING_NOT_CONFIGURED');
  const p = user.plan ?? {};
  if (p.source === 'dodo' && p.subscriptionId && ['active', 'past_due'].includes(p.status)) {
    if (p.tier === tier && p.billingInterval === interval) throw new BillingError(409, `You are already on ${tier} (${interval}).`, 'ALREADY_SUBSCRIBED');
    const r = await dodo('POST', `/subscriptions/${encodeURIComponent(p.subscriptionId)}/change-plan`, {
      product_id: product, quantity: 1, proration_billing_mode: 'prorated_immediately', return_url: returnUrl,
      metadata: { user_id: user.id, tier, interval },
    });
    return { kind: 'change', url: r.payment_link ?? null };
  }
  const r = await dodo('POST', '/checkouts', {
    product_cart: [{ product_id: product, quantity: 1 }],
    customer: p.customerId ? { customer_id: p.customerId } : { email: user.email, name: user.profile?.displayName || user.email },
    return_url: returnUrl,
    metadata: { user_id: user.id, tier, interval },
  });
  if (!r.checkout_url) throw new BillingError(502, 'Dodo Payments returned no checkout link.', 'PAYMENT_PROVIDER_ERROR');
  return { kind: 'checkout', url: r.checkout_url, sessionId: r.session_id };
}

// What each plan gives and costs, for the pricing and billing pages. Prices come from the Dodo products the
// server sells, so both pages show what checkout will charge. A plan with no product (or one Dodo can't
// return) has no price and can't be bought. Kept ten minutes; a failed lookup is retried on the next ask.
let plansCache = { at: 0, plans: null };
export async function listPlans(now = Date.now()) {
  if (plansCache.plans && now - plansCache.at < 10 * 60_000) return plansCache.plans;
  let complete = true;
  const priceOf = async (tier, interval) => {
    const id = productFor(tier, interval);
    if (!id || !billingConfigured()) return null;
    try {
      const p = (await dodo('GET', `/products/${encodeURIComponent(id)}`)).price ?? {};
      return Number.isFinite(p.price) ? { amount: p.price / 100, currency: p.currency ?? 'USD' } : null;
    } catch {
      complete = false;
      return null;
    }
  };
  const plans = await Promise.all(Object.entries(PLANS).map(async ([tier, p]) => {
    const prices = tier === 'free' ? { monthly: null, annual: null } : Object.fromEntries(await Promise.all(INTERVALS.map(async (i) => [i, await priceOf(tier, i)])));
    return { tier, credits: p.credits, maxSeconds: p.maxSeconds, prices, purchasable: Object.values(prices).some(Boolean) };
  }));
  if (complete) plansCache = { at: now, plans };
  return plans;
}

// Dodo's customer portal: payment method, invoices, cancel.
export async function portalLink({ user, returnUrl }) {
  if (!billingConfigured()) throw new BillingError(503, 'Payments are not set up on this server yet.', 'BILLING_NOT_CONFIGURED');
  const customerId = user.plan?.customerId;
  if (!customerId) throw new BillingError(404, 'You have no subscription to manage yet.', 'NO_SUBSCRIPTION');
  const r = await dodo('POST', `/customers/${encodeURIComponent(customerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`);
  if (!r.link) throw new BillingError(502, 'Dodo Payments returned no portal link.', 'PAYMENT_PROVIDER_ERROR');
  return r.link;
}

// The safety net for a missed webhook (a wrong endpoint URL or event filter, the tunnel down): ask Dodo
// for this user's subscription and payments and apply them like events. Dodo's own API is the authority
// here. Credits reset only when a subscription becomes active for this user for the first time, so calling
// this again never refills them.
export async function syncFromDodo(db, user) {
  if (!billingConfigured()) throw new BillingError(503, 'Payments are not set up on this server yet.', 'BILLING_NOT_CONFIGURED');
  const subs = (await dodo('GET', '/subscriptions?page_size=100')).items ?? [];
  const mine = subs
    .filter((s) => s.metadata?.user_id === user.id || (user.plan?.customerId && s.customer?.customer_id === user.plan.customerId))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const sub = mine.find((s) => ['active', 'past_due'].includes(s.status)) ?? mine[0];
  if (!sub) return { applied: [], message: 'no subscription found at Dodo' };
  const known = user.plan?.subscriptionId === sub.subscription_id && user.plan?.status === 'active';
  const type = sub.status === 'active' ? (known ? 'subscription.updated' : 'subscription.active') : `subscription.${sub.status}`;
  const applied = [applyEvent(db, { type, data: { ...sub, metadata: { ...sub.metadata, user_id: user.id } } })];
  const pays = (await dodo('GET', '/payments?page_size=100')).items ?? [];
  for (const p of pays.filter((x) => x.subscription_id === sub.subscription_id)) {
    applied.push(applyEvent(db, { type: p.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed', data: { ...p, metadata: { ...p.metadata, user_id: user.id } } }));
  }
  return { applied };
}

// Standard Webhooks, as Dodo signs them: HMAC-SHA256 over "id.timestamp.body" with the base64 secret after
// "whsec_", sent as space-separated "v1,<base64>" entries. Five minutes of clock tolerance.
export function verifyWebhook(rawBody, headers, secret = env('DODO_PAYMENTS_WEBHOOK_KEY'), now = Date.now()) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!secret || !id || !ts || !sig) return false;
  if (!Number.isFinite(Number(ts)) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'));
  return String(sig).split(' ').some((part) => {
    const given = Buffer.from(part.split(',')[1] ?? '');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

const iso = (v) => (v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

// Applies one verified event to the store. Returns what happened, for the log.
export function applyEvent(db, event, now = Date.now()) {
  const d = event?.data ?? {};
  const type = String(event?.type ?? '');
  const email = String(d.customer?.email ?? '').toLowerCase();
  const user = db.users.find((u) => d.metadata?.user_id && u.id === d.metadata.user_id)
    ?? db.users.find((u) => d.customer?.customer_id && u.plan?.customerId === d.customer.customer_id)
    // By email only for a verified address: an unverified sign-up can't collect someone else's payment.
    ?? db.users.find((u) => email && u.email === email && u.auth?.emailVerified === true);
  if (!user) return `${type}: no user for ${d.metadata?.user_id ?? d.customer?.customer_id ?? email ?? 'unknown'}`;
  const p = (user.plan ??= {});
  if (d.customer?.customer_id) p.customerId = d.customer.customer_id;

  if (type.startsWith('payment.')) {
    user.billing ??= {};
    const invoices = (user.billing.invoices ??= []);
    const id = d.payment_id ?? event.id ?? `pay_${now}`;
    if (!invoices.some((i) => i.id === id)) {
      invoices.unshift({ id, status: type === 'payment.succeeded' ? 'paid' : 'failed', amount: Number(d.total_amount ?? 0) / 100, currency: d.currency ?? 'USD', subscriptionId: d.subscription_id ?? null, createdAt: iso(d.created_at) ?? new Date(now).toISOString() });
      invoices.length = Math.min(invoices.length, 100);
    }
    return `${type}: ${user.email} ${d.total_amount ?? ''} ${d.currency ?? ''}`.trim();
  }
  if (!type.startsWith('subscription.')) return `${type}: ignored`;

  const mapped = planForProduct(d.product_id);
  if (d.subscription_id) p.subscriptionId = d.subscription_id;
  const status = {
    'subscription.active': 'active', 'subscription.renewed': 'active', 'subscription.plan_changed': 'active',
    'subscription.past_due': 'past_due', 'subscription.on_hold': 'on_hold', 'subscription.paused': 'paused',
    'subscription.cancelled': 'cancelled', 'subscription.expired': 'expired', 'subscription.failed': 'failed',
  }[type] ?? (d.status === 'active' ? 'active' : d.status) ?? p.status;
  if (['active', 'past_due'].includes(status) && !mapped) return `${type}: product ${d.product_id} is not a configured plan; ignored`;
  if (mapped) {
    p.tier = mapped.tier;
    p.billingInterval = mapped.interval;
  }
  p.source = 'dodo';
  p.status = status;
  p.cancelAtPeriodEnd = Boolean(d.cancel_at_next_billing_date);
  p.currentPeriodStart = iso(d.previous_billing_date) ?? p.currentPeriodStart ?? new Date(now).toISOString();
  p.currentPeriodEnd = iso(d.next_billing_date) ?? p.currentPeriodEnd ?? null;
  p.updatedAt = new Date(now).toISOString();
  // A new subscription or a paid renewal starts a fresh allowance for the period Dodo just billed.
  if (type === 'subscription.active' || type === 'subscription.renewed') {
    user.usage ??= {};
    user.usage.credits = { used: 0, periodStart: p.currentPeriodStart, periodEnd: p.currentPeriodEnd ?? new Date(now + MONTH_MS).toISOString() };
  }
  credits(user, now);
  return `${type}: ${user.email} → ${p.tier} ${p.billingInterval ?? ''} ${p.status}`.trim();
}
