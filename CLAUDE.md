# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Wasabi Scope is an AI requirements-capture tool for software consultants. It has two components:

1. **Chrome extension** (`wasabi-scope/`) — A Manifest V3 side panel that runs a Claude-powered scoping interview while the user demonstrates their client's software. Captures screen + mic, extracts DOM context, accepts file uploads, and exports a scoping document.

2. **Netlify Functions backend** (`netlify/functions/`) — Node.js serverless API that proxies Claude and OpenAI, persists sessions and messages to Neon Postgres, and stores screenshots/documents in Netlify Blobs.

The active backend is in the **root** `netlify/functions/` and root `netlify.toml`. The `wasabi-scope-api/` subdirectory is a legacy copy — do not edit it.

## Architecture

```
Chrome extension  ──HTTPS──►  Netlify Functions  ──►  Neon Postgres (WASABI_DATABASE_URL)
  sidepanel.js                  _lib.js (shared)          Netlify Blobs (screenshots, docs)
  service-worker.js             chat.js
  content.js                    sessions.js
  offscreen.js                  knack-scan.js
                                scope-generate.js (SSE)
                                story-generate.js (SSE)
                                transcribe.js
                                files.js
                                auth-register.js
```

**Why offscreen document?** Manifest V3 service workers can't call `getUserMedia`/`getDisplayMedia`. The offscreen doc is a hidden page the service worker spawns to run `MediaRecorder`, then ships the blob back.

**DB connection:** `_lib.js` reads `WASABI_DATABASE_URL` (preferred, pinned Neon DB) with a fallback to `NETLIFY_DATABASE_URL`. It deliberately avoids `@netlify/database` so Netlify's Neon extension can't redirect the connection at runtime. Uses `@neondatabase/serverless` for remote and `pg.Pool` for localhost.

**Auth:** Token-based only. The extension sends `x-wasabi-token: wsb_...` in every request. `requireUser()` in `_lib.js` looks it up in the `users` table.

**Coverage tracking:** After every Claude reply in `chat.js`, coverage tags `<coverage>{...}</coverage>` are parsed out and merged into `sessions.coverage` (JSONB). The extension renders these as a live checklist.

**Streaming:** `scope-generate.js` and `story-generate.js` stream Claude responses as SSE (`data: {"delta":"..."}`) and save the final document to both Postgres and a public Netlify Blob.

## Local development

```bash
cd wasabi-scope-api   # only needed if you need its node_modules; root has no package.json
netlify dev           # starts functions at http://localhost:8888
```

Run a migration:
```bash
netlify dev:exec node scripts/migrate.js
```

Inspect the database directly:
```bash
psql $WASABI_DATABASE_URL
```

Watch live function logs:
```bash
netlify functions:log chat --live
```

Deploy:
```bash
netlify deploy --prod
```

## Environment variables

| Variable | Purpose |
|---|---|
| `WASABI_DATABASE_URL` | Pinned Neon Postgres connection string (pooled) |
| `NETLIFY_DATABASE_URL` | Fallback (injected by Netlify's Neon integration) |
| `ANTHROPIC_API_KEY` | Claude API |
| `OPENAI_API_KEY` | Whisper transcription (optional) |
| `CLAUDE_MODEL` | Override Claude model (default varies per function) |

Check what's set: `netlify env:list`

## Database schema

Tables: `users`, `sessions`, `messages`, `page_contexts`, `files`, `transcripts`, `scope_documents`, `backend_scans`, `session_stories`.

- `sessions.coverage` is a JSONB map of `{ "category-id": "partial"|"done"|"unknown" }` merged incrementally.
- `backend_scans` stores the raw Knack API response and a processed `summary.promptText` injected into the chat system prompt.
- `page_contexts.screenshot_blob_key` is the Netlify Blobs key for screenshots captured during a session.
- Schema source: `wasabi-scope-api/migrations-legacy/001_init.sql` (reference). Run `scripts/migrate.js` to apply.

## Chrome extension

Load unpacked from `wasabi-scope/`. No build step — plain ES modules.

Key message flows:
- `sidepanel.js` → `background/service-worker.js` → `offscreen/offscreen.js` (recording)
- `sidepanel.js` → `content.js` (DOM extraction via `chrome.tabs.sendMessage`)
- `sidepanel.js` → Netlify Functions (all API calls)

Extension settings (API URL, token, client name, project type) are stored in `chrome.storage.local`.

## Project types and coverage categories

`chat.js` defines `REQUIREMENT_CATEGORIES` for each project type: `knack-rebuild`, `zoho-rebuild`, `erp-integration`, `custom-saas`, `general`. These drive what the AI asks about and what the coverage checklist tracks. The Knack categories focus on UI/frontend only — the backend data model is covered separately via `knack-scan.js`.

## Key conventions

- All Netlify functions export a default `async (req) => Response` handler and an `export const config = { path: '/api/...' }`.
- CORS is handled globally in `netlify.toml` for `/api/*` and via `handleOptions()` / `CORS_HEADERS` in `_lib.js` for the function responses themselves.
- SQL uses the tagged template helper: `` sql`SELECT ... WHERE id = ${id}` ``. For dynamic queries use `sql.query(text, params)`.
- Screenshots are base64 data URLs in transit, stored as binary in Netlify Blobs (`wasabi-screenshots` store), with only the blob key persisted in Postgres.
- Generated documents go to the `wasabi-docs` public Blob store; the public URL is returned in the SSE `done` event.
