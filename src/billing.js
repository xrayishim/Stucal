// $4.99/month subscription through Stripe Checkout. Uses Stripe's REST API
// directly, so no SDK is needed. Without keys, checkout is disabled.
const crypto = require('node:crypto');
const db = require('./db');

const { STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, APP_URL = 'http://localhost:3000' } = process.env;
const enabled = Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID);

async function stripe(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Stripe ${res.status}`);
  return json;
}

async function createCheckout(user) {
  const session = await stripe('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: String(user.id),
    success_url: `${APP_URL}/?paid=1`,
    cancel_url: `${APP_URL}/`,
    ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : {}),
  });
  return session.url;
}

async function createPortal(user) {
  const session = await stripe('billing_portal/sessions', { customer: user.stripe_customer_id, return_url: APP_URL });
  return session.url;
}

function verifySignature(rawBody, header) {
  if (!STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

function handleWebhook(rawBody, signature) {
  if (!verifySignature(rawBody, signature)) return false;
  const event = JSON.parse(rawBody);
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    db.prepare(`UPDATE users SET plan = 'active', stripe_customer_id = ? WHERE id = ?`).run(obj.customer, Number(obj.client_reference_id));
  } else if (event.type === 'customer.subscription.deleted') {
    db.prepare(`UPDATE users SET plan = 'canceled' WHERE stripe_customer_id = ?`).run(obj.customer);
  } else if (event.type === 'customer.subscription.updated') {
    const plan = ['active', 'trialing'].includes(obj.status) ? 'active' : 'canceled';
    db.prepare(`UPDATE users SET plan = ? WHERE stripe_customer_id = ?`).run(plan, obj.customer);
  }
  return true;
}

module.exports = { enabled, createCheckout, createPortal, handleWebhook };
