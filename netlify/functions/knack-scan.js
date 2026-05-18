// /api/knack/scan
// Body: { sessionId, appId, apiKey }
// Calls the Knack REST API to pull the full schema (objects, fields, connections).
// Stores a processed summary in backend_scans for injection into the chat system prompt.
// Raw API key is never persisted — only the app ID and processed schema are stored.

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

function processSchema(rawObjects) {
  const objectIndex = {};
  rawObjects.forEach(o => { objectIndex[o.key] = o.name; });

  return rawObjects.map(obj => {
    const fields = (obj.fields || []).map(f => {
      const out = { key: f.key, label: f.label, type: f.type, required: !!f.required };
      if (f.type === 'connection' && f.relationship) {
        out.connection = {
          object: f.relationship.object,
          objectName: objectIndex[f.relationship.object] || f.relationship.object,
          has: f.relationship.has  // 'one' | 'many'
        };
      }
      return out;
    });

    const connections = fields
      .filter(f => f.connection)
      .map(f => f.connection.objectName);

    return { key: obj.key, name: obj.name, fieldCount: fields.length, fields, connections };
  });
}

function formatSchemaForPrompt(objects) {
  const totalFields = objects.reduce((n, o) => n + o.fieldCount, 0);
  const lines = [`${objects.length} objects, ${totalFields} fields total\n`];

  for (const obj of objects) {
    lines.push(`• ${obj.name} (${obj.key}) — ${obj.fieldCount} fields${obj.connections.length ? ' | Connects to: ' + obj.connections.join(', ') : ''}`);
    for (const f of obj.fields.slice(0, 12)) {
      const conn = f.connection ? ` → ${f.connection.objectName} (${f.connection.has})` : '';
      const req  = f.required ? ' *' : '';
      lines.push(`    - ${f.label} [${f.type}${conn}]${req}`);
    }
    if (obj.fields.length > 12) lines.push(`    … and ${obj.fields.length - 12} more fields`);
  }
  return lines.join('\n');
}

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  // GET /api/knack/scan/status?sessionId=xxx — return existing scan summary
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return jsonResponse({ error: 'sessionId required' }, 400);
    const [scan] = await sql`
      SELECT bs.app_id, bs.summary FROM backend_scans bs
      JOIN sessions s ON s.id = bs.session_id
      WHERE bs.session_id = ${sessionId} AND s.user_id = ${user.id}
    `;
    if (!scan) return jsonResponse({ summary: null });
    return jsonResponse({ appId: scan.app_id, summary: scan.summary });
  }

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { sessionId, appId, apiKey } = await readJson(req);
  if (!sessionId || !appId || !apiKey) {
    return jsonResponse({ error: 'sessionId, appId, and apiKey required' }, 400);
  }

  const [session] = await sql`SELECT id FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
  if (!session) return jsonResponse({ error: 'Session not found' }, 404);

  // Pull schema from Knack
  const knackRes = await fetch('https://api.knack.com/v1/objects', {
    headers: {
      'X-Knack-Application-Id': appId,
      'X-Knack-REST-API-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!knackRes.ok) {
    const err = await knackRes.text();
    return jsonResponse({ error: `Knack API ${knackRes.status}: ${err}` }, 502);
  }

  const raw = await knackRes.json();
  const objects = processSchema(raw.objects || []);
  const promptText = formatSchemaForPrompt(objects);
  const summary = {
    objectCount: objects.length,
    totalFields: objects.reduce((n, o) => n + o.fieldCount, 0),
    objects,
    promptText
  };

  // Upsert — re-scan replaces the previous result
  await sql`
    INSERT INTO backend_scans (session_id, provider, app_id, raw_schema, summary)
    VALUES (${sessionId}, 'knack', ${appId}, ${JSON.stringify(raw)}, ${JSON.stringify(summary)})
    ON CONFLICT (session_id) DO UPDATE SET
      raw_schema = EXCLUDED.raw_schema,
      summary    = EXCLUDED.summary,
      app_id     = EXCLUDED.app_id,
      scanned_at = NOW()
  `;

  return jsonResponse({ summary });
};

export const config = { path: '/api/knack/scan' };
