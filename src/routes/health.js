// Apex-level health check. Not tenant-scoped — load balancers, uptime
// monitors, and Railway's own health probe hit this without a tenant
// hostname. Returns service liveness + DB reachability.

import express from 'express';
import { pool } from '../db/pool.js';

const router = express.Router();

router.get('/health', async (_req, res) => {
  try {
    const result = await pool.query('SELECT 1 AS ok');
    const db = result.rows[0]?.ok === 1 ? 'ok' : 'unexpected';
    res.json({ ok: true, db, version: '0.0.0' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'error', error: err.message });
  }
});

export default router;
