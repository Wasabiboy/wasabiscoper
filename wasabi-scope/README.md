# Wasabi Scope — AI Requirements Capture

Chrome extension that runs an AI scoping interview while the client demonstrates their existing software. Captures screen + voice + DOM context + uploaded documents, and outputs a full scoping document.

## What it does

1. **Side panel agent** — Claude Sonnet acts as a senior architect, asking one targeted question at a time, prioritising the least-covered requirement category.
2. **Screen + mic recording** — captures the demo session as a downloadable .webm file.
3. **Auto page context** — extracts forms, tables, navigation, and headings from the current page (Knack, Zoho, anything browser-based) and feeds them to the AI so its questions reference actual field names and screens.
4. **Voice input** — push-to-talk on the chat input using Web Speech API (en-NZ locale).
5. **Document uploads** — drop in PDFs, CSVs, screenshots, schema exports. Text content goes to the AI inline.
6. **Whisper transcription** — sends the demo audio to OpenAI Whisper, then back into the agent loop for follow-up questions.
7. **Live requirements coverage** — tracks which scoping categories are covered (data model, workflows, integrations, etc.). The AI updates these via inline tags.
8. **Scoping document export** — generates a markdown doc with architecture, effort estimate, and open questions.

## Install (developer mode)

1. Unzip the folder.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** → select the `wasabi-scope` folder.
5. Pin the extension icon to the toolbar.
6. Click the icon → side panel opens.
7. Click ⚙ Settings → paste your Anthropic API key (and optionally OpenAI key for transcription).
8. Click **● Start session**.

## Project types (drives the AI's question set)

- Knack app rebuild
- Zoho Creator rebuild
- ERP integration / liberation
- Custom SaaS migration
- General scoping

## Architecture

```
Side panel UI ──────► Background service worker ──────► Offscreen document
   │                          │                         │  (MediaRecorder)
   │                          ▼                         │
   │                  Content script in tab             ▼
   │              (extracts forms/tables/nav)     screen + mic .webm
   │                          │
   ▼                          ▼
Claude API ◄────────── Page context + chat history
   │
   ▼
Scoping doc (.md)
```

Why an offscreen document? Manifest V3 service workers can't call `getUserMedia` or `getDisplayMedia`. The offscreen doc is a hidden page that the service worker spawns to do the recording, then ships the blob URL back.

## What to build next (suggested roadmap)

**v0.2 — Smart capture**
- Auto-screenshot every N seconds during recording and feed to Claude vision for visual context
- Capture network requests (XHR/fetch) to map out the existing API surface
- Detect SPAs and capture route changes

**v0.3 — Persistence**
- Push sessions to Supabase (you already have an MCP connection for this)
- Multi-client workspace, resumable sessions

**v0.4 — Output integrations**
- Direct export to your Gamma.app for a pitch deck
- Push the scoping doc to Google Drive into the client folder
- Create a Linear/GitHub issue per "Open question"

**v0.5 — Voice agent**
- Switch from Web Speech API to OpenAI Realtime or ElevenLabs Conversational AI for full duplex voice (you've used both)
- Hands-free while the user demonstrates software

## Security notes

- API keys are stored in `chrome.storage.local` — never synced.
- `anthropic-dangerous-direct-browser-access: true` is enabled because we're calling Claude direct from the browser. For production, route through your own backend (Cloudways) so keys aren't in the client.
- All recordings stay local until you explicitly download or transcribe.

## Files

```
wasabi-scope/
├── manifest.json
├── background/service-worker.js     ← message routing, offscreen lifecycle
├── offscreen/offscreen.{html,js}    ← MediaRecorder lives here
├── content.js                       ← page DOM extraction
├── sidepanel/
│   ├── sidepanel.html               ← the agent UI
│   ├── sidepanel.css                ← dark theme
│   └── sidepanel.js                 ← agent loop, API calls, recording control
└── icons/                           ← W-branded green icons
```
