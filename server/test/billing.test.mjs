// The money path, end to end, with no real payment: the real server on a spare port with a temporary
// database, a fake Dodo API, and webhooks signed exactly as Dodo signs them (Standard Webhooks).
// Run: node --test server/test/billing.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { charge, creditCost, credits, effectiveTier, paywall, refund, verifyWebhook } from '../billing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const secretBytes = crypto.randomBytes(24);
const SECRET = `whsec_${secretBytes.toString('base64')}`;
const sign = (body, id, ts) => `v1,${crypto.createHmac('sha256', secretBytes).update(`${id}.${ts}.${body}`).digest('base64')}`;

test('credits, paywall and refunds follow the pricing page', () => {
  assert.equal(creditCost(15), 5);
  assert.equal(creditCost(9), 3);
  assert.equal(creditCost(4), 2, 'at least 2');
  const user = { email: 'a@b.c', plan: { tier: 'pro', status: 'active' } };
  assert.equal(effectiveTier(user), 'free', 'a tier with no Dodo payment behind it is not a plan');
  user.plan.source = 'dodo';
  assert.equal(effectiveTier(user), 'pro');
  user.plan.status = 'cancelled';
  user.plan.currentPeriodEnd = new Date(Date.now() + 86400000).toISOString();
  assert.equal(effectiveTier(user), 'pro', 'cancelled, but paid until the period ends');
  user.plan.currentPeriodEnd = new Date(Date.now() - 1000).toISOString();
  assert.equal(effectiveTier(user), 'free');

  const free = { email: 'f@b.c' };
  assert.equal(credits(free).limit, 15);
  assert.equal(paywall(free, 30).code, 'PLAN_LIMIT');
  const job = {};
  charge(free, job, 15);
  charge(free, {}, 15);
  charge(free, {}, 15);
  assert.equal(credits(free).remaining, 0);
  assert.equal(paywall(free, 15).code, 'CREDITS_EXHAUSTED');
  assert.equal(refund(free, job), true);
  assert.equal(refund(free, job), false, 'once per job');
  assert.equal(credits(free).remaining, 5);
});

test('webhook signatures: valid, tampered, stale, wrong secret', () => {
  const body = '{"type":"x"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sign(body, 'msg_1', ts) };
  assert.equal(verifyWebhook(body, headers, SECRET), true);
  assert.equal(verifyWebhook(`${body} `, headers, SECRET), false, 'one changed byte');
  assert.equal(verifyWebhook(body, { ...headers, 'webhook-signature': `v1,bad v1,${sign(body, 'msg_1', ts).slice(3)}` }, SECRET), true, 'any of several signatures');
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal(verifyWebhook(body, { ...headers, 'webhook-timestamp': old, 'webhook-signature': sign(body, 'msg_1', old) }, SECRET), false, 'replayed after 10 minutes');
  assert.equal(verifyWebhook(body, headers, `whsec_${crypto.randomBytes(24).toString('base64')}`), false);
});

test('sync from Dodo applies a payment whose webhook never came, and never refills credits', async (t) => {
  const { syncFromDodo } = await import('../billing.mjs');
  const sub = { subscription_id: 'sub_9', product_id: 'pdt_pro_m', status: 'active', customer: { customer_id: 'cus_9', email: 'late@example.com' }, metadata: { user_id: 'usr_late', tier: 'pro', interval: 'monthly' }, created_at: new Date().toISOString(), next_billing_date: new Date(Date.now() + 30 * 86400000).toISOString(), previous_billing_date: new Date().toISOString() };
  const other = { ...sub, subscription_id: 'sub_x', metadata: { user_id: 'someone-else' }, customer: { customer_id: 'cus_x', email: 'x@example.com' } };
  const dodo = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/subscriptions')) return res.end(JSON.stringify({ items: [other, sub] }));
    if (req.url.startsWith('/payments')) return res.end(JSON.stringify({ items: [{ payment_id: 'pay_9', status: 'succeeded', total_amount: 93219, currency: 'INR', subscription_id: 'sub_9', customer: sub.customer, created_at: sub.created_at }] }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => dodo.listen(0, '127.0.0.1', r));
  const saved = { ...process.env };
  Object.assign(process.env, { DODO_PAYMENTS_API_KEY: 'k', DODO_PAYMENTS_BASE_URL: `http://127.0.0.1:${dodo.address().port}`, DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m' });
  t.after(() => {
    dodo.close();
    for (const k of ['DODO_PAYMENTS_API_KEY', 'DODO_PAYMENTS_BASE_URL', 'DODO_PRODUCT_PRO_MONTHLY']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
  const user = { id: 'usr_late', email: 'late@example.com', plan: { tier: 'free' } };
  const db = { users: [user] };
  await syncFromDodo(db, user);
  assert.deepEqual([effectiveTier(user), user.plan.customerId, credits(user).limit], ['pro', 'cus_9', 600]);
  assert.deepEqual(user.billing.invoices.map((i) => [i.id, i.amount, i.currency]), [['pay_9', 932.19, 'INR']]);
  user.usage.credits.used = 100;
  await syncFromDodo(db, user);
  assert.equal(credits(user).used, 100, 'a second sync must not refill credits');
  assert.equal(user.billing.invoices.length, 1, 'the payment is recorded once');
});

test('register → paywall → checkout → webhooks → invoices → plan change → portal', async (t) => {
  // A fake Dodo API that records what the server asks for.
  const calls = [];
  const dodo = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/checkouts') return res.end(JSON.stringify({ session_id: 'cks_1', checkout_url: 'https://test.checkout.dodopayments.com/session/cks_1' }));
      if (/\/subscriptions\/sub_1\/change-plan$/.test(req.url)) return res.end(JSON.stringify({ payment_id: 'pay_2', payment_link: 'https://test.checkout.dodopayments.com/pay_2' }));
      if (/\/customers\/cus_1\/customer-portal\/session/.test(req.url)) return res.end(JSON.stringify({ link: 'https://test.customer.dodopayments.com/portal/x' }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => dodo.listen(0, '127.0.0.1', r));
  t.after(() => dodo.close());

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'byreel-billing-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [path.join(here, '..', 'index.mjs')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVER_DATA_DIR: data, JOBS_DIR: path.join(data, 'jobs'),
      DODO_PAYMENTS_API_KEY: 'dodo_test_key', DODO_PAYMENTS_WEBHOOK_KEY: SECRET, DODO_PAYMENTS_BASE_URL: `http://127.0.0.1:${dodo.address().port}`,
      DODO_PRODUCT_PRO_MONTHLY: 'pdt_pro_m', DODO_PRODUCT_ENTERPRISE_MONTHLY: 'pdt_ent_m', FRONTEND_URL: 'http://localhost:3000', ADMIN_EMAILS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  t.after(() => server.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  let token = null;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const me = async () => (await call('GET', '/api/user/me')).json.user;

  // Registration never grants a plan, whatever ?plan= says.
  const reg = await call('POST', '/api/register', { email: 'surfer@example.com', password: 'longpassword', name: 'Surfer', plan: 'enterprise' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json) + log);
  token = reg.json.token;
  let u = await me();
  assert.equal(u.plan.tier, 'free');
  assert.equal(u.plan.intended, 'enterprise');
  assert.deepEqual([u.usage.credits.limit, u.usage.credits.remaining], [15, 15]);

  // The paywall.
  const anon = await fetch(`${base}/api/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x"}' });
  assert.equal(anon.status, 401, 'no anonymous films');
  const long = await call('POST', '/api/prompt', { prompt: 'a 60 s film', length: 60 });
  assert.equal(long.status, 402);
  assert.equal(long.json.error, 'PLAN_LIMIT');
  const sneaky = await call('POST', '/api/user/plan', { tier: 'pro', interval: 'monthly' });
  assert.equal(sneaky.status, 402, 'the old free upgrade is closed');
  assert.equal((await me()).plan.tier, 'free');

  // Checkout: a hosted Dodo session for this user and product.
  const co = await call('POST', '/api/billing/checkout', { tier: 'pro', interval: 'monthly' });
  assert.equal(co.status, 200, JSON.stringify(co.json));
  assert.deepEqual([co.json.kind, co.json.url], ['checkout', 'https://test.checkout.dodopayments.com/session/cks_1']);
  const sent = calls.find((c) => c.url === '/checkouts');
  assert.equal(sent.auth, 'Bearer dodo_test_key');
  assert.deepEqual(sent.body.product_cart, [{ product_id: 'pdt_pro_m', quantity: 1 }]);
  assert.equal(sent.body.metadata.user_id, u.id);
  assert.equal(sent.body.return_url, 'http://localhost:3000/billing?checkout=success');
  assert.equal((await call('POST', '/api/billing/checkout', { tier: 'gold', interval: 'monthly' })).status, 400);

  // Webhooks.
  const hook = async (id, type, data, { signed = true } = {}) => {
    const body = JSON.stringify({ business_id: 'bus_1', type, timestamp: new Date().toISOString(), data });
    const ts = String(Math.floor(Date.now() / 1000));
    return call('POST', '/api/billing/webhook', body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signed ? sign(body, id, ts) : 'v1,forged' });
  };
  const sub = { payload_type: 'Subscription', subscription_id: 'sub_1', product_id: 'pdt_pro_m', status: 'active', customer: { customer_id: 'cus_1', email: 'surfer@example.com', name: 'Surfer' }, metadata: { user_id: u.id }, next_billing_date: new Date(Date.now() + 30 * 86400000).toISOString(), previous_billing_date: new Date().toISOString(), cancel_at_next_billing_date: false };
  assert.equal((await hook('msg_a', 'subscription.active', sub, { signed: false })).status, 401, 'forged webhooks are refused');
  assert.equal((await me()).plan.tier, 'free');
  assert.equal((await hook('msg_b', 'subscription.active', sub)).status, 200);
  u = await me();
  assert.deepEqual([u.plan.tier, u.plan.status, u.plan.customerId, u.usage.credits.limit], ['pro', 'active', 'cus_1', 600]);
  assert.equal((await hook('msg_b', 'subscription.active', sub)).json.duplicate, true, 'each event once');

  await hook('msg_c', 'payment.succeeded', { payload_type: 'Payment', payment_id: 'pay_1', total_amount: 3900, currency: 'USD', subscription_id: 'sub_1', customer: sub.customer, created_at: new Date().toISOString() });
  const inv = await call('GET', '/api/billing/invoices');
  assert.deepEqual(inv.json.invoices.map((i) => [i.id, i.amount, i.status]), [['pay_1', '$39.00 USD', 'paid']]);

  // An active subscriber changes plan instead of opening a second subscription.
  const change = await call('POST', '/api/billing/checkout', { tier: 'enterprise', interval: 'monthly' });
  assert.deepEqual([change.json.kind, change.json.url], ['change', 'https://test.checkout.dodopayments.com/pay_2']);
  assert.equal(calls.find((c) => /change-plan$/.test(c.url)).body.product_id, 'pdt_ent_m');
  assert.equal((await call('POST', '/api/billing/checkout', { tier: 'pro', interval: 'monthly' })).status, 409, 'already on it');

  const portal = await call('POST', '/api/billing/portal');
  assert.equal(portal.json.url, 'https://test.customer.dodopayments.com/portal/x');

  // A failed renewal puts the subscription on hold: free limits until it is paid.
  await hook('msg_d', 'subscription.on_hold', { ...sub, status: 'on_hold' });
  assert.equal((await me()).plan.tier, 'free');
  await hook('msg_e', 'subscription.renewed', sub);
  u = await me();
  assert.deepEqual([u.plan.tier, u.usage.credits.used], ['pro', 0]);
  assert.match(log, /\[billing\] subscription\.renewed: surfer@example\.com → pro monthly active/);
});
