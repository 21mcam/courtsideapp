# Live Supabase — applied migrations record

Migrations are applied to the live Supabase project **by hand** via
the SQL editor (CLAUDE.md gotcha #1). Nothing runs on deploy. This
file is the repo's only record of how far the live DB has been
brought forward — update it every time you apply a migration.

| Environment | Applied through | Date | Notes |
|---|---|---|---|
| Production (live Supabase) | **032** | 2026-10-08 | 001–019 during initial phases; 020–025 at PR #51 merge (025 = platform billing); 026–029 with walk-in checkout v2 (PR #53, live 2026-07-27); 030 theme; 031 booking import provenance applied by hand 2026-08-08; 032 platform console (PR #57) applied by hand 2026-10-08. |

To verify what's actually live, run this in the SQL editor and
compare against `ls db/migrations/`:

```sql
-- spot-check the newest migration's artifacts:
-- 032 → platform console tables (expect 2 rows)
SELECT table_name FROM information_schema.tables
 WHERE table_name IN ('platform_admins', 'platform_audit_log');
```

pg_cron status: **not enabled**. The Node scheduler in
`src/server.js` (on unless `SCHEDULER_ENABLED=false`) is the only
thing running weekly credit resets, cleanup sweeps, and class-horizon
extension. If you enable pg_cron later, re-run migration 022's `DO`
block so the cron job registers.
