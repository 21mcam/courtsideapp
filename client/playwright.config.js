// Playwright e2e for the public walk-in checkout — the funnel audit's
// acceptance criteria need a real layout engine (occlusion can't be
// asserted in jsdom). Hermetic: every /api call is intercepted in
// e2e/mocks.js, so no backend, no Postgres, no Stripe — just `vite
// preview` over the built bundle. Viewport is the design target
// (390×844, ~80% of booking traffic is phones).

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    // Chromium-only (CI installs just chromium); explicit mobile
    // emulation rather than an iPhone preset, which would demand
    // WebKit.
    browserName: 'chromium',
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  },
  projects: [{ name: 'chromium-mobile' }],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
