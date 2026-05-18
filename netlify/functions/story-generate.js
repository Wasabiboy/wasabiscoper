// /api/story/generate
// Streams Claude's narrative session story as SSE.
// Events: { delta: "text" } while streaming, { done: true, version, id, url } when saved.

import { sql, handleOptions, requireUser, readJson, jsonResponse } from './_lib.js';
import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-wasabi-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

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

  const history      = await sql`SELECT role, content FROM messages WHERE session_id = ${sessionId} ORDER BY created_at`;
  const pageContexts = await sql`SELECT url, title, captured_at, screenshot_blob_key FROM page_contexts WHERE session_id = ${sessionId} ORDER BY captured_at`;
  const files        = await sql`SELECT name FROM files WHERE session_id = ${sessionId}`;

  const screenshotCount = pageContexts.filter(p => p.screenshot_blob_key).length;
  const pagesVisited    = [...new Set(pageContexts.map(p => p.title).filter(Boolean))];

  const prompt = `You are a senior consultant at Wasabi Digital. Write a narrative session story — a first-person debrief note — about the scoping session you just conducted.

SESSION DETAILS:
- Client: ${session.client_name || 'Unspecified'}
- Project type: ${session.project_type}
- Pages/screens observed: ${pagesVisited.slice(0, 10).join(', ') || 'none recorded'}
- Screenshots captured: ${screenshotCount}
- Files reviewed: ${files.map(f => f.name).join(', ') || 'none'}
- Coverage achieved: ${JSON.stringify(session.coverage || {})}

Structure:
# Session story — ${session.client_name || 'Client'}
## What we set out to do
## What the client showed us
## Key discoveries
## What's still unclear
## Next steps

Be concrete. Reference specific things from the conversation. Don't pad.`;

  const messages = history.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: prompt });

  const enc = new TextEncoder();
  const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODEL, max_tokens: 4000, stream: true, messages })
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
        const [ver] = await sql`SELECT COALESCE(MAX(version),0) AS v FROM session_stories WHERE session_id = ${sessionId}`;
        const version = (ver?.v || 0) + 1;
        const [story] = await sql`
          INSERT INTO session_stories (session_id, version, content_md)
          VALUES (${sessionId}, ${version}, ${fullText})
          RETURNING id, version
        `;

        // Save to public Netlify Blob
        let publicUrl = null;
        try {
          const store = getStore({ name: 'wasabi-docs', access: 'public' });
          const key = `story/${sessionId}/v${version}.md`;
          await store.set(key, fullText, { metadata: { contentType: 'text/markdown' } });
          publicUrl = store.getPublicUrl(key);
        } catch (e) {
          console.warn('Blob upload failed:', e.message);
        }

        controller.enqueue(sse({ done: true, version: story.version, id: story.id, url: publicUrl }));
        controller.close();
      } catch (e) {
        controller.enqueue(sse({ error: e.message }));
        controller.close();
      }
    }
  });

  return new Response(stream, { headers: STREAM_HEADERS });
};

export const config = { path: '/api/story/generate' };
