# Standalone per-role "who has never done this role" scheduling view

We do not build a separate scheduling view/report whose job is to surface, for a
given role, the members who have **never** held it (or are most overdue for it).

## Why this is out of scope

The need this was meant to serve is already covered from the two places a VPE/TM
actually makes scheduling decisions:

- **At the point of assignment** — #146 (shipped) annotates the assign picker with
  each member's last time in that role, showing **"Never"** for those who have
  never held it. The logic lives in `src/server/role-recency-logic.ts`
  (`loadRoleRecency` / `indexRoleRecency`), computed purely from `role_slots`
  joined to `meetings` (no new tables, per ADR-0005). This puts "never done it"
  in front of the scheduler exactly when they're choosing who to assign.

- **As a report** — #8 (`ready-for-agent`) is the VPE overdue view: active members
  who haven't held *any* role in the last N meetings, ordered by how long since
  their last role. That's the proactive "who should I schedule next" surface.

A separate per-role never/overdue view would duplicate the recency computation a
third time and fragment the VPE surface across three places. If a per-role
breakdown is ever wanted, it should fold into #8's dashboard rather than stand
alone.

## Prior requests

- #154 — "Scheduling view: surface members who have never done a given role"
  (spun out of #146; closed wontfix 2026-07-10)
