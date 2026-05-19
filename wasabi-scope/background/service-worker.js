// Background service worker
// - Opens the side panel when the toolbar icon is clicked
// - Routes messages between the side panel, content scripts, and the offscreen document
// - Captures screenshots of the tab the user shared at session start

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Recording screen and microphone for scoping sessions.'
  });
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

/** Vertical scroll offsets for stitched full-page capture (viewport-sized strips). */
function scrollCapturePositions(viewportH, scrollHeight, overlapPx, maxStrips) {
  const v = Math.round(viewportH);
  const h = Math.ceil(scrollHeight);
  if (!v || h <= v + 24) return { positions: [0], subsampled: false };
  const step = Math.max(v - overlapPx, Math.floor(v * 0.38));
  const lastAllowed = Math.max(0, h - v);
  const raw = [];
  for (let top = 0; top < lastAllowed; top += step) raw.push(Math.min(Math.round(top), lastAllowed));
  raw.push(lastAllowed);
  const uniq = [...new Set(raw)].sort((a, b) => a - b);
  if (uniq.length <= maxStrips) return { positions: uniq, subsampled: false };
  const sampled = [];
  const n = uniq.length - 1;
  for (let i = 0; i < maxStrips; i++) {
    sampled.push(uniq[Math.round((i * n) / (maxStrips - 1))]);
  }
  return { positions: [...new Set(sampled)].sort((a, b) => a - b), subsampled: true };
}

async function csMessageWithInject(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, payload);
  }
}

async function resolveCaptureTabWindow() {
  const stored = await chrome.storage.session.get('captureTabId');
  let tab;
  if (stored.captureTabId) {
    try {
      tab = await chrome.tabs.get(stored.captureTabId);
    } catch {
      tab = null;
    }
  }
  if (!tab) {
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    tab = tabs.find(t => t.active && !t.url?.startsWith('chrome-extension://')) || tabs[0];
    if (!tab) return null;
  }
  if (tab.url?.startsWith('chrome://')) return null;
  return tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'START_RECORDING': {
          await ensureOffscreenDocument();
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START',
            includeMic: msg.includeMic !== false,
            includeAudio: msg.includeAudio !== false
          });
          sendResponse({ ok: true });
          break;
        }
        case 'STOP_RECORDING': {
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
          sendResponse({ ok: true });
          break;
        }

        case 'START_VOICE_INPUT': {
          await ensureOffscreenDocument();
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_VOICE_START' });
          sendResponse({ ok: true });
          break;
        }
        case 'STOP_VOICE_INPUT': {
          await ensureOffscreenDocument();
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_VOICE_STOP' });
          sendResponse({ ok: true });
          break;
        }

        case 'RECORDING_BLOB_READY': {
          chrome.runtime.sendMessage({ type: 'RECORDING_READY', url: msg.url, mimeType: msg.mimeType, size: msg.size });
          sendResponse({ ok: true });
          break;
        }

        // Offscreen → service worker only; relay to side panel (MV3 does not fan-out to all contexts).
        // Pass dataUrl directly — session storage adds unnecessary fragility.
        case 'VOICE_BLOB_READY': {
          // Also store as fallback in case the sidepanel is not ready for the direct message.
          try {
            await chrome.storage.session.set({
              pendingVoiceBlob: { dataUrl: msg.dataUrl, mimeType: msg.mimeType, size: msg.size }
            });
          } catch (e) {
            console.warn('[service-worker] pendingVoiceBlob storage failed (non-fatal):', e);
          }
          chrome.runtime.sendMessage({
            type: 'VOICE_BLOB_READY',
            dataUrl: msg.dataUrl,
            mimeType: msg.mimeType,
            size: msg.size
          }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'VOICE_RECORD_STARTED': {
          chrome.runtime.sendMessage({ type: 'VOICE_RECORD_STARTED' }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'VOICE_RECORD_ERROR': {
          chrome.runtime.sendMessage({ type: 'VOICE_RECORD_ERROR', error: msg.error }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }

        case 'SET_CAPTURE_TARGET': {
          // Called when the user clicks Start session.
          // Records which tab to capture screenshots from for the rest of the session.
          if (msg.tabId) {
            await chrome.storage.session.set({ captureTabId: msg.tabId });
            sendResponse({ ok: true, tabId: msg.tabId });
          } else {
            // No tabId supplied — discover the best candidate
            const tabs = await chrome.tabs.query({ windowType: 'normal' });
            const candidate = tabs.find(t => t.active && !t.url?.startsWith('chrome-extension://')) || tabs[0];
            if (candidate) {
              await chrome.storage.session.set({ captureTabId: candidate.id });
              sendResponse({ ok: true, tabId: candidate.id, url: candidate.url, title: candidate.title });
            } else {
              sendResponse({ ok: false, error: 'No tabs available' });
            }
          }
          break;
        }

        case 'CAPTURE_SCREENSHOT': {
          try {
            const tab = await resolveCaptureTabWindow();
            if (!tab) {
              sendResponse({ ok: false, error: 'No tab available to capture' });
              return;
            }
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
            sendResponse({ ok: true, dataUrl, tabUrl: tab.url, tabTitle: tab.title });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }

        case 'CAPTURE_FULL_PAGE_SCREENSHOT': {
          const tab = await resolveCaptureTabWindow();
          if (!tab) {
            sendResponse({ ok: false, error: 'No tab available to capture', strips: [], truncated: false });
            break;
          }
          let restoreScrollY = 0;
          try {
            const strips = [];
            let warning = null;
            try {
              const prep = await csMessageWithInject(tab.id, { type: 'SCROLL_CAPTURE_PREP' });
              if (!prep?.ok) throw new Error('Could not prepare page for scroll capture');
              restoreScrollY = prep.savedScrollY ?? 0;
              const ms = msg.maxStrips ?? 14;
              const { positions, subsampled } = scrollCapturePositions(prep.viewportH, prep.scrollHeight, 76, ms);
              if (subsampled) {
                warning = 'Very tall page — using spaced scroll samples; demo inner-scroll areas separately if needed.';
              }
              for (const top of positions) {
                await csMessageWithInject(tab.id, { type: 'SCROLL_CAPTURE_GOTO', top });
                await new Promise((r) => setTimeout(r, 280));
                const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 67 });
                strips.push(dataUrl);
              }
              sendResponse({
                ok: true,
                strips,
                stripCount: strips.length,
                tabUrl: tab.url,
                tabTitle: tab.title,
                truncated: !!warning,
                warning: warning || undefined
              });
            } finally {
              try {
                await csMessageWithInject(tab.id, {
                  type: 'SCROLL_CAPTURE_RESTORE',
                  savedScrollY: restoreScrollY
                });
              } catch (eR) {
                console.warn('[service-worker] scroll restore failed', eR);
              }
            }
          } catch (e) {
            sendResponse({ ok: false, error: e.message, strips: [], truncated: false });
          }
          break;
        }

        case 'CAPTURE_PAGE_CONTEXT': {
          // Ask the captured tab's content script for DOM context (or fall back to active tab)
          const stored = await chrome.storage.session.get('captureTabId');
          let tab;
          if (stored.captureTabId) {
            try { tab = await chrome.tabs.get(stored.captureTabId); } catch { tab = null; }
          }
          if (!tab) {
            const tabs = await chrome.tabs.query({ windowType: 'normal' });
            tab = tabs.find(t => t.active && !t.url?.startsWith('chrome-extension://')) || tabs[0];
          }
          if (!tab) {
            sendResponse({ ok: false, error: 'No active tab' });
            return;
          }
          try {
            const ctx = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
            sendResponse({ ok: true, context: ctx, tab: { id: tab.id, url: tab.url, title: tab.title } });
          } catch {
            // Content script not present (tab predates extension load) — inject it and retry once
            try {
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
              const ctx = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
              sendResponse({ ok: true, context: ctx, tab: { id: tab.id, url: tab.url, title: tab.title } });
            } catch (e2) {
              sendResponse({ ok: false, error: e2.message });
            }
          }
          break;
        }
        case 'GET_ACTIVITY': {
          // Fetch activity log from the captured tab's content script and drain it
          const stored = await chrome.storage.session.get('captureTabId');
          let tab;
          if (stored.captureTabId) {
            try { tab = await chrome.tabs.get(stored.captureTabId); } catch { tab = null; }
          }
          if (!tab) {
            const tabs = await chrome.tabs.query({ windowType: 'normal' });
            tab = tabs.find(t => t.active && !t.url?.startsWith('chrome-extension://')) || tabs[0];
          }
          if (!tab) { sendResponse({ ok: true, activity: '', count: 0 }); break; }
          try {
            const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ACTIVITY' });
            sendResponse({ ok: true, ...result });
          } catch {
            try {
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
              const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ACTIVITY' });
              sendResponse({ ok: true, ...result });
            } catch (e2) {
              sendResponse({ ok: true, activity: '', count: 0 });
            }
          }
          break;
        }

        case 'DOM_CHANGE_DETECTED': {
          // Content script detected a modal or new content — capture viewport and notify sidepanel
          try {
            const tab = await resolveCaptureTabWindow();
            if (tab) {
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 72 });
              chrome.runtime.sendMessage({
                type: 'AUTO_CAPTURE',
                description: msg.description,
                dataUrl,
                tabUrl: tab.url,
                tabTitle: tab.title
              }).catch(() => {}); // sidepanel may not be open
            }
          } catch (e) {
            console.warn('[service-worker] auto-capture failed:', e.message);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'CLOSE_OFFSCREEN': {
          await closeOffscreenDocument();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (e) {
      console.error('[service-worker]', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep channel open for async response
});
