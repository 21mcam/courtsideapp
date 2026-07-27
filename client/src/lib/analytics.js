// GA4 funnel instrumentation for the PUBLIC walk-in pages only.
//
// The tenant's measurement id (tenants.ga4_measurement_id) arrives on
// GET /api/tenant; when it's null everything here is a no-op — admin
// and member surfaces never call initAnalytics at all. gtag script
// injection is deferred to idle so it never competes with LCP.
//
// Funnel events mirror the GA4 steps measured on the flow this
// replaces, so before/after conversion comparison is one query:
//   view_services → select_service → select_slot → begin_checkout →
//   purchase
//
// The purchase event is deduped per booking id via localStorage
// (survives refreshes of the success page AND new tabs of the same
// success URL — the lookup effect polls, so idempotence matters).
//
// Everything browser-touching is inside guarded functions; the pure
// helpers below are unit tested from tests/analytics.test.js under
// plain node.

let inited = false;

export function initAnalytics(measurementId) {
  if (!measurementId || inited || typeof window === 'undefined') return;
  inited = true;
  // Stub immediately so events queue while the script loads.
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag() {
      window.dataLayer.push(arguments);
    };
  }
  window.gtag('js', new Date());
  // Explicit funnel events only — an automatic page_view would double
  // count against the SPA's single document.
  window.gtag('config', measurementId, { send_page_view: false });

  const inject = () => {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(s);
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(inject, { timeout: 2000 });
  } else {
    setTimeout(inject, 0);
  }
}

export function track(eventName, params = {}) {
  if (!inited || typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', eventName, params);
}

// ---------- purchase dedupe (pure, node-testable) ----------

export function purchaseKey(bookingId) {
  return `courtside_ga4_purchase_${bookingId}`;
}

export function shouldFirePurchase(storage, bookingId) {
  try {
    return !storage.getItem(purchaseKey(bookingId));
  } catch {
    // Storage unavailable (private mode) — degrade to firing; a
    // possible double-count beats losing the conversion entirely.
    return true;
  }
}

export function markPurchaseFired(storage, bookingId) {
  try {
    storage.setItem(purchaseKey(bookingId), '1');
  } catch {
    // Best effort.
  }
}

// booking = the lookup response shape (id, offering_name,
// amount_due_cents). value is dollars — GA4 wants decimal currency.
export function buildPurchaseParams(booking) {
  const value = (booking.amount_due_cents ?? 0) / 100;
  return {
    transaction_id: booking.id,
    value,
    currency: 'USD',
    items: [
      {
        item_name: booking.offering_name ?? 'booking',
        price: value,
        quantity: 1,
      },
    ],
  };
}

// Fire `purchase` exactly once per booking id. Safe to call on every
// lookup poll — the storage guard makes it idempotent.
export function firePurchaseOnce(booking, storage) {
  if (!booking?.id) return false;
  const s = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
  if (!s) return false;
  if (!shouldFirePurchase(s, booking.id)) return false;
  track('purchase', buildPurchaseParams(booking));
  markPurchaseFired(s, booking.id);
  return true;
}
