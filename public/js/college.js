'use strict';
// College console controller.

const STAGES = ['New', 'In Review', 'Docs Requested', 'Verified', 'Decision'];
let selectedAgentId = null;

// ---- Phase tabs ----
document.querySelector('.tabs').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-phase]');
  if (!a) return;
  e.preventDefault();
  document.querySelectorAll('.tabs a').forEach((x) => x.classList.toggle('active', x === a));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
  document.getElementById('phase-' + a.dataset.phase).classList.add('show');
  if (a.dataset.phase === 'collateral') loadCollateral();
  if (a.dataset.phase === 'reconciliation') loadReconciliation();
  if (a.dataset.phase === 'offboarding') loadOffboarding();
});

// ---- Phase 1: pipeline board ----
async function loadPipeline() {
  const agents = await getJSON('/api/agents');
  const board = document.getElementById('pipeline');
  board.innerHTML = '';
  STAGES.forEach((stage) => {
    const inStage = agents.filter((a) => a.stage === stage);
    const col = el('div', { class: 'pcol' }, [
      el('div', { class: 'pcol-h' }, [stageLabel(stage), el('span', { class: 'chip grey' }, [String(inStage.length)])]),
    ]);
    const body = el('div', { class: 'pcol-b' });
    if (!inStage.length) body.appendChild(el('div', { class: 'empty-col' }, ['—']));
    inStage.forEach((a) => {
      const chips = [];
      if (a.decision) chips.push(chip(a.decision, a.decision === 'Approved' ? 'green' : 'red', true));
      if (a.coi_frozen) chips.push(chip('On hold', 'amber', true));
      if (a.marn && !a.coi_frozen) chips.push(chip('MARN', 'teal'));
      body.appendChild(el('div', {
        class: 'pcard' + (a.id === selectedAgentId ? ' selected' : ''),
        onclick: () => selectAgent(a.id),
      }, [
        el('div', { class: 'nm' }, [a.business_name]),
        el('div', { class: 'ab' }, ['ABN ' + a.abn]),
        chips.length ? el('div', { class: 'cardchips' }, chips) : null,
      ]));
    });
    col.appendChild(body);
    board.appendChild(col);
  });
}

async function selectAgent(id) {
  selectedAgentId = id;
  await loadPipeline();
  const [agent, audit] = await Promise.all([
    getJSON('/api/agents/' + id),
    getJSON('/api/agents/' + id + '/audit'),
  ]);
  renderDossier(agent, audit);
  document.getElementById('dossier').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderDossier(a, audit) {
  const host = document.getElementById('dossier');
  host.innerHTML = '';

  // Header box with rail
  const header = el('div', { class: 'box' }, [
    el('div', { class: 'box-b' }, [
      el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, [
        el('h2', { style: 'font-family:Archivo;font-size:18px;margin:0' }, [a.business_name]),
        chip(stageLabel(a.stage), STAGE_CHIP[a.stage] || 'grey', true),
        a.decision ? chip(a.decision, a.decision === 'Approved' ? 'green' : 'red', true) : null,
        (a.relationship_status && a.relationship_status !== 'Active')
          ? chip(a.relationship_status, a.relationship_status === 'Terminated' ? 'red' : 'amber', true) : null,
      ]),
      el('div', { class: 'mono', style: 'color:var(--muted-2);font-size:12px;margin-top:3px' },
        ['ABN ' + a.abn + ' · ' + a.operator_name + ' · ' + a.operator_email]),
      renderRail(a),
    ]),
  ]);
  host.appendChild(header);

  if (a.coi_frozen) {
    host.appendChild(hardstop('amber', '‖', 'ON HOLD — CONFLICT-OF-INTEREST FORM NOT SIGNED',
      'This agent holds a migration agent number (MARN ' + a.marn + ') but has not signed the conflict-of-interest form. Their students are on hold and their commission is held until they sign it in the Agent portal. Only the agent can sign it — you can request it and send reminders.'));
    const requested = a.coi_requested_at
      ? 'Requested ' + fmtDateTime(a.coi_requested_at) + (a.coi_requested_by ? ' by ' + a.coi_requested_by : '') + ' — waiting for the agent to sign.'
      : 'Not requested yet.';
    host.appendChild(el('div', { class: 'actions', style: 'margin:-6px 0 10px;align-items:center' }, [
      el('button', { class: 'btn sm primary', onclick: () => requestCOI(a.id) },
        [a.coi_requested_at ? 'Send reminder' : 'Request declaration from agent']),
      el('span', { class: 'small muted' }, [requested]),
    ]));
  }
  if (a.decision === 'Rejected') {
    host.appendChild(hardstop('red', '✕', 'APPLICATION REJECTED',
      'Reason: ' + (a.decision_reason || '—')));
  }

  const cols = el('div', { class: 'grid-2', style: 'margin-top:16px' });

  // --- Left: documents + review actions ---
  const left = el('div');
  const docsBox = el('div', { class: 'box' }, [
    el('div', { class: 'box-h' }, [
      el('h3', {}, ['Required documents']),
      el('div', { class: 'spacer' }),
      allVerified(a.documents) && a.documents.length ? chip('All checked', 'green', true) : chip(a.documents.length + ' on file', 'grey'),
    ]),
  ]);
  const docsBody = el('div', { class: 'box-b' });
  if (!a.documents.length) docsBody.appendChild(el('div', { class: 'empty' }, ['No documents requested yet. Request one below.']));
  a.documents.forEach((d) => docsBody.appendChild(collegeDocRow(a, d)));

  // Request a document from the agent (only until a decision is made).
  if (!a.decision) {
    const sel = el('select', {}, ['ASIC extract', 'PIER/QEAC certificate', 'MARN', 'Police check', 'Insurance certificate', 'Other']
      .map((t) => el('option', { value: t }, [t])));
    const other = el('input', { type: 'text', placeholder: 'Document name', style: 'display:none;margin-top:6px' });
    sel.addEventListener('change', () => { other.style.display = sel.value === 'Other' ? '' : 'none'; });
    docsBody.appendChild(el('div', { style: 'margin-top:12px;border-top:1px solid var(--line-2);padding-top:12px' }, [
      el('div', { style: 'font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px' }, ['Request a document from the agent']),
      el('div', { style: 'display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap' }, [
        el('div', {}, [sel, other]),
        el('button', { class: 'btn sm primary', onclick: () => {
          const dt = sel.value === 'Other' ? other.value.trim() : sel.value;
          if (!dt) { toast('Enter a document name.', 'err'); return; }
          requestDoc(a.id, dt);
        } }, ['Request']),
      ]),
    ]));
  }
  docsBox.appendChild(docsBody);
  left.appendChild(docsBox);

  // Referees
  const refBox = el('div', { class: 'box' }, [el('div', { class: 'box-h' }, [el('h3', {}, ['Reference checks'])])]);
  const refBody = el('div', { class: 'box-b' });
  if (!a.referees.length) refBody.appendChild(el('div', { class: 'empty' }, ['None recorded.']));
  a.referees.forEach((r) => {
    refBody.appendChild(el('div', { class: 'doc' }, [
      el('div', { class: 'info' }, [el('b', {}, [r.referee_name]), el('small', {}, [r.organisation || '—'])]),
      chip(r.status, r.status === 'Passed' ? 'green' : r.status === 'Failed' ? 'red' : 'amber', true),
    ]));
  });
  refBox.appendChild(refBody);
  left.appendChild(refBox);
  cols.appendChild(left);

  // --- Right: review actions + agreement + audit ---
  const right = el('div');

  // Review actions box (drives the flow)
  const actBox = el('div', { class: 'box' }, [el('div', { class: 'box-h' }, [el('h3', {}, ['Review actions'])])]);
  const actBody = el('div', { class: 'box-b' });
  actBody.appendChild(el('p', { style: 'margin:0 0 12px;font-size:12.5px;color:var(--muted)' }, [nextStepHint(a)]));
  actBody.appendChild(stageActions(a));
  actBox.appendChild(actBody);
  right.appendChild(actBox);

  // Agreement
  if (a.agreements.length) {
    const g = a.agreements[a.agreements.length - 1];
    const agBox = el('div', { class: 'box' }, [
      el('div', { class: 'box-h' }, [el('h3', {}, ['Agreement']), el('div', { class: 'spacer' }),
        chip(g.status, g.status === 'Active' ? 'green' : 'blue', true)]),
      el('div', { class: 'box-b' }, [kv([
        ['Effective', fmtDate(g.effective_date)],
        ['Renewal', fmtDate(g.renewal_date)],
        ['Signed', g.signed_at ? fmtDate(g.signed_at) : '—'],
      ])]),
    ]);
    right.appendChild(agBox);
  }

  // Audit timeline
  const audBox = el('div', { class: 'box' }, [el('div', { class: 'box-h' }, [el('h3', {}, ['Activity history']), el('div', { class: 'spacer' }), chip('permanent record', 'grey')])]);
  const audBody = el('div', { class: 'box-b' });
  if (!audit.length) audBody.appendChild(el('div', { class: 'empty' }, ['No entries yet.']));
  else {
    const tl = el('div', { class: 'timeline' });
    audit.forEach((x) => tl.appendChild(el('div', { class: 'tl' }, [
      el('div', { class: 'when' }, [fmtDateTime(x.created_at) + ' · ' + x.actor]),
      el('div', { class: 'what' }, [el('b', {}, [labelEvent(x.event_type)]), ' — ' + x.detail]),
    ])));
    audBody.appendChild(tl);
  }
  audBox.appendChild(audBody);
  right.appendChild(audBox);

  cols.appendChild(right);
  host.appendChild(cols);
}

// Buttons available for the current stage.
function stageActions(a) {
  const wrap = el('div', { class: 'actions' });
  if (a.decision) {
    wrap.appendChild(el('span', { class: 'chip ' + (a.decision === 'Approved' ? 'green' : 'red') }, ['Decision recorded: ' + a.decision]));
    return wrap;
  }
  const mk = (label, cls, fn) => el('button', { class: 'btn ' + cls, onclick: fn }, [label]);
  switch (a.stage) {
    case 'New':
      wrap.appendChild(mk('Start review', 'primary', () => advance(a.id, 'In Review', 'Application picked up for review')));
      break;
    case 'In Review':
      wrap.appendChild(mk('Request more documents', '', () => advance(a.id, 'Docs Requested', 'More documents requested from agent')));
      wrap.appendChild(mk('Mark checks complete', 'primary', () => advance(a.id, 'Verified', 'Checks complete')));
      break;
    case 'Docs Requested':
      wrap.appendChild(mk('Documents received — mark checks complete', 'primary', () => advance(a.id, 'Verified', 'Requested documents received and checked')));
      break;
    case 'Verified':
      wrap.appendChild(mk('✓ Approve', 'primary', () => approve(a.id)));
      wrap.appendChild(mk('✗ Reject with reason', 'danger', () => reject(a.id)));
      break;
  }
  return wrap;
}

function nextStepHint(a) {
  if (a.decision) return 'This application is finished. Its status can no longer change and its history is locked.';
  return {
    'New': 'The agent has applied. Start the review to add it to your list.',
    'In Review': 'Check the documents on file. Mark each as checked, then either request more or mark the checks complete.',
    'Docs Requested': 'You have asked the agent for more documents. Once they arrive and check out, mark the checks complete.',
    'Verified': 'The checks are complete. Approve to create the agreement, or reject with a reason.',
  }[a.stage] || '';
}

// ---- write actions ----
async function advance(id, stage, note) {
  try {
    await postJSON('/api/agents/' + id + '/stage', { stage, note });
    toast('Moved to “' + stageLabel(stage) + '”.', 'ok');
    await selectAgent(id);
  } catch (e) { toast(e.message, 'err'); }
}
async function requestCOI(id) {
  try {
    const r = await postJSON('/api/agents/' + id + '/coi/request');
    toast(r.reminder ? 'Reminder sent to the agent.' : 'Declaration requested from the agent.', 'ok');
    await selectAgent(id);
  } catch (e) { toast(e.message, 'err'); }
}
async function verifyDoc(agentId, docId) {
  try {
    await postJSON('/api/agents/' + agentId + '/documents/' + docId + '/verify');
    toast('Document marked as checked.', 'ok');
    await selectAgent(agentId);
  } catch (e) { toast(e.message, 'err'); }
}
async function requestDoc(agentId, docType) {
  try {
    await postJSON('/api/agents/' + agentId + '/documents/request', { doc_type: docType });
    toast('Requested “' + docType + '” from the agent.', 'ok');
    await selectAgent(agentId);
  } catch (e) { toast(e.message, 'err'); }
}
async function cancelDocRequest(agentId, docId, name) {
  if (!confirm('Remove the request for “' + name + '”? Any file the agent uploaded for it is deleted.')) return;
  try {
    await api('DELETE', '/api/agents/' + agentId + '/documents/' + docId);
    toast('Request removed.', 'ok');
    await selectAgent(agentId);
  } catch (e) { toast(e.message, 'err'); }
}
// A document row on the college dossier: status + view + verify + remove.
function collegeDocRow(a, d) {
  const fileUrl = '/api/agents/' + a.id + '/documents/' + d.id + '/file';
  const acts = el('div', { class: 'acts' });
  acts.appendChild(d.status === 'Verified' ? chip('Checked', 'green', true)
    : d.status === 'Uploaded' ? chip('Uploaded', 'amber', true)
      : chip('Requested', 'grey', true));
  if (d.status === 'Uploaded' || d.status === 'Verified') {
    acts.appendChild(el('a', { class: 'btn sm', href: fileUrl, target: '_blank', rel: 'noopener' }, ['View']));
  }
  if (d.status === 'Uploaded' && !a.decision) {
    acts.appendChild(el('button', { class: 'btn sm primary', onclick: () => verifyDoc(a.id, d.id) }, ['Mark as checked']));
  }
  if (d.status !== 'Verified' && !a.decision) {
    acts.appendChild(el('button', { class: 'btn sm danger', onclick: () => cancelDocRequest(a.id, d.id, d.doc_type) }, ['Remove']));
  }
  return el('div', { class: 'docfile' }, [
    el('div', { class: 'meta' }, [
      el('b', {}, [d.doc_type]),
      el('small', {}, [d.original_filename
        ? d.original_filename + ' · uploaded ' + fmtDate(d.uploaded_at)
        : (d.requested_by ? 'Requested by ' + d.requested_by : 'Requested')]),
    ]),
    acts,
  ]);
}
async function approve(id) {
  if (!confirm('Approve this agent? This moves it to Decision, creates the agreement, and adds a line to the history.')) return;
  try {
    const r = await postJSON('/api/agents/' + id + '/approve');
    toast('Approved · agreement #' + r.agreement.id + ' created · added to history.', 'ok');
    await selectAgent(id);
  } catch (e) { toast('Approve failed: ' + e.message, 'err'); }
}
async function reject(id) {
  const reason = prompt('Reason for rejecting (required — added to the history):');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required.', 'err'); return; }
  try {
    await postJSON('/api/agents/' + id + '/reject', { reason: reason.trim() });
    toast('Rejected · added to history.', 'ok');
    await selectAgent(id);
  } catch (e) { toast('Reject failed: ' + e.message, 'err'); }
}

// ---- Phase 2 ----
async function loadCollateral() {
  const docs = await getJSON('/api/collateral');
  const host = document.getElementById('collateral');
  host.innerHTML = '';
  docs.forEach((doc) => {
    const box = el('div', { class: 'box' });
    box.appendChild(el('div', { class: 'box-h' }, [el('h3', {}, [doc.doc_name]), el('div', { class: 'spacer' }),
      doc.current_version ? chip('Current: v' + doc.current_version.version, 'green', true) : chip('none', 'grey')]));
    const b = el('div', { class: 'box-b' });
    doc.versions.forEach((v) => {
      b.appendChild(el('div', { class: 'doc' }, [
        el('div', { class: 'ic ' + (v.status === 'CURRENT' ? 'green' : '') }, ['PDF']),
        el('div', { class: 'info' }, [
          el('b', {}, ['v' + v.version + ' · ' + v.file_label]),
          el('small', {}, [(v.notes || '') + ' · published ' + fmtDate(v.published_at)]),
        ]),
        v.status === 'CURRENT' ? chip('Current', 'green', true) : chip('Old version', 'grey'),
      ]));
    });
    box.appendChild(b);
    // confirmation record
    if (doc.current_version) {
      const rows = doc.ledger.map((l) => [
        l.business_name,
        { node: l.acknowledged ? chip('Confirmed', 'green', true) : chip('Not yet', 'amber', true) },
        l.acknowledged_at ? fmtDateTime(l.acknowledged_at) : '—',
      ]);
      box.appendChild(el('div', { class: 'box-h', style: 'border-top:1px solid var(--line-2)' },
        [el('h3', {}, ['Who has confirmed the current version (v' + doc.current_version.version + ')'])]));
      box.appendChild(table(['Agent', 'Status', 'When'], rows));
    }
    host.appendChild(box);
  });
}

// ---- Phase 3 ----
async function loadReconciliation() {
  const data = await getJSON('/api/reconciliation');
  const host = document.getElementById('recon');
  host.innerHTML = '';
  if (!data.invoice) { host.appendChild(el('div', { class: 'empty' }, ['No invoices.'])); return; }
  const t = data.totals;

  if (t.blocked_onshore > 0) {
    host.appendChild(hardstop('red', '⛔', 'CANNOT BE PAID — STUDENT-TRANSFER RULE',
      t.blocked_onshore + ' payment(s) cannot be paid: a student already in Australia moved to us after 31 Mar 2026. Transfers accepted on or before that date can still be paid.'));
  }
  if (t.frozen_coi > 0) {
    host.appendChild(hardstop('amber', '‖', 'ON HOLD — CONFLICT-OF-INTEREST FORM NOT SIGNED',
      t.frozen_coi + ' payment(s) on hold: an agent has a migration agent number (MARN) on file but has not signed the conflict-of-interest form. On hold: ' + money(t.total_held_amount) + '. Signing the form (Agent portal) releases it.'));
  }

  host.appendChild(el('div', { class: 'stat-row' }, [
    stat('green', t.payable, 'Payable'),
    stat('red', t.blocked_onshore, 'Not payable'),
    stat('amber', t.frozen_coi, 'On hold'),
    stat('grey', t.not_due, 'Nothing owed'),
    stat('green', money0(t.total_payable_amount), 'Total to pay'),
  ]));

  const box = el('div', { class: 'box' });
  box.appendChild(el('div', { class: 'box-h' }, [el('h3', {}, [data.invoice.invoice_number + ' · ' + data.invoice.period])]));
  const rows = data.lines.map((l) => {
    const meta = STATUS_META[l.status];
    const ruleTxt = l.rule_type === 'flat' ? 'Flat ' + money(l.flat_amount) : l.rate_percent + '% of ' + money(l.tuition_amount);
    const r = [
      { node: el('div', {}, [el('div', { class: 'sname' }, [l.student_name]), el('div', { class: 'ssub' }, [l.course])]) },
      l.agent_name,
      { node: el('span', { class: 'mono', style: 'font-size:11.5px' }, [ruleTxt]) },
      { node: el('span', { class: 'money' }, [money(l.gross)]), align: 'right' },
      { node: chip(meta.label, meta.chip, true) },
      { node: el('span', { style: 'font-size:11.5px;color:var(--muted)' }, [l.reason]) },
    ];
    r._row = meta.row;
    return r;
  });
  box.appendChild(table(
    ['Student', 'Agent', 'Commission', { text: 'Amount', align: 'right' }, 'Status', 'Reason'],
    rows
  ));
  box.appendChild(el('div', { class: 'tbl-foot' }, [
    el('span', { style: 'color:var(--muted);font-size:12.5px' }, ['Total to pay']),
    el('div', { class: 'spacer', style: 'flex:1' }),
    el('b', { class: 'money', style: 'font-size:15px' }, [money(t.total_payable_amount)]),
  ]));
  host.appendChild(box);
}

// ---- Step 4: offboarding ----
const REL_CHIP = { 'Active': 'green', 'Notice Given': 'amber', 'Terminated': 'red' };
async function loadOffboarding() {
  const agents = await getJSON('/api/agents');
  const onboarded = agents.filter((a) => a.decision === 'Approved');
  const host = document.getElementById('offboarding');
  host.innerHTML = '';
  if (!onboarded.length) { host.appendChild(el('div', { class: 'empty' }, ['No onboarded agents yet.'])); return; }

  const box = el('div', { class: 'box' });
  box.appendChild(el('div', { class: 'box-h' }, [el('h3', {}, ['Onboarded agents'])]));
  const b = el('div', { class: 'box-b' });
  for (const a of onboarded) {
    // Pull the latest notice (if any) from the dossier.
    const full = await getJSON('/api/agents/' + a.id);
    const t = full.terminations && full.terminations.length ? full.terminations[full.terminations.length - 1] : null;
    const rel = a.relationship_status || 'Active';

    const right = el('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end' });
    right.appendChild(chip(rel, REL_CHIP[rel] || 'grey', true));
    if (rel === 'Active') {
      right.appendChild(el('button', { class: 'btn sm danger', onclick: () => terminate(a.id, a.business_name) }, ['End agreement']));
    } else if (rel === 'Notice Given') {
      right.appendChild(el('button', { class: 'btn sm primary', onclick: () => completeOffboard(a.id, a.business_name) }, ['Complete offboarding']));
    }

    const meta = [];
    if (t && rel !== 'Terminated') {
      meta.push('Effective ' + fmtDate(t.effective_date));
      meta.push(t.acknowledged_at ? 'Agent confirmed ' + fmtDate(t.acknowledged_at) : 'Awaiting agent confirmation');
    }
    if (t && rel === 'Terminated') meta.push('Ended ' + fmtDate(t.terminated_at));

    b.appendChild(el('div', { class: 'doc' }, [
      el('div', { class: 'info' }, [
        el('b', {}, [a.business_name]),
        el('small', {}, [(t && t.reason ? t.reason + ' · ' : '') + (meta.join(' · ') || 'Active agreement')]),
      ]),
      right,
    ]));
  }
  box.appendChild(b);
  host.appendChild(box);
}

async function terminate(id, name) {
  const reason = prompt('End the agreement with “' + name + '”.\n\nReason (required — the agent will see this):');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required.', 'err'); return; }
  const days = prompt('Notice period in days:', '30');
  if (days === null) return;
  try {
    const r = await postJSON('/api/agents/' + id + '/terminate', { reason: reason.trim(), noticePeriodDays: Number(days) || 30 });
    toast('Notice sent · ends ' + fmtDate(r.termination.effective_date) + '.', 'ok');
    await loadOffboarding();
  } catch (e) { toast(e.message, 'err'); }
}
async function completeOffboard(id, name) {
  if (!confirm('Complete offboarding for “' + name + '”? This ends the relationship and marks the agreement as ended. The agent keeps access to their final statement.')) return;
  try {
    await postJSON('/api/agents/' + id + '/offboard/complete');
    toast('Offboarding complete.', 'ok');
    await loadOffboarding();
  } catch (e) { toast(e.message, 'err'); }
}

// ---- helpers ----
function hardstop(kind, icon, head, body) {
  return el('div', { class: 'hardstop ' + kind }, [
    el('div', { class: 'bar' }),
    el('div', { class: 'body' }, [
      el('div', { class: 'stopicon' }, [icon]),
      el('div', {}, [el('b', {}, [head]), el('p', {}, [body])]),
    ]),
  ]);
}
function stat(kind, n, label, sub) {
  return el('div', { class: 'stat ' + kind }, [
    el('div', { class: 'lab' }, [label]),
    el('div', { class: 'val' }, [String(n)]),
    sub ? el('div', { class: 'sub' }, [sub]) : null,
  ]);
}
function kv(pairs) {
  const g = el('div', { class: 'kv' });
  pairs.forEach(([k, v]) => { g.appendChild(el('div', { class: 'k' }, [k])); g.appendChild(el('div', {}, [v])); });
  return g;
}
function allVerified(docs) { return docs.every((d) => d.verified); }
function abbr(t) {
  if (/ASIC/i.test(t)) return 'ASIC';
  if (/PIER/i.test(t)) return 'PIER';
  if (/QEAC/i.test(t)) return 'QEAC';
  if (/MARN/i.test(t)) return 'MARN';
  return t.slice(0, 4).toUpperCase();
}
function labelEvent(e) {
  return { STAGE_CHANGE: 'Status change', APPROVED: 'Approved', REJECTED: 'Rejected',
    DOC_UPLOADED: 'Document uploaded', DOC_VERIFIED: 'Document checked',
    COI_SIGNED: 'Conflict-of-interest form signed', COI_REQUESTED: 'Declaration requested', COLLATERAL_ACK: 'Marketing materials confirmed',
    TERMINATION_NOTICE: 'Termination notice sent', TERMINATION_ACK: 'Notice confirmed by agent',
    TERMINATED: 'Offboarding completed', AGENT_CREATED: 'Agency created',
    DOC_REQUESTED: 'Document requested', DOC_FILE_DELETED: 'File removed', DOC_REQUEST_CANCELLED: 'Request cancelled' }[e] || e;
}

(async function initCollege() {
  const me = await requireSession(['officer', 'admin']);
  if (!me) return;
  const chipHost = document.getElementById('userChip');
  if (me.role === 'admin') {
    chipHost.appendChild(el('a', { href: '/admin', class: 'btn sm', style: 'background:transparent;color:#fff;border-color:rgba(255,255,255,.35);text-decoration:none;margin-right:10px' }, ['Admin']));
  }
  chipHost.appendChild(userChip(me));
  loadPipeline();
})();
