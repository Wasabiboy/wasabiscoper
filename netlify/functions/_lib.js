// Shared helpers — uses @netlify/database for connection discovery,
// then picks the right Postgres driver based on the connection context:
//   - localhost / netlify dev → pg (TCP)
//   - production Netlify Database / Neon HTTP endpoint → @neondatabase/serverless (HTTP)
//
// Both drivers expose .query(text, params) — we normalise around that.

import { getConnectionString } from '@netlify/database';
import pg from 'pg';
import { neon } from '@neondatabase/serverless';

const { Pool } = pg;

let _querier = null; // (text: string, params: any[]) => Promise<rows[]>

async function getQuerier() {
  if (_querier) return _querier;

  const connectionString = await getConnectionString();
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

  if (isLocal) {
    const pool = new Pool({ connectionString, ssl: false });
    _querier = async (text, params) => {
      const r = await pool.query(text, params);
      return r.rows;
    };
  } else {
    // @neondatabase/serverless: use .query() for parameterised calls (not the tag form)
    const sqlClient = neon(connectionString);
    _querier = async (text, params) => {
      const rows = await sqlClient.query(text, params);
      return rows;
    };
  }
  return _querier;
}

// Tagged template helper: sql`SELECT * FROM users WHERE id = ${id}`
export async function sql(strings, ...values) {
  const querier = await getQuerier();
  let text = strings[0];
  for (let i = 0; i < values.length; i++) {
    text += '$' + (i + 1) + strings[i + 1];
  }
  return querier(text, values);
}

// Direct query form for cases where the tag form is awkward
sql.query = async (text, params) => {
  const querier = await getQuerier();
  const rows = await querier(text, params);
  return { rows };
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
