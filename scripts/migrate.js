'use strict';
// Creates the target database if it does not exist, then applies db/schema.sql.
// Connects first to the "postgres" maintenance DB using the same credentials.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = new URL(
  process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/agentms'
);
const targetDb = url.pathname.replace(/^\//, '') || 'agentms';

function adminUrl() {
  const u = new URL(url.toString());
  u.pathname = '/postgres';
  return u.toString();
}

async function ensureDatabase() {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  const { rows } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [targetDb]
  );
  if (rows.length === 0) {
    // Cannot parameterise an identifier — targetDb comes from our own .env.
    await admin.query(`CREATE DATABASE "${targetDb}"`);
    console.log(`Created database "${targetDb}".`);
  } else {
    console.log(`Database "${targetDb}" already exists.`);
  }
  await admin.end();
}

// schema.sql opens with a DROP block that destroys every table. That is only
// ever wanted when deliberately rebuilding from scratch, so it is fenced off
// with markers and stripped out unless --fresh is passed. Without this, every
// deploy silently wiped production data.
const FRESH = process.argv.includes('--fresh') || process.env.FRESH === '1';

function loadSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const START = '-- @fresh-only:start';
  const END = '-- @fresh-only:end';
  if (FRESH) return sql;
  const from = sql.indexOf(START);
  const to = sql.indexOf(END);
  if (from === -1 || to === -1) {
    throw new Error(
      'schema.sql is missing the @fresh-only markers around its DROP block. ' +
      'Refusing to run it, because it may destroy data.'
    );
  }
  return sql.slice(0, from) + sql.slice(to + END.length);
}

async function applySchema() {
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    if (FRESH) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
      if (rows[0].n > 0) console.log(`--fresh: DROPPING ${rows[0].n} existing tables and all their data.`);
    }
    await client.query(loadSchema());
  } finally {
    await client.end();
  }
  console.log(FRESH ? 'Schema rebuilt from scratch (data destroyed).' : 'Schema applied (existing data preserved).');
}

(async () => {
  try {
    await ensureDatabase();
    await applySchema();
    console.log('Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    console.error(
      'Check DATABASE_URL in .env (host, port, user, password). ' +
        'Current target DB: ' + targetDb
    );
    process.exit(1);
  }
})();
