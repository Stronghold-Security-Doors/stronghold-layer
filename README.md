# Stronghold layer

The workflow engine and canvas that sits on top of monday.com, plus the mirror — the layer's own copy of the boards, kept in sync by webhooks and a full re-sync every 6 hours. monday stays the master.

## Runbook (plain English)

**Where things are**
- Code: this GitHub repository. Every change is a commit; Render builds from the `main` branch.
- Running app + database: Render dashboard → `stronghold-layer` (web service) and `stronghold-layer-db` (database).
- Secrets: Render → stronghold-layer → Environment. `MONDAY_TOKEN` and `ADMIN_PASSWORD` live there and nowhere else.

**If something breaks**
1. Render → stronghold-layer → Events → find the last deploy that worked → Rollback.
2. If a workflow is misbehaving, open the app → Canvas → set that workflow to Watch. It stops writing to monday immediately.
3. The team keeps working in monday. The old monday automations can be switched back on at any time.

**Settings in the app**
- Setup: choose the Projects board, check the column mapping, register the monday webhooks.
- Canvas: edit workflows; Watch = log only, Live = acts on monday.
- Runs: every run of every workflow, step by step.
- Data: the mirror, board by board. Read-only for now. Should match monday within seconds; Setup → Mirror shows when each board last synced.

**Local run (for a developer)**
```
npm install
DATABASE_URL=postgres://... MONDAY_TOKEN=... ADMIN_PASSWORD=... SESSION_SECRET=anything node src/server.js
```
