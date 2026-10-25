// Database: the layer's own records (workflows, runs, settings). monday keeps the boards.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) console.warn('DATABASE_URL is not set — the layer cannot start without its database');
export const pool = new pg.Pool({ connectionString: url, ssl: url && !url.includes('localhost') ? { rejectUnauthorized: false } : false });

export async function q(text, params = []) { const r = await pool.query(text, params); return r.rows; }

export async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, def JSONB NOT NULL, mode TEXT NOT NULL DEFAULT 'watch',
    version INT NOT NULL DEFAULT 1, sort INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS workflow_versions (
    id SERIAL PRIMARY KEY, workflow_id TEXT NOT NULL, version INT NOT NULL, def JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS runs (
    id SERIAL PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL, mode TEXT NOT NULL,
    item_id TEXT, item_name TEXT, board_id TEXT, trigger TEXT, status TEXT NOT NULL DEFAULT 'running',
    node_id TEXT, resume_at TIMESTAMPTZ, item JSONB, log JSONB NOT NULL DEFAULT '[]', error TEXT,
    started_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE INDEX IF NOT EXISTS runs_item ON runs(item_id)`);
  await q(`CREATE INDEX IF NOT EXISTS runs_waiting ON runs(status, resume_at)`);
  await q(`CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, kind TEXT, body JSONB, received_at TIMESTAMPTZ DEFAULT now())`);
}

export async function getSetting(key, fallback = null) { const r = await q('SELECT value FROM settings WHERE key=$1', [key]); return r.length ? r[0].value : fallback; }
export async function setSetting(key, value) { await q('INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=now()', [key, JSON.stringify(value)]); }
