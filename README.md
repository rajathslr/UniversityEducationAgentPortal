# Education Agent Management System — demo build

A locally-runnable web app for **one CRICOS-registered, TEQSA-regulated Australian
university** to manage its network of education agents. Node + Express + PostgreSQL,
role-based logins (College officer / Agent / Admin) over **HTTPS**, real REST endpoints,
data persisted in Postgres.

Single jurisdiction (AUD, Australian rules: ESOS Act, National Code 2018, PRISMS,
TEQSA). Students are imported reference data. "India" is only a source-market label.

The two features that make this not a spreadsheet:

1. **Commission reconciliation guardrails** — a server-side engine that refuses to pay
   commission on a non-grandfathered **onshore transfer** and **freezes** a dual-agent's
   students until a Conflict-of-Interest (COI) declaration is signed.
2. **Collateral version control** — exactly one CURRENT version per document, with a
   mandatory **acknowledgment ledger** (audit evidence that agents discarded old files).

Access is authenticated: **separate logins for College officers and Agent operators**,
plus an **Admin** who manages accounts — all served over **HTTPS (self-signed cert)**.

---

## 1. Requirements

- **Node.js** 18+ (built and verified on Node 24).
- **PostgreSQL** running locally. Verified on PostgreSQL 16 on Windows.
  - Default superuser `postgres` / password `postgres` on `localhost:5432`.

## 2. Configuration

Config lives in `.env` (already created; copy from `.env.example` if missing):

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/agentms
PORT=3000
SESSION_TTL_HOURS=8
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ChangeMe!23           # bootstrap admin (seed only) — CHANGE THIS
SEED_USER_PASSWORD=Passw0rd!23       # default pw for seeded officer/agent logins
# HTTP_REDIRECT_PORT=8080            # optional: 301-redirect plain HTTP -> HTTPS
```

**If your Postgres differs**, edit `DATABASE_URL` in `.env`:
- Different password → change the `postgres:<password>` part.
- Different port → change `5432`.
- Different superuser → change the first `postgres`.
- The migrate script connects to the `postgres` maintenance database with these
  credentials, **creates the `agentms` database if it doesn't exist**, then applies the
  schema. You do not need to create the database by hand.

## 3. Run steps (exact)

```bash
npm install
npm run setup     # = migrate + seed + gen-cert (self-signed TLS certificate)
npm start         # serves on https://localhost:3000
```

`npm run setup` is the one-shot; the individual steps are `npm run migrate`,
`npm run seed`, `npm run gen-cert`.

Then open the **login page** (accept the browser's one-time self-signed warning):

- **Login** → <https://localhost:3000/login>

After signing in you land on your role's home. For the two-actor demo, sign in as an
**officer** in one browser and an **agent** in another (or a private window) so both
sessions are live at once.

> **Self-signed certificate:** the browser will warn the connection isn't trusted the
> first time — click *Advanced → proceed to localhost*. This is expected; the cert is
> generated locally into `certs/` and is not signed by a public CA.

Handy: `npm run reset` re-runs migrate + seed to return to the pristine demo state
(this also resets all users and signs everyone out). `npm test` runs the reconciliation
unit tests.

## 3a. Logins (seeded)

| Role | Username | Password | Sees |
| --- | --- | --- | --- |
| **Admin** | `admin` | `ChangeMe!23` (`ADMIN_PASSWORD`) | User administration only |
| **College officer** | `officer` | `Passw0rd!23` (`SEED_USER_PASSWORD`) | College console (all agencies) |
| College officer | `jkelly` | `Passw0rd!23` | College console |
| **Agent** — Sunrise (dual/COI) | `sunrise` | `Passw0rd!23` | Only Sunrise's own portal |
| Agent — Southern Cross | `southerncross` | `Passw0rd!23` | Only its own portal |
| Agent — Global Reach | `globalreach` | `Passw0rd!23` | Only its own portal |

**Change these before any real/public deployment.** Passwords are stored only as salted
one-way **scrypt** hashes (never plaintext, never reversibly encrypted).

### Roles & authorization
- **Admin** — the only role that can add/delete users and reset passwords (`/admin`).
  Not tied to an agency. The last remaining admin cannot be deleted.
- **Officer** — full College console: pipeline, approve/reject, verify docs, collateral,
  reconciliation across all agencies.
- **Agent** — scoped to exactly one agency: sees only their own dossier, students,
  collateral to acknowledge, and commission lines. The server enforces this (an agent
  requesting another agency's data gets HTTP 403), not just the UI.

Sessions are opaque httpOnly cookies (`Secure`, `SameSite=Lax`) backed by a `sessions`
table; resetting a user's password invalidates their existing sessions.

---

## 4. What's implemented (by priority)

**P0 — live, persisted write (College Phase 1):** open the Verified agent, click
**Approve** → it moves to Decision, **auto-generates an agreement record**, and appends
an **immutable audit-log row** — all persisted to Postgres and surviving a server
restart. **Reject with reason** does the same (records the reason + audit row).

**Phase 1 onboarding journey (live, both sides):** the agent uploads compliance documents
(simulated — metadata only, persisted), which nudges the application from New → In Review;
the college verifies each document and advances the pipeline stage
(In Review → Docs Requested → Verified); every step writes an immutable audit row. A
**progress rail** on both the College dossier and the Agent portal renders the current
stage. Approve/Reject close it out (P0 above).

**P1 — real read APIs:** Phase 2 collateral repository + acknowledgment ledger, and
Phase 3 reconciliation rendering the onshore block and COI freeze from real rows.

**P2 — agent-side writes:** acknowledge updated collateral (writes a ledger row); sign a
COI declaration (unfreezes the dual agent's students and releases held commission).

### The two regulatory rules (encoded server-side, in `src/reconciliation.js`)

- **ONSHORE BLOCK** — a line is non-payable when
  `onshore_transfer = true` **AND** `accepted_on_or_before_2026_03_31 = false`.
  Grandfathering is preserved: an onshore transfer accepted on/before 31 Mar 2026 is
  **still payable**. These are two independent columns — never collapsed to one boolean.
- **COI FREEZE** — if an agent has a **MARN** on file and **no signed COI declaration**,
  all that agent's enrolments are frozen and commission is **held** (not lost). The freeze
  is a two-party workflow: the **officer requests** the declaration (and can send reminders)
  from the College dossier — the banner is actionable, not passive — and the **agent signs**
  it in their portal (only the agent can sign it). Signing lifts the freeze. Both the request
  and the signature are written to the activity history.

Precedence when more than one could apply: `frozen-coi` → `blocked-onshore` →
`not-due` → `payable`. Reconciliation is a **pure function** (`reconcileInvoice`) with
unit tests in `test/reconciliation.test.js`; the frontend only renders computed statuses.

---

## 5. REST API surface

All `/api/*` routes except `login` require an authenticated session cookie. Role in
brackets: **[O]** officer/admin, **[Ag]** agent (own agency only), **[Ad]** admin,
**[*]** any signed-in user.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` `{username,password}` | Sign in; sets the session cookie |
| POST | `/api/auth/logout` | End the session |
| GET  | `/api/auth/me` | Current user |
| GET  | `/api/admin/users` **[Ad]** | List all users |
| POST | `/api/admin/users` `{username,password,role,fullName,agentId}` **[Ad]** | Create user |
| POST | `/api/admin/users/:id/reset-password` `{password}` **[Ad]** | Reset password (invalidates their sessions) |
| DELETE | `/api/admin/users/:id` **[Ad]** | Delete user (not last admin / not self) |
| GET  | `/api/agents?stage=` **[O]** | List agents (optionally filtered by pipeline stage) |
| GET  | `/api/agents/:id` **[O/Ag-own]** | Full dossier (docs, referees, agreements, students) |
| GET  | `/api/agents/:id/audit` | Append-only audit log |
| POST | `/api/agents/:id/stage` `{stage, note}` | Drive the review pipeline (New→In Review→Docs Requested→Verified) + audit row |
| POST | `/api/agents/:id/documents` `{doc_type, reference, expiry_date}` | Agent uploads a document (simulated); auto-moves New→In Review + audit row |
| POST | `/api/agents/:id/documents/:docId/verify` | College verifies a document + audit row |
| POST | `/api/agents/:id/approve` | **P0** Verified → Decision + agreement + audit row |
| POST | `/api/agents/:id/reject` `{reason}` | **P0** Reject with reason + audit row |
| GET  | `/api/agents/:id/performance` | Recruited, conversion, subclass-500 refusal rate, pre-census withdrawals |
| GET  | `/api/collateral` | Documents, versions, CURRENT version + acknowledgment ledger |
| POST | `/api/collateral/:versionId/acknowledge` `{agentId}` | **P2** Write a ledger row |
| GET  | `/api/invoices` | List invoices |
| GET  | `/api/reconciliation?invoiceId=` | Lines with computed flags (`payable` / `blocked-onshore` / `frozen-coi` / `not-due`) + totals |
| POST | `/api/agents/:id/coi/request` **[O]** | Officer requests the COI declaration from the agent (re-call = reminder) |
| POST | `/api/coi/:agentId/sign` | **P2** Sign COI → unfreeze the dual agent |
| POST | `/api/agents/:id/terminate` `{reason, noticePeriodDays}` **[O]** | **P4** Issue a termination notice (→ Notice Given) |
| POST | `/api/terminations/:tid/acknowledge` **[Ag-own]** | **P4** Agent confirms the notice |
| POST | `/api/agents/:id/offboard/complete` **[O]** | **P4** Complete offboarding (→ Terminated, agreement ended) |

## 6. Seed data (what to expect)

- **6 agents** across the pipeline: `Melbourne Pathways` (New), `Horizon Student
  Services` (In Review), `Apex Overseas Admissions` (Docs Requested), **`Global Reach
  Education` (Verified — approve this live)**, `Sunrise Migration & Education` (Approved,
  **dual agent: MARN on file, COI unsigned**), `Southern Cross Study Group` (Approved).
- **Invoice `INV-2026-0001`** with 5 commission lines producing exactly:
  **2 payable · 1 blocked (onshore, not grandfathered) · 1 frozen (dual agent, COI
  unsigned) · 1 not-due (withdrew pre-census).**
- **Collateral:** "2026 Fee Schedule" **v4 CURRENT** + **v3 SUPERSEDED**; ledger where
  Southern Cross has acknowledged v4 and Global Reach / Sunrise have **not**.

---

## 7. Verification (all passed on this build)

Run these against a seeded, running server:

```bash
# 1) Reconciliation returns exactly 2 payable / 1 blocked / 1 frozen / 1 not-due
curl -s "http://localhost:3000/api/reconciliation?invoiceId=1"

# 2) Approve persists across a restart (P0)
curl -s -X POST http://localhost:3000/api/agents/1/approve      # -> Approved + agreement + audit
#   ...stop the server, start it again...
curl -s http://localhost:3000/api/agents/1                      # stage still "Decision", decision "Approved"

# 3) Acknowledge writes a ledger row (P2)
curl -s -X POST http://localhost:3000/api/collateral/2/acknowledge -H "Content-Type: application/json" -d '{"agentId":2}'

# 4) Sign COI unfreezes (P2) — frozen 1->0, payable 2->3
curl -s -X POST http://localhost:3000/api/coi/2/sign
curl -s "http://localhost:3000/api/reconciliation?invoiceId=1"
```

Confirmed on this machine: reconciliation = **2/1/1/1**; approve **survived a full server
restart**; acknowledge wrote a row; COI sign shifted **frozen 1→0, payable 2→3**; and
`npm test` passes **9/9** engine tests (including the grandfathering edge case).

> After running the P0/P2 curls, run `npm run reset` to restore the pristine demo state
> before presenting.

---

## 8. Scripted ~10-minute demo walkthrough

> Have both tabs open. Start from a freshly seeded DB (`npm run reset`).
> Colour language throughout: **green = payable/verified, amber = pending/frozen,
> red = blocked/breach.**

**(0:00) Sign in (20s).** Open <https://localhost:3000/login>, accept the one-time
self-signed-certificate warning, and mention: *"Officers and agents have separate logins
over HTTPS; passwords are salted-hashed; an admin manages accounts."* Sign in as
**officer** (`officer` / `Passw0rd!23`) here, and as **sunrise** (`sunrise` /
`Passw0rd!23`) in a second browser/private window for the agent side.

**(0:20) Framing (30s).** "One Australian university managing its education-agent
network. Everything is Australian-regulated — ESOS, the National Code, TEQSA. I'll show
you the whole journey — an agent applying and being approved — then the two things a
spreadsheet can't do: commission guardrails and collateral version control with an audit
trail."

**(0:30) Phase 1 — the onboarding journey, both sides live. THE HEADLINE.**
This is the two-actor story: the agent uploads, the university reviews, the university
approves. Watch the **progress rail** advance on both screens.

*Agent portal tab — act as the applicant:*
- In the **"Signed in as"** picker (top right), choose **Melbourne Pathways Consulting**
  (a brand-new applicant). The hero reads **"Application started"** and the rail sits at
  **Applied**.
- On **My application**, use **Upload a document**: pick *ASIC extract*, type a reference,
  **⬆ Upload**. Say: *"The agent submits their compliance documents."* The document
  appears as **Pending review**, and the rail moves to **In review** automatically.
- (Optional) Upload a second one, e.g. *PIER cert* with an expiry date.

*College console tab — act as the university:*
- **Phase 1 · Pipeline**. Point out the board: Melbourne has moved into **In Review**.
  Click its card. The dossier opens with the same **progress rail**.
- The uploaded documents show with a **Verify** button. Click **Verify** on each —
  *"the university checks each document; every action is logged."*
- In **Review actions**, click **Mark Verified**. The rail advances to **Verified**.
- Now click **✓ Approve**, confirm. Say: *"That's a real database write."* The agent
  moves to **Decision / Approved**, an **agreement is auto-generated**, and the
  **audit log** now shows the entire journey: uploaded → in review → verified →
  approved. *"That timeline is immutable regulatory evidence — who did what, when."*
- (Optional) *"If I restart the server it's still approved — it's in Postgres, not
  memory."*

*Agent portal tab — flip back:*
- The applicant's hero now reads **"You're approved and active"** and the rail is
  complete. *"Same data, two audiences — the agent sees their own status live."*

> Tip: there's also **Global Reach Education**, pre-seeded at **Verified**, if you'd
> rather skip straight to the one-click Approve without the upload steps.

**(4:00) Phase 3 — reconciliation, the guardrails [College → Phase 3 tab].**
- The two red/amber **hard-stop banners** are the headline. Read them out.
- Totals: **2 payable, 1 blocked, 1 frozen, 1 not-due**, payable total **A$5,100**.
- Walk the 5 lines:
  - Two green **Payable** (one %-based, one flat).
  - **Rohan Gupta — Blocked (onshore):** *"Onshore transfer accepted after 31 March
    2026. Post-rule, that commission is non-payable. Note the engine still pays a
    grandfathered onshore transfer — the date genuinely matters, so we store it, not
    just a yes/no."*
  - **Vikram Singh — Frozen (COI):** *"His agent, Sunrise, is a dual agent — they hold a
    MARN, so they're also a registered migration agent. Until they sign a
    conflict-of-interest declaration, we freeze their students and hold the commission —
    A$4,200 here. We don't lose it; we hold it."*
  - **Neha Reddy — Not due:** withdrew pre-census.
- Emphasise: *"None of this logic is in the browser. It's a single server-side function
  with unit tests. The screen only renders what the engine decided."*

**(6:00) Phase 2 — collateral version control [College → Phase 2 tab].**
- "2026 Fee Schedule": **v4 CURRENT** (green), **v3 SUPERSEDED** (struck through). Exactly
  one CURRENT version is enforced at the database level.
- Acknowledgment ledger: Southern Cross has acknowledged v4; Global Reach and Sunrise
  are **Outstanding**. *"This is our audit evidence that agents discarded the old
  marketing files."*

**(7:00) The Agent side — unblock the freeze [Agent portal, signed in as `sunrise`].**
- This browser is logged in as **Sunrise Migration** — the portal is scoped to their own
  agency (no agency picker; that's the point of separate logins). Open the
  **Commissions** tab: the striped **"Enrolments frozen — COI declaration needed"** banner,
  the **On hold A$4,200** stat, and their one **Frozen** commission line.
- Click **Complete declaration**, confirm.
- Go to the **Collateral** tab: the teal **"Fee Schedule updated — acknowledgment needed"**
  banner. Click **"I've discarded the old version"**. *"That just wrote a row to the
  ledger."*

**(8:30) Back to the College reconciliation [College → Phase 3, it reloads].**
- The **COI freeze banner is gone**; totals now read **3 payable, 0 frozen**; Vikram's
  line is green **Payable**; payable total jumps to **A$9,300**. *"The agent resolved the
  conflict, and the money is released — end to end, persisted."*
- (Optional) On Phase 2, Sunrise now shows **Acknowledged** in the ledger.

**(9:30) Close.** "So: a regulated approval pipeline with an immutable audit trail,
reconciliation guardrails that encode the actual ESOS rules including grandfathering, and
versioned collateral with acknowledgment evidence — all persisted in Postgres."

---

## 9. Project layout

```
Temp_VMS/
├── package.json
├── .env / .env.example
├── certs/                      # self-signed TLS (git-ignored; created by gen-cert)
│   ├── server.key
│   └── server.cert
├── db/
│   └── schema.sql              # full schema incl. users + sessions (idempotent)
├── scripts/
│   ├── migrate.js              # create DB if needed + apply schema
│   ├── seed.js                 # realistic dummy data + seeded users
│   └── gen-cert.js             # self-signed cert generator (pure JS)
├── src/
│   ├── server.js               # Express app, HTTPS, all REST endpoints + guards
│   ├── auth.js                 # scrypt hashing, cookie sessions, role guards
│   ├── db.js                   # pg pool
│   └── reconciliation.js       # PURE rule engine (onshore block + COI freeze)
├── test/
│   └── reconciliation.test.js  # 9 unit tests incl. grandfathering
└── public/
    ├── index.html
    ├── login.html  + js/login.js
    ├── admin.html  + js/admin.js      # user administration (admin only)
    ├── college.html + js/college.js
    ├── agent.html   + js/agent.js
    ├── js/common.js
    └── css/styles.css
```

## 10. Notes & assumptions

- No ORM; raw SQL via `pg`. No build step; vanilla JS `fetch` on the frontend.
- **Auth:** passwords are salted **scrypt** hashes (Node built-in — no native dep).
  Sessions are opaque httpOnly `Secure` cookies backed by a `sessions` table. Role guards
  live server-side; the UI scoping is a convenience, not the security boundary.
- **TLS:** the app serves HTTPS with a **self-signed** cert (per requirement). For a
  public deployment you'd typically terminate TLS at a reverse proxy (nginx + a real CA
  cert) and can still run Node behind it; the self-signed path remains for local use.
- **Change the seeded passwords** (`ADMIN_PASSWORD`, `SEED_USER_PASSWORD`) before exposing
  this anywhere. On a public box, also bind Postgres to localhost and use a strong DB
  password rather than the `postgres:postgres` default.
- "One CURRENT version per document" is enforced by a partial unique index, not just app
  code.
- The audit log is append-only by convention (no UPDATE/DELETE paths in the app).
- **Phase 4 (offboarding)** is implemented: a college officer issues a termination notice
  (reason + notice period → effective date; agent goes Active → *Notice Given*), the agent
  confirms it in their **Account** tab, and the officer completes offboarding (→ *Terminated*,
  agreement ended). A terminated agent keeps read-only access to their final commission
  statement. Everything writes to the activity history.

---

## 11. Logging & debugging

Structured, correlated logging across the backend and the browser, so a bug can be traced
end to end.

**Where logs go.** JSON lines to the console **and** a daily file `logs/app-<date>.log`
(git-ignored). Set the level with `LOG_LEVEL` in `.env` (`debug` | `info` | `warn` |
`error`; default `info`); set `LOG_TO_FILE=0` for console only.

**Correlation IDs.** Every request gets a short id, returned in the `X-Request-Id`
response header and stamped on every log line for that request (`reqId`). The browser
reads that header, so a client-side `api_error` and the server line that produced it share
the same `reqId`.

**Backend captures**
- `http_request` — method, path, status, duration (ms), `userId`, `role`, `ip`
  (static assets are logged at `debug` to keep `info` clean).
- `auth_login` / `auth_login_failed` — sign-in outcomes (**never** the password).
- `handler_error` / `unhandled_error` — full stack traces; the client gets a generic
  message plus the `reqId` to quote.
- `server_started`, `unhandledRejection`, `uncaughtException`.

**Frontend captures** (in `public/js/common.js`)
- Uncaught errors (`window_error`) and promise rejections (`unhandled_rejection`).
- API failures (`api_error` with status + `reqId`) and network/TLS failures
  (`api_network_error`).
- These are mirrored to the browser console **and** shipped to `POST /api/client-logs`,
  where they're written to the same log stream tagged `source:"client"` with a `pageId`.

**Secret redaction.** Both sides strip anything matching
`pass|token|secret|cookie|authorization|sid` before writing. Request/response bodies are
never logged, so passwords can't leak. (Verified: a wrong-password login and a client
payload containing `secretToken` produced **zero** plaintext occurrences in the log.)

**Debugging a report.** Ask the user for the `reqId` shown in the failed response (or read
it from the browser console), then:

```bash
grep '"reqId":"<id>"' logs/app-<date>.log
```

…to see the browser event and the server handler for that exact interaction together.
