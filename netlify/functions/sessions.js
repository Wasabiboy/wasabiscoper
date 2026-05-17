// /api/sessions — list or create
// /api/sessions/:id — get one with related data
// /api/sessions/:id (PUT) — update coverage, status, metadata

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const url = new URL(req.url);
  // /api/sessions or /api/sessions/<uuid>
  const parts = url.pathname.split('/').filter(Boolean);
  const sessionId = parts[parts.length - 1] !== 'sessions' ? parts[parts.length - 1] : null;

  try {
    // List
    if (!sessionId && req.method === 'GET') {
      const rows = await sql`
        SELECT id, client_name, project_type, status, coverage, created_at, updated_at
        FROM sessions
        WHERE user_id = ${user.id}
        ORDER BY updated_at DESC
        LIMIT 50
      `;
      return jsonResponse({ sessions: rows });
    }

    // Create
    if (!sessionId && req.method === 'POST') {
      const body = await readJson(req);
      const [row] = await sql`
        INSERT INTO sessions (user_id, client_name, project_type, metadata)
        VALUES (${user.id}, ${body.clientName || null}, ${body.projectType || 'general'}, ${body.metadata || {}})
        RETURNING id, client_name, project_type, status, coverage, created_at, updated_at
      `;
      return jsonResponse({ session: row }, 201);
    }

    // Get one (with messages, files, page contexts)
    if (sessionId && req.method === 'GET') {
      const [session] = await sql`
        SELECT * FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}
      `;
      if (!session) return jsonResponse({ error: 'Not found' }, 404);
      const messages = await sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`;
      const files = await sql`SELECT id, name, mime_type, size_bytes, uploaded_at FROM files WHERE session_id = ${sessionId}`;
      const pageContexts = await sql`SELECT id, url, title, captured_at FROM page_contexts WHERE session_id = ${sessionId} ORDER BY captured_at DESC LIMIT 50`;
      return jsonResponse({ session, messages, files, pageContexts });
    }

    // Update
    if (sessionId && req.method === 'PUT') {
      const body = await readJson(req);
      const [updated] = await sql`
        UPDATE sessions SET
          client_name = COALESCE(${body.clientName ?? null}, client_name),
          project_type = COALESCE(${body.projectType ?? null}, project_type),
          status = COALESCE(${body.status ?? null}, status),
          coverage = COALESCE(${body.coverage ? JSON.stringify(body.coverage) : null}::jsonb, coverage),
          updated_at = NOW()
        WHERE id = ${sessionId} AND user_id = ${user.id}
        RETURNING *
      `;
      if (!updated) return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse({ session: updated });
    }

    // Delete
    if (sessionId && req.method === 'DELETE') {
      await sql`DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('[sessions]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: ['/api/sessions', '/api/sessions/*'] };
