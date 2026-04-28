// Admin-only read views — Phase 1, slice 4.
//
// These are intentionally minimal: list-out-of-the-box data so the
// admin UI has something useful to render. Real CRUD (create member,
// edit member, deactivate member) is Phase 2 work alongside the
// onboarding wizard.

export async function listMembers(req, res, next) {
  try {
    const result = await req.db.query(
      `SELECT id, email, first_name, last_name, phone, user_id, created_at
         FROM members
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [req.tenant.id],
    );
    res.json({ members: result.rows });
  } catch (err) {
    next(err);
  }
}

export async function listAdmins(req, res, next) {
  try {
    // Join to users so we can show name/email on the admin roster.
    const result = await req.db.query(
      `SELECT ta.id, ta.role, ta.user_id, ta.created_at,
              u.email, u.first_name, u.last_name
         FROM tenant_admins ta
         JOIN users u
           ON u.tenant_id = ta.tenant_id
          AND u.id = ta.user_id
        WHERE ta.tenant_id = $1
        ORDER BY ta.created_at DESC`,
      [req.tenant.id],
    );
    res.json({ admins: result.rows });
  } catch (err) {
    next(err);
  }
}
