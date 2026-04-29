-- Migration 016 — stripe_webhook_events dedup table
--
-- Stripe occasionally redelivers webhooks (network blip, our 5xx,
-- or just at-least-once design). Some handlers are idempotent
-- structurally — account.updated just sets current state, which
-- doesn't drift on duplicate delivery. Others aren't — granting
-- weekly credits twice on a duplicate invoice.payment_succeeded
-- would silently inflate balances.
--
-- This table is the dedup primitive: every webhook delivery INSERTs
-- the event_id with ON CONFLICT DO NOTHING. If 0 rows return, we've
-- already processed this delivery and skip the handler. Otherwise
-- we proceed.
--
-- No tenant_id, no RLS — the runtime needs to write here BEFORE it
-- knows which tenant the event belongs to (in fact, before we trust
-- the event payload at all). Default GRANTs from migration 011
-- give app_runtime SELECT/INSERT/UPDATE/DELETE.
--
-- account_id is denormalized for debugging — when an event handler
-- fails, you can SELECT * FROM stripe_webhook_events WHERE
-- account_id = '...' and see the recent stream without joining.
--
-- Apply: psql -v ON_ERROR_STOP=1 -f 016_stripe_webhook_events.sql
-- Depends on: 011 (app_runtime role exists with default grants).

CREATE TABLE stripe_webhook_events (
  event_id        text PRIMARY KEY,
  event_type      text NOT NULL,
  account_id      text,
  received_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stripe_webhook_events_account_idx
  ON stripe_webhook_events (account_id, received_at DESC)
  WHERE account_id IS NOT NULL;

COMMENT ON TABLE stripe_webhook_events IS
  'Webhook idempotency log. INSERT ON CONFLICT DO NOTHING per event '
  'delivery; 0 rows back means duplicate, skip the handler.';

-- Verify (commented for live apply):
--
--   INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ('evt_test', 'foo');
--   INSERT INTO stripe_webhook_events (event_id, event_type) VALUES ('evt_test', 'foo')
--   ON CONFLICT DO NOTHING RETURNING event_id;
--   -- expect: 0 rows
--   DELETE FROM stripe_webhook_events WHERE event_id = 'evt_test';
