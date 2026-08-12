'use strict';
// Admin controller — user management. Admin role only.

let me = null;

async function init() {
  me = await requireSession(['admin']);
  if (!me) return;
  document.getElementById('userChip').appendChild(userChip(me));

  // Sidebar section switching.
  document.querySelector('#adminNav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (!a) return;
    e.preventDefault();
    document.querySelectorAll('#adminNav a').forEach((x) => x.classList.toggle('active', x === a));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
    document.getElementById('tab-' + a.dataset.tab).classList.add('show');
  });

  // Show/hide the agency field based on role.
  const roleSel = document.getElementById('role');
  const toggleAgency = () => {
    document.getElementById('agencyField').style.display = roleSel.value === 'agent' ? '' : 'none';
  };
  roleSel.addEventListener('change', toggleAgency);
  toggleAgency();

  document.getElementById('addBtn').addEventListener('click', addUser);

  // Agency creation: prefill sample values so it's submit-ready, but editable.
  document.getElementById('fillSample').addEventListener('click', fillAgencySample);
  document.getElementById('createAgencyBtn').addEventListener('click', createAgency);
  fillAgencySample();

  await loadAgencyOptions();
  await loadApplications();
  await loadAgencies();
  await loadUsers();
}

// Fill the "Agency (for agent)" picker. Must be re-run whenever an agency is
// added — creating one or approving an application — or the new agency can't
// be picked until the page is reloaded.
async function loadAgencyOptions() {
  const agents = await getJSON('/api/agents');
  const sel = document.getElementById('agentId');
  const previous = sel.value;
  sel.innerHTML = '';
  agents.forEach((a) => sel.appendChild(el('option', { value: a.id }, [a.business_name])));
  if (previous && agents.some((a) => String(a.id) === previous)) sel.value = previous;
}

// ---- public applications review queue ----
const APP_CHIP = { Pending: 'amber', Approved: 'green', Rejected: 'red' };

async function loadApplications() {
  const apps = await getJSON('/api/admin/applications');
  const host = document.getElementById('applicationList');
  host.innerHTML = '';

  const pending = apps.filter((a) => a.status === 'Pending');
  const badge = document.getElementById('appsBadge');
  if (pending.length) { badge.style.display = ''; badge.textContent = String(pending.length); }
  else badge.style.display = 'none';

  if (!apps.length) {
    host.appendChild(el('div', { class: 'box' }, [el('div', { class: 'box-b' }, [
      el('div', { class: 'empty' }, ['No applications yet. They arrive from the public form at /apply.']),
    ])]));
    return;
  }

  // Pending get a full review card; decided ones collapse into a compact table.
  pending.forEach((a) => host.appendChild(applicationCard(a)));

  const decided = apps.filter((a) => a.status !== 'Pending');
  if (decided.length) {
    host.appendChild(el('div', { class: 'sec-head', style: 'margin-top:22px' }, [
      el('h2', {}, ['Already reviewed']),
      el('p', {}, [String(decided.length) + ' application' + (decided.length === 1 ? '' : 's')]),
    ]));
    host.appendChild(el('div', { class: 'box' }, [table(
      ['Agency', 'Contact', 'Status', 'Reviewed', 'Reason'],
      decided.map((a) => [
        { node: el('div', {}, [
          el('div', { class: 'sname' }, [a.business_name]),
          el('div', { class: 'ssub mono' }, ['ABN ' + a.abn]),
        ]) },
        a.operator_name || '—',
        { node: chip(a.status, APP_CHIP[a.status] || 'grey', true) },
        { node: el('span', { class: 'small muted' }, [
          fmtDate(a.reviewed_at) + (a.reviewed_by ? ' · ' + a.reviewed_by : '')]) },
        { node: el('span', { class: 'small muted' }, [a.decision_reason || '—']) },
      ])
    )]));
  }
}

function applicationCard(a) {
  const box = el('div', { class: 'box' }, [
    el('div', { class: 'box-h' }, [
      el('h3', {}, [a.business_name]),
      chip('Pending', 'amber', true),
      el('div', { class: 'spacer' }),
      el('span', { class: 'small muted' }, ['Applied ' + fmtDateTime(a.submitted_at)]),
    ]),
  ]);
  const body = el('div', { class: 'box-b' });
  body.appendChild(kv([
    ['ABN', a.abn],
    ['Primary contact', a.operator_name],
    ['Email', a.operator_email],
    ['City', a.origin_city || '—'],
    ['Market', a.source_market || '—'],
    ['MARN', a.marn || 'None declared'],
  ]));
  if (a.note) {
    body.appendChild(el('div', { class: 'note', style: 'margin-top:10px' },
      [el('span', { class: 'i' }, ['“']), el('span', {}, [a.note])]));
  }
  if (a.marn) {
    body.appendChild(el('div', { class: 'note', style: 'margin-top:8px' }, [
      el('span', { class: 'i' }, ['⚠']),
      el('span', {}, ['Declared a MARN — once approved this agency is a dual agent, so its students stay on hold until the conflict-of-interest declaration is signed.']),
    ]));
  }

  // Approving needs a login; suggest a sensible username but let it be edited.
  const suggested = (a.business_name || 'agent').toLowerCase()
    .replace(/pty|ltd|limited|\./g, '').trim().split(/\s+/)[0].replace(/[^a-z0-9]/g, '').slice(0, 12)
    || 'agent';
  const userIn = el('input', { type: 'text', value: suggested });
  const passIn = el('input', { type: 'text', value: 'Temp' + Math.floor(Math.random() * 9000 + 1000) + '!' });
  body.appendChild(el('div', { style: 'margin-top:14px;border-top:1px solid var(--line-2);padding-top:14px' }, [
    el('div', { style: 'font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px' },
      ['Issue their login (they sign in with these)']),
    el('div', { class: 'split' }, [
      el('div', { class: 'field' }, [el('label', {}, ['Username']), userIn]),
      el('div', { class: 'field' }, [el('label', {}, ['Initial password (min 8)']), passIn]),
    ]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn sm primary', onclick: () => approveApplication(a, userIn.value.trim(), passIn.value) },
        ['Approve & create agency']),
      el('button', { class: 'btn sm danger', onclick: () => rejectApplication(a) }, ['Reject']),
    ]),
  ]));
  box.appendChild(body);
  return box;
}

async function approveApplication(a, username, password) {
  if (!username) { toast('Enter a username for their login.', 'err'); return; }
  if ((password || '').length < 8) { toast('Password must be at least 8 characters.', 'err'); return; }
  if (!confirm('Approve “' + a.business_name + '”?\n\nThis creates the agency at the New stage, issues the login "'
    + username + '", and requests their onboarding documents.')) return;
  try {
    const r = await postJSON('/api/admin/applications/' + a.id + '/approve', { username, password });
    toast('Approved — “' + r.agent.business_name + '” created with login “' + r.user.username + '”.', 'ok');
    await loadApplications();
    await loadAgencyOptions();
    await loadAgencies();
    await loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

async function rejectApplication(a) {
  const reason = prompt('Why is “' + a.business_name + '” being rejected?\n(Kept on the record.)');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required.', 'err'); return; }
  try {
    await postJSON('/api/admin/applications/' + a.id + '/reject', { reason: reason.trim() });
    toast('Application rejected.', 'ok');
    await loadApplications();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- existing agencies list ----
const STAGE_CHIP_A = { 'New': 'grey', 'In Review': 'blue', 'Docs Requested': 'amber', 'Verified': 'teal', 'Decision': 'green' };
async function loadAgencies() {
  const agents = await getJSON('/api/agents');
  const host = document.getElementById('agencyList');
  host.innerHTML = '';
  if (!agents.length) { host.appendChild(el('div', { class: 'box-b' }, [el('div', { class: 'empty' }, ['No agencies yet.'])])); return; }
  const rows = agents.map((a) => [
    { node: el('div', {}, [el('div', { class: 'sname' }, [a.business_name]), el('div', { class: 'ssub mono' }, ['ABN ' + a.abn])]) },
    { node: chip(a.stage, STAGE_CHIP_A[a.stage] || 'grey', true) },
    { node: a.decision ? chip(a.decision, a.decision === 'Approved' ? 'green' : 'red', true) : el('span', { class: 'muted small' }, ['—']) },
    { node: (a.relationship_status && a.relationship_status !== 'Active')
        ? chip(a.relationship_status, a.relationship_status === 'Terminated' ? 'red' : 'amber', true)
        : chip('Active', 'green') },
    a.operator_name || '—',
  ]);
  host.appendChild(table(['Agency', 'Stage', 'Decision', 'Relationship', 'Operator'], rows));
}

// ---- create agency (prefilled, editable) ----
const SAMPLE_NAMES = ['Beacon', 'Summit', 'Orchid', 'Pioneer', 'Coral', 'Vertex', 'Harbour', 'Lotus'];
function fillAgencySample() {
  const w = SAMPLE_NAMES[Math.floor(Math.random() * SAMPLE_NAMES.length)];
  const slug = w.toLowerCase();
  const set = (id, v) => { document.getElementById(id).value = v; };
  set('ag_business', w + ' Study Abroad Pty Ltd');
  set('ag_abn', randAbn());
  set('ag_market', 'India');
  set('ag_op', w + ' Operator');
  set('ag_email', 'operator@' + slug + '.example');
  set('ag_marn', '');
  set('ag_user', slug + Math.floor(Math.random() * 90 + 10));
  set('ag_pass', 'Temp' + Math.floor(Math.random() * 9000 + 1000) + '!');
}
function randAbn() {
  let s = '';
  for (let i = 0; i < 11; i++) s += Math.floor(Math.random() * 10);
  return s.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4');
}
async function createAgency() {
  const val = (id) => document.getElementById(id).value.trim();
  const body = {
    business_name: val('ag_business'),
    abn: val('ag_abn'),
    source_market: val('ag_market') || 'India',
    operator_name: val('ag_op'),
    operator_email: val('ag_email'),
    marn: val('ag_marn'),
    username: val('ag_user'),
    password: val('ag_pass'),
  };
  try {
    const r = await postJSON('/api/admin/agencies', body);
    toast('Agency created — login “' + r.user.username + '” · starts at New with documents requested.', 'ok');
    fillAgencySample();
    await loadAgencyOptions();
    await loadAgencies();
    await loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

const ROLE_CHIP = { admin: 'blue', officer: 'teal', agent: 'grey' };

async function loadUsers() {
  const users = await getJSON('/api/admin/users');
  const host = document.getElementById('userList');
  host.innerHTML = '';
  const rows = users.map((u) => {
    const actions = el('div', { class: 'actions' }, [
      el('button', { class: 'btn sm', onclick: () => resetPw(u) }, ['Reset password']),
      el('button', { class: 'btn sm danger', onclick: () => removeUser(u), disabled: u.id === me.id ? 'disabled' : null }, ['Delete']),
    ]);
    return [
      { node: el('div', {}, [
        el('div', { class: 'sname' }, [u.full_name || u.username]),
        el('div', { class: 'ssub mono' }, ['@' + u.username]),
      ]) },
      { node: chip(u.role, ROLE_CHIP[u.role] || 'grey', true) },
      u.agent_name || '—',
      { node: u.active ? chip('active', 'green') : chip('disabled', 'amber') },
      { node: actions },
    ];
  });
  host.appendChild(table(['User', 'Role', 'Agency', 'Status', 'Actions'], rows));
}

async function addUser() {
  const role = document.getElementById('role').value;
  const body = {
    role,
    fullName: document.getElementById('fullName').value.trim(),
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
  };
  if (role === 'agent') body.agentId = Number(document.getElementById('agentId').value);
  try {
    await postJSON('/api/admin/users', body);
    toast('User created.', 'ok');
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    document.getElementById('fullName').value = '';
    await loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

async function resetPw(u) {
  const pw = prompt('New password for @' + u.username + ' (min 8 chars):');
  if (pw === null) return;
  if (pw.length < 8) { toast('Password must be at least 8 characters.', 'err'); return; }
  try {
    await postJSON('/api/admin/users/' + u.id + '/reset-password', { password: pw });
    toast('Password reset. Their active sessions were signed out.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function removeUser(u) {
  if (!confirm('Delete user @' + u.username + '? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/admin/users/' + u.id);
    toast('User deleted.', 'ok');
    await loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

init();
