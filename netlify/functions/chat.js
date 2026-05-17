// /api/chat
// Body: { sessionId, userMessage, pageContext?, fileContent?, fileName? }
// - Loads full chat history from DB
// - Builds the system prompt with current coverage state
// - Calls Claude (Anthropic key from server env, never exposed to extension)
// - Parses <coverage> tags from reply, updates sessions.coverage
// - Persists user + assistant messages
// - Returns the reply

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

const REQUIREMENT_CATEGORIES = {
  'knack-rebuild': [
    { id: 'data-model', label: 'Data model & entities', desc: 'Tables, fields, relationships, key constraints' },
    { id: 'users-roles', label: 'Users & roles', desc: 'Who logs in, what they can see/do' },
    { id: 'workflows', label: 'Core workflows', desc: 'Day-to-day tasks, sequences, approvals' },
    { id: 'views-pages', label: 'Views & pages', desc: 'Forms, tables, dashboards, reports' },
    { id: 'business-rules', label: 'Business rules', desc: 'Validations, calculations, conditional logic' },
    { id: 'integrations', label: 'Integrations', desc: 'Email, Xero, Stripe, webhooks, exports' },
    { id: 'data-volume', label: 'Data volume & growth', desc: 'Record counts, expected growth' },
    { id: 'reporting', label: 'Reporting & analytics', desc: 'What gets measured, by whom, how often' },
    { id: 'pain-points', label: 'Current pain points', desc: 'What breaks, slow, or missing' },
    { id: 'migration', label: 'Migration & cutover', desc: 'Historic data, downtime tolerance' }
  ],
  'zoho-rebuild': [
    { id: 'apps-forms', label: 'Apps, forms, reports', desc: 'Creator structure to be replicated' },
    { id: 'workflows', label: 'Workflows & deluge', desc: 'Existing scripts and automations' },
    { id: 'users-roles', label: 'Users & permissions', desc: 'Role-based access' },
    { id: 'integrations', label: 'Connected services', desc: 'Books, CRM, third-party APIs' },
    { id: 'data-model', label: 'Data model', desc: 'Forms, fields, relationships' },
    { id: 'pain-points', label: 'Pain points', desc: 'Why move off Zoho?' },
    { id: 'migration', label: 'Migration plan', desc: 'Historic data, cutover' }
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

function buildSystemPrompt(session) {
  const cats = REQUIREMENT_CATEGORIES[session.project_type] || REQUIREMENT_CATEGORIES.general;
  const coverage = session.coverage || {};
  const coverageList = cats.map(c => `- ${c.label} (${c.id}): ${coverage[c.id] || 'unknown'} — ${c.desc}`).join('\n');

  return `You are a senior software architect from Wasabi Digital (Auckland, NZ), scoping a project for a client.

Your job is to interview the client while they demonstrate their existing software, extracting enough detail that a developer could rebuild it. You combine deep technical knowledge (Knack, Zoho Creator, ERP systems, React, Node, Postgres) with sharp consulting instincts.

PROJECT TYPE: ${session.project_type}
CLIENT: ${session.client_name || 'Unspecified'}

REQUIREMENTS COVERAGE STATUS:
${coverageList}

RULES OF ENGAGEMENT:
1. Ask ONE focused question at a time. Never stack multiple questions.
2. Prioritise the LEAST-covered categories. Start with data model and core workflows.
3. When the user shares page context (URL, forms, tables), reference specific things you see — "I notice your job table has a 'Status' column with values like 'Quoted', 'Confirmed'. What triggers each transition?"
4. Probe for edge cases, exceptions, and integrations.
5. If the user uploads a document, refer to it explicitly.
6. After every 3-4 exchanges, briefly summarise what you've learned about one category.
7. To update coverage, include a JSON object on its own line in this exact format:
   <coverage>{"category-id": "done", "another-id": "partial"}</coverage>
   The user won't see this — it's parsed out.
8. Be conversational, direct, NZ-friendly. No corporate fluff. Treat the user as a peer.
9. If the user seems stuck, suggest they demonstrate something on screen rather than describing it.`;
}

function parseCoverageUpdates(text) {
  const match = text.match(/<coverage>([\s\S]*?)<\/coverage>/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
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
    const { sessionId, userMessage, pageContext, fileContent, fileName } = body;
    if (!sessionId || !userMessage) {
      return jsonResponse({ error: 'sessionId and userMessage required' }, 400);
    }

    const [session] = await sql`
      SELECT * FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}
    `;
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    // Persist the user message first
    await sql`INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, 'user', ${userMessage})`;

    // Save page context if attached
    if (pageContext) {
      await sql`
        INSERT INTO page_contexts (session_id, url, title, context)
        VALUES (${sessionId}, ${pageContext.url || null}, ${pageContext.title || null}, ${JSON.stringify(pageContext)})
      `;
    }

    // Load full history for the model
    const history = await sql`
      SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at
    `;

    // Build messages array, injecting context blocks as preceding user turns
    const messages = [];
    for (const msg of history) {
      messages.push({ role: msg.role, content: msg.content });
    }
    // Inject inline context just before the latest user message
    if (pageContext || fileContent) {
      const lastUser = messages.pop();
      if (pageContext) {
        messages.push({ role: 'user', content: `[PAGE CONTEXT]\n${JSON.stringify(pageContext, null, 2)}` });
      }
      if (fileContent) {
        messages.push({ role: 'user', content: `[DOCUMENT: ${fileName || 'attachment'}]\n${fileContent.slice(0, 8000)}` });
      }
      messages.push(lastUser);
    }

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
        system: buildSystemPrompt(session),
        messages
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return jsonResponse({ error: `Claude API ${claudeRes.status}: ${errText}` }, 502);
    }

    const data = await claudeRes.json();
    const reply = data.content[0].text;

    // Parse coverage updates and merge
    const coverageUpdate = parseCoverageUpdates(reply);
    if (coverageUpdate) {
      await sql`
        UPDATE sessions
        SET coverage = coverage || ${JSON.stringify(coverageUpdate)}::jsonb
        WHERE id = ${sessionId}
      `;
    }

    // Persist assistant reply
    await sql`
      INSERT INTO messages (session_id, role, content, metadata)
      VALUES (${sessionId}, 'assistant', ${reply}, ${JSON.stringify({ model: MODEL, usage: data.usage })})
    `;

    // Return reply + updated coverage so the extension can update the UI
    const [updated] = await sql`SELECT coverage FROM sessions WHERE id = ${sessionId}`;
    return jsonResponse({ reply, coverage: updated.coverage });
  } catch (e) {
    console.error('[chat]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/chat' };
