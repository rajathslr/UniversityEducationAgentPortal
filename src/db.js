'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/agentms';

const pool = new Pool({ connectionString });

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
