'use strict';
// Admin controller — user management. Admin role only.

let me = null;

async function init() {
  me = await requireSession(['admin']);
  if (!me) return;
  document.getElementById('userChip').appendChild(userChip(me));

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
  await loadUsers();
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
