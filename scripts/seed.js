'use strict';
// Realistic dummy data engineered so the guardrails are visible in the demo:
//  - 6 agents across pipeline stages (1 Verified & ready to approve live;
//    1 dual agent with a MARN and NO signed COI).
//  - 1 invoice, 5 commission lines => 2 payable / 1 blocked / 1 frozen / 1 not-due.
//  - Collateral: "2026 Fee Schedule" CURRENT v4 + SUPERSEDED v3, partial ack ledger.
require('dotenv').config();
const { Client } = require('pg');
const { hashPassword } = require('../src/auth');

const url =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/agentms';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe!23';
const SEED_USER_PASSWORD = process.env.SEED_USER_PASSWORD || 'Passw0rd!23';

async function main() {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('BEGIN');

    // Wipe (respect FKs) so seed is repeatable.
    await db.query(`TRUNCATE
      sessions, users, terminations,
      commission_lines, invoices, students,
      collateral_acks, collateral_versions, collateral_documents,
      agreements, audit_log, referee_checks, agent_documents, agents
      RESTART IDENTITY CASCADE`);

    // ---------------------------------------------------------------
    // Agents
    // ---------------------------------------------------------------
    const agents = {};

    async function addAgent(key, a) {
      const { rows } = await db.query(
        `INSERT INTO agents
          (business_name, abn, operator_name, operator_email, source_market,
           stage, decision, decision_reason, decided_at, marn, coi_signed, coi_signed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          a.business_name, a.abn, a.operator_name, a.operator_email,
          a.source_market || 'India', a.stage, a.decision || null,
          a.decision_reason || null, a.decided_at || null,
          a.marn || null, a.coi_signed || false, a.coi_signed_at || null,
        ]
      );
      agents[key] = rows[0].id;
      return rows[0].id;
    }

    // 1) Verified, ready to approve LIVE in the demo (P0). No MARN.
    await addAgent('globalReach', {
      business_name: 'Global Reach Education Pty Ltd',
      abn: '51 824 753 556', operator_name: 'Anita Desai',
      operator_email: 'anita@globalreach.example', stage: 'Verified',
    });

    // 2) Dual agent — MARN on file, COI NOT signed => students frozen.
    await addAgent('sunrise', {
      business_name: 'Sunrise Migration & Education Pty Ltd',
      abn: '72 601 148 902', operator_name: 'Ravi Menon',
      operator_email: 'ravi@sunrisemig.example', stage: 'Decision',
      decision: 'Approved', decided_at: '2026-02-12T04:00:00Z',
      marn: 'MARN-1793021', coi_signed: false,
    });

    // 3) Clean, already-approved agent — source of the payable/blocked/not-due lines.
    await addAgent('southernCross', {
      business_name: 'Southern Cross Study Group Pty Ltd',
      abn: '18 302 449 771', operator_name: 'Meera Nair',
      operator_email: 'meera@southerncross.example', stage: 'Decision',
      decision: 'Approved', decided_at: '2026-01-20T02:30:00Z',
    });

    // 4-6) Earlier pipeline stages.
    await addAgent('melbourne', {
      business_name: 'Melbourne Pathways Consulting Pty Ltd',
      abn: '90 115 776 233', operator_name: 'Sanjay Rao',
      operator_email: 'sanjay@melbpathways.example', stage: 'New',
    });
    await addAgent('horizon', {
      business_name: 'Horizon Student Services Pty Ltd',
      abn: '33 908 221 640', operator_name: 'Deepa Iyer',
      operator_email: 'deepa@horizonstudent.example', stage: 'In Review',
    });
    await addAgent('apex', {
      business_name: 'Apex Overseas Admissions Pty Ltd',
      abn: '64 771 205 118', operator_name: 'Karan Malhotra',
      operator_email: 'karan@apexadmissions.example', stage: 'Docs Requested',
    });

    // ---------------------------------------------------------------
    // Compliance documents + referee checks
    // ---------------------------------------------------------------
    async function addDoc(agentId, doc_type, reference, expiry, verified) {
      await db.query(
        `INSERT INTO agent_documents (agent_id, doc_type, reference, expiry_date, verified)
         VALUES ($1,$2,$3,$4,$5)`,
        [agentId, doc_type, reference, expiry || null, verified || false]
      );
    }
    async function addReferee(agentId, name, org, contact, status) {
      await db.query(
        `INSERT INTO referee_checks (agent_id, referee_name, organisation, contact, status)
         VALUES ($1,$2,$3,$4,$5)`,
        [agentId, name, org, contact, status]
      );
    }

    // Verified agent has a full, clean file.
    await addDoc(agents.globalReach, 'ASIC extract', 'ASIC-2026-55231', null, true);
    await addDoc(agents.globalReach, 'PIER cert', 'PIER-GR-4471', '2027-06-30', true);
    await addReferee(agents.globalReach, 'Univ. of Adelaide Intl Office', 'UoA', 'intl@uoa.example', 'Passed');
    await addReferee(agents.globalReach, 'RMIT Partnerships', 'RMIT', 'partners@rmit.example', 'Passed');

    // Dual agent — note the MARN doc.
    await addDoc(agents.sunrise, 'ASIC extract', 'ASIC-2025-88120', null, true);
    await addDoc(agents.sunrise, 'QEAC cert', 'QEAC-J1188', '2027-01-31', true);
    await addDoc(agents.sunrise, 'MARN', 'MARN-1793021', null, true);
    await addReferee(agents.sunrise, 'Deakin Recruitment', 'Deakin', 'rec@deakin.example', 'Passed');
    await addReferee(agents.sunrise, 'La Trobe Intl', 'La Trobe', 'intl@latrobe.example', 'Passed');

    await addDoc(agents.southernCross, 'ASIC extract', 'ASIC-2025-70044', null, true);
    await addDoc(agents.southernCross, 'PIER cert', 'PIER-SC-2290', '2026-11-30', true);
    await addReferee(agents.southernCross, 'Monash Global', 'Monash', 'global@monash.example', 'Passed');
    await addReferee(agents.southernCross, 'UniSA Intl', 'UniSA', 'intl@unisa.example', 'Passed');

    await addDoc(agents.horizon, 'ASIC extract', 'ASIC-2026-10233', null, true);
    await addDoc(agents.horizon, 'PIER cert', 'PIER-HZ-9001', '2027-03-31', false);
    await addReferee(agents.horizon, 'Griffith Intl', 'Griffith', 'intl@griffith.example', 'Pending');

    await addDoc(agents.apex, 'ASIC extract', 'ASIC-2026-33501', null, false);
    await addReferee(agents.apex, 'QUT Partnerships', 'QUT', 'partners@qut.example', 'Pending');

    // ---------------------------------------------------------------
    // Agreements for already-approved agents
    // ---------------------------------------------------------------
    async function addAgreement(agentId, status, eff, renew, signedAt) {
      await db.query(
        `INSERT INTO agreements (agent_id, status, effective_date, renewal_date, signed_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [agentId, status, eff, renew, signedAt]
      );
    }
    await addAgreement(agents.sunrise, 'Active', '2026-02-12', '2027-02-12', '2026-02-12T04:05:00Z');
    await addAgreement(agents.southernCross, 'Active', '2026-01-20', '2027-01-20', '2026-01-20T02:35:00Z');

    // ---------------------------------------------------------------
    // Audit log (Phase 1 immutable history)
    // ---------------------------------------------------------------
    async function audit(agentId, type, detail, actor, when) {
      await db.query(
        `INSERT INTO audit_log (agent_id, event_type, detail, actor, created_at)
         VALUES ($1,$2,$3,$4,COALESCE($5, now()))`,
        [agentId, type, detail, actor || 'College Admin', when || null]
      );
    }
    await audit(agents.globalReach, 'STAGE_CHANGE', 'New -> In Review', 'College Admin', '2026-07-01T01:00:00Z');
    await audit(agents.globalReach, 'STAGE_CHANGE', 'In Review -> Docs Requested', 'College Admin', '2026-07-03T01:00:00Z');
    await audit(agents.globalReach, 'STAGE_CHANGE', 'Docs Requested -> Verified', 'College Admin', '2026-07-08T01:00:00Z');
    await audit(agents.sunrise, 'APPROVED', 'Application approved. Agreement created.', 'College Admin', '2026-02-12T04:00:00Z');
    await audit(agents.southernCross, 'APPROVED', 'Application approved. Agreement created.', 'College Admin', '2026-01-20T02:30:00Z');

    // ---------------------------------------------------------------
    // Collateral repository + acknowledgment ledger
    // ---------------------------------------------------------------
    const feeDocId = (
      await db.query(
        `INSERT INTO collateral_documents (doc_name) VALUES ('2026 Fee Schedule') RETURNING id`
      )
    ).rows[0].id;

    const v3Id = (
      await db.query(
        `INSERT INTO collateral_versions (document_id, version, status, file_label, notes, published_at)
         VALUES ($1,3,'SUPERSEDED','2026-fee-schedule-v3.pdf','Old version — do not use.','2025-11-01')
         RETURNING id`,
        [feeDocId]
      )
    ).rows[0].id;
    const v4Id = (
      await db.query(
        `INSERT INTO collateral_versions (document_id, version, status, file_label, notes, published_at)
         VALUES ($1,4,'CURRENT','2026-fee-schedule-v4.pdf','Current — Feb 2026 fee revision.','2026-02-05')
         RETURNING id`,
        [feeDocId]
      )
    ).rows[0].id;

    // A second document for context.
    const brandDocId = (
      await db.query(
        `INSERT INTO collateral_documents (doc_name) VALUES ('Agent Marketing Guidelines') RETURNING id`
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO collateral_versions (document_id, version, status, file_label, notes, published_at)
       VALUES ($1,2,'CURRENT','marketing-guidelines-v2.pdf','Current brand & CRICOS disclosure rules.','2026-01-15')`,
      [brandDocId]
    );

    // Ledger: some agents acknowledged the CURRENT v4, some have NOT.
    async function ack(versionId, agentId, when) {
      await db.query(
        `INSERT INTO collateral_acks (version_id, agent_id, acknowledged_at)
         VALUES ($1,$2,COALESCE($3, now()))`,
        [versionId, agentId, when || null]
      );
    }
    // Southern Cross acknowledged v4; Sunrise & Global Reach have NOT (gap visible).
    await ack(v4Id, agents.southernCross, '2026-02-06T00:00:00Z');
    // Historical: everyone had acknowledged v3.
    await ack(v3Id, agents.southernCross, '2025-11-02T00:00:00Z');
    await ack(v3Id, agents.sunrise, '2025-11-03T00:00:00Z');

    // ---------------------------------------------------------------
    // Students (imported reference data) + performance signal
    // ---------------------------------------------------------------
    async function addStudent(agentId, s) {
      const { rows } = await db.query(
        `INSERT INTO students
          (agent_id, full_name, source_market, course, visa_subclass, visa_status, enrolment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          agentId, s.full_name, s.source_market || 'India', s.course,
          s.visa_subclass || 'subclass-500', s.visa_status || 'Granted',
          s.enrolment_status || 'Enrolled',
        ]
      );
      return rows[0].id;
    }

    // The 5 students that appear on the invoice.
    const stuPayable1 = await addStudent(agents.southernCross, { full_name: 'Aarav Sharma', course: 'Master of IT' });
    const stuPayable2 = await addStudent(agents.southernCross, { full_name: 'Priya Patel', course: 'Bachelor of Nursing' });
    const stuBlocked  = await addStudent(agents.southernCross, { full_name: 'Rohan Gupta', course: 'Master of Business' });
    const stuNotDue   = await addStudent(agents.southernCross, { full_name: 'Neha Reddy', course: 'Diploma of Commerce', enrolment_status: 'Withdrawn' });
    const stuFrozen   = await addStudent(agents.sunrise,       { full_name: 'Vikram Singh', course: 'Master of Engineering' });

    // Extra students purely to make performance aggregates meaningful.
    await addStudent(agents.southernCross, { full_name: 'Isha Kulkarni', course: 'Master of IT', visa_status: 'Refused' });
    await addStudent(agents.southernCross, { full_name: 'Arjun Mehta', course: 'Bachelor of Nursing', enrolment_status: 'Completed' });
    await addStudent(agents.sunrise, { full_name: 'Sneha Joshi', course: 'Master of Data Science', visa_status: 'Refused' });
    await addStudent(agents.sunrise, { full_name: 'Manish Verma', course: 'Master of Engineering', enrolment_status: 'Deferred' });

    // ---------------------------------------------------------------
    // Invoice + commission lines (the reconciliation showcase)
    // ---------------------------------------------------------------
    const invId = (
      await db.query(
        `INSERT INTO invoices (invoice_number, period) VALUES ('INV-2026-0001','Q1 2026') RETURNING id`
      )
    ).rows[0].id;

    async function addLine(l) {
      await db.query(
        `INSERT INTO commission_lines
          (invoice_id, student_id, agent_id, rule_type, rate_percent, flat_amount,
           tuition_amount, tier, milestone, onshore_transfer,
           accepted_on_or_before_2026_03_31, exception_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          invId, l.student_id, l.agent_id, l.rule_type,
          l.rate_percent || null, l.flat_amount || null,
          l.tuition_amount || 0, l.tier || null, l.milestone || null,
          !!l.onshore_transfer, !!l.accepted_on_or_before_2026_03_31,
          l.exception_flag || null,
        ]
      );
    }

    // 1) payable — percent
    await addLine({ student_id: stuPayable1, agent_id: agents.southernCross,
      rule_type: 'percent', rate_percent: 15, tuition_amount: 24000,
      tier: 'Gold', milestone: 'Census passed' });
    // 2) payable — flat
    await addLine({ student_id: stuPayable2, agent_id: agents.southernCross,
      rule_type: 'flat', flat_amount: 1500, tier: 'Silver', milestone: 'Census passed' });
    // 3) BLOCKED — onshore transfer, NOT grandfathered (accepted after 31 Mar 2026)
    await addLine({ student_id: stuBlocked, agent_id: agents.southernCross,
      rule_type: 'percent', rate_percent: 15, tuition_amount: 26000,
      tier: 'Gold', milestone: 'Enrolment', onshore_transfer: true,
      accepted_on_or_before_2026_03_31: false });
    // 4) FROZEN — dual agent (MARN) with unsigned COI
    await addLine({ student_id: stuFrozen, agent_id: agents.sunrise,
      rule_type: 'percent', rate_percent: 15, tuition_amount: 28000,
      tier: 'Gold', milestone: 'Census passed' });
    // 5) NOT DUE — withdrew pre-census
    await addLine({ student_id: stuNotDue, agent_id: agents.southernCross,
      rule_type: 'percent', rate_percent: 15, tuition_amount: 18000,
      tier: 'Bronze', milestone: 'Enrolment', exception_flag: 'pre-census' });

    // ---------------------------------------------------------------
    // Users (auth) — 1 admin, 2 officers, agent operators for 3 agencies.
    // Passwords are salted scrypt hashes. Demo passwords come from .env.
    // ---------------------------------------------------------------
    async function addUser(u) {
      await db.query(
        `INSERT INTO users (username, password_hash, role, full_name, agent_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [u.username, hashPassword(u.password), u.role, u.full_name || null, u.agent_id || null]
      );
    }
    // Bootstrap admin
    await addUser({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin', full_name: 'System Administrator' });
    // College officers
    await addUser({ username: 'officer', password: SEED_USER_PASSWORD, role: 'officer', full_name: 'Priya Officer' });
    await addUser({ username: 'jkelly', password: SEED_USER_PASSWORD, role: 'officer', full_name: 'Jordan Kelly' });
    // Agent operators (scoped to their agency)
    await addUser({ username: 'sunrise', password: SEED_USER_PASSWORD, role: 'agent', full_name: 'Ravi Menon', agent_id: agents.sunrise });
    await addUser({ username: 'southerncross', password: SEED_USER_PASSWORD, role: 'agent', full_name: 'Meera Nair', agent_id: agents.southernCross });
    await addUser({ username: 'globalreach', password: SEED_USER_PASSWORD, role: 'agent', full_name: 'Anita Desai', agent_id: agents.globalReach });

    await db.query('COMMIT');
    console.log('Seed complete.');
    console.log('  Agents: 6 (1 Verified ready to approve, 1 dual/MARN unsigned COI)');
    console.log('  Invoice INV-2026-0001: 5 lines (2 payable / 1 blocked / 1 frozen / 1 not-due)');
    console.log('  Collateral: 2026 Fee Schedule v4 CURRENT + v3 SUPERSEDED, partial ack ledger');
    console.log('  Users: admin=' + ADMIN_USERNAME + ' · officers(officer,jkelly) · agents(sunrise,southerncross,globalreach)');
    console.log('  Officer/agent password = SEED_USER_PASSWORD from .env');
    process.exit(0);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await db.end().catch(() => {});
  }
}

main();
