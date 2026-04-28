// Express app factory. Returns the configured app without binding a
// port — `server.js` handles listen for prod/dev; tests import `app`
// and call their own `app.listen(0, ...)` to bind to a random port.
//
// MOUNT ORDER (critical — read CLAUDE.md gotcha #5 before changing):
//   1. Stripe webhook with express.raw  ← MUST come BEFORE express.json.
//      The webhook handler resolves the tenant from Stripe metadata, NOT
//      from the subdomain (Stripe POSTs from api.stripe.com).
//   2. express.json() for everything else.
//   3. Apex-level routes (/health) — no tenant context.
//   4. /api/* with resolveTenant. Routes that touch the DB additionally
//      use withTenantContext (per-route, not global).
//   5. /api/* fallthrough returns JSON 404 instead of falling into the
//      SPA HTML fallback.
//   6. Static client/dist + SPA fallback (only if a client build exists).

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import healthRouter from './routes/health.js';
import tenantRouter from './routes/tenant.js';
import authRouter from './routes/auth.js';
import meRouter from './routes/me.js';
import platformRouter from './routes/platform.js';
import { resolveTenant } from './middleware/resolveTenant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../client/dist');

export const app = express();

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// 1. Stripe webhook (Phase 5 placeholder).
//    Mount BEFORE express.json with express.raw so the signature can
//    be verified against the exact bytes Stripe sent.

// 2. JSON body parsing for everything below.
app.use(express.json());

// 3. Apex routes (no tenant context required).
app.use('/', healthRouter);

// 4. Platform / super-admin routes — apex hostname, no tenant
//    resolution. Mounted BEFORE the /api resolveTenant middleware
//    so /api/platform/* skips the subdomain lookup. The router
//    has its own catch-all 404 so unmatched /api/platform paths
//    don't fall through.
app.use('/api/platform', platformRouter);

// 5. Tenant-scoped API.
app.use('/api', resolveTenant);
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/tenant', tenantRouter);

// 6. /api/* fallthrough.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 7. Static frontend + SPA fallback.
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler — last.
app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err);
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'internal server error' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});
