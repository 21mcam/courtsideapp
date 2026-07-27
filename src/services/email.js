// Transactional email service — Resend-backed, dev/test safe.
//
// Layers:
//   1. Pure template renderers (render*Email) — no I/O, unit-testable.
//      They take plain values (tenant name, accent key, times + the
//      tenant's IANA timezone) and return { subject, html, text }.
//   2. sendEmail — the only Resend touchpoint. Lazy client from
//      RESEND_API_KEY; when the key is unset it logs a one-line skip
//      (with the recipient redacted) and no-ops, so dev machines and
//      the test suite never hit the network. Skipped sends are also
//      recorded in an in-memory log so integration tests can assert
//      "an email would have gone out" without a fake SMTP layer.
//   3. High-level senders (sendBookingConfirmation, ...) — take a
//      req.tenant-shaped object (name, subdomain, timezone,
//      theme_accent, reply_to_email — all on tenant_lookup as of
//      migration 020) plus the event details, render, and send.
//
// Sender identity (CLAUDE.md): "from" is platform-owned
// (EMAIL_FROM env, default 'Courtside <noreply@courtside.app>')
// until per-tenant custom domains land post-v1; reply-to is the
// tenant's reply_to_email when set.
//
// Callers fire-and-forget AFTER their DB transaction commits —
// never inside it (CLAUDE.md: no external calls inside a tenant
// transaction). Request handlers hook res.on('finish'), which fires
// after withTenantContext's COMMIT; webhook handlers call directly
// after their explicit COMMIT.
// TODO: outbox — replace fire-and-forget with an outbox drain for
// reliability-critical sends (CLAUDE.md, Phase 3+).

import { Resend } from 'resend';
import { tenantUrl, buildBookingUrl, buildManageUrl } from '../lib/publicUrl.js';

let _resend = null;

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// ---------- shared helpers (pure) ----------

// Accent key → hex. Mirrors the 600-weight swatches in
// client/src/theme.js ACCENTS (and the CHECK on tenants.theme_accent).
const ACCENT_HEX = {
  indigo: '#4f46e5',
  sky: '#0284c7',
  emerald: '#059669',
  violet: '#7c3aed',
  rose: '#e11d48',
  slate: '#0f172a',
  court: '#16a34a',
};

export function accentHex(key) {
  return ACCENT_HEX[key] ?? ACCENT_HEX.indigo;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Format an instant in the tenant's timezone (gotcha #6: booking
// times are always presented in tenant-local time, never server
// time). Example: "Mon, Mar 1, 2027, 10:00 AM EST".
export function formatInTenantTz(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

export function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

// Tenant subdomain URLs moved to lib/publicUrl.js once the admin UI
// needed them too (a route shouldn't import the email service to build
// a link). Re-exported here so the existing callers — and the email
// tests that have covered tenantUrl since Phase 1 slice 5 — keep
// importing from the same place.
export { tenantUrl, buildBookingUrl, buildManageUrl };

// Redact a recipient for log lines: keep the first character and the
// domain. 'member@example.com' → 'm***@example.com'.
export function redactEmail(email) {
  const s = String(email ?? '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return `${s[0]}***${s.slice(at)}`;
}

// ---------- layout (pure) ----------

// Minimal branded shell: tenant name on the accent bar, white card,
// muted footer. Inline styles only — email clients strip <style>
// blocks, and the CSP-free world of email demands self-containment
// anyway. Table-based for Outlook compatibility.
function renderLayout({ tenantName, accent, bodyHtml }) {
  const hex = accentHex(accent);
  const safeTenant = escapeHtml(tenantName);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f1f5f9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:94%;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <tr>
              <td style="background-color:${hex};padding:20px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;">${safeTenant}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px;color:#0f172a;font-size:15px;line-height:1.6;">
${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
                Sent by ${safeTenant} via Courtside.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function detailRowsHtml(rows) {
  const tr = rows
    .filter(([, v]) => v != null && v !== '')
    .map(
      ([label, value]) =>
        `                  <tr>
                    <td style="padding:4px 16px 4px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
                    <td style="padding:4px 0;color:#0f172a;font-weight:600;">${escapeHtml(value)}</td>
                  </tr>`,
    )
    .join('\n');
  return `                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;font-size:14px;">
${tr}
                </table>`;
}

function detailRowsText(rows) {
  return rows
    .filter(([, v]) => v != null && v !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

// One payment line for a booking, whichever shape applies:
//   * creditCost > 0        → "3 credits"
//   * amountPaidCents > 0   → "$45.00 (paid)"
//   * amountDueCents > 0    → "$45.00 (due at the facility)"
function paymentLine({ creditCost, amountPaidCents, amountDueCents }) {
  if (creditCost > 0) {
    return `${creditCost} credit${creditCost === 1 ? '' : 's'}`;
  }
  if (amountPaidCents > 0) {
    return `${formatMoney(amountPaidCents)} (paid)`;
  }
  if (amountDueCents > 0) {
    return `${formatMoney(amountDueCents)} (due at the facility)`;
  }
  return null;
}

// ---------- template renderers (pure) ----------

export function renderBookingConfirmationEmail({
  tenantName,
  accent,
  timezone,
  recipientName,
  offeringName,
  resourceName,
  startTime,
  creditCost = null,
  amountPaidCents = null,
  amountDueCents = null,
  manageUrl = null,
  customerNote = null,
}) {
  const when = formatInTenantTz(startTime, timezone);
  const payment = paymentLine({ creditCost, amountPaidCents, amountDueCents });
  const rows = [
    ['What', offeringName],
    ['Where', resourceName],
    ['When', when],
    ['Payment', payment],
    ['Your note', customerNote],
  ];
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const subject = `Booking confirmed: ${offeringName}`;
  const hex = accentHex(accent);
  // Walk-in confirmations carry the no-login manage link; member
  // confirmations (no manageUrl) keep the reply-to footer.
  const footerHtml = manageUrl
    ? `                <p style="margin:0 0 16px;">
                  <a href="${escapeHtml(manageUrl)}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">Reschedule or view your booking</a>
                </p>
                <p style="margin:0;color:#64748b;font-size:13px;">No account needed — that link is your booking. Questions? Reply to this email.</p>`
    : `                <p style="margin:0;color:#64748b;font-size:13px;">Need to change something? Reply to this email or contact the facility.</p>`;
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Booking confirmed</p>
                <p style="margin:0;">${escapeHtml(greeting)} your booking at ${escapeHtml(tenantName)} is confirmed.</p>
${detailRowsHtml(rows)}
${footerHtml}`,
  });
  const text = [
    'Booking confirmed',
    '',
    `${greeting} your booking at ${tenantName} is confirmed.`,
    '',
    detailRowsText(rows),
    '',
    ...(manageUrl
      ? [
          'Reschedule or view your booking (no account needed):',
          manageUrl,
          '',
          'Questions? Reply to this email.',
        ]
      : ['Need to change something? Reply to this email or contact the facility.']),
  ].join('\n');
  return { subject, html, text };
}

export function renderBookingRescheduleEmail({
  tenantName,
  accent,
  timezone,
  recipientName,
  offeringName,
  resourceName,
  previousStartTime,
  startTime,
  manageUrl = null,
}) {
  const wasWhen = formatInTenantTz(previousStartTime, timezone);
  const nowWhen = formatInTenantTz(startTime, timezone);
  const rows = [
    ['What', offeringName],
    ['Where', resourceName],
    ['New time', nowWhen],
    ['Was', wasWhen],
  ];
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const subject = `Booking moved: ${offeringName}`;
  const hex = accentHex(accent);
  const manageHtml = manageUrl
    ? `                <p style="margin:0 0 16px;">
                  <a href="${escapeHtml(manageUrl)}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">View or reschedule again</a>
                </p>
`
    : '';
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Booking moved</p>
                <p style="margin:0;">${escapeHtml(greeting)} your booking at ${escapeHtml(tenantName)} has a new time.</p>
${detailRowsHtml(rows)}
${manageHtml}                <p style="margin:0;color:#64748b;font-size:13px;">Questions? Reply to this email or contact the facility.</p>`,
  });
  const text = [
    'Booking moved',
    '',
    `${greeting} your booking at ${tenantName} has a new time.`,
    '',
    detailRowsText(rows),
    '',
    ...(manageUrl ? ['View or reschedule again:', manageUrl, ''] : []),
    'Questions? Reply to this email or contact the facility.',
  ].join('\n');
  return { subject, html, text };
}

export function renderBookingCancellationEmail({
  tenantName,
  accent,
  timezone,
  recipientName,
  offeringName,
  resourceName,
  startTime,
  refundCredits = 0,
}) {
  const when = formatInTenantTz(startTime, timezone);
  const rows = [
    ['What', offeringName],
    ['Where', resourceName],
    ['When', when],
  ];
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const refundNote =
    refundCredits > 0
      ? `${refundCredits} credit${refundCredits === 1 ? '' : 's'} ${refundCredits === 1 ? 'has' : 'have'} been refunded to your balance.`
      : null;
  const subject = `Booking cancelled: ${offeringName}`;
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Booking cancelled</p>
                <p style="margin:0;">${escapeHtml(greeting)} this booking at ${escapeHtml(tenantName)} has been cancelled.</p>
${detailRowsHtml(rows)}
${refundNote ? `                <p style="margin:0 0 8px;font-weight:600;">${escapeHtml(refundNote)}</p>\n` : ''}                <p style="margin:0;color:#64748b;font-size:13px;">Questions? Reply to this email or contact the facility.</p>`,
  });
  const text = [
    'Booking cancelled',
    '',
    `${greeting} this booking at ${tenantName} has been cancelled.`,
    '',
    detailRowsText(rows),
    ...(refundNote ? ['', refundNote] : []),
    '',
    'Questions? Reply to this email or contact the facility.',
  ].join('\n');
  return { subject, html, text };
}

export function renderPasswordResetEmail({ tenantName, accent, resetUrl }) {
  const subject = `Reset your ${tenantName} password`;
  const safeUrl = escapeHtml(resetUrl);
  const hex = accentHex(accent);
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Reset your password</p>
                <p style="margin:0 0 16px;">We received a request to reset the password for your ${escapeHtml(tenantName)} account. The link below expires in 1 hour.</p>
                <p style="margin:0 0 16px;">
                  <a href="${safeUrl}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">Reset password</a>
                </p>
                <p style="margin:0 0 16px;color:#64748b;font-size:13px;">Or paste this link into your browser:<br /><a href="${safeUrl}" style="color:${hex};word-break:break-all;">${safeUrl}</a></p>
                <p style="margin:0;color:#64748b;font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
  });
  const text = [
    'Reset your password',
    '',
    `We received a request to reset the password for your ${tenantName} account.`,
    'The link below expires in 1 hour.',
    '',
    resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email — your password won't change.",
  ].join('\n');
  return { subject, html, text };
}

export function renderWelcomeEmail({ tenantName, accent, firstName, loginUrl }) {
  const subject = `Welcome to ${tenantName}`;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const hex = accentHex(accent);
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Welcome to ${escapeHtml(tenantName)}</p>
                <p style="margin:0 0 16px;">${escapeHtml(greeting)} your membership is set up. Sign in to see your credits, book sessions, and manage your account.</p>
                <p style="margin:0 0 16px;">
                  <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">Go to ${escapeHtml(tenantName)}</a>
                </p>
                <p style="margin:0;color:#64748b;font-size:13px;">Questions? Reply to this email or contact the facility.</p>`,
  });
  const text = [
    `Welcome to ${tenantName}`,
    '',
    `${greeting} your membership is set up. Sign in to see your credits, book sessions, and manage your account.`,
    '',
    loginUrl,
    '',
    'Questions? Reply to this email or contact the facility.',
  ].join('\n');
  return { subject, html, text };
}

// Staff invite. Two variants share the template:
//   * isNewUser: the invitee has no password yet — the button is a
//     set-password link (password-reset-token infrastructure, 7-day
//     expiry).
//   * existing user: they already log in here (e.g. a member being
//     promoted to staff) — the button is a plain sign-in link.
export function renderAdminInviteEmail({
  tenantName,
  accent,
  firstName,
  actionUrl,
  isNewUser,
}) {
  const subject = `You've been invited to help manage ${tenantName}`;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const hex = accentHex(accent);
  const safeUrl = escapeHtml(actionUrl);
  const lead = isNewUser
    ? 'Set a password to activate your account. The link below expires in 7 days.'
    : 'Sign in with your existing password to get started.';
  const buttonLabel = isNewUser ? 'Set your password' : 'Sign in';
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">You're invited</p>
                <p style="margin:0 0 16px;">${escapeHtml(greeting)} you've been invited to help manage ${escapeHtml(tenantName)} as a staff member. ${escapeHtml(lead)}</p>
                <p style="margin:0 0 16px;">
                  <a href="${safeUrl}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">${escapeHtml(buttonLabel)}</a>
                </p>
                <p style="margin:0 0 16px;color:#64748b;font-size:13px;">Or paste this link into your browser:<br /><a href="${safeUrl}" style="color:${hex};word-break:break-all;">${safeUrl}</a></p>
                <p style="margin:0;color:#64748b;font-size:13px;">If you weren't expecting this invitation, you can safely ignore this email.</p>`,
  });
  const text = [
    "You're invited",
    '',
    `${greeting} you've been invited to help manage ${tenantName} as a staff member.`,
    lead,
    '',
    actionUrl,
    '',
    "If you weren't expecting this invitation, you can safely ignore this email.",
  ].join('\n');
  return { subject, html, text };
}

// Purchase receipt for a one-time credit pack (credit-packs slice).
// Sent by the Stripe webhook after the grant commits. Purchased
// credits roll over week to week (unlike the weekly allotment), and
// the copy says so — it's the pack's whole selling point.
export function renderPackReceiptEmail({
  tenantName,
  accent,
  firstName,
  packName,
  credits,
  amountPaidCents,
  balanceAfter = null,
}) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const creditsLabel = `${credits} credit${credits === 1 ? '' : 's'}`;
  const rows = [
    ['Pack', packName],
    ['Credits added', creditsLabel],
    ['Amount paid', formatMoney(amountPaidCents)],
    [
      'New balance',
      balanceAfter == null
        ? null
        : `${balanceAfter} credit${balanceAfter === 1 ? '' : 's'}`,
    ],
  ];
  const subject = `Receipt: ${packName}`;
  const rolloverNote =
    'Purchased credits roll over week to week until you use them.';
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">Thanks for your purchase</p>
                <p style="margin:0;">${escapeHtml(greeting)} your credits have been added to your ${escapeHtml(tenantName)} account.</p>
${detailRowsHtml(rows)}
                <p style="margin:0 0 8px;">${escapeHtml(rolloverNote)}</p>
                <p style="margin:0;color:#64748b;font-size:13px;">Questions? Reply to this email or contact the facility.</p>`,
  });
  const text = [
    'Thanks for your purchase',
    '',
    `${greeting} your credits have been added to your ${tenantName} account.`,
    '',
    detailRowsText(rows),
    '',
    rolloverNote,
    '',
    'Questions? Reply to this email or contact the facility.',
  ].join('\n');
  return { subject, html, text };
}

// Platform billing: the tenant's own Courtside subscription payment
// failed. Addressed to the facility OPERATOR (owner admin), not their
// members — so the CTA points at the admin billing settings page and
// the footer's "via Courtside" framing does the platform-speaking.
export function renderPlatformPaymentFailedEmail({
  tenantName,
  accent,
  billingUrl,
}) {
  const subject = `Action needed: Courtside payment failed for ${tenantName}`;
  const hex = accentHex(accent);
  const html = renderLayout({
    tenantName,
    accent,
    bodyHtml: `                <p style="margin:0 0 8px;font-size:17px;font-weight:700;">We couldn't process your Courtside payment</p>
                <p style="margin:0 0 16px;">The latest subscription payment for ${escapeHtml(tenantName)}'s Courtside plan didn't go through. Stripe will retry automatically over the next few days, and your booking site stays online in the meantime.</p>
                <p style="margin:0 0 16px;">To fix it now, update your payment method:</p>
                <p style="margin:0 0 16px;">
                  <a href="${escapeHtml(billingUrl)}" style="display:inline-block;background-color:${hex};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;">Update payment method</a>
                </p>
                <p style="margin:0;color:#64748b;font-size:13px;">If the retries keep failing, your Courtside subscription will be cancelled and your booking site paused until billing is restored.</p>`,
  });
  const text = [
    "We couldn't process your Courtside payment",
    '',
    `The latest subscription payment for ${tenantName}'s Courtside plan didn't go through.`,
    'Stripe will retry automatically over the next few days, and your booking site stays online in the meantime.',
    '',
    `Update your payment method: ${billingUrl}`,
    '',
    'If the retries keep failing, your Courtside subscription will be cancelled and your booking site paused until billing is restored.',
  ].join('\n');
  return { subject, html, text };
}

// ---------- send layer ----------

// In-memory record of sends skipped because RESEND_API_KEY is unset.
// Lets integration tests (which always run keyless) assert that a
// flow queued the right email without any network fake. Ring-buffered
// so a long-lived keyless dev server doesn't grow unbounded.
const _skippedEmails = [];
const SKIPPED_LOG_CAP = 200;

export function __getSkippedEmails() {
  return [..._skippedEmails];
}

export function __clearSkippedEmails() {
  _skippedEmails.length = 0;
}

export async function sendEmail({ to, subject, html, text, replyTo }) {
  const from = process.env.EMAIL_FROM || 'Courtside <noreply@courtside.app>';
  const resend = getResend();
  if (!resend) {
    console.log(
      `[email] skipped (no RESEND_API_KEY): ${subject} to ${redactEmail(to)}`,
    );
    _skippedEmails.push({ to, subject, html, text, replyTo: replyTo ?? null });
    if (_skippedEmails.length > SKIPPED_LOG_CAP) _skippedEmails.shift();
    return { skipped: true };
  }

  const payload = { from, to, subject, html, text };
  if (replyTo) payload.replyTo = replyTo;
  const { data, error } = await resend.emails.send(payload);
  if (error) {
    throw new Error(`resend: ${error.message ?? JSON.stringify(error)}`);
  }
  return { id: data?.id ?? null };
}

// ---------- high-level senders ----------
//
// `tenant` is req.tenant-shaped (tenant_lookup row): name, subdomain,
// timezone, theme_accent, reply_to_email. theme_accent /
// reply_to_email may be missing until migrations 019/020 are applied
// to the live DB — both degrade gracefully (indigo accent, no
// reply-to).

function tenantSendFields(tenant) {
  return {
    tenantName: tenant.name,
    accent: tenant.theme_accent,
    replyTo: tenant.reply_to_email ?? undefined,
  };
}

export function sendBookingConfirmation({
  tenant,
  to,
  recipientName,
  offeringName,
  resourceName,
  startTime,
  creditCost = null,
  amountPaidCents = null,
  amountDueCents = null,
  manageUrl = null,
  customerNote = null,
}) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderBookingConfirmationEmail({
    tenantName,
    accent,
    timezone: tenant.timezone,
    recipientName,
    offeringName,
    resourceName,
    startTime,
    creditCost,
    amountPaidCents,
    amountDueCents,
    manageUrl,
    customerNote,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendBookingReschedule({
  tenant,
  to,
  recipientName,
  offeringName,
  resourceName,
  previousStartTime,
  startTime,
  manageUrl = null,
}) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderBookingRescheduleEmail({
    tenantName,
    accent,
    timezone: tenant.timezone,
    recipientName,
    offeringName,
    resourceName,
    previousStartTime,
    startTime,
    manageUrl,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendBookingCancellation({
  tenant,
  to,
  recipientName,
  offeringName,
  resourceName,
  startTime,
  refundCredits = 0,
}) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderBookingCancellationEmail({
    tenantName,
    accent,
    timezone: tenant.timezone,
    recipientName,
    offeringName,
    resourceName,
    startTime,
    refundCredits,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendPasswordReset({ tenant, to, resetUrl }) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderPasswordResetEmail({
    tenantName,
    accent,
    resetUrl,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendAdminInvite({ tenant, to, firstName, actionUrl, isNewUser }) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderAdminInviteEmail({
    tenantName,
    accent,
    firstName,
    actionUrl,
    isNewUser,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendPackReceipt({
  tenant,
  to,
  firstName,
  packName,
  credits,
  amountPaidCents,
  balanceAfter = null,
}) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderPackReceiptEmail({
    tenantName,
    accent,
    firstName,
    packName,
    credits,
    amountPaidCents,
    balanceAfter,
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

export function sendMemberWelcome({ tenant, to, firstName }) {
  const { tenantName, accent, replyTo } = tenantSendFields(tenant);
  const { subject, html, text } = renderWelcomeEmail({
    tenantName,
    accent,
    firstName,
    loginUrl: tenantUrl(tenant.subdomain, '/login'),
  });
  return sendEmail({ to, subject, html, text, replyTo });
}

// Platform → operator. Deliberately NO replyTo: tenant.reply_to_email
// is the tenant's member-facing address; this email is from the
// platform to the tenant, so replies go to the platform default.
export function sendPlatformPaymentFailed({ tenant, to }) {
  const { subject, html, text } = renderPlatformPaymentFailedEmail({
    tenantName: tenant.name,
    accent: tenant.theme_accent,
    billingUrl: tenantUrl(tenant.subdomain, '/admin/settings/billing'),
  });
  return sendEmail({ to, subject, html, text });
}
