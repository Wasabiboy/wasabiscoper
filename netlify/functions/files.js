// /api/files
// Body: { sessionId, name, mimeType, sizeBytes, textContent? }
// Stores file metadata + extracted text. For binary files (PDFs, images), v0.2 will use Netlify Blobs.

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { sessionId, name, mimeType, sizeBytes, textContent } = await readJson(req);
    if (!sessionId || !name) return jsonResponse({ error: 'sessionId and name required' }, 400);

    // Verify session ownership
    const [session] = await sql`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    const [row] = await sql`
      INSERT INTO files (session_id, name, mime_type, size_bytes, text_content)
      VALUES (${sessionId}, ${name}, ${mimeType || null}, ${sizeBytes || null}, ${textContent || null})
      RETURNING id, name, mime_type, size_bytes, uploaded_at
    `;
    return jsonResponse({ file: row }, 201);
  } catch (e) {
    console.error('[files]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/files' };
