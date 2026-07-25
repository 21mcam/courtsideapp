// Transactional email service — Phase 3 email slice.
//
// Two layers under test:
//
//   1. Pure template renderers in src/services/email.js — unit
//      tests, no DB, no network, never skipped.
//   2. Flow integration — the four transactional emails fire from
//      their real endpoints/webhooks with NO RESEND_API_KEY set.
//      Every send becomes a recorded no-op (__getSkippedEmails), so
//      we assert both "the flow still succeeds keyless" AND "the
//      right email would have gone out, to the right recipient,
//      with the tenant's reply-to".
//
// Request-path emails fire on res 'finish' (after withTenantContext's
// COMMIT), which can land a tick after fetch() resolves — hence the
// small waitForEmail poll helper. Webhook emails fire before the
// webhook responds, but the same helper keeps assertions uniform.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import Stripe from 'stripe';

const TENANT = 'verify-email-flows';
const TZ = 'America/New_York';
const WEBHOOK_SECRET = 'whsec_test_secret_for_email_tests';

// Keyless email + faked Stripe, BEFORE the app (and the email
// service) load.
delete process.env.RESEND_API_KEY;
delete process.env.EMAIL_FROM;
process.env.STRIPE_TEST_MODE = '1';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const { app } = await import('../src/app.js');
const {
  renderBookingConfirmationEmail,
  renderBookingCancellationEmail,
  renderPasswordResetEmail,
  renderWelcomeEmail,
  tenantUrl,
  redactEmail,
  sendEmail,
  __getSkippedEmails,
  __clearSkippedEmails,
} = await import('../src/services/email.js');

// ============================================================
// unit: template rendering (no DB, never skipped)
// ============================================================

const T = {
  tenantName: 'Momentum <Sports>',
  accent: 'emerald',
  timezone: TZ,
};

// 2027-03-01T15:00:00Z = 10:00 AM EST on Monday Mar 1 in New York.
const START = '2027-03-01T15:00:00.000Z';

test('booking confirmation renders credits, local time, and escapes HTML', () => {
  const { subject, html, text } = renderBookingConfirmationEmail({
    ...T,
    recipientName: 'Casey',
    offeringName: '30-min <Cage>',
    resourceName: 'Cage 1',
    startTime: START,
    creditCost: 3,
  });
  assert.equal(subject, 'Booking confirmed: 30-min <Cage>');
  // Tenant timezone, not server timezone (CLAUDE.md gotcha #6).
  for (const part of ['Mar 1, 2027', '10:00 AM', 'EST']) {
    assert.ok(html.includes(part), `html missing "${part}"`);
    assert.ok(text.includes(part), `text missing "${part}"`);
  }
  assert.ok(html.includes('3 credits'));
  assert.ok(text.includes('3 credits'));
  // User-supplied strings are escaped in HTML, raw in text.
  assert.ok(html.includes('30-min &lt;Cage&gt;'));
  assert.ok(!html.includes('30-min <Cage>'));
  assert.ok(html.includes('Momentum &lt;Sports&gt;'));
  assert.ok(text.includes('30-min <Cage>'));
  // Accent header uses the tenant's color (emerald 600).
  assert.ok(html.includes('#059669'));
});

test('booking confirmation renders paid and due-at-facility variants', () => {
  const paid = renderBookingConfirmationEmail({
    ...T,
    offeringName: 'Cage 60',
    resourceName: 'Cage 1',
    startTime: START,
    amountPaidCents: 4500,
  });
  assert.ok(paid.text.includes('$45.00 (paid)'));
  const due = renderBookingConfirmationEmail({
    ...T,
    offeringName: 'Cage 60',
    resourceName: 'Cage 1',
    startTime: START,
    amountDueCents: 4500,
  });
  assert.ok(due.text.includes('$45.00 (due at the facility)'));
});

test('cancellation renders refund note only when credits were refunded', () => {
  const withRefund = renderBookingCancellationEmail({
    ...T,
    recipientName: 'Casey',
    offeringName: 'Cage 60',
    resourceName: 'Cage 1',
    startTime: START,
    refundCredits: 3,
  });
  assert.equal(withRefund.subject, 'Booking cancelled: Cage 60');
  assert.ok(withRefund.html.includes('3 credits have been refunded'));
  assert.ok(withRefund.text.includes('3 credits have been refunded'));

  const single = renderBookingCancellationEmail({
    ...T,
    offeringName: 'Cage 60',
    resourceName: 'Cage 1',
    startTime: START,
    refundCredits: 1,
  });
  assert.ok(single.text.includes('1 credit has been refunded'));

  const noRefund = renderBookingCancellationEmail({
    ...T,
    offeringName: 'Cage 60',
    resourceName: 'Cage 1',
    startTime: START,
    refundCredits: 0,
  });
  assert.ok(!noRefund.html.includes('refunded'));
  assert.ok(!noRefund.text.includes('refunded'));
});

test('password reset renders the reset link in html and text', () => {
  const resetUrl = 'http://momentum.localhost:5173/reset?token=abc123';
  const { subject, html, text } = renderPasswordResetEmail({
    tenantName: 'Momentum',
    accent: 'indigo',
    resetUrl,
  });
  assert.equal(subject, 'Reset your Momentum password');
  assert.ok(html.includes(`href="${resetUrl}"`));
  assert.ok(text.includes(resetUrl));
  assert.ok(text.includes('expires in 1 hour'));
});

test('welcome renders greeting and login URL', () => {
  const { subject, html, text } = renderWelcomeEmail({
    tenantName: 'Momentum',
    accent: 'sky',
    firstName: 'Casey',
    loginUrl: 'http://momentum.localhost:5173/login',
  });
  assert.equal(subject, 'Welcome to Momentum');
  assert.ok(html.includes('Hi Casey,'));
  assert.ok(html.includes('http://momentum.localhost:5173/login'));
  assert.ok(text.includes('http://momentum.localhost:5173/login'));
});

test('tenantUrl matches resolveTenant hostname shapes (dev and prod)', () => {
  const prevHost = process.env.APP_HOSTNAME;
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.APP_HOSTNAME = 'localhost';
    delete process.env.NODE_ENV;
    assert.equal(
      tenantUrl('momentum', '/reset?token=x'),
      'http://momentum.localhost:5173/reset?token=x',
    );
    process.env.APP_HOSTNAME = 'courtside.app';
    process.env.NODE_ENV = 'production';
    assert.equal(tenantUrl('momentum', '/login'), 'https://momentum.courtside.app/login');
  } finally {
    if (prevHost === undefined) delete process.env.APP_HOSTNAME;
    else process.env.APP_HOSTNAME = prevHost;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
});

test('redactEmail keeps first char + domain only', () => {
  assert.equal(redactEmail('member@example.com'), 'm***@example.com');
  assert.equal(redactEmail('not-an-email'), '***');
  assert.equal(redactEmail(null), '***');
});

test('sendEmail without RESEND_API_KEY no-ops and records the skip', async () => {
  __clearSkippedEmails();
  const result = await sendEmail({
    to: 'someone@example.com',
    subject: 'Test subject',
    html: '<p>hi</p>',
    text: 'hi',
    replyTo: 'desk@example.com',
  });
  assert.deepEqual(result, { skipped: true });
  const log = __getSkippedEmails();
  assert.equal(log.length, 1);
  assert.equal(log[0].to, 'someone@example.com');
  assert.equal(log[0].subject, 'Test subject');
  assert.equal(log[0].replyTo, 'desk@example.com');
});

// ============================================================
// integration: flows succeed keyless + queue the right email
// ============================================================

const skip =
  !process.env.DATABASE_URL_PRIVILEGED &&
  'DATABASE_URL_PRIVILEGED required';

let server;
let baseUrl;
let privilegedPool;
let tenant_id;
let adminToken;
let memberToken;
let member_id;
let memberEmail;
let resource_id;
let offering_id;
let plan_id;
let stripe_account_id;

const REPLY_TO = 'frontdesk@momentum-tests.example.com';

// Far-future Monday; hours below cover Mondays only. Distinct slots
// per test so the GiST exclusion never trips across tests.
const MONDAY = '2027-03-01';
const iso = (hhmm) => new Date(`${MONDAY}T${hhmm}:00.000-05:00`).toISOString();

before(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  privilegedPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL_PRIVILEGED,
  });
  await privilegedPool.query(
    `INSERT INTO tenants (subdomain, name, timezone)
     VALUES ($1, 'Email Tests', $2)
     ON CONFLICT (subdomain) DO NOTHING`,
    [TENANT, TZ],
  );
  tenant_id = (
    await privilegedPool.query(`SELECT id FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ])
  ).rows[0].id;

  const adminEmail = `admin-${randomUUID()}@example.com`;
  const u = await privilegedPool.query(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
     VALUES ($1, $2, $3, 'Admin', 'X') RETURNING id`,
    [tenant_id, adminEmail, await bcrypt.hash('password', 10)],
  );
  await privilegedPool.query(
    `INSERT INTO tenant_admins (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [tenant_id, u.rows[0].id],
  );

  resource_id = (
    await privilegedPool.query(
      `INSERT INTO resources (tenant_id, name) VALUES ($1, 'Email Cage') RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  offering_id = (
    await privilegedPool.query(
      `INSERT INTO offerings
         (tenant_id, name, category, duration_minutes, credit_cost,
          dollar_price, capacity, allow_member_booking, allow_public_booking)
       VALUES ($1, 'Cage 60', 'cage-time', 60, 3, 4500, 1, true, true)
       RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;
  await privilegedPool.query(
    `INSERT INTO offering_resources (tenant_id, offering_id, resource_id)
     VALUES ($1, $2, $3)`,
    [tenant_id, offering_id, resource_id],
  );
  await privilegedPool.query(
    `INSERT INTO operating_hours (tenant_id, resource_id, day_of_week, open_time, close_time)
     VALUES ($1, $2, 1, '09:00', '17:00')`,
    [tenant_id, resource_id],
  );
  // Wide advance window so far-future Monday slots book cleanly;
  // 24h free-cancel so the far-future cancel refunds 100%.
  await privilegedPool.query(
    `INSERT INTO booking_policies (
       tenant_id, free_cancel_hours_before, allow_member_self_cancel,
       min_advance_booking_minutes, max_advance_booking_days
     ) VALUES ($1, 24, true, 0, 730)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant_id],
  );

  plan_id = (
    await privilegedPool.query(
      `INSERT INTO plans (tenant_id, name, monthly_price_cents, credits_per_week)
       VALUES ($1, 'Email Test Plan', 9900, 5) RETURNING id`,
      [tenant_id],
    )
  ).rows[0].id;

  stripe_account_id = `acct_test_${randomUUID().slice(0, 8)}`;
  await privilegedPool.query(
    `INSERT INTO stripe_connections (tenant_id, stripe_account_id, charges_enabled)
     VALUES ($1, $2, true)`,
    [tenant_id, stripe_account_id],
  );

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const login = await fetch(`${baseUrl}/api/auth/login?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'password' }),
  });
  adminToken = (await login.json()).token;

  // Self-registered member (register-member also queues a welcome
  // email as of the people-flows slice — asserted in its own test
  // below; every email test clears the skip log first).
  memberEmail = `member-${randomUUID()}@example.com`;
  const reg = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: memberEmail,
      password: 'password123',
      first_name: 'Casey',
      last_name: 'Member',
    }),
  });
  assert.equal(reg.status, 201);
  ({ token: memberToken, member_id } = await reg.json());
  const adj = await adminFetch(`/api/admin/members/${member_id}/credit-adjustments`, {
    method: 'POST',
    body: JSON.stringify({ amount: 10, note: 'email test seed' }),
  });
  assert.equal(adj.status, 201);
});

after(async () => {
  if (!process.env.DATABASE_URL_PRIVILEGED) return;
  if (privilegedPool) {
    await privilegedPool.query(
      `DELETE FROM stripe_webhook_events WHERE account_id = $1`,
      [stripe_account_id],
    );
    await privilegedPool.query(`DELETE FROM tenants WHERE subdomain = $1`, [
      TENANT,
    ]);
    await privilegedPool.end();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
});

function adminFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {}),
    },
  });
}

function memberFetch(path, init = {}) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${baseUrl}${path}${sep}tenant=${TENANT}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${memberToken}`,
      ...(init.headers ?? {}),
    },
  });
}

function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return fetch(`${baseUrl}/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': signature,
    },
    body: payload,
  });
}

// Request-path emails fire on res 'finish' — poll briefly.
async function waitForEmail(pred, { timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = __getSkippedEmails().find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('admin sets the tenant reply-to; /api/tenant exposes it', { skip }, async () => {
  const bad = await adminFetch('/api/admin/reply-to-email', {
    method: 'PUT',
    body: JSON.stringify({ reply_to_email: 'not-an-email' }),
  });
  assert.equal(bad.status, 400);

  const res = await adminFetch('/api/admin/reply-to-email', {
    method: 'PUT',
    body: JSON.stringify({ reply_to_email: REPLY_TO.toUpperCase() }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { reply_to_email: REPLY_TO });

  const t = await fetch(`${baseUrl}/api/tenant?tenant=${TENANT}`);
  assert.equal((await t.json()).reply_to_email, REPLY_TO);
});

test('member self-signup gets a welcome email (keyless no-op)', { skip }, async () => {
  __clearSkippedEmails();
  const email = `selfsignup-${randomUUID()}@example.com`;
  const res = await fetch(`${baseUrl}/api/auth/register-member?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'password123',
      first_name: 'Selby',
      last_name: 'Signup',
    }),
  });
  assert.equal(res.status, 201);

  const mail = await waitForEmail((e) => e.to === email);
  assert.ok(mail, 'welcome email was not queued');
  assert.equal(mail.subject, 'Welcome to Email Tests');
  assert.ok(mail.html.includes('Hi Selby,'));
  assert.ok(mail.text.includes(`http://${TENANT}.localhost:5173/login`));
});

test('admin-created member gets a welcome email (keyless no-op)', { skip }, async () => {
  __clearSkippedEmails();
  const email = `manual-${randomUUID()}@example.com`;
  const res = await adminFetch('/api/admin/members', {
    method: 'POST',
    body: JSON.stringify({ email, first_name: 'Manny', last_name: 'Ual' }),
  });
  assert.equal(res.status, 201);

  const mail = await waitForEmail((e) => e.to === email);
  assert.ok(mail, 'welcome email was not queued');
  assert.equal(mail.subject, 'Welcome to Email Tests');
  assert.equal(mail.replyTo, REPLY_TO);
  assert.ok(mail.html.includes('Hi Manny,'));
  assert.ok(mail.text.includes(`http://${TENANT}.localhost:5173/login`));
});

test('member booking sends a confirmation with credits + local time', { skip }, async () => {
  __clearSkippedEmails();
  const res = await memberFetch('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: iso('10:00'),
    }),
  });
  assert.equal(res.status, 201);
  const { booking } = await res.json();

  const mail = await waitForEmail((e) => e.to === memberEmail);
  assert.ok(mail, 'confirmation email was not queued');
  assert.equal(mail.subject, 'Booking confirmed: Cage 60');
  assert.equal(mail.replyTo, REPLY_TO);
  assert.ok(mail.text.includes('Cage 60'));
  assert.ok(mail.text.includes('Email Cage'));
  assert.ok(mail.text.includes('3 credits'));
  assert.ok(mail.text.includes('10:00 AM'));
  assert.ok(mail.text.includes('EST'));

  // Cancel it → cancellation email with the full-refund note.
  __clearSkippedEmails();
  const cancel = await memberFetch(`/api/bookings/${booking.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).refund_credits, 3);

  const cancelMail = await waitForEmail((e) => e.to === memberEmail);
  assert.ok(cancelMail, 'cancellation email was not queued');
  assert.equal(cancelMail.subject, 'Booking cancelled: Cage 60');
  assert.equal(cancelMail.replyTo, REPLY_TO);
  assert.ok(cancelMail.text.includes('3 credits have been refunded'));
});

test('admin walk-in booking sends confirmation to the customer', { skip }, async () => {
  __clearSkippedEmails();
  const customerEmail = `walkin-${randomUUID()}@example.com`;
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: iso('11:00'),
      end_time: iso('12:00'),
      customer: {
        first_name: 'Walk',
        last_name: 'In',
        email: customerEmail,
      },
    }),
  });
  assert.equal(res.status, 201);

  const mail = await waitForEmail((e) => e.to === customerEmail);
  assert.ok(mail, 'walk-in confirmation email was not queued');
  assert.equal(mail.subject, 'Booking confirmed: Cage 60');
  assert.ok(mail.text.includes('$45.00 (due at the facility)'));
});

test('admin member booking sends no email (member was at the desk)', { skip }, async () => {
  __clearSkippedEmails();
  const res = await adminFetch('/api/admin/bookings', {
    method: 'POST',
    body: JSON.stringify({
      offering_id,
      resource_id,
      start_time: iso('12:00'),
      end_time: iso('13:00'),
      member_id,
    }),
  });
  assert.equal(res.status, 201);
  const mail = await waitForEmail((e) => e.to === memberEmail, { timeout: 300 });
  assert.equal(mail, null);
});

test('forgot-password sends the reset link', { skip }, async () => {
  __clearSkippedEmails();
  const res = await fetch(`${baseUrl}/api/auth/forgot-password?tenant=${TENANT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberEmail }),
  });
  assert.equal(res.status, 200);

  const mail = await waitForEmail((e) => e.to === memberEmail);
  assert.ok(mail, 'password reset email was not queued');
  assert.equal(mail.subject, 'Reset your Email Tests password');
  assert.equal(mail.replyTo, REPLY_TO);
  assert.ok(
    mail.text.includes(`http://${TENANT}.localhost:5173/reset?token=`),
    'reset link missing from text body',
  );

  // Unknown email: same 200 (anti-enumeration), no email queued.
  __clearSkippedEmails();
  const unknown = await fetch(
    `${baseUrl}/api/auth/forgot-password?tenant=${TENANT}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `ghost-${randomUUID()}@example.com` }),
    },
  );
  assert.equal(unknown.status, 200);
  const none = await waitForEmail(() => true, { timeout: 300 });
  assert.equal(none, null);
});

test('walk-in payment webhook sends the paid confirmation', { skip }, async () => {
  __clearSkippedEmails();
  const customerEmail = `paid-${randomUUID()}@example.com`;
  const start = iso('13:00');
  const end = iso('14:00');
  const booking_id = (
    await privilegedPool.query(
      `INSERT INTO bookings (
         tenant_id, offering_id, resource_id,
         customer_first_name, customer_last_name, customer_email,
         start_time, end_time, status, hold_expires_at,
         amount_due_cents, credit_cost_charged, payment_status
       ) VALUES ($1, $2, $3, 'Payer', 'Person', $4, $5, $6,
                 'pending_payment', $5, 4500, 0, 'pending')
       RETURNING id`,
      [tenant_id, offering_id, resource_id, customerEmail, start, end],
    )
  ).rows[0].id;

  const res = await signedWebhook({
    id: `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: `cs_${randomUUID().slice(0, 8)}`,
        mode: 'payment',
        amount_total: 4500,
        payment_intent: `pi_${randomUUID().slice(0, 8)}`,
        metadata: {
          courtside_tenant_id: tenant_id,
          courtside_booking_id: booking_id,
        },
      },
    },
  });
  assert.equal(res.status, 200);

  const mail = await waitForEmail((e) => e.to === customerEmail);
  assert.ok(mail, 'paid walk-in confirmation was not queued');
  assert.equal(mail.subject, 'Booking confirmed: Cage 60');
  assert.equal(mail.replyTo, REPLY_TO);
  assert.ok(mail.text.includes('$45.00 (paid)'));
  assert.ok(mail.text.includes('Email Cage'));
});

test('first subscription checkout sends welcome; resubscribe does not', { skip }, async () => {
  __clearSkippedEmails();
  const subscriptionEvent = () => ({
    id: `evt_${randomUUID()}`,
    type: 'checkout.session.completed',
    account: stripe_account_id,
    data: {
      object: {
        id: `cs_${randomUUID().slice(0, 8)}`,
        mode: 'subscription',
        subscription: `sub_${randomUUID().slice(0, 8)}`,
        customer: `cus_${randomUUID().slice(0, 8)}`,
        metadata: {
          courtside_tenant_id: tenant_id,
          courtside_member_id: member_id,
          courtside_plan_id: plan_id,
        },
      },
    },
  });

  const res = await signedWebhook(subscriptionEvent());
  assert.equal(res.status, 200);

  const mail = await waitForEmail((e) => e.to === memberEmail);
  assert.ok(mail, 'welcome email was not queued on first subscription');
  assert.equal(mail.subject, 'Welcome to Email Tests');
  assert.equal(mail.replyTo, REPLY_TO);
  assert.ok(mail.html.includes('Hi Casey,'));

  // A second checkout for the same member (history exists now) must
  // not re-welcome — and the keyless flow still 200s.
  __clearSkippedEmails();
  const again = await signedWebhook(subscriptionEvent());
  assert.equal(again.status, 200);
  const none = await waitForEmail((e) => e.to === memberEmail, { timeout: 300 });
  assert.equal(none, null);
});
