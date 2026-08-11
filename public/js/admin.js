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

  // Populate agency dropdown (admins may read the agent list).
  const agents = await getJSON('/api/agents');
  const sel = document.getElementById('agentId');
  agents.forEach((a) => sel.appendChild(el('option', { value: a.id }, [a.business_name])));

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

  await loadUsers();
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
