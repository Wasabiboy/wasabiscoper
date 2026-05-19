// Content script: extracts structural context and tracks user interactions.
// Activity events are sent automatically with every chat turn so Claude
// can reference what the user just did ("I see you clicked Add Job, then...").

let activityLog = [];
const MAX_EVENTS = 150;

let _savedScrollCaptureY = 0;

function logActivity(type, data) {
  const time = new Date().toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  activityLog.push({ time, type, ...data });
  if (activityLog.length > MAX_EVENTS) activityLog.shift();
}

// --- Event listeners ---

// Clicks: resolve to the nearest meaningful interactive element
document.addEventListener('click', (e) => {
  const el = e.target.closest(
    'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], ' +
    'input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], label'
  ) || e.target;
  const text = (el.innerText || el.value || el.title || el.getAttribute('aria-label') || '').trim().slice(0, 80);
  if (!text && !el.id && el === e.target) return; // skip blank background clicks
  logActivity('click', {
    element: el.tagName.toLowerCase(),
    text: text || null,
    id: el.id || null,
    href: el.tagName === 'A' ? (el.getAttribute('href') || null) : null,
    type: el.type || null
  });
}, true);

// Form field changes (fires after user leaves field or selects option)
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
  if (el.type === 'password') return;
  const label = (el.labels?.[0]?.innerText?.trim()) || el.placeholder || el.name || el.id || '?';
  let value;
  if (el.tagName === 'SELECT') {
    value = el.options[el.selectedIndex]?.text || el.value;
  } else if (el.type === 'checkbox' || el.type === 'radio') {
    value = el.checked ? 'checked' : 'unchecked';
  } else {
    value = el.value?.slice(0, 100);
  }
  logActivity('change', {
    field: label.slice(0, 60),
    value: value || null,
    inputType: el.type || el.tagName.toLowerCase()
  });
}, true);

// Form submissions
document.addEventListener('submit', (e) => {
  const form = e.target;
  const fields = [...form.querySelectorAll(
    'input:not([type="hidden"]):not([type="password"]), select, textarea'
  )].slice(0, 20).map(f =>
    (f.labels?.[0]?.innerText?.trim() || f.placeholder || f.name || f.id || '?').slice(0, 40)
  ).filter(Boolean);
  logActivity('submit', {
    action: (form.action || '').replace(location.origin, '') || location.pathname,
    fields
  });
}, true);

// SPA navigation (hash routing, pushState, replaceState)
function onNavigate() {
  logActivity('navigate', {
    url: location.pathname + location.search + location.hash,
    title: document.title.slice(0, 80)
  });
}
window.addEventListener('hashchange', onNavigate);
window.addEventListener('popstate', onNavigate);
try {
  const origPush = history.pushState.bind(history);
  history.pushState = function (...args) { origPush(...args); onNavigate(); };
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) { origReplace(...args); onNavigate(); };
} catch {}

// --- Formatters ---

function summarize(el, maxText = 80) {
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 4),
    text: (el.innerText || '').trim().slice(0, maxText) || null
  };
}

function formatActivity(events) {
  return events.map(e => {
    switch (e.type) {
      case 'click': {
        const label = e.text || e.id || e.element;
        return `[${e.time}] clicked "${label}"${e.href ? ' → ' + e.href : ''}`;
      }
      case 'change':
        return `[${e.time}] set "${e.field}" = "${e.value}"`;
      case 'submit':
        return `[${e.time}] submitted form${e.action !== location.pathname ? ' (' + e.action + ')' : ''}: ${e.fields.join(', ')}`;
      case 'navigate':
        return `[${e.time}] navigated → ${e.url}`;
      default:
        return `[${e.time}] ${e.type}`;
    }
  }).join('\n');
}

// --- DOM extraction (unchanged) ---

function extractForms() {
  // querySelectorAll traverses the full DOM tree regardless of scroll position.
  // Off-screen and overflow-hidden fields are all captured.
  return [...document.querySelectorAll('form, [role="form"], [data-form]')].slice(0, 10).map(form => ({
    action: form.action || null,
    method: form.method || 'GET',
    fields: [...form.querySelectorAll('input, select, textarea')].slice(0, 50).map(f => {
      const label = (f.labels && f.labels[0]?.innerText?.trim())
        || f.placeholder
        || f.getAttribute('aria-label')
        || f.name
        || f.id
        || null;
      const value = f.type === 'password' ? null
        : f.type === 'checkbox' || f.type === 'radio' ? (f.checked ? 'checked' : 'unchecked')
        : f.tagName === 'SELECT' ? (f.options[f.selectedIndex]?.text || f.value || null)
        : (f.value?.slice(0, 100) || null);
      return {
        label,
        name: f.name || f.id || null,
        type: f.type || f.tagName.toLowerCase(),
        required: !!f.required,
        value: value || null,
        options: f.tagName === 'SELECT' ? [...f.options].map(o => o.text).slice(0, 30) : null
      };
    })
  }));
}

function extractTables() {
  return [...document.querySelectorAll('table')].slice(0, 8).map(table => {
    const headers = [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
      .map(h => h.innerText.trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 25);

    const bodyRows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')];

    // All rows are in the DOM regardless of scroll — capture up to 20 as sample
    const sampleRows = bodyRows.slice(0, 20).map(row =>
      [...row.querySelectorAll('td')].map(cell => cell.innerText.trim().slice(0, 80)).filter(Boolean)
    ).filter(r => r.length);

    return { headers, rowCount: bodyRows.length, sampleRows };
  });
}

function extractLists() {
  // Capture definition lists, label-value pairs common in detail/view pages
  const details = [];

  // dl / dt+dd pairs (common in Knack detail views)
  document.querySelectorAll('dl').forEach(dl => {
    const pairs = [];
    let currentLabel = null;
    [...dl.children].forEach(el => {
      if (el.tagName === 'DT') currentLabel = el.innerText.trim().slice(0, 60);
      if (el.tagName === 'DD' && currentLabel) {
        pairs.push({ label: currentLabel, value: el.innerText.trim().slice(0, 120) });
        currentLabel = null;
      }
    });
    if (pairs.length) details.push({ type: 'dl', pairs });
  });

  // .kn-detail-body style label+value elements (Knack-specific)
  const knackDetails = [...document.querySelectorAll('.kn-detail-body .kn-label, .kn-view-asset label')]
    .slice(0, 30)
    .map(label => {
      const value = label.nextElementSibling?.innerText?.trim()
        || label.closest('.kn-detail-field')?.querySelector('.kn-detail-field-value, span:last-child')?.innerText?.trim();
      return value ? { label: label.innerText.trim().slice(0, 60), value: value.slice(0, 120) } : null;
    })
    .filter(Boolean);

  if (knackDetails.length) details.push({ type: 'knack-detail', pairs: knackDetails });

  return details;
}

function extractNavigation() {
  return [...document.querySelectorAll('nav a, [role="navigation"] a, .sidebar a, .menu a, .kn-app-menu a')]
    .map(a => ({ text: a.innerText.trim().slice(0, 40), href: a.getAttribute('href') }))
    .filter(n => n.text)
    .slice(0, 40);
}

/**
 * Lightweight hints from embedded builder runtimes when exposed on window.
 */
function extractPlatformHints() {
  const hints = {
    iframeCount: document.querySelectorAll('iframe').length,
    knack: null,
    zohoCreator: null
  };

  try {
    const K = typeof Knack !== 'undefined' ? Knack : null;
    if (K) {
      let sceneKey = null;
      try {
        if (typeof K.getSceneSlug === 'function') sceneKey = K.getSceneSlug();
        else if (K.scene?.key) sceneKey = String(K.scene.key);
        else if (K.scene_slug) sceneKey = String(K.scene_slug);
      } catch {
        /* ignore */
      }
      hints.knack = {
        runtimePresent: true,
        applicationId: K.application_id || null,
        sceneKeyOrSlug: sceneKey,
        locationHash: typeof location.hash === 'string' ? location.hash.slice(0, 220) || null : null,
        knackDomLikely: !!document.querySelector('[class*="kn-"]')
      };
    }
  } catch {
    hints.knack = { runtimePresent: true, note: 'Could not safely read Knack runtime' };
  }

  try {
    if (typeof window.ZohoCreatorSDK !== 'undefined') {
      hints.zohoCreator = { sdkPresent: true };
    }
    const zcMeta = document.querySelector('meta[name="zc-app"], meta[property="zc:app"]');
    const zcHint = zcMeta?.content || zcMeta?.getAttribute('content');
    if (zcHint) {
      hints.zohoCreator = hints.zohoCreator || {};
      hints.zohoCreator.metaAppHint = zcHint.slice(0, 120);
    }
    if (/\bzoho creator\b/i.test(document.title)) {
      hints.zohoCreator = hints.zohoCreator || {};
      hints.zohoCreator.titleMatch = true;
    }
    const zcRoots = [
      '[id*="zc_"]',
      '[class*="zoho "]',
      '.zcform',
      '[data-zc*="form"]'
    ];
    const zohoDomLikely =
      !!(document.querySelector(zcRoots.join(', ')) || document.querySelector('script[src*="zohocreator.com"]'));
    if (zohoDomLikely) {
      hints.zohoCreator = hints.zohoCreator || {};
      hints.zohoCreator.domLikely = true;
    }
  } catch {
    /* ignore */
  }

  return hints;
}

function getScrollMetricsForCapture() {
  const docEl = document.documentElement;
  const body = document.body || docEl;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const scrollHeight = Math.max(docEl.scrollHeight, body.scrollHeight, viewportH);
  const scrollWidth = Math.max(docEl.scrollWidth, body.scrollWidth, viewportW);
  return { viewportH, viewportW, scrollHeight, scrollWidth };
}

function getPageContext() {
  const scrollMetrics = getScrollMetricsForCapture();
  return {
    url: location.href,
    title: document.title,
    h1: document.querySelector('h1')?.innerText?.trim() || null,
    headings: [...document.querySelectorAll('h1, h2, h3')].slice(0, 15).map(h => ({
      level: h.tagName.toLowerCase(),
      text: h.innerText.trim().slice(0, 80)
    })),
    forms: extractForms(),
    tables: extractTables(),
    detailViews: extractLists(),
    navigation: extractNavigation(),
    platformHints: extractPlatformHints(),
    scrollHint: {
      viewportHeight: scrollMetrics.viewportH,
      approximatePageScrollHeightPx: scrollMetrics.scrollHeight,
      likelyNeedsFullPageScreenshot: scrollMetrics.scrollHeight > scrollMetrics.viewportH + 120
    },
    // Note: all elements above are from the full DOM tree and include off-screen /
    // scrolled-out content. The only exception would be virtualised lists (react-window
    // etc.) which only mount visible rows — standard Knack tables don't use these.
    // Inner scroll containers (embedded grids) stay partially hidden until scrolled.
    timestamp: new Date().toISOString()
  };
}

// --- DOM change observer ---

let _domCaptureInhibited = false; // true during scroll-capture to suppress false triggers
let _lastAutoCapture = 0;
const _AUTO_COOLDOWN_MS = 8000; // minimum gap between auto-captures

const _MODAL_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.kn-modal',
  '.kn-popup',
  '.kn-modal-bg ~ *',
  '[class*="modal"]',
  '[class*="dialog"]',
  '[class*="lightbox"]',
  '[class*="overlay"]',
].join(', ');

function _describeSignificantNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  // Skip elements that are off-screen or tiny
  try {
    const rect = node.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) return null;
  } catch { return null; }

  // Modal or dialog directly or containing one
  const modalEl = node.matches?.(_MODAL_SELECTORS) ? node
    : node.querySelector?.(_MODAL_SELECTORS);
  if (modalEl) {
    const heading = modalEl.querySelector('h1, h2, h3, [role="heading"], .kn-title');
    const title = heading?.innerText?.trim().slice(0, 60)
      || modalEl.getAttribute('aria-label')?.slice(0, 60)
      || modalEl.id
      || 'dialog';
    return `dialog opened: "${title}"`;
  }

  // Large content block — new view or panel loaded
  const interactive = node.querySelectorAll?.(
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"], [role="menuitem"]'
  );
  if (interactive && interactive.length >= 4) {
    const heading = node.querySelector('h1, h2, h3');
    const title = heading?.innerText?.trim().slice(0, 60) || document.title.slice(0, 60);
    return `new page content loaded: "${title}"`;
  }

  return null;
}

const _domObserver = new MutationObserver((mutations) => {
  if (_domCaptureInhibited) return;
  const now = Date.now();
  if (now - _lastAutoCapture < _AUTO_COOLDOWN_MS) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      const desc = _describeSignificantNode(node);
      if (desc) {
        _lastAutoCapture = now;
        logActivity('dom-change', { description: desc });
        chrome.runtime.sendMessage({ type: 'DOM_CHANGE_DETECTED', description: desc }).catch(() => {});
        return; // one event per mutation batch
      }
    }
  }
});

_domObserver.observe(document.body, { childList: true, subtree: true });

// --- Message handlers ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SCROLL_CAPTURE_PREP') {
    _domCaptureInhibited = true; // suppress observer during scroll capture
    _savedScrollCaptureY = window.scrollY ?? document.documentElement.scrollTop ?? 0;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    const m = getScrollMetricsForCapture();
    sendResponse({ ok: true, savedScrollY: _savedScrollCaptureY, ...m });
  }

  if (msg.type === 'SCROLL_CAPTURE_GOTO') {
    const top = typeof msg.top === 'number' ? msg.top : 0;
    window.scrollTo({ top: Math.max(0, top), left: 0, behavior: 'instant' });
    sendResponse({
      ok: true,
      scrollTop: window.scrollY ?? document.documentElement.scrollTop ?? 0
    });
  }

  if (msg.type === 'SCROLL_CAPTURE_RESTORE') {
    window.scrollTo({ top: msg.savedScrollY ?? _savedScrollCaptureY ?? 0, left: 0, behavior: 'instant' });
    _domCaptureInhibited = false; // re-enable observer
    sendResponse({ ok: true });
  }

  if (msg.type === 'GET_PAGE_CONTEXT') {
    const ctx = getPageContext();
    ctx.recentActivity = formatActivity(activityLog.slice(-30));
    sendResponse(ctx);
  }

  if (msg.type === 'GET_ACTIVITY') {
    // Return formatted log and drain it so the next turn starts fresh
    const events = activityLog.slice();
    activityLog = [];
    sendResponse({
      activity: formatActivity(events),
      count: events.length
    });
  }

  return true;
});
