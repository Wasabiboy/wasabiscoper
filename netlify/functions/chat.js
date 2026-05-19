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

const SPECIALIST_ROLES = {
  // knack-rebuild
  'views-pages':     'UI/UX analyst mapping every screen, view, form, table, and navigation path',
  'workflows':       'business process analyst mapping every workflow end-to-end with steps, triggers, decisions, and exceptions',
  'users-roles':     'identity and access specialist mapping every user type, permission level, and data visibility rule',
  'business-rules':  'business logic analyst mapping every validation, calculation, conditional display rule, and automated action',
  'integrations':    'integration architect mapping every connected system, data flow direction, API surface, and sync timing',
  'pain-points':     'user researcher uncovering exactly what is broken, slow, or missing — and the workarounds people use today',
  // zoho-rebuild
  'apps-forms':      'UI analyst mapping every Zoho Creator form, layout, and screen',
  // erp-integration
  'erp-system':      'ERP specialist cataloguing the existing system version, modules, and configuration',
  'integration-points': 'integration architect mapping every ERP connection point and data contract',
  'data-flows':      'data architect mapping every data flow, sync pattern, and ownership boundary',
  'auth-security':   'security architect mapping authentication, authorisation, and audit requirements',
  // custom-saas
  'current-saas':    'SaaS migration specialist assessing the current platform and its limitations',
  'usage-patterns':  'user researcher mapping usage behaviour, frequency, and power user workflows',
  'critical-features': 'product analyst mapping must-have functionality that cannot be compromised',
  'nice-to-have':    'product analyst mapping wishlist features and their business value',
  'data-export':     'data migration specialist assessing data portability and historical data requirements',
  // general
  'goal':        'project strategist clarifying success criteria, scope boundaries, and definition of done',
  'users':       'user researcher mapping all user personas, their goals, and their pain points',
  'data':        'data architect mapping entities, relationships, volumes, and data sources',
  'constraints': 'project manager mapping budget, timeline, technology, and compliance constraints',
};

function buildSystemPrompt(session, backendScan, focusCategory) {
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

  let focusSection = '';
  if (focusCategory) {
    const cat = cats.find(c => c.id === focusCategory);
    if (cat) {
      const role = SPECIALIST_ROLES[focusCategory] || 'specialist';
      focusSection = `

FOCUS MODE — ${cat.label.toUpperCase()}:
You are now acting as a ${role}. For THIS TURN, concentrate entirely on "${cat.label}" (${cat.desc}).
- Ask the single most targeted question that would reveal the most about this category
- Reference specific things already known about this project where relevant
- Probe for edge cases, exceptions, and specifics within this category only
- Do not drift to other categories this turn
- After your question, emit a coverage update as usual`;
    }
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
3. When you receive a screenshot (may be a stitched full-page composite covering several scroll positions), give a ONE-LINE summary of what you see ("Looks like a job detail form with about 12 fields") then ask ONE targeted question about something that needs clarification — a field whose purpose is unclear, a status you haven't mapped, a relationship that isn't obvious. Ignore minor strip overlap/gaps from stitching. Do NOT read back a full list of field names or enumerate everything visible.
4. When you receive user activity events, use them silently as context. Only mention them if they reveal something worth asking about (e.g. the user submitted a form you haven't discussed yet).
5. Probe for edge cases, exceptions, and integrations.
6. If the user uploads a document, acknowledge it briefly and ask the one most useful question from it.
7. After every 3-4 exchanges, briefly summarise what you've learned about one category in 1-2 sentences.
8. After EVERY reply, assess each coverage category and emit an update tag:
   <coverage>{"category-id": "status"}</coverage>
   Rules:
   - "partial" = you have some useful information but key gaps remain
   - "done" = you have enough detail to write that section of the scope doc
   - Only include categories whose status has changed — don't repeat unchanged ones
   - Be generous with "partial" after even one useful exchange on a topic
   - Mark "done" once you know: the main screens/flows, who uses it, the key rules/exceptions
   Always emit this tag, even if nothing changed (emit an empty object {} if truly no change).
9. Be conversational, direct, NZ-friendly. No corporate fluff. Treat the user as a peer.
10. If the user seems stuck, suggest they demonstrate something on screen rather than describing it.
11. PAGE CONTEXT JSON may include platformHints (Knack runtime, Zoho Creator signals, iframe count). Use them to ask precise, product-specific questions when present.
12. Integrations: explicitly probe for accounting (Xero, MYOB, QuickBooks), payments (Stripe), automation (Zapier, Make), email (transactional/SMTP), webhooks, calendar sync, and exports/CSV — and map inbound vs outbound and which system owns the truth.${focusSection}`;
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
    const { sessionId, userMessage, pageContext, fileContent, fileName, screenshotDataUrl, pageActivity, focusCategory } = body;
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
        system: buildSystemPrompt(session, backendScan, focusCategory || null),
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
