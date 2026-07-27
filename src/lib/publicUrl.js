// Absolute tenant URLs — the single constructor for every link that
// points a browser at a tenant's subdomain.
//
// These started life in services/email.js (they were only ever needed
// by email templates). Now the admin UI shows tenants their own
// shareable booking link, so the helpers live here in lib/ and email.js
// re-exports them: a route shouldn't have to import the email service
// to build a URL. Same rationale as lib/advanceWindow.js.
//
// The shape must match what resolveTenant parses back OUT of the Host
// header ({subdomain}.{APP_HOSTNAME}), plus the Vite dev server port
// in local dev.

export function tenantUrl(subdomain, path = '/') {
  const apex = process.env.APP_HOSTNAME || 'localhost';
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const port = apex === 'localhost' ? ':5173' : '';
  return `${protocol}://${subdomain}.${apex}${port}${path}`;
}

// The public booking page. Pass an offeringId to deep-link straight
// past the service list into that service's time picker — tenants
// share these on Instagram bios, Google Business, and "book HitTrax"
// buttons.
//
// The 'service' param name is the client's URL contract
// (client/src/lib/walkinParams.js parseWalkInParams); buildWalkInParams
// on the client builds the same string from the same key, and
// tests/bookingLinks.test.js asserts the two agree.
export function buildBookingUrl(subdomain, offeringId = null) {
  const path = offeringId
    ? `/walk-in?service=${encodeURIComponent(offeringId)}`
    : '/walk-in';
  return tenantUrl(subdomain, path);
}

// The no-login manage/reschedule capability URL embedded in walk-in
// confirmation + reschedule emails. One constructor so the client
// route and the email link can't drift.
export function buildManageUrl(subdomain, token) {
  return tenantUrl(
    subdomain,
    `/walk-in/manage?token=${encodeURIComponent(token)}`,
  );
}
