// Acceptance tests for the rebuilt walk-in checkout, at the design
// viewport (390×844). Each maps to a criterion from the funnel audit
// of the Setmore flow this replaces:
//
//   1. OCCLUSION — nothing purchasable may ever sit under fixed UI.
//      (Their fixed CTA covered the bottom catalog rows: −32% at
//      service selection.)
//   2. TAP COUNT — service (1) → day (1) → slot (1) → 3 fields → pay.
//   3. ONE PRICE — the number on the service row is the number on
//      every later surface. (Their $90 became $93.60 "Tax".)
//   4. NO LOGIN — guest checkout is the only path. (Their login wall:
//      −37% at checkout start.)
//
// Fully API-mocked (e2e/mocks.js) against `vite preview` — hermetic.

import { test, expect } from '@playwright/test';
import { installMocks, PRICE_LABEL } from './mocks.js';

const ENTRY = '/walk-in?tenant=momentum';

// Assert `el` can be brought fully into view strictly above the fixed
// summary bar, and that its center actually receives hit-testing.
async function assertUnobstructed(page, locator, barTop) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, 'element must render').toBeTruthy();
  expect(
    box.y + box.height,
    'element bottom must clear the summary bar top',
  ).toBeLessThanOrEqual(barTop + 0.5);
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.outerHTML.slice(0, 80) : null;
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(hit, 'element center must be hit-testable').toBeTruthy();
}

test('occlusion: no fixed bar over the catalog; bar never covers slots or form', async ({ page }) => {
  await installMocks(page);
  await page.goto(ENTRY);

  // Step 1 — the catalog. There is deliberately NO fixed bar here;
  // every service row must be reachable and hit-testable.
  const rows = page.getByTestId('service-row');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId('summary-bar')).toHaveCount(0);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThanOrEqual(12);
  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y) != null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit).toBe(true);
  }

  // Step 2 — bar visible; every day chip and EVERY slot button
  // (including the last at max scroll) must clear it.
  await rows.first().click();
  const bar = page.getByTestId('summary-bar');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('slot-button').first()).toBeVisible();
  const barTop = (await bar.boundingBox()).y;

  const chips = page.getByTestId('day-chip');
  for (let i = 0; i < Math.min(await chips.count(), 5); i += 1) {
    await assertUnobstructed(page, chips.nth(i), barTop);
  }
  const slots = page.getByTestId('slot-button');
  const slotCount = await slots.count();
  expect(slotCount).toBeGreaterThanOrEqual(20);
  for (let i = 0; i < slotCount; i += 1) {
    await assertUnobstructed(page, slots.nth(i), barTop);
  }

  // Step 3 — the whole form, including the last field, clears the bar.
  await slots.last().click();
  await expect(page.locator('#walkin-details-form')).toBeVisible();
  const barTop3 = (await bar.boundingBox()).y;
  for (const sel of [
    'input[autocomplete="name"]',
    'input[autocomplete="tel"]',
    'input[autocomplete="email"]',
    'textarea',
  ]) {
    await assertUnobstructed(page, page.locator(sel).first(), barTop3);
  }
});

test('tap path: 3 taps to the form; exactly 3 required fields + 1 optional', async ({ page }) => {
  await installMocks(page);
  await page.goto(ENTRY);

  await page.getByTestId('service-row').first().click(); // tap 1
  await page.getByTestId('day-chip').nth(1).click(); //      tap 2
  await page.getByTestId('slot-button').first().click(); //  tap 3

  const form = page.locator('#walkin-details-form');
  await expect(form).toBeVisible();

  await expect(form.locator('input[required]')).toHaveCount(3);
  await expect(form.locator('textarea')).toHaveCount(1);
  await expect(form.locator('textarea[required]')).toHaveCount(0);
  // Correct mobile keyboards / autofill hooks.
  await expect(form.locator('input[autocomplete="name"]')).toHaveCount(1);
  await expect(
    form.locator('input[type="tel"][inputmode="tel"][autocomplete="tel"]'),
  ).toHaveCount(1);
  await expect(
    form.locator('input[type="email"][autocomplete="email"]'),
  ).toHaveCount(1);
});

test('one price: the list price is the bar price is the CTA price is the charge', async ({ page }) => {
  const recorded = await installMocks(page);
  await page.goto(ENTRY);

  const firstRow = page.getByTestId('service-row').first();
  await expect(firstRow.getByTestId('service-price')).toHaveText(PRICE_LABEL);

  await firstRow.click();
  const bar = page.getByTestId('summary-bar');
  await expect(bar).toContainText(PRICE_LABEL);

  await page.getByTestId('slot-button').first().click();
  await expect(bar).toContainText(PRICE_LABEL);
  await expect(page.getByTestId('details-price')).toHaveText(PRICE_LABEL);
  await expect(page.getByTestId('pay-cta')).toHaveText(`Pay ${PRICE_LABEL}`);

  // Only ONE dollar amount may exist on the checkout surfaces — a
  // second, larger number is exactly the drip-pricing failure.
  const dollarAmounts = await page.evaluate(() =>
    Array.from(document.body.innerText.matchAll(/\$\d[\d,]*\.?\d*/g)).map(
      (m) => m[0],
    ),
  );
  expect(new Set(dollarAmounts)).toEqual(new Set([PRICE_LABEL]));

  // …and the amount the server is asked to charge is the same
  // offering the list showed (server test asserts unit_amount ===
  // listed price; here we prove the client can't swap offerings).
  await page.locator('input[autocomplete="name"]').fill('Casey Tester');
  await page.locator('input[autocomplete="tel"]').fill('7185550123');
  await page.locator('input[autocomplete="email"]').fill('casey@example.com');
  await page.getByTestId('pay-cta').click();
  await expect(page.getByTestId('stripe-stub')).toBeVisible();
  expect(recorded.bookingPosts).toHaveLength(1);
  expect(recorded.bookingPosts[0].body.offering_id).toBe(
    '55555555-5555-4555-8555-000000000001',
  );
});

test('no login in the path: guest-only to payment; no gtag without an id', async ({ page }) => {
  const recorded = await installMocks(page);
  const visited = [];
  const external = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (host !== 'localhost') external.push(req.url());
  });

  await page.goto(ENTRY);
  // The subtle member link exists, but nothing in the flow requires it.
  await expect(page.getByText('Member sign in')).toBeVisible();
  // Social proof is a first-class element on the first screen.
  await expect(page.getByText('5.0')).toBeVisible();
  await expect(page.getByText('(205 Google reviews)')).toBeVisible();

  await page.getByTestId('service-row').first().click();
  await page.getByTestId('slot-button').first().click();
  await page.locator('input[autocomplete="name"]').fill('Casey Tester');
  await page.locator('input[autocomplete="tel"]').fill('7185550123');
  await page.locator('input[autocomplete="email"]').fill('casey@example.com');
  // Trust copy: the flexibility promise + hold note, policy-driven.
  await expect(page.getByText(/Reschedule free up to 24h before/)).toBeVisible();
  await expect(page.getByText(/hold your time for 30 minutes/)).toBeVisible();
  await page.getByTestId('pay-cta').click();
  await expect(page.getByTestId('stripe-stub')).toBeVisible();

  expect(visited.some((p) => p.includes('/login'))).toBe(false);
  expect(recorded.bookingPosts).toHaveLength(1);
  expect(recorded.bookingPosts[0].authorization).toBeNull();
  // ga4_measurement_id is null → zero third-party requests.
  expect(external).toEqual([]);
});
