// /api/scope/generate
// Streams a full technical migration scope as SSE.
// For knack-rebuild sessions with a backend scan, generates PostgreSQL DDL,
// TypeScript interfaces, API endpoint map, and component architecture.
// Events: { delta: "text" } while streaming, { done: true, version, id, url } when saved.

import { sql, handleOptions, requireUser, readJson, jsonResponse } from './_lib.js';
import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-wasabi-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function buildKnackMigrationPrompt(session, files, backendScan, pagesVisited, screenshotCount) {
  const schemaSection = backendScan?.summary?.promptText
    ? `KNACK APP SCHEMA — ${backendScan.app_id}
${backendScan.summary.promptText}

`
    : '';

  const filesLine = files.length ? files.map(f => f.name).join(', ') : 'none';
  const pagesLine = pagesVisited.length ? pagesVisited.slice(0, 15).join(', ') : 'none recorded';

  return `Based on our entire scoping conversation, generate a complete technical migration specification in markdown.

${schemaSection}CLIENT: ${session.client_name || 'TBD'}
PROJECT: Knack app rebuild → React / TypeScript / Node.js / PostgreSQL
Files reviewed: ${filesLine}
Screens observed: ${pagesLine} (${screenshotCount} screenshots captured)

Produce the document below. Be specific — reference the actual schema objects and fields above, and things the client said in our conversation. Do not pad with generic advice or invent features not discussed.

---

# Migration Scope: ${session.client_name || 'Client'}
*Prepared by Wasabi Digital · ${new Date().toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' })}*

## 1. Executive Summary
3–4 sentences: what is being rebuilt, why, and the key architectural decision.

## 2. Current System Analysis

### 2.1 App Overview
Summarise the app's purpose, scale, and key user roles based on the conversation.

### 2.2 Object Inventory
For each Knack object in the schema, one paragraph covering: business purpose, critical fields, and key relationships. Group logically if many objects.

### 2.3 Identified Pain Points
What is broken, slow, or missing. Quote or paraphrase specific things the client said.

### 2.4 Custom Behaviour to Port
Any automations, calculated fields, conditional logic, or integrations mentioned.

## 3. Proposed Architecture

### 3.1 Tech Stack Decision
| Layer | Technology | Rationale |
|---|---|---|
| Frontend | React 19 + TypeScript + Vite | |
| UI | Tailwind CSS + shadcn/ui | |
| Routing | React Router v7 | |
| Server state | TanStack Query | |
| Backend | Node.js + TypeScript + Fastify | |
| Database | PostgreSQL on Neon (serverless) | |
| Auth | [recommend based on roles discussed] | |
| File storage | [recommend based on file fields found] | |
| Hosting | Netlify (frontend) + Railway or Render (API) | |
| Background jobs | [only if automation rules require it] | |

Fill in the Rationale column with 1-line justifications relevant to this client.

### 3.2 System Diagram
Draw a simple ASCII diagram: Browser → React SPA → Fastify API → PostgreSQL + any integrations.

## 4. PostgreSQL Data Model

Knack → PostgreSQL type mappings used:
- short_text / paragraph_text → TEXT
- number → NUMERIC(15,4), currency → NUMERIC(15,2)
- boolean → BOOLEAN
- date_time → TIMESTAMPTZ, date → DATE
- email / phone / link → TEXT
- address / name → JSONB
- file / image → TEXT (URL reference)
- multiple_choice (single) → TEXT, multiple_choice (multi) → TEXT[]
- connection has=one → INTEGER FK column on child table
- connection has=many → junction table
- equation / formula → GENERATED ALWAYS AS or VIEW

For EVERY Knack object in the schema above, produce:

### \`table_name\`
> *Knack: Object Name (object_key)*

Brief description of what this table represents.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| id | SERIAL | PRIMARY KEY | |
| knack_id | TEXT | UNIQUE NOT NULL | Knack record ID — needed for migration reconciliation |
| … | … | … | Map every Knack field |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | |

\`\`\`sql
CREATE TABLE table_name (
  id SERIAL PRIMARY KEY,
  knack_id TEXT UNIQUE NOT NULL,
  -- columns derived from Knack fields
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
\`\`\`

After all tables, add a ### Relationships section summarising all FK relationships.

## 5. TypeScript Domain Types

For each table, produce a TypeScript interface using camelCase property names derived from Knack field labels.

\`\`\`typescript
// types/[tableName].ts
export interface TableName {
  id: number;
  // ... one property per column
}

export type CreateTableNameInput = Omit<TableName, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateTableNameInput = Partial<CreateTableNameInput>;
\`\`\`

## 6. API Design

### 6.1 Endpoint Map
| Method | Path | Auth | Description |
|---|---|---|---|

Produce CRUD endpoints for each entity plus any custom action endpoints that match workflows discussed.

### 6.2 Auth Middleware
Describe the JWT / session strategy and which role levels have access to which endpoints.

## 7. Frontend Architecture

### 7.1 Page & Route Map
| Route | Page Component | Description |
|---|---|---|

Derive from Knack views seen in screenshots and pages mentioned in conversation.

### 7.2 Key Reusable Components
List components needed (data tables, forms, modals, status badges etc.) with a brief description.

### 7.3 Form Architecture
For each major entity, describe the form fields, validation rules, and submit behaviour.

## 8. Auth & Roles

| Role | Description | Permissions |
|---|---|---|

If a permission matrix is appropriate, produce one: rows = roles, columns = entities, cells = CRUD access.

## 9. Business Logic & Workflows

For each workflow or rule identified in the conversation:

| # | Rule / Workflow | Trigger | Logic | Implementation |
|---|---|---|---|---|

Implementation options: DB constraint, API validation layer, Fastify hook, background job, cron.

## 10. Integrations

For each integration mentioned:
- **System**: name
- **Direction**: inbound / outbound / bidirectional
- **Data**: what flows
- **Approach**: REST webhook / SDK / scheduled sync
- **Complexity**: low / medium / high

## 11. Reporting & Analytics

List each report or dashboard needed, data source, and suggested implementation (server-rendered table, Chart.js, Recharts, etc.).

## 12. Data Migration Plan

| Phase | Task | Notes |
|---|---|---|
| 1 | Create PostgreSQL schema | Run DDL from Section 4 |
| 2 | Extract from Knack | Paginated REST API, 1000 records/page, 120ms delay |
| 3 | Transform & load | Node.js scripts per object, in dependency order |
| 4 | Resolve FKs | Map Knack IDs → PostgreSQL integer IDs |
| 5 | Validate | Record counts, null audit, FK integrity, formula spot-checks |
| 6 | Cutover | Freeze Knack, final delta load, DNS switch |

Note any objects with large record counts or complex relationships that need special handling.

## 13. Effort Estimate

| Phase | Scope | Days |
|---|---|---|
| 0 | Project setup, CI/CD, environments | |
| 1 | Data model + migration scripts | |
| 2 | API — core CRUD | |
| 3 | Auth & roles | |
| 4 | Frontend — core screens | |
| 5 | Business logic & workflows | |
| 6 | Integrations | |
| 7 | Reporting | |
| 8 | Testing + QA | |
| 9 | Migration cutover + hypercare | |
| | **Total** | **X–Y days** |

Include a confidence note (e.g. "±30% — dependent on open questions below").

## 14. Risks & Assumptions

Bullet list. Distinguish between risks (things that could blow out scope) and assumptions (things we're taking as true).

## 15. Open Questions

Numbered list of things still to confirm before build begins.

---

Reminder: every section should be grounded in the actual schema and conversation. If something wasn't discussed, write "Not yet scoped — needs a follow-up conversation" rather than inventing it.`;
}

function buildGeneralPrompt(session, files, backendScan, pagesVisited) {
  const schemaSection = backendScan?.summary?.promptText
    ? `\nBACKEND SCHEMA:\n${backendScan.summary.promptText}\n`
    : '';
  return `Based on our entire conversation, generate a complete scoping document in markdown for ${session.client_name || 'the client'} — project type: ${session.project_type}.
${schemaSection}
Files reviewed: ${files.map(f => f.name).join(', ') || 'none'}
Screens observed: ${pagesVisited.slice(0, 10).join(', ') || 'none recorded'}

# Project Scope: ${session.client_name || 'Client'}

## Executive Summary
## Project Context
## Requirements
### Data model
### Users & roles
### Workflows
### Integrations
### Business rules & validations
### Reporting needs
### Pain points to solve
## Proposed Architecture
## Effort Estimate
## Risks & Assumptions
## Open Questions
## Recommended Next Steps

Be specific. Cite things the user actually said. Don't invent details.`;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return handleOptions();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  const { sessionId } = await readJson(req);
  if (!sessionId) return jsonResponse({ error: 'sessionId required' }, 400);

  const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId} AND user_id = ${user.id}`;
  if (!session) return jsonResponse({ error: 'Session not found' }, 404);

  const [history, files, pageContexts, backendScan] = await Promise.all([
    sql`SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`,
    sql`SELECT name FROM files WHERE session_id = ${sessionId}`,
    sql`SELECT title, url, captured_at, screenshot_blob_key FROM page_contexts WHERE session_id = ${sessionId} ORDER BY captured_at`,
    sql`SELECT app_id, summary FROM backend_scans WHERE session_id = ${sessionId}`.then(r => r[0] || null)
  ]);

  const pagesVisited = [...new Set(pageContexts.map(p => p.title).filter(Boolean))];
  const screenshotCount = pageContexts.filter(p => p.screenshot_blob_key).length;

  const prompt = session.project_type === 'knack-rebuild'
    ? buildKnackMigrationPrompt(session, files, backendScan, pagesVisited, screenshotCount)
    : buildGeneralPrompt(session, files, backendScan, pagesVisited);

  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: prompt });

  const enc = new TextEncoder();
  const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: MODEL, max_tokens: 8000, stream: true, messages })
        });

        if (!claudeRes.ok) {
          controller.enqueue(sse({ error: `Claude ${claudeRes.status}: ${await claudeRes.text()}` }));
          controller.close(); return;
        }

        let fullText = '';
        let buf = '';
        const reader = claudeRes.body.getReader();
        const dec = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
              const parsed = JSON.parse(raw);
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                fullText += parsed.delta.text;
                controller.enqueue(sse({ delta: parsed.delta.text }));
              }
            } catch {}
          }
        }

        // Persist to DB
        const [ver] = await sql`SELECT COALESCE(MAX(version),0) AS v FROM scope_documents WHERE session_id = ${sessionId}`;
        const version = (ver?.v || 0) + 1;
        const [doc] = await sql`
          INSERT INTO scope_documents (session_id, version, content_md)
          VALUES (${sessionId}, ${version}, ${fullText})
          RETURNING id, version
        `;

        // Save to public Netlify Blob
        let publicUrl = null;
        try {
          const store = getStore({ name: 'wasabi-docs', access: 'public' });
          const key = `scope/${sessionId}/v${version}.md`;
          await store.set(key, fullText, { metadata: { contentType: 'text/markdown' } });
          publicUrl = store.getPublicUrl(key);
        } catch (e) {
          console.warn('Blob upload failed:', e.message);
        }

        controller.enqueue(sse({ done: true, version: doc.version, id: doc.id, url: publicUrl }));
        controller.close();
      } catch (e) {
        controller.enqueue(sse({ error: e.message }));
        controller.close();
      }
    }
  });

  return new Response(stream, { headers: STREAM_HEADERS });
};

export const config = { path: '/api/scope/generate' };
