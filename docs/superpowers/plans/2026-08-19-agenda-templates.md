# Agenda Templates (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a club run a meeting with a different shape — starting with a speech contest — by giving a meeting an optional template that supplies its own claimable role set and its own run-of-show.

**Architecture:** `meetings.template_id` is nullable and NULL means the existing code path runs unchanged. Templates live in three new tables; their roles are materialized into `role_definitions` (because `role_slots.role_definition_id` is a `NOT NULL` restricting FK) and their run-of-show is a flat, ungated beat list adapted into the existing `Beat[]` type, so `expandRunSheet` and everything downstream of it stays untouched.

**Tech Stack:** TanStack Start (React 19, SSR via Nitro), Drizzle ORM on PostgreSQL via `node-postgres`, Vitest, Biome, Tailwind v4 + shadcn/ui, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-08-19-agenda-templates-design.md` — read it first. This plan implements it and argues from it; where they disagree, the spec wins and the plan is wrong.

## Landing shape — TWO PRs

Decided at eng review (2026-08-19). A single ~35-file diff is the size `/ship`'s review gate does not converge on (CLAUDE.md; it cost four rounds on #519).

- **PR 1 — Tasks 1-9, 11, 12, 13.** Schema through print, plus the officer picker and docs. A contest meeting can be created, converted, claimed and printed. `Present` is hidden for a templated meeting with a note saying the projected deck is coming.
- **PR 2 — Task 10.** The generic beat-driven deck. ~5 files.

The cut is at the deck because a contest chair runs the night off a printed script, so it is both the most separable piece and the least urgent one. Each PR is independently shippable and independently reviewable.

## Global Constraints

- Package manager is **Bun**. `bun run test` (Vitest, never `bun test`). Single test: `bunx vitest run <path>`.
- **`bun run typecheck` is the only thing that type-checks.** `bun run build` and `bun run test` both pass on type-broken code. Run it before claiming any task is green.
- **Integration suites silently SKIP without a database.** Export `TEST_DATABASE_URL` before running them or ~630 tests vanish and the run still reads green. On this Mac the test DB is on **port 5433**: `TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"`.
- After any schema change, sync the test DB: `DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bun run db:push --force`. That is the one database `db:push` is for. Never `db:push` the dev DB — use `db:generate` + `db:migrate`.
- **Print tests need Chrome.** On macOS set `CHROME_PATH` to a Playwright `chrome-headless-shell` — never `/Applications/Google Chrome.app/...`, which is found but never returns from `--print-to-pdf` and turns an honest skip into a 135s `ETIMEDOUT`.
- Biome formats with **tabs** and **double quotes**, import organization on. `bun run fix` applies auto-fixes; read the gate with `bunx biome check --diagnostic-level=error` because `seed.ts` emits ~118 pre-existing warnings that bury real errors. Run the gate **last**, before commit.
- Import alias is `#/*` → `src/*`.
- **Server-module rule:** a `src/server/*.ts` module that defines a `createServerFn` exports ONLY `createServerFn`s and types. All db logic goes in a sibling `*-logic.ts`. `server-modules.guard.test.ts` enforces this.
- Never hand-edit `src/routeTree.gen.ts`.
- Do not add dependencies.
- Copy rule from the spec (D7): seeded contest segment labels are **"Prepared Speech Contest"**, **"Impromptu Speaking Contest"**, **"Speech Evaluation Contest"** — not the Toastmasters International marks.
- Work happens in the worktree at `.claude/worktrees/agenda-templates` on branch `worktree-agenda-templates`. Never edit the main checkout.

---

### Task 1: Schema — three template tables and two columns

**Files:**
- Modify: `src/db/schema.ts` (append after the `roleDefinitions` / `roleSlots` block, ~line 900)
- Modify: `src/db/schema.ts:825-833` (the `role_definitions` index array)
- Create: `drizzle/<generated>.sql` (via `bun run db:generate`)
- Test: `src/db/template-schema.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: drizzle tables `meetingTemplates`, `meetingTemplateRoles`, `meetingTemplateBeats`; enum `templateBeatKindEnum`; new columns `meetings.templateId`, `roleDefinitions.templateId`.

- [ ] **Step 1: Write the failing test**

Create `src/db/template-schema.integration.test.ts`:

```ts
/**
 * DB-backed tests for the agenda-template schema (#agenda-templates).
 * Proves the two partial unique indexes on `role_definitions` behave as
 * designed: the pre-existing one-standard-role-per-key guarantee survives the
 * addition of `template_id`, and template roles are constrained per template.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/db/template-schema.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb())("agenda template schema", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(cleanup);

	async function makeTemplate(key: string, clubId: string | null = null) {
		const [row] = await testDb
			.insert(meetingTemplates)
			.values({ clubId, key, name: `Template ${key}` })
			.returning({ id: meetingTemplates.id });
		if (!row) throw new Error("insert failed");
		return row.id;
	}

	it("still rejects two standard role definitions sharing a key", async () => {
		await expect(
			testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				name: "Second Timer",
				category: "functionary",
				key: "timer",
				templateId: null,
			}),
		).rejects.toThrow();
	});

	it("allows a template role to reuse a standard key", async () => {
		const templateId = await makeTemplate("speech_contest");
		await testDb.insert(roleDefinitions).values({
			clubId: club.clubId,
			name: "Contest Timer",
			category: "functionary",
			key: "timer",
			templateId,
		});
		const rows = await testDb.select().from(roleDefinitions);
		expect(rows.filter((r) => r.key === "timer")).toHaveLength(2);
	});

	it("rejects two roles sharing a key within one template", async () => {
		const templateId = await makeTemplate("speech_contest");
		await testDb.insert(roleDefinitions).values({
			clubId: club.clubId,
			name: "Contest Timer",
			category: "functionary",
			key: "timer",
			templateId,
		});
		await expect(
			testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				name: "Another Contest Timer",
				category: "functionary",
				key: "timer",
				templateId,
			}),
		).rejects.toThrow();
	});

	it("rejects two global templates sharing a key", async () => {
		await makeTemplate("speech_contest");
		await expect(makeTemplate("speech_contest")).rejects.toThrow();
	});

	it("allows a club template to reuse a global template key", async () => {
		await makeTemplate("speech_contest");
		const id = await makeTemplate("speech_contest", club.clubId);
		expect(id).toBeTruthy();
	});

	it("cascades roles and beats when a template is deleted", async () => {
		const templateId = await makeTemplate("throwaway");
		await testDb.insert(meetingTemplateRoles).values({
			templateId,
			key: "chair",
			name: "Chair",
			category: "leadership",
		});
		await testDb.insert(meetingTemplateBeats).values({
			templateId,
			sortOrder: 0,
			kind: "event",
			label: "Call to order",
			minutes: 2,
		});
		await testDb.delete(meetingTemplates);
		expect(await testDb.select().from(meetingTemplateRoles)).toHaveLength(0);
		expect(await testDb.select().from(meetingTemplateBeats)).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/db/template-schema.integration.test.ts
```

Expected: FAIL — `meetingTemplates` is not exported from `#/db/schema`.

- [ ] **Step 3: Add the enum and three tables to `src/db/schema.ts`**

Add the enum beside the other `pgEnum` declarations near `roleCategoryEnum` (~line 76):

```ts
export const templateBeatKindEnum = pgEnum("template_beat_kind", [
	"section",
	"role",
	"event",
]);
```

Append after the `roleSlots` block:

```ts
// ---------------------------------------------------------------------------
// Meeting templates — a named bundle of a role set plus a run-of-show, for a
// meeting whose SHAPE differs from the club's standard night (a speech
// contest). `meetings.template_id` NULL is the standard meeting and runs the
// code-derived `RUN_OF_SHOW` (src/lib/agenda-runsheet.ts) exactly as before;
// only a templated meeting reads these tables. See
// docs/superpowers/specs/2026-08-19-agenda-templates-design.md.
// ---------------------------------------------------------------------------

export const meetingTemplates = pgTable(
	"meeting_templates",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// NULL = a GLOBAL template available to every club. Non-null = owned by
		// that club (Phase 2 — nothing writes club-scoped rows yet).
		clubId: uuid("club_id").references(() => clubs.id, {
			onDelete: "cascade",
		}),
		// Stable identity, e.g. "speech_contest" — what the seed is idempotent on.
		key: text("key").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		// Applied to `meetings.length_minutes` on conversion when set; NULL leaves
		// the meeting's existing length alone.
		defaultLengthMinutes: integer("default_length_minutes"),
		sortOrder: integer("sort_order").notNull().default(0),
		// Disable, never delete — a past meeting references its template and
		// `meetings.template_id` is ON DELETE RESTRICT. Mirrors
		// `role_definitions.enabled`.
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(t) => [
		// TWO partial indexes rather than one on (club_id, key): Postgres treats
		// NULLs as distinct, so a single index would let two GLOBAL templates
		// share a key. Same reasoning as the role_definitions pair below.
		uniqueIndex("meeting_templates_global_key_unique")
			.on(t.key)
			.where(sql`${t.clubId} is null`),
		uniqueIndex("meeting_templates_club_key_unique")
			.on(t.clubId, t.key)
			.where(sql`${t.clubId} is not null`),
	],
);

// The template's own role set. Deliberately the same shape as `RoleSeed`
// (src/lib/role-template.ts) so materializing into `role_definitions` is a
// field-for-field copy.
export const meetingTemplateRoles = pgTable(
	"meeting_template_roles",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => meetingTemplates.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		category: roleCategoryEnum("category").notNull(),
		defaultCount: integer("default_count").notNull().default(1),
		sortOrder: integer("sort_order").notNull().default(0),
		isSpeakerRole: boolean("is_speaker_role").notNull().default(false),
		description: text("description"),
	},
	(t) => [uniqueIndex("meeting_template_roles_key_unique").on(t.templateId, t.key)],
);

// The template's FLAT run-of-show. No `requiresAnyOf` / `requiresGroup` /
// `fallbacks` — a contest's shape is fixed by the contest rules and does not
// adapt to which roles a club runs, which is the whole reason the standard
// run-of-show needs those gates and this does not (spec D1).
export const meetingTemplateBeats = pgTable(
	"meeting_template_beats",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		templateId: uuid("template_id")
			.notNull()
			.references(() => meetingTemplates.id, { onDelete: "cascade" }),
		sortOrder: integer("sort_order").notNull(),
		kind: templateBeatKindEnum("kind").notNull(),
		// The activity ("Contest Briefing") or, for kind='section', the band title.
		label: text("label").notNull(),
		detail: text("detail"),
		minutes: integer("minutes").notNull().default(0),
		// Binds to `meeting_template_roles.key` — whose name renders as the
		// presenter. NULL for an event/section beat nobody owns.
		roleKey: text("role_key"),
		// Consecutive beats sharing a non-null value form ONE block emitted once
		// per slot of that role, so [Contestant N][Minute of silence] adapts to
		// however many contestants signed up (spec D4).
		repeatsRoleKey: text("repeats_role_key"),
		// The single squishy beat, if the template has one. At most one per
		// template — validated on write, not enforced by the database.
		flex: boolean("flex").notNull().default(false),
		// Timer-card marks in minutes, all three or none. `real`, not `numeric`:
		// drizzle's `numeric` returns a STRING unless a mode flag converts it, and
		// this schema uses `numeric` nowhere (35 tables, zero uses) so there is no
		// precedent to copy. Marks need fractions — EVALUATION_MARKS is
		// { green: 2, yellow: 2.5, red: 3 } — so `integer` will not do, and float
		// imprecision is irrelevant against a card a human holds up.
		markGreen: real("mark_green"),
		markYellow: real("mark_yellow"),
		markRed: real("mark_red"),
	},
	(t) => [
		uniqueIndex("meeting_template_beats_order_unique").on(t.templateId, t.sortOrder),
	],
);
```

Add `real` to the `drizzle-orm/pg-core` import at the top of the file if it is not already there.

- [ ] **Step 4: Add the two columns and split the `role_definitions` index**

In `roleDefinitions`' column block, after `key`:

```ts
		// The template that owns this role definition, NULL for the club's own
		// standard roles (every row before agenda templates existed). Standard
		// slot generation and /admin/roles both filter on `template_id IS NULL`,
		// so a template's roles never leak into the club's role editor or onto a
		// normal meeting. ON DELETE RESTRICT: a template with materialized roles
		// cannot be deleted out from under the slots referencing them.
		templateId: uuid("template_id").references(
			(): AnyPgColumn => meetingTemplates.id,
			{ onDelete: "restrict" },
		),
```

Replace the single index in `roleDefinitions`' index array with the pair:

```ts
		// TWO partial indexes, not one widened to (club_id, template_id, key).
		// Postgres treats NULLs as distinct, so folding template_id into a single
		// index would leave every STANDARD role (template_id IS NULL)
		// unconstrained — a club could then hold two standard Timers and nothing
		// would fail. Splitting keeps the original guarantee verbatim and adds
		// the same guarantee per template. See spec D3.
		uniqueIndex("role_definitions_club_key_unique")
			.on(t.clubId, t.key)
			.where(sql`${t.key} is not null and ${t.templateId} is null`),
		uniqueIndex("role_definitions_club_template_key_unique")
			.on(t.clubId, t.templateId, t.key)
			.where(sql`${t.key} is not null and ${t.templateId} is not null`),
```

In `meetings`' column block, after `meetingNumber`:

```ts
		// The template this meeting's shape comes from (#agenda-templates). NULL
		// — the overwhelming majority — is the standard meeting and reads the
		// code-derived RUN_OF_SHOW, unchanged. ON DELETE RESTRICT so a template a
		// past meeting was run from can never be deleted; disable it instead.
		templateId: uuid("template_id").references(
			(): AnyPgColumn => meetingTemplates.id,
			{ onDelete: "restrict" },
		),
```

`meetings` is declared before `meetingTemplates`, so both self-references use the `AnyPgColumn` lazy form already used by `roleSlots.evaluatesSlotId`.

- [ ] **Step 5: Generate the migration and sync both databases**

```bash
bun run db:generate
bun run db:migrate
DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bun run db:push --force
```

Read the generated SQL and confirm it drops `role_definitions_club_key_unique` and creates both replacements. If drizzle emits a bare `DROP INDEX` with no recreate, fix the schema and regenerate — do not hand-edit the migration.

- [ ] **Step 6: Run test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/db/template-schema.integration.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add src/db/schema.ts drizzle/ src/db/template-schema.integration.test.ts
git commit -m "feat(schema): meeting template tables, and split the role_definitions unique index"
```

---

### Task 2: Template limits — absolute ceilings in `lib/`

**Files:**
- Create: `src/lib/meeting-template-limits.ts`
- Test: `src/lib/meeting-template-limits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_TEMPLATE_BEATS = 200`, `MAX_TEMPLATE_ROLES = 40`, `MAX_TEMPLATE_LABEL_CHARS = 120`, `MAX_TEMPLATE_DETAIL_CHARS = 400`, `MAX_ROLE_REPEAT_SLOTS = 20`.

These live in `src/lib/` and not in the logic module **because a module that imports `#/db` throws `DATABASE_URL is not set` in a unit test, which makes its constants unassertable** — the caps could then be raised to 5,000,000 with the whole suite green. That has happened twice in this repo (#519, #522).

- [ ] **Step 1: Write the failing test**

Create `src/lib/meeting-template-limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "./meeting-template-limits";

// ABSOLUTE ceilings, never stated relative to the constant under test:
// `expect(x).toBeLessThanOrEqual(MAX)` passes for every value of MAX,
// including one that reintroduces the bug it was written to stop.
describe("meeting template limits", () => {
	it("caps beats far below the cost knee", () => {
		expect(MAX_TEMPLATE_BEATS).toBe(200);
	});
	it("caps roles per template", () => {
		expect(MAX_TEMPLATE_ROLES).toBe(40);
	});
	it("caps the repeat expansion", () => {
		expect(MAX_ROLE_REPEAT_SLOTS).toBe(20);
	});
	it("caps rendered strings", () => {
		expect(MAX_TEMPLATE_LABEL_CHARS).toBe(120);
		expect(MAX_TEMPLATE_DETAIL_CHARS).toBe(400);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/meeting-template-limits.test.ts
```

Expected: FAIL — cannot resolve `./meeting-template-limits`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/meeting-template-limits.ts`:

```ts
/**
 * Absolute ceilings on a meeting template's size, kept in `lib/` so a unit test
 * can import them without a database. A constant defined in a module that
 * imports `#/db` at load throws `DATABASE_URL is not set` under vitest, which
 * makes it unassertable — the number could be raised arbitrarily with the whole
 * suite green (#519, #522). The renderer imports these; it does not define them.
 *
 * HONESTY NOTE: these are BOUNDS, not measurements. The contest seed is ~30
 * beats and 8 roles, so each ceiling leaves generous headroom while staying far
 * below any plausible cost knee — but nobody has run the curve. Phase 1's only
 * writer is the seed, so the caps are a corruption guard rather than a DoS
 * control. BEFORE Phase 2 exposes a template editor to officers, measure the
 * render cost the way #519 did (500 and 5,000 chars both rendered in 39ms;
 * 49,999 took 3,707ms) and reset these numbers to sit well below the knee.
 * Do not let this comment claim a measurement that has not happened.
 */

/** Ordered rows one template may declare, BEFORE repeat expansion. */
export const MAX_TEMPLATE_BEATS = 200;

/** Distinct roles one template may declare. */
export const MAX_TEMPLATE_ROLES = 40;

/** Slots one `repeatsRoleKey` block may expand over. Bounds the expansion
 *  separately from the beat count: 200 beats each repeating over an unbounded
 *  role would multiply out even though every stored row was within its cap. */
export const MAX_ROLE_REPEAT_SLOTS = 20;

/** Characters in a beat's `label`. */
export const MAX_TEMPLATE_LABEL_CHARS = 120;

/** Characters in a beat's `detail`. */
export const MAX_TEMPLATE_DETAIL_CHARS = 400;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bunx vitest run src/lib/meeting-template-limits.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/meeting-template-limits.ts src/lib/meeting-template-limits.test.ts
git commit -m "feat(templates): absolute size ceilings, in lib so they are assertable"
```

---

### Task 3: The beat adapter — stored rows to `Beat[]`

**Files:**
- Create: `src/lib/agenda-template-beats.ts`
- Test: `src/lib/agenda-template-beats.test.ts`

**Interfaces:**
- Consumes: `Beat`, `AgendaSlot`, `TimingMarks` from `#/lib/agenda-runsheet`; the caps from Task 2.
- Produces:
  - `type TemplateBeatRow = { sortOrder: number; kind: "section" | "role" | "event"; label: string; detail: string | null; minutes: number; roleKey: string | null; repeatsRoleKey: string | null; flex: boolean; markGreen: number | null; markYellow: number | null; markRed: number | null }`
  - `type TemplateRoleRow = { key: string; name: string; isSpeakerRole: boolean }`
  - `function templateBeatsToRunOfShow(beats: TemplateBeatRow[], roles: TemplateRoleRow[], slots: AgendaSlot[]): Beat[]`
  - `const SECTION_ROLE_KEY = "__section__"`

This is a pure function with no database access, which is what makes the whole shape testable.

- [ ] **Step 1: Write the failing test**

Create `src/lib/agenda-template-beats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "./agenda-runsheet";
import {
	SECTION_ROLE_KEY,
	type TemplateBeatRow,
	type TemplateRoleRow,
	templateBeatsToRunOfShow,
} from "./agenda-template-beats";

const ROLES: TemplateRoleRow[] = [
	{ key: "contest_chair", name: "Contest Chair", isSpeakerRole: false },
	{ key: "contestant", name: "Contestant", isSpeakerRole: true },
];

function beat(over: Partial<TemplateBeatRow> & { sortOrder: number }): TemplateBeatRow {
	return {
		kind: "event",
		label: "Beat",
		detail: null,
		minutes: 1,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		...over,
	};
}

function slot(roleKey: string, roleName: string, slotIndex: number): AgendaSlot {
	return {
		id: `${roleKey}-${slotIndex}`,
		roleName,
		roleKey,
		category: roleKey === "contestant" ? "speaker" : "leadership",
		isSpeakerRole: roleKey === "contestant",
		slotIndex,
		assigneeName: null,
		speechTitle: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		evaluatesSlotId: null,
		evaluates: null,
	};
}

describe("templateBeatsToRunOfShow", () => {
	it("maps an event beat to an event beat", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "event", label: "Call to order", minutes: 2 })],
			ROLES,
			[],
		);
		expect(out).toEqual([
			{ kind: "event", who: "Call to order", detail: "", minutes: 2 },
		]);
	});

	it("maps a role beat to an ungated role beat that renders unowned", () => {
		const out = templateBeatsToRunOfShow(
			[
				beat({
					sortOrder: 0,
					kind: "role",
					label: "Opening Remarks",
					detail: "Welcome the room",
					minutes: 5,
					roleKey: "contest_chair",
				}),
			],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0)],
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			kind: "role",
			roleKey: "contest_chair",
			roleName: "Contest Chair",
			role: "plain",
			detail: "Welcome the room",
			minutes: 5,
			renderUnowned: true,
		});
		// The gates the standard run-of-show needs must NOT be emitted here.
		expect(out[0]).not.toHaveProperty("requiresAnyOf");
		expect(out[0]).not.toHaveProperty("requiresGroup");
		expect(out[0]).not.toHaveProperty("fallbacks");
	});

	it("marks a speaker-role beat as a speaker beat", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Speech", roleKey: "contestant" })],
			ROLES,
			[slot("contestant", "Contestant", 0)],
		);
		expect(out[0]).toMatchObject({ role: "speaker" });
	});

	it("emits a section as an ownerless band beat", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "section", label: "PREPARED SPEECH CONTEST", minutes: 0 })],
			ROLES,
			[],
		);
		expect(out[0]).toMatchObject({
			kind: "role",
			roleKey: SECTION_ROLE_KEY,
			roleName: "PREPARED SPEECH CONTEST",
			minutes: 0,
			renderUnowned: true,
			handoff: true,
		});
	});

	it("repeats a block once per slot of the repeated role", () => {
		const beats = [
			beat({
				sortOrder: 0,
				kind: "role",
				label: "Contestant",
				minutes: 7,
				roleKey: "contestant",
				repeatsRoleKey: "contestant",
			}),
			beat({
				sortOrder: 1,
				kind: "event",
				label: "Minute of silence",
				minutes: 1,
				repeatsRoleKey: "contestant",
			}),
		];
		const slots = [0, 1, 2].map((i) => slot("contestant", "Contestant", i));
		const out = templateBeatsToRunOfShow(beats, ROLES, slots);
		expect(out).toHaveLength(6);
		expect(out.map((b) => ("who" in b ? b.who : b.roleName))).toEqual([
			"Contestant",
			"Minute of silence",
			"Contestant",
			"Minute of silence",
			"Contestant",
			"Minute of silence",
		]);
	});

	it("emits nothing for a repeat block whose role has no slots", () => {
		const beats = [
			beat({ sortOrder: 0, kind: "role", label: "Contestant", roleKey: "contestant", repeatsRoleKey: "contestant" }),
			beat({ sortOrder: 1, kind: "event", label: "Minute of silence", repeatsRoleKey: "contestant" }),
			beat({ sortOrder: 2, kind: "event", label: "Results" }),
		];
		const out = templateBeatsToRunOfShow(beats, ROLES, []);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ who: "Results" });
	});

	it("splits two adjacent repeat blocks that name different roles", () => {
		const roles: TemplateRoleRow[] = [
			...ROLES,
			{ key: "evaluator", name: "Evaluation Contestant", isSpeakerRole: false },
		];
		const beats = [
			beat({ sortOrder: 0, kind: "role", label: "Contestant", roleKey: "contestant", repeatsRoleKey: "contestant" }),
			beat({ sortOrder: 1, kind: "role", label: "Evaluator", roleKey: "evaluator", repeatsRoleKey: "evaluator" }),
		];
		const slots = [
			slot("contestant", "Contestant", 0),
			slot("contestant", "Contestant", 1),
			slot("evaluator", "Evaluation Contestant", 0),
		];
		const out = templateBeatsToRunOfShow(beats, roles, slots);
		expect(out).toHaveLength(3);
	});

	it("carries timer marks only when all three are present", () => {
		const withMarks = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Speech", roleKey: "contestant", markGreen: 5, markYellow: 6, markRed: 7 })],
			ROLES,
			[slot("contestant", "Contestant", 0)],
		);
		expect(withMarks[0]).toMatchObject({ marks: { green: 5, yellow: 6, red: 7 } });

		const partial = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Speech", roleKey: "contestant", markGreen: 5, markYellow: null, markRed: 7 })],
			ROLES,
			[slot("contestant", "Contestant", 0)],
		);
		expect(partial[0]).not.toHaveProperty("marks");
	});

	it("orders by sortOrder regardless of input order", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 2, label: "third" }), beat({ sortOrder: 0, label: "first" }), beat({ sortOrder: 1, label: "second" })],
			ROLES,
			[],
		);
		expect(out.map((b) => ("who" in b ? b.who : ""))).toEqual(["first", "second", "third"]);
	});

	it("caps the repeat expansion", () => {
		const beats = [
			beat({ sortOrder: 0, kind: "role", label: "Contestant", roleKey: "contestant", repeatsRoleKey: "contestant" }),
		];
		const slots = Array.from({ length: 50 }, (_, i) => slot("contestant", "Contestant", i));
		const out = templateBeatsToRunOfShow(beats, ROLES, slots);
		expect(out).toHaveLength(20);
	});

	it("truncates an oversized label and detail", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "event", label: "x".repeat(500), detail: "y".repeat(2000) })],
			ROLES,
			[],
		);
		const row = out[0];
		if (!row || row.kind !== "event") throw new Error("expected an event beat");
		expect(row.who).toHaveLength(120);
		expect(row.detail).toHaveLength(400);
	});

	it("carries flex through to the beat", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Table Topics", roleKey: "contest_chair", flex: true })],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0)],
		);
		expect(out[0]).toMatchObject({ flex: true });
	});

	it("omits flex when the row does not set it", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Speech", roleKey: "contest_chair" })],
			ROLES,
			[slot("contest_chair", "Contest Chair", 0)],
		);
		expect(out[0]).not.toHaveProperty("flex");
	});

	it("drops a role beat whose roleKey names no template role", () => {
		const out = templateBeatsToRunOfShow(
			[beat({ sortOrder: 0, kind: "role", label: "Ghost", roleKey: "nope" })],
			ROLES,
			[],
		);
		expect(out).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/agenda-template-beats.test.ts
```

Expected: FAIL — cannot resolve `./agenda-template-beats`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/agenda-template-beats.ts`:

```ts
/**
 * Adapts a template's STORED run-of-show rows into the `Beat[]` the existing
 * `expandRunSheet` already consumes, so a templated meeting and a standard one
 * render through one pipeline and cannot silently diverge.
 *
 * The emitted beats are deliberately UNGATED — no `requiresAnyOf`,
 * `requiresGroup`, `fallbacks` or tokens. The standard run-of-show needs those
 * because it must adapt to whichever roles a club actually runs; a contest's
 * shape is fixed by the contest rules and does not adapt. See spec D1.
 *
 * Pure: no database access, so every branch here is reachable from a unit test.
 */
import type { AgendaSlot, Beat, TimingMarks } from "./agenda-runsheet";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "./meeting-template-limits";

/** One stored row of `meeting_template_beats`. */
export type TemplateBeatRow = {
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	flex: boolean;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

/** What the adapter needs from `meeting_template_roles`. */
export type TemplateRoleRow = {
	key: string;
	name: string;
	isSpeakerRole: boolean;
};

/**
 * The synthetic role key a section band carries. A section is not a role, but
 * `AgendaRow.roleKey` is how the print layouts colour a row's spine (#445), so
 * every row needs one and sections need one that can never collide with a real
 * `role_definitions.key`. The double underscores make that structural rather
 * than a naming convention someone could accidentally reuse.
 */
export const SECTION_ROLE_KEY = "__section__";

/** Cap by CODE POINTS, not UTF-16 units: slicing a surrogate pair in half
 *  yields a lone surrogate that renders as a replacement glyph and makes
 *  `encodeURIComponent` throw for any consumer building a URL from it. */
function capChars(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : points.slice(0, max).join("");
}

/** All three marks or none — a beat with a green and a red but no yellow would
 *  print a timer card with a hole in it. */
function resolveMarks(row: TemplateBeatRow): TimingMarks | undefined {
	const { markGreen, markYellow, markRed } = row;
	if (markGreen == null || markYellow == null || markRed == null) return undefined;
	return { green: markGreen, yellow: markYellow, red: markRed };
}

/** Slots belonging to a template role, in slot order. */
function slotsForRole(slots: AgendaSlot[], roleKey: string): AgendaSlot[] {
	return slots
		.filter((s) => s.roleKey === roleKey)
		.sort((a, b) => a.slotIndex - b.slotIndex);
}

function toBeat(
	row: TemplateBeatRow,
	rolesByKey: Map<string, TemplateRoleRow>,
): Beat | null {
	const label = capChars(row.label, MAX_TEMPLATE_LABEL_CHARS);
	const detail = capChars(row.detail ?? "", MAX_TEMPLATE_DETAIL_CHARS);

	if (row.kind === "section") {
		// A band, not a presenter: `handoff` is what the print layouts and
		// `groupByPresenter` already use for a full-width row carrying no clock
		// stamp, and a section is exactly that shape.
		return {
			kind: "role",
			roleKey: SECTION_ROLE_KEY,
			roleName: label,
			role: "plain",
			detail,
			minutes: row.minutes,
			renderUnowned: true,
			handoff: true,
		};
	}

	if (row.kind === "event") {
		return { kind: "event", who: label, detail, minutes: row.minutes };
	}

	// kind === "role"
	if (row.roleKey == null) return null;
	const role = rolesByKey.get(row.roleKey);
	// A beat naming a role the template does not declare is dropped rather than
	// rendered against an invented name — the seed is the only writer today, so
	// this is a corruption guard, not a user-facing path.
	if (!role) return null;

	const marks = resolveMarks(row);
	const beat: Beat = {
		kind: "role",
		roleKey: role.key,
		roleName: role.name,
		role: role.isSpeakerRole ? "speaker" : "plain",
		detail,
		minutes: row.minutes,
		renderUnowned: true,
		...(marks ? { marks } : {}),
		...(row.flex ? { flex: true } : {}),
	};
	return beat;
}

/**
 * Expand and adapt. Rows are taken in `sortOrder`; a run of CONSECUTIVE rows
 * sharing the same non-null `repeatsRoleKey` forms one block emitted once per
 * slot of that role (capped at `MAX_ROLE_REPEAT_SLOTS`), so a contest agenda is
 * correct for however many contestants actually signed up rather than for the
 * number someone typed when the template was authored. A block whose role has
 * no slots this meeting emits nothing.
 */
export function templateBeatsToRunOfShow(
	beats: TemplateBeatRow[],
	roles: TemplateRoleRow[],
	slots: AgendaSlot[],
): Beat[] {
	const rolesByKey = new Map(roles.map((r) => [r.key, r]));
	const ordered = [...beats].sort((a, b) => a.sortOrder - b.sortOrder);
	const out: Beat[] = [];

	let i = 0;
	while (i < ordered.length) {
		const row = ordered[i];
		if (!row) break;

		if (row.repeatsRoleKey == null) {
			const beat = toBeat(row, rolesByKey);
			if (beat) out.push(beat);
			i += 1;
			continue;
		}

		// Gather the consecutive run sharing this repeatsRoleKey.
		const repeatKey = row.repeatsRoleKey;
		const block: TemplateBeatRow[] = [];
		while (i < ordered.length) {
			const next = ordered[i];
			if (!next || next.repeatsRoleKey !== repeatKey) break;
			block.push(next);
			i += 1;
		}

		const repeatCount = Math.min(
			slotsForRole(slots, repeatKey).length,
			MAX_ROLE_REPEAT_SLOTS,
		);
		for (let n = 0; n < repeatCount; n++) {
			for (const blockRow of block) {
				const beat = toBeat(blockRow, rolesByKey);
				if (beat) out.push(beat);
			}
		}
	}

	return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bunx vitest run src/lib/agenda-template-beats.test.ts
bun run typecheck
```

Expected: PASS, 12 tests. If `Beat` rejects `handoff`, check `agenda-runsheet.ts` — `handoff` is on the shared half of the `Beat` union (search `handoff?: boolean`); if it is not, add it there in the same shape `AgendaRow.handoff` already has.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-template-beats.ts src/lib/agenda-template-beats.test.ts
git commit -m "feat(templates): pure adapter from stored template beats to Beat[]"
```

---

### Task 4: `resolveRunOfShow` — one seam for both paths

**Files:**
- Modify: `src/lib/agenda-runsheet.ts` (append after `RUN_OF_SHOW`, ~line 1222)
- Test: `src/lib/agenda-runsheet.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `buildRunOfShow`, `RunOfShowConfig` (`agenda-runsheet.ts`); `templateBeatsToRunOfShow` (Task 3).
- Produces: `function resolveRunOfShow(input: { geIntroducesFunctionaries: boolean; template: { beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null; slots: AgendaSlot[] }): Beat[]`

This exists so the two routes stop each deciding for themselves how to build a run-of-show. They are copy-pasted today (`club.$clubId.meeting.$meetingId.tsx:375` and `print.tsx:156`), which is exactly where screen and print can silently disagree.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-runsheet.test.ts`:

```ts
describe("resolveRunOfShow", () => {
	it("returns the standard run-of-show when there is no template", () => {
		const out = resolveRunOfShow({
			geIntroducesFunctionaries: false,
			template: null,
			slots: [],
		});
		expect(out).toEqual(buildRunOfShow({ geIntroducesFunctionaries: false }));
	});

	it("honours the club's GE variant when there is no template", () => {
		const out = resolveRunOfShow({
			geIntroducesFunctionaries: true,
			template: null,
			slots: [],
		});
		expect(out).toEqual(buildRunOfShow({ geIntroducesFunctionaries: true }));
	});

	it("returns the template's beats when there is one, ignoring the GE variant", () => {
		const template = {
			roles: [{ key: "chair", name: "Contest Chair", isSpeakerRole: false }],
			beats: [
				{
					sortOrder: 0,
					kind: "event" as const,
					label: "Call to order",
					detail: null,
					minutes: 2,
					roleKey: null,
					repeatsRoleKey: null,
					flex: false,
					markGreen: null,
					markYellow: null,
					markRed: null,
				},
			],
		};
		const out = resolveRunOfShow({
			geIntroducesFunctionaries: true,
			template,
			slots: [],
		});
		expect(out).toEqual([
			{ kind: "event", who: "Call to order", detail: "", minutes: 2 },
		]);
	});
});
```

Add `resolveRunOfShow` to the import block at the top of that test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/agenda-runsheet.test.ts
```

Expected: FAIL — `resolveRunOfShow` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/agenda-runsheet.ts`:

```ts
/**
 * The ONE place a meeting's run-of-show is chosen. A meeting with no template
 * gets the code-derived standard flow, exactly as before agenda templates
 * existed; a templated meeting gets its stored beats adapted into the same
 * `Beat[]` shape.
 *
 * Exists as a named seam because the screen and the print route each used to
 * call `buildRunOfShow` themselves, which is precisely the seam where the two
 * surfaces can silently disagree about what the meeting is. `geIntroducesFunctionaries`
 * is meaningless for a templated meeting — the club variant it selects is a
 * property of the STANDARD flow — so it is ignored on that branch rather than
 * threaded through and quietly dropped.
 */
export function resolveRunOfShow(input: {
	geIntroducesFunctionaries: boolean;
	template: {
		beats: TemplateBeatRow[];
		roles: TemplateRoleRow[];
	} | null;
	slots: AgendaSlot[];
}): Beat[] {
	if (!input.template) {
		return buildRunOfShow({
			geIntroducesFunctionaries: input.geIntroducesFunctionaries,
		});
	}
	return templateBeatsToRunOfShow(
		input.template.beats,
		input.template.roles,
		input.slots,
	);
}
```

Add to the imports at the top of `agenda-runsheet.ts`:

```ts
import {
	type TemplateBeatRow,
	type TemplateRoleRow,
	templateBeatsToRunOfShow,
} from "./agenda-template-beats";
```

`agenda-template-beats.ts` imports types from `agenda-runsheet.ts`, so this is a cycle in the module graph. It is types-only in one direction plus one value import in the other, which esbuild and `tsc` both handle — but if `bun run typecheck` complains, move `Beat`, `AgendaSlot` and `TimingMarks` into a new `src/lib/agenda-beat-types.ts` that both files import, and re-export them from `agenda-runsheet.ts` so no call site changes.

- [ ] **Step 4: Run test to verify it passes**

```bash
bunx vitest run src/lib/agenda-runsheet.test.ts
bun run typecheck
```

Expected: PASS, including the 3 new tests and every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-runsheet.ts src/lib/agenda-runsheet.test.ts
git commit -m "feat(templates): resolveRunOfShow, one seam for templated and standard meetings"
```

---

### Task 5: Template logic module — read, materialize, resolve defs

**Files:**
- Create: `src/server/meeting-templates-logic.ts`
- Test: `src/server/meeting-templates-logic.integration.test.ts`

**Interfaces:**
- Consumes: `#/db/schema` tables from Task 1; `TemplateBeatRow` / `TemplateRoleRow` from Task 3.
- Produces:
  - `type MeetingTemplateSummary = { id: string; key: string; name: string; description: string | null; defaultLengthMinutes: number | null }`
  - `async function listAvailableTemplates(clubId: string): Promise<MeetingTemplateSummary[]>`
  - `async function loadTemplateContent(templateId: string): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null>`
  - `async function materializeTemplateRoles(conn: DbOrTx, clubId: string, templateId: string): Promise<void>`
  - `async function resolveMeetingRoleDefs(conn: DbOrTx, clubId: string, templateId: string | null): Promise<MeetingSlotDefs[]>`
  - `type DbOrTx` (copy the two-line alias from `meeting-create-logic.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/server/meeting-templates-logic.integration.test.ts`:

```ts
/**
 * DB-backed tests for template reads and role materialization.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-templates-logic.integration.test.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	listAvailableTemplates,
	loadTemplateContent,
	materializeTemplateRoles,
	resolveMeetingRoleDefs,
} = await import("./meeting-templates-logic");

async function makeContestTemplate() {
	const [tpl] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: null,
			key: "speech_contest",
			name: "Speech Contest",
			description: "A club contest",
			defaultLengthMinutes: 150,
		})
		.returning({ id: meetingTemplates.id });
	if (!tpl) throw new Error("insert failed");
	await testDb.insert(meetingTemplateRoles).values([
		{ templateId: tpl.id, key: "contest_chair", name: "Contest Chair", category: "leadership", defaultCount: 1, sortOrder: 10 },
		{ templateId: tpl.id, key: "contestant", name: "Contestant", category: "speaker", defaultCount: 4, sortOrder: 20, isSpeakerRole: true },
	]);
	await testDb.insert(meetingTemplateBeats).values([
		{ templateId: tpl.id, sortOrder: 0, kind: "event", label: "Call to order", minutes: 2 },
		{ templateId: tpl.id, sortOrder: 1, kind: "role", label: "Speech", minutes: 7, roleKey: "contestant", repeatsRoleKey: "contestant" },
	]);
	return tpl.id;
}

describe.skipIf(!hasTestDb())("meeting template logic", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(cleanup);

	it("lists global templates for any club", async () => {
		await makeContestTemplate();
		const rows = await listAvailableTemplates(club.clubId);
		expect(rows.map((r) => r.key)).toEqual(["speech_contest"]);
		expect(rows[0]?.defaultLengthMinutes).toBe(150);
	});

	it("omits disabled templates", async () => {
		const id = await makeContestTemplate();
		await testDb.update(meetingTemplates).set({ enabled: false }).where(eq(meetingTemplates.id, id));
		expect(await listAvailableTemplates(club.clubId)).toHaveLength(0);
	});

	// Guards the tenant boundary. Without this the SQL `or(isNull, eq)` could be
	// replaced by a bare `eq(enabled, true)` and every test would stay green
	// while one club listed another club's templates.
	it("never lists ANOTHER club's template", async () => {
		const other = await seedClub();
		await testDb.insert(meetingTemplates).values({
			clubId: other.clubId,
			key: "their_private_template",
			name: "Their Template",
		});
		const rows = await listAvailableTemplates(club.clubId);
		expect(rows.map((r) => r.key)).not.toContain("their_private_template");
	});

	it("lists this club's OWN template alongside the globals", async () => {
		await makeContestTemplate();
		await testDb.insert(meetingTemplates).values({
			clubId: club.clubId,
			key: "our_template",
			name: "Our Template",
		});
		const keys = (await listAvailableTemplates(club.clubId)).map((r) => r.key);
		expect(keys).toContain("speech_contest");
		expect(keys).toContain("our_template");
	});

	// resolveMeetingRoleDefs is a PURE READ since the eng review, so a template
	// this club has not used yet resolves to nothing. Pins that contract so the
	// write cannot creep back in without a failing test.
	it("resolves EMPTY for a template whose roles are not materialized", async () => {
		const id = await makeContestTemplate();
		const defs = await resolveMeetingRoleDefs(testDb, club.clubId, id);
		expect(defs).toHaveLength(0);
	});

	it("loads beats and roles, ordered", async () => {
		const id = await makeContestTemplate();
		const content = await loadTemplateContent(id);
		expect(content?.beats.map((b) => b.sortOrder)).toEqual([0, 1]);
		expect(content?.roles.map((r) => r.key)).toEqual(["contest_chair", "contestant"]);
	});

	it("returns null for an unknown template", async () => {
		expect(await loadTemplateContent(crypto.randomUUID())).toBeNull();
	});

	it("materializes template roles into role_definitions scoped to the template", async () => {
		const id = await makeContestTemplate();
		await materializeTemplateRoles(testDb, club.clubId, id);
		const rows = await testDb
			.select()
			.from(roleDefinitions)
			.where(and(eq(roleDefinitions.clubId, club.clubId), eq(roleDefinitions.templateId, id)));
		expect(rows.map((r) => r.key).sort()).toEqual(["contest_chair", "contestant"]);
		expect(rows.find((r) => r.key === "contestant")?.defaultCount).toBe(4);
		expect(rows.find((r) => r.key === "contestant")?.isSpeakerRole).toBe(true);
	});

	it("is idempotent — a second materialize adds nothing", async () => {
		const id = await makeContestTemplate();
		await materializeTemplateRoles(testDb, club.clubId, id);
		await materializeTemplateRoles(testDb, club.clubId, id);
		const rows = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.templateId, id));
		expect(rows).toHaveLength(2);
	});

	it("does not overwrite a club's rename on re-materialize", async () => {
		const id = await makeContestTemplate();
		await materializeTemplateRoles(testDb, club.clubId, id);
		await testDb
			.update(roleDefinitions)
			.set({ name: "Contest Chairman" })
			.where(and(eq(roleDefinitions.templateId, id), eq(roleDefinitions.key, "contest_chair")));
		await materializeTemplateRoles(testDb, club.clubId, id);
		const row = await testDb
			.select()
			.from(roleDefinitions)
			.where(and(eq(roleDefinitions.templateId, id), eq(roleDefinitions.key, "contest_chair")));
		expect(row[0]?.name).toBe("Contest Chairman");
	});

	it("resolves standard defs when the template is null", async () => {
		const defs = await resolveMeetingRoleDefs(testDb, club.clubId, null);
		expect(defs.length).toBeGreaterThan(0);
		const standard = await testDb
			.select()
			.from(roleDefinitions)
			.where(and(eq(roleDefinitions.clubId, club.clubId), isNull(roleDefinitions.templateId)));
		expect(defs).toHaveLength(standard.filter((r) => r.enabled).length);
	});

	it("resolves only the template's defs once they are materialized", async () => {
		const id = await makeContestTemplate();
		await materializeTemplateRoles(testDb, club.clubId, id);
		const defs = await resolveMeetingRoleDefs(testDb, club.clubId, id);
		expect(defs).toHaveLength(2);
	});

	it("excludes template roles from the standard resolution", async () => {
		const id = await makeContestTemplate();
		await materializeTemplateRoles(testDb, club.clubId, id);
		const defs = await resolveMeetingRoleDefs(testDb, club.clubId, null);
		const ids = new Set(defs.map((d) => d.id));
		const templateRows = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.templateId, id));
		for (const row of templateRows) expect(ids.has(row.id)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/server/meeting-templates-logic.integration.test.ts
```

Expected: FAIL — cannot resolve `./meeting-templates-logic`.

- [ ] **Step 3: Write the implementation**

Create `src/server/meeting-templates-logic.ts`:

```ts
/**
 * Reads and materialization for agenda templates. A `*-logic.ts` module and not
 * part of `meeting-templates.ts` for the two independent reasons the repo
 * already documents: a top-level db-touching export inside a server-fn module
 * drags `#/db` → `pg` → `Buffer` into the client bundle, and a query living
 * only inside a `createServerFn` handler is unreachable from vitest.
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { db } from "#/db";
import { db as database } from "#/db";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-beats";
import type { MeetingSlotDefs } from "./meeting-create-logic";

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** A template as the picker shows it. */
export type MeetingTemplateSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	defaultLengthMinutes: number | null;
};

/**
 * Templates this club may apply: every enabled GLOBAL template (`club_id IS
 * NULL`) plus its own. Phase 1 writes no club-scoped rows, but the query admits
 * them so Phase 2 needs no change here.
 */
export async function listAvailableTemplates(
	clubId: string,
): Promise<MeetingTemplateSummary[]> {
	return database
		.select({
			id: meetingTemplates.id,
			key: meetingTemplates.key,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
		})
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.enabled, true),
				// The tenant boundary lives in the QUERY, not in a `.filter()` the
				// next refactor can drop with every test still green. NULL club_id =
				// a global template available to everyone; anything else must be
				// this club's. Phase 1 writes no club-scoped rows, but writing the
				// predicate now means Phase 2's editor cannot leak one club's
				// template to another. Same shape #544/#560 had to be fixed for.
				or(
					isNull(meetingTemplates.clubId),
					eq(meetingTemplates.clubId, clubId),
				),
			),
		)
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));
}

/**
 * A template's beats and roles, ordered. Null when the template has neither —
 * which for a `meetings.template_id` pointer means corruption, since that FK is
 * ON DELETE RESTRICT and the template therefore cannot have been deleted.
 *
 * NO existence check and the two selects run in PARALLEL. This is called from
 * `loadMeetingDetail`, which TODOS.md already flags as issuing ~15 sequential
 * round trips that every roll-mode write re-runs; three more sequential ones
 * would land on the exact path that hurts, on contest night. An existence
 * SELECT that the foreign key already guarantees is not worth a round trip.
 */
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	const [beats, roles] = await Promise.all([
		loadTemplateBeats(templateId),
		loadTemplateRoles(templateId),
	]);
	// Both empty = no such template. A Phase 2 editor could create a template
	// with no beats AND no roles, which would read as missing here; give it at
	// least one row, or add the existence check back at that point.
	if (beats.length === 0 && roles.length === 0) return null;
	return { beats, roles };
}

async function loadTemplateBeats(
	templateId: string,
): Promise<TemplateBeatRow[]> {
	return database
		.select({
			sortOrder: meetingTemplateBeats.sortOrder,
			kind: meetingTemplateBeats.kind,
			label: meetingTemplateBeats.label,
			detail: meetingTemplateBeats.detail,
			minutes: meetingTemplateBeats.minutes,
			roleKey: meetingTemplateBeats.roleKey,
			repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
			flex: meetingTemplateBeats.flex,
			markGreen: meetingTemplateBeats.markGreen,
			markYellow: meetingTemplateBeats.markYellow,
			markRed: meetingTemplateBeats.markRed,
		})
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, templateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder));
}

async function loadTemplateRoles(
	templateId: string,
): Promise<TemplateRoleRow[]> {
	return database
		.select({
			key: meetingTemplateRoles.key,
			name: meetingTemplateRoles.name,
			isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
		})
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
}

/**
 * Copy a template's roles into this club's `role_definitions`, tagged with the
 * template. Idempotent on `(club_id, template_id, key)` via the partial unique
 * index, and `DO NOTHING` rather than `DO UPDATE` so a club's own rename of a
 * materialized role survives every later re-application — the club's name is
 * what every surface labels with (#445), and re-materializing must not undo it.
 *
 * Required because `role_slots.role_definition_id` is NOT NULL and restricting:
 * a claimable contest role has to be a real `role_definitions` row.
 */
export async function materializeTemplateRoles(
	conn: DbOrTx,
	clubId: string,
	templateId: string,
): Promise<void> {
	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
	if (roles.length === 0) return;

	await conn
		.insert(roleDefinitions)
		.values(
			roles.map((r) => ({
				clubId,
				templateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		)
		.onConflictDoNothing();
}

/**
 * The ONE definition of "which role definitions does this meeting draw slots
 * from" — the club's ENABLED standard roles when there is no template, the
 * template's materialized roles when there is. Exported so the preview and the
 * apply share one predicate instead of each spelling it out.
 */
export function roleDefScope(clubId: string, templateId: string | null) {
	return and(
		eq(roleDefinitions.clubId, clubId),
		templateId === null
			? and(isNull(roleDefinitions.templateId), eq(roleDefinitions.enabled, true))
			: eq(roleDefinitions.templateId, templateId),
	);
}

/**
 * PURE READ. Returns the role definitions a meeting's slots are generated from.
 *
 * Deliberately does NOT materialize. A function named `resolve…` that quietly
 * INSERTs is a surprise for the next caller, and it made the preview impossible
 * to build on: showing an officer what a conversion would do must not itself
 * change anything, so the preview could not call a resolver that writes and had
 * to duplicate this predicate. One rule, two callers, no drift.
 *
 * For a template this club has never used, the result is EMPTY — the caller
 * must have called `materializeTemplateRoles` first. `applyTemplateConversion`
 * does exactly that, as its own explicit step.
 *
 * `generateSlotRows` itself is unchanged — the CALLER decides which definitions
 * it sees, which keeps the blast radius of templates off the slot generator.
 */
export async function resolveMeetingRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<MeetingSlotDefs[]> {
	return conn
		.select({
			id: roleDefinitions.id,
			defaultCount: roleDefinitions.defaultCount,
			enabled: roleDefinitions.enabled,
			category: roleDefinitions.category,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			sortOrder: roleDefinitions.sortOrder,
			name: roleDefinitions.name,
		})
		.from(roleDefinitions)
		.where(roleDefScope(clubId, templateId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
}
```

Imports for this module: `import { and, asc, eq, isNull, or } from "drizzle-orm";` — exactly those five, no more. Strict TS has no-unused-locals, so a speculative import fails the build.

If `MeetingSlotDefs` (`= SlotGenInput & RoleDefLite`) needs fields beyond those selected, open `src/lib/meeting-roles.ts`, read `RoleDefLite`, and add exactly its fields to the select. Do not widen `SlotGenInput`.

- [ ] **Step 4: Run test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/server/meeting-templates-logic.integration.test.ts
bun run typecheck
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Filter template roles out of the club role editor**

`listRoleDefinitions` (`src/server/role-definitions-logic.ts:54`) builds `const where = [eq(roleDefinitions.clubId, clubId)]`. Add immediately after it:

```ts
	// Template-owned roles are not the club's role template — they belong to a
	// meeting shape, are managed by applying that template, and must never appear
	// in /admin/roles or in a standard meeting's "+ Add role" picker.
	where.push(isNull(roleDefinitions.templateId));
```

Add `isNull` to that file's `drizzle-orm` import.

- [ ] **Step 6: Prove the filter with a test**

Append to `src/server/role-definitions.integration.test.ts`:

```ts
	it("omits template-owned roles from the club's role list", async () => {
		const { meetingTemplates: tpl } = await import("#/db/schema");
		const [row] = await testDb
			.insert(tpl)
			.values({ clubId: null, key: "t", name: "T" })
			.returning({ id: tpl.id });
		if (!row) throw new Error("insert failed");
		await testDb.insert(roleDefinitions).values({
			clubId: club.clubId,
			templateId: row.id,
			key: "contest_chair",
			name: "Contest Chair",
			category: "leadership",
		});
		const rows = await listRoleDefinitions(club.clubId);
		expect(rows.map((r) => r.name)).not.toContain("Contest Chair");
	});
```

Place it inside the existing top-level `describe`, and match the surrounding tests' way of referring to the seeded club (`club.clubId` here — check the file and use whatever name it binds).

- [ ] **Step 7: Run both suites and commit**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/server/meeting-templates-logic.integration.test.ts src/server/role-definitions.integration.test.ts
bun run typecheck
git add src/server/meeting-templates-logic.ts src/server/meeting-templates-logic.integration.test.ts src/server/role-definitions-logic.ts src/server/role-definitions.integration.test.ts
git commit -m "feat(templates): template reads, role materialization, and scoped def resolution"
```

---

### Task 6: Conversion — preview and apply

**Files:**
- Modify: `src/server/meeting-templates-logic.ts`
- Test: `src/server/meeting-template-convert.integration.test.ts`

**Interfaces:**
- Consumes: everything from Task 5; `generateSlotRows` (`#/lib/agenda`); `linkEvaluatorsToSpeakers` (`./meeting-create-logic`); `logActivity` (`./activity`).
- Produces:
  - `type ReleasedHolder = { memberId: string | null; guestId: string | null; name: string; roleName: string }`
  - `type ConversionPlan = { openSlotsRemoved: number; claimedSlotsReleased: number; slotsWithSpeeches: number; releasedHolders: ReleasedHolder[] }`
  - `async function planTemplateConversion(meetingId: string, templateId: string | null): Promise<ConversionPlan>`
  - `async function applyTemplateConversion(input: { meetingId: string; clubId: string; templateId: string | null; actorMemberId: string | null }): Promise<ConversionPlan>`

Note: the released holders are **returned**, never enqueued as notifications. `notifications.slot_id` is `NOT NULL` with `ON DELETE CASCADE` to `role_slots`, so a row enqueued against a slot this same transaction deletes is cascade-deleted before the poller can see it — a notification that silently never sends. See the spec's conversion section.

- [ ] **Step 1: Write the failing test**

Create `src/server/meeting-template-convert.integration.test.ts`:

```ts
/**
 * DB-backed tests for converting a meeting to and from a template.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/meeting-template-convert.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	meetings,
	roleSlots,
	speeches,
} from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyTemplateConversion, planTemplateConversion } = await import(
	"./meeting-templates-logic"
);

async function makeTemplate() {
	const [tpl] = await testDb
		.insert(meetingTemplates)
		.values({ clubId: null, key: "speech_contest", name: "Speech Contest", defaultLengthMinutes: 150 })
		.returning({ id: meetingTemplates.id });
	if (!tpl) throw new Error("insert failed");
	await testDb.insert(meetingTemplateRoles).values([
		{ templateId: tpl.id, key: "contest_chair", name: "Contest Chair", category: "leadership", defaultCount: 1, sortOrder: 10 },
		{ templateId: tpl.id, key: "contestant", name: "Contestant", category: "speaker", defaultCount: 3, sortOrder: 20, isSpeakerRole: true },
	]);
	await testDb.insert(meetingTemplateBeats).values({
		templateId: tpl.id, sortOrder: 0, kind: "event", label: "Call to order", minutes: 2,
	});
	return tpl.id;
}

describe.skipIf(!hasTestDb())("meeting template conversion", () => {
	let club: SeededClub;
	let templateId: string;

	beforeEach(async () => {
		club = await seedClub();
		templateId = await makeTemplate();
	});
	afterEach(cleanup);

	async function slotsFor(meetingId: string) {
		return testDb.select().from(roleSlots).where(eq(roleSlots.meetingId, meetingId));
	}

	it("previews without changing anything", async () => {
		const before = await slotsFor(club.meetingId);
		const plan = await planTemplateConversion(club.meetingId, templateId);
		expect(plan.openSlotsRemoved + plan.claimedSlotsReleased).toBe(before.length);
		expect(await slotsFor(club.meetingId)).toHaveLength(before.length);
	});

	it("replaces the standard slots with the template's", async () => {
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		const after = await slotsFor(club.meetingId);
		// 1 chair + 3 contestants
		expect(after).toHaveLength(4);
	});

	it("stamps template_id and the template's default length on the meeting", async () => {
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		const [row] = await testDb.select().from(meetings).where(eq(meetings.id, club.meetingId));
		expect(row?.templateId).toBe(templateId);
		expect(row?.lengthMinutes).toBe(150);
	});

	it("returns the holder of a claimed slot instead of silently dropping them", async () => {
		const [slot] = await slotsFor(club.meetingId);
		if (!slot) throw new Error("seed produced no slots");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: club.memberId, status: "claimed" })
			.where(eq(roleSlots.id, slot.id));

		const plan = await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		expect(plan.claimedSlotsReleased).toBe(1);
		expect(plan.releasedHolders).toHaveLength(1);
		expect(plan.releasedHolders[0]?.memberId).toBe(club.memberId);
		expect(plan.releasedHolders[0]?.name).toBeTruthy();
	});

	it("keeps a speech alive when its slot is removed", async () => {
		const [speech] = await testDb
			.insert(speeches)
			.values({ personId: club.personId, title: "My speech" })
			.returning({ id: speeches.id });
		if (!speech) throw new Error("insert failed");
		const all = await slotsFor(club.meetingId);
		const speaker = all.find((s) => s.slotIndex === 0);
		if (!speaker) throw new Error("no slot");
		await testDb.update(roleSlots).set({ speechId: speech.id }).where(eq(roleSlots.id, speaker.id));

		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});

		const surviving = await testDb.select().from(speeches).where(eq(speeches.id, speech.id));
		expect(surviving).toHaveLength(1);
	});

	it("writes one activity row", async () => {
		await applyTemplateConversion({
			meetingId: club.meetingId,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		const rows = await testDb.select().from(activityLog).where(eq(activityLog.clubId, club.clubId));
		expect(rows.filter((r) => r.action === "meeting.template_applied")).toHaveLength(1);
	});

	it("converts back to a standard meeting when templateId is null", async () => {
		await applyTemplateConversion({
			meetingId: club.meetingId, clubId: club.clubId, templateId, actorMemberId: null,
		});
		await applyTemplateConversion({
			meetingId: club.meetingId, clubId: club.clubId, templateId: null, actorMemberId: null,
		});
		const [row] = await testDb.select().from(meetings).where(eq(meetings.id, club.meetingId));
		expect(row?.templateId).toBeNull();
		const after = await slotsFor(club.meetingId);
		expect(after.length).toBeGreaterThan(4);
	});

	it("refuses to convert a held meeting", async () => {
		await testDb.update(meetings).set({ status: "held" }).where(eq(meetings.id, club.meetingId));
		await expect(
			applyTemplateConversion({
				meetingId: club.meetingId, clubId: club.clubId, templateId, actorMemberId: null,
			}),
		).rejects.toThrow(/scheduled/i);
	});

	it("reports how many slots it will ADD before anything is materialized", async () => {
		// 1 chair + 3 contestants, read from the template's own rows because
		// nothing is materialized yet.
		const plan = await planTemplateConversion(club.meetingId, templateId);
		expect(plan.slotsAdded).toBe(4);
	});

	it("adds nothing and removes nothing on a re-apply", async () => {
		await applyTemplateConversion({
			meetingId: club.meetingId, clubId: club.clubId, templateId, actorMemberId: null,
		});
		const plan = await planTemplateConversion(club.meetingId, templateId);
		expect(plan.slotsAdded).toBe(0);
		expect(plan.openSlotsRemoved).toBe(0);
		expect(plan.claimedSlotsReleased).toBe(0);
	});

	it("returns a GUEST holder, not just members", async () => {
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: club.clubId, name: "Visiting Judge" })
			.returning({ id: guests.id });
		if (!guest) throw new Error("insert failed");
		const [slot] = await slotsFor(club.meetingId);
		if (!slot) throw new Error("seed produced no slots");
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: guest.id, status: "claimed" })
			.where(eq(roleSlots.id, slot.id));

		const plan = await applyTemplateConversion({
			meetingId: club.meetingId, clubId: club.clubId, templateId, actorMemberId: null,
		});
		expect(plan.releasedHolders[0]?.guestId).toBe(guest.id);
		expect(plan.releasedHolders[0]?.name).toBe("Visiting Judge");
	});

	it("leaves lengthMinutes alone when the template sets none", async () => {
		await testDb
			.update(meetingTemplates)
			.set({ defaultLengthMinutes: null })
			.where(eq(meetingTemplates.id, templateId));
		const [before] = await testDb.select().from(meetings).where(eq(meetings.id, club.meetingId));
		await applyTemplateConversion({
			meetingId: club.meetingId, clubId: club.clubId, templateId, actorMemberId: null,
		});
		const [after] = await testDb.select().from(meetings).where(eq(meetings.id, club.meetingId));
		expect(after?.lengthMinutes).toBe(before?.lengthMinutes);
	});

	it("refuses an unknown template", async () => {
		await expect(
			applyTemplateConversion({
				meetingId: club.meetingId, clubId: club.clubId, templateId: crypto.randomUUID(), actorMemberId: null,
			}),
		).rejects.toThrow(/template/i);
	});
});
```

Before running, open `src/test/db.ts` and confirm `SeededClub` exposes `meetingId`, `memberId` and `personId`. If any is missing, add it to `seedClub`'s return rather than working around it — every later task's tests want them.

- [ ] **Step 2: Run test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/server/meeting-template-convert.integration.test.ts
```

Expected: FAIL — `planTemplateConversion` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/server/meeting-templates-logic.ts`:

```ts
/** A member or guest whose slot the conversion released. */
export type ReleasedHolder = {
	memberId: string | null;
	guestId: string | null;
	name: string;
	roleName: string;
};

/** What a conversion will do (preview) or did (apply). */
export type ConversionPlan = {
	openSlotsRemoved: number;
	claimedSlotsReleased: number;
	slotsWithSpeeches: number;
	/** Slots the conversion will CREATE. The spec's dialog copy promises this
	 *  number ("removes 9 open slots, adds 14 contest roles"), and it cannot come
	 *  from `role_definitions` on a first-time preview — nothing is materialized
	 *  yet, by design, because the preview must not write. So it is read from the
	 *  TEMPLATE's own rows and reduced by whatever already exists. */
	slotsAdded: number;
	releasedHolders: ReleasedHolder[];
};

/** Slots this meeting has now, annotated with role name and assignee name. */
async function loadSlotsForConversion(conn: DbOrTx, meetingId: string) {
	return conn
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			roleName: roleDefinitions.name,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.innerJoin(roleDefinitions, eq(roleSlots.roleDefinitionId, roleDefinitions.id))
		.leftJoin(members, eq(roleSlots.assignedMemberId, members.id))
		.leftJoin(guests, eq(roleSlots.assignedGuestId, guests.id))
		.where(eq(roleSlots.meetingId, meetingId));
}

function summarize(
	current: Awaited<ReturnType<typeof loadSlotsForConversion>>,
	keepDefIds: Set<string>,
	targetSlotCount: number,
): ConversionPlan {
	const doomed = current.filter((s) => !keepDefIds.has(s.roleDefinitionId));
	const held = doomed.filter((s) => s.assignedMemberId || s.assignedGuestId);
	const kept = current.length - doomed.length;
	return {
		openSlotsRemoved: doomed.length - held.length,
		claimedSlotsReleased: held.length,
		slotsWithSpeeches: doomed.filter((s) => s.speechId !== null).length,
		// Never negative: a re-apply keeps every slot, so target minus kept is 0.
		slotsAdded: Math.max(0, targetSlotCount - kept),
		releasedHolders: held.map((s) => ({
			memberId: s.assignedMemberId,
			guestId: s.assignedGuestId,
			name: s.memberName ?? s.guestName ?? "Someone",
			roleName: s.roleName,
		})),
	};
}

/**
 * What applying `templateId` to this meeting would do. Read-only — the
 * confirmation dialog shows these counts BEFORE anything is destroyed, which is
 * the whole reason converting a meeting with live claims on it is allowed at
 * all.
 */
export async function planTemplateConversion(
	meetingId: string,
	templateId: string | null,
): Promise<ConversionPlan> {
	const [meeting] = await database
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");

	const current = await loadSlotsForConversion(database, meetingId);

	// Preview must NOT materialize: a preview that writes would leave a club's
	// role_definitions littered with templates nobody applied. It reuses the
	// SAME predicate the apply resolves through (`roleDefScope`) rather than
	// re-expressing it, so the two can never disagree about what gets kept —
	// which is the one thing this dialog exists to guarantee.
	const target = await database
		.select({ id: roleDefinitions.id, defaultCount: roleDefinitions.defaultCount })
		.from(roleDefinitions)
		.where(roleDefScope(meeting.clubId, templateId));

	// How many slots the target shape has. For an ALREADY-materialized template
	// (or the standard roles) that is the sum over `target`. For a first-time
	// template nothing is materialized yet, so read the template's own rows.
	const targetSlotCount =
		target.length > 0
			? target.reduce((n, d) => n + d.defaultCount, 0)
			: templateId === null
				? 0
				: (
						await database
							.select({ defaultCount: meetingTemplateRoles.defaultCount })
							.from(meetingTemplateRoles)
							.where(eq(meetingTemplateRoles.templateId, templateId))
					).reduce((n, r) => n + r.defaultCount, 0);

	return summarize(current, new Set(target.map((r) => r.id)), targetSlotCount);
}

/**
 * Apply a template to an existing meeting (or `null` to convert it back to a
 * standard meeting), in ONE transaction.
 *
 * Released holders are RETURNED, never enqueued on `notifications`:
 * `notifications.slot_id` is NOT NULL and ON DELETE CASCADE to `role_slots`, so
 * a row enqueued against a slot this transaction then deletes is cascade-deleted
 * before the poller could ever see it — a notification that silently never
 * sends. The caller surfaces the existing WhatsApp nudge against each name
 * instead.
 *
 * Authorization is the CALLER's: this function has no session. The server fn
 * gates on admin/vpe and on the club's archive state before calling it.
 */
export async function applyTemplateConversion(input: {
	meetingId: string;
	clubId: string;
	templateId: string | null;
	actorMemberId: string | null;
}): Promise<ConversionPlan> {
	const { meetingId, clubId, templateId, actorMemberId } = input;

	if (templateId !== null) {
		const content = await loadTemplateContent(templateId);
		if (!content) throw new Error("That meeting template no longer exists.");
	}

	return database.transaction(async (tx) => {
		const [meeting] = await tx
			.select({
				id: meetings.id,
				status: meetings.status,
				clubId: meetings.clubId,
			})
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.limit(1);
		if (!meeting || meeting.clubId !== clubId) {
			throw new Error("Meeting not found.");
		}
		// Mirrors the meeting lifecycle lock (ADR-0012): reshaping a meeting that
		// already happened, or one that was cancelled, is never right.
		if (meeting.status !== "scheduled") {
			throw new Error("Only a scheduled meeting can change its template.");
		}

		// Materialize EXPLICITLY, as its own step — `resolveMeetingRoleDefs` is a
		// pure read since the eng review, so the write has to be visible here
		// rather than hidden inside the resolver. Idempotent.
		if (templateId !== null) {
			await materializeTemplateRoles(tx, clubId, templateId);
		}
		const defs = await resolveMeetingRoleDefs(tx, clubId, templateId);
		const keepDefIds = new Set(defs.map((d) => d.id));
		const current = await loadSlotsForConversion(tx, meetingId);
		const plan = summarize(
			current,
			keepDefIds,
			defs.reduce((n, d) => n + d.defaultCount, 0),
		);

		const doomedIds = current
			.filter((s) => !keepDefIds.has(s.roleDefinitionId))
			.map((s) => s.id);
		if (doomedIds.length > 0) {
			// Release first, then delete. Clearing the assignee and the speech
			// pointer in their own statement keeps the "a slot is released before
			// it disappears" invariant true at every intermediate state, and the
			// speech itself is Person-owned (ADR-0009) so it survives regardless.
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					assignedGuestId: null,
					speechId: null,
					status: "open",
					claimedAt: null,
				})
				.where(inArray(roleSlots.id, doomedIds));
			await tx.delete(roleSlots).where(inArray(roleSlots.id, doomedIds));
		}

		const existingDefIds = new Set(
			current
				.filter((s) => keepDefIds.has(s.roleDefinitionId))
				.map((s) => s.roleDefinitionId),
		);
		const toCreate = defs.filter((d) => !existingDefIds.has(d.id));
		if (toCreate.length > 0) {
			const rows = generateSlotRows(toCreate, meetingId);
			if (rows.length > 0) {
				const inserted = await tx
					.insert(roleSlots)
					.values(rows)
					.returning({
						id: roleSlots.id,
						roleDefinitionId: roleSlots.roleDefinitionId,
						slotIndex: roleSlots.slotIndex,
					});
				await linkEvaluatorsToSpeakers(tx, inserted, defs);
			}
		}

		const length =
			templateId === null
				? null
				: (
						await tx
							.select({ m: meetingTemplates.defaultLengthMinutes })
							.from(meetingTemplates)
							.where(eq(meetingTemplates.id, templateId))
							.limit(1)
					)[0]?.m ?? null;

		await tx
			.update(meetings)
			.set({ templateId, ...(length != null ? { lengthMinutes: length } : {}) })
			.where(eq(meetings.id, meetingId));

		await logActivity(tx, {
			clubId,
			actorMemberId,
			action: "meeting.template_applied",
			targetType: "meeting",
			targetId: meetingId,
			detail: templateId === null ? "Standard meeting" : templateId,
		});

		return plan;
	});
}
```

Extend that file's imports:

```ts
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { guests, meetings, members, roleSlots } from "#/db/schema";
import { generateSlotRows } from "#/lib/agenda";
import { linkEvaluatorsToSpeakers } from "./meeting-create-logic";
import { logActivity } from "./activity";
```

Check `logActivity`'s `ActivityInput` in `src/server/activity.ts` and match its field names exactly; if `action` is a union rather than `string`, add `"meeting.template_applied"` to it.

- [ ] **Step 4: Run test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" \
  bunx vitest run src/server/meeting-template-convert.integration.test.ts
bun run typecheck
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/meeting-templates-logic.ts src/server/meeting-template-convert.integration.test.ts
git commit -m "feat(templates): preview and apply a template to an existing meeting"
```

---

### Task 7: Server functions

**Files:**
- Create: `src/server/meeting-templates.ts`
- Test: `src/server/meeting-templates-authz.guard.test.ts`

**Interfaces:**
- Consumes: Task 5 and Task 6 exports; `requireUser`, `requireClubRole`, `assertClubNotArchived` (`./guards`).
- Produces: `listTemplatesForClub`, `previewTemplateForMeeting`, `applyTemplateToMeeting` — `createServerFn`s only.

This module must export **nothing but `createServerFn`s and types**, or `server-modules.guard.test.ts` fails.

- [ ] **Step 1: Write the failing guard test**

Create `src/server/meeting-templates-authz.guard.test.ts`:

```ts
/**
 * Comment-blind source guard: every mutating template server fn must gate on
 * admin/vpe AND on the club's archive state. Read comment-blind (`readSource`)
 * because a "must be present" assertion would falsely PASS on a comment merely
 * naming the pattern.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/meeting-templates.ts");

describe("meeting template server fns", () => {
	it("gates every mutating fn on an admin/vpe club role", () => {
		const mutators = SOURCE.split("export const").filter((chunk) =>
			chunk.includes('method: "POST"'),
		);
		expect(mutators.length).toBeGreaterThan(0);
		for (const chunk of mutators) {
			expect(chunk).toContain("requireClubRole");
		}
	});

	it("asserts the club is not archived on every mutating fn", () => {
		const mutators = SOURCE.split("export const").filter((chunk) =>
			chunk.includes('method: "POST"'),
		);
		for (const chunk of mutators) {
			expect(chunk).toContain("assertClubNotArchived");
		}
	});

	it("exports only server fns and types", () => {
		const exportLines = SOURCE.split("\n").filter((l) => l.startsWith("export "));
		for (const line of exportLines) {
			const ok =
				line.startsWith("export const") ||
				line.startsWith("export type") ||
				line.startsWith("export interface");
			expect(ok, `unexpected export: ${line}`).toBe(true);
		}
		for (const line of exportLines.filter((l) => l.startsWith("export const"))) {
			expect(line).toContain("createServerFn");
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/server/meeting-templates-authz.guard.test.ts
```

Expected: FAIL — cannot read `src/server/meeting-templates.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/server/meeting-templates.ts`:

```ts
/**
 * Server fns for agenda templates. Exports ONLY `createServerFn`s and types —
 * a plain top-level db-touching export in this module would drag `#/db` → `pg`
 * → `Buffer` into the client bundle and white-screen the page. All db logic
 * lives in `meeting-templates-logic.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import {
	assertClubNotArchived,
	requireClubRole,
	requireUser,
} from "./guards";
import {
	applyTemplateConversion,
	type ConversionPlan,
	listAvailableTemplates,
	type MeetingTemplateSummary,
	planTemplateConversion,
} from "./meeting-templates-logic";

export type { ConversionPlan, MeetingTemplateSummary };

const clubInput = z.object({ clubId: z.string().uuid() });
const meetingTemplateInput = z.object({
	meetingId: z.string().uuid(),
	templateId: z.string().uuid().nullable(),
});

// NOTE the `.validator()` shape below. This repo passes a FUNCTION, not a zod
// schema: `role-definitions.ts:26` is
// `.validator((clubId: unknown) => uuid.parse(clubId))`. Passing the schema
// object directly does not match how every other server fn here is written.

/** Resolve a meeting to its club, and gate the caller as an admin/vpe of it. */
async function requireMeetingAdmin(meetingId: string) {
	const user = await requireUser();
	const [meeting] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) throw new Error("Meeting not found.");
	await assertClubNotArchived(meeting.clubId);
	const membership = await requireClubRole(user.id, meeting.clubId, ["admin"]);
	return { clubId: meeting.clubId, membership };
}

export const listTemplatesForClub = createServerFn({ method: "GET" })
	.validator((input: unknown) => clubInput.parse(input))
	.handler(async ({ data }): Promise<MeetingTemplateSummary[]> => {
		const user = await requireUser();
		await assertClubNotArchived(data.clubId);
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return listAvailableTemplates(data.clubId);
	});

export const previewTemplateForMeeting = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingTemplateInput.parse(input))
	.handler(async ({ data }): Promise<ConversionPlan> => {
		await requireMeetingAdmin(data.meetingId);
		return planTemplateConversion(data.meetingId, data.templateId);
	});

export const applyTemplateToMeeting = createServerFn({ method: "POST" })
	.validator((input: unknown) => meetingTemplateInput.parse(input))
	.handler(async ({ data }): Promise<ConversionPlan> => {
		const { clubId, membership } = await requireMeetingAdmin(data.meetingId);
		return applyTemplateConversion({
			meetingId: data.meetingId,
			clubId,
			templateId: data.templateId,
			actorMemberId: membership.id,
		});
	});
```

Open a neighbouring server-fn module (e.g. `src/server/role-definitions.ts`) and match its `createServerFn` / `.validator` / `.handler` call shape exactly — if it uses `.inputValidator` or a different zod version's API, follow that file, not this snippet.

`previewTemplateForMeeting` also calls `requireMeetingAdmin`, so the guard test's POST-only assertions still hold while the read is gated too.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bunx vitest run src/server/meeting-templates-authz.guard.test.ts src/server/server-modules.guard.test.ts src/server/public-readers-archive-gate.guard.test.ts
bun run typecheck
```

Expected: PASS. If `public-readers-archive-gate.guard.test.ts` flags a new ungated reader, the fix is to gate it — not to add it to `REVIEWED_UNGATED`.

- [ ] **Step 5: Commit**

```bash
git add src/server/meeting-templates.ts src/server/meeting-templates-authz.guard.test.ts
git commit -m "feat(templates): admin-gated server fns for listing, previewing and applying templates"
```

---

### Task 8: Seed the Speech Contest template

**Files:**
- Create: `src/lib/contest-template.ts`
- Modify: `src/db/seed.ts`
- Create: `scripts/seed-global-templates.ts`
- Test: `src/lib/contest-template.test.ts`

**Interfaces:**
- Consumes: `TemplateBeatRow`, `TemplateRoleRow` (Task 3); the caps (Task 2).
- Produces: `CONTEST_TEMPLATE_KEY`, `CONTEST_TEMPLATE`, `type TemplateSeed`.

The seed content lives in `lib/` beside `role-template.ts`, for the same reason that file gives: it is shared by the dev seed and a production script, and neither should pull the other in.

- [ ] **Step 1: Write the failing test**

Create `src/lib/contest-template.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { templateBeatsToRunOfShow } from "./agenda-template-beats";
import { CONTEST_TEMPLATE, CONTEST_TEMPLATE_KEY } from "./contest-template";
import { MAX_TEMPLATE_BEATS, MAX_TEMPLATE_ROLES } from "./meeting-template-limits";

describe("contest template seed", () => {
	it("is within the size ceilings", () => {
		expect(CONTEST_TEMPLATE.beats.length).toBeLessThan(MAX_TEMPLATE_BEATS);
		expect(CONTEST_TEMPLATE.roles.length).toBeLessThan(MAX_TEMPLATE_ROLES);
	});

	it("uses generic segment labels, not TI marks", () => {
		const labels = CONTEST_TEMPLATE.beats.map((b) => b.label);
		expect(labels).toContain("PREPARED SPEECH CONTEST");
		expect(labels).toContain("IMPROMPTU SPEAKING CONTEST");
		expect(labels).toContain("SPEECH EVALUATION CONTEST");
		const joined = labels.join(" | ");
		expect(joined).not.toContain("International Speech Contest");
		expect(joined).not.toContain("Table Topics Contest");
	});

	it("declares a contestant role that carries speeches", () => {
		const contestant = CONTEST_TEMPLATE.roles.find((r) => r.key === "contestant");
		expect(contestant?.isSpeakerRole).toBe(true);
		expect(contestant?.category).toBe("speaker");
	});

	it("declares every roleKey its beats reference", () => {
		const keys = new Set(CONTEST_TEMPLATE.roles.map((r) => r.key));
		for (const beat of CONTEST_TEMPLATE.beats) {
			if (beat.roleKey) expect(keys.has(beat.roleKey)).toBe(true);
			if (beat.repeatsRoleKey) expect(keys.has(beat.repeatsRoleKey)).toBe(true);
		}
	});

	it("has strictly increasing sortOrder", () => {
		const orders = CONTEST_TEMPLATE.beats.map((b) => b.sortOrder);
		expect(orders).toEqual([...orders].sort((a, b) => a - b));
		expect(new Set(orders).size).toBe(orders.length);
	});

	it("declares at most one flex beat", () => {
		expect(CONTEST_TEMPLATE.beats.filter((b) => b.flex)).toHaveLength(0);
	});

	it("adapts its contestant block to the number of signups", () => {
		const roles = CONTEST_TEMPLATE.roles.map((r) => ({
			key: r.key, name: r.name, isSpeakerRole: r.isSpeakerRole,
		}));
		const slotsFor = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				id: `c${i}`, roleName: "Contestant", roleKey: "contestant",
				category: "speaker", isSpeakerRole: true, slotIndex: i,
				assigneeName: null, speechTitle: null, projectLevel: null,
				minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null,
			}));
		const four = templateBeatsToRunOfShow(CONTEST_TEMPLATE.beats, roles, slotsFor(4));
		const seven = templateBeatsToRunOfShow(CONTEST_TEMPLATE.beats, roles, slotsFor(7));
		expect(seven.length).toBeGreaterThan(four.length);
	});

	it("has a stable key", () => {
		expect(CONTEST_TEMPLATE_KEY).toBe("speech_contest");
		expect(CONTEST_TEMPLATE.key).toBe(CONTEST_TEMPLATE_KEY);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/contest-template.test.ts
```

Expected: FAIL — cannot resolve `./contest-template`.

- [ ] **Step 3: Write the seed content**

Create `src/lib/contest-template.ts`. Keep it db-free, like `role-template.ts`.

```ts
/**
 * The seeded global Speech Contest template: a club contest's role set and
 * run-of-show, as DATA. Kept db-free beside `role-template.ts` so both the dev
 * seed (`src/db/seed.ts`) and the production seeding script
 * (`scripts/seed-global-templates.ts`) share one copy.
 *
 * Segment labels are deliberately GENERIC rather than the Toastmasters
 * International contest names (ADR-0024's trademark-safe default, #384). A club
 * that wants the official wording renames its materialized roles and, in Phase
 * 2, its own copy of the template.
 *
 * Contestant is a SPEAKER-category role: contest speeches are still speeches,
 * so the speech record, the project picker and Pathways attribution all work
 * against a contestant slot with no special-casing.
 */
import type { TemplateBeatRow, TemplateRoleRow } from "./agenda-template-beats";

export const CONTEST_TEMPLATE_KEY = "speech_contest";

type SeedRole = TemplateRoleRow & {
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	description: string;
};

export type TemplateSeed = {
	key: string;
	name: string;
	description: string;
	defaultLengthMinutes: number;
	roles: SeedRole[];
	beats: TemplateBeatRow[];
};

const role = (
	key: string,
	name: string,
	category: SeedRole["category"],
	defaultCount: number,
	sortOrder: number,
	description: string,
	isSpeakerRole = false,
): SeedRole => ({ key, name, category, defaultCount, sortOrder, description, isSpeakerRole });

let order = 0;
const beat = (
	over: Partial<TemplateBeatRow> & { kind: TemplateBeatRow["kind"]; label: string },
): TemplateBeatRow => ({
	sortOrder: order++,
	detail: null,
	minutes: 0,
	roleKey: null,
	repeatsRoleKey: null,
	flex: false,
	markGreen: null,
	markYellow: null,
	markRed: null,
	...over,
});

export const CONTEST_TEMPLATE: TemplateSeed = {
	key: CONTEST_TEMPLATE_KEY,
	name: "Speech Contest",
	description:
		"A club contest: prepared speeches, impromptu speaking and speech evaluation, judged on paper ballots.",
	defaultLengthMinutes: 150,
	roles: [
		role("sergeant_at_arms", "Sergeant at Arms", "leadership", 1, 10,
			"Opens the room, seats guests and calls the contest to order."),
		role("contest_chair", "Contest Chair", "leadership", 1, 20,
			"Runs the contest: welcomes the room, explains the rules, introduces each contestant and announces the results."),
		role("chief_judge", "Chief Judge", "leadership", 1, 30,
			"Briefs the judges, collects and verifies the ballots, and certifies the result. Recruited from outside the club where possible."),
		role("judge", "Judge", "functionary", 5, 40,
			"Scores each contestant against the contest criteria and submits a ballot."),
		role("ballot_counter", "Ballot Counter", "functionary", 2, 50,
			"Collects ballots and tallies them with the Chief Judge, out of the room."),
		role("contest_timer", "Contest Timer", "functionary", 2, 60,
			"Times each contestant and signals the qualifying window; two timers so the times can be cross-checked."),
		role("test_speaker", "Test Speaker", "speaker", 1, 70,
			"Delivers the speech the evaluation contestants evaluate.", true),
		role("contestant", "Contestant", "speaker", 4, 80,
			"Competes in the contest. A contest speech can still be a Pathways project — attach it as you would any speech.", true),
	],
	beats: [
		beat({ kind: "section", label: "OPENING" }),
		beat({ kind: "role", label: "Call to order", roleKey: "sergeant_at_arms", minutes: 5,
			detail: "Opens the room and hands over to the Contest Chair." }),
		beat({ kind: "role", label: "Welcome and introductions", roleKey: "contest_chair", minutes: 5,
			detail: "Welcomes contestants, judges and guests." }),
		beat({ kind: "role", label: "Judges' briefing", roleKey: "chief_judge", minutes: 10,
			detail: "Briefs the judges and ballot counters, and confirms eligibility." }),
		beat({ kind: "role", label: "Contest rules and timing", roleKey: "contest_chair", minutes: 5,
			detail: "Explains the speaking area, the timing signals and the disqualification rules." }),

		beat({ kind: "section", label: "PREPARED SPEECH CONTEST" }),
		beat({ kind: "role", label: "Contestant", roleKey: "contestant", repeatsRoleKey: "contestant",
			minutes: 7, markGreen: 5, markYellow: 6, markRed: 7,
			detail: "Delivers the prepared speech." }),
		beat({ kind: "event", label: "One minute of silence", repeatsRoleKey: "contestant", minutes: 1,
			detail: "Judges complete their ballots." }),
		beat({ kind: "event", label: "Two minutes of silence", minutes: 2,
			detail: "After the final contestant, judges finish their ballots." }),
		beat({ kind: "role", label: "Contestant interviews", roleKey: "contest_chair", minutes: 5,
			detail: "Brief interviews while the ballots are collected." }),

		beat({ kind: "section", label: "IMPROMPTU SPEAKING CONTEST" }),
		beat({ kind: "role", label: "Contest briefing", roleKey: "contest_chair", minutes: 3,
			detail: "Explains the impromptu format and the question." }),
		beat({ kind: "role", label: "Contestant", roleKey: "contestant", repeatsRoleKey: "contestant",
			minutes: 2, markGreen: 1, markYellow: 1.5, markRed: 2,
			detail: "Answers the question." }),
		beat({ kind: "event", label: "One minute of silence", repeatsRoleKey: "contestant", minutes: 1,
			detail: "Judges complete their ballots." }),
		beat({ kind: "event", label: "Break", minutes: 10, detail: "Ballots are tallied." }),

		beat({ kind: "section", label: "SPEECH EVALUATION CONTEST" }),
		beat({ kind: "role", label: "Contest briefing", roleKey: "contest_chair", minutes: 3,
			detail: "Explains the evaluation format." }),
		beat({ kind: "role", label: "Test speech", roleKey: "test_speaker", minutes: 7,
			detail: "The speech every evaluation contestant evaluates." }),
		beat({ kind: "event", label: "Evaluation preparation", minutes: 5,
			detail: "Contestants prepare their evaluations out of the room." }),
		beat({ kind: "role", label: "Evaluation contestant", roleKey: "contestant", repeatsRoleKey: "contestant",
			minutes: 3, markGreen: 2, markYellow: 2.5, markRed: 3,
			detail: "Delivers the evaluation." }),
		beat({ kind: "event", label: "One minute of silence", repeatsRoleKey: "contestant", minutes: 1,
			detail: "Judges complete their ballots." }),

		beat({ kind: "section", label: "RESULTS AND CLOSING" }),
		beat({ kind: "role", label: "Tallying", roleKey: "ballot_counter", minutes: 10,
			detail: "Ballots are counted and verified with the Chief Judge." }),
		beat({ kind: "role", label: "Timers' report", roleKey: "contest_timer", minutes: 3,
			detail: "Reports each contestant's time and confirms who qualified." }),
		beat({ kind: "role", label: "Results and certificates", roleKey: "contest_chair", minutes: 10,
			detail: "Announces the winners and presents the certificates." }),
		beat({ kind: "role", label: "Closing remarks", roleKey: "contest_chair", minutes: 5,
			detail: "Thanks the judges, the organizing team and the guests." }),
	],
};
```

The three contestant blocks all repeat on `contestant`, which is correct: one contestant role is claimed per segment a member competes in. If a club wants separate rosters per segment, that is Phase 2 (three roles, three repeat keys) — do not add it now.

- [ ] **Step 4: Write the seeding script**

Create `scripts/seed-global-templates.ts`:

```ts
/**
 * Idempotently seeds the GLOBAL agenda templates. Safe to re-run: keyed on
 * `meeting_templates.key` where `club_id IS NULL`, and it REPLACES the
 * template's beats and roles rather than appending, so an edit to
 * `src/lib/contest-template.ts` reaches an already-seeded database.
 *
 * Materialized `role_definitions` rows are NOT touched — a club may have
 * renamed them, and #445 makes the club's own name authoritative.
 *
 * Run: bun run scripts/seed-global-templates.ts
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { CONTEST_TEMPLATE, type TemplateSeed } from "#/lib/contest-template";

async function seedTemplate(seed: TemplateSeed): Promise<void> {
	await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(and(eq(meetingTemplates.key, seed.key), isNull(meetingTemplates.clubId)))
			.limit(1);

		let templateId = existing?.id;
		if (templateId) {
			await tx
				.update(meetingTemplates)
				.set({
					name: seed.name,
					description: seed.description,
					defaultLengthMinutes: seed.defaultLengthMinutes,
				})
				.where(eq(meetingTemplates.id, templateId));
			await tx.delete(meetingTemplateBeats).where(eq(meetingTemplateBeats.templateId, templateId));
			await tx.delete(meetingTemplateRoles).where(eq(meetingTemplateRoles.templateId, templateId));
		} else {
			const [row] = await tx
				.insert(meetingTemplates)
				.values({
					clubId: null,
					key: seed.key,
					name: seed.name,
					description: seed.description,
					defaultLengthMinutes: seed.defaultLengthMinutes,
				})
				.returning({ id: meetingTemplates.id });
			if (!row) throw new Error(`Failed to insert template ${seed.key}`);
			templateId = row.id;
		}

		await tx.insert(meetingTemplateRoles).values(
			seed.roles.map((r) => ({
				templateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		);
		await tx.insert(meetingTemplateBeats).values(
			seed.beats.map((b) => ({ ...b, templateId })),
		);
	});
	console.log(`seeded template: ${seed.key}`);
}

await seedTemplate(CONTEST_TEMPLATE);
process.exit(0);
```

Deleting a template's roles is safe only because `meeting_template_roles` is not what slots reference — slots reference the materialized `role_definitions` rows, which this script leaves alone.

Add to `package.json` scripts: `"seed:templates": "bun run scripts/seed-global-templates.ts"`.

- [ ] **Step 4b: Write the re-sync escape hatch**

Materialization is deliberately **copy-once** (`.onConflictDoNothing()`), which means a later seed edit never reaches a club that has already run a contest. That is the same contract `ROLE_TEMPLATE` already has — it seeds `role_definitions` at club creation and editing the constant later reaches nobody — so this is the existing rule, not a new compromise. It is the right default because every materialized field (`name`, `defaultCount`, `category`, `description`) is club-editable via `updateClubRole`, and overwriting on each conversion would silently reset a club that deliberately set six contestants.

But it needs a deliberate escape hatch. Create `scripts/resync-template-roles.ts`:

```ts
/**
 * Push a seed change into ALREADY-materialized `role_definitions` rows.
 *
 * Materialization is copy-once by design (see `materializeTemplateRoles`), so a
 * template edit reaches only clubs that have never used it. This script is the
 * deliberate, auditable way to push one to everyone else. It PRINTS A DIFF and
 * changes nothing unless `--apply` is passed, because every field it touches is
 * one a club may have edited on purpose.
 *
 * Run: bun run scripts/resync-template-roles.ts <template-key> [--apply]
 */
```

It must: resolve the template by key where `club_id IS NULL`; for every `role_definitions` row with that `template_id`, compare `name` / `defaultCount` / `category` / `isSpeakerRole` / `description` against the seed; print one line per differing field as `club → role.field: current ⇒ seed`; exit without writing unless `--apply`. Never touch a row whose `key` is absent from the seed — a club may have added its own role to the template scope.

Add to `package.json`: `"resync:templates": "bun run scripts/resync-template-roles.ts"`.

- [ ] **Step 5: Call it from the dev seed**

In `src/db/seed.ts`, after the clubs are created, add:

```ts
	await seedGlobalTemplates();
```

and extract the `seedTemplate` body into an exported `seedGlobalTemplates()` in the script so both callers share it — or, if that fights the seed's structure, import and call the script's function directly. Do not duplicate the template rows.

- [ ] **Step 6: Run everything and verify**

```bash
bunx vitest run src/lib/contest-template.test.ts
bun run seed:templates
DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bun run seed:templates
bun run typecheck
```

Expected: 8 tests pass; the script prints `seeded template: speech_contest`; running it twice produces the same row count.

- [ ] **Step 7: Commit**

```bash
git add src/lib/contest-template.ts src/lib/contest-template.test.ts scripts/seed-global-templates.ts src/db/seed.ts package.json
git commit -m "feat(templates): seed the global Speech Contest template"
```

---

### Task 9: Wire the run sheet — both routes through one seam

**Files:**
- Modify: `src/server/meetings.ts` (the `loadMeetingDetail` payload, ~line 234 and ~line 405)
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx:375`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.print.tsx:156`
- Test: `src/lib/agenda-template-runsheet.test.ts`

**Interfaces:**
- Consumes: `resolveRunOfShow` (Task 4); `loadTemplateContent` (Task 5).
- Produces: `loadMeetingDetail`'s payload gains `template: { beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/agenda-template-runsheet.test.ts`:

```ts
/**
 * End-to-end through the PURE pipeline: template rows → Beat[] → expandRunSheet
 * → buildTimeline. Proves the adapter's output is something the existing run
 * sheet actually consumes, which unit-testing the adapter alone cannot show.
 */
import { describe, expect, it } from "vitest";
import { expandRunSheet, resolveRunOfShow } from "./agenda-runsheet";
import { buildTimeline } from "./agenda-timing";
import { CONTEST_TEMPLATE } from "./contest-template";

const roles = CONTEST_TEMPLATE.roles.map((r) => ({
	key: r.key, name: r.name, isSpeakerRole: r.isSpeakerRole,
}));

function slotsFor(spec: Record<string, number>) {
	return Object.entries(spec).flatMap(([key, n]) => {
		const role = CONTEST_TEMPLATE.roles.find((r) => r.key === key);
		if (!role) throw new Error(`no seeded role ${key}`);
		return Array.from({ length: n }, (_, i) => ({
			id: `${key}-${i}`,
			roleName: role.name,
			roleKey: key,
			category: role.category,
			isSpeakerRole: role.isSpeakerRole,
			slotIndex: i,
			assigneeName: null,
			speechTitle: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			evaluatesSlotId: null,
			evaluates: null,
		}));
	});
}

describe("contest run sheet", () => {
	const slots = slotsFor({
		sergeant_at_arms: 1, contest_chair: 1, chief_judge: 1, judge: 5,
		ballot_counter: 2, contest_timer: 2, test_speaker: 1, contestant: 4,
	});
	const beats = resolveRunOfShow({
		geIntroducesFunctionaries: false,
		template: { beats: CONTEST_TEMPLATE.beats, roles },
		slots,
	});

	it("produces rows the existing expander understands", () => {
		const rows = expandRunSheet(slots, beats);
		expect(rows.length).toBeGreaterThan(20);
		expect(rows.every((r) => typeof r.who === "string" && r.who.length > 0)).toBe(true);
		expect(rows.every((r) => Number.isFinite(r.minutes))).toBe(true);
	});

	it("names the Chief Judge and the contestants", () => {
		const rows = expandRunSheet(slots, beats);
		const who = rows.map((r) => r.who).join(" | ");
		expect(who).toContain("Chief Judge");
		expect(who).toContain("Contestant");
	});

	it("keeps every section band", () => {
		const rows = expandRunSheet(slots, beats);
		const who = rows.map((r) => r.who).join(" | ");
		for (const label of [
			"OPENING", "PREPARED SPEECH CONTEST", "IMPROMPTU SPEAKING CONTEST",
			"SPEECH EVALUATION CONTEST", "RESULTS AND CLOSING",
		]) {
			expect(who).toContain(label);
		}
	});

	it("books a shorter clock for fewer contestants", () => {
		const few = slotsFor({ contest_chair: 1, contestant: 2 });
		const many = slotsFor({ contest_chair: 1, contestant: 6 });
		const minutes = (s: typeof few) =>
			expandRunSheet(
				s,
				resolveRunOfShow({
					geIntroducesFunctionaries: false,
					template: { beats: CONTEST_TEMPLATE.beats, roles },
					slots: s,
				}),
			).reduce((sum, r) => sum + r.minutes, 0);
		expect(minutes(few)).toBeLessThan(minutes(many));
	});

	it("stamps a running clock", () => {
		const rows = buildTimeline(
			expandRunSheet(slots, beats),
			new Date("2026-09-12T13:00:00Z"),
			"America/Chicago",
		);
		expect(rows[0]?.time).toBe("8:00");
		expect(rows.at(-1)?.time).not.toBe(rows[0]?.time);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/agenda-template-runsheet.test.ts
```

Expected: FAIL initially only if Task 4's `resolveRunOfShow` is missing; otherwise it may pass immediately, which is fine — it is a regression net for the wiring below. If it passes, note that in the commit and continue.

- [ ] **Step 3: Put the template on the meeting payload**

In `src/server/meetings.ts`, the loader already selects the club's `geIntroducesFunctionaries` (~line 405). Select `meetings.templateId` alongside the other meeting columns, then after the slots are loaded:

```ts
	// The meeting's template content, or null for a standard meeting. One extra
	// round trip only when `template_id` is set (the two selects run in
	// parallel), so a normal meeting pays nothing.
	//
	// THROW rather than fall through. `resolveRunOfShow` reads `template: null`
	// as "standard meeting", so a templated meeting whose content failed to load
	// would silently render the STANDARD beats against CONTEST slots — and since
	// no contest slot matches `toastmaster_of_the_day` / `speaker` / any standard
	// key, almost every beat gates out and the officer gets a near-empty agenda
	// with no error at all. Loud failure beats a blank sheet on contest night.
	let template = null;
	if (meeting.templateId) {
		template = await loadTemplateContent(meeting.templateId);
		if (!template) {
			throw new Error(
				`Meeting ${meeting.id} references template ${meeting.templateId}, which has no beats or roles.`,
			);
		}
	}
```

Add a unit test for this arm in `src/lib/agenda-template-runsheet.test.ts` — `resolveRunOfShow` given a template with zero beats must not silently return the standard run-of-show:

```ts
it("does not fall back to the standard flow for an empty template", () => {
	const out = resolveRunOfShow({
		geIntroducesFunctionaries: false,
		template: { beats: [], roles: [] },
		slots: [],
	});
	expect(out).toEqual([]);
	expect(out).not.toEqual(buildRunOfShow({ geIntroducesFunctionaries: false }));
});
```

Add `template` to the returned payload and `import { loadTemplateContent } from "./meeting-templates-logic";` at the top. `meetings.ts` defines `createServerFn`s, so confirm this import does not create a top-level db-touching export in that module — it does not, because `loadTemplateContent` is only *called* inside handlers.

- [ ] **Step 4: Switch both routes to the seam**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, replace line 375's

```ts
expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries })),
```

with

```ts
expandRunSheet(
	slots,
	resolveRunOfShow({ geIntroducesFunctionaries, template, slots }),
),
```

pulling `template` from the loader data beside `geIntroducesFunctionaries` (~line 291). Swap the `buildRunOfShow` import for `resolveRunOfShow` (line 51).

In `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`, apply the same change at line 156, taking `template` from the loader data beside `geIntroducesFunctionaries` (~line 150) and swapping the import at line 22.

Both routes now build their run-of-show through one function, which is the point.

- [ ] **Step 5: Run the full agenda suite**

```bash
bunx vitest run src/lib/agenda-template-runsheet.test.ts src/lib/agenda-runsheet.test.ts src/lib/agenda-parity.test.ts src/lib/agenda-slides.test.ts
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bunx vitest run src/server/meetings-plan-payload.integration.test.ts
bun run typecheck
```

Expected: all PASS. `agenda-parity.test.ts` must still pass unchanged — a standard meeting's output has not moved.

- [ ] **Step 6: Commit**

```bash
git add src/server/meetings.ts src/routes/club.\$clubId.meeting.\$meetingId.tsx src/routes/club.\$clubId_.meeting.\$meetingId.print.tsx src/lib/agenda-template-runsheet.test.ts
git commit -m "feat(templates): render a templated meeting's run sheet through one seam"
```

---

### Task 10: The generic beat deck — **PR 2, not PR 1**

> **This task ships in a SECOND pull request.** PR 1 ends at Task 13. In PR 1 the Present button is hidden for a meeting with a `template_id`, with a short note in its place ("Projected deck for this meeting type is coming"); a contest chair runs the night off the printed script. Land PR 1, then this.
>
> Two fixes to fold in when you build it, both from the eng review: the `beat` slide's `label` and `who` were the same value (drop `label`, keep `who` — and see #463, which is the same complaint about `AgendaRow.who` generally); and the `·`-stripping hedge below is unnecessary — verified at `agenda-runsheet.ts:1697` that a section band takes the `renderUnowned` arm and emits a bare `owner.roleName` with no assignee suffix, because no slot can carry `SECTION_ROLE_KEY`.


**Files:**
- Modify: `src/lib/agenda-slides.ts`
- Modify: `src/lib/deck-to-pptx.ts`
- Modify: `src/components/agenda/meeting-present.tsx`
- Modify: `src/routes/club.$clubId_.meeting.$meetingId.present.tsx:71`
- Test: `src/lib/agenda-slides.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `resolveRunOfShow` (Task 4); `SlideDeckInput` (`agenda-slides.ts`).
- Produces: a new `Slide` variant `{ kind: "beat"; label: string; who: string; detail: string; minutes: number; section: string | null }`; `SlideDeckInput` gains `template: { beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agenda-slides.test.ts`:

```ts
describe("templated meeting deck", () => {
	const roles = CONTEST_TEMPLATE.roles.map((r) => ({
		key: r.key, name: r.name, isSpeakerRole: r.isSpeakerRole,
	}));
	const slots = [
		{ id: "chair", roleName: "Contest Chair", roleKey: "contest_chair", category: "leadership",
			isSpeakerRole: false, slotIndex: 0, assigneeName: "Ada Lovelace", speechTitle: null,
			projectLevel: null, minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null },
		{ id: "c0", roleName: "Contestant", roleKey: "contestant", category: "speaker",
			isSpeakerRole: true, slotIndex: 0, assigneeName: null, speechTitle: null,
			projectLevel: null, minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null },
	];

	function build() {
		return buildSlideDeck({
			meeting: BASE_MEETING,
			club: BASE_CLUB,
			slots,
			geIntroducesFunctionaries: false,
			ballotUrl: "https://example.test/ballot",
			template: { beats: CONTEST_TEMPLATE.beats, roles },
		});
	}

	it("opens with the title slide and closes with the thank-you slide", () => {
		const deck = build();
		expect(deck[0]?.kind).toBe("title");
		expect(deck.at(-1)?.kind).toBe("thankYou");
	});

	it("emits a beat slide per run-sheet row", () => {
		const deck = build();
		expect(deck.filter((s) => s.kind === "beat").length).toBeGreaterThan(5);
	});

	it("carries the assignee onto the slide", () => {
		const deck = build();
		const withAda = deck.filter((s) => s.kind === "beat" && s.who.includes("Ada Lovelace"));
		expect(withAda.length).toBeGreaterThan(0);
	});

	it("emits no vote, awards or word-of-the-day slides", () => {
		const deck = build();
		for (const kind of ["vote", "awards", "wordOfTheDay"]) {
			expect(deck.some((s) => s.kind === kind)).toBe(false);
		}
	});

	it("leaves a standard meeting's deck untouched", () => {
		const templated = build();
		const standard = buildSlideDeck({
			meeting: BASE_MEETING, club: BASE_CLUB, slots,
			geIntroducesFunctionaries: false,
			ballotUrl: "https://example.test/ballot",
			template: null,
		});
		expect(standard.some((s) => s.kind === "beat")).toBe(false);
		expect(standard).not.toEqual(templated);
	});
});
```

Import `CONTEST_TEMPLATE` at the top of that test file, and reuse whatever meeting/club fixtures the file already defines — replace `BASE_MEETING` / `BASE_CLUB` with the real fixture names in that file.

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/lib/agenda-slides.test.ts
```

Expected: FAIL — `SlideDeckInput` has no `template`.

- [ ] **Step 3: Add the slide kind and the branch**

In `src/lib/agenda-slides.ts`, add to the `Slide` union:

```ts
	| {
			/** One row of a TEMPLATED meeting's run sheet (#agenda-templates).
			 *  The standard deck composes slides by hand against the seven standard
			 *  role keys, which a template's roles are not; this kind is the generic
			 *  fallback that gives every template projection with no bespoke code. */
			kind: "beat";
			label: string;
			who: string;
			detail: string;
			minutes: number;
			/** The section band this row sits under, for the slide's eyebrow. */
			section: string | null;
	  }
```

Add `template` to `SlideDeckInput`:

```ts
	/** The meeting's template content, or null for a standard meeting. */
	template: {
		beats: TemplateBeatRow[];
		roles: TemplateRoleRow[];
	} | null;
```

At the top of `buildSlideDeck`, immediately after the title slide is pushed:

```ts
	// A templated meeting takes the generic path: its roles are not the seven
	// standard keys the slides below bind to, so every one of them would either
	// miss or project a segment that is not happening.
	if (template) {
		return [
			...deck,
			...buildTemplateBeatSlides({ template, slots }),
			{
				kind: "thankYou" as const,
				meetingSchedule: club.meetingSchedule,
				nextMeetingAt,
				timezone: club.timezone,
			},
		];
	}
```

Add the builder below `buildSlideDeck`:

```ts
/** One slide per run-sheet row, with the section band carried as an eyebrow
 *  rather than as a slide of its own — a full slide reading only
 *  "PREPARED SPEECH CONTEST" is a dead beat on a projector. */
function buildTemplateBeatSlides(input: {
	template: { beats: TemplateBeatRow[]; roles: TemplateRoleRow[] };
	slots: AgendaSlot[];
}): Slide[] {
	const beats = resolveRunOfShow({
		geIntroducesFunctionaries: false,
		template: input.template,
		slots: input.slots,
	});
	const rows = expandRunSheet(input.slots, beats);
	const slides: Slide[] = [];
	let section: string | null = null;
	for (const row of rows) {
		if (row.roleKey === SECTION_ROLE_KEY) {
			section = row.who;
			continue;
		}
		slides.push({
			kind: "beat",
			label: row.who,
			who: row.who,
			detail: row.detail,
			minutes: row.minutes,
			section,
		});
	}
	return slides;
}
```

Import `resolveRunOfShow`, `expandRunSheet`, `SECTION_ROLE_KEY`, `TemplateBeatRow`, `TemplateRoleRow`.

`expandRunSheet` renders a section band's `who` as the section label because the adapter set `roleName` to it and `renderUnowned: true`, so no assignee lookup happens. Confirm that by reading `expandRunSheet`'s role arm; if `who` comes out as `"LABEL · — open —"`, strip at the `·` here rather than changing `expandRunSheet`.

- [ ] **Step 4: Render it in present mode and the pptx export**

In `src/components/agenda/meeting-present.tsx`, add a case to the slide switch:

```tsx
		case "beat":
			return (
				<div className="flex h-full flex-col justify-center gap-6 px-16">
					{slide.section ? (
						<p className="text-2xl uppercase tracking-widest opacity-60">
							{slide.section}
						</p>
					) : null}
					<h2 className="text-6xl font-semibold">{slide.who}</h2>
					{slide.detail ? (
						<p className="text-3xl opacity-80">{slide.detail}</p>
					) : null}
					<p className="text-2xl opacity-60">{slide.minutes} min</p>
				</div>
			);
```

Match the surrounding cases' class conventions and wrapper element — copy the shape of the neighbouring case rather than this snippet's exact markup.

In `src/lib/deck-to-pptx.ts`, add a matching `case "beat":` that writes the section as a small eyebrow text box, the `who` as the title, and `detail` + minutes as body text. Follow the existing cases' `addText` calls exactly.

In `src/routes/club.$clubId_.meeting.$meetingId.present.tsx:71`, pass `template: data.template` into `buildSlideDeck` alongside `geIntroducesFunctionaries`.

Search for every other `buildSlideDeck(` call site and add `template` — `bun run typecheck` will name them all, since the field is required.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bunx vitest run src/lib/agenda-slides.test.ts src/lib/deck-to-pptx.test.ts src/lib/agenda-parity.test.ts
bun run typecheck
```

Expected: PASS. `agenda-parity.test.ts` must still pass — a standard deck has not changed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agenda-slides.ts src/lib/agenda-slides.test.ts src/lib/deck-to-pptx.ts src/components/agenda/meeting-present.tsx src/routes/club.\$clubId_.meeting.\$meetingId.present.tsx
git commit -m "feat(templates): generic beat-driven deck for templated meetings"
```

---

### Task 11: Print page count across a fixture matrix

**Files:**
- Modify: `src/components/agenda/print-page-count.test.tsx`

**Interfaces:**
- Consumes: `printedPageCount`, `printableDocument` (`#/test/print-page-count`); `PRINT_PAGE_CSS` (`#/components/agenda/print-theme`); `CONTEST_TEMPLATE`.
- Produces: nothing.

A contest agenda is **multi-page** — the one-sheet promise does not hold here and must not be asserted. What must hold is that the page count is *stable and bounded* across contestant counts, because `repeatsRoleKey` is exactly the code that varies with them.

- [ ] **Step 1: Write the failing test**

Append to `src/components/agenda/print-page-count.test.tsx`, following that file's existing render + `printableDocument` + `printedPageCount` pattern:

```tsx
describe("contest agenda print", () => {
	// A contest agenda is MULTI-page by nature, so this does not assert "1".
	// It asserts the count is bounded and grows with contestants, because
	// `repeatsRoleKey` is the code that varies across them — and per the repo's
	// fixture-matrix trap, a single-contestant-count fixture would let a
	// regression through on every other count.
	function renderContest(contestants: number, clubName: string) {
		const roles = CONTEST_TEMPLATE.roles.map((r) => ({
			key: r.key, name: r.name, isSpeakerRole: r.isSpeakerRole,
		}));
		const slots = CONTEST_TEMPLATE.roles.flatMap((r) => {
			const n = r.key === "contestant" ? contestants : r.defaultCount;
			return Array.from({ length: n }, (_, i) => ({
				id: `${r.key}-${i}`, roleName: r.name, roleKey: r.key,
				category: r.category, isSpeakerRole: r.isSpeakerRole, slotIndex: i,
				assigneeName: null, speechTitle: null, projectLevel: null,
				minMinutes: null, maxMinutes: null, evaluatesSlotId: null, evaluates: null,
			}));
		});
		const rows = buildTimeline(
			expandRunSheet(
				slots,
				resolveRunOfShow({
					geIntroducesFunctionaries: false,
					template: { beats: CONTEST_TEMPLATE.beats, roles },
					slots,
				}),
			),
			new Date("2026-09-12T13:00:00Z"),
			"America/Chicago",
		);
		// Mirror this file's existing `agendaHtml` (line ~159): it renders
		// `<MeetingAgendaPrint>` directly via `renderToStaticMarkup`, with
		// `layout`, `header`, `roles`, `officers`, `explainers`, `rows` and
		// `ballotUrl`. There is NO route-wrapper helper for the agenda in this
		// file — the `.pgwrap` reproduction at line ~231 belongs to the WORD
		// POSTER tests, not this one. Copy `agendaHtml`'s shape and swap `rows`.
		return renderToStaticMarkup(
			<MeetingAgendaPrint
				layout="editorial"
				header={{ ...header, clubName }}
				roles={[]}
				officers={[]}
				explainers={[]}
				rows={rows}
				ballotUrl={BALLOT_URL}
			/>,
		);
	}

	it.each([4, 6, 7])("prints a bounded sheet count with %i contestants", (n) => {
		const html = printableDocument(PRINT_PAGE_CSS, renderContest(n, "Toastmasters Club"));
		const pages = printedPageCount(html);
		expect(pages).toBeGreaterThan(0);
		expect(pages).toBeLessThanOrEqual(4);
	});

	it("does not gain a page from a long club name alone", () => {
		const short = printedPageCount(
			printableDocument(PRINT_PAGE_CSS, renderContest(6, "Acme")),
		);
		const long = printedPageCount(
			printableDocument(
				PRINT_PAGE_CSS,
				renderContest(6, "The Extraordinarily Long Named Toastmasters Club of Greater Somewhere"),
			),
		);
		expect(long).toBe(short);
	});

	it("prints a non-empty document (the unstated-zero control)", () => {
		const html = printableDocument(PRINT_PAGE_CSS, renderContest(6, "Acme"));
		expect(html).toContain("Chief Judge");
		expect(html.length).toBeGreaterThan(2000);
	});
});
```

Reuse the `header`, `BALLOT_URL` and `pages()` bindings already defined at the top of that file rather than inventing new ones. Note the deliberate asymmetry with the word-poster tests below in the same file: those reproduce the route's `.pgwrap` wrapper because that reset is what they exist to pin, while the agenda tests render the component directly. Follow the agenda convention here — this test is about how many sheets the contest's ROWS produce, not about the page reset, which `print-page-reset.guard.test.ts` already covers for every route.

- [ ] **Step 2: Run test to verify it fails or skips honestly**

```bash
CHROME_PATH="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | head -1)" \
  bunx vitest run src/components/agenda/print-page-count.test.tsx
```

If `CHROME_PATH` resolves empty, the whole file skips and you have verified nothing. Install the shell first:

```bash
bunx playwright install chromium-headless-shell
```

Expected once Chrome resolves: FAIL, because the contest fixture does not compile yet.

- [ ] **Step 3: Make it pass**

Adjust only the fixture and the page-count ceiling. If a 7-contestant contest genuinely needs 5 sheets, raise the bound to the measured number and say so in a comment — but confirm first that the growth is content and not a layout bug, by eyeballing the PDF:

```bash
bunx vitest run src/components/agenda/print-page-count.test.tsx --reporter=verbose
```

- [ ] **Step 4: Run the full print suite**

```bash
CHROME_PATH="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell | head -1)" \
  bunx vitest run src/components/agenda/print-page-count.test.tsx src/components/agenda/print-density.test.tsx src/routes/print-page-reset.guard.test.ts
```

Expected: PASS, with no skips.

- [ ] **Step 5: Commit**

```bash
git add src/components/agenda/print-page-count.test.tsx
git commit -m "test(templates): contest print page count across 4/6/7 contestants"
```

---

### Task 12: The picker and convert dialog

**Files:**
- Create: `src/components/agenda/meeting-template-dialog.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (officer action area)
- Test: `src/components/agenda/meeting-template-dialog.test.tsx`

**Interfaces:**
- Consumes: `listTemplatesForClub`, `previewTemplateForMeeting`, `applyTemplateToMeeting` (Task 7); `MeetingTemplateSummary`, `ConversionPlan`.
- Produces: `<MeetingTemplateDialog meetingId clubId currentTemplateId open onOpenChange />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/agenda/meeting-template-dialog.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MeetingTemplateDialog } from "./meeting-template-dialog";

const TEMPLATES = [
	{ id: "t1", key: "speech_contest", name: "Speech Contest", description: "A club contest", defaultLengthMinutes: 150 },
];

const PLAN = {
	openSlotsRemoved: 9,
	claimedSlotsReleased: 2,
	slotsWithSpeeches: 1,
	releasedHolders: [
		{ memberId: "m1", guestId: null, name: "Ada Lovelace", roleName: "Speaker" },
		{ memberId: "m2", guestId: null, name: "Grace Hopper", roleName: "Evaluator" },
	],
};

function setup(over: Partial<Parameters<typeof MeetingTemplateDialog>[0]> = {}) {
	const onApply = vi.fn().mockResolvedValue(PLAN);
	const props = {
		open: true,
		onOpenChange: vi.fn(),
		currentTemplateId: null,
		templates: TEMPLATES,
		loadPreview: vi.fn().mockResolvedValue(PLAN),
		onApply,
		...over,
	};
	render(<MeetingTemplateDialog {...props} />);
	return { props, onApply };
}

describe("MeetingTemplateDialog", () => {
	it("lists the standard meeting and every template", () => {
		setup();
		expect(screen.getByText("Standard meeting")).toBeInTheDocument();
		expect(screen.getByText("Speech Contest")).toBeInTheDocument();
	});

	it("shows the preview before anything is applied", async () => {
		const { onApply } = setup();
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => expect(screen.getByText(/2 claimed roles/i)).toBeInTheDocument());
		expect(onApply).not.toHaveBeenCalled();
	});

	it("names every member whose role will be released", async () => {
		setup();
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());
		expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
	});

	it("reassures that speeches survive", async () => {
		setup();
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => expect(screen.getByText(/speech.*kept|kept.*speech/i)).toBeInTheDocument());
	});

	it("applies only after confirmation", async () => {
		const { onApply } = setup();
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => screen.getByRole("button", { name: /Apply/i }));
		await userEvent.click(screen.getByRole("button", { name: /Apply/i }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith("t1"));
	});

	it("marks the current template as current", () => {
		setup({ currentTemplateId: "t1" });
		expect(screen.getByText(/current/i)).toBeInTheDocument();
	});

	it("says how many roles it will add", async () => {
		setup();
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => expect(screen.getByText(/adds 14 roles/i)).toBeInTheDocument());
	});

	// The critical gap from the eng review: a failed preview previously left a
	// blank panel with no message and no way forward.
	it("shows an error and keeps Apply disabled when the preview fails", async () => {
		setup({ loadPreview: vi.fn().mockRejectedValue(new Error("network")) });
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => expect(screen.getByText(/could not load/i)).toBeInTheDocument());
		expect(screen.getByRole("button", { name: /Apply/i })).toBeDisabled();
	});

	it("recovers when Retry succeeds", async () => {
		const loadPreview = vi
			.fn()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(PLAN);
		setup({ loadPreview });
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => screen.getByRole("button", { name: /Retry/i }));
		await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
		await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());
	});

	it("does not fire a second conversion on a double-click", async () => {
		let resolveApply: (v: unknown) => void = () => {};
		const onApply = vi.fn(() => new Promise((r) => { resolveApply = r; }));
		setup({ onApply });
		await userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));
		await waitFor(() => screen.getByRole("button", { name: /Apply/i }));
		const apply = screen.getByRole("button", { name: /Apply/i });
		await userEvent.click(apply);
		await userEvent.click(apply);
		expect(onApply).toHaveBeenCalledTimes(1);
		resolveApply(PLAN);
	});
});
```

The component takes `templates`, `loadPreview` and `onApply` as props rather than calling the server fns itself — that is what makes it testable without the Start runtime, and matches how the repo's other dialogs are structured. The route wires the real fns in.

- [ ] **Step 2: Run test to verify it fails**

```bash
bunx vitest run src/components/agenda/meeting-template-dialog.test.tsx
```

Expected: FAIL — cannot resolve `./meeting-template-dialog`.

- [ ] **Step 3: Write the component**

Create `src/components/agenda/meeting-template-dialog.tsx`. Open `src/components/agenda/meeting-meta-dialog.tsx` first and copy its Dialog structure, imports and button conventions exactly.

Required behaviour, all covered by the tests above:

1. A list of choices: "Standard meeting" (`templateId: null`) plus one row per template, each showing `name` and `description`, with the current one badged "Current".
2. Selecting one calls `loadPreview(templateId)` and renders the returned `ConversionPlan`: "Removes N open roles", "Releases M claimed roles", "Adds N roles" (`slotsAdded`), and — when `slotsWithSpeeches > 0` — an explicit line that attached speeches are **kept**, because that is the thing an officer will most fear losing.
2b. The panel is a three-state machine, not a single loaded view:

```
        select template
              │
              ▼
        ┌───────────┐  reject   ┌─────────┐
        │  loading  │──────────▶│ failed  │
        └─────┬─────┘           └────┬────┘
              │ resolve              │ Retry
              ▼                      │
        ┌───────────┐◀───────────────┘
        │  loaded   │   Apply ──▶ pending ──▶ close
        └───────────┘   (button disabled while pending)
```

`failed` shows the reason plus a Retry button and keeps Apply disabled. `pending` disables Apply so a double-click cannot fire two conversions. Without these, a flaky club-room connection leaves the officer staring at a blank panel with no message and no way forward, on the one dialog in the app that confirms a destructive change.
3. Every `releasedHolders` entry renders as its `name` and `roleName`, so the officer can see exactly who to message. Where the repo's WhatsApp nudge component takes a member id, render it beside each name; if it needs a phone the dialog does not have, render the name alone and leave the nudge to the roster.
4. An "Apply" button, disabled until a preview has loaded, calling `onApply(templateId)`.
5. No destructive action reachable without the preview having rendered first.

Use `Button`, `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` from `#/components/ui`. Do not colour any anchor — the unlayered global `a` rule in `src/styles.css` overrides layered utilities, and a link in here would repaint teal.

- [ ] **Step 4: Wire it into the meeting route**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, add a "Change meeting type" item to the officer action area, visible only when the viewer can manage the club (reuse the existing `canManage` / `canEdit` flag the loader already returns). Wire `templates` from `listTemplatesForClub`, `loadPreview` to `previewTemplateForMeeting`, and `onApply` to `applyTemplateToMeeting` followed by a query invalidation so the agenda re-renders.

Follow the file's existing pattern for calling a server fn from a mutation — copy a neighbouring mutation rather than inventing one.

- [ ] **Step 5: Run tests to verify they pass**

```bash
bunx vitest run src/components/agenda/meeting-template-dialog.test.tsx
bun run typecheck
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/agenda/meeting-template-dialog.tsx src/components/agenda/meeting-template-dialog.test.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(templates): meeting type picker with a destructive-change preview"
```

---

### Task 13: Full gate, docs, and cleanup

**Files:**
- Modify: `CONTEXT.md` (Glossary)
- Modify: `CLAUDE.md` (Data layer section)
- Modify: `TODOS.md`

- [ ] **Step 1: Run every gate**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
export CHROME_PATH="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell | head -1)"
bun run test
bun run typecheck
```

Expected: all green, with the DB-backed and print suites **running, not skipping**. Confirm the test count is in the thousands, not the hundreds — a low count means `TEST_DATABASE_URL` did not take and you have verified nothing.

- [ ] **Step 2: Add the glossary entry**

Append to `CONTEXT.md`'s Glossary:

```markdown
**Meeting template** — a named bundle of a role set plus a flat run-of-show, letting a meeting
run a shape other than the club's standard night (today: Speech Contest). `meetings.template_id`
NULL is the standard meeting and reads the code-derived `RUN_OF_SHOW`; a templated meeting reads
`meeting_template_beats` through `resolveRunOfShow`. A template's roles are materialized into
`role_definitions` with `template_id` set, because `role_slots.role_definition_id` is a NOT NULL
restricting FK — which is also why `/admin/roles` filters `template_id IS NULL`. Templates are
GLOBAL (`meeting_templates.club_id IS NULL`) in Phase 1; club-authored ones and the editor are
Phase 2. See `docs/superpowers/specs/2026-08-19-agenda-templates-design.md`.
```

- [ ] **Step 3: Add the CLAUDE.md note**

Append to the **Data layer** section of `CLAUDE.md`:

```markdown
**A template's beats are FLAT; the standard run-of-show's are not.** `meeting_template_beats`
carries no `requiresAnyOf` / `requiresGroup` / `fallbacks` / tokens, and that is deliberate: the
standard run-of-show needs those gates because it must adapt to whichever roles a club actually
runs, and a contest's shape is fixed by the contest rules. Do not "unify" the two by making
`RUN_OF_SHOW` storable — `agenda-parity.test.ts` cannot prove such a migration faithful, because
a parity test cannot see a defect present on both sides.

**A conversion cannot notify through `notifications`.** `notifications.slot_id` is NOT NULL and
ON DELETE CASCADE to `role_slots`, so a row enqueued against a slot the same transaction deletes
is cascade-deleted before the poller sees it. `applyTemplateConversion` returns
`releasedHolders` and the UI surfaces the WhatsApp nudge instead.
```

- [ ] **Step 4: Record the Phase 2 follow-ups**

Append to `TODOS.md` under a new `## Agenda templates` heading:

```markdown
- Phase 2: club-authored templates (copy a global into the club and edit it) and the template
  editor UI. The storage is already data, so this needs no migration — only writes and a UI.
  **Priority:** P3

- Converting standard → contest → standard rebuilds slots in both directions and loses
  assignments both ways, because each template owns its own role definitions and there is no
  overlap to preserve. The preview makes it visible before it happens. Slot preservation across
  templates was deliberately deferred.
  **Priority:** P4

- A contest's three segments all repeat on the single `contestant` role, so a member competing
  in only one segment still occupies a contestant slot in all three. Separate per-segment
  rosters means three roles and three repeat keys — a seed change, not a code change.
  **Priority:** P3
```

- [ ] **Step 5: Run the lint gate last**

```bash
bun run fix
bunx biome check --diagnostic-level=error
bun run typecheck
```

Expected: no errors. Read the gate with `--diagnostic-level=error` — `seed.ts`'s ~118 pre-existing warnings otherwise bury a real one.

- [ ] **Step 6: Commit**

```bash
git add CONTEXT.md CLAUDE.md TODOS.md
git commit -m "docs(templates): glossary, the two traps worth remembering, and Phase 2 follow-ups"
```

- [ ] **Step 7: Confirm the standard meeting did not move**

The single most important regression check in this plan. On a meeting with `template_id IS NULL`, the printed run sheet, the screen agenda and the projected deck must be **byte-identical** to what they were before Task 1.

```bash
bun run dev
```

Open a seeded club's upcoming meeting, its `/print` route and its `/present` route. Compare against `git stash`-free `main` if in any doubt. `agenda-parity.test.ts` passing is necessary but not sufficient — it compares the two derivations against each other, not against history.

---

## Self-Review Notes

**Spec coverage.** D1 → Tasks 3, 4, 9. D2 → Task 5. D3 → Task 1. D4 → Tasks 3, 8, 11. D5 → Tasks 6, 7. D6 → Task 10. D7 → Task 8. Data model → Task 1. Slot generation → Task 5. Conversion → Tasks 6, 7, 12. Run sheet → Tasks 4, 9. Deck → Task 10. Module layout → Tasks 5, 7. Test plan → Tasks 1, 2, 3, 5, 6, 7, 8, 11, 13. Accepted limitations → recorded in Task 13's TODOS entries.

**Known soft spots, flagged rather than hidden.** Two places tell the implementer to read the surrounding code and match it instead of trusting a snippet: the `createServerFn` call shape (Task 7, now corrected to the function form this repo actually uses) and the present-mode slide markup (Task 10). Task 11's soft spot was a factual error and is fixed — this repo's agenda print tests render `<MeetingAgendaPrint>` directly and there is no route-wrapper helper for them.

**Type consistency.** `TemplateBeatRow` / `TemplateRoleRow` are defined once in Task 3 and used verbatim in Tasks 4, 5, 8, 9, 10. `ConversionPlan` / `ReleasedHolder` are defined in Task 6 and consumed in Tasks 7 and 12. `SECTION_ROLE_KEY` is defined in Task 3 and consumed in Task 10. `MeetingSlotDefs` is the existing export from `meeting-create-logic.ts` and is not redefined. `roleDefScope` is defined in Task 5 and consumed by Task 6's preview.

---

## Implementation Tasks

Synthesized from the 2026-08-19 eng review. Each derives from a specific finding; all are folded into the task bodies above, so this list is the audit trail rather than extra work.

- [ ] **T1 (P1, human: ~5min / CC: ~1min)** — schema — Store timer marks as `real`, not `numeric`
  - Surfaced by: Architecture — `numeric` appears in zero of 35 tables; drizzle returns it as a string without a mode flag unverified at 0.45.1
  - Files: `src/db/schema.ts`
  - Verify: `bun run typecheck` and the Task 1 integration suite
- [ ] **T2 (P1, human: ~10min / CC: ~2min)** — server/templates — Move the tenant filter from JS into SQL
  - Surfaced by: Architecture — `listAvailableTemplates` selected every club's rows then `.filter()`ed in app code
  - Files: `src/server/meeting-templates-logic.ts`, `src/server/meeting-templates-logic.integration.test.ts`
  - Verify: the new "never lists ANOTHER club's template" test fails if the `or(isNull…)` is removed
- [ ] **T3 (P1, human: ~45min / CC: ~8min)** — server/templates — Split materialize out of `resolveMeetingRoleDefs`
  - Surfaced by: Code quality — a read that writes forced the preview to duplicate the scope predicate
  - Files: `src/server/meeting-templates-logic.ts`, both its test files
  - Verify: preview and apply both route through `roleDefScope`; "resolves EMPTY for an un-materialized template" passes
- [ ] **T4 (P1, human: ~30min / CC: ~5min)** — server/meetings — Throw when a templated meeting's content fails to load
  - Surfaced by: Failure modes — **critical gap**: `template: null` reads as "standard meeting", so a contest would silently render standard beats against contest slots and print a near-empty sheet
  - Files: `src/server/meetings.ts`, `src/lib/agenda-template-runsheet.test.ts`
  - Verify: `resolveRunOfShow` with an empty template returns `[]`, not the standard run-of-show
- [ ] **T5 (P1, human: ~1.5h / CC: ~12min)** — components/agenda — Three-state dialog with retry and a pending guard
  - Surfaced by: Tests — **critical gap**: a rejected preview left a blank panel, no message, no recovery, on a destructive-action confirmation
  - Files: `src/components/agenda/meeting-template-dialog.tsx` + test
  - Verify: the four new dialog tests (error shown, Apply disabled, retry recovers, double-click fires once)
- [ ] **T6 (P2, human: ~20min / CC: ~4min)** — server/templates — Drop the existence check, parallelize the two selects
  - Surfaced by: Performance — three sequential queries added to a loader TODOS.md already flags at ~15 sequential round trips
  - Files: `src/server/meeting-templates-logic.ts`
  - Verify: `loadTemplateContent` issues two statements, concurrently (`statementsDuring`, `src/test/query-spy.ts`)
- [ ] **T7 (P2, human: ~1.5h / CC: ~12min)** — scripts — Add `resync-template-roles.ts` with a dry-run diff
  - Surfaced by: Architecture — copy-once materialization means a seed edit never reaches a club that already used the template
  - Files: `scripts/resync-template-roles.ts`, `package.json`
  - Verify: run against a club with a renamed role; prints the diff, writes nothing without `--apply`
- [ ] **T8 (P2, human: ~30min / CC: ~6min)** — server/templates — Add `slotsAdded` to `ConversionPlan`
  - Surfaced by: Tests — the spec's dialog copy promises "adds 14 contest roles" and the plan had no such field
  - Files: `src/server/meeting-templates-logic.ts`, conversion test, dialog + test
  - Verify: 4 on a first preview, 0 on a re-apply
- [ ] **T9 (P2, human: ~40min / CC: ~8min)** — tests — Close the six remaining coverage gaps
  - Surfaced by: Test review — flex passthrough, guest-held release, NULL `defaultLengthMinutes`, re-apply preview, un-materialized resolve, `template` on the payload
  - Files: the Task 3, 5, 6 and 9 test files
  - Verify: `TEST_DATABASE_URL=… bun run test`, count in the thousands not hundreds
- [ ] **T10 (P3, human: ~5min / CC: ~1min)** — docs — Fix the stale Codex claim in CLAUDE.md
  - Surfaced by: Outside voice preflight — CLAUDE.md says `codex_reviews=disabled`; `gstack-config get codex_reviews` returns `enabled`
  - Files: `CLAUDE.md`
  - Verify: the doc matches `gstack-config get codex_reviews`

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_OPEN (PLAN) | 6 issues, 2 critical gaps, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Scope:** SCOPE_REDUCED — split into two PRs at the deck (PR 1 = Tasks 1-9, 11, 12, 13; PR 2 = Task 10).

**Findings folded:** `real` over `numeric` (T1); tenant filter into SQL (T2); materialize split out of the resolver (T3); throw instead of silently rendering the standard flow (T4); three-state dialog with retry and pending guard (T5); parallelized template load (T6); re-sync escape hatch (T7); `slotsAdded` (T8); six coverage gaps (T9). Three factual errors about this repo corrected without a decision: the `.validator()` call shape, the non-existent `renderPrintSurface` helper, and an unnecessary `·`-stripping hedge.

**Critical gaps found (both closed in-plan):** a templated meeting whose content fails to load rendering the standard run-of-show against contest slots and printing a near-empty sheet; and a failed preview leaving a blank dialog with no message and no recovery.

**VERDICT:** ENG REVIEW COMPLETE — 6 issues found and folded, 2 unresolved decisions below. Not CLEAR until those are settled.

**UNRESOLVED DECISIONS:**
- Outside voice never ran. The Claude subagent fallback terminated on an API session limit before producing findings, and Codex is not installed. Nothing independent has read this plan — re-run `/plan-eng-review` or `/codex review` after the limit resets if you want that check before implementing.
- TODOS.md proposals were not walked through individually. Three candidates are recorded as T7/T10 above and in Task 13's TODOS block rather than being agreed one by one: the re-sync script's operational burden, the stale CLAUDE.md Codex claim, and measuring the Task 2 caps before Phase 2 exposes a template editor.
