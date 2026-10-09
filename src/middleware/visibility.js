// Private facilities (tenants.visibility = 'private', migration 035)
// are being set up: staff can sign in and configure everything, but the
// public can't book or create accounts yet. Mount on the public create
// routes only — browsing stays open so staff can preview the pages.

export const FACILITY_NOT_OPEN_CODE = 'facility_not_open';

export function refuseWhenPrivate(req, res, next) {
  if (req.tenant?.visibility === 'private') {
    return res.status(403).json({
      error: `${req.tenant.name} isn't taking online bookings yet`,
      code: FACILITY_NOT_OPEN_CODE,
    });
  }
  next();
}
