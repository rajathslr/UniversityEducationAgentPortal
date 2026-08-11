'use strict';
// Shared helpers for both views.

// ---------------------------------------------------------------
// Client logging — mirrors to the console and ships warn/error to
// the backend (/api/client-logs) so front + back logs are correlated
// in one place. A per-page id ties a page's events together.
// ---------------------------------------------------------------
const __pageId = Math.random().toString(36).slice(2, 10);
function __safeContext(o) {
  if (o == null) return o;
  try {
    // Strip anything secret-looking before it leaves the browser.
    return JSON.parse(JSON.stringify(o, (k, v) => (/pass|token|secret|sid/i.test(k) ? '[redacted]' : v)));
  } catch (e) { return String(o); }
}
function clientLog(level, msg, context) {
  try { (console[level] || console.log).call(console, '[' + level + '] ' + msg, context || ''); } catch (e) { /* ignore */ }
  if (level === 'warn' || level === 'error') {
    try {
      fetch('/api/client-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, msg: String(msg), context: __safeContext(context), url: location.pathname, pageId: __pageId }),
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* logging must never throw */ }
  }
}
const log = {
  debug: (m, c) => clientLog('debug', m, c),
  info: (m, c) => clientLog('info', m, c),
  warn: (m, c) => clientLog('warn', m, c),
  error: (m, c) => clientLog('error', m, c),
};
// Global capture of uncaught errors and unhandled promise rejections.
window.addEventListener('error', (e) => {
  clientLog('error', 'window_error', { message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  clientLog('error', 'unhandled_rejection', { reason: r && r.message ? r.message : String(r), stack: r && r.stack });
});

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch (netErr) {
    // Network / TLS failure — never carries the request body.
    clientLog('error', 'api_network_error', { method, url, error: String(netErr) });
    throw netErr;
  }
  const reqId = (res.headers && res.headers.get) ? res.headers.get('X-Request-Id') : null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Note: we log method/url/status only — never the request body (may hold a password).
    clientLog('warn', 'api_error', { method, url, status: res.status, reqId, error: data && data.error });
    const err = new Error((data && data.error) || res.statusText);
    err.reqId = reqId;
    throw err;
  }
  return data;
}
const getJSON = (u) => api('GET', u);
const postJSON = (u, b) => api('POST', u, b);

// Multipart file upload (browser sets the Content-Type boundary itself).
async function apiUpload(url, file) {
  const fd = new FormData();
  fd.append('file', file);
  let res;
  try { res = await fetch(url, { method: 'POST', body: fd }); }
  catch (e) { clientLog('error', 'api_network_error', { method: 'POST', url, error: String(e) }); throw e; }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    clientLog('warn', 'api_error', { method: 'POST', url, status: res.status, error: data && data.error });
    throw new Error((data && data.error) || res.statusText);
  }
  return data;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'html') node.innerHTML = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
  }
  (children || []).forEach((c) => { if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return node;
}

function money(n) {
  return 'A$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money0(n) {
  return 'A$' + Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
}
function chip(text, kind, withDot) {
  return el('span', { class: 'chip ' + (kind || 'grey') },
    [withDot ? el('span', { class: 'dot' }) : null, text].filter(Boolean));
}
function fmtDate(s) { return s ? new Date(s).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function fmtDateTime(s) { return s ? new Date(s).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }

let _toastTimer;
function toast(msg, kind) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.appendChild(t); }
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Commission status -> {label, chip class, row class}. Keys are the API contract
// (do not change); only the labels are user-facing plain language.
const STATUS_META = {
  'payable':         { label: 'Payable',      chip: 'green', row: '' },
  'blocked-onshore': { label: 'Not payable',  chip: 'red',   row: 'blocked' },
  'frozen-coi':      { label: 'On hold',      chip: 'amber', row: 'frozen' },
  'not-due':         { label: 'Nothing owed', chip: 'grey',  row: '' },
};

const STAGE_CHIP = {
  'New': 'grey', 'In Review': 'blue', 'Docs Requested': 'amber',
  'Verified': 'teal', 'Decision': 'green',
};
// Plain-language display names for the pipeline stages (internal values unchanged).
const STAGE_LABEL = {
  'New': 'New', 'In Review': 'In review', 'Docs Requested': 'Documents requested',
  'Verified': 'Checks done', 'Decision': 'Decision',
};
const stageLabel = (s) => STAGE_LABEL[s] || s;

// Progress rail — computes step states from an agent's stage/decision.
// Rail: Applied -> In review -> Documents -> Verified -> Approved
const RAIL_STEPS = [
  { key: 'Applied',     order: 1 },
  { key: 'In review',   order: 2 },
  { key: 'Documents',   order: 3 },
  { key: 'Checks done', order: 4 },
  { key: 'Approved',    order: 5 },
];
function stageOrder(stage) {
  return { 'New': 1, 'In Review': 2, 'Docs Requested': 3, 'Verified': 4, 'Decision': 5 }[stage] || 1;
}
function renderRail(agent) {
  const cur = stageOrder(agent.stage);
  const rejected = agent.decision === 'Rejected';
  const rail = el('div', { class: 'rail' });
  RAIL_STEPS.forEach((s, i) => {
    let cls = 'step';
    if (rejected && s.order === 5) cls += ' rejected';
    else if (s.order < cur) cls += ' done';
    else if (s.order === cur) cls += (agent.decision === 'Approved' && s.order === 5) ? ' done' : ' active';
    const label = s.key === 'Approved' && rejected ? 'Rejected' : s.key;
    const glyph = (rejected && s.order === 5) ? '✕'
      : (s.order < cur || (agent.decision === 'Approved' && s.order === 5)) ? '✓'
      : s.order === cur ? '●' : String(s.order);
    const step = el('div', { class: cls }, [
      el('div', { class: 'node' }, [
        el('div', { class: 'dot' }, [glyph]),
        el('div', { class: 'lbl' }, [label]),
      ]),
    ]);
    if (i < RAIL_STEPS.length - 1) step.appendChild(el('div', { class: 'line' }));
    rail.appendChild(step);
  });
  return rail;
}

// ---- auth helpers (shared by all authenticated pages) ----
function homeFor(role) {
  return role === 'admin' ? '/admin' : role === 'officer' ? '/college' : '/agent';
}
// Fetch the current session; redirect to /login if unauthenticated, or to the
// caller's home if their role isn't allowed on this page. Returns the user or null.
async function requireSession(allowedRoles) {
  let user;
  try {
    user = (await getJSON('/api/auth/me')).user;
  } catch (e) {
    location.replace('/login');
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    location.replace(homeFor(user.role));
    return null;
  }
  return user;
}
async function logout() {
  try { await postJSON('/api/auth/logout'); } catch (e) { /* ignore */ }
  location.replace('/login');
}
// Build the signed-in chip + logout for the top nav.
function userChip(user) {
  const ROLE_LABEL = { admin: 'Administrator', officer: 'College officer', agent: 'Agent' };
  return el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
    el('div', { style: 'text-align:right;line-height:1.25' }, [
      el('div', { style: 'font-size:12.5px;font-weight:600' }, [user.full_name || user.username]),
      el('div', { style: 'font-size:11px;color:var(--muted-2,#8A9096)' }, [ROLE_LABEL[user.role] || user.role]),
    ]),
    el('button', { class: 'btn sm', style: 'background:transparent;color:#fff;border-color:rgba(255,255,255,.35)', onclick: logout }, ['Log out']),
  ]);
}

function table(headers, rows) {
  if (!rows.length) return el('div', { class: 'box-b' }, [el('div', { class: 'empty' }, ['None.'])]);
  const thead = el('tr', {}, headers.map((h) => el('th', h && h.align ? { style: 'text-align:' + h.align } : {}, [h && h.text != null ? h.text : h])));
  const body = rows.map((cells) =>
    el('tr', cells._row ? { class: cells._row } : {},
      cells.map((c) => el('td', c && c.align ? { style: 'text-align:' + c.align } : {}, [c && c.node !== undefined ? c.node : (typeof c === 'string' ? c : c)]))));
  return el('table', {}, [el('thead', {}, [thead]), el('tbody', {}, body)]);
}
