# Agenda Templates (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a club run a meeting with a different shape — starting with a speech contest — by giving a meeting an optional template that supplies its own claimable role set and its own run-of-show.

**Architecture:** `meetings.template_id` is nullable and NULL means the existing code path runs unchanged. Templates live in three new tables; their roles are materialized into `role_definitions` (because `role_slots.role_definition_id` is a `NOT NULL` restricting FK) and their run-of-show is a flat, ungated beat list adapted into the existing `Beat[]` type, so `expandRunSheet` and everything downstream of it stays untouched.

**Tech Stack:** TanStack Start (React 19, SSR via Nitro), Drizzle ORM on PostgreSQL via `node-postgres`, Vitest, Biome, Tailwind v4 + shadcn/ui, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-08-19-agenda-templates-design.md` — read it first. This plan implements it and argues from it; where they disagree, the spec wins and the plan is wrong.

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
		// Timer-card marks in minutes, all three or none.
		markGreen: numeric("mark_green", { mode: "number" }),
		markYellow: numeric("mark_yellow", { mode: "number" }),
		markRed: numeric("mark_red", { mode: "number" }),
	},
	(t) => [
		uniqueIndex("meeting_template_beats_order_unique").on(t.templateId, t.sortOrder),
	],
);
```

Add `numeric` to the `drizzle-orm/pg-core` import at the top of the file if it is not already there.

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
 * Picked against the measured cost curve, not against the current seed: the
 * contest seed is ~30 beats and 8 roles, so every ceiling here has room for a
 * far larger template while staying an order of magnitude below the point where
 * a single render becomes a blocked event loop.
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

	it("resolves only the template's defs when a template is given, materializing first", async () => {
		const id = await makeContestTemplate();
		const defs = await resolveMeetingRoleDefs(testDb, club.clubId, id);
		expect(defs).toHaveLength(2);
		const rows = await testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.templateId, id));
		expect(rows).toHaveLength(2);
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
	const rows = await database
		.select({
			id: meetingTemplates.id,
			key: meetingTemplates.key,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
			clubId: meetingTemplates.clubId,
			sortOrder: meetingTemplates.sortOrder,
		})
		.from(meetingTemplates)
		.where(eq(meetingTemplates.enabled, true))
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));

	return rows
		.filter((r) => r.clubId === null || r.clubId === clubId)
		.map(({ clubId: _clubId, sortOrder: _sortOrder, ...rest }) => rest);
}

/** A template's beats and roles, ordered. Null when the template is unknown. */
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	const [tpl] = await database
		.select({ id: meetingTemplates.id })
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, templateId))
		.limit(1);
	if (!tpl) return null;

	const beats = await database
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

	const roles = await database
		.select({
			key: meetingTemplateRoles.key,
			name: meetingTemplateRoles.name,
			isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
		})
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));

	return { beats, roles };
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
 * The role definitions a meeting's slots are generated from: the club's own
 * ENABLED standard roles when there is no template, or the template's roles
 * (materializing them on first use) when there is.
 *
 * `generateSlotRows` itself is unchanged — the CALLER decides which definitions
 * it sees, which keeps the blast radius of templates off the slot generator.
 */
export async function resolveMeetingRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<MeetingSlotDefs[]> {
	if (templateId !== null) {
		await materializeTemplateRoles(conn, clubId, templateId);
	}
	const scope =
		templateId === null
			? and(isNull(roleDefinitions.templateId), eq(roleDefinitions.enabled, true))
			: eq(roleDefinitions.templateId, templateId);

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
		.where(and(eq(roleDefinitions.clubId, clubId), scope))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
}
```

If `MeetingSlotDefs` (`= SlotGenInput & RoleDefLite`) needs fields beyond those selected, open `src/lib/meeting-roles.ts`, read `RoleDefLite`, and add exactly its fields to the select. Do not widen `SlotGenInput`.

The unused `isNotNull` import above is a placeholder only if the compiler needs it — remove it if `bun run fix` flags it.

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
): ConversionPlan {
	const doomed = current.filter((s) => !keepDefIds.has(s.roleDefinitionId));
	const held = doomed.filter((s) => s.assignedMemberId || s.assignedGuestId);
	return {
		openSlotsRemoved: doomed.length - held.length,
		claimedSlotsReleased: held.length,
		slotsWithSpeeches: doomed.filter((s) => s.speechId !== null).length,
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
	// Preview must NOT materialize: a preview that writes rows would leave a
	// club's role_definitions littered with templates nobody applied.
	const target =
		templateId === null
			? await database
					.select({ id: roleDefinitions.id })
					.from(roleDefinitions)
					.where(
						and(
							eq(roleDefinitions.clubId, meeting.clubId),
							isNull(roleDefinitions.templateId),
							eq(roleDefinitions.enabled, true),
						),
					)
			: await database
					.select({ id: roleDefinitions.id })
					.from(roleDefinitions)
					.where(
						and(
							eq(roleDefinitions.clubId, meeting.clubId),
							eq(roleDefinitions.templateId, templateId),
						),
					);

	return summarize(current, new Set(target.map((r) => r.id)));
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

		const defs = await resolveMeetingRoleDefs(tx, clubId, templateId);
		const keepDefIds = new Set(defs.map((d) => d.id));
		const current = await loadSlotsForConversion(tx, meetingId);
		const plan = summarize(current, keepDefIds);

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
	.validator(clubInput)
	.handler(async ({ data }): Promise<MeetingTemplateSummary[]> => {
		const user = await requireUser();
		await assertClubNotArchived(data.clubId);
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return listAvailableTemplates(data.clubId);
	});

export const previewTemplateForMeeting = createServerFn({ method: "GET" })
	.validator(meetingTemplateInput)
	.handler(async ({ data }): Promise<ConversionPlan> => {
		await requireMeetingAdmin(data.meetingId);
		return planTemplateConversion(data.meetingId, data.templateId);
	});

export const applyTemplateToMeeting = createServerFn({ method: "POST" })
	.validator(meetingTemplateInput)
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
	// round trip only when `template_id` is set, so a normal meeting pays nothing.
	const template = meeting.templateId
		? await loadTemplateContent(meeting.templateId)
		: null;
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

### Task 10: The generic beat deck

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
		// Reuse this file's existing helper that renders the print surface with
		// the ROUTE's wrapper elements (.pgwrap and the no-print toolbar) — a
		// fixture that renders only the component cannot observe those resets.
		return renderPrintSurface({ rows, clubName });
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

`renderPrintSurface` is a placeholder for whatever this file already uses to render the print route *with its wrapper elements*. Open the file, find that helper, and call it — do not render the bare component, because `.pgwrap` lives on the route's page component and a component-only fixture cannot observe the reset that keeps the page count honest.

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
2. Selecting one calls `loadPreview(templateId)` and renders the returned `ConversionPlan`: "Removes N open roles", "Releases M claimed roles", and — when `slotsWithSpeeches > 0` — an explicit line that attached speeches are **kept**, because that is the thing an officer will most fear losing.
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

**Known soft spots, flagged rather than hidden.** Three places tell the implementer to read the surrounding code and match it instead of trusting a snippet: the `createServerFn` call shape (Task 7), the print-surface render helper (Task 11), and the present-mode slide markup (Task 10). Those are genuine "follow the local pattern" points, not placeholders — each names exactly what to read and what to match.

**Type consistency.** `TemplateBeatRow` / `TemplateRoleRow` are defined once in Task 3 and used verbatim in Tasks 4, 5, 8, 9, 10. `ConversionPlan` / `ReleasedHolder` are defined in Task 6 and consumed in Tasks 7 and 12. `SECTION_ROLE_KEY` is defined in Task 3 and consumed in Task 10. `MeetingSlotDefs` is the existing export from `meeting-create-logic.ts` and is not redefined.
