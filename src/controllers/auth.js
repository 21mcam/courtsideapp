// Auth controllers — Phase 1, slice 1: member-only.
//
// register-member: creates users + members rows in one transaction,
// issues a JWT carrying { tenant_id, user_id, member_id, role: 'member' }.
// Refuses if a user with that email already exists in this tenant —
// the user should log in instead. Linking an existing user to a new
// member is admin-only (separate path, later).
//
// login: authenticates against users table, requires the user to have
// a member row in this tenant for slice 1. Admin-only login is a
// separate path added in a later slice.

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

const TOKEN_EXPIRY = '7d';
const BCRYPT_ROUNDS = 10;

const registerMemberSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(8, 'password must be at least 8 characters'),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(1).max(50).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});

function signToken({ tenant_id, user_id, member_id, role }) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'CHANGE_ME') {
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign({ tenant_id, user_id, member_id, role }, secret, {
    expiresIn: TOKEN_EXPIRY,
  });
}

export async function registerMember(req, res, next) {
  try {
    const parsed = registerMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
    }
    const { email, password, first_name, last_name, phone } = parsed.data;

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let user_id, member_id;
    try {
      const userResult = await req.db.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [req.tenant.id, email, password_hash, first_name, last_name],
      );
      user_id = userResult.rows[0].id;

      const memberResult = await req.db.query(
        `INSERT INTO members (tenant_id, user_id, email, first_name, last_name, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [req.tenant.id, user_id, email, first_name, last_name, phone ?? null],
      );
      member_id = memberResult.rows[0].id;
    } catch (err) {
      if (err.code === '23505') {
        // unique_violation — email already exists for users or members
        // in this tenant. The composite FK between them keeps these
        // in sync, so either constraint failing means "already
        // registered."
        return res.status(409).json({ error: 'email already registered' });
      }
      throw err;
    }

    const token = signToken({
      tenant_id: req.tenant.id,
      user_id,
      member_id,
      role: 'member',
    });

    res.status(201).json({ token, user_id, member_id });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid input' });
    }
    const { email, password } = parsed.data;

    // Defense in depth: tenant_id in WHERE clause is technically
    // redundant under RLS (the policy already filters by GUC), but
    // we add it explicitly per CLAUDE.md — RLS is the safety net,
    // app code is the first line.
    const userResult = await req.db.query(
      `SELECT id, password_hash FROM users
        WHERE tenant_id = $1 AND email = $2`,
      [req.tenant.id, email],
    );

    // Same response on missing user as wrong password — no user-
    // enumeration via login error.
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    const { id: user_id, password_hash } = userResult.rows[0];
    const valid = await bcrypt.compare(password, password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid credentials' });
    }

    // Slice 1 is member-only. If this user has no member row in this
    // tenant, refuse to issue a token. Admin login is a separate
    // path added later.
    const memberResult = await req.db.query(
      `SELECT id FROM members WHERE tenant_id = $1 AND user_id = $2`,
      [req.tenant.id, user_id],
    );
    const member_id = memberResult.rows[0]?.id;
    if (!member_id) {
      return res
        .status(403)
        .json({ error: 'no member account for this user in this tenant' });
    }

    const token = signToken({
      tenant_id: req.tenant.id,
      user_id,
      member_id,
      role: 'member',
    });

    res.json({ token, user_id, member_id });
  } catch (err) {
    next(err);
  }
}
