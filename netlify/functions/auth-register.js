// /api/auth/register
// Simple beta auth: POST { email, displayName } → returns { token }
// Paste the token into the extension's Settings. No password yet.
// For production, swap to Netlify Identity, Stack Auth (Neon Auth), or Clerk.

import { sql, jsonResponse, handleOptions, readJson } from './_lib.js';
import { randomBytes } from 'node:crypto';

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const { email, displayName } = await readJson(req);
    if (!email) return jsonResponse({ error: 'email required' }, 400);

    const token = 'wsb_' + randomBytes(24).toString('base64url');

    // Upsert — if email exists, rotate the token
    const [row] = await sql`
      INSERT INTO users (email, display_name, api_token)
      VALUES (${email}, ${displayName || null}, ${token})
      ON CONFLICT (email) DO UPDATE SET
        api_token = EXCLUDED.api_token,
        display_name = COALESCE(EXCLUDED.display_name, users.display_name)
      RETURNING id, email, display_name, api_token
    `;
    return jsonResponse({ user: { id: row.id, email: row.email, displayName: row.display_name }, token: row.api_token });
  } catch (e) {
    console.error('[register]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/auth/register' };
