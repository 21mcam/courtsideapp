// Liability waivers v1 — Tier-A sell-readiness slice.
//
// Config lives on booking_policies (waiver_required, waiver_text,
// waiver_version — see migration 023). The version is bumped by the
// policies update controller whenever waiver_text changes, so
// enforcement ("do you have a CURRENT-version signature?") re-prompts
// everyone after a text edit.
//
// Endpoints here:
//   GET  /api/waivers/current        public — the current waiver text
//                                    (only exposed when required)
//   POST /api/waivers/sign           member — record a signature
//   GET  /api/admin/waiver-signatures  admin — list signatures
//
// Enforcement helpers are exported for the booking flows:
//   * createMemberBooking / createMemberClassBooking call
//     findMissingWaiverSignature and 409 with code
//     WAIVER_REQUIRED_CODE when the member hasn't signed the current
//     version. The member UI opens a waiver modal on that code, signs
//     via POST /api/waivers/sign, and retries the booking.
//   * createCustomerBooking (walk-in) captures the signature inline
//     on the booking form and records it against customer_email in
//     the SAME transaction as the booking.
//
// waiver_signatures is append-only: the runtime role has INSERT +
// SELECT only (UPDATE/DELETE revoked in migration 023).

import { z } from 'zod';

// Distinct machine-readable code the member UI keys off to open the
// waiver modal (a plain 409 message would be ambiguous).
export const WAIVER_REQUIRED_CODE = 'waiver_signature_required';

// Read the tenant's waiver config off the booking_policies singleton.
// Tenants that predate the row (or migration 023) get the schema
// defaults: waiver off.
export async function getWaiverConfig(db, tenantId) {
  const r = await db.query(
    `SELECT waiver_required, waiver_text, waiver_version
       FROM booking_policies
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return (
    r.rows[0] ?? { waiver_required: false, waiver_text: null, waiver_version: 1 }
  );
}

// Enforcement helper shared by the booking flows. Returns null when
// booking may proceed (waiver off, or a current-version signature
// exists for this member / customer email), or { waiver_version }
// when a signature at the current version is missing.
export async function findMissingWaiverSignature(
  db,
  tenantId,
  { memberId = null, customerEmail = null },
) {
  const config = await getWaiverConfig(db, tenantId);
  if (!config.waiver_required) return null;
  const r = await db.query(
    `SELECT 1 FROM waiver_signatures
      WHERE tenant_id = $1
        AND waiver_version = $2
        AND (
          ($3::uuid IS NOT NULL AND member_id = $3)
          OR ($4::text IS NOT NULL AND customer_email = $4)
        )
      LIMIT 1`,
    [tenantId, config.waiver_version, memberId, customerEmail],
  );
  if (r.rows.length > 0) return null;
  return { waiver_version: config.waiver_version };
}

// Shared zod shape for a signature payload. Used by POST
// /api/waivers/sign (members) and embedded in the walk-in booking
// body (customerBookings.js).
export const waiverSignatureSchema = z
  .object({
    signer_name: z.string().trim().min(1).max(300),
    guardian_name: z.string().trim().min(1).max(300).optional(),
    is_minor: z.boolean().optional(),
  })
  .refine((d) => !d.is_minor || d.guardian_name, {
    message: 'guardian_name is required when signing on behalf of a minor',
  });

// ============================================================
// GET /api/waivers/current — public + member
// ============================================================
//
// The walk-in booking form and the member waiver modal both render
// the text from here. When the waiver isn't required the text is
// intentionally NOT exposed (there's nothing to sign).
export async function getCurrentWaiver(req, res, next) {
  try {
    const config = await getWaiverConfig(req.db, req.tenant.id);
    if (!config.waiver_required) {
      return res.json({ waiver_required: false });
    }
    res.json({
      waiver_required: true,
      waiver_text: config.waiver_text ?? '',
      waiver_version: config.waiver_version,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// POST /api/waivers/sign — member records a signature
// ============================================================
//
// Body: { signer_name, guardian_name?, is_minor? }. Records a row at
// the CURRENT waiver_version. Signing when the waiver isn't required
// is a 409 (nothing to sign). Re-signing an already-signed version is
// allowed (append-only; harmless duplicate).
export async function signWaiver(req, res, next) {
  try {
    if (!req.user?.member_id) {
      return res
        .status(403)
        .json({ error: 'must be signed in as a member to sign the waiver' });
    }
    const { tenant, db, user } = req;

    const parsed = waiverSignatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { signer_name, guardian_name, is_minor } = parsed.data;

    const config = await getWaiverConfig(db, tenant.id);
    if (!config.waiver_required) {
      return res
        .status(409)
        .json({ error: 'this facility does not require a waiver' });
    }

    const result = await db.query(
      `INSERT INTO waiver_signatures
         (tenant_id, member_id, signer_name, guardian_name, is_minor,
          waiver_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, member_id, signer_name, guardian_name, is_minor,
                 waiver_version, signed_at`,
      [
        tenant.id,
        user.member_id,
        signer_name,
        guardian_name ?? null,
        is_minor ?? false,
        config.waiver_version,
      ],
    );
    res.status(201).json({ signature: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// GET /api/admin/waiver-signatures — admin list
// ============================================================
//
// Query params:
//   current_only=true  only signatures at the current waiver_version
//                      (i.e. the people who are covered right now)
//
// Response: { waiver: { required, version }, signatures: [...] } —
// each signature carries the member's name/email when it's a member
// signature (LEFT JOIN; walk-ins have customer_email inline).
export async function listWaiverSignatures(req, res, next) {
  try {
    const config = await getWaiverConfig(req.db, req.tenant.id);
    const currentOnly = req.query.current_only === 'true';

    const params = [req.tenant.id];
    let versionClause = '';
    if (currentOnly) {
      params.push(config.waiver_version);
      versionClause = `AND ws.waiver_version = $${params.length}`;
    }

    const result = await req.db.query(
      `SELECT ws.id, ws.member_id, ws.customer_email, ws.signer_name,
              ws.guardian_name, ws.is_minor, ws.waiver_version,
              ws.signed_at,
              m.first_name AS member_first_name,
              m.last_name  AS member_last_name,
              m.email      AS member_email
         FROM waiver_signatures ws
         LEFT JOIN members m
           ON m.tenant_id = ws.tenant_id AND m.id = ws.member_id
        WHERE ws.tenant_id = $1
          ${versionClause}
        ORDER BY ws.signed_at DESC
        LIMIT 500`,
      params,
    );
    res.json({
      waiver: {
        required: config.waiver_required,
        version: config.waiver_version,
      },
      signatures: result.rows,
    });
  } catch (err) {
    next(err);
  }
}
