// Stronghold layer — entry point. Express app: login, static screens, API, monday webhooks, scheduler.
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, q, getSetting } from './db.js';
import { defaults } from './workflows.js';
import { run, matching, resumeDue } from './engine.js';
import * as monday from './monday.js';
import * as mirror from './mirror.js';
import api from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// --- login: one shared password for the owner/office. Cookie is signed with SESSION_SECRET. ---
const SECRET = process.env.SESSION_SECRET || 'change-me';
const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const verify = c => { if (!c) return false; const i = c.lastIndexOf('.'); return i > 0 && sign(c.slice(0, i)) === c; };
const authed = req => verify(req.cookies && req.cookies.sl_session);
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.post('/login', (req, res) => {
  const pw = process.env.ADMIN_PASSWORD; const given = (req.body && req.body.password) || '';
  if (!pw) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set in Render → Environment' });
  if (given !== pw) return res.status(401).json({ error: 'Wrong password' });
  res.cookie('sl_session', sign('owner.' + Date.now()), { httpOnly: true, sameSite: 'lax', secure: !!process.env.RENDER, maxAge: 30 * 864e5 }); res.json({ ok: true });
});
app.post('/logout', (req, res) => { res.clearCookie('sl_session'); res.json({ ok: true }); });

// --- monday webhooks (no login: monday calls this). The "challenge" handshake is how monday verifies the URL. ---
app.post('/webhooks/monday', async (req, res) => {
  const body = req.body || {};
  if (body.challenge) return res.json({ challenge: body.challenge });
  res.json({ ok: true }); // answer fast; do the work after
  try {
    const ev = body.event || {}; await q('INSERT INTO events(kind,body) VALUES($1,$2)', [ev.type || 'unknown', JSON.stringify(body)]);
    const boardsMap = await getSetting('boards', {}); const boardName = Object.keys(boardsMap).find(n => String(boardsMap[n]) === String(ev.boardId)) || '';
    const evt = { type: ev.type, boardName, boardId: ev.boardId, itemId: ev.pulseId, columnTitle: ev.columnTitle, columnId: ev.columnId, value: labelOf(ev.value), previousValue: labelOf(ev.previousValue) };
    // keep the mirror current first, whatever the event
    if (boardName && evt.itemId) { if (evt.type === 'item_deleted' || evt.type === 'item_archived') { await mirror.markGone(evt.itemId); return; } try { await mirror.refreshItem(boardName, evt.boardId, evt.itemId); } catch (e) { console.error('mirror refresh', e.message); } }
    const ws = (await q(`SELECT * FROM workflows WHERE mode IN ('watch','live')`)).filter(w => { const t = w.def.nodes.find(n => n.type === 'trigger'); return !t || !t.p.board || String(t.p.board).toLowerCase() === boardName.toLowerCase(); });
    const fire = matching(ws, evt); if (!fire.length) return;
    const item = await monday.readItem(evt.itemId); if (!item) return;
    const trigger = evt.type === 'change_column_value' ? `${evt.columnTitle} changed to "${evt.value || ''}"` : evt.type === 'create_item' ? 'Item created' : 'Item moved to ' + (item['Group'] || 'another group');
    for (const wf of fire) {
      // rule 1: a new event on the same item cancels an older waiting run of the same workflow
      await q(`UPDATE runs SET status='cancelled', updated_at=now() WHERE workflow_id=$1 AND item_id=$2 AND status='waiting'`, [wf.id, String(evt.itemId)]);
      await run(wf, Object.assign({}, item), wf.mode === 'live' ? 'live' : 'watch', { trigger });
    }
  } catch (e) { console.error('webhook error', e.message); }
});
function labelOf(v) { if (!v) return ''; if (v.label && typeof v.label === 'object') return v.label.text || ''; if (v.label) return String(v.label); if (v.value != null) return String(v.value); if (v.date) return v.date; if (v.text) return v.text; return ''; }

// --- everything below needs login ---
app.use((req, res, next) => { if (authed(req)) return next(); if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login' }); res.redirect('/login'); });
app.use('/api', api);
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// --- start ---
const port = process.env.PORT || 10000;
(async () => {
  await migrate(); await mirror.migrateMirror();
  const n = (await q('SELECT count(*)::int AS n FROM workflows'))[0].n;
  if (!n) { for (const [i, w] of defaults().entries()) await q('INSERT INTO workflows(id,name,def,mode,version,sort) VALUES($1,$2,$3,$4,1,$5)', [w.id, w.name, JSON.stringify({ desc: w.desc, sample: w.sample, nodes: w.nodes, edges: w.edges, color: w.color }), 'watch', i]); console.log('Loaded the default workflows (all in watch mode)'); }
  setInterval(() => resumeDue().catch(e => console.error('scheduler', e.message)), 30000);
  setInterval(() => mirror.syncAll().catch(e => console.error('mirror sync', e.message)), 6 * 3600 * 1000); // safety net: full re-sync every 6 hours
  mirror.syncAll().catch(e => console.error('mirror first sync', e.message)); // and once at start, so a fresh deploy fills itself
  app.listen(port, () => console.log('Stronghold layer listening on ' + port));
})();
