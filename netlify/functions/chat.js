// /api/chat
// Body: { sessionId, userMessage, pageContext?, fileContent?, fileName?, screenshotDataUrl? }
// - Loads full chat history
// - Optionally uploads screenshot to Netlify Blobs and passes to Claude vision
// - Calls Claude with system prompt + history + vision
// - Persists messages, parses <coverage> tags
// - Stores screenshot key in page_contexts so the scope doc can embed them later

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';
import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

const REQUIREMENT_CATEGORIES = {
  // Frontend walkthrough categories only — data model is covered by the backend scan,
  // migration/volume are a separate conversation after the builder review.
  'knack-rebuild': [
    { id: 'views-pages', label: 'Views & pages', desc: 'Forms, tables, dashboards, menus' },
    { id: 'workflows', label: 'Core workflows', desc: 'Day-to-day tasks, sequences, approvals' },
    { id: 'users-roles', label: 'Users & roles', desc: 'Who logs in, what they can see and do' },
    { id: 'business-rules', label: 'Business rules', desc: 'Validations, calculations, conditional logic' },
    { id: 'integrations', label: 'Integrations', desc: 'Email, Xero, Stripe, webhooks, exports' },
    { id: 'pain-points', label: 'Pain points', desc: 'What breaks, is slow, or is missing' },
  ],
  'zoho-rebuild': [
    { id: 'apps-forms', label: 'Apps & forms', desc: 'Screens, fields, layouts' },
    { id: 'workflows', label: 'Workflows & automations', desc: 'Deluge scripts, triggers, approvals' },
    { id: 'users-roles', label: 'Users & permissions', desc: 'Role-based access' },
    { id: 'integrations', label: 'Connected services', desc: 'Books, CRM, APIs' },
    { id: 'pain-points', label: 'Pain points', desc: 'Why move off Zoho?' },
  ],
  'erp-integration': [
    { id: 'erp-system', label: 'ERP details', desc: 'Vendor, version, on-prem/cloud' },
    { id: 'integration-points', label: 'Integration points', desc: 'APIs, IDocs, files, DB' },
    { id: 'workflows', label: 'Workflows to liberate', desc: 'Which processes need modern UI' },
    { id: 'users-roles', label: 'Users & roles', desc: 'Who uses the new interface' },
    { id: 'data-flows', label: 'Data flows', desc: 'Read vs write-back, sync timing' },
    { id: 'auth-security', label: 'Auth & security', desc: 'SSO, RBAC, audit' },
    { id: 'pain-points', label: 'Pain points', desc: 'What ERP UI fails at' }
  ],
  'custom-saas': [
    { id: 'current-saas', label: 'Current SaaS', desc: 'Product, plan, cost' },
    { id: 'usage-patterns', label: 'Usage patterns', desc: 'Who, how often, for what' },
    { id: 'critical-features', label: 'Critical features', desc: 'Must-haves' },
    { id: 'nice-to-have', label: 'Nice-to-have', desc: 'Wishlist' },
    { id: 'data-export', label: 'Data export', desc: 'Can we extract history' },
    { id: 'integrations', label: 'Integrations', desc: 'Connected systems' }
  ],
  'general': [
    { id: 'goal', label: 'Goal & success', desc: 'What done looks like' },
    { id: 'users', label: 'Users', desc: 'Personas and counts' },
    { id: 'workflows', label: 'Workflows', desc: 'Core flows' },
    { id: 'data', label: 'Data', desc: 'Entities and sources' },
    { id: 'integrations', label: 'Integrations', desc: 'External systems' },
    { id: 'constraints', label: 'Constraints', desc: 'Budget, time, tech' }
  ]
};

function buildSystemPrompt(session, backendScan) {
  const cats = REQUIREMENT_CATEGORIES[session.project_type] || REQUIREMENT_CATEGORIES.general;
  const coverage = session.coverage || {};
  const coverageList = cats.map(c => `- ${c.label} (${c.id}): ${coverage[c.id] || 'unknown'} — ${c.desc}`).join('\n');

  let backendSection = '';
  if (backendScan?.summary?.promptText) {
    backendSection = `
KNACK BACKEND SCHEMA (${backendScan.app_id}):
${backendScan.summary.promptText}

Use this schema to ask precise questions — e.g. reference specific object names, field labels, and connection relationships you see above. When the client describes a workflow, map it to the actual objects and fields.`;
  }

  return `You are a senior software architect from Wasabi Digital (Auckland, NZ), scoping a project for a client.

Your job is to interview the client while they demonstrate their existing software, extracting enough detail that a developer could rebuild it. You combine deep technical knowledge (Knack, Zoho Creator, ERP systems, React, Node, Postgres) with sharp consulting instincts.

PROJECT TYPE: ${session.project_type}
CLIENT: ${session.client_name || 'Unspecified'}

REQUIREMENTS COVERAGE STATUS:
${coverageList}
${backendSection}
RULES OF ENGAGEMENT:
1. Ask ONE focused question at a time. Never stack multiple questions.
2. Prioritise the LEAST-covered categories. Start with data model and core workflows.
3. When you receive a screenshot or page/DOM context, give a ONE-LINE summary of what you see ("Looks like a job detail form with about 12 fields") then ask ONE targeted question about something that needs clarification — a field whose purpose is unclear, a status you haven't mapped, a relationship that isn't obvious. Do NOT read back a list of field names or enumerate everything visible.
4. When you receive user activity events, use them silently as context. Only mention them if they reveal something worth asking about (e.g. the user submitted a form you haven't discussed yet).
5. Probe for edge cases, exceptions, and integrations.
6. If the user uploads a document, acknowledge it briefly and ask the one most useful question from it.
7. After every 3-4 exchanges, briefly summarise what you've learned about one category in 1-2 sentences.
8. To update coverage, include a JSON object on its own line in this exact format:
   <coverage>{"category-id": "done", "another-id": "partial"}</coverage>
   The user won't see this — it's parsed out.
9. Be conversational, direct, NZ-friendly. No corporate fluff. Treat the user as a peer.
10. If the user seems stuck, suggest they demonstrate something on screen rather than describing it.`;
}

function parseCoverageUpdates(text) {
  const match = text.match(/<coverage>([\s\S]*?)<\/coverage>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

// Parse a data URL like "data:image/jpeg;base64,XXX" into {mediaType, base64}
function parseDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

async function uploadScreenshot(sessionId, dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;

  const store = getStore('wasabi-screenshots');
  const key = `${sessionId}/${Date.now()}.jpg`;
  const buf = Buffer.from(parsed.base64, 'base64');
  await store.set(key, buf, { metadata: { mediaType: parsed.mediaType } });
  return { key, mediaType: parsed.mediaType, base64: parsed.base64 };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  if (!ANTHROPIC_API_KEY) {
    return jsonResponse({ error: 'Server misconfigured — ANTHROPIC_API_KEY not set' }, 500);
  }

  try {
    const body = await readJson(req);
    const { sessionId, userMessage, pageContext, fileContent, fileName, screenshotDataUrl, pageActivity } = body;
    if (!sessionId || !userMessage) {
      return jsonResponse({ error: 'sessionId and userMessage required' }, 400);
    }

    const [session] = await sql`
      SELECT * FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}
    `;
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    const [backendScan] = await sql`
      SELECT app_id, summary FROM backend_scans WHERE session_id = ${sessionId}
    `;

    // Persist the user message
    await sql`INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, 'user', ${userMessage})`;

    // Handle screenshot — upload to blobs, save reference in page_contexts
    let screenshotInfo = null;
    if (screenshotDataUrl) {
      try {
        screenshotInfo = await uploadScreenshot(sessionId, screenshotDataUrl);
        if (screenshotInfo) {
          await sql`
            INSERT INTO page_contexts (session_id, url, title, context, screenshot_blob_key)
            VALUES (
              ${sessionId},
              ${pageContext?.url || null},
              ${pageContext?.title || null},
              ${JSON.stringify(pageContext || {})},
              ${screenshotInfo.key}
            )
          `;
        }
      } catch (e) {
        console.error('Screenshot upload failed:', e);
        // Continue without screenshot rather than failing the whole turn
      }
    } else if (pageContext) {
      // No screenshot but we have DOM context
      await sql`
        INSERT INTO page_contexts (session_id, url, title, context)
        VALUES (${sessionId}, ${pageContext.url || null}, ${pageContext.title || null}, ${JSON.stringify(pageContext)})
      `;
    }

    // Load full history
    const history = await sql`
      SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at
    `;

    // Build messages array
    const messages = [];
    for (let i = 0; i < history.length - 1; i++) {
      messages.push({ role: history[i].role, content: history[i].content });
    }

    // Build the LAST user message with optional inline context, file content, and image
    const lastUserBlocks = [];
    if (pageActivity) {
      lastUserBlocks.push({
        type: 'text',
        text: `[USER ACTIVITY — what happened since the last message]\n${pageActivity}`
      });
    }
    if (pageContext) {
      lastUserBlocks.push({
        type: 'text',
        text: `[PAGE CONTEXT]\n${JSON.stringify(pageContext, null, 2)}`
      });
    }
    if (fileContent) {
      lastUserBlocks.push({
        type: 'text',
        text: `[DOCUMENT: ${fileName || 'attachment'}]\n${fileContent.slice(0, 8000)}`
      });
    }
    if (screenshotInfo) {
      lastUserBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: screenshotInfo.mediaType,
          data: screenshotInfo.base64
        }
      });
    }
    lastUserBlocks.push({ type: 'text', text: userMessage });

    messages.push({ role: 'user', content: lastUserBlocks });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: buildSystemPrompt(session, backendScan),
        messages
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return jsonResponse({ error: `Claude API ${claudeRes.status}: ${errText}` }, 502);
    }

    const data = await claudeRes.json();
    const reply = data.content[0].text;

    const coverageUpdate = parseCoverageUpdates(reply);
    if (coverageUpdate) {
      await sql`
        UPDATE sessions
        SET coverage = coverage || ${JSON.stringify(coverageUpdate)}::jsonb
        WHERE id = ${sessionId}
      `;
    }

    await sql`
      INSERT INTO messages (session_id, role, content, metadata)
      VALUES (${sessionId}, 'assistant', ${reply}, ${JSON.stringify({ model: MODEL, usage: data.usage, hadScreenshot: !!screenshotInfo })})
    `;

    const [updated] = await sql`SELECT coverage FROM sessions WHERE id = ${sessionId}`;
    return jsonResponse({ reply, coverage: updated.coverage, screenshotStored: !!screenshotInfo });
  } catch (e) {
    console.error('[chat]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/chat' };
