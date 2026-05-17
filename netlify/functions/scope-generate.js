// /api/scope/generate
// Body: { sessionId }
// Generates a complete markdown scoping doc, persists it as a versioned scope_document, returns it.

import { sql, jsonResponse, handleOptions, requireUser, readJson } from './_lib.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  try {
    const { sessionId } = await readJson(req);
    if (!sessionId) return jsonResponse({ error: 'sessionId required' }, 400);

    const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    const history = await sql`SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`;
    const files = await sql`SELECT name, mime_type, size_bytes FROM files WHERE session_id = ${sessionId}`;

    const prompt = `Based on our entire conversation, generate a complete scoping document in markdown for ${session.client_name || 'the client'} — project type: ${session.project_type}.

Structure:
# Project scoping — ${session.client_name || 'Client'}
## Executive summary
(2-3 sentences: what we're building, who for, why)

## Project context
- Client: ${session.client_name || 'TBD'}
- Project type: ${session.project_type}
- Files reviewed: ${files.map(f => f.name).join(', ') || 'none'}

## Requirements

### Data model
(Specific entities, fields, relationships the user described or you observed in page contexts)

### Users & roles
### Workflows
### Integrations
### Business rules & validations
### Reporting needs
### Pain points to solve

## Proposed architecture
(Stack recommendation, key decisions, rationale)

## Effort estimate
(Total weeks, with low/mid/high confidence ranges. Break down by major phase.)

## Risks & assumptions
(Numbered list)

## Open questions
(Things explicitly NOT covered yet — be honest)

## Recommended next steps
(3-5 actions)

Be specific. Cite things the user actually said. Include real field names, workflow names, integration points. Don't invent details. If something is unknown, say so under Open questions.`;

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: prompt });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return jsonResponse({ error: `Claude API ${claudeRes.status}: ${errText}` }, 502);
    }
    const data = await claudeRes.json();
    const markdown = data.content[0].text;

    // Versioned save
    const [existing] = await sql`SELECT COALESCE(MAX(version), 0) AS v FROM scope_documents WHERE session_id = ${sessionId}`;
    const version = (existing?.v || 0) + 1;
    const [doc] = await sql`
      INSERT INTO scope_documents (session_id, version, content_md)
      VALUES (${sessionId}, ${version}, ${markdown})
      RETURNING id, version, generated_at
    `;

    return jsonResponse({ document: { ...doc, content_md: markdown } });
  } catch (e) {
    console.error('[scope-generate]', e);
    return jsonResponse({ error: e.message }, 500);
  }
};

export const config = { path: '/api/scope/generate' };
