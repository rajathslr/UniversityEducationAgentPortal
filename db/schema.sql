-- Education Agent Management System — schema
-- One CRICOS/TEQSA-regulated Australian university managing its education agents.
-- Single jurisdiction (AUD, Australian rules). Idempotent: safe to re-run.

DROP TABLE IF EXISTS sessions              CASCADE;
DROP TABLE IF EXISTS users                 CASCADE;
DROP TABLE IF EXISTS terminations          CASCADE;
DROP TABLE IF EXISTS commission_lines      CASCADE;
DROP TABLE IF EXISTS invoices              CASCADE;
DROP TABLE IF EXISTS students              CASCADE;
DROP TABLE IF EXISTS collateral_acks       CASCADE;
DROP TABLE IF EXISTS collateral_versions   CASCADE;
DROP TABLE IF EXISTS collateral_documents  CASCADE;
DROP TABLE IF EXISTS agreements            CASCADE;
DROP TABLE IF EXISTS audit_log             CASCADE;
DROP TABLE IF EXISTS referee_checks        CASCADE;
DROP TABLE IF EXISTS agent_documents       CASCADE;
DROP TABLE IF EXISTS agents                CASCADE;

-- =====================================================================
-- Phase 1 — Selection & due diligence
-- =====================================================================

CREATE TABLE agents (
  id              SERIAL PRIMARY KEY,
  business_name   TEXT        NOT NULL,
  abn             TEXT        NOT NULL,               -- Australian Business Number
  operator_name   TEXT        NOT NULL,              -- the single operator account
  operator_email  TEXT        NOT NULL,
  source_market   TEXT        NOT NULL DEFAULT 'India', -- label only; ignored in rules
  -- Pipeline: New -> In Review -> Docs Requested -> Verified -> Decision
  stage           TEXT        NOT NULL DEFAULT 'New',
  decision        TEXT,                               -- 'Approved' | 'Rejected' | NULL
  decision_reason TEXT,
  decided_at      TIMESTAMPTZ,
  -- COI FREEZE inputs: a Migration Agent Registration Number on file means the
  -- operator can act as both agent and migration agent (dual role). Without a
  -- signed Conflict-of-Interest declaration, that agent's enrolments freeze.
  marn            TEXT,                               -- NULL = not a dual agent
  coi_signed      BOOLEAN     NOT NULL DEFAULT FALSE,
  coi_signed_at   TIMESTAMPTZ,
  -- The college formally requests the declaration from the agent (and can remind).
  coi_requested_at TIMESTAMPTZ,
  coi_requested_by TEXT,
  -- Phase 4 offboarding lifecycle for an onboarded agent:
  --   'Active' -> 'Notice Given' -> 'Terminated'
  relationship_status TEXT     NOT NULL DEFAULT 'Active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_documents (
  id          SERIAL PRIMARY KEY,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  doc_type    TEXT    NOT NULL,        -- 'ASIC extract' | 'PIER cert' | 'QEAC cert' | 'MARN'
  reference   TEXT,                    -- e.g. cert number
  expiry_date DATE,                    -- for certs with an expiry
  verified    BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE referee_checks (
  id           SERIAL PRIMARY KEY,
  agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  referee_name TEXT    NOT NULL,
  organisation TEXT,
  contact      TEXT,
  status       TEXT    NOT NULL DEFAULT 'Pending'  -- 'Pending' | 'Passed' | 'Failed'
);

-- Immutable, append-only. No UPDATE/DELETE in application code.
CREATE TABLE audit_log (
  id         SERIAL PRIMARY KEY,
  agent_id   INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  event_type TEXT        NOT NULL,     -- 'STAGE_CHANGE' | 'APPROVED' | 'REJECTED' | 'COI_SIGNED' | 'COLLATERAL_ACK' | ...
  detail     TEXT        NOT NULL,     -- human-readable summary
  actor      TEXT        NOT NULL DEFAULT 'College Admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Phase 2 — Onboarding & collateral
-- =====================================================================

CREATE TABLE agreements (
  id             SERIAL PRIMARY KEY,
  agent_id       INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status         TEXT    NOT NULL DEFAULT 'Draft',  -- 'Draft' | 'Active' | 'Expired'
  effective_date DATE,
  renewal_date   DATE,
  signed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Phase 4 — Offboarding
-- A termination notice starts the wind-down of an onboarded agent. The agent
-- acknowledges it; the college completes offboarding once the notice period
-- has run and the final position is settled.
-- =====================================================================
CREATE TABLE terminations (
  id                 SERIAL PRIMARY KEY,
  agent_id           INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason             TEXT    NOT NULL,
  notice_period_days INTEGER NOT NULL DEFAULT 30,
  notice_date        DATE    NOT NULL DEFAULT CURRENT_DATE,
  effective_date     DATE    NOT NULL,        -- notice_date + notice_period_days
  initiated_by       TEXT    NOT NULL DEFAULT 'College Admin',
  acknowledged_at    TIMESTAMPTZ,             -- set when the agent acknowledges
  terminated_at      TIMESTAMPTZ,             -- set when offboarding is completed
  status             TEXT    NOT NULL DEFAULT 'Notice Given', -- 'Notice Given' | 'Acknowledged' | 'Terminated'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX terminations_agent_idx ON terminations(agent_id);

CREATE TABLE collateral_documents (
  id       SERIAL PRIMARY KEY,
  doc_name TEXT NOT NULL              -- e.g. '2026 Fee Schedule'
);

CREATE TABLE collateral_versions (
  id           SERIAL PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES collateral_documents(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  status       TEXT    NOT NULL,       -- 'CURRENT' | 'SUPERSEDED'
  file_label   TEXT    NOT NULL,       -- pretend filename
  notes        TEXT,
  published_at DATE    NOT NULL
);
-- Exactly one CURRENT version per document.
CREATE UNIQUE INDEX one_current_per_doc
  ON collateral_versions (document_id)
  WHERE status = 'CURRENT';

-- Acknowledgment ledger: audit evidence an agent discarded the old version and
-- confirmed the current one.
CREATE TABLE collateral_acks (
  id              SERIAL PRIMARY KEY,
  version_id      INTEGER NOT NULL REFERENCES collateral_versions(id) ON DELETE CASCADE,
  agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, agent_id)
);

-- =====================================================================
-- Phase 3 — Monitoring & reconciliation
-- =====================================================================

-- Students are imported reference data (never onboarded here).
CREATE TABLE students (
  id               SERIAL PRIMARY KEY,
  agent_id         INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  full_name        TEXT    NOT NULL,
  source_market    TEXT    NOT NULL DEFAULT 'India',
  course           TEXT    NOT NULL,
  visa_subclass    TEXT,                 -- e.g. 'subclass-500'
  visa_status      TEXT    NOT NULL DEFAULT 'Granted', -- 'Granted' | 'Refused' | 'Pending'
  enrolment_status TEXT    NOT NULL DEFAULT 'Enrolled' -- 'Enrolled' | 'Withdrawn' | 'Deferred' | 'Completed'
);

CREATE TABLE invoices (
  id             SERIAL PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  period         TEXT NOT NULL,          -- e.g. 'Q1 2026'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One commission line per student on an invoice. The two regulatory inputs are
-- stored as SEPARATE columns so grandfathering cannot collapse to one boolean.
CREATE TABLE commission_lines (
  id                              SERIAL PRIMARY KEY,
  invoice_id                      INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  student_id                      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  agent_id                        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Commission rule
  rule_type                       TEXT    NOT NULL DEFAULT 'percent', -- 'percent' | 'flat'
  rate_percent                    NUMERIC(5,2),        -- when rule_type='percent'
  flat_amount                     NUMERIC(12,2),       -- when rule_type='flat'
  tuition_amount                  NUMERIC(12,2) NOT NULL DEFAULT 0, -- base for percent
  tier                            TEXT,                -- e.g. 'Bronze'/'Silver'/'Gold' (label)
  milestone                       TEXT,                -- e.g. 'Census passed'
  -- ONSHORE BLOCK inputs (kept as two independent booleans on purpose):
  onshore_transfer                BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_on_or_before_2026_03_31 BOOLEAN NOT NULL DEFAULT FALSE,
  -- Exception flag (withdrawn / deferred / pre-census) => not due
  exception_flag                  TEXT                 -- NULL | 'withdrawn' | 'deferred' | 'pre-census'
);

-- =====================================================================
-- Authentication — users & sessions
-- =====================================================================

-- Three roles:
--   'admin'   — manages users (add/delete/reset). Not tied to an agency.
--   'officer' — College officer: full College console access.
--   'agent'   — Agent operator: scoped to exactly one agency (agent_id).
-- Passwords are stored as salted one-way scrypt hashes (never plaintext,
-- never reversibly encrypted). Format: 'scrypt$N$saltHex$hashHex'.
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('admin','officer','agent')),
  full_name     TEXT,
  -- Required when role='agent'; the agency this operator is scoped to.
  agent_id      INTEGER     REFERENCES agents(id) ON DELETE CASCADE,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An agent user must have an agent_id; admin/officer must not.
  CONSTRAINT agent_scope_ck CHECK (
    (role = 'agent' AND agent_id IS NOT NULL) OR
    (role <> 'agent' AND agent_id IS NULL)
  )
);
CREATE INDEX users_role_idx ON users(role);

-- Opaque server-side session tokens delivered as an httpOnly cookie.
CREATE TABLE sessions (
  token      TEXT        PRIMARY KEY,             -- random 256-bit hex
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
