# Modeled speaker↔evaluator role link

**Status:** Out of scope (rejected during triage of #95, 2026-07-03).

## The request
Replace the "paired evaluator inferred by highest `defaultCount`" heuristic in
`src/lib/meeting-roles.ts` (`pickSpeakerAndEvaluatorRoles`) with an explicit,
modeled link between a speaker role and its evaluator role (e.g. a
`pairedEvaluatorRoleId` FK on `roleDefinitions`).

## Why it was rejected
Two different "pairings" were conflated:

- **Slot-level (Speaker 1 ↔ Evaluator 1)** already works positionally and
  correctly. `applyAddSpeakerSlot` inserts a speaker slot and an evaluator slot
  in index parity; remove/auto-assign mirror it. A Speaker 1 / Speaker 3 gap is
  fixed with the existing up/down reorder controls. Nothing to model.
- **Role-level (which evaluator *role* is "the" evaluator)** is the only thing
  the heuristic decides, and it only matters if a club defines **two or more
  `evaluator`-category roles** — which the standard template never does.

The multi-evaluator-role case is hypothetical. And #66 (custom roles + custom
agendas) already gives clubs the flexibility to express any unusual arrangement
(e.g. a second/specialized evaluator) without a hard-coded inter-role FK. A
modeled link would be a *more brittle, less flexible* version of what custom
roles already provide, built for a case no real club has hit.

## What would change our mind
A real club actually running multiple distinct `evaluator`-category roles and
reporting that the wrong role gets slotted. If that happens, prefer a small,
visible guardrail (surface the ambiguity in `/_authed/admin/roles`) over a data
model — the FK link stays overengineering.
