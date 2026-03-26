const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { log, error } = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    error(`DB query failed: ${text}`, err);
    throw err;
  }
}

async function getClient() {
  return pool.connect();
}

async function initSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
  log('Database schema initialized');
}

module.exports = { query, getClient, initSchema };
