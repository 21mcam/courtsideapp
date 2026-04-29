// Stripe client wrapper.
//
// The whole codebase imports `getStripe()` from here instead of `new
// Stripe(...)` directly. Two reasons:
//
//   1. Single source of API key + version pinning.
//   2. Tests run with `STRIPE_TEST_MODE=1`, which returns a hand-rolled
//      fake that resolves immediately without network. Routes that
//      verify webhook signatures still use the *real* Stripe SDK
//      method `Stripe.webhooks.constructEvent` — it's purely local
//      HMAC math, no API call, so tests sign with a known secret.
//
// As we add slices we extend the fake's surface area. Anything we
// don't fake yet will throw `TypeError` in tests, which is the right
// failure mode — forces us to fake what we use.

import Stripe from 'stripe';

let _stripe = null;

export function getStripe() {
  if (process.env.STRIPE_TEST_MODE === '1') {
    return testFake();
  }
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia',
    });
  }
  return _stripe;
}

// ---------- test fake ----------
//
// In-memory store keyed by acct id. Each call mutates the store so
// tests can drive a "submit details" simulation by calling
// __setAccountState(id, { details_submitted: true, ... }) between
// onboarding-link and connection-status calls.
const _fakeAccounts = new Map();

export function __resetStripeFake() {
  _fakeAccounts.clear();
}

export function __setAccountState(id, patch) {
  const cur = _fakeAccounts.get(id) ?? {};
  _fakeAccounts.set(id, { ...cur, ...patch });
}

function testFake() {
  return {
    accounts: {
      async create(params) {
        const id = `acct_test_${Math.random().toString(36).slice(2, 10)}`;
        const row = {
          id,
          type: params?.type ?? 'standard',
          email: params?.email ?? null,
          country: params?.country ?? 'US',
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
        };
        _fakeAccounts.set(id, row);
        return row;
      },
      async retrieve(id) {
        const row = _fakeAccounts.get(id);
        if (!row) {
          const err = new Error(`No such account: ${id}`);
          err.code = 'resource_missing';
          err.statusCode = 404;
          throw err;
        }
        return row;
      },
    },
    accountLinks: {
      async create(params) {
        const account = params?.account;
        if (!account || !_fakeAccounts.has(account)) {
          const err = new Error('Invalid account for accountLinks.create');
          err.statusCode = 400;
          throw err;
        }
        return {
          url: `https://stripe.example/onboard/${account}?return=${encodeURIComponent(params?.return_url ?? '')}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        };
      },
    },
  };
}
