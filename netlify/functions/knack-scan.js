// /api/knack/scan
// Fetches both the data model (objects/fields) and the page structure (scenes/views)
// from the Knack REST API, so Claude has the full picture of the app.
// Raw API key is never persisted — only app ID and processed summaries are stored.

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

const KNACK_HEADERS = (appId, apiKey) => ({
  'X-Knack-Application-Id': appId,
  'X-Knack-REST-API-Key': apiKey,
  'Content-Type': 'application/json'
});

async function knackGet(path, appId, apiKey) {
  const res = await fetch(`https://api.knack.com/v1/${path}`, {
    headers: KNACK_HEADERS(appId, apiKey)
  });
  if (!res.ok) throw new Error(`Knack API ${res.status} on /${path}: ${await res.text()}`);
  return res.json();
}

// --- Objects / data model ---

function processObjects(rawObjects) {
  const objectIndex = {};
  rawObjects.forEach(o => { objectIndex[o.key] = o.name; });

  return rawObjects.map(obj => {
    const fields = (obj.fields || []).map(f => {
      const out = { key: f.key, label: f.label, type: f.type, required: !!f.required };
      if (f.type === 'connection' && f.relationship) {
        out.connection = {
          object: f.relationship.object,
          objectName: objectIndex[f.relationship.object] || f.relationship.object,
          has: f.relationship.has
        };
      }
      return out;
    });
    const connections = fields.filter(f => f.connection).map(f => f.connection.objectName);
    return { key: obj.key, name: obj.name, fieldCount: fields.length, fields, connections };
  });
}

function formatObjectsForPrompt(objects) {
  const totalFields = objects.reduce((n, o) => n + o.fieldCount, 0);
  const lines = [`DATA MODEL — ${objects.length} objects, ${totalFields} fields\n`];
  for (const obj of objects) {
    lines.push(`• ${obj.name} (${obj.key}) — ${obj.fieldCount} fields${obj.connections.length ? ' | connects to: ' + obj.connections.join(', ') : ''}`);
    for (const f of obj.fields.slice(0, 12)) {
      const conn = f.connection ? ` → ${f.connection.objectName} (${f.connection.has})` : '';
      const req  = f.required ? ' *' : '';
      lines.push(`    - ${f.label} [${f.type}${conn}]${req}`);
    }
    if (obj.fields.length > 12) lines.push(`    … and ${obj.fields.length - 12} more fields`);
  }
  return lines.join('\n');
}

// --- Scenes / views (pages and UI) ---

const VIEW_TYPE_LABELS = {
  table: 'Table', form: 'Form', details: 'Details', search: 'Search',
  menu: 'Menu', list: 'List', map: 'Map', calendar: 'Calendar',
  report: 'Report/Chart', login: 'Login', registration: 'Registration',
  rich_text: 'Rich Text', checkout: 'Checkout', customer_portal: 'Customer Portal'
};

function processScenes(rawScenes, objectIndex) {
  return (rawScenes || []).map(scene => {
    const views = (scene.views || []).map(v => {
      const label = VIEW_TYPE_LABELS[v.type] || v.type;
      const source = v.source?.object
        ? (objectIndex[v.source.object] || v.source.object)
        : null;
      return {
        key: v.key,
        name: v.name,
        type: v.type,
        typeLabel: label,
        sourceObject: source
      };
    });
    return {
      key: scene.key,
      name: scene.name,
      slug: scene.slug || null,
      authenticated: !!scene.authenticated,
      viewCount: views.length,
      views
    };
  });
}

function formatScenesForPrompt(scenes) {
  if (!scenes.length) return '';
  const lines = [`\nPAGE STRUCTURE — ${scenes.length} pages\n`];
  for (const scene of scenes) {
    const auth = scene.authenticated ? ' [login required]' : '';
    lines.push(`• ${scene.name} (${scene.key})${auth}`);
    for (const v of scene.views) {
      const src = v.sourceObject ? ` — data: ${v.sourceObject}` : '';
      lines.push(`    - ${v.name} [${v.typeLabel}${src}]`);
    }
  }
  return lines.join('\n');
}

// --- Handler ---

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

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

  // Fetch objects and scenes in parallel
  const [rawObjects, rawScenes] = await Promise.all([
    knackGet('objects', appId, apiKey),
    knackGet('scenes', appId, apiKey).catch(() => ({ scenes: [] })) // scenes endpoint may not exist on all plans
  ]);

  const objectIndex = {};
  (rawObjects.objects || []).forEach(o => { objectIndex[o.key] = o.name; });

  const objects = processObjects(rawObjects.objects || []);
  const scenes  = processScenes(rawScenes.scenes || [], objectIndex);

  const objectsPromptText = formatObjectsForPrompt(objects);
  const scenesPromptText  = formatScenesForPrompt(scenes);
  const promptText = objectsPromptText + scenesPromptText;

  const summary = {
    objectCount: objects.length,
    totalFields: objects.reduce((n, o) => n + o.fieldCount, 0),
    sceneCount: scenes.length,
    objects,
    scenes,
    promptText
  };

  const raw = { objects: rawObjects, scenes: rawScenes };

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
