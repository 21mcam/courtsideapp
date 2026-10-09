# Platform console (super admin)

The platform operator's own back office, at `https://admin.<APP_HOSTNAME>`
(e.g. `admin.app.craigave.org`). `admin` is a reserved subdomain no tenant
can claim, and the existing `*.<APP_HOSTNAME>` wildcard DNS + Railway
custom domain already cover it — no infra changes.

What it does (v1):

- **Facilities** — every tenant with platform billing state, Stripe
  Connect status, members, bookings, last activity; "need attention"
  count up top.
- **Facility detail** — "ready to take bookings?" checklist, billing,
  activity, staff, profile, recent platform actions.
- **New facility** — creates the tenant + owner; the owner is emailed a
  set-password link (you never handle their password).
- **Billing** — set trial end, make free, suspend / unsuspend.
- **View as owner** — opens the facility's admin as its owner,
  **read-only**, for one hour, with a banner. The API refuses every
  non-GET request and the DB transaction runs `READ ONLY`.
- **Visibility** (migration 035) — per facility: **Private** (coming-soon
  page for visitors, no online bookings or sign-ups, staff can preview,
  hidden from search engines), **Unlisted** (works, hidden from search),
  **Public**. Facilities created here start Private.
- **Audit log** — sign-ins (and failures), facility views, view-as-owner
  sessions, tenant creation, billing changes.

## One-time setup

1. Apply `db/migrations/032_platform_admin.sql` in the Supabase SQL editor
   (then update [MIGRATIONS_APPLIED.md](MIGRATIONS_APPLIED.md)).
2. Create your login — locally, no DB credentials needed:

   ```bash
   node scripts/platform/create-admin.js you@example.com "Your Name"
   ```

   It prompts for a password (12+ chars) and prints:
   - an `INSERT` to paste into the Supabase SQL editor, and
   - a TOTP setup key for your authenticator app (1Password, Google
     Authenticator, …: "enter setup key", time-based, 6 digits).

   Don't save the output anywhere — the setup key is a credential.
3. Sign in at `https://admin.<APP_HOSTNAME>` with email, password and the
   current 6-digit code.

Lost your phone or password? Re-run the script for the same email and
paste the new statement — it replaces both. To lock someone out
immediately: `UPDATE platform_admins SET active = false WHERE email = '…';`
(live sessions die on their next request).

## Security model

- `platform_admins` / `platform_audit_log` have no grants for
  `app_runtime`; all access is through `SECURITY DEFINER` functions
  that check the acting admin is active. Cross-tenant reads
  (`platform_list_tenants`, `platform_get_tenant`) are the explicit,
  audited escape hatches CLAUDE.md calls for.
- Sessions: JWT `aud=platform`, 12 h, re-checked against the DB on
  every request. Tenant routes reject any token with an audience, and
  the console rejects tenant tokens.
- TOTP codes are single-use (`totp_last_step`). Failed sign-ins are
  throttled (5 per 15 min per IP and per email) and audited.
- View-as-owner: a 60-second handoff token travels in the URL
  *fragment* (never sent to a server), is bound to one tenant, and is
  exchanged for the 1-hour read-only session. Both steps are audited;
  the session can't be opened if the audit write fails.

## Legacy API token

`X-Super-Admin-Token` (`SUPER_ADMIN_TOKEN`) still works for
`POST /api/platform/signup-tenant` and
`PATCH /api/platform/tenants/:subdomain/billing`, audited as "API
token". Everything else needs a console session. Once you're using the
console, consider unsetting `SUPER_ADMIN_TOKEN` on Railway — it's an
unattributed shared secret.

## Local dev

`http://admin.localhost:5173` (Vite) with the backend on :3000. Tenant
handoffs go to `http://<subdomain>.localhost:5173`.

## Not yet (next slices)

- View-as-owner with write access (deliberately read-only for now).
- Platform health panel: scheduler heartbeat, Stripe webhook and email
  failures (email failures are console-only today — needs a log table).
- Resend an owner's setup email; deactivate/delete a tenant.
- Multiple platform admins / roles (table supports it; no UI).
