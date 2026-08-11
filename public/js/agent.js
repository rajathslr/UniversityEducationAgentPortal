'use strict';
// Agent portal controller. The picker chooses which agency we are signed in as
// (all agencies, including those still in the pipeline, so the upload→review→
// approve journey can be demoed end to end).

let currentId = null;
let cache = {};

const DOC_TYPES = ['ASIC extract', 'PIER cert', 'QEAC cert', 'MARN', 'Police check', 'Insurance certificate'];

// ---- tabs ----
document.querySelector('#agentNav').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]');
  if (!a) return;
  e.preventDefault();
  document.querySelectorAll('#agentNav a').forEach((x) => x.classList.toggle('active', x === a));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
  document.getElementById('tab-' + a.dataset.tab).classList.add('show');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

let me = null;

async function init() {
  me = await requireSession(['agent']);
  if (!me) return;
  document.getElementById('userChip').appendChild(userChip(me));
  // An agent operator is scoped to exactly one agency.
  await load(Number(me.agent_id));
}

async function load(id) {
  currentId = id;
  const [agent, collateral, recon] = await Promise.all([
    getJSON('/api/agents/' + id),
    getJSON('/api/collateral'),
    getJSON('/api/reconciliation'),
  ]);
  cache = { agent, collateral, recon };
  renderHeader(agent);
  renderApplication(agent);
  renderCollateral(agent, collateral);
  renderStudents(agent);
  renderCommissions(agent, recon);
  renderAccount(agent, recon);
}

// ---- header / hero ----
const HERO = {
  'New':            { eb: 'Your application', t: 'Application started', s: 'Upload your documents to start the review.' },
  'In Review':      { eb: 'Your application', t: 'Your application is being reviewed', s: 'Meridian is checking your documents. We may ask for more if needed.' },
  'Docs Requested': { eb: 'Action needed', t: 'More documents needed', s: 'Please upload the extra documents Meridian has asked for.' },
  'Verified':       { eb: 'Your application', t: 'Checks done — waiting for a decision', s: 'Your checks are complete. A decision is on the way.' },
};
function renderHeader(a) {
  document.getElementById('whoami').innerHTML =
    a.business_name + '<small class="mono">ABN ' + a.abn + '</small>';
  let h;
  if (a.decision === 'Approved') h = { eb: 'Your application', t: "You're approved and active", s: 'You can view your marketing materials, your students and your commissions.' };
  else if (a.decision === 'Rejected') h = { eb: 'Your application', t: 'Application not successful', s: a.decision_reason || '' };
  else h = HERO[a.stage] || HERO['New'];
  document.getElementById('heroEyebrow').textContent = h.eb;
  document.getElementById('heroTitle').textContent = h.t;
  document.getElementById('heroSub').textContent = h.s;
  const rail = document.getElementById('heroRail');
  rail.innerHTML = '';
  rail.appendChild(renderRail(a));

  // Collateral ack badge
  const outstanding = collateralOutstanding(a, cache.collateral);
  const badge = document.getElementById('ackBadge');
  if (outstanding > 0) { badge.style.display = ''; badge.textContent = outstanding; }
  else badge.style.display = 'none';
}

// ---- My application ----
function renderApplication(a) {
  const host = document.getElementById('tab-application');
  host.innerHTML = '';
  const grid = el('div', { class: 'grid-2' });

  // Requested documents — upload one real file per request
  const dl = el('div');
  const done = a.documents.filter((d) => d.status === 'Verified').length;
  const docsBox = el('div', { class: 'box' }, [
    el('div', { class: 'box-h' }, [el('h3', {}, ['Your documents']), el('div', { class: 'spacer' }),
      a.documents.length ? chip(done + ' of ' + a.documents.length + ' checked', done === a.documents.length ? 'green' : 'grey', true) : null]),
  ]);
  const db = el('div', { class: 'box-b' });
  if (!a.documents.length) {
    db.appendChild(el('div', { class: 'empty' }, ['The college has not requested any documents yet.']));
  } else {
    db.appendChild(el('p', { style: 'margin:0 0 8px;font-size:12.5px;color:var(--muted)' },
      ['Upload one file for each document the college has requested. PDF, PNG or JPG · up to 10 MB.']));
    a.documents.forEach((d) => db.appendChild(agentDocRow(a, d)));
  }
  docsBox.appendChild(db);
  dl.appendChild(docsBox);
  grid.appendChild(dl);

  // Right column: status + agreement + notifications
  const dr = el('div');

  if (a.stage === 'Docs Requested') {
    dr.appendChild(hardstop('teal', '↻', 'More documents needed',
      'Meridian has asked for more documents. Upload them on the left to continue.'));
  }
  if (a.decision === 'Rejected') {
    dr.appendChild(hardstop('red', '✕', 'Application not successful', a.decision_reason || ''));
  }

  if (a.agreements.length) {
    const g = a.agreements[a.agreements.length - 1];
    dr.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'box-h' }, [el('h3', {}, ['Signed agreement']), el('div', { class: 'spacer' }),
        chip(g.status, g.status === 'Active' ? 'green' : 'blue', true)]),
      el('div', { class: 'box-b' }, [
        el('div', { class: 'split' }, [
          field('Effective', fmtDate(g.effective_date)),
          field('Renewal', fmtDate(g.renewal_date)),
        ]),
        field('Agreement type', 'ESOS / National Code 2018 agreement'),
      ]),
    ]));
  }

  // References (read-only)
  if (a.referees.length) {
    const rb = el('div', { class: 'box' }, [el('div', { class: 'box-h' }, [el('h3', {}, ['References'])])]);
    const rbb = el('div', { class: 'box-b' });
    a.referees.forEach((r) => rbb.appendChild(el('div', { class: 'doc' }, [
      el('div', { class: 'info' }, [el('b', {}, [r.referee_name]), el('small', {}, [r.organisation || '—'])]),
      chip(r.status, r.status === 'Passed' ? 'green' : 'amber', true),
    ])));
    rb.appendChild(rbb);
    dr.appendChild(rb);
  }
  grid.appendChild(dr);
  host.appendChild(grid);
}

// ---- Collateral ----
function renderCollateral(a, docs) {
  const host = document.getElementById('tab-collateral');
  host.innerHTML = '';
  // outstanding hardstop
  const outstanding = docs.filter((d) => d.current_version && myLedger(d, a.id) && !myLedger(d, a.id).acknowledged);
  outstanding.forEach((d) => {
    const box = el('div', { class: 'hardstop teal' }, [
      el('div', { class: 'bar' }),
      el('div', { class: 'body' }, [
        el('div', { class: 'stopicon' }, ['↻']),
        el('div', {}, [
          el('b', {}, [d.doc_name + ' updated — please confirm']),
          el('p', {}, ['A new ' + d.doc_name + ' (v' + d.current_version.version + ') replaces the one you had. Confirm you will delete the old file and use only v' + d.current_version.version + '. Using out-of-date materials with students breaks the rules.']),
        ]),
        el('div', { class: 'act' }, [el('button', { class: 'btn sm primary',
          onclick: () => acknowledge(d.current_version.id, a.id) }, ['I have deleted the old version'])]),
      ]),
    ]);
    host.appendChild(box);
  });

  host.appendChild(el('div', { class: 'sec-head' }, [el('h2', {}, ['Current marketing materials']),
    el('p', {}, ['Only the current version is available. Old versions are removed automatically.'])]));
  const box = el('div', { class: 'box' });
  const b = el('div', { class: 'box-b' });
  docs.forEach((d) => {
    if (!d.current_version) return;
    const mine = myLedger(d, a.id);
    b.appendChild(el('div', { class: 'doc' }, [
      el('div', { class: 'ic green' }, ['PDF']),
      el('div', { class: 'info' }, [el('b', {}, [d.doc_name]),
        el('small', {}, [el('span', { class: 'chip green', style: 'margin-right:6px' }, ['Current · v' + d.current_version.version]),
          'published ' + fmtDate(d.current_version.published_at)])]),
      mine && mine.acknowledged ? chip('Confirmed', 'green', true) : chip('Not confirmed', 'amber', true),
    ]));
  });
  b.appendChild(el('div', { class: 'note' }, [el('span', { class: 'i' }, ['⚖']),
    'Old versions are removed so there is no risk of sending a student out-of-date fees or entry requirements.']));
  box.appendChild(b);
  host.appendChild(box);
}

// ---- My students ----
function renderStudents(a) {
  const host = document.getElementById('tab-students');
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'sec-head' }, [el('h2', {}, ['My students']),
    el('p', {}, ['Students linked to your agency.'])]));
  const box = el('div', { class: 'box' });
  if (!a.students.length) { box.appendChild(el('div', { class: 'box-b' }, [el('div', { class: 'empty' }, ['No students linked yet.'])])); host.appendChild(box); return; }
  const rows = a.students.map((s) => [
    { node: el('div', {}, [el('div', { class: 'sname' }, [s.full_name]), el('div', { class: 'ssub mono' }, ['STU-' + String(1000 + s.id)])]) },
    s.course,
    { node: chip(s.visa_subclass || '—', 'grey') },
    { node: chip(s.visa_status, s.visa_status === 'Granted' ? 'green' : s.visa_status === 'Refused' ? 'red' : 'amber', true) },
    { node: chip(s.enrolment_status, s.enrolment_status === 'Enrolled' || s.enrolment_status === 'Completed' ? 'green' : s.enrolment_status === 'Withdrawn' ? 'red' : 'amber', true) },
  ]);
  box.appendChild(table(['Student', 'Course', 'Visa', 'Visa status', 'Status'], rows));
  host.appendChild(box);
}

// ---- Commissions ----
function renderCommissions(a, recon) {
  const host = document.getElementById('tab-commissions');
  host.innerHTML = '';
  const mine = recon.lines.filter((l) => l.agent_id === a.id);

  // COI freeze hardstop
  if (a.coi_frozen) {
    host.appendChild(el('div', { class: 'hardstop' }, [
      el('div', { class: 'bar' }),
      el('div', { class: 'body' }, [
        el('div', { class: 'stopicon' }, ['‖']),
        el('div', {}, [
          el('b', {}, ['Students on hold — conflict-of-interest form needed']),
          el('p', {}, ['Because you hold a migration agent number (MARN ' + a.marn + '), you also give migration advice. Meridian needs your signed conflict-of-interest form before these students can proceed and your commission can be paid.'
            + (a.coi_requested_at ? ' Meridian asked you to complete this on ' + fmtDate(a.coi_requested_at) + '.' : '')]),
        ]),
        el('div', { class: 'act' }, [el('button', { class: 'btn sm primary', onclick: () => signCOI(a.id) }, ['Sign the form'])]),
      ]),
    ]));
  } else if (a.marn && a.coi_signed) {
    host.appendChild(hardstop('green', '✓', 'Conflict-of-interest form signed',
      'Signed ' + fmtDateTime(a.coi_signed_at) + '. Your students are active and your commission can be paid.'));
  }

  // Stats
  const payable = mine.filter((l) => l.payable).reduce((s, l) => s + l.payable_amount, 0);
  const held = mine.filter((l) => l.status === 'frozen-coi').reduce((s, l) => s + l.gross, 0);
  const blocked = mine.filter((l) => l.status === 'blocked-onshore').reduce((s, l) => s + l.gross, 0);
  host.appendChild(el('div', { class: 'stat-row' }, [
    stat('green', money0(payable), 'To be paid', mine.filter((l) => l.payable).length + ' item(s)'),
    stat('amber', money0(held), 'On hold', a.coi_frozen ? 'action needed' : 'none'),
    stat('red', money0(blocked), 'Not payable', 'transfer rule'),
  ]));

  host.appendChild(el('div', { class: 'sec-head' }, [el('h2', {}, ['Your commissions']),
    el('p', {}, ['Invoice ' + (recon.invoice ? recon.invoice.invoice_number : '') + ' · ' + (recon.invoice ? recon.invoice.period : '')])]));
  const box = el('div', { class: 'box' });
  if (!mine.length) { box.appendChild(el('div', { class: 'box-b' }, [el('div', { class: 'empty' }, ['No commissions on the current invoice.'])])); host.appendChild(box); return; }
  const rows = mine.map((l) => {
    const meta = STATUS_META[l.status];
    const r = [
      { node: el('div', { class: 'sname' }, [l.student_name]) },
      l.milestone || '—',
      { node: el('span', { class: 'mono', style: 'font-size:11px' }, [(l.tier ? l.tier + ' · ' : '') + (l.rule_type === 'flat' ? 'flat' : l.rate_percent + '%')]) },
      { node: el('span', { class: 'money' }, [money(l.gross)]), align: 'right' },
      { node: chip(meta.label, meta.chip, true) },
    ];
    r._row = meta.row;
    return r;
  });
  box.appendChild(table(['Student', 'Milestone', 'Rate', { text: 'Amount', align: 'right' }, 'Status'], rows));
  box.appendChild(el('div', { class: 'tbl-foot' }, [
    el('span', { style: 'color:var(--muted);font-size:12.5px' }, ['Total to be paid to you']),
    el('div', { style: 'flex:1' }),
    el('b', { class: 'money', style: 'font-size:15px' }, [money(payable)]),
  ]));
  host.appendChild(box);
  host.appendChild(el('div', { class: 'note' }, [el('span', { class: 'i' }, ['?']),
    'Students who withdrew, deferred, left before the census date, or transferred within Australia are shown here with the reason, so nothing is missing.']));
}

// ---- Account (Phase 4 offboarding, agent side) ----
function renderAccount(a, recon) {
  const host = document.getElementById('tab-account');
  host.innerHTML = '';
  const rel = a.relationship_status || 'Active';
  const t = (a.terminations && a.terminations.length) ? a.terminations[a.terminations.length - 1] : null;

  // Notice of ending
  if (rel === 'Notice Given' && t) {
    if (!t.acknowledged_at) {
      host.appendChild(el('div', { class: 'hardstop' }, [
        el('div', { class: 'bar' }),
        el('div', { class: 'body' }, [
          el('div', { class: 'stopicon' }, ['!']),
          el('div', {}, [
            el('b', {}, ['Your agreement is ending']),
            el('p', {}, ['Meridian has given notice to end your agreement on ' + fmtDate(t.effective_date) + '. Reason: ' + t.reason + '. Please confirm you have received this notice.']),
          ]),
          el('div', { class: 'act' }, [el('button', { class: 'btn sm primary', onclick: () => acknowledgeNotice(t.id) }, ['I confirm I have received this notice'])]),
        ]),
      ]));
    } else {
      host.appendChild(hardstop('green', '✓', 'Notice received',
        'You confirmed this notice on ' + fmtDateTime(t.acknowledged_at) + '. Your agreement ends on ' + fmtDate(t.effective_date) + '.'));
    }
  } else if (rel === 'Terminated' && t) {
    host.appendChild(hardstop('red', '■', 'Your agreement has ended',
      'Your agreement ended on ' + fmtDate(t.terminated_at) + '. You can still view and download your final commission statement on the Commissions tab.'));
  }

  // Profile
  const kv = el('div', { class: 'kv' });
  const add = (k, v) => { kv.appendChild(el('div', { class: 'k' }, [k])); kv.appendChild(el('div', {}, [v])); };
  add('Business', a.business_name);
  add('ABN', a.abn);
  add('Main contact', a.operator_name);
  add('Email', a.operator_email);
  const relChip = rel === 'Active' ? chip('Active', 'green', true)
    : rel === 'Notice Given' ? chip('Ending soon', 'amber', true)
    : chip('Ended', 'red', true);
  kv.appendChild(el('div', { class: 'k' }, ['Status']));
  kv.appendChild(el('div', {}, [relChip]));
  host.appendChild(el('div', { class: 'box' }, [
    el('div', { class: 'box-h' }, [el('h3', {}, ['Your account'])]),
    el('div', { class: 'box-b' }, [kv]),
  ]));

  // Calm explainer when active
  if (rel === 'Active') {
    host.appendChild(el('div', { class: 'box' }, [
      el('div', { class: 'box-h' }, [el('h3', {}, ['If your agreement ends'])]),
      el('div', { class: 'box-b' }, [
        el('p', { style: 'margin:0;font-size:13px;color:var(--muted)' },
          ['If Meridian ends the agreement, you will get a notice here to confirm, plus a final commission statement. You keep access to view and download your final statement after the agreement ends.']),
      ]),
    ]));
  }
}

async function acknowledgeNotice(tid) {
  try {
    await postJSON('/api/terminations/' + tid + '/acknowledge');
    toast('Notice confirmed.', 'ok');
    await load(currentId);
  } catch (e) { toast('Could not confirm: ' + e.message, 'err'); }
}

// ---- documents (request-driven, real files) ----
function agentDocRow(a, d) {
  const fileUrl = '/api/agents/' + a.id + '/documents/' + d.id + '/file';
  const acts = el('div', { class: 'acts' });
  const statusChip = d.status === 'Verified' ? chip('Checked', 'green', true)
    : d.status === 'Uploaded' ? chip('Uploaded — being checked', 'amber', true)
      : chip('Requested', 'grey', true);

  if (d.status === 'Verified') {
    acts.appendChild(el('a', { class: 'btn sm', href: fileUrl, target: '_blank', rel: 'noopener' }, ['View']));
  } else {
    const input = el('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' });
    const btn = el('button', { class: 'btn sm primary', onclick: () => {
      const f = input.files && input.files[0];
      if (!f) { toast('Choose a file first.', 'err'); return; }
      uploadDocFile(a.id, d.id, f);
    } }, [d.status === 'Uploaded' ? 'Replace' : '⬆ Upload']);
    acts.appendChild(input);
    acts.appendChild(btn);
    if (d.status === 'Uploaded') {
      acts.appendChild(el('a', { class: 'btn sm', href: fileUrl, target: '_blank', rel: 'noopener' }, ['View']));
      acts.appendChild(el('button', { class: 'btn sm danger', onclick: () => deleteDocFile(a.id, d.id) }, ['Delete']));
    }
  }
  return el('div', { class: 'docfile' }, [
    el('div', { class: 'meta' }, [
      el('b', {}, [d.doc_type]),
      el('small', {}, [d.original_filename ? d.original_filename + ' · ' + fmtBytes(d.size_bytes) : 'Requested by the college — please upload']),
    ]),
    statusChip,
    acts,
  ]);
}
async function uploadDocFile(agentId, docId, file) {
  try {
    await apiUpload('/api/agents/' + agentId + '/documents/' + docId + '/file', file);
    toast('File uploaded.', 'ok');
    await load(agentId);
  } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
}
async function deleteDocFile(agentId, docId) {
  if (!confirm('Delete this uploaded file? You can upload a new one afterwards.')) return;
  try {
    await api('DELETE', '/api/agents/' + agentId + '/documents/' + docId + '/file');
    toast('File removed.', 'ok');
    await load(agentId);
  } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
async function acknowledge(versionId, id) {
  try {
    const r = await postJSON('/api/collateral/' + versionId + '/acknowledge', { agentId: id });
    toast(r.already_acknowledged ? 'Already confirmed.' : 'Confirmation saved.', 'ok');
    await load(id);
  } catch (e) { toast('Could not confirm: ' + e.message, 'err'); }
}
async function signCOI(id) {
  if (!confirm('Sign the conflict-of-interest form? This takes your students off hold and lets your commission be paid.')) return;
  try {
    await postJSON('/api/coi/' + id + '/sign');
    toast('Form signed — your students are active again.', 'ok');
    await load(id);
  } catch (e) { toast('Sign failed: ' + e.message, 'err'); }
}

// ---- helpers ----
function hardstop(kind, icon, head, body) {
  return el('div', { class: 'hardstop ' + kind }, [
    el('div', { class: 'bar' }),
    el('div', { class: 'body' }, [el('div', { class: 'stopicon' }, [icon]),
      el('div', {}, [el('b', {}, [head]), el('p', {}, [body])])]),
  ]);
}
function stat(kind, n, label, sub) {
  return el('div', { class: 'stat ' + kind }, [el('div', { class: 'lab' }, [label]),
    el('div', { class: 'val' }, [String(n)]), sub ? el('div', { class: 'sub' }, [sub]) : null]);
}
function field(label, value) {
  return el('div', { class: 'field' }, [el('label', {}, [label]),
    el('div', { class: 'mono', style: 'border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:13px;background:#FBFBFA' }, [value])]);
}
function myLedger(doc, agentId) { return doc.ledger.find((l) => l.agent_id === agentId); }
function collateralOutstanding(a, docs) {
  if (!docs) return 0;
  return docs.filter((d) => d.current_version && myLedger(d, a.id) && !myLedger(d, a.id).acknowledged).length;
}
function abbr(t) {
  if (/ASIC/i.test(t)) return 'ASIC';
  if (/PIER/i.test(t)) return 'PIER';
  if (/QEAC/i.test(t)) return 'QEAC';
  if (/MARN/i.test(t)) return 'MARN';
  return t.slice(0, 4).toUpperCase();
}
function initials(name) { return (name || '··').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(); }

init();
