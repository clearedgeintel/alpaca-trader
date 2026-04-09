const fs = require('fs');
const path = require('path');
const { log, error } = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

/**
 * Run versioned migrations against the database.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * @param {Object} pool - pg Pool instance
 */
async function runMigrations(pool) {
  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  // Get already-applied migrations
  const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const appliedSet = new Set(applied.rows.map(r => r.version));

  // Read migration files, sorted by name
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace('.sql', '');
    if (appliedSet.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      log(`Migration applied: ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      error(`Migration failed: ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    log('Database schema up to date');
  } else {
    log(`Applied ${count} migration(s)`);
  }
}

module.exports = { runMigrations };
