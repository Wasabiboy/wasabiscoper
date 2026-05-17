# Wasabi Scope — full deployment guide

End-to-end setup: Netlify Functions backend + Neon Postgres + Chrome extension. About 15 minutes.

## Architecture

```
Chrome extension  ──HTTPS──►  Netlify Functions  ──►  Neon Postgres
                              (Anthropic key here)
                              (OpenAI key here)     
                                      │
                                      ▼
                              api.anthropic.com
                              api.openai.com
```

The extension only ever holds a Wasabi token. All API keys live in Netlify environment variables.

## Prerequisites

- A Netlify account (you have one: Wasabiboy, 26 sites)
- Node.js 20+ locally
- Your Anthropic API key
- (Optional) OpenAI API key for Whisper transcription
- Chrome browser

## Part 1 — Backend (Netlify + Neon)

### 1.1 Install Netlify CLI

```bash
npm install -g netlify-cli
netlify login
```

### 1.2 Initialise the project

```bash
cd wasabi-scope-api
npm install
netlify init
```

When prompted:
- **Create & configure a new site** → yes
- **Team** → your team
- **Site name** → `wasabi-scope` (or whatever — will give you `wasabi-scope.netlify.app`)
- **Build command** → leave blank (no build needed)
- **Publish directory** → `public`
- **Functions directory** → `netlify/functions`

### 1.3 Provision Neon Postgres

Use Netlify's built-in Neon integration — no manual connection string handling required:

```bash
netlify db init
```

This:
- Creates a Neon Postgres database in a region matching your functions
- Sets `NETLIFY_DATABASE_URL` and `NETLIFY_DATABASE_URL_UNPOOLED` in your site env vars automatically
- You have 7 days to claim it (link to your Neon account)

**If you already have a Neon database you want to use:**

```bash
netlify env:set NETLIFY_DATABASE_URL "postgresql://..."
```

— set this in the Netlify UI under Site configuration → Environment variables, marked as a secret. Never paste the connection string in code or chat.

### 1.4 Set API keys

```bash
netlify env:set ANTHROPIC_API_KEY "sk-ant-..."
netlify env:set OPENAI_API_KEY "sk-..."        # optional, for transcription
```

Or paste them into the Netlify UI under Site configuration → Environment variables. Mark both as **Contains secret values**.

### 1.5 Run the migration

```bash
netlify dev:exec node scripts/migrate.js
```

This injects `NETLIFY_DATABASE_URL` from your site env into the local node process, then runs `migrations/001_init.sql`. You should see:

```
→ Running 001_init.sql
  ✓ 001_init.sql
All migrations applied.
```

### 1.6 Test locally

```bash
netlify dev
```

Open http://localhost:8888 — you should see the beta signup page. Submit your email, copy the `wsb_...` token that comes back. Keep it.

### 1.7 Deploy

```bash
netlify deploy --prod
```

Your API is now live at `https://wasabi-scope.netlify.app/api/*`.

## Part 2 — Chrome extension

### 2.1 Install

1. Unzip `wasabi-scope.zip`.
2. Open `chrome://extensions/`.
3. Toggle **Developer mode** on.
4. Click **Load unpacked** → select the `wasabi-scope` folder.
5. Pin the extension icon.

### 2.2 Configure

1. Click the extension icon → side panel opens.
2. Click ⚙ Settings:
   - **API base URL**: `https://wasabi-scope.netlify.app`
   - **Wasabi token**: paste the `wsb_...` token from beta signup
   - **Client name**: optional
   - **Project type**: Knack app rebuild (or whatever fits)
3. Click **Save**.

### 2.3 Run your first session

1. Open the client's Knack app in another tab.
2. Click **● Start session** — Chrome will ask which screen/tab to share.
3. The agent greets you and asks its first question.
4. As you demonstrate features:
   - Click 📄 to send the current page structure to the AI
   - Click 🎤 to answer by voice
   - Drag/drop schema exports, screenshots, CSVs into the file zone
5. Watch the **Requirements coverage** checklist fill in live.
6. When done, click **Generate scoping document** — markdown file downloads.

## Part 3 — Verify it's working

### 3.1 Check the database

```bash
netlify db:open    # opens Neon SQL editor
```

Or via psql with the `NETLIFY_DATABASE_URL_UNPOOLED` connection string. Run:

```sql
SELECT count(*) FROM sessions;
SELECT count(*) FROM messages WHERE role='user';
SELECT count(*) FROM messages WHERE role='assistant';
```

Numbers should reflect your test session.

### 3.2 Check logs

```bash
netlify functions:log chat --live
```

Watch live as the extension sends messages.

## Costs (approx)

- **Netlify Functions** — free tier is 125k requests/month. Plenty for beta.
- **Neon** — free tier: 0.5GB storage, 191 compute hours/month. Plenty for beta.
- **Anthropic Claude Sonnet 4.5** — about $0.03 per typical scoping interaction (1.5k input tokens, 600 output).
- **OpenAI Whisper** — $0.006/minute of audio. A 1hr session = $0.36.

Conservative estimate: a full 1hr scoping session including transcription costs you about **$2-3 in API calls**. Charge the client $500+ for the scope doc deliverable.

## Production hardening (before going beyond beta)

1. **Real auth**: swap the wsb_token system for Stack Auth (Neon's built-in auth) or Netlify Identity. Add password/OAuth login.
2. **Per-user rate limiting**: prevent runaway Claude costs on a single token.
3. **Binary file storage**: route uploaded PDFs/screenshots through Netlify Blobs instead of dropping them.
4. **Recording uploads**: currently recordings stay in the browser. Add a "Save to cloud" button that POSTs the .webm to Netlify Blobs.
5. **Multi-tenant**: a `teams` table so Decoded Digital staff can share sessions across the team.
6. **Vision capture**: feed periodic screenshots to Claude vision API during recording.

## Troubleshooting

**"API 401 — Unauthorized"** → token wrong or missing. Re-paste from beta signup.

**"API 500 — Server misconfigured"** → an env var is missing. Check `netlify env:list`.

**Migration fails with "NETLIFY_DATABASE_URL not set"** → use `netlify dev:exec node scripts/migrate.js` (injects env) or `netlify link` first then `netlify env:get NETLIFY_DATABASE_URL` to verify it's there.

**Side panel doesn't open** → reload the extension at `chrome://extensions/`, then click the icon again.

**Recording shows black** → in the Chrome picker, choose the specific tab/window with the app open, not "Entire screen", for best quality.

## File layout

```
wasabi-scope-api/
├── netlify.toml                        ← routes, CORS, function config
├── package.json
├── migrations/001_init.sql             ← schema
├── scripts/migrate.js                  ← migration runner
├── netlify/functions/
│   ├── _lib.js                         ← auth, db client, helpers
│   ├── auth-register.js                ← POST /api/auth/register
│   ├── sessions.js                     ← CRUD /api/sessions
│   ├── chat.js                         ← POST /api/chat (Claude proxy)
│   ├── files.js                        ← POST /api/files
│   ├── transcribe.js                   ← POST /api/transcribe (Whisper proxy)
│   └── scope-generate.js               ← POST /api/scope/generate
└── public/index.html                   ← beta signup page

wasabi-scope/                            ← Chrome extension
├── manifest.json
├── background/service-worker.js
├── offscreen/{offscreen.html, .js}
├── content.js
├── sidepanel/{sidepanel.html, .css, .js}
└── icons/
```
