#!/usr/bin/env node
// Tiny migration runner for Supabase Postgres. Reads .env for the project
// ref + DB password, connects directly, runs whichever .sql files you pass
// (or `--all-pending` to apply everything not yet recorded in the
// buffr_migrations tracking table).
//
// Usage:
//   node scripts/db-migrate.mjs supabase/migrations/0003_server_time_rpc.sql
//   node scripts/db-migrate.mjs --all-pending
//   node scripts/db-migrate.mjs --status
//
// The tracking table is created on first run. Existing migrations applied
// via the SQL editor before this runner existed need to be marked applied
// manually:
//   node scripts/db-migrate.mjs --mark-applied 0001_initial_schema.sql 0002_rls_policies.sql

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: resolve(fileURLToPath(import.meta.url), '../../.env') });

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const password = process.env.SUPABASE_DB_PASSWORD;
if (!url || !password) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_DB_PASSWORD in .env');
  process.exit(1);
}

const refMatch = url.match(/^https:\/\/([^.]+)\.supabase\.co/);
if (!refMatch) {
  console.error(`Could not parse project ref from ${url}`);
  process.exit(1);
}
const projectRef = refMatch[1];

// Direct connection — works for migrations from a dev machine. For runtime
// app traffic Supabase recommends the pooler, but for one-off DDL the direct
// connection is simplest and supports session-level features.
const client = new pg.Client({
  host: `db.${projectRef}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

const MIGRATIONS_DIR = resolve(fileURLToPath(import.meta.url), '../../supabase/migrations');
const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS buffr_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function ensureTrackingTable() {
  await client.query(TRACKING_TABLE_DDL);
}

async function getApplied() {
  const { rows } = await client.query('SELECT name FROM buffr_migrations ORDER BY name');
  return new Set(rows.map(r => r.name));
}

async function applyFile(absPath) {
  const name = basename(absPath);
  const sql = readFileSync(absPath, 'utf-8');
  console.log(`→ ${name}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO buffr_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
    await client.query('COMMIT');
    console.log(`  applied`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function markApplied(name) {
  await client.query(
    'INSERT INTO buffr_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
    [name],
  );
  console.log(`  marked ${name} as applied (no SQL run)`);
}

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/db-migrate.mjs <file...> | --all-pending | --status | --mark-applied <name...>');
    process.exit(1);
  }

  await client.connect();
  try {
    await ensureTrackingTable();

    if (args[0] === '--status') {
      const applied = await getApplied();
      const all = listMigrations();
      console.log('migration                                  status');
      console.log('───────────────────────────────────────────────────');
      for (const f of all) {
        console.log(`${f.padEnd(42)} ${applied.has(f) ? 'applied' : 'PENDING'}`);
      }
      return;
    }

    if (args[0] === '--mark-applied') {
      for (const name of args.slice(1)) {
        await markApplied(name);
      }
      return;
    }

    if (args[0] === '--all-pending') {
      const applied = await getApplied();
      const pending = listMigrations().filter(f => !applied.has(f));
      if (pending.length === 0) {
        console.log('Nothing pending.');
        return;
      }
      for (const f of pending) {
        await applyFile(join(MIGRATIONS_DIR, f));
      }
      return;
    }

    // Specific files
    for (const arg of args) {
      const path = arg.startsWith('/') ? arg : resolve(arg);
      await applyFile(path);
    }
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
