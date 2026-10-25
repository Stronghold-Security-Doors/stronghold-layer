// The workflow engine. Runs one workflow on one monday item, step by step, and writes a log line for every step.
// mode 'watch' = log only, nothing written to monday. mode 'live' = acts. mode 'test' = like watch, no run saved.
import { q, getSetting } from './db.js';
import * as monday from './monday.js';

export function evalRule(r, item) {
  const raw = item[r.col]; const v = (raw == null ? '' : String(raw)).trim().toLowerCase(); const t = String(r.val || '').trim().toLowerCase();
  switch (r.op) {
    case 'is': return v === t; case 'is not': return v !== t;
    case 'is any of': return t.split(',').map(s => s.trim()).filter(Boolean).includes(v);
    case 'is empty': return v === ''; case 'is not empty': return v !== '';
    case 'is at least': return parseFloat(v) >= parseFloat(t); case 'is less than': return parseFloat(v) < parseFloat(t);
  } return false;
}
export const fill = (s, item) => String(s || '').replace(/\{([^}]+)\}/g, (m, k) => { const key = k.trim(); let v = item[key]; if ((v == null || v === '') && /(reference|name)/i.test(key)) v = item['Item name']; return v != null && v !== '' ? v : ''; });
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function dateVal(v, today = new Date()) {
  const m = /^today(?:\s*\+\s*(\d+)\s*(day|week)s?)?$/i.exec(String(v || '').trim()); if (!m) return v;
  const d = new Date(today); if (m[1]) d.setDate(d.getDate() + (+m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1)); return iso(d);
}
// "1 day", "2 hours", "until 2 weeks before {Due Date}", "until {Installation Date}"
export function waitUntil(text, item, now = new Date()) {
  const s = String(text || '').trim(); let m;
  if ((m = /^(\d+)\s*(minute|hour|day|week)s?$/i.exec(s))) { const n = +m[1], u = m[2].toLowerCase(); const ms = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 }[u]; return { at: new Date(now.getTime() + n * ms), note: s }; }
  if ((m = /until\s+(\d+)\s*(day|week)s?\s+before\s+\{?([^}]+?)\}?$/i.exec(s))) { const d = new Date(item[m[3].trim()]); if (isNaN(d)) return { at: null, note: `${m[3].trim()} has no date yet` }; d.setDate(d.getDate() - (+m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1)); return { at: d, note: s }; }
  if ((m = /until\s+\{?([^}]+?)\}?$/i.exec(s))) { const d = new Date(item[m[1].trim()]); if (isNaN(d)) return { at: null, note: `${m[1].trim()} has no date yet` }; return { at: d, note: s }; }
  return { at: new Date(now.getTime() + 864e5), note: `couldn't read "${s}" — waiting 1 day` };
}

// Column titles → ids for writes, from the board the item lives on.
async function columnId(item, title) { const c = item.__columns && item.__columns[title]; return c ? c.id : null; }
async function groupId(boardId, title) { const b = await monday.board(boardId); const g = (b.groups || []).find(x => x.title.trim().toLowerCase() === String(title).trim().toLowerCase()); return g ? g.id : null; }
async function boardIdByName(name) { const map = await getSetting('boards', {}); if (map[name]) return map[name]; const all = await monday.boards(); const b = all.find(x => x.name.trim().toLowerCase() === String(name).trim().toLowerCase()); return b ? b.id : null; }

// Runs (or resumes) a workflow. Returns the run record. `startNodeId` resumes after a wait.
export async function run(wf, item, mode, opts = {}) {
  const log = opts.runRow ? [...(opts.runRow.log || [])] : []; const push = (kind, text) => log.push({ t: new Date().toISOString(), kind, text });
  const acts = mode === 'live';
  const nid = id => wf.def.nodes.find(n => n.id === id);
  let node = opts.startNodeId ? nid(opts.startNodeId) : wf.def.nodes.find(n => n.type === 'trigger');
  let runRow = opts.runRow || null;
  const persist = async (status, extra = {}) => {
    if (mode === 'test') return;
    if (!runRow) { const r = await q('INSERT INTO runs(workflow_id,workflow_name,mode,item_id,item_name,board_id,trigger,status,item,log) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [wf.id, wf.name, mode, item.__id || null, item['Item name'] || null, item.__board || null, opts.trigger || null, status, JSON.stringify(item), JSON.stringify(log)]); runRow = r[0]; }
    else await q('UPDATE runs SET status=$2, node_id=$3, resume_at=$4, item=$5, log=$6, error=$7, updated_at=now() WHERE id=$1', [runRow.id, status, extra.nodeId || null, extra.resumeAt || null, JSON.stringify(item), JSON.stringify(log), extra.error || null]);
  };
  if (!node) { push('exit', 'This workflow has no trigger'); await persist('done'); return { log, item, status: 'done' }; }
  if (opts.resumed) { push('wait', `Resumed after "${node.p.for}"`); const e = wf.def.edges.find(x => x.from === node.id); node = e ? nid(e.to) : null; if (!node) { push('exit', 'Nothing after the wait — run ended'); await persist('done'); return { log, item, status: 'done' }; } }
  await persist('running');
  const seen = {}; let steps = 0;
  try {
    while (node && steps < 80) {
      steps++; seen[node.id] = (seen[node.id] || 0) + 1;
      if (seen[node.id] > 3) { push('wait', 'Loop paused — the run ends here and waits for the next change on the item'); break; }
      let port = 'out', stop = false; const p = node.p || {};
      switch (node.type) {
        case 'trigger': push('trigger', opts.trigger || p.event || node.title); break;
        case 'condition': { const rules = p.rules || []; const res = rules.map(r => evalRule(r, item)); const ok = rules.length ? (p.match === 'any' ? res.some(Boolean) : res.every(Boolean)) : false; port = ok ? 'yes' : 'no';
          push(ok ? 'yes' : 'no', `${node.title} → ${ok ? 'Yes' : 'No'}  (${rules.map((r, i) => `${r.col} ${r.op}${r.op.includes('empty') ? '' : ' ' + r.val}: ${item[r.col] ?? ''} → ${res[i] ? 'yes' : 'no'}`).join(' · ') || 'no rules'})`); break; }
        case 'status': { const v = dateVal(p.val); const prev = item[p.col]; item[p.col] = v;
          if (acts) { const cid = await columnId(item, p.col); if (!cid) push('no', `Column "${p.col}" not found on this board — nothing written`); else { await monday.setColumn(item.__board, item.__id, cid, v); push('status', `${p.col}: ${prev || '—'} → ${v}`); } }
          else push('status', `(watch) would set ${p.col}: ${prev || '—'} → ${v}`); break; }
        case 'email': { const raw = p.to || ''; const key = raw.replace(/ column$/i, ''); const to = item[key] || fill(raw, item); push('email', `${acts ? '' : '(watch) '}Email to ${to}: "${fill(p.subject, item)}" — email sending arrives in phase 3; logged only`); break; }
        case 'notify': { const text = `${p.who}: ${fill(p.msg, item)}`; if (acts && item.__id) { await monday.postUpdate(item.__id, `🔔 ${text}`); push('notify', text + ' (posted as an update)'); } else push('notify', `(watch) ${text}`); break; }
        case 'wait': { const w = waitUntil(p.for, item); if (mode === 'test') { push('wait', `Would wait ${p.for}${w.at ? ' (until ' + w.at.toISOString().slice(0, 16).replace('T', ' ') + ')' : ' — ' + w.note}`); stop = true; break; }
          if (!w.at) { push('wait', `Can't wait: ${w.note}. Run parked.`); await persist('parked', { nodeId: node.id, error: w.note }); return { log, item, status: 'parked' }; }
          push('wait', `Waiting ${p.for} — resumes ${w.at.toISOString().slice(0, 16).replace('T', ' ')}`); await persist('waiting', { nodeId: node.id, resumeAt: w.at }); return { log, item, status: 'waiting' }; }
        case 'move': { const prev = item['Group']; item['Group'] = p.group;
          if (acts) { const gid = await groupId(item.__board, p.group); if (!gid) push('no', `Group "${p.group}" not found — not moved`); else { await monday.moveToGroup(item.__id, gid); push('move', `Moved ${prev} → ${p.group}`); } }
          else push('move', `(watch) would move ${prev} → ${p.group}`); break; }
        case 'create': { const name = fill(p.item, item) || item['Item name'] || 'New item';
          if (acts) { const bid = await boardIdByName(p.board); if (!bid) push('no', `Board "${p.board}" not found — nothing created`); else { const id = await monday.createItem(bid, name); push('create', `Created "${name}" on ${p.board} (id ${id})`); } }
          else push('create', `(watch) would create "${name}" on the ${p.board} board`); break; }
        case 'ai': push('ai', `AI block "${p.task || node.title}" — AI blocks arrive in phase 2; skipped`); if (p.out && !item[p.out]) item[p.out] = ''; break;
        case 'exit': push('exit', p.note || node.title); stop = true; break;
        default: push('exit', `Unknown step type ${node.type}`); stop = true;
      }
      if (stop) break;
      const edge = wf.def.edges.find(e => e.from === node.id && e.port === port);
      if (!edge) { push('exit', `Nothing connected to "${port}" on "${node.title}" — run ended`); break; }
      node = nid(edge.to);
    }
    await persist('done'); return { log, item, status: 'done' };
  } catch (err) {
    push('no', 'Error: ' + err.message); await persist('parked', { nodeId: node && node.id, error: err.message }); return { log, item, status: 'parked', error: err.message };
  }
}

// Which workflows should fire for a monday event?
export function matching(workflows, ev) {
  return workflows.filter(wf => {
    const t = wf.def.nodes.find(n => n.type === 'trigger'); if (!t) return false; const p = t.p || {};
    if ((p.trigger || 'change_column_value') !== ev.type) return false;
    if (ev.type === 'change_column_value') { const cols = String(p.columns || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); if (cols.length && !cols.includes(String(ev.columnTitle || '').trim().toLowerCase())) return false;
      if (p.when) { const m = /^(.*?)\s*=\s*(.*)$/.exec(p.when); if (m && m[1].trim().toLowerCase() === String(ev.columnTitle || '').trim().toLowerCase() && String(ev.value || '').trim().toLowerCase() !== m[2].trim().toLowerCase()) return false; } }
    return true;
  });
}

// Resume waiting runs whose time has come. Called by the scheduler.
export async function resumeDue() {
  const due = await q(`SELECT * FROM runs WHERE status='waiting' AND resume_at <= now() ORDER BY resume_at LIMIT 20`);
  for (const r of due) {
    const wfr = await q('SELECT * FROM workflows WHERE id=$1', [r.workflow_id]); if (!wfr.length) { await q(`UPDATE runs SET status='parked', error='workflow deleted' WHERE id=$1`, [r.id]); continue; }
    const wf = wfr[0]; if (wf.mode === 'off') { await q(`UPDATE runs SET status='parked', error='workflow switched off' WHERE id=$1`, [r.id]); continue; }
    let item = null; try { item = r.item_id ? await monday.readItem(r.item_id) : r.item; } catch (e) { item = r.item; }
    if (!item) item = r.item;
    await run(wf, item, wf.mode === 'live' ? 'live' : 'watch', { startNodeId: r.node_id, resumed: true, runRow: r });
  }
  return due.length;
}
