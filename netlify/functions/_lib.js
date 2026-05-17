// Shared helpers — uses @netlify/database + node-postgres (pg).
// pg works against both local dev (raw TCP Postgres) and production Neon (also TCP),
// unlike the HTTP-only @neondatabase/serverless driver.

import { getConnectionString } from '@netlify/database';
import pg from 'pg';
const { Pool } = pg;

let _pool = null;
async function getPool() {
  if (!_pool) {
    const connectionString = await getConnectionString();
    _pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    });
  }
  return _pool;
}

// Tagged template helper: sql`SELECT * FROM users WHERE id = ${id}`
// Converts the template into a parameterized query for pg.
export async function sql(strings, ...values) {
  const pool = await getPool();
  // Build $1, $2, $3 ... placeholders
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += '$' + (i + 1) + strings[i + 1];
  }
  const result = await pool.query(text, values);
  return result.rows;
}

// Direct query for cases where the tag form is awkward
sql.query = async (text, params) => {
  const pool = await getPool();
  return pool.query(text, params);
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-wasabi-token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

export function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function getUser(req) {
  const token = req.headers.get('x-wasabi-token');
  if (!token) return null;
  const rows = await sql`SELECT id, email, display_name FROM users WHERE api_token = ${token} LIMIT 1`;
  return rows[0] || null;
}

export async function requireUser(req) {
  const user = await getUser(req);
  if (!user) {
    return { error: jsonResponse({ error: 'Unauthorized — missing or invalid x-wasabi-token' }, 401) };
  }
  return { user };
}

export async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}