# Plan 001: Extract pure agenda logic into a testable module + stand up the Vitest harness

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0e33f82..HEAD -- src/server/meetings.ts src/routes/_authed/meetings.\$id.tsx vite.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt (with tests)
- **Planned at**: commit `0e33f82`, 2026-06-26
- **Issue**: https://github.com/abustamam/tm-scheduler/issues/12

## Why this matters

The app's core domain logic — generating role slots from a club's role
definitions, resolving which speaker each evaluator evaluates, and numbering
repeated roles ("Speaker 1", "Speaker 2") — is currently inlined inside server
function handlers and React components. That makes it impossible to unit-test
without a database or a rendered DOM. This plan extracts those three pieces into
a single pure module (`src/lib/agenda.ts`) and stands up the Vitest harness
with the first real tests. It unblocks plan 002 (integration tests) and plan 003
(timezone fix), and it gives the repo its first non-vacuous `bun run test`.

There are currently **zero test files** in the repo; `bun run test` passes
because Vitest finds nothing to run. After this plan, the harness is proven and
the most reusable logic is covered.

## Current state

Relevant files:

- `src/server/meetings.ts` — server functions; contains slot generation (lines
  193–199) and evaluator→speaker resolution (lines 96–111).
- `src/routes/_authed/meetings.$id.tsx` — meeting detail UI; contains role
  numbering (lines 48–56).
- `src/db/seed.ts` — also generates slots the same way (lines 156–162); leave it
  as-is in this plan but note it for the maintenance section.
- `vite.config.ts` — Vite config with TanStack Start + Nitro plugins. Vitest
  currently has no dedicated config and would try to load this one.

Slot generation today (`src/server/meetings.ts:193-199`):

```ts
const slotRows = defs.flatMap((def) =>
	Array.from({ length: def.defaultCount }, (_, i) => ({
		meetingId: meeting.id,
		roleDefinitionId: def.id,
		slotIndex: i,
	})),
);
```

Evaluator resolution today (`src/server/meetings.ts:96-111`):

```ts
const bySlotId = new Map(rows.map((r) => [r.id, r]));
const slots = rows.map((r) => {
	const target = r.evaluatesSlotId ? bySlotId.get(r.evaluatesSlotId) : undefined;
	return {
		...r,
		evaluates: target
			? { slotId: target.id, speakerName: target.assigneeName, speechTitle: target.speechTitle }
			: null,
	};
});
```

Role numbering today (`src/routes/_authed/meetings.$id.tsx:48-56`):

```ts
const roleCounts = slots.reduce<Record<string, number>>((acc, s) => {
	acc[s.roleName] = (acc[s.roleName] ?? 0) + 1;
	return acc;
}, {});
function slotLabel(s: Slot) {
	return roleCounts[s.roleName] > 1 ? `${s.roleName} ${s.slotIndex + 1}` : s.roleName;
}
```

Repo conventions to match:

- **Biome formats with tabs and double quotes**, import organization on. After
  editing, run `bunx biome check --write <files>` so formatting passes.
- Import alias `#/*` → `src/*` (declared in `tsconfig.json` paths and
  `package.json` imports). In **tests**, import the module under test with a
  **relative path** (`./agenda`) to avoid alias-resolution setup.
- Strict TS with `noUnusedLocals`/`noUnusedParameters` — no unused symbols.
- `src/lib/` is for pure helpers usable by both client and server (see
  `src/lib/format.ts`, `src/lib/utils.ts`). The new module belongs here because
  role numbering is used in a client component — it must NOT import `db`/`pg`.

## Commands you will need

| Purpose   | Command                                   | Expected on success     |
|-----------|-------------------------------------------|-------------------------|
| Install   | `bun install`                             | exit 0                  |
| Typecheck | `bunx tsc --noEmit`                        | exit 0, no errors       |
| Test      | `bunx vitest run src/lib/agenda.test.ts`  | all pass                |
| Lint/fmt  | `bun run check`                           | exit 0                  |
| Autofix   | `bunx biome check --write <files>`        | rewrites, exit 0        |

## Suggested executor toolkit

- Invoke the `tdd` skill if available — write each test before the extracted
  function, confirm it fails, then make it pass.

## Scope

**In scope** (the only files you should modify or create):
- `vitest.config.ts` (create)
- `src/lib/agenda.ts` (create)
- `src/lib/agenda.test.ts` (create)
- `src/server/meetings.ts` (replace the two inlined blocks with calls)
- `src/routes/_authed/meetings.$id.tsx` (replace the numbering block with calls)

**Out of scope** (do NOT touch):
- `src/db/seed.ts` — has its own copy of slot generation; consolidating it is a
  follow-up, not this plan. Leave it.
- Any database query, guard, or `createServerFn` wiring — behavior must be
  byte-identical; this is a pure refactor.
- The response shapes returned by `getMeeting` / `createMeeting` — clients depend
  on them. The extracted functions must produce the exact same data.

## Git workflow

- Branch: `advisor/001-extract-agenda-logic`
- Commit per logical unit; conventional-commit style (match `git log`, e.g.
  `refactor: extract pure agenda logic into src/lib/agenda.ts`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Stand up a dedicated Vitest config

Create `vitest.config.ts` so Vitest does not load the Start/Nitro Vite plugins.
Resolve the `#/` alias for later plans. Use the `node` environment (these tests
are pure; no DOM needed):

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: { "#": resolve(__dirname, "src") },
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});
```

Note: the alias maps the bare specifier `#` so that `#/db` resolves to
`src/db` (Vite alias does prefix replacement: `#/db` → `<root>/src/db`).

**Verify**: `bunx vitest run` → exits 0 with "No test files found" (no tests yet).
If it errors trying to load Nitro/Start plugins instead, the config is being
ignored — STOP and report.

### Step 2: Create the pure module with the three functions

Create `src/lib/agenda.ts`. Keep the functions generic over the row shapes using
small local input types so they don't depend on Drizzle types:

```ts
/** A role definition's shape needed to generate slots. */
export type SlotGenInput = { id: string; defaultCount: number };

/** Generate one slot row per (definition × defaultCount), 0-based slotIndex. */
export function generateSlotRows(
	defs: SlotGenInput[],
	meetingId: string,
): { meetingId: string; roleDefinitionId: string; slotIndex: number }[] {
	return defs.flatMap((def) =>
		Array.from({ length: def.defaultCount }, (_, i) => ({
			meetingId,
			roleDefinitionId: def.id,
			slotIndex: i,
		})),
	);
}

/** Build the count of slots per role name (for numbering repeated roles). */
export function buildRoleCounts<T extends { roleName: string }>(
	slots: T[],
): Record<string, number> {
	return slots.reduce<Record<string, number>>((acc, s) => {
		acc[s.roleName] = (acc[s.roleName] ?? 0) + 1;
		return acc;
	}, {});
}

/** "Speaker 1" when a role repeats, otherwise just "Speaker". */
export function slotLabel(
	slot: { roleName: string; slotIndex: number },
	roleCounts: Record<string, number>,
): string {
	return roleCounts[slot.roleName] > 1
		? `${slot.roleName} ${slot.slotIndex + 1}`
		: slot.roleName;
}
```

For evaluator resolution, model the minimum fields it reads:

```ts
type EvaluatorRow = {
	id: string;
	evaluatesSlotId: string | null;
	assigneeName: string | null;
	speechTitle: string | null;
};

/** Attach `evaluates` (the speaker slot this row evaluates) by id lookup. */
export function resolveEvaluatorLinks<T extends EvaluatorRow>(
	rows: T[],
): (T & {
	evaluates: { slotId: string; speakerName: string | null; speechTitle: string | null } | null;
})[] {
	const bySlotId = new Map(rows.map((r) => [r.id, r]));
	return rows.map((r) => {
		const target = r.evaluatesSlotId ? bySlotId.get(r.evaluatesSlotId) : undefined;
		return {
			...r,
			evaluates: target
				? { slotId: target.id, speakerName: target.assigneeName, speechTitle: target.speechTitle }
				: null,
		};
	});
}
```

**Verify**: `bunx tsc --noEmit` → exit 0.

### Step 3: Write the unit tests

Create `src/lib/agenda.test.ts` (import relatively from `./agenda`). Cover:

- `generateSlotRows`: a def with `defaultCount: 3` yields 3 rows with
  `slotIndex` 0,1,2; `defaultCount: 0` yields none; multiple defs are flattened
  in order; empty input yields `[]`.
- `buildRoleCounts` + `slotLabel`: a role appearing once → label is the bare
  name; appearing 3× → "Name 1/2/3" using `slotIndex + 1`.
- `resolveEvaluatorLinks`: an evaluator row whose `evaluatesSlotId` points at a
  speaker row gets `evaluates` populated with that speaker's name/title; a row
  with `evaluatesSlotId: null` gets `evaluates: null`; a dangling id (no
  matching row) gets `evaluates: null`.

Model the file structure after a standard Vitest suite (`describe`/`it`/`expect`
from `vitest`).

**Verify**: `bunx vitest run src/lib/agenda.test.ts` → all pass (expect ~8–10
assertions across the three functions).

### Step 4: Replace the inlined logic with calls

In `src/server/meetings.ts`:
- Replace lines 193–199 (slot generation) with
  `const slotRows = generateSlotRows(defs, meeting.id);`
- Replace lines 96–111 (evaluator resolution) with
  `const slots = resolveEvaluatorLinks(rows);`
- Add `import { generateSlotRows, resolveEvaluatorLinks } from "#/lib/agenda";`

In `src/routes/_authed/meetings.$id.tsx`:
- Replace the `roleCounts` reducer and `slotLabel` function (lines 48–56) with
  `const roleCounts = buildRoleCounts(slots);` and call
  `slotLabel(slot, roleCounts)` at the existing call site (line ~140).
- Add `import { buildRoleCounts, slotLabel } from "#/lib/agenda";`

**Verify**: `bunx tsc --noEmit` → exit 0. `bun run check` → exit 0 (run
`bunx biome check --write` on the edited files first if formatting fails).

## Test plan

- New file `src/lib/agenda.test.ts` with the cases in Step 3.
- No existing test to model after (this is the first); use a standard Vitest
  `describe`/`it`/`expect` structure.
- Verification: `bunx vitest run` → all pass, ≥3 `describe` blocks.

## Done criteria

ALL must hold:

- [ ] `bunx vitest run` exits 0 with the new tests passing (≥8 assertions)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run check` exits 0
- [ ] `grep -n "flatMap" src/server/meetings.ts` returns nothing (slot gen moved out)
- [ ] `grep -n "bySlotId" src/server/meetings.ts` returns nothing (resolution moved out)
- [ ] `src/lib/agenda.ts` does NOT import `db`, `pg`, or anything under `#/db`
      (`grep -nE "db|pg|/db" src/lib/agenda.ts` → no import lines)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report (do not improvise) if:
- The "Current state" excerpts don't match the live code at the cited lines.
- `bunx vitest run` cannot be made to ignore the Start/Nitro plugins (Step 1
  verify fails) after one config fix attempt.
- Replacing the inlined logic changes any returned data shape (the `getMeeting`
  or `createMeeting` return type changes) — the refactor must be behavior-neutral.

## Maintenance notes

- `src/db/seed.ts:156-162` has a second copy of slot generation. A future
  cleanup should make it call `generateSlotRows`; deferred here to keep this
  plan a pure, low-risk refactor with no DB involvement.
- Plan 002 (integration tests) and plan 003 (timezone) both rely on the Vitest
  config created in Step 1 — if you change the alias scheme, update those plans.
- Reviewer should confirm the extracted functions are pure (no I/O) and that
  `meetings.$id.tsx` still numbers repeated roles identically.
