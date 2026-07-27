// Pure unit tests for the GA4 module's node-safe helpers
// (client/src/lib/analytics.js): purchase dedupe + event payload
// math. The browser-touching functions (initAnalytics/track) no-op
// outside a window and are exercised by the Playwright e2e instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPurchaseParams,
  markPurchaseFired,
  purchaseKey,
  shouldFirePurchase,
} from '../client/src/lib/analytics.js';

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

test('purchase fires once per booking id', () => {
  const s = fakeStorage();
  assert.equal(shouldFirePurchase(s, 'b1'), true);
  markPurchaseFired(s, 'b1');
  assert.equal(shouldFirePurchase(s, 'b1'), false);
  // Different booking → independent.
  assert.equal(shouldFirePurchase(s, 'b2'), true);
});

test('storage failure degrades to firing (never lose the conversion)', () => {
  const broken = {
    getItem: () => {
      throw new Error('quota');
    },
    setItem: () => {
      throw new Error('quota');
    },
  };
  assert.equal(shouldFirePurchase(broken, 'b1'), true);
  // markPurchaseFired must not throw.
  markPurchaseFired(broken, 'b1');
});

test('purchaseKey namespaces by booking id', () => {
  assert.equal(purchaseKey('abc'), 'courtside_ga4_purchase_abc');
});

test('buildPurchaseParams: cents → decimal dollars, GA4 shape', () => {
  const p = buildPurchaseParams({
    id: 'bk-1',
    offering_name: '60-min Cage',
    amount_due_cents: 6000,
  });
  assert.deepEqual(p, {
    transaction_id: 'bk-1',
    value: 60,
    currency: 'USD',
    items: [{ item_name: '60-min Cage', price: 60, quantity: 1 }],
  });
  // Missing amounts don't NaN the payload.
  assert.equal(buildPurchaseParams({ id: 'x' }).value, 0);
});
