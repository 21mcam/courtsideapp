// Shared admin-facing notice for cancelling a booking that was paid
// online. Cancelling never touches Stripe — the customer's money
// stays with the facility until the operator refunds it in their
// Stripe dashboard (no in-app refund path yet). Both admin cancel
// surfaces (Bookings list, Calendar detail panel) append this to
// their success message so the copy can't drift.
//
// `body` is the POST /api/bookings/:id/cancel response;
// stripe_refund_due_cents is 0 for member/cash bookings.
export function stripeRefundNotice(body) {
  const cents = body?.stripe_refund_due_cents ?? 0;
  if (cents <= 0) return '';
  return (
    ` Heads up: they paid $${(cents / 100).toFixed(2)} online, which was ` +
    'NOT refunded — if a refund is owed, issue it from your Stripe dashboard.'
  );
}
