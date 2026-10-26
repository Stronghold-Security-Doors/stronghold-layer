// The app's own API, used by the canvas, setup and runs screens.
import { Router } from 'express';
import { q, getSetting, setSetting } from '../db.js';
import * as monday from '../monday.js';
import { run, matching, autoLayoutOf } from '../engine-helpers.js';
import { defaults, autoLayout } from '../workflows.js';
import * as mirror from '../mirror.js';

const api = Router();
const uid = () => 'w' + Math.random().toString(36).slice(2, 8);

// --- workflows ---
api.get('/workflows', async (req, res) => { res.json(await q('SELECT id,name,def,mode,version,sort,updated_at FROM workflows ORDER BY sort,name')); });
api.post('/workflows', async (req, res) => {
  const { name } = req.body || {}; const id = uid(); const def = { desc: '', sample: { Group: '' }, nodes: [{ id: 'n' + Math.random().toString(36).slice(2, 7), type: 'trigger', title: 'Trigger', p: { board: 'Projects', trigger: 'change_column_value', columns: '', event: '' }, x: 40, y: 120 }], edges: [] };
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM workflows'))[0].s;
  await q('INSERT INTO workflows(id,name,def,mode,version,sort) VALUES($1,$2,$3,$4,1,$5)', [id, name || 'New workflow', JSON.stringify(def), 'watch', sort]);
  res.json({ id });
});
api.put('/workflows/:id', async (req, res) => {
  const { name, def, mode } = req.body || {}; const cur = (await q('SELECT * FROM workflows WHERE id=$1', [req.params.id]))[0]; if (!cur) return res.status(404).json({ error: 'not found' });
  const changedDef = def && JSON.stringify(def) !== JSON.stringify(cur.def);
  const version = changedDef ? cur.version + 1 : cur.version;
  if (changedDef) await q('INSERT INTO workflow_versions(workflow_id,version,def) VALUES($1,$2,$3)', [cur.id, cur.version, JSON.stringify(cur.def)]);
  await q('UPDATE workflows SET name=$2, def=$3, mode=$4, version=$5, updated_at=now() WHERE id=$1', [cur.id, name ?? cur.name, JSON.stringify(def ?? cur.def), mode ?? cur.mode, version]);
  res.json({ ok: true, version });
});
api.delete('/workflows/:id', async (req, res) => { await q('DELETE FROM workflows WHERE id=$1', [req.params.id]); res.json({ ok: true }); });
api.post('/workflows/:id/tidy', async (req, res) => { const w = (await q('SELECT * FROM workflows WHERE id=$1', [req.params.id]))[0]; if (!w) return res.status(404).end(); autoLayout(w.def); await q('UPDATE workflows SET def=$2 WHERE id=$1', [w.id, JSON.stringify(w.def)]); res.json(w.def); });
api.get('/workflows/:id/versions', async (req, res) => { res.json(await q('SELECT id,version,created_at FROM workflow_versions WHERE workflow_id=$1 ORDER BY version DESC', [req.params.id])); });
api.post('/workflows/:id/restore/:version', async (req, res) => { const v = (await q('SELECT def FROM workflow_versions WHERE workflow_id=$1 AND version=$2', [req.params.id, req.params.version]))[0]; if (!v) return res.status(404).end(); req.body = { def: v.def }; const cur = (await q('SELECT * FROM workflows WHERE id=$1', [req.params.id]))[0]; await q('INSERT INTO workflow_versions(workflow_id,version,def) VALUES($1,$2,$3)', [cur.id, cur.version, JSON.stringify(cur.def)]); await q('UPDATE workflows SET def=$2, version=version+1, updated_at=now() WHERE id=$1', [cur.id, JSON.stringify(v.def)]); res.json({ ok: true }); });
api.post('/workflows/reset-defaults', async (req, res) => { const ws = defaults(); for (const [i, w] of ws.entries()) { await q('INSERT INTO workflows(id,name,def,mode,version,sort) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(id) DO UPDATE SET def=$3, name=$2, updated_at=now()', [w.id, w.name, JSON.stringify({ desc: w.desc, sample: w.sample, nodes: w.nodes, edges: w.edges, color: w.color }), 'watch', i]); } res.json({ ok: true }); });

// --- test a workflow on a real item (never writes) ---
api.post('/workflows/:id/test', async (req, res) => {
  const w = (await q('SELECT * FROM workflows WHERE id=$1', [req.params.id]))[0]; if (!w) return res.status(404).end();
  let item; try { item = req.body.itemId ? await monday.readItem(req.body.itemId) : Object.assign({}, w.def.sample || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const r = await run(w, item, 'test', { trigger: 'Test run' + (req.body.itemId ? ' on ' + (item['Item name'] || req.body.itemId) : ' on the sample item') });
  res.json({ log: r.log, item: Object.fromEntries(Object.entries(r.item).filter(([k]) => !k.startsWith('__'))) });
});

// --- runs ---
api.get('/runs', async (req, res) => { const { item, workflow, limit } = req.query; const where = [], params = []; if (item) { params.push(item); where.push(`item_id=$${params.length}`); } if (workflow) { params.push(workflow); where.push(`workflow_id=$${params.length}`); } params.push(Math.min(+limit || 100, 500)); res.json(await q(`SELECT id,workflow_id,workflow_name,mode,item_id,item_name,trigger,status,resume_at,error,started_at,updated_at,jsonb_array_length(log) AS steps FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${params.length}`, params)); });
api.get('/runs/:id', async (req, res) => { const r = (await q('SELECT * FROM runs WHERE id=$1', [req.params.id]))[0]; if (!r) return res.status(404).end(); res.json(r); });
api.post('/runs/:id/retry', async (req, res) => { const r = (await q('SELECT * FROM runs WHERE id=$1', [req.params.id]))[0]; if (!r) return res.status(404).end(); await q(`UPDATE runs SET status='waiting', resume_at=now(), error=NULL WHERE id=$1`, [r.id]); res.json({ ok: true }); });
api.post('/runs/:id/cancel', async (req, res) => { await q(`UPDATE runs SET status='cancelled', updated_at=now() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); });

// --- setup: monday connection, boards, webhooks ---
api.get('/setup', async (req, res) => {
  const out = { tokenSet: !!process.env.MONDAY_TOKEN, publicUrl: process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '', boards: await getSetting('boards', {}), me: null, error: null };
  try { out.me = await monday.me(); } catch (e) { out.error = e.message; }
  res.json(out);
});
api.get('/setup/boards', async (req, res) => { try { res.json(await monday.boards()); } catch (e) { res.status(400).json({ error: e.message }); } });
api.post('/setup/boards', async (req, res) => { const map = Object.assign(await getSetting('boards', {}), req.body || {}); await setSetting('boards', map); res.json(map); });
// Which column titles do the workflows mention, and does the chosen board have them?
api.get('/setup/mapping', async (req, res) => {
  const map = await getSetting('boards', {}); const bid = map['Projects']; if (!bid) return res.json({ board: null, columns: [], used: [] });
  try { const b = await monday.board(bid); const titles = new Set(b.columns.map(c => c.title)); const groups = b.groups.map(g => g.title);
    const ws = await q('SELECT id,name,def FROM workflows'); const used = {};
    for (const w of ws) for (const n of w.def.nodes) { const p = n.p || {}; const add = (t, why) => { if (!t) return; t = String(t).replace(/ column$/i, '').trim(); if (!t || /^Today/i.test(t)) return; (used[t] = used[t] || { title: t, found: titles.has(t) || t === 'Group', where: new Set() }).where.add(w.name.split(' — ')[0] + ' · ' + why); };
      if (n.type === 'trigger') String(p.columns || '').split(',').forEach(c => add(c, 'trigger'));
      if (n.type === 'condition') (p.rules || []).forEach(r => add(r.col, 'check'));
      if (n.type === 'status') add(p.col, 'sets'); if (n.type === 'email') add(p.to, 'email to');
      if (n.type === 'wait') { const m = /\{([^}]+)\}/.exec(p.for || ''); if (m) add(m[1], 'wait'); }
      if (n.type === 'move') { if (!groups.includes(p.group)) (used['group:' + p.group] = { title: 'Group "' + p.group + '"', found: false, where: new Set([w.name.split(' — ')[0] + ' · move']) }); } }
    res.json({ board: { id: b.id, name: b.name, columns: b.columns.map(c => c.title), groups }, used: Object.values(used).map(u => ({ ...u, where: [...u.where] })).sort((a, b) => (a.found === b.found ? 0 : a.found ? 1 : -1)) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
api.get('/setup/webhooks', async (req, res) => { const map = await getSetting('boards', {}); const out = {}; for (const [name, id] of Object.entries(map)) { try { out[name] = await monday.webhooks(id); } catch (e) { out[name] = { error: e.message }; } } res.json(out); });
api.post('/setup/webhooks', async (req, res) => {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL; if (!base) return res.status(400).json({ error: 'No public URL known yet' });
  const map = await getSetting('boards', {}); const url = base.replace(/\/$/, '') + '/webhooks/monday'; const made = [];
  for (const [name, id] of Object.entries(map)) { const existing = await monday.webhooks(id); for (const ev of ['change_column_value', 'create_item', 'item_moved_to_any_group', 'item_deleted', 'item_archived', 'change_name']) { if (existing.some(w => w.event === ev && (w.config || '').includes(url))) continue; try { made.push({ board: name, event: ev, id: await monday.createWebhook(id, url, ev) }); } catch (e) { made.push({ board: name, event: ev, error: e.message }); } } }
  res.json({ url, made });
});
api.get('/setup/items', async (req, res) => { const map = await getSetting('boards', {}); const bid = map[req.query.board || 'Projects']; if (!bid) return res.json([]); try { res.json(await monday.boardItems(bid, 60)); } catch (e) { res.status(400).json({ error: e.message }); } });
// --- mirror ---
api.get('/mirror/status', async (req, res) => { res.json(await mirror.status()); });
api.post('/mirror/sync', async (req, res) => { const { board } = req.body || {}; const map = await getSetting('boards', {}); if (board) { if (!map[board]) return res.status(400).json({ error: 'board not mapped' }); return res.json([await mirror.syncBoard(board, map[board])]); } res.json(await mirror.syncAll()); });
api.get('/mirror/items', async (req, res) => { const board = req.query.board || 'Projects'; const search = (req.query.q || '').trim().toLowerCase(); const includeArchived = req.query.archived === '1';
  const rows = await q(`SELECT item_id,name,group_title,cols,updated_at,created_at,archived FROM mirror_items WHERE board_name=$1 ${includeArchived ? '' : 'AND NOT archived'} ORDER BY updated_at DESC NULLS LAST LIMIT 2000`, [board]);
  const out = search ? rows.filter(r => (r.name + ' ' + Object.values(r.cols).join(' ')).toLowerCase().includes(search)) : rows;
  const b = (await q('SELECT columns, groups FROM mirror_boards WHERE name=$1', [board]))[0]; res.json({ board, columns: b ? b.columns : [], groups: b ? b.groups : [], items: out }); });
api.get('/mirror/items/:id', async (req, res) => { const r = (await q('SELECT * FROM mirror_items WHERE item_id=$1', [req.params.id]))[0]; if (!r) return res.status(404).json({ error: 'not in the mirror' }); let updates = []; try { updates = await monday.updatesFor(r.item_id); } catch (e) {} const runs = await q('SELECT id,workflow_name,mode,status,started_at,trigger FROM runs WHERE item_id=$1 ORDER BY id DESC LIMIT 50', [r.item_id]); res.json({ item: r, updates, runs }); });
api.get('/mirror/log', async (req, res) => { res.json(await q('SELECT * FROM mirror_log ORDER BY id DESC LIMIT 100')); });

api.get('/events', async (req, res) => { res.json(await q('SELECT id,kind,body,received_at FROM events ORDER BY id DESC LIMIT 50')); });

export default api;
