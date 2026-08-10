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

async function applySchema() {
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'schema.sql'),
    'utf8'
  );
  await client.query(sql);
  await client.end();
  console.log('Schema applied.');
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
