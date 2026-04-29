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
// In-memory stores keyed by acct id (and per-account for products /
// prices to mirror Connect's per-account isolation). Each call mutates
// the store so tests can drive simulations:
//   * __setAccountState(id, { details_submitted: true, ... })
//   * Inspect created products/prices via __getProductsForAccount(acct).
const _fakeAccounts = new Map();
const _fakeProducts = new Map();        // `${acct}:${productId}` → product
const _fakePrices = new Map();          // `${acct}:${priceId}` → price
const _fakeCustomers = new Map();       // `${acct}:${customerId}` → customer
const _fakeCheckoutSessions = new Map();// `${acct}:${sessionId}` → session
const _fakeSubscriptions = new Map();   // `${acct}:${subId}` → subscription

export function __resetStripeFake() {
  _fakeAccounts.clear();
  _fakeProducts.clear();
  _fakePrices.clear();
  _fakeCustomers.clear();
  _fakeCheckoutSessions.clear();
  _fakeSubscriptions.clear();
}

export function __setAccountState(id, patch) {
  const cur = _fakeAccounts.get(id) ?? {};
  _fakeAccounts.set(id, { ...cur, ...patch });
}

export function __getProductsForAccount(acct) {
  return Array.from(_fakeProducts.entries())
    .filter(([k]) => k.startsWith(`${acct}:`))
    .map(([, v]) => v);
}

export function __getPricesForAccount(acct) {
  return Array.from(_fakePrices.entries())
    .filter(([k]) => k.startsWith(`${acct}:`))
    .map(([, v]) => v);
}

// Slice 4a additions: simulate a Checkout Session "completing" by
// creating a subscription on the connected account + setting the
// session to status 'complete'. Tests use this to drive the
// post-checkout webhook flow.
export function __completeCheckoutSession(acct, sessionId, opts = {}) {
  const session = _fakeCheckoutSessions.get(`${acct}:${sessionId}`);
  if (!session) {
    throw new Error(`fake stripe: no checkout session ${sessionId} on ${acct}`);
  }
  // Spawn a fake subscription
  const subId = `sub_test_${Math.random().toString(36).slice(2, 10)}`;
  const now = Math.floor(Date.now() / 1000);
  const subscription = {
    id: subId,
    customer: session.customer,
    status: 'active',
    current_period_start: now,
    current_period_end: now + 30 * 24 * 60 * 60,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: session.line_items[0]?.price } }] },
    metadata: { ...session.metadata, ...(opts.metadata ?? {}) },
  };
  _fakeSubscriptions.set(`${acct}:${subId}`, subscription);
  session.status = 'complete';
  session.subscription = subId;
  return { session, subscription };
}

export function __getSubscriptionsForAccount(acct) {
  return Array.from(_fakeSubscriptions.entries())
    .filter(([k]) => k.startsWith(`${acct}:`))
    .map(([, v]) => v);
}

// Helper: pull stripeAccount from the per-call options. Connect calls
// pass `{ stripeAccount: 'acct_xxx' }` as the second arg; calls
// without it run on the platform account.
function acctFromOptions(opts) {
  if (!opts?.stripeAccount) {
    const err = new Error(
      'fake stripe: products/prices.create requires stripeAccount option (Connect)',
    );
    err.statusCode = 400;
    throw err;
  }
  if (!_fakeAccounts.has(opts.stripeAccount)) {
    const err = new Error(`fake stripe: unknown account ${opts.stripeAccount}`);
    err.statusCode = 404;
    throw err;
  }
  return opts.stripeAccount;
}

function testFake() {
  return {
    // webhooks.constructEvent is purely local HMAC math — no API
    // call. Use the real Stripe SDK static method here so signing +
    // verifying behave identically to production. Tests sign with
    // Stripe.webhooks.generateTestHeaderString and the controller
    // verifies through this same code path.
    webhooks: Stripe.webhooks,
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
    products: {
      async create(params, opts) {
        const acct = acctFromOptions(opts);
        const id = `prod_test_${Math.random().toString(36).slice(2, 10)}`;
        const row = {
          id,
          name: params?.name,
          metadata: params?.metadata ?? {},
          active: params?.active ?? true,
          stripe_account: acct, // for test introspection only
        };
        _fakeProducts.set(`${acct}:${id}`, row);
        return row;
      },
    },
    customers: {
      async create(params, opts) {
        const acct = acctFromOptions(opts);
        const id = `cus_test_${Math.random().toString(36).slice(2, 10)}`;
        const row = {
          id,
          email: params?.email ?? null,
          metadata: params?.metadata ?? {},
          stripe_account: acct,
        };
        _fakeCustomers.set(`${acct}:${id}`, row);
        return row;
      },
    },
    billingPortal: {
      sessions: {
        async create(params, opts) {
          const acct = acctFromOptions(opts);
          if (!params?.customer) {
            const err = new Error('fake stripe: customer required for portal session');
            err.statusCode = 400;
            throw err;
          }
          if (!_fakeCustomers.has(`${acct}:${params.customer}`)) {
            const err = new Error(`fake stripe: unknown customer ${params.customer}`);
            err.statusCode = 404;
            throw err;
          }
          const id = `bps_test_${Math.random().toString(36).slice(2, 10)}`;
          return {
            id,
            customer: params.customer,
            return_url: params.return_url,
            url: `https://stripe.example/billing-portal/${id}`,
            stripe_account: acct,
          };
        },
      },
    },
    checkout: {
      sessions: {
        async create(params, opts) {
          const acct = acctFromOptions(opts);
          if (params?.mode !== 'subscription') {
            const err = new Error(
              `fake stripe: only mode='subscription' faked, got ${params?.mode}`,
            );
            err.statusCode = 400;
            throw err;
          }
          if (!params?.customer) {
            const err = new Error('fake stripe: customer required');
            err.statusCode = 400;
            throw err;
          }
          if (!_fakeCustomers.has(`${acct}:${params.customer}`)) {
            const err = new Error(`fake stripe: unknown customer ${params.customer}`);
            err.statusCode = 404;
            throw err;
          }
          const id = `cs_test_${Math.random().toString(36).slice(2, 10)}`;
          const row = {
            id,
            mode: params.mode,
            status: 'open',
            customer: params.customer,
            line_items: params.line_items ?? [],
            success_url: params.success_url,
            cancel_url: params.cancel_url,
            metadata: params.metadata ?? {},
            url: `https://stripe.example/checkout/${id}`,
            stripe_account: acct,
          };
          _fakeCheckoutSessions.set(`${acct}:${id}`, row);
          return row;
        },
      },
    },
    prices: {
      async create(params, opts) {
        const acct = acctFromOptions(opts);
        if (!params?.product) {
          const err = new Error('fake stripe: prices.create requires product');
          err.statusCode = 400;
          throw err;
        }
        if (!_fakeProducts.has(`${acct}:${params.product}`)) {
          const err = new Error(
            `fake stripe: product ${params.product} not on account ${acct}`,
          );
          err.statusCode = 404;
          throw err;
        }
        const id = `price_test_${Math.random().toString(36).slice(2, 10)}`;
        const row = {
          id,
          product: params.product,
          unit_amount: params.unit_amount,
          currency: params.currency ?? 'usd',
          recurring: params.recurring ?? null,
          active: params.active ?? true,
          stripe_account: acct,
        };
        _fakePrices.set(`${acct}:${id}`, row);
        return row;
      },
    },
  };
}
