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

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initSchema() {
  // Try versioned migrations first, fall back to schema.sql for existing setups
  try {
    const { runMigrations } = require('./migrator');
    await runMigrations(pool);
  } catch (err) {
    log('Migration runner unavailable, falling back to schema.sql');
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await query(sql);
    log('Database schema initialized via schema.sql');
  }
}

module.exports = { query, getClient, withTransaction, initSchema };
