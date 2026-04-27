# Railway setup

End-to-end runbook for deploying this app to Railway. Do this once;
auto-deploy from `main` handles every push after that.

## Prerequisites

- Railway account (any plan; $5/mo Hobby is fine to start)
- GitHub repo for this codebase, with `main` as the default branch
- Supabase already set up ([SUPABASE_SETUP.md](SUPABASE_SETUP.md))
- A domain you control + access to its DNS records
- (Phase 5+) Stripe account with a Connect platform configured

## 1. Create the Railway service

1. https://railway.app → **New project** → **Deploy from GitHub repo**
2. Pick the repo, pick the `main` branch
3. Railway auto-detects Node and runs `npm install` + `npm start`.
   That's already the right thing — `package.json` has:
   - `start`: `node src/server.js`
   - `build`: `cd client && npm install && npm run build` (Railway
     runs this automatically as part of `npm install`'s post-install
     hook on most Node templates; if it doesn't, add a custom Build
     Command in Railway settings: `npm install && npm run build`)
4. First deploy will fail until env vars are set — that's expected.

## 2. Set environment variables

Railway dashboard → your service → **Variables** → add each:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The runtime pooler URL from [SUPABASE_SETUP.md](SUPABASE_SETUP.md) step 4. Same string as your local `.env` — `app_runtime` role, hex password, transaction pooler host, port 6543. |
| `JWT_SECRET` | A long random string. Generate locally with `openssl rand -hex 64` (longer than the DB password for extra entropy). Different value per environment (don't reuse dev's secret in prod). |
| `APP_HOSTNAME` | Your apex hostname, e.g. `app.yourdomain.com`. The subdomain middleware strips this off `req.hostname` to extract the tenant. |
| `NODE_ENV` | `production` |
| `RESEND_API_KEY` | (Phase 3+) From Resend dashboard. Leave blank in Phase 0. |
| `STRIPE_SECRET_KEY` | (Phase 3+) Live key from Stripe dashboard. Test key is fine until launch. |
| `STRIPE_WEBHOOK_SECRET` | (Phase 5+) Provided by Stripe when you create the webhook endpoint. |
| `STRIPE_CONNECT_CLIENT_ID` | (Phase 3+) From Stripe Connect settings. |

**Do NOT set `VITE_API_URL`.** The frontend bundle uses same-origin
relative URLs in production — both backend and frontend are served
by the same Express process. Setting `VITE_API_URL` would point the
bundle at a different origin and break things. (CLAUDE.md gotcha #7.)

## 3. Domain setup (wildcard subdomain)

Tenants are routed by subdomain — `momentum.app.yourdomain.com`,
`anothertenant.app.yourdomain.com`, etc. You need a wildcard DNS
record so all subdomains route to Railway.

1. Railway dashboard → your service → **Settings** → **Domains** →
   **Custom domain**
2. Add **two** entries:
   - `app.yourdomain.com` (the apex routing target — also where
     `/health` lives)
   - `*.app.yourdomain.com` (the wildcard for tenant subdomains)
3. Railway gives you a `CNAME` target for each (something like
   `app-name.up.railway.app`).
4. In your DNS provider (Cloudflare, Namecheap, etc.), add:
   - `CNAME app → app-name.up.railway.app`
   - `CNAME *.app → app-name.up.railway.app`
5. Wait for DNS propagation (usually <5 min, sometimes longer).
6. Railway provisions Let's Encrypt TLS for both — wait for the green
   check next to each domain.

## 4. Health check

Railway → service → **Settings** → **Healthcheck path**: `/health`.
Railway will hit this on each deploy and refuse to swap traffic if it
fails. Our `/health` route returns 503 if the DB is unreachable, so
this catches "deploy succeeded but Supabase is down" failures
automatically.

## 5. Verify the first deploy

After env vars and domains are set, redeploy (Railway → service →
**Deployments** → **Redeploy**). Then:

```bash
curl https://app.yourdomain.com/health
# expected: {"ok":true,"db":"ok","version":"0.0.0"}

curl https://momentum.app.yourdomain.com/api/tenant
# expected: tenant JSON, assuming you seeded `momentum` per
# SUPABASE_SETUP.md step 5
```

If you get the tenant JSON, the full chain is live: DNS → Railway
edge → Express → resolveTenant → Supabase pooler → app_runtime.

## Auto-deploy

Railway watches `main` and auto-deploys on every push. **NEVER
push directly to `main` without testing first** — there's no staging
environment in Phase 0. Use feature branches + PRs; CI gates the
merge ([CI_SETUP.md](CI_SETUP.md)). Once we have branch protection
configured (post-Phase-0), CI will be a hard gate.

## When you rotate a secret

1. Generate the new value (`openssl rand -hex …` for passwords/keys,
   Stripe dashboard for Stripe keys)
2. Set the new value in `.env` locally and verify it works
3. Update Railway → Variables → save
4. Railway auto-redeploys with the new value
5. (Critical for `app_runtime` password) Update Supabase via
   `ALTER ROLE app_runtime PASSWORD '...'` BEFORE updating Railway —
   otherwise Railway redeploys with a new password the DB doesn't
   know about and `/health` 503s

## Logs and debugging

Railway → service → **Deployments** → click a deploy → **View logs**.
Backend `console.log` / `console.error` show up here. Webhook bodies
and tenant resolution errors are loggable points if something looks
off.
