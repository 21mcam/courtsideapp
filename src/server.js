// Express entry. Boots the API + serves the built frontend.
//
// MOUNT ORDER (critical — read CLAUDE.md gotcha #5 before changing):
//   1. Stripe webhook with express.raw  ← MUST come BEFORE express.json.
//      Reversing the order breaks signature verification silently. The
//      webhook handler resolves the tenant from Stripe metadata, NOT
//      from the subdomain (Stripe POSTs from api.stripe.com).
//   2. express.json() for everything else.
//   3. Apex-level routes (/health) — no tenant context.
//   4. /api/* with resolveTenant middleware. Routes that touch the DB
//      additionally use withTenantContext (per-route, not global, to
//      avoid spending a connection on routes like /api/tenant that
//      have no DB work).
//   5. /api/* fallthrough returns JSON 404 instead of falling into the
//      SPA HTML fallback below.
//   6. Static client/dist + SPA fallback (only if a client build
//      exists — in dev, Vite serves the frontend on :5173 and proxies
//      /api here, so this branch never fires).

import 'dotenv/config';

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import healthRouter from './routes/health.js';
import tenantRouter from './routes/tenant.js';
import { resolveTenant } from './middleware/resolveTenant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../client/dist');

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;

// In production we sit behind Railway's reverse proxy. trust proxy = 1
// makes req.hostname / req.protocol / req.ip reflect the original
// client request rather than Railway's internal hop.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// 1. Stripe webhook (Phase 5 placeholder).
//    Mount BEFORE express.json with express.raw so the signature can
//    be verified against the exact bytes Stripe sent.
//
//    Example shape (uncomment and wire up in Phase 5):
//      app.post(
//        '/webhooks/stripe',
//        express.raw({ type: 'application/json' }),
//        stripeWebhookHandler,
//      );

// 2. JSON body parsing for everything below.
app.use(express.json());

// 3. Apex routes (no tenant context required).
app.use('/', healthRouter);

// 4. Tenant-scoped API.
app.use('/api', resolveTenant);
app.use('/api/tenant', tenantRouter);

// 5. Anything under /api that didn't match returns JSON 404 (not the
//    SPA HTML fallback below).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 6. Static frontend + SPA fallback. Only mount when a build exists,
//    so `npm run dev` (no client/dist yet) doesn't 500 on every page
//    load.
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

app.listen(port, () => {
  console.log(`courtside listening on :${port}`);
});
