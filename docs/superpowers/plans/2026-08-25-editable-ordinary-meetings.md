# 622a — Editable Ordinary Meetings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an ordinary club meeting's agenda editable, by materialising the code-derived run of show into a private per-meeting template on first edit, with the printed sheet byte-identical on day one.

**Architecture:** A new pure module in `src/lib/` converts `buildRunOfShow(...)` output into `TemplateBeatSeed[]`, inserting five section bands and preserving detail tokens verbatim. Two things must exist before it can be faithful: `meeting_template_beats` gains a `handoff` column, and the template row builder learns to resolve detail tokens the way the standard path already does. The seam that today returns `null` for a template-less meeting instead materialises, once, inside a transaction.

**Tech Stack:** TypeScript strict, Drizzle ORM on Postgres (node-postgres), Vitest, Biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-club-owned-agendas.md` — read it alongside this plan. Decisions D1–D10 and review outcomes R1–R7 are referenced by number throughout.

## Global Constraints

- **Package manager is Bun.** `bun run test` (Vitest), never `bun test`. Single test: `bunx vitest run <path>`.
- **Integration suites silently SKIP without a database.** Export `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"` before running, or ~630 tests vanish and the pass count still reads green.
- **`bun run typecheck` is the only thing that type-checks.** Build and test both transpile without checking.
- **Read the lint gate with `bunx biome check --diagnostic-level=error`.** `seed.ts` carries ~118 pre-existing warnings that bury real errors. Run `bun run fix` to apply formatting; never `--unsafe`.
- **Biome formats with tabs and double quotes.** Import organization is on.
- **Import alias is `#/*` → `src/*`.**
- **Never hand-edit `src/routeTree.gen.ts`.** Running dev or build appends a footer to it; `git checkout --` it before committing.
- **Migrations:** edit `src/db/schema.ts`, then `bun run db:generate` + `bun run db:migrate`. Never `db:push` against the dev database. After a schema change, sync the test database: `DATABASE_URL=…tm_test bun run db:push --force`.
- **Server-fn modules export only `createServerFn`s and types.** Testable db logic goes in a sibling `*-logic.ts`; anything a unit test must reach goes in `src/lib/` with no `#/db` import.
- **`src/lib/` is db-free. Keep it that way** (R6) — a module importing `#/db` throws `DATABASE_URL is not set` in a unit test.
- **Caps** (`src/lib/meeting-template-limits.ts`): `MAX_TEMPLATE_BEATS` 200, `MAX_TEMPLATE_ROLES` 40, `MAX_ROLE_REPEAT_SLOTS` 20, `MAX_TEMPLATE_DETAIL_CHARS` 400, `MAX_TEMPLATE_LABEL_CHARS` (see file).
- **Never assert a cap relative to its own constant** (#519). `expect(x.length).toBeLessThanOrEqual(CAP)` passes for every value of CAP. Assert absolute numbers.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` (modify) | Add `handoff` boolean to `meetingTemplateBeats`, mirroring `flex` at :1083. |
| `drizzle/<generated>.sql` (create) | The generated migration. Do not hand-write. |
| `src/lib/agenda-runsheet.ts` (modify) | Export a detail-token resolver usable without a `Beat`; teach it the parameterised `{roles:<group>}` form. |
| `src/lib/agenda-template-rows.ts` (modify) | Carry `handoff` through; resolve detail tokens instead of passing them as plain text. |
| `src/lib/agenda-materialise.ts` (create) | **Pure.** `(beats, variant) → TemplateBeatSeed[]` — band insertion, token rewriting, handoff preservation. No `#/db`. |
| `src/lib/agenda-materialise.test.ts` (create) | Golden band tables, both variants, handoff counts, token preservation. |
| `src/server/meeting-agenda-edit-logic.ts` (modify) | Replace the `return null` at :166 with a materialise-then-load path, in a transaction. |
| `src/server/meeting-agenda-edit-logic.integration.test.ts` (modify) | Materialisation round trip, idempotence, cap refusal. |
| `src/server/recurrence-rule-logic.ts` (modify) | Correct the pristine predicate's comment (R2). Behaviour unchanged. |

Nine files, one of them generated. The materialiser is a separate module rather than a function inside `agenda-template-rows.ts` because it is the only piece that needs the `Beat` vocabulary, and keeping it apart stops `agenda-template-rows.ts` from importing the run-of-show builder.

---

## Task 1: `handoff` column

**Files:**
- Modify: `src/db/schema.ts:1083` (beside `flex`)
- Create: `drizzle/<generated>.sql`
- Test: `src/server/template-schema.integration.test.ts` (existing file, add a case)

**Interfaces:**
- Consumes: nothing.
- Produces: `meetingTemplateBeats.handoff` — `boolean("handoff").notNull().default(false)`. Tasks 3 and 4 read and write it.

- [ ] **Step 1: Write the failing test**

Append to `src/server/template-schema.integration.test.ts`:

```ts
it("carries handoff on a template beat, defaulting false", async () => {
	const { clubId, templateId } = await seedTemplate();
	const [row] = await testDb
		.insert(meetingTemplateBeats)
		.values({
			templateId,
			sortOrder: 0,
			kind: "role",
			label: "Introduces the speakers",
			minutes: 0,
		})
		.returning({ handoff: meetingTemplateBeats.handoff });
	expect(row?.handoff).toBe(false);

	const [flagged] = await testDb
		.insert(meetingTemplateBeats)
		.values({
			templateId,
			sortOrder: 1,
			kind: "role",
			label: "Introduces the Table Topics Master",
			minutes: 0,
			handoff: true,
		})
		.returning({ handoff: meetingTemplateBeats.handoff });
	expect(flagged?.handoff).toBe(true);
	await cleanup(clubId, []);
});
```

Match the file's existing seed/cleanup helpers — read the top of the file for their real names before writing, and reuse them rather than inlining inserts.

- [ ] **Step 2: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/template-schema.integration.test.ts -t "carries handoff"
```

Expected: FAIL — `column "handoff" does not exist`.

- [ ] **Step 3: Add the column**

In `src/db/schema.ts`, immediately after the `flex` line:

```ts
		flex: boolean("flex").notNull().default(false),
		/** Renders as the indented "X introduces Y" elbow and gets its own slide
		 *  in the projected deck. Carried so an adopted standard agenda keeps the
		 *  4 (or 5, on the GE variant) hand-offs the code path emits — without
		 *  this, adoption silently drops them. See spec D8. */
		handoff: boolean("handoff").notNull().default(false),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
bun run db:generate
bun run db:migrate
DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run db:push --force
```

Read the generated SQL before applying. It must be a single `ALTER TABLE ... ADD COLUMN "handoff" boolean DEFAULT false NOT NULL`. If it contains anything else, stop — the schema edit was wrong.

- [ ] **Step 5: Run the test and watch it pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/template-schema.integration.test.ts
```

Expected: PASS, and every pre-existing case in the file still passes.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/ src/server/template-schema.integration.test.ts
git commit -m "feat(agenda): carry handoff on a template beat"
```

---

## Task 2: A token resolver the template path can call

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (around `resolveDetail` at :1607, `DETAIL_TOKEN_RE` at :1580, `groupRoleNames` at :1489)
- Test: `src/lib/agenda-runsheet.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function resolveDetailTokens(
      detail: string,
      slots: AgendaSlot[],
      group: RoleGroup | null,
  ): string;
  ```
  Task 3 calls it. `group` supplies what a `Beat`'s `requiresGroup` supplies today; `null` means the `{roles}` list falls back to the same role-key filter the beat path uses.

  Also produces the parameterised token form `{roles:functionaries}` / `{roles:reportingFunctionaries}`, which Task 4 emits.

**Why this task exists:** `resolveDetail` is private, takes a `Beat`, and reaches `beat.requiresGroup` through `groupRoleNames`. A materialised template beat has no `Beat` and no gating fields (D1), so the template path cannot call it as-is. `RoleGroup` has exactly two values and only two beats carry one (`agenda-runsheet.ts:951` `functionaries`, `:1229` `reportingFunctionaries`), so parameterising the token is enough — no new column, and no gating resurrection.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-runsheet.test.ts`:

```ts
describe("resolveDetailTokens", () => {
	const slots: AgendaSlot[] = [
		{ ...baseSlot(), roleKey: "timer", roleName: "Timer", assigneeName: "Ada" },
		{
			...baseSlot(),
			roleKey: "grammarian",
			roleName: "Grammarian",
			assigneeName: "Bo",
		},
	];

	it("resolves {names:…} against the holders", () => {
		expect(resolveDetailTokens("Introduces {names:timer}", slots, null)).toBe(
			"Introduces — Ada",
		);
	});

	it("resolves the PARAMETERISED roles token from its own group", () => {
		// The template path has no Beat, so the group travels in the token.
		expect(
			resolveDetailTokens("Calls for the {roles:functionaries} to report", slots, null),
		).toBe("Calls for the Timer and Grammarian to report");
	});

	it("leaves an unknown role key verbatim rather than blanking the cue", () => {
		expect(resolveDetailTokens("Ask the {role:tymer}", slots, null)).toBe(
			"Ask the {role:tymer}",
		);
	});
});
```

`baseSlot()` is a helper in this file — read its real name and shape first and use it; do not invent a fixture. Fix the two expected strings to whatever `joinRoleNames` and `introducedSuffix` actually produce: run the test once, read the actual, and pin THAT. Do not adjust the implementation to match a guessed string.

- [ ] **Step 2: Run it and watch it fail**

```bash
bunx vitest run src/lib/agenda-runsheet.test.ts -t "resolveDetailTokens"
```

Expected: FAIL — `resolveDetailTokens is not exported`.

- [ ] **Step 3: Extend the token regex**

Replace `DETAIL_TOKEN_RE` at `src/lib/agenda-runsheet.ts:1580`:

```ts
const DETAIL_TOKEN_RE =
	/\{roles(?::([a-zA-Z]+))?\}|\{awards\}|\{role:([a-z_]+)\}|\{names:([a-z_]+)\}/g;
```

The group is optional so the bare `{roles}` the code path emits keeps working unchanged. Note the capture-group order shifted: the roles group is now group 1, and `roleKey`/`namesKey` move to 2 and 3. Every reader of this regex must be updated in the same step.

- [ ] **Step 4: Extract the resolver**

Rewrite `resolveDetail` as a thin wrapper over a new exported function, keeping its whole docblock (the single-pass and replacer-function reasoning is load-bearing and still true):

```ts
export function resolveDetailTokens(
	detail: string,
	slots: AgendaSlot[],
	group: RoleGroup | null,
): string {
	if (!detail.includes("{")) return detail;
	return detail.replace(
		DETAIL_TOKEN_RE,
		(whole, rolesGroup?: string, roleKey?: string, namesKey?: string) => {
			if (whole === AWARDS_TOKEN) return joinRoleNames(awardLabels(slots));
			if (whole.startsWith("{roles")) {
				// An explicit group in the token wins; otherwise fall back to the
				// caller's, which is how the Beat path supplies `requiresGroup`.
				const g = (rolesGroup ?? group) as RoleGroup | undefined;
				return joinRoleNames(
					g != null && g in GROUP_SLOTS
						? GROUP_SLOTS[g](slots).map((s) => s.roleName)
						: fallbackRoleNames(slots),
				);
			}
			if (namesKey != null) {
				const names = roleHolderNames(namesKey, slots);
				return names ?? whole;
			}
			if (roleKey != null) return resolveRoleName(roleKey, slots) ?? whole;
			return whole;
		},
	);
}

function resolveDetail(beat: Beat, slots: AgendaSlot[]): string {
	return resolveDetailTokens(beat.detail, slots, beat.requiresGroup ?? null);
}
```

Two things to reconcile against the real file rather than accepting the sketch: `groupRoleNames(beat, slots)` currently does the group lookup AND the `requiresAnyOf` fallback in one place — split it so the group half is reachable without a `Beat` (that is `fallbackRoleNames` above, which keeps the existing `requiresAnyOf`-less behaviour), and reuse the existing `{role:…}` resolution rather than inventing `resolveRoleName` if a helper already exists. Read `:1489–:1500` and `:1607–:1640` before writing.

- [ ] **Step 5: Run the whole run-sheet suite**

```bash
bunx vitest run src/lib/agenda-runsheet.test.ts src/lib/agenda-parity.test.ts
```

Expected: PASS, including every pre-existing token case. If a pre-existing case fails, the capture-group renumbering in Step 3 was applied incompletely.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(agenda): expose a detail-token resolver that needs no Beat"
```

---

## Task 3: The template path resolves tokens and carries handoff

**Files:**
- Modify: `src/lib/agenda-template-rows.ts` (`TemplateBeatSeed` at :49, the row builder at :180–:200)
- Test: `src/lib/agenda-template-rows.test.ts`

**Interfaces:**
- Consumes: `resolveDetailTokens(detail, slots, group)` from Task 2; `meetingTemplateBeats.handoff` from Task 1.
- Produces: `TemplateBeatSeed` gains `handoff: boolean`. `TemplateBeatRow` inherits it. `buildTemplateRows` output now carries `handoff` on the `AgendaRow` and a resolved `detail`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-template-rows.test.ts`:

```ts
it("resolves detail tokens instead of printing them", () => {
	const beats = withBeatIds([
		{
			sortOrder: 0,
			kind: "role" as const,
			label: "Toastmaster of the Day",
			detail: "Introduces the {role:table_topics_master}{names:table_topics_master}",
			minutes: 0,
			roleKey: "toastmaster",
			repeatsRoleKey: null,
			flex: false,
			handoff: true,
			markGreen: null,
			markYellow: null,
			markRed: null,
		},
	]);
	const rows = buildTemplateRows(beats, ROLES_FIXTURE, SLOTS_FIXTURE);
	// The token vocabulary is the same one the printed row already speaks;
	// storing it as plain text is what made an adopted agenda print `{names:…}`.
	expect(rows[0]?.detail).not.toContain("{");
	expect(rows[0]?.detail).toContain("Table Topics Master");
	expect(rows[0]?.handoff).toBe(true);
});
```

Reuse this file's existing role and slot fixtures — read the top of the file for their real names. `withBeatIds` is in `src/test/template-beat-ids.ts`.

- [ ] **Step 2: Run it and watch it fail**

```bash
bunx vitest run src/lib/agenda-template-rows.test.ts -t "resolves detail tokens"
```

Expected: FAIL — `detail` still contains `{`, and `handoff` is not a property.

- [ ] **Step 3: Add `handoff` to the seed type**

In `src/lib/agenda-template-rows.ts`, extend `TemplateBeatSeed` (:49):

```ts
	flex: boolean;
	handoff: boolean;
```

- [ ] **Step 4: Resolve the detail and carry the flag**

Replace the `detail` line in the row builder (:186) and extend `base`:

```ts
	const detail = resolveDetailTokens(
		capChars(row.detail ?? "", MAX_TEMPLATE_DETAIL_CHARS),
		bound,
		null,
	);
	const base = {
		detail,
		minutes: row.minutes,
		marks: resolveMarks(row),
		...(row.flex ? { flex: true as const } : {}),
		...(row.handoff ? { handoff: true as const } : {}),
	};
```

Cap BEFORE resolving, not after: the cap bounds what an officer can type, and resolution can legitimately expand a short token into a long list of names. Capping the resolved string would truncate holder names instead of the officer's input.

Pass `bound` (the row's slots), not the full slot array — read the surrounding function to confirm which variable holds the slots this row was bound to, and use that.

- [ ] **Step 5: Run it and watch it pass**

```bash
bunx vitest run src/lib/agenda-template-rows.test.ts
```

Expected: PASS. Pre-existing cases whose fixtures carry no tokens are unaffected because `resolveDetailTokens` returns early when there is no `{`.

- [ ] **Step 6: Typecheck, then fix every construction site**

```bash
bun run typecheck
```

`TemplateBeatSeed` gained a required field, so seed and test fixtures will fail to compile. Fix each by adding `handoff: false` — do NOT make the field optional to avoid the work. The compile errors are the list of places that must decide, and `src/db/seed-global-templates.ts` in particular must keep spreading the seed into `.values()` unchanged.

- [ ] **Step 7: Commit**

```bash
bun run fix
bunx biome check --diagnostic-level=error
git add src/lib/agenda-template-rows.ts src/lib/agenda-template-rows.test.ts src/db/
git commit -m "feat(agenda): template rows resolve detail tokens and carry handoff"
```

---

## Task 4: The materialiser

**Files:**
- Create: `src/lib/agenda-materialise.ts`
- Create: `src/lib/agenda-materialise.test.ts`

**Interfaces:**
- Consumes: `buildRunOfShow({ geIntroducesFunctionaries })` and `type Beat` from `#/lib/agenda-runsheet`; `type TemplateBeatSeed` from `#/lib/agenda-template-rows`.
- Produces:
  ```ts
  export function materialiseRunOfShow(
      geIntroducesFunctionaries: boolean,
  ): TemplateBeatSeed[];
  export const BAND_LABELS: readonly string[]; // the five, in order
  ```
  Task 5 calls `materialiseRunOfShow`.

**This is the task R5 was about.** Call `buildRunOfShow({ geIntroducesFunctionaries })` with the club's value. Do **not** import the `RUN_OF_SHOW` const — it is `buildRunOfShow({ geIntroducesFunctionaries: false })` frozen at `agenda-runsheet.ts:1333`, and using it silently gives every club the 22-beat variant.

- [ ] **Step 1: Write the failing test**

Create `src/lib/agenda-materialise.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BAND_LABELS, materialiseRunOfShow } from "./agenda-materialise";

/**
 * Boundaries are written as LITERALS, never imported from the module under
 * test. An assertion stated relative to the constant it guards passes for every
 * value of that constant, including one that reintroduces the bug (#519).
 * Measured from `buildRunOfShow` on 2026-08-25 — see the spec's D2 tables.
 */
const EXPECTED = {
	false: { beats: 22, handoffs: 4, bands: [0, 4, 7, 10, 18] },
	true: { beats: 23, handoffs: 5, bands: [0, 5, 8, 11, 19] },
} as const;

describe("materialiseRunOfShow", () => {
	for (const variant of [false, true] as const) {
		const want = EXPECTED[`${variant}`];

		it(`emits ${want.beats} beats plus 5 bands for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds).toHaveLength(want.beats + 5);
			expect(seeds.filter((s) => s.kind === "section")).toHaveLength(5);
		});

		it(`opens each band at the right beat for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			// Index of each section row, minus the sections already emitted before
			// it, is the index of the beat it precedes in the ORIGINAL list.
			const opens = seeds
				.map((s, i) => ({ s, i }))
				.filter(({ s }) => s.kind === "section")
				.map(({ i }, nth) => i - nth);
			expect(opens).toEqual(want.bands);
		});

		it(`preserves every hand-off for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds.filter((s) => s.handoff)).toHaveLength(want.handoffs);
		});

		it(`keeps detail tokens VERBATIM for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			const tokened = seeds.filter((s) => s.detail?.includes("{"));
			expect(tokened.length).toBeGreaterThan(0);
			// Resolution happens at render time, per row, against that meeting's
			// holders. Resolving here would freeze one evening's names into a
			// template reused every week.
			expect(seeds.some((s) => /\{names:[a-z_]+\}/.test(s.detail ?? ""))).toBe(
				true,
			);
		});

		it(`sortOrder is dense and ascending for geIntro=${variant}`, () => {
			const seeds = materialiseRunOfShow(variant);
			expect(seeds.map((s) => s.sortOrder)).toEqual(
				seeds.map((_, i) => i),
			);
		});
	}

	it("names the MCF variant's extra hand-off", () => {
		// The 23rd beat exists only on this variant. If materialiseRunOfShow ever
		// reads the RUN_OF_SHOW const instead of building for the club, this is
		// the assertion that fails (R5).
		const withGe = materialiseRunOfShow(true);
		const without = materialiseRunOfShow(false);
		expect(withGe.length - without.length).toBe(1);
		expect(withGe.filter((s) => s.handoff).length).toBe(
			without.filter((s) => s.handoff).length + 1,
		);
	});

	it("emits the five bands in order", () => {
		expect(BAND_LABELS).toEqual([
			"OPENING",
			"SPEECHES",
			"TABLE TOPICS",
			"EVALUATIONS",
			"CLOSING",
		]);
	});

	it("rewrites a bare {roles} token with its group", () => {
		// A materialised beat has no `requiresGroup` (D1 drops gating), so the
		// group has to travel in the token or the list cannot resolve later.
		const seeds = materialiseRunOfShow(true);
		const rolesTokens = seeds
			.map((s) => s.detail ?? "")
			.filter((d) => d.includes("{roles"));
		expect(rolesTokens.length).toBeGreaterThan(0);
		for (const d of rolesTokens) {
			expect(d).toMatch(/\{roles:(functionaries|reportingFunctionaries)\}/);
		}
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bunx vitest run src/lib/agenda-materialise.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the materialiser**

Create `src/lib/agenda-materialise.ts`:

```ts
// src/lib/agenda-materialise.ts
import {
	type Beat,
	buildRunOfShow,
	type RoleGroup,
} from "./agenda-runsheet";
import type { TemplateBeatSeed } from "./agenda-template-rows";

/**
 * Turn the code-derived run of show into rows a club can edit.
 *
 * ```
 * buildRunOfShow({ geIntroducesFunctionaries })   the CLUB's variant
 *         |  22 or 23 beats, gating still attached
 *         v
 *   drop the gating  <- D1: a row stays until deleted, so the gate is
 *         |              evaluated once, here, and never again
 *         v
 *   open five bands (D2)
 *         |  + 5 section rows
 *         v
 *   Beat -> TemplateBeatSeed
 *         |  detail tokens VERBATIM (D7), handoff carried (D8)
 *         v
 *   TemplateBeatSeed[]
 * ```
 *
 * Pure and `#/db`-free so the golden band tables above are reachable from
 * vitest (R6) — a `createServerFn` handler body is not.
 */

/** The five bands, in the order they open. Spec D2. */
export const BAND_LABELS = [
	"OPENING",
	"SPEECHES",
	"TABLE TOPICS",
	"EVALUATIONS",
	"CLOSING",
] as const;

/**
 * Which beat each band opens on, as a predicate over the ORIGINAL beat list.
 *
 * Stated structurally rather than by index because the two variants differ by
 * one beat: the GE opening pair shifts everything after it. Only five beats
 * carry a stable `id`, so most boundaries cannot be anchored on one — the
 * hand-off that introduces each segment is the reliable marker.
 */
function bandOpensAt(beats: Beat[]): number[] {
	const handoffs: number[] = [];
	beats.forEach((b, i) => {
		if (b.handoff === true) handoffs.push(i);
	});
	const evalIdx = beats.findIndex((b) => b.id === "geEvaluationHandoff");
	// OPENING starts the sheet. SPEECHES opens on the hand-off that introduces
	// the speakers, which is the LAST hand-off before Table Topics; TABLE TOPICS
	// on the next; EVALUATIONS on `geEvaluationHandoff` (the one boundary with a
	// stable id); CLOSING on the Toastmaster's awards beat, which is the first
	// beat after the general evaluation.
	const speeches = handoffs.find((i) => i > (beats.findIndex((b) => b.id === "geOpeningHandoff") ?? -1)) ?? 0;
	const tableTopics = handoffs.find((i) => i > speeches) ?? 0;
	const closing = beats.findIndex((b) => b.id === "generalEvaluation") + 1;
	return [0, speeches, tableTopics, evalIdx, closing];
}

export function materialiseRunOfShow(
	geIntroducesFunctionaries: boolean,
): TemplateBeatSeed[] {
	// NOT the `RUN_OF_SHOW` const — that is this call with the variant frozen
	// `false`, so using it gives every club the 22-beat sheet and silently drops
	// MCF's `geOpeningHandoff`. See R5.
	const beats = buildRunOfShow({ geIntroducesFunctionaries });
	const opensAt = bandOpensAt(beats);

	const out: TemplateBeatSeed[] = [];
	let band = 0;
	beats.forEach((beat, i) => {
		while (band < opensAt.length && opensAt[band] === i) {
			out.push(sectionSeed(BAND_LABELS[band] as string, out.length));
			band += 1;
		}
		out.push(beatSeed(beat, out.length));
	});
	return out;
}

function sectionSeed(label: string, sortOrder: number): TemplateBeatSeed {
	return {
		sortOrder,
		kind: "section",
		label,
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
	};
}

function beatSeed(beat: Beat, sortOrder: number): TemplateBeatSeed {
	const isRole = beat.kind === "role";
	return {
		sortOrder,
		kind: beat.kind,
		label: isRole ? beat.roleName : beat.who,
		detail: qualifyRolesToken(beat) || null,
		minutes: beat.minutes,
		roleKey: isRole ? beat.roleKey : null,
		// A speaker or evaluator beat fans out across every matching slot, which
		// is what `repeatsRoleKey` means in the template model. Without this a
		// three-speaker meeting materialises ONE speech row.
		repeatsRoleKey:
			isRole && (beat.role === "speaker" || beat.role === "evaluator")
				? beat.roleKey
				: null,
		flex: beat.flex === true,
		handoff: beat.handoff === true,
		markGreen: beat.marks?.green ?? null,
		markYellow: beat.marks?.yellow ?? null,
		markRed: beat.marks?.red ?? null,
	};
}

/**
 * Rewrite a bare `{roles}` into `{roles:<group>}`.
 *
 * The token resolves through the beat's `requiresGroup` today, and a
 * materialised row has no gating fields (D1). Putting the group INSIDE the
 * token keeps the list dynamic — it still resolves against whoever holds the
 * roles that week — without a column and without reviving the gate.
 */
function qualifyRolesToken(beat: Beat): string {
	const group: RoleGroup | undefined = beat.requiresGroup;
	if (group == null) return beat.detail;
	return beat.detail.replaceAll("{roles}", `{roles:${group}}`);
}
```

Two things to verify against the real source rather than trusting this sketch, both of which the tests will catch: `beat.flex` and `beat.marks` may not exist on every arm of the `Beat` union (read `:220–:252`), and `bandOpensAt`'s `speeches` derivation must produce the D2 tables — run the test and, if a boundary is off, fix the derivation, never the expected literals.

- [ ] **Step 4: Run the tests until the golden tables pass**

```bash
bunx vitest run src/lib/agenda-materialise.test.ts
```

Expected: PASS, all 13 cases. If a band boundary disagrees, print the beats and re-derive:

```bash
bun run --eval 'import("#/lib/agenda-runsheet").then(m=>m.buildRunOfShow({geIntroducesFunctionaries:true}).forEach((b,i)=>console.log(i,b.handoff?"HO":"  ",b.id??"-",b.minutes)))'
```

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
bun run fix
git add src/lib/agenda-materialise.ts src/lib/agenda-materialise.test.ts
git commit -m "feat(agenda): materialise the run of show into editable template rows"
```

---

## Task 5: Materialise on first edit

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts:166` and the `loadAgendaDraft` body
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: `materialiseRunOfShow(geIntroducesFunctionaries)` from Task 4.
- Produces: `loadAgendaDraft(meetingId)` returns a draft for a template-less meeting instead of `null`, having created and pointed the meeting at a private template.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/meeting-agenda-edit-logic.integration.test.ts`:

```ts
describe("materialise on first edit", () => {
	it("turns a standard meeting into an editable draft", async () => {
		const { clubId, meetingId } = await seedStandardMeeting();
		const draft = await loadAgendaDraft(meetingId);
		expect(draft).not.toBeNull();
		expect(draft?.rows.filter((r) => r.kind === "section")).toHaveLength(5);
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		expect(m?.templateId).not.toBeNull();
		await cleanup(clubId, []);
	});

	it("is IDEMPOTENT — a second load reuses the same template", async () => {
		const { clubId, meetingId } = await seedStandardMeeting();
		const first = await loadAgendaDraft(meetingId);
		const second = await loadAgendaDraft(meetingId);
		expect(second?.templateId).toBe(first?.templateId);
		// The row ids must be stable too: the editor keys React state and its
		// `confirmed` refs on them, so a second id set would look like every row
		// changed at once.
		expect(second?.rows.map((r) => r.id)).toEqual(first?.rows.map((r) => r.id));
		await cleanup(clubId, []);
	});

	it("uses the CLUB's GE variant, not the default", async () => {
		const { clubId, meetingId } = await seedStandardMeeting({
			geIntroducesFunctionaries: true,
		});
		const draft = await loadAgendaDraft(meetingId);
		// 23 beats + 5 bands on this variant; 22 + 5 on the other. Reading the
		// RUN_OF_SHOW const instead of building for the club fails here (R5).
		expect(draft?.rows).toHaveLength(28);
		await cleanup(clubId, []);
	});

	it("leaves an ALREADY-templated meeting alone", async () => {
		const { clubId, meetingId, templateId } = await seedContestMeeting();
		const draft = await loadAgendaDraft(meetingId);
		expect(draft?.templateId).toBe(templateId);
		await cleanup(clubId, []);
	});
});
```

`seedStandardMeeting` / `seedContestMeeting` / `cleanup` — read the top of this file and reuse whatever it already has, extending a helper rather than adding a parallel one. Per CLAUDE.md, give any seeded key a per-run suffix, track the ids you create, and delete only those.

- [ ] **Step 2: Run them and watch them fail**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts -t "materialise on first edit"
```

Expected: FAIL — `loadAgendaDraft` returns `null` for a standard meeting.

- [ ] **Step 3: Replace the early return**

At `src/server/meeting-agenda-edit-logic.ts:166`, replace:

```ts
	if (!meeting?.templateId) return null;
```

with:

```ts
	if (!meeting) return null;
	const templateId =
		meeting.templateId ??
		(await materialiseForMeeting(
			meetingId,
			meeting.clubId,
			meeting.geIntroducesFunctionaries,
		));
```

and add, in the same module:

```ts
/**
 * Build this meeting its own editable copy of the standard agenda, once.
 *
 * In a TRANSACTION with a re-read under lock: two officers opening the editor
 * at the same moment would otherwise both see a null `template_id` and mint two
 * private templates, and the loser's rows become orphans the UI never shows.
 */
async function materialiseForMeeting(
	meetingId: string,
	clubId: string,
	geIntroducesFunctionaries: boolean,
): Promise<string> {
	return await database.transaction(async (tx) => {
		const [locked] = await tx
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.for("update")
			.limit(1);
		if (locked?.templateId) return locked.templateId;

		const seeds = materialiseRunOfShow(geIntroducesFunctionaries);
		const [tpl] = await tx
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId,
				key: `meeting-${meetingId}`,
				name: "Standard meeting",
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("Failed to create the agenda copy.");

		await tx
			.insert(meetingTemplateBeats)
			.values(seeds.map((s) => ({ ...s, templateId: tpl.id })));
		await tx
			.update(meetings)
			.set({ templateId: tpl.id })
			.where(eq(meetings.id, meetingId));
		return tpl.id;
	});
}
```

Then replace every later use of `meeting.templateId` in this function with `templateId`.

Check two things against the real module before writing: whether `meeting.clubId` is already selected (the `.innerJoin(clubs, …)` at :163 suggests the columns are available, but confirm the select list), and whether the existing conversion path also materialises `role_definitions` against the copy — if it does, decide deliberately whether a standard-agenda copy needs them. It does **not**: the standard flow binds beats to the club's existing roles by key, and minting private role definitions would detach this meeting's slots from the club's roster. Write that reasoning into the comment.

- [ ] **Step 4: Run them and watch them pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts
```

Expected: PASS, and every pre-existing case in the file still passes.

- [ ] **Step 5: Verify day-one parity by hand, in a browser**

This is the release's whole promise and no unit test covers the rendered sheet.

```bash
DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_scheduler_dev" \
BETTER_AUTH_SECRET=dev BETTER_AUTH_URL=http://localhost:3000 ENABLE_DEV_LOGIN=1 \
bunx vite dev --port 3000
```

Open an ordinary MCF meeting's print view, screenshot it. Then open its agenda editor (which materialises), reload the print view, screenshot again. The two must be identical. If they differ, stop and fix the materialiser — do not proceed.

- [ ] **Step 6: Commit**

```bash
bun run typecheck
bun run fix
git checkout -- src/routeTree.gen.ts
git add src/server/meeting-agenda-edit-logic.ts src/server/meeting-agenda-edit-logic.integration.test.ts
git commit -m "feat(agenda): an ordinary meeting's agenda becomes editable on first edit"
```

---

## Task 6: Cap the source read, and correct the stale comment

**Files:**
- Modify: `src/server/meeting-agenda-edit-logic.ts` (`copyTemplateForMeeting`)
- Modify: `src/server/recurrence-rule-logic.ts:127–133`
- Test: `src/server/meeting-agenda-edit-logic.integration.test.ts`

**Interfaces:**
- Consumes: `MAX_TEMPLATE_BEATS` from `#/lib/meeting-template-limits`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
it("REFUSES to copy a template over the beat ceiling", async () => {
	const { clubId, templateId, meetingId } = await seedOversizeTemplate(
		MAX_TEMPLATE_BEATS + 1,
	);
	// Refuse, never truncate: a silently shortened agenda is a meeting that
	// runs off the end of its booking with nothing on the sheet to say so.
	await expect(copyTemplateForMeeting(meetingId, templateId)).rejects.toThrow(
		/too large/i,
	);
	await cleanup(clubId, []);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bunx vitest run src/server/meeting-agenda-edit-logic.integration.test.ts -t "REFUSES to copy"
```

Expected: FAIL — the copy succeeds.

- [ ] **Step 3: Cap the read**

In `copyTemplateForMeeting`, bound the source beat select with `.limit(MAX_TEMPLATE_BEATS + 1)` and refuse when the result exceeds the cap:

```ts
	if (sourceBeats.length > MAX_TEMPLATE_BEATS) {
		throw new Error(
			`That agenda is too large to copy (${MAX_TEMPLATE_BEATS} rows maximum).`,
		);
	}
```

Fetching one more than the cap is what makes the check possible without an unbounded read.

- [ ] **Step 4: Correct the pristine predicate's comment (R2)**

In `src/server/recurrence-rule-logic.ts`, replace the comment above `m.templateId === null`:

```ts
				// A meeting with a template is not an empty shell. Until #622 that
				// meant "somebody reshaped it into a contest"; it now ALSO means
				// "somebody edited its agenda", because the first edit of an
				// ordinary meeting materialises a private copy. Both are content,
				// and this predicate already declines to prune any meeting with
				// content (a theme, a Word of the Day, a claimed slot).
				// It also still cannot be deleted: `meeting_templates.meeting_id`
				// cascades from `meetings`, but materialized `role_definitions`
				// pointing at a private template are ON DELETE RESTRICT, so the
				// delete would throw. See TODOS "Agenda templates".
				m.templateId === null,
```

- [ ] **Step 5: Run the full suite**

```bash
CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell" \
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
```

Expected: every test passes. On Linux `CHROME_PATH` is unnecessary; on macOS the browser-backed print gates skip silently without it.

- [ ] **Step 6: Commit**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error
git add src/server/
git commit -m "fix(agenda): cap the template copy's source read; correct a stale pruner comment"
```

---

## Task 7: Prove day-one parity in a test, not just by eye

**Files:**
- Modify: `src/lib/agenda-parity.test.ts`
- Test: same file

**Interfaces:**
- Consumes: `materialiseRunOfShow` (Task 4), `buildTemplateRows` (Task 3), `expandRunSheet`.
- Produces: nothing.

**Why this is its own task:** Task 5's browser check is a human looking at two screenshots once. This is the assertion that keeps day-one parity true for every later change. A parity test alone cannot see a defect present on both sides, so this pins golden values as well.

- [ ] **Step 1: Write the failing test**

```ts
describe("adoption preserves the printed sheet", () => {
	for (const variant of [false, true] as const) {
		it(`materialised rows match the code path for geIntro=${variant}`, () => {
			const slots = STANDARD_SLOTS; // reuse this file's fixture
			const codeRows = expandRunSheet(
				buildRunOfShow({ geIntroducesFunctionaries: variant }),
				slots,
			);
			const seeds = materialiseRunOfShow(variant);
			const adopted = buildTemplateRows(
				withBeatIds(seeds),
				ROLES_FIXTURE,
				slots,
			).filter((r) => r.section !== true);

			expect(adopted.map((r) => r.who)).toEqual(codeRows.map((r) => r.who));
			expect(adopted.map((r) => r.detail)).toEqual(
				codeRows.map((r) => r.detail),
			);
			expect(adopted.map((r) => r.minutes)).toEqual(
				codeRows.map((r) => r.minutes),
			);
			expect(adopted.filter((r) => r.handoff)).toHaveLength(
				codeRows.filter((r) => r.handoff).length,
			);
		});
	}

	it("names a real holder after adoption, and follows a HOLDER CHANGE", () => {
		// A frozen name passes a same-fixture comparison. Changing the holder
		// between two renders is what proves the token stayed live.
		const seeds = withBeatIds(materialiseRunOfShow(true));
		const first = buildTemplateRows(seeds, ROLES_FIXTURE, slotsHeldBy("Ada"));
		const second = buildTemplateRows(seeds, ROLES_FIXTURE, slotsHeldBy("Bo"));
		expect(first.some((r) => r.detail?.includes("Ada"))).toBe(true);
		expect(second.some((r) => r.detail?.includes("Bo"))).toBe(true);
		expect(second.some((r) => r.detail?.includes("Ada"))).toBe(false);
	});
});
```

`slotsHeldBy(name)` does not exist — write it in this file as a small helper returning the standard slot set with the General Evaluator held by `name`. Reuse `STANDARD_SLOTS`/`ROLES_FIXTURE` under whatever names this file already uses.

- [ ] **Step 2: Run it and watch it fail**

```bash
bunx vitest run src/lib/agenda-parity.test.ts
```

Expected: FAIL until the materialiser is faithful.

- [ ] **Step 3: Fix the MATERIALISER, never the expectation**

Any mismatch is a materialiser bug. The one legitimate exception is row ORDER around bands, since `adopted` filters sections out — if the counts match but positions differ, check `bandOpensAt`.

- [ ] **Step 4: Run the geometry gates**

```bash
CHROME_PATH="…/chrome-headless-shell" bunx vitest run \
  src/components/agenda/print-page-count.test.tsx \
  src/components/agenda/print-density.test.tsx
```

Expected: PASS. These are the only gates that can see print layout, and adoption changes what prints.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-parity.test.ts
git commit -m "test(agenda): adoption preserves the printed sheet on both GE variants"
```

---

## Task 8: Say what adopting costs (R1)

**Files:**
- Modify: the agenda editor's empty/first-edit surface — find it with `grep -rn "Edit agenda" src/routes src/components`
- Create: `src/routes/agenda-adoption-notice.guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Why:** D2/R1 accepted that an adopted club stops receiving upstream agenda improvements — 15 of the last 27 commits to `agenda-runsheet.ts` changed beat content. That is only defensible if the officer is told.

- [ ] **Step 1: Write the failing guard**

```ts
// Route copy cannot be asserted by mounting — the route needs a router context
// and a mocked `#/db`. A comment-blind source guard is the reachable gate.
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = "src/routes/club.$clubId.meeting.$meetingId_.agenda.tsx";

describe("adoption notice", () => {
	it("tells the officer that upstream improvements stop arriving", () => {
		const src = readSource(ROUTE);
		expect(src).toMatch(/improvements .* will not reach/i);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bunx vitest run src/routes/agenda-adoption-notice.guard.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add the copy**

Render once, above the table, only when this meeting's template was materialised from the standard agenda:

> **This agenda is now yours.** Improvements we make to the standard agenda will not reach it — edit it here instead.

- [ ] **Step 4: Run it and watch it pass, then commit**

```bash
bunx vitest run src/routes/agenda-adoption-notice.guard.test.ts
bun run typecheck
git checkout -- src/routeTree.gen.ts
git add src/routes/
git commit -m "feat(agenda): say plainly that an adopted agenda stops receiving updates"
```

---

## Self-Review

**1. Spec coverage.** D1 → Task 4 (gating resolved once, dropped). D2 → Task 4. D3 → Task 5. D7 → Tasks 2 and 3. D8 → Tasks 1 and 3. D9 → this plan is 622a only. D10 → Task 6. R1 → Task 8. R2 → Task 6 step 4. R4 → deferred to the cap's calibration, noted below. R5 → Task 4 and its test. R6 → Task 4 (pure `src/lib/`, literal boundaries). R7 → **622b, not here.** D4, D5, D6 and R3 are all 622b.

**Gap found and accepted:** R4 says the cap ceiling must be measured after D7 lands. Task 6 caps at the existing `MAX_TEMPLATE_BEATS` rather than a freshly measured number — correct for 622a, because the write path already enforces that bound, so the read cap is closing a hole rather than choosing a new limit. Re-measuring belongs with 622b, where officer-authored templates first become copy sources.

**2. Placeholder scan.** No TBDs. Three places tell the implementer to read real source before writing (Task 2's `groupRoleNames` split, Task 4's `Beat` union arms, Task 5's select list) — these are verification instructions with the exact file and line to check, not deferred decisions. Every code step carries real code.

**3. Type consistency.** `TemplateBeatSeed` gains `handoff: boolean` in Task 3 and Task 4 constructs it — consistent. `resolveDetailTokens(detail, slots, group)` is defined in Task 2 and called in Task 3 with `(capped, bound, null)` — consistent. `materialiseRunOfShow(geIntroducesFunctionaries)` defined in Task 4, called in Tasks 5 and 7 — consistent. `BAND_LABELS` exported in Task 4, asserted in its own test only.

---

## NOT in scope

- **Everything in 622b** — save-as-club-template, `clubs.default_template_id`, `/club/$clubId/agendas`, and the D4/D5 notices. Separate plan, per D9.
- **`requireClubTemplateEditor`** (R3) — 622a's writes are all meeting-keyed and covered by the existing `requireMeetingTemplateEditor`.
- **The resync escape hatch** — TODOS:101, re-scoped to P2 by the eng review. Writable independently and would serve the existing contest case today.
- **Fixing the `role_definitions` FK** — TODOS:109's open design question. Not needed by anything here, and changing delete semantics inside a feature PR is how data-integrity regressions land.
- **An editor control for `handoff`** — the column is carried through adoption; exposing it is separate.
- **Re-measuring the cap ceiling** — see the self-review gap above.
