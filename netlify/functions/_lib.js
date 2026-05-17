// Shared helpers used by every function.
// The @netlify/neon driver reads NETLIFY_DATABASE_URL automatically from the env —
// the connection string never appears in code or in any prompt.

import { neon } from '@netlify/neon';

export const sql = neon(); // singleton

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-wasabi-token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS
  });
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// Look up the authenticated user from the x-wasabi-token header.
// Returns null if no valid token.
export async function getUser(req) {
  const token = req.headers.get('x-wasabi-token');
  if (!token) return null;
  const rows = await sql`SELECT id, email, display_name FROM users WHERE api_token = ${token} LIMIT 1`;
  return rows[0] || null;
}

// Require auth — returns either a user object or a 401 Response.
export async function requireUser(req) {
  const user = await getUser(req);
  if (!user) {
    return { error: jsonResponse({ error: 'Unauthorized — missing or invalid x-wasabi-token' }, 401) };
  }
  return { user };
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
