# Agenda Role-History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill past `meetings` + `role_slots` + `speeches` from ~2 years of Google-Doc meeting agendas so member profiles and the scheduler have real role/speech history.

**Architecture:** A one-time pipeline in three stages. (1) **Extraction** — the main agent (with Drive MCP access) reads each agenda and emits one JSON record per meeting into `ref/agendas/`. (2) **Pure logic** — `import-agendas-logic.ts` turns a JSON record + club roster + role definitions into planned DB writes and an unmatched-name report (no DB, fully unit-tested). (3) **Writer** — `import-agendas.ts` (a standalone Bun script mirroring `scripts/import-members.ts`) loads the dataset, resolves roster/role-defs from the DB, calls the logic, and — behind a `--commit` flag (dry-run by default) — upserts idempotently. No schema changes.

**Tech Stack:** TypeScript (strict), Bun runtime, Drizzle ORM + node-postgres, Vitest, Biome. Import alias `#/*` → `src/*`.

**Spec:** `docs/superpowers/specs/2026-07-08-agenda-role-history-backfill-design.md`

---

## Prerequisites (executor read first)

- Work in an isolated worktree (see `superpowers:using-git-worktrees`). A fresh worktree needs `bun install` and a copied `.env.local` before any `bun run`/DB command works.
- Integration tests need a Postgres test DB. Set `TEST_DATABASE_URL` to the `tm_test` database on the running `dev-postgres` container (see `scripts/import-members.integration.test.ts` for the pattern). Do NOT rely on plain `bun run test` masking skipped DB suites.
- **Task 6 (extraction) requires Drive MCP access and is performed by the main agent or the user — not a code subagent.** Tasks 1–5 and 7 are ordinary code/TDD and can be dispatched to subagents. If a subagent hits Task 6, it should stop and hand back.
- Run a single test file with `bunx vitest run <path>`. Lint/format gate: `bun run check`.

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/import-agendas-logic.ts` | Pure functions: name normalize/match, role-label mapping, and `planMeetingImport` (record → planned writes + report). No DB, no I/O. |
| `scripts/import-agendas-logic.test.ts` | Vitest unit tests for the logic, using small handwritten fixtures. |
| `scripts/import-agendas.ts` | Standalone Bun CLI: load env, read `ref/agendas/*.json` + `aliases.json`, fetch roster + role defs from DB, call logic, print report; `--commit` applies writes idempotently. |
| `scripts/import-agendas.integration.test.ts` | Integration test against `tm_test`: idempotency (run writer twice → no duplicates) + evaluator pairing. |
| `ref/agendas/*.json` | Extracted dataset — one file per meeting (Task 6). |
| `ref/agendas/aliases.json` | Hand-editable name alias map (Task 6, pre-seeded). |
| `package.json` | Add `import-agendas` script (Task 5). |

Data flow: `ref/agendas/*.json` → `planMeetingImport` → writer applies plan to DB.

---

## Task 1: Types + name normalization + `matchMember`

**Files:**
- Create: `scripts/import-agendas-logic.ts`
- Test: `scripts/import-agendas-logic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/import-agendas-logic.test.ts
import { describe, expect, it } from "vitest";
import { matchMember, normalizeName, type RosterMember } from "./import-agendas-logic";

const roster: RosterMember[] = [
	{ memberId: "m1", personId: "p1", name: "Jagpal Singh" },
	{ memberId: "m2", personId: "p2", name: "Saiful Haque" },
	{ memberId: "m3", personId: "p3", name: "Mahbuba Khan" },
	{ memberId: "m4", personId: "p4", name: "Schinthia Islam" },
];

describe("normalizeName", () => {
	it("lowercases, trims, collapses whitespace, strips the (G) guest marker", () => {
		expect(normalizeName("  Hana   Haque (G) ")).toBe("hana haque");
		expect(normalizeName("Jagpal Singh")).toBe("jagpal singh");
	});
});

describe("matchMember", () => {
	it("matches on exact normalized name", () => {
		const r = matchMember("schinthia islam", roster, {});
		expect(r.member?.memberId).toBe("m4");
	});

	it("applies the alias map before matching", () => {
		const r = matchMember("Dina", roster, { dina: "Mahbuba Khan" });
		expect(r.member?.memberId).toBe("m3");
	});

	it("auto-corrects a unique typo at edit-distance 1", () => {
		const r = matchMember("Jaqpal Singh", roster, {});
		expect(r.member?.memberId).toBe("m1");
	});

	it("does NOT auto-match when two candidates tie at distance 1", () => {
		const two: RosterMember[] = [
			{ memberId: "a", personId: "pa", name: "Sara" },
			{ memberId: "b", personId: "pb", name: "Kara" },
		];
		const r = matchMember("Tara", two, {});
		expect(r.member).toBeUndefined();
		expect(r.suggestions.sort()).toEqual(["Kara", "Sara"]);
	});

	it("reports near-misses (distance 2) as suggestions but does not match", () => {
		const r = matchMember("Jagxxl Singh", roster, {});
		expect(r.member).toBeUndefined();
		expect(r.suggestions).toContain("Jagpal Singh");
	});

	it("strips (G) and matches a former guest who is now on the roster", () => {
		const r = matchMember("Schinthia Islam (G)", roster, {});
		expect(r.member?.memberId).toBe("m4");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts`
Expected: FAIL — `Cannot find module './import-agendas-logic'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/import-agendas-logic.ts

export type RosterMember = {
	memberId: string;
	personId: string;
	name: string;
};

/** Lowercase, strip a trailing "(G)" guest marker, collapse whitespace, trim. */
export function normalizeName(raw: string): string {
	return raw
		.replace(/\(g\)/gi, " ")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

export type MatchResult = {
	member?: RosterMember;
	/** Roster names within edit-distance 2, offered when there is no confident match. */
	suggestions: string[];
};

/**
 * Resolve a raw agenda name to a roster member.
 * Order: alias map → exact normalized → unique typo at distance ≤1 → no match
 * (with distance-≤2 names surfaced as suggestions). Never matches ambiguously.
 * `aliases` keys are normalized raw names; values are canonical roster names.
 */
export function matchMember(
	raw: string,
	roster: RosterMember[],
	aliases: Record<string, string>,
): MatchResult {
	const norm = normalizeName(raw);
	const aliased = aliases[norm];
	const target = aliased ? normalizeName(aliased) : norm;

	const exact = roster.find((m) => normalizeName(m.name) === target);
	if (exact) return { member: exact, suggestions: [] };

	const scored = roster
		.map((m) => ({ m, d: levenshtein(target, normalizeName(m.name)) }))
		.sort((a, b) => a.d - b.d);

	const atOne = scored.filter((s) => s.d <= 1);
	if (atOne.length === 1) return { member: atOne[0].m, suggestions: [] };

	const suggestions = scored.filter((s) => s.d <= 2).map((s) => s.m.name);
	return { member: undefined, suggestions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts`
Expected: PASS (all 8 assertions).

- [ ] **Step 5: Commit**

```bash
git add scripts/import-agendas-logic.ts scripts/import-agendas-logic.test.ts
git commit -m "feat(import-agendas): name normalize + fuzzy member matching"
```

---

## Task 2: Role-label mapping

**Files:**
- Modify: `scripts/import-agendas-logic.ts`
- Test: `scripts/import-agendas-logic.test.ts`

- [ ] **Step 1: Write the failing test** (append to the test file)

```ts
import { mapRoleLabel } from "./import-agendas-logic";

describe("mapRoleLabel", () => {
	it("maps fixed labels to role-definition names at slotIndex 0", () => {
		expect(mapRoleLabel("Toastmaster")).toEqual({ roleName: "Toastmaster of the Day", slotIndex: 0 });
		expect(mapRoleLabel("TableTopic Master")).toEqual({ roleName: "Table Topics Master", slotIndex: 0 });
		expect(mapRoleLabel("Grammarian/WOD")).toEqual({ roleName: "Grammarian", slotIndex: 0 });
		expect(mapRoleLabel("Ah Counter")).toEqual({ roleName: "Ah-Counter", slotIndex: 0 });
		expect(mapRoleLabel("General Evaluator")).toEqual({ roleName: "General Evaluator", slotIndex: 0 });
		expect(mapRoleLabel("Timer")).toEqual({ roleName: "Timer", slotIndex: 0 });
	});

	it("maps numbered Speaker/Evaluator labels to slotIndex N-1", () => {
		expect(mapRoleLabel("Speaker #1")).toEqual({ roleName: "Speaker", slotIndex: 0 });
		expect(mapRoleLabel("Speaker #3")).toEqual({ roleName: "Speaker", slotIndex: 2 });
		expect(mapRoleLabel("Evaluator #2")).toEqual({ roleName: "Evaluator", slotIndex: 1 });
	});

	it("maps Vote Counter (and the 'Voter Counter' typo) to Vote Counter", () => {
		expect(mapRoleLabel("Vote Counter")).toEqual({ roleName: "Vote Counter", slotIndex: 0 });
		expect(mapRoleLabel("Voter Counter")).toEqual({ roleName: "Vote Counter", slotIndex: 0 });
	});

	it("returns null for out-of-scope / unknown labels", () => {
		expect(mapRoleLabel("Sergeant at Arms")).toBeNull();
		expect(mapRoleLabel("Something Else")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts -t mapRoleLabel`
Expected: FAIL — `mapRoleLabel is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `import-agendas-logic.ts`)

```ts
export type RoleTarget = { roleName: string; slotIndex: number };

const FIXED_ROLE_MAP: Record<string, string> = {
	toastmaster: "Toastmaster of the Day",
	"tabletopic master": "Table Topics Master",
	"table topic master": "Table Topics Master",
	"grammarian/wod": "Grammarian",
	grammarian: "Grammarian",
	"ah counter": "Ah-Counter",
	"ah-counter": "Ah-Counter",
	"general evaluator": "General Evaluator",
	timer: "Timer",
	"vote counter": "Vote Counter",
	"voter counter": "Vote Counter",
};

/**
 * Map an agenda role label to a role-definition name + slotIndex.
 * Returns null for labels with no per-meeting slot (e.g. Sergeant at Arms — an
 * officer position) or unknown labels; the caller reports & skips those.
 */
export function mapRoleLabel(label: string): RoleTarget | null {
	const key = label.toLowerCase().replace(/\s+/g, " ").trim();

	const numbered = key.match(/^(speaker|evaluator)\s*#\s*(\d+)$/);
	if (numbered) {
		const roleName = numbered[1] === "speaker" ? "Speaker" : "Evaluator";
		return { roleName, slotIndex: Number(numbered[2]) - 1 };
	}

	const fixed = FIXED_ROLE_MAP[key];
	return fixed ? { roleName: fixed, slotIndex: 0 } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts -t mapRoleLabel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-agendas-logic.ts scripts/import-agendas-logic.test.ts
git commit -m "feat(import-agendas): agenda role-label -> role definition mapping"
```

---

## Task 3: `planMeetingImport` — record → planned writes + report

**Files:**
- Modify: `scripts/import-agendas-logic.ts`
- Test: `scripts/import-agendas-logic.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { planMeetingImport, type AgendaRecord, type RoleDef } from "./import-agendas-logic";

const roleDefs: RoleDef[] = [
	{ id: "rd-tm", name: "Toastmaster of the Day" },
	{ id: "rd-sp", name: "Speaker" },
	{ id: "rd-ev", name: "Evaluator" },
	{ id: "rd-vc", name: "Vote Counter" },
];

const baseRecord: AgendaRecord = {
	meetingNumber: 55,
	date: "2026-07-09",
	theme: "Unity",
	wordOfTheDay: "Momentum",
	sourceFileId: "f1",
	sourceTitle: "55th",
	roles: [
		{ label: "Toastmaster", name: "Schinthia Islam" },
		{
			label: "Speaker #1",
			name: "Jagpal Singh",
			speech: { title: "Leadership in the Era of AI", projectLevel: "Level 2", projectName: "Effective Body Language" },
		},
		{ label: "Evaluator #1", name: "Saiful Haque", evaluates: "Speaker #1" },
		{ label: "Vote Counter", name: "Mahbuba Khan" },
	],
};

describe("planMeetingImport", () => {
	it("plans a meeting, matched slots, a speech, and links the evaluator to its speaker slot", () => {
		const plan = planMeetingImport(baseRecord, roster, roleDefs, {});

		expect(plan.meeting).toMatchObject({
			date: "2026-07-09",
			theme: "Unity",
			wordOfTheDay: "Momentum",
			lengthMinutes: 60,
			status: "completed",
		});

		const tmSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-tm");
		expect(tmSlot).toMatchObject({ assignedMemberId: "m4", slotIndex: 0, status: "confirmed" });

		const spSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-sp" && s.slotIndex === 0);
		expect(spSlot?.assignedMemberId).toBe("m1");
		expect(spSlot?.speech).toMatchObject({
			personId: "p1",
			title: "Leadership in the Era of AI",
			projectLevel: "Level 2",
			projectName: "Effective Body Language",
		});

		const evSlot = plan.slots.find((s) => s.roleDefinitionId === "rd-ev" && s.slotIndex === 0);
		expect(evSlot?.evaluatesTarget).toEqual({ roleName: "Speaker", slotIndex: 0 });

		expect(plan.slots.some((s) => s.roleDefinitionId === "rd-vc")).toBe(true);
		expect(plan.unmatched).toHaveLength(0);
	});

	it("reports (and skips) a row whose name has no confident match", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Timer", name: "Totally Unknown" }] };
		const plan = planMeetingImport(rec, roster, [...roleDefs, { id: "rd-ti", name: "Timer" }], {});
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "name", label: "Timer", name: "Totally Unknown" }),
		]);
	});

	it("reports (and skips) a row whose role label maps to a definition the club lacks", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Timer", name: "Schinthia Islam" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {}); // no Timer def
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toEqual([
			expect.objectContaining({ kind: "role", label: "Timer" }),
		]);
	});

	it("skips out-of-scope labels (Sergeant at Arms) without reporting them as errors", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Sergeant at Arms", name: "Muhammad Ali" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		expect(plan.slots).toHaveLength(0);
		expect(plan.unmatched).toHaveLength(0);
	});

	it("creates a speaker slot with no speech when the row has no speech detail", () => {
		const rec: AgendaRecord = { ...baseRecord, roles: [{ label: "Speaker #2", name: "Saiful Haque" }] };
		const plan = planMeetingImport(rec, roster, roleDefs, {});
		const s = plan.slots.find((x) => x.roleDefinitionId === "rd-sp" && x.slotIndex === 1);
		expect(s?.assignedMemberId).toBe("m2");
		expect(s?.speech).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts -t planMeetingImport`
Expected: FAIL — `planMeetingImport is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `import-agendas-logic.ts`)

```ts
export type SpeechDetail = { title: string; projectLevel?: string; projectName?: string };

export type AgendaRoleRow = {
	label: string;
	name: string;
	speech?: SpeechDetail;
	evaluates?: string; // e.g. "Speaker #1"
};

export type AgendaRecord = {
	meetingNumber: number | null;
	date: string; // ISO yyyy-mm-dd
	theme?: string;
	wordOfTheDay?: string;
	roles: AgendaRoleRow[];
	sourceFileId: string;
	sourceTitle: string;
};

export type RoleDef = { id: string; name: string };

export type PlannedSpeech = {
	personId: string;
	title: string;
	projectLevel?: string;
	projectName?: string;
};

export type PlannedSlot = {
	roleDefinitionId: string;
	slotIndex: number;
	assignedMemberId: string;
	status: "confirmed";
	evaluatesTarget?: RoleTarget; // resolved to a speaker slot id by the writer
	speech?: PlannedSpeech;
};

export type PlannedMeeting = {
	date: string;
	theme?: string;
	wordOfTheDay?: string;
	lengthMinutes: 60;
	status: "completed";
};

export type UnmatchedEntry =
	| { kind: "name"; label: string; name: string; suggestions: string[] }
	| { kind: "role"; label: string; name: string };

export type MeetingPlan = {
	meeting: PlannedMeeting;
	slots: PlannedSlot[];
	unmatched: UnmatchedEntry[];
};

/** Labels that are intentionally not imported as per-meeting slots. */
const IGNORED_LABELS = new Set(["sergeant at arms", "sergeant-at-arms"]);

export function planMeetingImport(
	record: AgendaRecord,
	roster: RosterMember[],
	roleDefs: RoleDef[],
	aliases: Record<string, string>,
): MeetingPlan {
	const meeting: PlannedMeeting = {
		date: record.date,
		theme: record.theme,
		wordOfTheDay: record.wordOfTheDay,
		lengthMinutes: 60,
		status: "completed",
	};
	const slots: PlannedSlot[] = [];
	const unmatched: UnmatchedEntry[] = [];
	const defByName = new Map(roleDefs.map((d) => [d.name, d]));

	for (const row of record.roles) {
		if (!row.name?.trim()) continue; // blank cell
		if (IGNORED_LABELS.has(row.label.toLowerCase().trim())) continue;

		const target = mapRoleLabel(row.label);
		if (!target) {
			unmatched.push({ kind: "role", label: row.label, name: row.name });
			continue;
		}
		const def = defByName.get(target.roleName);
		if (!def) {
			unmatched.push({ kind: "role", label: row.label, name: row.name });
			continue;
		}

		const match = matchMember(row.name, roster, aliases);
		if (!match.member) {
			unmatched.push({ kind: "name", label: row.label, name: row.name, suggestions: match.suggestions });
			continue;
		}

		const slot: PlannedSlot = {
			roleDefinitionId: def.id,
			slotIndex: target.slotIndex,
			assignedMemberId: match.member.memberId,
			status: "confirmed",
		};
		if (row.evaluates) {
			const evTarget = mapRoleLabel(row.evaluates);
			if (evTarget) slot.evaluatesTarget = evTarget;
		}
		if (row.speech?.title) {
			slot.speech = {
				personId: match.member.personId,
				title: row.speech.title,
				projectLevel: row.speech.projectLevel,
				projectName: row.speech.projectName,
			};
		}
		slots.push(slot);
	}

	return { meeting, slots, unmatched };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts`
Expected: PASS (entire file).

- [ ] **Step 5: Lint + commit**

```bash
bun run check
git add scripts/import-agendas-logic.ts scripts/import-agendas-logic.test.ts
git commit -m "feat(import-agendas): planMeetingImport builds writes + unmatched report"
```

---

## Task 4: Vote Counter role-definition ensure helper

**Files:**
- Modify: `scripts/import-agendas-logic.ts`
- Test: `scripts/import-agendas-logic.test.ts`

The writer must create a "Vote Counter" functionary role definition if the club lacks one. The *decision* of whether creation is needed is pure and testable; the DB insert lives in the writer (Task 5).

- [ ] **Step 1: Write the failing test** (append)

```ts
import { missingRoleDefinitions } from "./import-agendas-logic";

describe("missingRoleDefinitions", () => {
	it("returns a Vote Counter definition to create when the club lacks it", () => {
		const missing = missingRoleDefinitions([{ id: "rd-tm", name: "Toastmaster of the Day" }]);
		expect(missing).toEqual([{ name: "Vote Counter", category: "functionary", isSpeakerRole: false, defaultCount: 1 }]);
	});

	it("returns nothing when Vote Counter already exists", () => {
		expect(missingRoleDefinitions([{ id: "rd-vc", name: "Vote Counter" }])).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts -t missingRoleDefinitions`
Expected: FAIL — `missingRoleDefinitions is not a function`.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
export type RoleDefToCreate = {
	name: string;
	category: "functionary";
	isSpeakerRole: false;
	defaultCount: number;
};

/** The only role definition this backfill may create: Vote Counter. */
export function missingRoleDefinitions(roleDefs: RoleDef[]): RoleDefToCreate[] {
	const has = roleDefs.some((d) => d.name === "Vote Counter");
	return has ? [] : [{ name: "Vote Counter", category: "functionary", isSpeakerRole: false, defaultCount: 1 }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run scripts/import-agendas-logic.test.ts -t missingRoleDefinitions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-agendas-logic.ts scripts/import-agendas-logic.test.ts
git commit -m "feat(import-agendas): compute missing Vote Counter role definition"
```

---

## Task 5: Writer CLI (`import-agendas.ts`) + dry-run/commit + idempotency

**Files:**
- Create: `scripts/import-agendas.ts`
- Modify: `package.json` (add script)
- Test: `scripts/import-agendas.integration.test.ts`

Study `scripts/import-members.ts` for the standalone-script pattern (dotenv load, `#/db` import, `pg` pool, top-level `await`, `process.exit`) and `scripts/import-members.integration.test.ts` for the `tm_test` harness (how it points `#/db` at `TEST_DATABASE_URL`, seeds a club, and cleans up). Mirror those exactly.

**Idempotency contract (implement precisely):**
- Meeting: upsert on `(clubId, scheduledAt)`. `scheduledAt` = `record.date` at 18:45 local (the club's 6:45 PM start). Find existing by that timestamp; update theme/WOD/length/status or insert.
- Slots: for the meeting, `DELETE FROM role_slots WHERE meeting_id = $meeting` then re-insert the planned slots. (A meeting's slot set is fully derived from its agenda.)
- Speeches: for each planned speech, find an existing speech by `(personId, normalized title)`; reuse its id if found, else insert. Then set the freshly-inserted slot's `speech_id` to it. (Deleting slots only nulls the pointer; the durable person-owned speech survives — so re-runs never duplicate speeches.)
- Evaluator pairing: after inserting a meeting's slots, for each slot with `evaluatesTarget`, `UPDATE role_slots SET evaluates_slot_id = <that meeting's Speaker slot at slotIndex>`.

- [ ] **Step 1: Write the failing integration test**

```ts
// scripts/import-agendas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
// Mirror import-members.integration.test.ts for the tm_test db handle + seeding.
import { db } from "#/db";
import { meetings, roleSlots, speeches } from "#/db/schema";
import { applyMeetingPlan, type WriterContext } from "./import-agendas";
import { planMeetingImport, type AgendaRecord } from "./import-agendas-logic";

// NOTE: seedClub() / cleanup() adapted from import-members.integration.test.ts.
// It must insert a club, the standard role definitions (Toastmaster of the Day,
// Speaker x3, Evaluator x3, General Evaluator, Timer, Ah-Counter, Grammarian),
// and roster members (with people) for the names used below, returning ids.

let ctx: WriterContext;
let clubId: string;

const record: AgendaRecord = {
	meetingNumber: 1,
	date: "2025-01-09",
	theme: "Fresh Start",
	wordOfTheDay: "Momentum",
	sourceFileId: "f",
	sourceTitle: "t",
	roles: [
		{ label: "Speaker #1", name: "Jagpal Singh", speech: { title: "AI Talk", projectLevel: "Level 2" } },
		{ label: "Evaluator #1", name: "Saiful Haque", evaluates: "Speaker #1" },
		{ label: "Vote Counter", name: "Mahbuba Khan" },
	],
};

beforeAll(async () => {
	({ ctx, clubId } = await seedClubAndContext()); // see import-members test for pattern
});
afterAll(async () => {
	await cleanup(clubId);
});

async function importOnce() {
	const plan = planMeetingImport(record, ctx.roster, ctx.roleDefs, {});
	await applyMeetingPlan(plan, ctx);
}

describe("import-agendas writer", () => {
	it("creates the Vote Counter role definition, meeting, slots, and speech", async () => {
		await importOnce();
		const m = await db.select().from(meetings).where(eq(meetings.clubId, clubId));
		expect(m).toHaveLength(1);
		expect(m[0].status).toBe("completed");
		expect(m[0].lengthMinutes).toBe(60);

		const slots = await db.select().from(roleSlots).where(eq(roleSlots.meetingId, m[0].id));
		expect(slots.length).toBe(3);

		const sp = await db.select().from(speeches);
		expect(sp.some((s) => s.title === "AI Talk")).toBe(true);
	});

	it("is idempotent: a second run does not duplicate meetings, slots, or speeches", async () => {
		await importOnce();
		const m = await db.select().from(meetings).where(eq(meetings.clubId, clubId));
		expect(m).toHaveLength(1);
		const slots = await db.select().from(roleSlots).where(eq(roleSlots.meetingId, m[0].id));
		expect(slots.length).toBe(3);
		const aiSpeeches = (await db.select().from(speeches)).filter((s) => s.title === "AI Talk");
		expect(aiSpeeches).toHaveLength(1);
	});

	it("links the evaluator slot to its speaker slot", async () => {
		const m = (await db.select().from(meetings).where(eq(meetings.clubId, clubId)))[0];
		const slots = await db.select().from(roleSlots).where(eq(roleSlots.meetingId, m.id));
		const speaker = slots.find((s) => s.slotIndex === 0 && s.speechId != null);
		const evaluator = slots.find((s) => s.evaluatesSlotId != null);
		expect(evaluator?.evaluatesSlotId).toBe(speaker?.id);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test bunx vitest run scripts/import-agendas.integration.test.ts`
Expected: FAIL — `applyMeetingPlan` / `WriterContext` not exported from `./import-agendas`.

- [ ] **Step 3: Write the writer**

```ts
// scripts/import-agendas.ts
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { meetings, members, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import {
	type AgendaRecord,
	type MeetingPlan,
	missingRoleDefinitions,
	normalizeName,
	type PlannedSlot,
	planMeetingImport,
	type RoleDef,
	type RosterMember,
} from "./import-agendas-logic";

export type WriterContext = {
	clubId: string;
	roster: RosterMember[];
	roleDefs: RoleDef[];
};

const CLUB_START_HOUR = 18; // 6 PM
const CLUB_START_MIN = 45; // :45

function scheduledAtFor(dateISO: string): Date {
	const [y, mo, d] = dateISO.split("-").map(Number);
	return new Date(y, mo - 1, d, CLUB_START_HOUR, CLUB_START_MIN, 0, 0);
}

/** Ensure the Vote Counter role definition exists; return the refreshed role-def list. */
async function ensureRoleDefs(ctx: WriterContext): Promise<RoleDef[]> {
	const toCreate = missingRoleDefinitions(ctx.roleDefs);
	for (const def of toCreate) {
		await db.insert(roleDefinitions).values({ clubId: ctx.clubId, ...def });
	}
	return db
		.select({ id: roleDefinitions.id, name: roleDefinitions.name })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, ctx.clubId));
}

/** Apply one meeting's plan to the DB, idempotently. */
export async function applyMeetingPlan(plan: MeetingPlan, ctx: WriterContext): Promise<void> {
	ctx.roleDefs = await ensureRoleDefs(ctx); // may have created Vote Counter
	const scheduledAt = scheduledAtFor(plan.meeting.date);

	// Upsert meeting on (clubId, scheduledAt).
	const existing = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(and(eq(meetings.clubId, ctx.clubId), eq(meetings.scheduledAt, scheduledAt)));
	let meetingId: string;
	if (existing[0]) {
		meetingId = existing[0].id;
		await db
			.update(meetings)
			.set({
				theme: plan.meeting.theme,
				wordOfTheDay: plan.meeting.wordOfTheDay,
				lengthMinutes: plan.meeting.lengthMinutes,
				status: plan.meeting.status,
			})
			.where(eq(meetings.id, meetingId));
	} else {
		const inserted = await db
			.insert(meetings)
			.values({
				clubId: ctx.clubId,
				scheduledAt,
				theme: plan.meeting.theme,
				wordOfTheDay: plan.meeting.wordOfTheDay,
				lengthMinutes: plan.meeting.lengthMinutes,
				status: plan.meeting.status,
			})
			.returning({ id: meetings.id });
		meetingId = inserted[0].id;
	}

	// Re-derive slots: delete then re-insert.
	await db.delete(roleSlots).where(eq(roleSlots.meetingId, meetingId));

	// Map re-resolved role-def ids by (name) since ensureRoleDefs may have changed them.
	const defById = new Map(ctx.roleDefs.map((d) => [d.id, d]));
	const speakerSlotIdByIndex = new Map<number, string>();
	const pending = plan.slots.map((s) => ({ ...s })); // shallow copy

	// Insert non-evaluator-linked slots first so speaker slots exist for pairing.
	for (const s of pending) {
		// Resolve/create the speech.
		let speechId: string | null = null;
		if (s.speech) {
			const norm = normalizeName(s.speech.title);
			const found = (await db.select({ id: speeches.id, title: speeches.title }).from(speeches).where(eq(speeches.personId, s.speech.personId)))
				.find((row) => normalizeName(row.title) === norm);
			if (found) {
				speechId = found.id;
			} else {
				const ins = await db
					.insert(speeches)
					.values({
						personId: s.speech.personId,
						title: s.speech.title,
						projectLevel: s.speech.projectLevel,
						projectName: s.speech.projectName,
					})
					.returning({ id: speeches.id });
				speechId = ins[0].id;
			}
		}
		const ins = await db
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: s.roleDefinitionId,
				slotIndex: s.slotIndex,
				assignedMemberId: s.assignedMemberId,
				status: s.status,
				speechId,
				claimedAt: scheduledAt,
			})
			.returning({ id: roleSlots.id });
		const def = defById.get(s.roleDefinitionId);
		if (def?.name === "Speaker") speakerSlotIdByIndex.set(s.slotIndex, ins[0].id);
		// Stash the inserted id back on the plan slot for the pairing pass.
		(s as PlannedSlot & { _id?: string })._id = ins[0].id;
	}

	// Evaluator pairing pass.
	for (const s of pending as (PlannedSlot & { _id?: string })[]) {
		if (s.evaluatesTarget && s.evaluatesTarget.roleName === "Speaker" && s._id) {
			const speakerId = speakerSlotIdByIndex.get(s.evaluatesTarget.slotIndex);
			if (speakerId) {
				await db.update(roleSlots).set({ evaluatesSlotId: speakerId }).where(eq(roleSlots.id, s._id));
			}
		}
	}
}

// ---- CLI entrypoint (only runs when invoked directly, not under test import) ----

async function loadContext(clubId: string): Promise<WriterContext> {
	const roster = await db
		.select({ memberId: members.id, personId: members.personId, name: members.name })
		.from(members)
		.where(eq(members.clubId, clubId));
	const roleDefs = await db
		.select({ id: roleDefinitions.id, name: roleDefinitions.name })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
	return { clubId, roster, roleDefs };
}

function loadRecords(dir: string): AgendaRecord[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json") && f !== "aliases.json" && f !== "index.json")
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as AgendaRecord);
}

async function main() {
	const commit = process.argv.includes("--commit");
	const clubId = process.env.IMPORT_CLUB_ID;
	if (!clubId) throw new Error("Set IMPORT_CLUB_ID to the target club id.");

	const dir = "ref/agendas";
	const aliases = JSON.parse(readFileSync(join(dir, "aliases.json"), "utf8")) as Record<string, string>;
	const records = loadRecords(dir);
	const ctx = await loadContext(clubId);

	let meetingsN = 0;
	let slotsN = 0;
	let speechesN = 0;
	const unmatched: string[] = [];

	for (const record of records) {
		const plan = planMeetingImport(record, ctx.roster, ctx.roleDefs, aliases);
		meetingsN += 1;
		slotsN += plan.slots.length;
		speechesN += plan.slots.filter((s) => s.speech).length;
		for (const u of plan.unmatched) {
			const extra = u.kind === "name" && u.suggestions.length ? ` (did you mean: ${u.suggestions.join(", ")}?)` : "";
			unmatched.push(`#${record.meetingNumber ?? "?"} ${record.date} · ${u.label} · "${u.name}" [${u.kind}]${extra}`);
		}
		if (commit) await applyMeetingPlan(plan, ctx);
	}

	console.log(`Meetings: ${meetingsN}  Slots: ${slotsN}  Speeches: ${speechesN}`);
	console.log(`Unmatched/skipped rows: ${unmatched.length}`);
	for (const line of unmatched) console.log("  - " + line);
	console.log(commit ? "\nCOMMITTED to the database." : "\nDRY RUN — pass --commit to write.");
	process.exit(0);
}

// Run main() only as a CLI, never when imported by tests.
if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
```

- [ ] **Step 4: Add the package script**

In `package.json` scripts, add:

```json
"import-agendas": "bun run scripts/import-agendas.ts"
```

- [ ] **Step 5: Run the integration test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/tm_test bunx vitest run scripts/import-agendas.integration.test.ts`
Expected: PASS (3 tests: create, idempotent re-run, evaluator pairing).

- [ ] **Step 6: Lint + commit**

```bash
bun run check
git add scripts/import-agendas.ts scripts/import-agendas.integration.test.ts package.json
git commit -m "feat(import-agendas): idempotent writer CLI with dry-run + evaluator pairing"
```

---

## Task 6: Extraction — build the `ref/agendas/` dataset (main agent / Drive access)

**Files:**
- Create: `ref/agendas/<NN>-<date>.json` (one per readable meeting)
- Create: `ref/agendas/aliases.json`
- Create: `ref/.gitignore` note — the dataset IS committed (club agenda data, not secret).

**This task is NOT a code subagent task — it requires Google Drive MCP access and reading judgment.** The main agent (or the user) performs it.

- [ ] **Step 1: Seed the alias map**

Create `ref/agendas/aliases.json` (normalized-raw-name → canonical roster name). Start with the known short forms; extend it as the dry-run report surfaces more:

```json
{
	"saif": "Saiful Haque",
	"farha begum": "Farhanaaz Begum",
	"dina": "Mahbuba Khan"
}
```

- [ ] **Step 2: Extract each readable meeting to JSON**

For every non-shortcut agenda in Drive folder `1MkX1A_OK2HlSiTHa2EAQMwkd5o5TmB29` (Google Docs, `.docx` #3/#29/#31, and best-effort the #35 JPEG), read it and write `ref/agendas/<NN>-<date>.json` matching the `AgendaRecord` shape from Task 3:

```jsonc
{
	"meetingNumber": 55,
	"date": "2026-07-09",
	"theme": "Unity",
	"wordOfTheDay": "Momentum",
	"roles": [
		{ "label": "Toastmaster", "name": "Faisal Ali" },
		{ "label": "Speaker #1", "name": "Jagpal Singh",
		  "speech": { "title": "Leadership in the Era of AI", "projectLevel": "Level 2", "projectName": "Effective Body Language" } },
		{ "label": "Evaluator #1", "name": "Sudheer Isanaka", "evaluates": "Speaker #1" }
	],
	"sourceFileId": "13FAdX...",
	"sourceTitle": "55th_Meeting_MCF_Agenda_7-09-26"
}
```

Rules while extracting:
- Only include **filled** role rows (omit blank cells).
- `date` from the footer "Meeting Date" (fall back to the filename date). ISO `yyyy-mm-dd`.
- Speaker rows: include `speech` only when a title is present; include `projectLevel`/`projectName` only when the line has them (older agendas won't).
- Evaluator rows: set `evaluates` to the speaker label (e.g. from "X for Y", find which Speaker # is Y).
- Skip shortcuts entirely (unreadable). Note skipped meetings in a comment in `index.json`.

- [ ] **Step 3: Write an index for traceability**

Create `ref/agendas/index.json` listing each meeting number, date, source file id, and whether it was imported or skipped (with reason).

- [ ] **Step 4: Commit the dataset**

```bash
git add ref/agendas/
git commit -m "data(import-agendas): extracted agenda dataset + alias map"
```

---

## Task 7: Dry-run, review, then commit to prod

**Files:** none (operational).

- [ ] **Step 1: Dry-run against the target DB**

```bash
IMPORT_CLUB_ID=<mcf-club-id> bun run import-agendas
```

Expected: prints Meetings/Slots/Speeches counts and the unmatched/skipped list. No DB writes.

- [ ] **Step 2: Triage the unmatched report**

For each `[name]` line, add a real alias to `ref/agendas/aliases.json` if the "did you mean" suggestion is correct, or leave it skipped if it's a genuine guest/outsider. Re-run Step 1 until the report is acceptable (target ~70% of rows matched). Commit alias updates.

- [ ] **Step 3: Commit to the database**

```bash
IMPORT_CLUB_ID=<mcf-club-id> bun run import-agendas --commit
```

Expected: "COMMITTED to the database."

- [ ] **Step 4: Spot-check in the app**

Open a couple of backfilled past meetings and a member profile; confirm role slots + speeches appear. Because the writer is idempotent, fixing an alias and re-running `--commit` is safe.

- [ ] **Step 5: Final commit (any alias fixes from triage)**

```bash
git add ref/agendas/aliases.json
git commit -m "data(import-agendas): alias fixes from dry-run triage"
```

---

## Notes for the executor

- **No schema/migration changes** — this plan only reads existing tables and writes rows. If you find yourself editing `src/db/schema.ts`, stop; that's out of scope.
- The logic module (`import-agendas-logic.ts`) is pure and must stay DB-free so it's unit-testable; all DB I/O lives in `import-agendas.ts`. This mirrors the repo's `*-logic.ts` convention.
- These scripts import `#/db` directly and are never imported by client code, so there is no client-bundle-leak concern (unlike `src/server/*`).
