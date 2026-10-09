// Per-tenant "Add to Home Screen" support: the web app manifest and
// its icon. Each facility installs as ITSELF ("Sunset Park Baseball",
// its accent color, its initial) — never as "Courtside".
//
// Deliberately no service worker: Chrome no longer requires one to
// offer install, iOS never did, and an offline cache in front of a
// live booking page is a stale-price/stale-slot bug waiting to happen.
//
// Pure — unit tested from tests/webManifest.test.js.

import { accentHex, escapeHtml } from '../services/email.js';

// Home-screen labels truncate around 12 characters. Use the full name
// when it fits; otherwise as many whole words as fit; otherwise a hard
// cut of the first word.
export function shortName(name) {
  const clean = String(name ?? '').trim();
  if (clean.length <= 12) return clean;
  let out = '';
  for (const word of clean.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 12) break;
    out = next;
  }
  return out || clean.slice(0, 12);
}

function initial(name) {
  const m = String(name ?? '').match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '•';
}

export function buildManifest(tenant) {
  const icon = '/api/tenant/icon.svg';
  return {
    id: '/',
    name: tenant.name,
    short_name: shortName(tenant.name),
    description: `Book at ${tenant.name}`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: accentHex(tenant.theme_accent),
    icons: [
      // One full-bleed SVG serves both purposes: the letter sits well
      // inside the maskable safe zone (inner 80% circle).
      { src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}

export function buildIconSvg(tenant) {
  const fill = accentHex(tenant.theme_accent);
  const letter = escapeHtml(initial(tenant.name));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${fill}"/>
  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
        font-family="Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="260" font-weight="700" fill="#ffffff">${letter}</text>
</svg>
`;
}
