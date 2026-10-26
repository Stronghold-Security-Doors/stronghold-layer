// The mirror: the layer's own copy of the monday boards, kept current by webhooks and a periodic full re-sync.
// monday stays the master. Every row here can be rebuilt from monday at any time ("Sync now").
import { q, getSetting, setSetting } from './db.js';
import * as monday from './monday.js';

export const MIRROR_BOARDS = ['Projects', 'Leads', 'Contacts', 'Deals', 'Quotes & Invoices', 'Installations', 'Surveys', 'Accounts', "T&C's Agreements", 'Warranties and O&M', 'Maintenance', 'Debt'];

export async function migrateMirror() {
  await q(`CREATE TABLE IF NOT EXISTS mirror_boards (name TEXT PRIMARY KEY, board_id TEXT NOT NULL, columns JSONB NOT NULL DEFAULT '[]', groups JSONB NOT NULL DEFAULT '[]', item_count INT DEFAULT 0, last_full_sync TIMESTAMPTZ, last_event TIMESTAMPTZ, status TEXT DEFAULT 'never')`);
  await q(`CREATE TABLE IF NOT EXISTS mirror_items (item_id TEXT PRIMARY KEY, board_name TEXT NOT NULL, board_id TEXT NOT NULL, name TEXT NOT NULL, group_id TEXT, group_title TEXT, cols JSONB NOT NULL DEFAULT '{}', raw JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, archived BOOLEAN DEFAULT false, synced_at TIMESTAMPTZ DEFAULT now())`);
  await q(`CREATE INDEX IF NOT EXISTS mirror_items_board ON mirror_items(board_name, archived)`);
  await q(`CREATE INDEX IF NOT EXISTS mirror_items_group ON mirror_items(board_name, group_title)`);
  await q(`CREATE TABLE IF NOT EXISTS mirror_log (id SERIAL PRIMARY KEY, board_name TEXT, kind TEXT, detail TEXT, at TIMESTAMPTZ DEFAULT now())`);
}
const log = (board, kind, detail) => q('INSERT INTO mirror_log(board_name,kind,detail) VALUES($1,$2,$3)', [board, kind, detail]).catch(() => {});

function shape(it) { // one monday item → one mirror row
  const cols = {}, raw = {};
  for (const cv of it.column_values || []) { const t = cv.column ? cv.column.title : cv.id; cols[t] = cv.text || ''; raw[cv.id] = { title: t, type: cv.type, value: cv.value }; }
  return { item_id: String(it.id), name: it.name, group_id: it.group ? it.group.id : null, group_title: it.group ? it.group.title : null, cols, raw, created_at: it.created_at || null, updated_at: it.updated_at || null };
}
async function upsertRows(boardName, boardId, rows) {
  for (const r of rows) {
    await q(`INSERT INTO mirror_items(item_id,board_name,board_id,name,group_id,group_title,cols,raw,created_at,updated_at,archived,synced_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,now())
      ON CONFLICT(item_id) DO UPDATE SET board_name=$2, board_id=$3, name=$4, group_id=$5, group_title=$6, cols=$7, raw=$8, created_at=$9, updated_at=$10, archived=false, synced_at=now()`,
      [r.item_id, boardName, String(boardId), r.name, r.group_id, r.group_title, JSON.stringify(r.cols), JSON.stringify(r.raw), r.created_at, r.updated_at]);
  }
}

// Full import of one board, page by page. Safe to run any time; it only updates rows.
export async function syncBoard(boardName, boardId) {
  await q(`INSERT INTO mirror_boards(name,board_id,status) VALUES($1,$2,'syncing') ON CONFLICT(name) DO UPDATE SET board_id=$2, status='syncing'`, [boardName, String(boardId)]);
  try {
    const b = await monday.board(boardId);
    await q('UPDATE mirror_boards SET columns=$2, groups=$3 WHERE name=$1', [boardName, JSON.stringify(b.columns.map(c => ({ id: c.id, title: c.title, type: c.type }))), JSON.stringify(b.groups)]);
    const seen = []; let page = await monday.itemsPage(boardId, null, 100); let n = 0;
    while (page && page.items && page.items.length) {
      await upsertRows(boardName, boardId, page.items.map(shape)); page.items.forEach(i => seen.push(String(i.id))); n += page.items.length;
      if (!page.cursor) break; page = await monday.itemsPage(boardId, page.cursor, 100);
    }
    // anything we had that monday no longer lists is archived/deleted there
    if (seen.length) await q(`UPDATE mirror_items SET archived=true WHERE board_name=$1 AND NOT (item_id = ANY($2)) AND archived=false`, [boardName, seen]);
    await q(`UPDATE mirror_boards SET item_count=$2, last_full_sync=now(), status='ok' WHERE name=$1`, [boardName, n]);
    await log(boardName, 'full_sync', `${n} items`); return { board: boardName, items: n };
  } catch (e) { await q(`UPDATE mirror_boards SET status=$2 WHERE name=$1`, [boardName, 'error: ' + e.message]); await log(boardName, 'error', e.message); return { board: boardName, error: e.message }; }
}
export async function syncAll() { const map = await getSetting('boards', {}); const out = []; for (const [name, id] of Object.entries(map)) out.push(await syncBoard(name, id)); await setSetting('mirror_last_sync', new Date().toISOString()); return out; }

// One item, after a webhook. Returns the mirror row (also used by the workflow engine).
export async function refreshItem(boardName, boardId, itemId) {
  const d = await monday.itemFull(itemId); if (!d) { await q('UPDATE mirror_items SET archived=true, synced_at=now() WHERE item_id=$1', [String(itemId)]); return null; }
  const r = shape(d); await upsertRows(boardName, boardId, [r]); await q('UPDATE mirror_boards SET last_event=now() WHERE name=$1', [boardName]); return r;
}
export async function markGone(itemId) { await q('UPDATE mirror_items SET archived=true, synced_at=now() WHERE item_id=$1', [String(itemId)]); }

export async function status() {
  const boards = await q('SELECT name, board_id, item_count, last_full_sync, last_event, status, jsonb_array_length(groups) AS groups, jsonb_array_length(columns) AS columns FROM mirror_boards ORDER BY name');
  const counts = await q('SELECT board_name, count(*) FILTER (WHERE NOT archived)::int AS live, count(*) FILTER (WHERE archived)::int AS archived FROM mirror_items GROUP BY board_name');
  for (const b of boards) { const c = counts.find(x => x.board_name === b.name); b.live = c ? c.live : 0; b.archived = c ? c.archived : 0; }
  return { boards, lastSync: await getSetting('mirror_last_sync', null) };
}
