'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { reconcileInvoice } = require('./reconciliation');
const auth = require('./auth');
const logger = require('./logger');

const app = express();
app.use(express.json({ limit: '64kb' }));

// Per-request correlation id + access logging. Runs first so everything
// downstream (including static assets and the auth layer) can log with it.
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);
  req.log = logger.child({ reqId: req.id });
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 10) / 10;
    const isAsset = /\.(css|js|png|svg|ico|map|woff2?)$/i.test(req.path) || req.path.startsWith('/css') || req.path.startsWith('/js');
    let level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (isAsset && res.statusCode < 400) level = 'debug'; // keep asset noise out of info
    req.log[level]('http_request', {
      method: req.method, path: req.path, status: res.statusCode, ms,
      userId: req.user && req.user.id, role: req.user && req.user.role,
      ip: req.ip,
    });
  });
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(auth.attachUser);

const PORT = Number(process.env.PORT || 3000);
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 0);

// Convenience role guards.
const officerOnly = auth.requireRole('officer', 'admin');
const adminOnly = auth.requireRole('admin');

// Helper: append an immutable audit row.
async function appendAudit(client, agentId, eventType, detail, actor) {
  await (client || db).query(
    `INSERT INTO audit_log (agent_id, event_type, detail, actor)
     VALUES ($1,$2,$3,$4)`,
    [agentId, eventType, detail, actor || 'College Admin']
  );
}

function wrap(fn) {
  return (req, res) =>
    fn(req, res).catch((err) => {
      (req.log || logger).error('handler_error', { err, method: req.method, path: req.path });
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error', reqId: req.id });
    });
}

// =====================================================================
// Authentication
// =====================================================================

// POST /api/auth/login {username, password}  — OPEN (defined before the guard)
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = (req.body && req.body.username || '').trim();
  const password = (req.body && req.body.password) || '';
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const u = (await db.query(
    `SELECT * FROM users WHERE lower(username)=lower($1) AND active=TRUE`, [username]
  )).rows[0];
  // Constant-ish response — same error whether user missing or password wrong.
  if (!u || !auth.verifyPassword(password, u.password_hash)) {
    req.log.warn('auth_login_failed', { username }); // never logs the password
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const { token, maxAgeSec } = await auth.createSession(u.id);
  auth.setSessionCookie(res, token, maxAgeSec);
  req.log.info('auth_login', { username: u.username, userId: u.id, role: u.role });
  res.json({ user: publicUser(u) });
}));

// Client-side log intake — OPEN (errors can occur on the login page pre-auth).
// Correlated with this request's id; if a session exists it is tagged too.
app.post('/api/client-logs', (req, res) => {
  const b = req.body || {};
  const level = ['debug', 'info', 'warn', 'error'].includes(b.level) ? b.level : 'info';
  req.log.child({ source: 'client', clientPath: String(b.url || '').slice(0, 200), pageId: b.pageId,
    userId: req.user && req.user.id, role: req.user && req.user.role })
    [level](String(b.msg || 'client_log').slice(0, 200), { context: b.context });
  res.json({ ok: true, reqId: req.id });
});

// Everything below /api requires an authenticated session.
app.use('/api', auth.requireAuth);

// GET /api/auth/me
app.get('/api/auth/me', wrap(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

// POST /api/auth/logout
app.post('/api/auth/logout', wrap(async (req, res) => {
  await auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, full_name: u.full_name, agent_id: u.agent_id };
}

// =====================================================================
// Admin — user management (admin role only)
// =====================================================================
app.use('/api/admin', adminOnly);

// GET /api/admin/users
app.get('/api/admin/users', wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.role, u.full_name, u.agent_id, u.active, u.created_at,
            a.business_name AS agent_name
       FROM users u LEFT JOIN agents a ON a.id = u.agent_id
      ORDER BY u.role, u.username`
  );
  res.json(rows);
}));

// POST /api/admin/users {username, password, role, fullName, agentId}
app.post('/api/admin/users', wrap(async (req, res) => {
  const { username, password, role, fullName } = req.body || {};
  let agentId = req.body && req.body.agentId;
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password and role are required.' });
  if (!['admin', 'officer', 'agent'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (role === 'agent') {
    agentId = Number(agentId);
    if (!agentId) return res.status(400).json({ error: 'An agent user must be linked to an agency.' });
    const ok = (await db.query(`SELECT 1 FROM agents WHERE id=$1`, [agentId])).rows.length;
    if (!ok) return res.status(400).json({ error: 'Linked agency does not exist.' });
  } else {
    agentId = null;
  }
  try {
    const row = (await db.query(
      `INSERT INTO users (username, password_hash, role, full_name, agent_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, role, full_name, agent_id, active`,
      [username.trim(), auth.hashPassword(password), role, (fullName || '').trim() || null, agentId]
    )).rows[0];
    res.json({ ok: true, user: row });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is already taken.' });
    throw e;
  }
}));

// POST /api/admin/users/:id/reset-password {password}
app.post('/api/admin/users/:id/reset-password', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const password = (req.body && req.body.password) || '';
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const r = await db.query(
    `UPDATE users SET password_hash=$2, updated_at=now() WHERE id=$1 RETURNING id`,
    [id, auth.hashPassword(password)]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'User not found.' });
  // Invalidate that user's existing sessions on a reset.
  await db.query(`DELETE FROM sessions WHERE user_id=$1`, [id]);
  res.json({ ok: true, user_id: id });
}));

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  const target = (await db.query(`SELECT role FROM users WHERE id=$1`, [id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'admin') {
    const admins = Number((await db.query(`SELECT count(*)::int AS n FROM users WHERE role='admin' AND active=TRUE`)).rows[0].n);
    if (admins <= 1) return res.status(400).json({ error: 'Cannot delete the last admin account.' });
  }
  await db.query(`DELETE FROM users WHERE id=$1`, [id]);
  res.json({ ok: true, deleted: id });
}));

// =====================================================================
// Phase 1 — Agents pipeline
// =====================================================================

// GET /api/agents?stage=Verified   (college pipeline — officers/admin only)
app.get('/api/agents', officerOnly, wrap(async (req, res) => {
  const { stage } = req.query;
  const params = [];
  let sql = `SELECT a.*,
      (a.marn IS NOT NULL AND a.coi_signed = FALSE) AS coi_frozen
     FROM agents a`;
  if (stage) {
    params.push(stage);
    sql += ` WHERE a.stage = $1`;
  }
  sql += ` ORDER BY a.id`;
  const { rows } = await db.query(sql, params);
  res.json(rows);
}));

// GET /api/agents/:id  (full dossier — own agency for agents; any for officers/admin)
app.get('/api/agents/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!auth.canActOnAgent(req.user, id)) return res.status(403).json({ error: 'You can only view your own agency.' });
  const agentQ = await db.query(
    `SELECT a.*, (a.marn IS NOT NULL AND a.coi_signed = FALSE) AS coi_frozen
     FROM agents a WHERE a.id = $1`,
    [id]
  );
  if (agentQ.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

  const [docs, referees, agreements, students, terminations] = await Promise.all([
    db.query(`SELECT * FROM agent_documents WHERE agent_id=$1 ORDER BY id`, [id]),
    db.query(`SELECT * FROM referee_checks WHERE agent_id=$1 ORDER BY id`, [id]),
    db.query(`SELECT * FROM agreements WHERE agent_id=$1 ORDER BY id`, [id]),
    db.query(`SELECT * FROM students WHERE agent_id=$1 ORDER BY id`, [id]),
    db.query(`SELECT * FROM terminations WHERE agent_id=$1 ORDER BY id`, [id]),
  ]);

  const agent = agentQ.rows[0];
  res.json({
    ...agent,
    documents: docs.rows,
    referees: referees.rows,
    agreements: agreements.rows,
    students: students.rows,
    terminations: terminations.rows,
  });
}));

// GET /api/agents/:id/audit  (officers/admin)
app.get('/api/agents/:id/audit', officerOnly, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM audit_log WHERE agent_id=$1 ORDER BY created_at DESC, id DESC`,
    [Number(req.params.id)]
  );
  res.json(rows);
}));

// POST /api/agents/:id/approve  (P0 — officers/admin)
// Verified -> Decision(Approved), auto-generate agreement, append audit. Persisted.
app.post('/api/agents/:id/approve', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (a.stage !== 'Verified') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only a Verified agent can be approved (current stage: ${a.stage}).` });
    }

    await client.query(
      `UPDATE agents SET stage='Decision', decision='Approved', decision_reason=NULL, decided_at=now() WHERE id=$1`,
      [id]
    );

    // Auto-generate the agreement record (Draft, effective today + 12-month renewal).
    const agr = await client.query(
      `INSERT INTO agreements (agent_id, status, effective_date, renewal_date)
       VALUES ($1,'Draft', CURRENT_DATE, (CURRENT_DATE + INTERVAL '1 year')::date)
       RETURNING *`,
      [id]
    );

    await appendAudit(client, id, 'APPROVED',
      `Application approved. Agreement #${agr.rows[0].id} created.`);

    await client.query('COMMIT');
    res.json({ ok: true, agent_id: id, decision: 'Approved', agreement: agr.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/agents/:id/reject {reason}  (P0 — officers/admin)
app.post('/api/agents/:id/reject', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body && req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (a.stage !== 'Verified') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only a Verified agent can be rejected (current stage: ${a.stage}).` });
    }

    await client.query(
      `UPDATE agents SET stage='Decision', decision='Rejected', decision_reason=$2, decided_at=now() WHERE id=$1`,
      [id, reason]
    );
    await appendAudit(client, id, 'REJECTED', `Application rejected. Reason: ${reason}`);

    await client.query('COMMIT');
    res.json({ ok: true, agent_id: id, decision: 'Rejected', reason });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// Allowed forward pipeline transitions (Decision is reached only via approve/reject).
const STAGE_FLOW = {
  'New': ['In Review'],
  'In Review': ['Docs Requested', 'Verified'],
  'Docs Requested': ['In Review', 'Verified'],
  'Verified': [], // -> Decision only through approve/reject
  'Decision': [],
};

// POST /api/agents/:id/stage {stage, note}  — drive the review pipeline (officers/admin)
app.post('/api/agents/:id/stage', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const toStage = (req.body && req.body.stage || '').trim();
  const note = (req.body && req.body.note || '').trim();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (a.decision) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Agent already at Decision (${a.decision}); stage is locked.` });
    }
    const allowed = STAGE_FLOW[a.stage] || [];
    if (!allowed.includes(toStage)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot move ${a.business_name} from "${a.stage}" to "${toStage}".` });
    }
    await client.query(`UPDATE agents SET stage=$2 WHERE id=$1`, [id, toStage]);
    await appendAudit(client, id, 'STAGE_CHANGE',
      `${a.stage} -> ${toStage}${note ? ' — ' + note : ''}`);
    await client.query('COMMIT');
    res.json({ ok: true, agent_id: id, stage: toStage });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/agents/:id/documents {doc_type, reference, expiry_date}  — agent uploads (own agency) or officer/admin
app.post('/api/agents/:id/documents', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!auth.canActOnAgent(req.user, id)) return res.status(403).json({ error: 'You can only upload for your own agency.' });
  const { doc_type, reference, expiry_date } = req.body || {};
  if (!doc_type) return res.status(400).json({ error: 'doc_type is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }

    const doc = (await client.query(
      `INSERT INTO agent_documents (agent_id, doc_type, reference, expiry_date, verified)
       VALUES ($1,$2,$3,$4,FALSE) RETURNING *`,
      [id, doc_type, reference || null, expiry_date || null]
    )).rows[0];
    await appendAudit(client, id, 'DOC_UPLOADED',
      `Agent uploaded ${doc_type}${reference ? ' (' + reference + ')' : ''} — being checked.`, 'Agent');

    // Uploading a document while brand-new nudges the application into review.
    if (a.stage === 'New') {
      await client.query(`UPDATE agents SET stage='In Review' WHERE id=$1`, [id]);
      await appendAudit(client, id, 'STAGE_CHANGE', 'New -> In Review (documents received)');
    }
    await client.query('COMMIT');
    res.json({ ok: true, document: doc });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/agents/:id/documents/:docId/verify  — college verifies a document (officers/admin)
app.post('/api/agents/:id/documents/:docId/verify', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const docId = Number(req.params.docId);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const doc = (await client.query(
      `SELECT * FROM agent_documents WHERE id=$1 AND agent_id=$2 FOR UPDATE`, [docId, id]
    )).rows[0];
    if (!doc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Document not found' }); }
    await client.query(`UPDATE agent_documents SET verified=TRUE WHERE id=$1`, [docId]);
    await appendAudit(client, id, 'DOC_VERIFIED', `Checked ${doc.doc_type}${doc.reference ? ' (' + doc.reference + ')' : ''}.`);
    await client.query('COMMIT');
    res.json({ ok: true, document_id: docId, verified: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// GET /api/agents/:id/performance  (own agency for agents; any for officers/admin)
app.get('/api/agents/:id/performance', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!auth.canActOnAgent(req.user, id)) return res.status(403).json({ error: 'You can only view your own agency.' });
  const { rows } = await db.query(
    `SELECT
        COUNT(*)                                                          AS recruited,
        COUNT(*) FILTER (WHERE enrolment_status='Enrolled')               AS enrolled,
        COUNT(*) FILTER (WHERE enrolment_status='Completed')              AS completed,
        COUNT(*) FILTER (WHERE enrolment_status='Withdrawn')              AS withdrawn,
        COUNT(*) FILTER (WHERE enrolment_status='Deferred')               AS deferred,
        COUNT(*) FILTER (WHERE visa_subclass='subclass-500')             AS subclass_500_total,
        COUNT(*) FILTER (WHERE visa_subclass='subclass-500' AND visa_status='Refused') AS subclass_500_refused
     FROM students WHERE agent_id=$1`,
    [id]
  );
  const r = rows[0];
  const recruited = Number(r.recruited);
  const enrolled = Number(r.enrolled) + Number(r.completed);
  const s500 = Number(r.subclass_500_total);
  res.json({
    agent_id: id,
    recruited,
    enrolled: Number(r.enrolled),
    completed: Number(r.completed),
    withdrawn: Number(r.withdrawn),
    deferred: Number(r.deferred),
    conversion_rate: recruited ? round2(enrolled / recruited) : 0,
    subclass_500_total: s500,
    subclass_500_refused: Number(r.subclass_500_refused),
    subclass_500_refusal_rate: s500 ? round2(Number(r.subclass_500_refused) / s500) : 0,
    pre_census_withdrawals: Number(r.withdrawn),
  });
}));

// =====================================================================
// Phase 2 — Collateral + acknowledgment ledger
// =====================================================================

// GET /api/collateral  (documents, versions, and who acknowledged CURRENT)
app.get('/api/collateral', wrap(async (req, res) => {
  const docs = (await db.query(`SELECT * FROM collateral_documents ORDER BY id`)).rows;
  const versions = (await db.query(`SELECT * FROM collateral_versions ORDER BY document_id, version DESC`)).rows;
  const acks = (await db.query(
    `SELECT ca.*, a.business_name
       FROM collateral_acks ca JOIN agents a ON a.id = ca.agent_id
      ORDER BY ca.acknowledged_at`
  )).rows;
  const agents = (await db.query(
    `SELECT id, business_name FROM agents
      WHERE decision='Approved' OR stage='Verified' ORDER BY id`
  )).rows;

  const result = docs.map((d) => {
    const vlist = versions.filter((v) => v.document_id === d.id);
    const current = vlist.find((v) => v.status === 'CURRENT') || null;
    return {
      ...d,
      versions: vlist,
      current_version: current,
      // Ledger for the CURRENT version: which relevant agents have / have not acknowledged.
      ledger: current
        ? agents.map((ag) => {
            const row = acks.find((k) => k.version_id === current.id && k.agent_id === ag.id);
            return {
              agent_id: ag.id,
              business_name: ag.business_name,
              acknowledged: !!row,
              acknowledged_at: row ? row.acknowledged_at : null,
            };
          })
        : [],
    };
  });
  res.json(result);
}));

// POST /api/collateral/:id/acknowledge {agentId}  (P2) — :id is a VERSION id
app.post('/api/collateral/:id/acknowledge', wrap(async (req, res) => {
  const versionId = Number(req.params.id);
  // Agents may only acknowledge as their own agency; officers/admin may pass any agentId.
  const agentId = req.user.role === 'agent' ? Number(req.user.agent_id) : Number(req.body && req.body.agentId);
  if (!agentId) return res.status(400).json({ error: 'agentId is required.' });
  if (!auth.canActOnAgent(req.user, agentId)) return res.status(403).json({ error: 'You can only acknowledge for your own agency.' });

  const v = (await db.query(`SELECT cv.*, cd.doc_name FROM collateral_versions cv
      JOIN collateral_documents cd ON cd.id=cv.document_id WHERE cv.id=$1`, [versionId])).rows[0];
  if (!v) return res.status(404).json({ error: 'Collateral version not found' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO collateral_acks (version_id, agent_id)
       VALUES ($1,$2)
       ON CONFLICT (version_id, agent_id) DO NOTHING
       RETURNING *`,
      [versionId, agentId]
    );
    const already = ins.rows.length === 0;
    await appendAudit(client, agentId, 'COLLATERAL_ACK',
      `Confirmed using the current ${v.doc_name} v${v.version} and deleting the old one.`,
      'Agent');
    await client.query('COMMIT');
    res.json({ ok: true, already_acknowledged: already, version_id: versionId, agent_id: agentId });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// =====================================================================
// Phase 3 — Reconciliation + COI signing
// =====================================================================

// GET /api/invoices  (list, for the picker)
app.get('/api/invoices', wrap(async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM invoices ORDER BY id`);
  res.json(rows);
}));

// GET /api/reconciliation?invoiceId=1
app.get('/api/reconciliation', wrap(async (req, res) => {
  let invoiceId = Number(req.query.invoiceId);
  if (!invoiceId) {
    const first = (await db.query(`SELECT id FROM invoices ORDER BY id LIMIT 1`)).rows[0];
    if (!first) return res.json({ invoice: null, lines: [], totals: {} });
    invoiceId = first.id;
  }
  const invoice = (await db.query(`SELECT * FROM invoices WHERE id=$1`, [invoiceId])).rows[0];
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // Join each line with its student and agent COI context.
  const lines = (await db.query(
    `SELECT cl.*, s.full_name AS student_name, s.enrolment_status, s.course,
            a.business_name AS agent_name, a.marn, a.coi_signed
       FROM commission_lines cl
       JOIN students s ON s.id = cl.student_id
       JOIN agents   a ON a.id = cl.agent_id
      WHERE cl.invoice_id = $1
      ORDER BY cl.id`,
    [invoiceId]
  )).rows;

  // Agents only ever see their own agency's lines; officers/admin see all.
  const scoped = req.user.role === 'agent'
    ? lines.filter((l) => Number(l.agent_id) === Number(req.user.agent_id))
    : lines;

  // All rule logic is server-side (pure function). Frontend only renders.
  const { lines: evaluated, totals } = reconcileInvoice(scoped);
  res.json({ invoice, lines: evaluated, totals });
}));

// POST /api/agents/:id/coi/request  — college formally requests the COI declaration (or reminds)
app.post('/api/agents/:id/coi/request', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const a = (await db.query(`SELECT * FROM agents WHERE id=$1`, [id])).rows[0];
  if (!a) return res.status(404).json({ error: 'Agent not found' });
  if (!a.marn) return res.status(400).json({ error: 'This agent has no MARN on file, so no declaration is required.' });
  if (a.coi_signed) return res.status(409).json({ error: 'The agent has already signed the declaration.' });

  const reminder = !!a.coi_requested_at; // already requested before => this is a reminder
  await db.query(
    `UPDATE agents SET coi_requested_at=now(), coi_requested_by=$2 WHERE id=$1`,
    [id, req.user.username]
  );
  await appendAudit(null, id, 'COI_REQUESTED',
    reminder
      ? 'Sent the agent a reminder to sign the conflict-of-interest form.'
      : 'Requested the conflict-of-interest form from the agent.',
    req.user.username);
  res.json({ ok: true, agent_id: id, reminder });
}));

// POST /api/coi/:agentId/sign  (P2) — unfreezes the dual agent's students (own agency or officer/admin)
app.post('/api/coi/:agentId/sign', wrap(async (req, res) => {
  const agentId = Number(req.params.agentId);
  if (!auth.canActOnAgent(req.user, agentId)) return res.status(403).json({ error: 'You can only sign for your own agency.' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [agentId])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (!a.marn) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Agent has no MARN on file; a COI declaration is not required.' });
    }
    await client.query(
      `UPDATE agents SET coi_signed=TRUE, coi_signed_at=now() WHERE id=$1`,
      [agentId]
    );
    await appendAudit(client, agentId, 'COI_SIGNED',
      `Conflict-of-interest form signed for MARN ${a.marn}. Students taken off hold; commission released.`,
      'Agent');
    await client.query('COMMIT');
    res.json({ ok: true, agent_id: agentId, coi_signed: true });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// =====================================================================
// Phase 4 — Offboarding
// =====================================================================

// POST /api/agents/:id/terminate {reason, noticePeriodDays}  — college issues a notice
app.post('/api/agents/:id/terminate', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const reason = (req.body && req.body.reason || '').trim();
  const noticeDays = Math.max(0, Number(req.body && req.body.noticePeriodDays) || 30);
  if (!reason) return res.status(400).json({ error: 'A reason for ending the agreement is required.' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (a.decision !== 'Approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only an approved (onboarded) agent can be offboarded.' });
    }
    if (a.relationship_status !== 'Active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Agent is already "${a.relationship_status}".` });
    }
    const t = (await client.query(
      `INSERT INTO terminations (agent_id, reason, notice_period_days, effective_date)
       VALUES ($1,$2,$3,(CURRENT_DATE + make_interval(days => $3))::date)
       RETURNING *`,
      [id, reason, noticeDays]
    )).rows[0];
    await client.query(`UPDATE agents SET relationship_status='Notice Given' WHERE id=$1`, [id]);
    await appendAudit(client, id, 'TERMINATION_NOTICE',
      `Termination notice issued (${noticeDays}-day notice, effective ${t.effective_date}). Reason: ${reason}`);
    await client.query('COMMIT');
    res.json({ ok: true, termination: t });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/terminations/:tid/acknowledge  — agent (own) acknowledges the notice
app.post('/api/terminations/:tid/acknowledge', wrap(async (req, res) => {
  const tid = Number(req.params.tid);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query(`SELECT * FROM terminations WHERE id=$1 FOR UPDATE`, [tid])).rows[0];
    if (!t) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Notice not found' }); }
    if (!auth.canActOnAgent(req.user, t.agent_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only acknowledge your own notice.' });
    }
    if (!t.acknowledged_at) {
      await client.query(
        `UPDATE terminations SET acknowledged_at=now(), status='Acknowledged' WHERE id=$1`, [tid]);
      await appendAudit(client, t.agent_id, 'TERMINATION_ACK', 'Agent acknowledged the termination notice.', 'Agent');
    }
    await client.query('COMMIT');
    res.json({ ok: true, termination_id: tid, already: !!t.acknowledged_at });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// POST /api/agents/:id/offboard/complete  — college completes offboarding
app.post('/api/agents/:id/offboard/complete', officerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`SELECT * FROM agents WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!a) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Agent not found' }); }
    if (a.relationship_status !== 'Notice Given') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This agent has no active termination notice to complete.' });
    }
    await client.query(
      `UPDATE terminations SET status='Terminated', terminated_at=now()
        WHERE agent_id=$1 AND status <> 'Terminated'`, [id]);
    await client.query(`UPDATE agents SET relationship_status='Terminated' WHERE id=$1`, [id]);
    await client.query(`UPDATE agreements SET status='Expired' WHERE agent_id=$1`, [id]);
    await appendAudit(client, id, 'TERMINATED',
      'Offboarding completed. Relationship ended; agreement marked as ended. Final statement available to the agent.');
    await client.query('COMMIT');
    res.json({ ok: true, agent_id: id, relationship_status: 'Terminated' });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Friendly page routes (pages are static shells; each checks the session via
// /api/auth/me on load and redirects to /login if needed).
const page = (name) => (req, res) => res.sendFile(path.join(__dirname, '..', 'public', name));
app.get('/login', page('login.html'));
app.get('/admin', page('admin.html'));
app.get('/college', page('college.html'));
app.get('/agent', page('agent.html'));

// Safety-net error handler (e.g. errors thrown in middleware such as attachUser).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  (req.log || logger).error('unhandled_error', { err, method: req.method, path: req.path });
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error', reqId: req && req.id });
});

// Last-resort process guards — log, don't die silently.
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { err: reason }));
process.on('uncaughtException', (err) => logger.error('uncaughtException', { err }));

// ---- HTTPS (self-signed) ----
const keyPath = path.join(__dirname, '..', 'certs', 'server.key');
const certPath = path.join(__dirname, '..', 'certs', 'server.cert');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('\nTLS certificate not found in certs/.');
  console.error('Run:  npm run gen-cert   (or  npm run setup  for migrate+seed+cert)\n');
  process.exit(1);
}

const tlsOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };

https.createServer(tlsOptions, app).listen(PORT, () => {
  logger.info('server_started', {
    proto: 'https', port: PORT, tls: 'self-signed',
    logLevel: (process.env.LOG_LEVEL || 'info'),
    urls: { login: `https://localhost:${PORT}/login` },
  });
  // Human-friendly banner for the operator.
  console.log(`Agent MS (HTTPS, self-signed) on https://localhost:${PORT}  ·  Login: /login  ·  logs -> logs/app-<date>.log`);
});

// Optional: redirect plain HTTP -> HTTPS if HTTP_REDIRECT_PORT is set.
if (HTTP_REDIRECT_PORT) {
  http.createServer((req, res) => {
    const host = (req.headers.host || `localhost:${PORT}`).replace(/:\d+$/, `:${PORT}`);
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  }).listen(HTTP_REDIRECT_PORT, () => {
    logger.info('http_redirect_started', { from: HTTP_REDIRECT_PORT, to: PORT });
  });
}
