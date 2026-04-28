// GET /api/me — returns the authenticated user plus their resolved
// role memberships (admin row + member row) for the current tenant.
//
// Honors the "one user, many roles" model: a facility owner who's
// also a member of their own facility gets both fields populated.
//
// All queries explicitly filter by tenant_id (CLAUDE.md: app code is
// the first line of defense; RLS is the safety net).

export async function me(req, res, next) {
  try {
    const { user_id } = req.user;

    const userResult = await req.db.query(
      `SELECT id, email, first_name, last_name
         FROM users
        WHERE tenant_id = $1 AND id = $2`,
      [req.tenant.id, user_id],
    );

    if (userResult.rows.length === 0) {
      // Token references a user that doesn't exist (or is in a
      // different tenant — RLS would also filter that). Either way,
      // 401 — they need to re-auth.
      return res.status(401).json({ error: 'user not found' });
    }

    const adminResult = await req.db.query(
      `SELECT id, role FROM tenant_admins
        WHERE tenant_id = $1 AND user_id = $2`,
      [req.tenant.id, user_id],
    );

    const memberResult = await req.db.query(
      `SELECT id FROM members
        WHERE tenant_id = $1 AND user_id = $2`,
      [req.tenant.id, user_id],
    );

    // Pull credits if the user has a member record. Surfaced in the
    // payload so the member dashboard can show "X credits available"
    // without a second roundtrip. Admin-only users get null here.
    let credits = null;
    if (memberResult.rows[0]) {
      const balRes = await req.db.query(
        `SELECT current_credits FROM credit_balances
          WHERE tenant_id = $1 AND member_id = $2`,
        [req.tenant.id, memberResult.rows[0].id],
      );
      credits = {
        current_credits: balRes.rows[0]?.current_credits ?? 0,
      };
    }

    res.json({
      user: userResult.rows[0],
      tenant: {
        id: req.tenant.id,
        subdomain: req.tenant.subdomain,
        name: req.tenant.name,
      },
      memberships: {
        admin: adminResult.rows[0] ?? null,
        member: memberResult.rows[0] ?? null,
      },
      credits,
    });
  } catch (err) {
    next(err);
  }
}
