// /api/transcribe
// multipart/form-data with: file (audio blob), sessionId
// Server holds OPENAI_API_KEY in env, calls Whisper, persists transcript.

import { sql, jsonResponse, handleOptions, requireUser } from './_lib.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  if (!OPENAI_API_KEY) {
    return jsonResponse({ error: 'Server misconfigured — OPENAI_API_KEY not set' }, 500);
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const sessionId = formData.get('sessionId');

    if (!file || !sessionId) {
      return jsonResponse({ error: 'file and sessionId required' }, 400);
    }

    const [session] = await sql`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    // Forward to Whisper
    const whisperForm = new FormData();
    const name = typeof file.name === 'string' && file.name ? file.name : 'recording.webm';
    const fileType = typeof file.type === 'string' && file.type ? file.type : 'audio/webm';
    console.log('[transcribe] Forwarding to Whisper:', { name, type: fileType, size: typeof file.size === 'number' ? file.size : 'unknown' });
    whisperForm.append('file', file, name);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('language', 'en');

    const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
      body: whisperForm
    });
    const wText = await wRes.text();
    console.log('[transcribe] Whisper response:', wRes.status, wText.slice(0, 300));
    if (!wRes.ok) {
      return jsonResponse({ error: `Whisper ${wRes.status}: ${wText}` }, 502);
    }
    const result = JSON.parse(wText);
    console.log('[transcribe] Whisper transcript:', result.text ? `"${result.text.slice(0, 120)}…"` : '(empty)');

    const [row] = await sql`
      INSERT INTO transcripts (session_id, source, text)
      VALUES (${sessionId}, 'whisper', ${result.text || ''})
      RETURNING id, text, created_at
    `;
    return jsonResponse({ transcript: row });
  } catch (e) {
    console.error('[transcribe]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/transcribe' };
