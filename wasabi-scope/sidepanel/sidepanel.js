// Wasabi Scope — sidepanel logic (v0.2, backend-connected)
// All AI/DB calls now route through https://your-site.netlify.app/api/*
// The extension only holds a wasabi token, never raw API keys.

const $ = (id) => document.getElementById(id);

/** Shipped default — users can switch to localhost or another deploy in Settings → Save */
const DEFAULT_API_BASE = 'https://wasabiscope.netlify.app';

const state = {
  apiBase: DEFAULT_API_BASE,
  token: '',
  sessionId: null,
  clientName: '',
  projectType: 'knack-rebuild',
  /** Scroll + stitch JPEG strips before each chat turn when enabled */
  fullPageScreenshots: true,
  recording: false,
  thinking: false,  // true while awaiting Claude response — suppresses auto-captures
  recordingUrl: null,
  recordingMimeType: null,
  timerInterval: null,
  startTime: null,
  coverage: {},
  uploadedFiles: [],
  voiceEnabled: false,
  elevenLabsKey: '',
  elevenLabsVoiceId: '',
  knackAppId: '',
  knackApiKey: ''
};

let currentAudio = null;

const REQUIREMENT_CATEGORIES = {
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
    { id: 'integration-points', label: 'Integration points', desc: 'APIs, IDocs, files' },
    { id: 'workflows', label: 'Workflows to liberate', desc: 'Which processes need modern UI' },
    { id: 'users-roles', label: 'Users & roles', desc: 'Who uses the new interface' },
    { id: 'data-flows', label: 'Data flows', desc: 'Read vs write-back, sync' },
    { id: 'auth-security', label: 'Auth & security', desc: 'SSO, RBAC, audit' },
    { id: 'pain-points', label: 'Pain points', desc: 'What ERP UI fails at' }
  ],
  'custom-saas': [
    { id: 'current-saas', label: 'Current SaaS', desc: 'Product, plan, cost' },
    { id: 'usage-patterns', label: 'Usage patterns', desc: 'Who, how often' },
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

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode screenshot strip'));
    img.src = dataUrl;
  });
}

/** Stack viewport JPEG captures into one data URL so /api/chat still receives one image */
async function stitchScreenshotStrips(dataUrls, options = {}) {
  const maxPixels = options.maxPixels ?? Math.floor(12.5 * 1024 * 1024);
  if (!Array.isArray(dataUrls) || !dataUrls.length) return null;
  if (dataUrls.length === 1) return dataUrls[0];
  const imgs = [];
  for (const u of dataUrls) {
    imgs.push(await loadImageFromDataUrl(u));
  }
  let targetW = imgs[0].naturalWidth || imgs[0].width;
  targetW = Math.min(targetW, options.maxStripWidth ?? 1280);

  let sumH = 0;
  const rowHeights = imgs.map((im) => {
    const w = im.naturalWidth || im.width;
    const h = im.naturalHeight || im.height;
    const hh = Math.max(1, Math.round(h * targetW / w));
    sumH += hh;
    return hh;
  });

  while (targetW * sumH > maxPixels && targetW > 480) {
    targetW = Math.floor(targetW * 0.92);
    sumH = 0;
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      const w = im.naturalWidth || im.width;
      const h = im.naturalHeight || im.height;
      rowHeights[i] = Math.max(1, Math.round(h * targetW / w));
      sumH += rowHeights[i];
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = sumH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let y = 0;
  for (let i = 0; i < imgs.length; i++) {
    ctx.drawImage(imgs[i], 0, y, targetW, rowHeights[i]);
    y += rowHeights[i];
  }

  const q = imgs.length >= 10 ? 0.56 : imgs.length >= 6 ? 0.62 : 0.71;
  return canvas.toDataURL('image/jpeg', q);
}

async function api(path, options = {}) {
  if (!state.apiBase) throw new Error('Set API base URL in Settings');
  if (!state.token) throw new Error('Set your Wasabi token in Settings');
  const res = await fetch(state.apiBase + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-wasabi-token': state.token,
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API ${res.status}: ${t}`);
  }
  return res.json();
}

/** Whisper via backend (OPENAI_API_KEY on Netlify). */
async function transcribeAudioBlob(blob, filename = 'recording.webm') {
  if (!state.sessionId) throw new Error('Start a session first.');
  console.log('[sidepanel] Transcribing audio:', { blobType: blob.type, blobSize: blob.size, filename });
  const form = new FormData();
  // Ensure the blob has a usable MIME type for Whisper
  form.append('file', blob, filename);
  form.append('sessionId', state.sessionId);
  const url = `${state.apiBase.replace(/\/$/, '')}/api/transcribe`;
  console.log('[sidepanel] POST', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-wasabi-token': state.token },
    body: form
  });
  const raw = await res.text();
  console.log('[sidepanel] Transcribe response:', res.status, raw.slice(0, 200));
  if (!res.ok) {
    let err = raw;
    try {
      const j = JSON.parse(raw);
      err = j.error || raw;
    } catch { /* use raw */ }
    throw new Error(`Transcription failed (${res.status}): ${err}`);
  }
  const body = JSON.parse(raw);
  const t = body.transcript?.text ?? body.transcript;
  const text = (typeof t === 'string' ? t : '').trim();
  console.log('[sidepanel] Transcript result:', text ? `"${text.slice(0, 80)}…"` : '(empty)');
  return text;
}

/** Transcribe voice clip and send to the scoping agent. */
async function submitVoiceToAgent(blob, mimeType) {
  const ext = (mimeType || '').includes('mp4') ? 'm4a' : 'webm';
  systemMessage('Transcribing your voice…');
  const text = await transcribeAudioBlob(blob, `voice.${ext}`);
  if (!text) {
    systemMessage('No speech detected — try again, speaking clearly.');
    return;
  }
  $('chat-input').value = text;
  const preview = text.length > 140 ? text.slice(0, 140) + '…' : text;
  systemMessage(`You said: “${preview}” — sending to agent…`);
  // Skip full-page scroll capture on voice turns (faster; user already spoke).
  await sendToAgent(text, { skipScreenshot: true });
  $('chat-input').value = '';
}

function stopAudio() {
  window.speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

function speakReply(text) {
  if (!state.voiceEnabled) return;
  const clean = text.replace(/<coverage>[\s\S]*?<\/coverage>/g, '').trim();
  if (!clean) return;
  if (state.elevenLabsKey) {
    speakElevenLabs(clean);
  } else {
    speakWebSpeech(clean);
  }
}

async function speakElevenLabs(text) {
  stopAudio();
  try {
    const voiceId = state.elevenLabsVoiceId || 'IKne3meq5aSn9XLyUdCD';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': state.elevenLabsKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      systemMessage(`🔇 ElevenLabs error ${res.status}: ${errText}`);
      speakWebSpeech(text);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    currentAudio = new Audio(url);
    currentAudio.onended = () => { URL.revokeObjectURL(url); currentAudio = null; };
    await currentAudio.play();
  } catch (e) {
    systemMessage(`🔇 Voice error: ${e.message}`);
    speakWebSpeech(text);
  }
}

function speakWebSpeech(text) {
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const pickVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    return voices.find(v => /en.NZ|en.AU/i.test(v.lang))
      || voices.find(v => v.lang.startsWith('en'))
      || null;
  };
  utter.voice = pickVoice();
  utter.rate = 1.05;
  utter.pitch = 1.0;
  utter.onerror = () => {
    systemMessage('🔇 Spoken reply unavailable in this panel — read the text above, or add an ElevenLabs key in Settings.');
  };
  // Voices often load asynchronously on first open.
  if (!utter.voice && window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      utter.voice = pickVoice();
      window.speechSynthesis.speak(utter);
    };
    return;
  }
  window.speechSynthesis.speak(utter);
}

async function findSessionByUrl(tabUrl) {
  try {
    const origin = new URL(tabUrl).origin;
    const data = await api(`/api/sessions?targetUrl=${encodeURIComponent(origin)}`);
    return data.sessions?.[0] || null;
  } catch {
    return null;
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    'apiBase', 'token', 'clientName', 'projectType', 'sessionId', 'voiceEnabled',
    'elevenLabsKey', 'elevenLabsVoiceId', 'checklistOpen', 'knackAppId', 'knackApiKey', 'fullPageScreenshots'
  ]);
  state.apiBase = (data.apiBase || '').trim().replace(/\/$/, '') || DEFAULT_API_BASE;
  state.token = data.token || '';
  state.clientName = data.clientName || '';
  state.projectType = data.projectType || 'knack-rebuild';
  state.sessionId = data.sessionId || null;
  state.voiceEnabled = !!data.voiceEnabled;
  state.elevenLabsKey = data.elevenLabsKey || '';
  state.elevenLabsVoiceId = data.elevenLabsVoiceId || '';
  state.knackAppId = data.knackAppId || '';
  state.knackApiKey = data.knackApiKey || '';
  state.fullPageScreenshots = data.fullPageScreenshots !== false;
  if ($('full-page-shot')) $('full-page-shot').checked = state.fullPageScreenshots;
  $('voice-btn').textContent = state.voiceEnabled ? '🔊' : '🔇';
  $('elevenlabs-key').value = state.elevenLabsKey;
  $('elevenlabs-voice').value = state.elevenLabsVoiceId;
  $('knack-app-id').value = state.knackAppId;
  $('knack-api-key').value = state.knackApiKey;
  setChecklistOpen(!!data.checklistOpen);
  $('api-base').value = state.apiBase;
  $('wasabi-token').value = state.token;
  $('client-name').value = state.clientName;
  $('project-type').value = state.projectType;
  updateKnackVisibility();
  renderChecklist();

  if (!state.apiBase || !state.token) return;

  // URL-based lookup is the source of truth for session resume.
  // Always check which session belongs to the current tab — if none match,
  // clear any stored session so we don't bleed context from a different job.
  let currentOrigin = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    if (tab?.url) currentOrigin = new URL(tab.url).origin;
  } catch {}

  if (currentOrigin) {
    try {
      const match = await findSessionByUrl(currentOrigin);
      if (match) {
        if (match.id !== state.sessionId) {
          systemMessage(`↩ Resumed session for ${new URL(currentOrigin).hostname}`);
        }
        state.sessionId = match.id;
        await chrome.storage.local.set({ sessionId: match.id });
      } else {
        // No session for this page — don't carry over a session from somewhere else
        state.sessionId = null;
        await chrome.storage.local.set({ sessionId: null });
      }
    } catch (e) {
      console.warn('URL-based session lookup failed:', e.message);
      // Network error — fall back to stored session rather than clearing it
    }
  }

  if (state.sessionId) await resumeSession();
}

async function resumeSession() {
  try {
    const data = await api(`/api/sessions/${state.sessionId}`);
    state.coverage = data.session.coverage || {};
    state.clientName = data.session.client_name || state.clientName;
    state.projectType = data.session.project_type || state.projectType;
    $('chat').innerHTML = '';
    data.messages.forEach(m => renderBubble(m.role, m.content));
    renderChecklist();
    $('session-status').textContent = `Session ${state.sessionId.slice(0, 8)}`;
    // Load existing backend scan if present
    try {
      const scanData = await api(`/api/knack/scan?sessionId=${state.sessionId}`);
      if (scanData.summary) {
        renderSchemaTree(scanData.summary);
        const sc = scanData.summary;
        $('knack-scan-status').textContent = `${sc.objectCount} objects · ${sc.totalFields} fields · ${sc.sceneCount || 0} pages`;
        $('scan-knack-btn').textContent = '↻ Re-scan';
        setKnackOpen(true);
      }
    } catch { /* no scan yet — that's fine */ }
  } catch (e) {
    if (e.message.startsWith('API 404')) {
      state.sessionId = null;
      await chrome.storage.local.set({ sessionId: null });
      systemMessage('Previous session no longer exists — starting fresh.');
    } else {
      systemMessage('Could not resume session: ' + e.message);
    }
  }
}

$('save-settings').addEventListener('click', async () => {
  state.apiBase = $('api-base').value.trim().replace(/\/$/, '') || DEFAULT_API_BASE;
  state.token = $('wasabi-token').value.trim();
  state.clientName = $('client-name').value.trim();
  state.projectType = $('project-type').value;
  state.elevenLabsKey = $('elevenlabs-key').value.trim();
  state.elevenLabsVoiceId = $('elevenlabs-voice').value.trim();
  state.knackAppId = $('knack-app-id').value.trim();
  state.knackApiKey = $('knack-api-key').value.trim();
  await chrome.storage.local.set({
    apiBase: state.apiBase, token: state.token, clientName: state.clientName, projectType: state.projectType,
    elevenLabsKey: state.elevenLabsKey, elevenLabsVoiceId: state.elevenLabsVoiceId, voiceEnabled: state.voiceEnabled,
    knackAppId: state.knackAppId, knackApiKey: state.knackApiKey,
    fullPageScreenshots: !!$('full-page-shot')?.checked
  });
  state.fullPageScreenshots = !!$('full-page-shot')?.checked;
  updateKnackVisibility();
  renderChecklist();
  $('settings-panel').classList.add('hidden');
  systemMessage('Settings saved.');
});

$('project-type').addEventListener('change', updateKnackVisibility);

$('settings-btn').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));

function setChecklistOpen(open) {
  $('checklist-body').classList.toggle('hidden', !open);
  $('checklist-arrow').classList.toggle('open', open);
}
$('checklist-toggle').addEventListener('click', async () => {
  const open = $('checklist-body').classList.contains('hidden');
  setChecklistOpen(open);
  await chrome.storage.local.set({ checklistOpen: open });
});

function updateKnackVisibility() {
  const isKnack = ($('project-type').value || state.projectType) === 'knack-rebuild';
  $('knack-settings').classList.toggle('hidden', !isKnack);
  $('knack-panel').classList.toggle('hidden', !isKnack);
}

function setKnackOpen(open) {
  $('knack-body').classList.toggle('hidden', !open);
  $('knack-arrow').classList.toggle('open', open);
}
$('knack-toggle').addEventListener('click', () => {
  const open = $('knack-body').classList.contains('hidden');
  setKnackOpen(open);
});

async function scanKnackBackend() {
  if (!state.sessionId) { systemMessage('Start a session first.'); return; }
  const appId = state.knackAppId || $('knack-app-id').value.trim();
  const apiKey = state.knackApiKey || $('knack-api-key').value.trim();
  if (!appId || !apiKey) {
    systemMessage('Enter your Knack App ID and REST API key in Settings first.');
    $('settings-panel').classList.remove('hidden');
    return;
  }
  const btn = $('scan-knack-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('knack-scan-status').textContent = 'Scanning Knack backend…';
  try {
    const data = await api('/api/knack/scan', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, appId, apiKey })
    });
    renderSchemaTree(data.summary);
    const { objectCount, totalFields, sceneCount = 0 } = data.summary;
    $('knack-scan-status').textContent = `${objectCount} objects · ${totalFields} fields · ${sceneCount} pages`;
    btn.textContent = '↻ Re-scan';
    setKnackOpen(true);
    systemMessage(`✅ Knack scan complete — ${objectCount} objects, ${sceneCount} pages loaded.`);
  } catch (e) {
    $('knack-scan-status').textContent = 'Scan failed';
    systemMessage('Knack scan failed: ' + e.message);
    btn.textContent = 'Scan Knack backend';
  } finally {
    btn.disabled = false;
  }
}

function renderSchemaTree(summary) {
  const tree = $('knack-schema-tree');
  tree.innerHTML = '';

  if ((summary.objects || []).length) {
    const objHeader = document.createElement('div');
    objHeader.className = 'schema-section-label';
    objHeader.textContent = `Objects (${summary.objectCount})`;
    tree.appendChild(objHeader);
  }

  (summary.objects || []).forEach(obj => {
    const item = document.createElement('div');
    item.className = 'schema-object';
    const header = document.createElement('div');
    header.className = 'schema-obj-header';
    header.textContent = `${obj.name} (${obj.key}) — ${obj.fieldCount} fields`;
    if (obj.connections.length) {
      const conn = document.createElement('span');
      conn.className = 'schema-conn muted';
      conn.textContent = ` → ${obj.connections.join(', ')}`;
      header.appendChild(conn);
    }
    item.appendChild(header);
    const fields = document.createElement('div');
    fields.className = 'schema-fields';
    obj.fields.slice(0, 8).forEach(f => {
      const fd = document.createElement('div');
      fd.className = 'schema-field';
      const conn = f.connection ? ` → ${f.connection.objectName}` : '';
      const req = f.required ? ' *' : '';
      fd.textContent = `${f.label} [${f.type}${conn}]${req}`;
      fields.appendChild(fd);
    });
    if (obj.fields.length > 8) {
      const more = document.createElement('div');
      more.className = 'schema-field muted';
      more.textContent = `… ${obj.fields.length - 8} more fields`;
      fields.appendChild(more);
    }
    item.appendChild(fields);
    tree.appendChild(item);
  });

  if ((summary.scenes || []).length) {
    const pageHeader = document.createElement('div');
    pageHeader.className = 'schema-section-label';
    pageHeader.style.marginTop = '10px';
    pageHeader.textContent = `Pages (${summary.sceneCount})`;
    tree.appendChild(pageHeader);

    summary.scenes.forEach(scene => {
      const item = document.createElement('div');
      item.className = 'schema-object';
      const header = document.createElement('div');
      header.className = 'schema-obj-header';
      header.textContent = `${scene.name} (${scene.key})${scene.authenticated ? ' 🔒' : ''}`;
      item.appendChild(header);
      const views = document.createElement('div');
      views.className = 'schema-fields';
      scene.views.forEach(v => {
        const vd = document.createElement('div');
        vd.className = 'schema-field';
        const src = v.sourceObject ? ` — ${v.sourceObject}` : '';
        vd.textContent = `${v.name} [${v.typeLabel}${src}]`;
        views.appendChild(vd);
      });
      item.appendChild(views);
      tree.appendChild(item);
    });
  }

  tree.classList.remove('hidden');
}

$('scan-knack-btn').addEventListener('click', scanKnackBackend);

$('voice-btn').addEventListener('click', async () => {
  state.voiceEnabled = !state.voiceEnabled;
  $('voice-btn').textContent = state.voiceEnabled ? '🔊' : '🔇';
  await chrome.storage.local.set({ voiceEnabled: state.voiceEnabled });
  if (!state.voiceEnabled) stopAudio();
});

function renderBubble(role, content) {
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = content.replace(/<coverage>[\s\S]*?<\/coverage>/g, '').trim();
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}
function systemMessage(text) {
  const chat = $('chat');
  const div = document.createElement('div');
  div.className = 'bubble system';
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}
function renderChecklist() {
  const cats = REQUIREMENT_CATEGORIES[state.projectType] || REQUIREMENT_CATEGORIES.general;
  const ul = $('checklist');
  ul.innerHTML = '';
  cats.forEach(c => {
    const s = state.coverage[c.id] || 'unknown';
    const li = document.createElement('li');
    li.className = s;
    li.innerHTML = `<span class="status"></span><div class="cat-info"><strong>${c.label}</strong><br><span class="muted">${c.desc}</span></div><button class="focus-btn" title="Focus agent on this area">Ask ›</button>`;
    li.querySelector('.focus-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      focusOnCategory(c.id, c.label, c.desc);
    });
    ul.appendChild(li);
  });
}

function focusOnCategory(categoryId, label, desc) {
  if (!state.sessionId) { systemMessage('Start a session first.'); return; }
  const status = state.coverage[categoryId] || 'unknown';
  const statusNote = status === 'done' ? 'already marked done' : status === 'partial' ? 'partially covered' : 'not yet covered';
  sendToAgent(`Let's focus on "${label}". This is ${statusNote} — ${desc}. Ask me your most targeted question about this.`, { focusCategory: categoryId });
}

$('start-btn').addEventListener('click', async () => {
  try {
    if (!state.sessionId) {
      // Discover capture target tab first so we can save its URL with the session
      let targetUrl = null;
      try {
        const tabs = await chrome.tabs.query({ windowType: 'normal' });
        const candidate = tabs.find(t => t.active && !t.url.startsWith('chrome-extension://')) || tabs[0];
        if (candidate) {
          await chrome.runtime.sendMessage({ type: 'SET_CAPTURE_TARGET', tabId: candidate.id });
          targetUrl = new URL(candidate.url).origin;
          systemMessage(`📸 Screenshots from: ${candidate.title.slice(0, 50)}`);
        }
      } catch (e) {
        console.warn('Could not set capture target:', e);
      }

      const { session } = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ clientName: state.clientName, projectType: state.projectType, targetUrl })
      });
      state.sessionId = session.id;
      await chrome.storage.local.set({ sessionId: state.sessionId });
      $('session-status').textContent = `Session ${state.sessionId.slice(0, 8)}`;
    }
    const res = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      includeMic: $('include-mic').checked,
      includeAudio: $('include-audio').checked
    });
    if (res?.ok) {
      state.recording = true;
      state.startTime = Date.now();
      $('timer').classList.remove('hidden');
      state.timerInterval = setInterval(updateTimer, 500);
      systemMessage('🔴 Recording. Show me how your software works.');
    } else {
      console.warn('[sidepanel] Recording unavailable:', res?.error);
      systemMessage('Session active (screen recording unavailable — screenshots will still capture each turn).');
    }
    $('start-btn').classList.add('hidden');
    $('stop-btn').classList.remove('hidden');
    const sess = await api(`/api/sessions/${state.sessionId}`);
    if (!sess.messages.length) {
      await sendToAgent("I'm starting a scoping session. Please begin the interview.");
    }
  } catch (e) {
    systemMessage('Error: ' + e.message);
  }
});

$('stop-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  state.recording = false;
  clearInterval(state.timerInterval);
  $('start-btn').classList.remove('hidden');
  $('stop-btn').classList.add('hidden');
  systemMessage('⏹ Recording stopped.');
});

function updateTimer() {
  const e = Math.floor((Date.now() - state.startTime) / 1000);
  $('timer').textContent = `${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
}

async function sendToAgent(userText, extras = {}) {
  if (!state.sessionId) { systemMessage('Click Start session first.'); return; }
  stopAudio(); // stop AI mid-sentence if user sends another message
  if (!extras.silent) renderBubble('user', userText);
  systemMessage('thinking…');
  state.thinking = true;
  let stitchWarning = null;
  try {
    // Capture screenshot and activity log before every turn
    const fullPageUi = $('full-page-shot');
    const useFullPage = !extras.skipScreenshot && (fullPageUi ? fullPageUi.checked : state.fullPageScreenshots);
    const snapPromise = extras.skipScreenshot
      ? Promise.resolve({ ok: false })
      : extras.screenshotDataUrl
        ? Promise.resolve({ ok: false })
        : useFullPage
          ? chrome.runtime.sendMessage({ type: 'CAPTURE_FULL_PAGE_SCREENSHOT' })
          : chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
    const [snapResult, activityResult] = await Promise.allSettled([
      snapPromise,
      chrome.runtime.sendMessage({ type: 'GET_ACTIVITY' })
    ]);
    if (snapResult.status === 'fulfilled' && snapResult.value) {
      const snap = snapResult.value;
      if (snap.warning) stitchWarning = snap.warning;
      if (snap.ok && snap.strips?.length) {
        try {
          const stitched = await stitchScreenshotStrips(snap.strips);
          extras.screenshotDataUrl = stitched || snap.strips[0];
        } catch {
          extras.screenshotDataUrl = snap.strips[0];
          stitchWarning = (stitchWarning ? stitchWarning + ' ' : '') + 'Stitch failed — using first strip only.';
        }
      } else if (snap.ok && snap.dataUrl) {
        extras.screenshotDataUrl = snap.dataUrl;
      }
    }
    if (!extras.screenshotDataUrl && useFullPage) {
      const fb = await chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' });
      if (fb?.ok && fb.dataUrl) {
        extras.screenshotDataUrl = fb.dataUrl;
        if (!stitchWarning) stitchWarning = 'Viewport-only fallback (full-page capture failed or timed out).';
      }
    }
    if (activityResult.status === 'fulfilled' && activityResult.value?.activity) {
      extras.pageActivity = activityResult.value.activity;
    }
    const data = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, userMessage: userText, ...extras })
    });
    const sys = $('chat').querySelector('.bubble.system:last-of-type');
    if (sys && sys.textContent === 'thinking…') sys.remove();
    state.coverage = data.coverage || state.coverage;
    renderChecklist();
    renderBubble('assistant', data.reply);
    speakReply(data.reply);
    if (extras.skipScreenshot && !state.voiceEnabled) {
      systemMessage('Tip: click 🔊 to hear the agent read replies aloud.');
    }
    if (stitchWarning) systemMessage('📸 ' + stitchWarning);
  } catch (e) {
    const sys = $('chat').querySelector('.bubble.system:last-of-type');
    if (sys && sys.textContent === 'thinking…') sys.remove();
    systemMessage('Error: ' + e.message);
  } finally {
    state.thinking = false;
  }
}

$('send-btn').addEventListener('click', () => {
  const txt = $('chat-input').value.trim();
  if (!txt) return;
  $('chat-input').value = '';
  sendToAgent(txt);
});
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send-btn').click(); }
});

$('page-ctx-btn').addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_PAGE_CONTEXT' });
    if (!res.ok) { systemMessage('Context capture failed: ' + res.error); return; }
    sendToAgent(`I'm on "${res.context.title}". Have a look at the page structure and ask about anything specific.`, { pageContext: res.context });
  } catch (e) {
    systemMessage('Error: ' + e.message);
  }
});

const voiceMic = {
  active: false,
  starting: false,           // true while START_VOICE_INPUT is in flight
  _stopRequested: false,     // set by finishVoiceRecording when called during startup
  _stopping: false,          // guard against double-stop calls
  maxTimer: null,
  recognition: null,         // Web Speech Recognition instance
  webSpeechFinal: '',        // accumulated final text from Web Speech
  webSpeechSuccess: false,   // whether Web Speech produced usable text
  resolveWebSpeech: null,    // resolve for the Web Speech completion promise
  webSpeechPromise: Promise.resolve() // resolved when Web Speech is done (or skipped)
};

function setMicRecordingUi(on) {
  voiceMic.active = on;
  if (on) voiceMic._stopRequested = false;
  $('mic-btn').style.color = on ? 'var(--accent)' : '';
  $('mic-btn').textContent = '🎤';
  $('mic-btn').title = on
    ? 'Release to send your voice reply'
    : 'Hold to speak to the agent';
  if (!on) {
    $('voice-preview').classList.add('hidden');
    voiceMic._stopping = false;
    voiceMic._stopRequested = false;
  }
}

/** Show live transcription preview during voice recording. */
function updateVoicePreview(text, isFinal) {
  const preview = $('voice-preview');
  const textEl = $('voice-preview-text');
  if (!preview || !textEl) return;
  preview.classList.remove('hidden');
  textEl.textContent = text || '🎤 Listening…';
  textEl.className = isFinal ? 'voice-preview-text final' : 'voice-preview-text';
}

/** Start Web Speech Recognition for live transcription preview. */
function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.log('[sidepanel] Web Speech API not available — falling back to Whisper only.');
    voiceMic.webSpeechSuccess = false;
    voiceMic.resolveWebSpeech?.();
    return;
  }

  voiceMic.webSpeechPromise = new Promise(resolve => {
    voiceMic.resolveWebSpeech = resolve;
  });
  voiceMic.webSpeechSuccess = false;
  voiceMic.webSpeechFinal = '';

  try {
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (e) => {
      let interim = '';
      let final = voiceMic.webSpeechFinal;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          final += result[0].transcript + ' ';
        } else {
          interim += result[0].transcript;
        }
      }
      voiceMic.webSpeechFinal = final;
      updateVoicePreview((final + interim).trim(), false);
    };

    rec.onerror = (e) => {
      console.warn('[sidepanel] Web Speech error:', e.error, e.message);
      // 'no-speech' and 'aborted' are common — let onend finalize
    };

    rec.onend = () => {
      const text = voiceMic.webSpeechFinal.trim();
      voiceMic.webSpeechSuccess = !!text;
      if (text) {
        updateVoicePreview(text, true);
        // Don't populate chat input here — finishVoiceRecording handles auto-send
      } else {
        $('voice-preview').classList.add('hidden');
        systemMessage('No speech detected by browser — falling back to server transcription…');
      }
      voiceMic.recognition = null;
      voiceMic.resolveWebSpeech?.();
    };

    rec.start();
    voiceMic.recognition = rec;
    updateVoicePreview('', false);
    console.log('[sidepanel] Web Speech recognition started.');
  } catch (e) {
    console.error('[sidepanel] Web Speech start failed:', e);
    voiceMic.webSpeechSuccess = false;
    voiceMic.recognition = null;
    voiceMic.resolveWebSpeech?.();
  }
}

/** Stop Web Speech Recognition and finalize transcript. */
function stopWebSpeech() {
  if (voiceMic.recognition) {
    try {
      voiceMic.recognition.stop();
    } catch (e) {
      console.warn('[sidepanel] Web Speech stop error:', e);
      voiceMic.recognition = null;
      voiceMic.webSpeechSuccess = false;
      voiceMic.resolveWebSpeech?.();
    }
  } else {
    // No recognition instance — nothing to stop, resolve now
    voiceMic.webSpeechSuccess = false;
    voiceMic.resolveWebSpeech?.();
  }
}

/** Unified stop: Web Speech + offscreen recorder + timer cleanup. */
async function finishVoiceRecording() {
  if (voiceMic._stopping) return;
  voiceMic._stopping = true;
  voiceMic._stopRequested = true;
  if (voiceMic.maxTimer != null) {
    clearTimeout(voiceMic.maxTimer);
    voiceMic.maxTimer = null;
  }
  voiceMic.starting = false;
  stopWebSpeech();
  try {
    await chrome.runtime.sendMessage({ type: 'STOP_VOICE_INPUT' });
  } catch (e) {
    console.warn('[sidepanel] STOP_VOICE_INPUT failed:', e);
  }
}

// Push-to-talk: pointerdown starts recording, pointerup/pointerleave stops and sends.
$('mic-btn').addEventListener('pointerdown', async (e) => {
  e.preventDefault();
  $('mic-btn').setPointerCapture(e.pointerId);

  if (voiceMic.active || voiceMic.starting) return;

  if (!state.sessionId) {
    systemMessage('Click ● Start session first, then use 🎤 to speak to the agent.');
    return;
  }
  if (!state.apiBase?.trim() || !state.token) {
    systemMessage('Set API base URL and Wasabi token in Settings.');
    $('settings-panel')?.classList.remove('hidden');
    return;
  }

  voiceMic.starting = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'START_VOICE_INPUT' });
    if (res?.ok === false) throw new Error(res.error || 'Could not start microphone');
    voiceMic.starting = false;
    // Check if user already released while we were waiting for START_VOICE_INPUT
    if (voiceMic._stopRequested) {
      console.log('[sidepanel] Stop requested during startup — aborting.');
      return;
    }
    setMicRecordingUi(true);
    startWebSpeech();
    systemMessage('🎤 Listening… release to send.');
    if (voiceMic.maxTimer != null) clearTimeout(voiceMic.maxTimer);
    voiceMic.maxTimer = setTimeout(() => {
      if (!voiceMic.active) return;
      systemMessage('🎤 2 min limit — finalising…');
      finishVoiceRecording();
    }, 120000);
  } catch (e) {
    voiceMic.starting = false;
    setMicRecordingUi(false);
    systemMessage('Mic: ' + e.message);
  }
});

$('mic-btn').addEventListener('pointerup', (e) => {
  e.preventDefault();
  if (!voiceMic.active && !voiceMic.starting) return;
  finishVoiceRecording();
});

$('mic-btn').addEventListener('pointerleave', (e) => {
  // Only stop if actively recording (not just starting up)
  if (!voiceMic.active) return;
  systemMessage('🎤 Released — sending…');
  finishVoiceRecording();
});

// Also stop if the user releases the pointer anywhere outside the button
document.addEventListener('pointerup', (e) => {
  if (!voiceMic.active) return;
  if (e.target === $('mic-btn') || $('mic-btn').contains(e.target)) return;
  finishVoiceRecording();
});

const dropzone = $('dropzone');
const fileInput = $('file-input');
dropzone.addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

async function handleFiles(files) {
  for (const f of files) {
    let textContent = null;
    if (f.type.startsWith('text/') || /\.(json|csv|md|sql|yml|yaml|xml|html)$/i.test(f.name)) {
      textContent = await f.text();
    }
    try {
      await api('/api/files', {
        method: 'POST',
        body: JSON.stringify({ sessionId: state.sessionId, name: f.name, mimeType: f.type, sizeBytes: f.size, textContent })
      });
      state.uploadedFiles.push({ name: f.name, size: f.size });
      if (textContent) {
        await sendToAgent(`I'm sharing a file with you: ${f.name}.`, { fileContent: textContent, fileName: f.name });
      } else {
        systemMessage(`📎 ${f.name} attached (${(f.size/1024).toFixed(1)}KB).`);
      }
    } catch (e) {
      systemMessage('Upload failed: ' + e.message);
    }
  }
  renderFileList();
}

function renderFileList() {
  const ul = $('file-list');
  ul.innerHTML = '';
  state.uploadedFiles.forEach(f => {
    const li = document.createElement('li');
    li.innerHTML = `<span>📎 ${f.name} <span class="muted">(${(f.size/1024).toFixed(1)}KB)</span></span>`;
    ul.appendChild(li);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'VOICE_RECORD_STARTED') {
    setMicRecordingUi(true);
  }
  if (msg.type === 'VOICE_BLOB_READY') {
    if (voiceMic.maxTimer != null) {
      clearTimeout(voiceMic.maxTimer);
      voiceMic.maxTimer = null;
    }
    setMicRecordingUi(false);
    (async () => {
      try {
        // Wait for Web Speech to finish (it should already be done by now)
        await voiceMic.webSpeechPromise;
        if (voiceMic.webSpeechSuccess) {
          // Push-to-talk: Web Speech captured text — auto-send to agent
          const text = voiceMic.webSpeechFinal.trim();
          console.log('[sidepanel] Skipping Whisper — Web Speech captured:', text.slice(0, 80));
          $('voice-preview').classList.add('hidden');
          $('chat-input').value = '';
          if (text) {
            systemMessage(`You said: “${text.length > 100 ? text.slice(0, 100) + '…' : text}”`);
            await sendToAgent(text, { skipScreenshot: true });
          }
          return;
        }
        // Web Speech failed or not available — fall back to Whisper transcription
        let dataUrl = msg.dataUrl;
        // Fallback to session storage if direct dataUrl is missing (edge case)
        if (!dataUrl) {
          const stored = await chrome.storage.session.get('pendingVoiceBlob');
          dataUrl = stored.pendingVoiceBlob?.dataUrl;
          // Clean up after fallback read
          try { await chrome.storage.session.remove('pendingVoiceBlob'); } catch { /* non-critical */ }
        }
        if (!dataUrl) throw new Error('No audio received from recorder — try again.');
        console.log('[sidepanel] Voice blob received (Whisper fallback):', { mimeType: msg.mimeType, size: msg.size, dataUrlLen: dataUrl.length });
        const blob = await fetch(dataUrl).then((r) => r.blob());
        console.log('[sidepanel] Blob from dataUrl:', { type: blob.type, size: blob.size });
        await submitVoiceToAgent(blob, msg.mimeType);
      } catch (e) {
        console.error('[sidepanel] Voice processing failed:', e);
        systemMessage('Voice failed: ' + e.message);
      }
    })();
  }
  if (msg.type === 'VOICE_RECORD_ERROR') {
    if (voiceMic.maxTimer != null) {
      clearTimeout(voiceMic.maxTimer);
      voiceMic.maxTimer = null;
    }
    stopWebSpeech();
    voiceMic.starting = false;
    setMicRecordingUi(false);
    systemMessage('🎤 ' + (msg.error || 'Recording failed'));
  }

  if (msg.type === 'RECORDING_READY') {
    state.recordingUrl = msg.url;
    state.recordingMimeType = msg.mimeType;
    $('recording-section').classList.remove('hidden');
    $('recording-preview').src = msg.url;
    systemMessage(`📹 Recording ready (${(msg.size / 1024 / 1024).toFixed(1)}MB)`);
  }
  if (msg.type === 'OFFSCREEN_ERROR') systemMessage('Recording error: ' + msg.error);

  if (msg.type === 'AUTO_CAPTURE') {
    // Suppress if no session, already thinking, or voice not ready
    if (!state.sessionId || state.thinking) return;
    const desc = msg.description || 'page changed';
    systemMessage(`👁 Detected: ${desc}`);
    sendToAgent(
      `I noticed the interface just changed — ${desc}. In one sentence acknowledge what you can see, then ask your most targeted question about it.`,
      { screenshotDataUrl: msg.dataUrl, silent: true }
    );
  }
});

$('download-recording').addEventListener('click', () => {
  if (!state.recordingUrl) return;
  const a = document.createElement('a');
  a.href = state.recordingUrl;
  a.download = `wasabi-scope-${state.clientName || 'session'}-${Date.now()}.webm`;
  a.click();
});

$('transcribe-recording').addEventListener('click', async () => {
  if (!state.recordingUrl) return;
  systemMessage('Transcribing via server…');
  try {
    const blob = await fetch(state.recordingUrl).then(r => r.blob());
    const text = await transcribeAudioBlob(blob, 'recording.webm');
    $('transcript').textContent = text;
    $('transcript').classList.remove('hidden');
    systemMessage('Transcript stored. Feeding it to the agent.');
    await sendToAgent('Analyse the transcript of what I just demonstrated and ask follow-up questions.', {
      fileContent: text,
      fileName: 'session-transcript.txt'
    });
  } catch (e) {
    systemMessage('Transcription failed: ' + e.message);
  }
});

function triggerDownload(content, filename, mimeType = 'text/markdown') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Read an SSE stream from a generate endpoint, rendering text progressively in chat.
// Returns { fullText, version, url } on success, throws on error.
async function streamGenerate(endpoint, btn, btnLabel) {
  if (!state.sessionId) {
    systemMessage('No active session.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return null;
  }
  btn.disabled = true;
  btn.textContent = 'Generating…';

  // Scroll to chat and create a live bubble
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const chat = $('chat');
  const bubble = document.createElement('div');
  bubble.className = 'bubble assistant';
  bubble.textContent = '…';
  chat.appendChild(bubble);
  chat.scrollTop = chat.scrollHeight;

  try {
    const res = await fetch(state.apiBase + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wasabi-token': state.token },
      body: JSON.stringify({ sessionId: state.sessionId })
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

    let fullText = '';
    let buf = '';
    const reader = res.body.getReader();
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
        try {
          const evt = JSON.parse(raw);
          if (evt.error) throw new Error(evt.error);
          if (evt.delta) {
            fullText += evt.delta;
            bubble.textContent = fullText;
            chat.scrollTop = chat.scrollHeight;
          }
          if (evt.done) {
            btn.textContent = `✓ v${evt.version} downloaded`;
            setTimeout(() => { btn.disabled = false; btn.textContent = btnLabel; }, 4000);
            return { fullText, version: evt.version, url: evt.url };
          }
        } catch (e) {
          throw e;
        }
      }
    }
    throw new Error('Stream ended without done event');
  } catch (e) {
    bubble.remove();
    btn.textContent = btnLabel;
    btn.disabled = false;
    systemMessage('Generation failed: ' + e.message);
    return null;
  }
}

$('generate-scope').addEventListener('click', async () => {
  const slug = (state.clientName || 'client').replace(/\s+/g, '-');
  const result = await streamGenerate('/api/scope/generate', $('generate-scope'), 'Generate scoping document');
  if (!result) return;
  triggerDownload(result.fullText, `scope-${slug}-v${result.version}.md`);
  if (result.url) systemMessage(`📄 Scope doc v${result.version} — ${result.url}`);
});

$('generate-story').addEventListener('click', async () => {
  const slug = (state.clientName || 'client').replace(/\s+/g, '-');
  const result = await streamGenerate('/api/story/generate', $('generate-story'), 'Generate session story');
  if (!result) return;
  triggerDownload(result.fullText, `story-${slug}-v${result.version}.md`);
  if (result.url) systemMessage(`📖 Session story v${result.version} — ${result.url}`);
});

$('export-session').addEventListener('click', async () => {
  if (!state.sessionId) return;
  try {
    const data = await api(`/api/sessions/${state.sessionId}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wasabi-session-${state.sessionId}.json`;
    a.click();
  } catch (e) {
    systemMessage('Export failed: ' + e.message);
  }
});

$('new-session-btn').addEventListener('click', async () => {
  if (!confirm('Start a new session? The current one stays saved in the cloud.')) return;
  state.sessionId = null;
  state.coverage = {};
  state.uploadedFiles = [];
  await chrome.storage.local.set({ sessionId: null });
  $('chat').innerHTML = '';
  $('session-status').textContent = 'Idle';
  renderChecklist();
  renderFileList();
});

loadSettings();

$('full-page-shot')?.addEventListener('change', async () => {
  state.fullPageScreenshots = !!$('full-page-shot').checked;
  await chrome.storage.local.set({ fullPageScreenshots: state.fullPageScreenshots });
});
