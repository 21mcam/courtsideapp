// Route-interception fixtures for the walk-in e2e. Every /api call
// the public flow makes is answered here — no backend, no DB. Shapes
// mirror the real endpoints (see src/controllers/customerBookings.js
// and src/routes/tenant.js).

export const PRICE_CENTS = 6000; // one price, everywhere: $60.00
export const PRICE_LABEL = '$60.00';

const CAGE_A = '11111111-1111-4111-8111-111111111111';
const CAGE_B = '22222222-2222-4222-8222-222222222222';

export const TENANT = {
  id: '00000000-0000-4000-8000-000000000001',
  subdomain: 'momentum',
  name: 'Momentum Sports Training',
  timezone: 'America/New_York',
  theme_accent: 'court',
  reply_to_email: 'frontdesk@momentum.example',
  address: { street: '123 Main St', city: 'Staten Island', state: 'NY', zip: '10307' },
  business_phone: '(718) 555-0100',
  google_rating: 5.0,
  google_review_count: 205,
  google_reviews_url: 'https://g.page/momentum-example',
  ga4_measurement_id: null, // e2e asserts no gtag request without an id
  billing_blocked: false,
};

function offering(i, name, category, resources, description = null) {
  return {
    id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    name,
    category,
    description,
    duration_minutes: 60,
    dollar_price: PRICE_CENTS,
    display_order: i,
    resources,
  };
}

const BOTH = [
  { id: CAGE_A, name: 'Cage A', display_order: 0 },
  { id: CAGE_B, name: 'Cage B', display_order: 1 },
];
const ONLY_B = [{ id: CAGE_B, name: 'Cage B', display_order: 1 }];

// Enough rows that the list scrolls well past one 844px viewport —
// the occlusion assertions must include rows born off-screen.
export const OFFERINGS = [
  offering(1, '30-min Baseball Machine + Cage', 'cage-machine', BOTH,
    'Pitching machine set to your speed. Helmets provided.'),
  offering(2, '60-min Baseball Machine + Cage', 'cage-machine', BOTH),
  offering(3, '30-min Softball Machine + Cage', 'cage-machine', BOTH),
  offering(4, '60-min Softball Machine + Cage', 'cage-machine', BOTH),
  offering(5, '30-min Cage Only (No Machine)', 'cage-only', BOTH),
  offering(6, '60-min Cage Only (No Machine)', 'cage-only', BOTH),
  offering(7, '90-min Cage Only (No Machine)', 'cage-only', BOTH),
  offering(8, '30-min HitTrax Session', 'hittrax', ONLY_B,
    'Ball-tracking data on every swing — exit velo, launch angle, distance.'),
  offering(9, '60-min HitTrax Session', 'hittrax', ONLY_B),
  offering(10, '90-min HitTrax Session', 'hittrax', ONLY_B),
  offering(11, '2-hr Team Cage Block', 'cage-only', BOTH),
  offering(12, '2-hr Team HitTrax Block', 'hittrax', ONLY_B),
];

export const CATEGORIES = [
  { category: 'cage-machine', label: 'Cage + Pitching Machine', display_order: 0 },
  { category: 'cage-only', label: 'Cage Only (No Machine)', display_order: 1 },
  { category: 'hittrax', label: 'HitTrax – See Your Hitting Stats', display_order: 2 },
];

export const POLICY = {
  hold_minutes: 30,
  customer_reschedule_hours_before: 24,
  min_advance_booking_minutes: 0,
  max_advance_booking_days: 30,
};

// Dense slot grid for any requested date: 14:00Z–02:00Z next day,
// every 30 min (matches a 9am–9pm EST day well enough for layout).
function slotsFor(date) {
  const out = [];
  const base = Date.parse(`${date}T14:00:00.000Z`);
  for (let i = 0; i < 24; i += 1) {
    const start = new Date(base + i * 30 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    out.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return out;
}

// Install all interceptions. Returns a recorder with the booking
// POSTs seen (request objects + parsed bodies).
export async function installMocks(page) {
  const recorded = { bookingPosts: [] };

  await page.route('**/api/tenant**', (route) =>
    route.fulfill({ json: TENANT }),
  );
  await page.route('**/api/customers/offerings**', (route) =>
    route.fulfill({
      json: { offerings: OFFERINGS, categories: CATEGORIES, policy: POLICY },
    }),
  );
  await page.route('**/api/waivers/current**', (route) =>
    route.fulfill({
      json: { waiver_required: false, waiver_text: null, waiver_version: 1 },
    }),
  );
  await page.route('**/api/availability**', (route) => {
    const url = new URL(route.request().url());
    route.fulfill({
      json: {
        slots: slotsFor(url.searchParams.get('date')),
        duration_minutes: 60,
        min_advance_booking_minutes: 0,
        max_advance_booking_days: 30,
      },
    });
  });
  await page.route('**/api/customers/bookings**', (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = req.postDataJSON();
    recorded.bookingPosts.push({
      body,
      authorization: req.headers()['authorization'] ?? null,
    });
    return route.fulfill({
      status: 201,
      json: {
        booking: {
          id: '66666666-6666-4666-8666-666666666666',
          status: 'pending_payment',
          start_time: body.start_time,
          amount_due_cents: PRICE_CENTS,
          hold_expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
        },
        checkout_url: '/stripe-stub',
        session_id: 'cs_test_e2e',
        hold_minutes: 30,
      },
    });
  });
  // The client hard-navigates to checkout_url; keep it same-origin
  // and stub it so the test can observe the landing.
  await page.route('**/stripe-stub', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1 data-testid="stripe-stub">Stripe Checkout stub</h1>',
    }),
  );

  return recorded;
}
