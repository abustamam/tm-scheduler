# Data-driven member data from CSV + hide fabricated progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist real member join dates from the Toastmasters CSV export via a one-off seed script, switch tenure display to those real dates, and remove all fabricated Pathways-progress UI (tabled to issue #61).

**Architecture:** Add two nullable date columns to `members` (`joinedAt`, `originalJoinDate`). Pure CSV parse/map/match logic lives in `src/lib/members-csv.ts` (unit-tested, no DB); a thin `scripts/import-members.ts` runner reads the file, fetches the club's existing members, and upserts them with a two-pass (email→name) match and a fill-only overwrite policy. Server selects expose the new dates; the roster / member-detail / dashboard drop every mock-progress element and read `joinedAt ?? createdAt` for tenure.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM + node-postgres, Bun, Vitest, Biome (tabs + double quotes).

**Spec:** `docs/superpowers/specs/2026-06-30-data-driven-members-design.md`

**Working dir:** worktree `../tm-scheduler-data-driven-members` (branch `feat/data-driven-members`). Run all `bun` commands there.

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/db/schema.ts` | `members.joinedAt` + `members.originalJoinDate` columns | modify |
| `drizzle/00xx_*.sql` + `drizzle/meta/*` | generated migration | create (generated) |
| `src/lib/members-csv.ts` | pure: CSV parse, paid filter, M/D/YYYY parse, row→fields map, match decision, fill-only | create |
| `src/lib/members-csv.test.ts` | unit tests for the pure logic | create |
| `scripts/import-members.ts` | DB runner: args, read file, fetch existing, upsert, log | create |
| `package.json` | `import-members` script | modify |
| `src/server/club.ts` | add `joinedAt`/`originalJoinDate` to `listClubMembers` + `getMemberProfile` selects/returns | modify |
| `src/data/club.ts` | delete mock-pathway exports; keep avatar/status helpers | modify |
| `src/routes/_authed/index.tsx` | roster: real tenure, drop Pathway/Level/Status columns + segments + 2 stat cards | modify |
| `src/routes/_authed/members.$id.tsx` | member detail: real tenure, drop pathway card + awards + status pill | modify |
| `src/routes/_authed/dashboard.tsx` | drop hero ring + "Next up" card | modify |
| `src/components/club/progress-ring.tsx` | now unused | delete |
| `src/components/club/status-pill.tsx` | now unused | delete |

---

## Task 1: Schema columns + migration

**Files:**
- Modify: `src/db/schema.ts` (the `members` table, ~line 108-125)

- [ ] **Step 1: Add the two columns**

In `src/db/schema.ts`, inside `members = pgTable("members", { ... }`, add after the `office` line:

```ts
		office: text("office"),
		// Real join dates from the Toastmasters membership export (seeded by
		// scripts/import-members.ts). joinedAt = "Member of Club Since";
		// originalJoinDate = first-ever Toastmasters join (stored for #64, no UI yet).
		joinedAt: timestamp("joined_at"),
		originalJoinDate: timestamp("original_join_date"),
```

(`timestamp` is already imported at the top of the file.)

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate`
Expected: a new file `drizzle/00xx_<name>.sql` containing `ALTER TABLE "members" ADD COLUMN "joined_at" timestamp;` and `... "original_join_date" timestamp;`, plus updated `drizzle/meta/`.

- [ ] **Step 3: Apply the migration to local dev**

Run: `bun run db:migrate`
Expected: applies cleanly, no error.

- [ ] **Step 4: Verify columns exist**

Run: `docker exec dev-postgres psql -U dev -d tm_scheduler -c "\d members" | grep -E "joined_at|original_join_date"`
Expected: both columns listed as `timestamp without time zone`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add members.joined_at + original_join_date"
```

---

## Task 2: CSV parser (pure)

**Files:**
- Create: `src/lib/members-csv.ts`
- Test: `src/lib/members-csv.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/members-csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCsv } from "./members-csv";

describe("parseCsv", () => {
	it("parses header + rows into keyed objects", () => {
		const text = "Name,Email,Status (*)\nAda Lovelace,ada@x.io,PaidMember\n";
		expect(parseCsv(text)).toEqual([
			{ Name: "Ada Lovelace", Email: "ada@x.io", "Status (*)": "PaidMember" },
		]);
	});

	it("keeps empty fields as empty strings", () => {
		const text = "Name,Email,Phone\nBob,,+1555\n";
		expect(parseCsv(text)).toEqual([
			{ Name: "Bob", Email: "", Phone: "+1555" },
		]);
	});

	it("handles quoted fields containing commas", () => {
		const text = 'Name,City\n"Khan, Mois","Folsom, CA"\n';
		expect(parseCsv(text)).toEqual([{ Name: "Khan, Mois", City: "Folsom, CA" }]);
	});

	it("ignores a trailing blank line", () => {
		const text = "Name\nAda\n\n";
		expect(parseCsv(text)).toEqual([{ Name: "Ada" }]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: FAIL — cannot find module `./members-csv`.

- [ ] **Step 3: Implement `parseCsv`**

Create `src/lib/members-csv.ts`:

```ts
/**
 * Pure helpers for importing the Toastmasters club-membership CSV export.
 * No DB access — unit-tested in isolation; the DB runner is
 * scripts/import-members.ts.
 */

/** Split one CSV line into fields, honoring double-quoted fields with commas. */
function splitLine(line: string): string[] {
	const out: string[] = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (inQuotes) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === ",") {
			out.push(field);
			field = "";
		} else {
			field += c;
		}
	}
	out.push(field);
	return out;
}

/** Parse CSV text (header row + data rows) into an array of keyed objects. */
export function parseCsv(text: string): Record<string, string>[] {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0) return [];
	const header = splitLine(lines[0]);
	return lines.slice(1).map((line) => {
		const cells = splitLine(line);
		const row: Record<string, string> = {};
		header.forEach((key, i) => {
			row[key] = (cells[i] ?? "").trim();
		});
		return row;
	});
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/members-csv.ts src/lib/members-csv.test.ts
git commit -m "feat(import): quote-aware CSV parser"
```

---

## Task 3: Paid filter, date parse, row→fields mapping (pure)

**Files:**
- Modify: `src/lib/members-csv.ts`
- Modify: `src/lib/members-csv.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/members-csv.test.ts`:

```ts
import { isPaid, mapRow, parseMDY } from "./members-csv";

describe("isPaid", () => {
	it("is true only for PaidMember status", () => {
		expect(isPaid({ "Status (*)": "PaidMember" })).toBe(true);
		expect(isPaid({ "Status (*)": "UnpaidMember" })).toBe(false);
		expect(isPaid({})).toBe(false);
	});
});

describe("parseMDY", () => {
	it("parses M/D/YYYY at local midnight", () => {
		const d = parseMDY("5/1/2024");
		expect(d?.getFullYear()).toBe(2024);
		expect(d?.getMonth()).toBe(4); // May = 4
		expect(d?.getDate()).toBe(1);
	});
	it("returns null for empty or malformed input", () => {
		expect(parseMDY("")).toBeNull();
		expect(parseMDY("not-a-date")).toBeNull();
	});
});

describe("mapRow", () => {
	it("maps name/email/phone(mobile)/dates; empties become null", () => {
		const row = {
			Name: "Faisal Ali",
			Email: "ifaisalali@me.com",
			"Home Phone": "+1510",
			"Mobile Phone": "+15103666802",
			"Member of Club Since": "5/1/2024",
			"Original Join Date": "10/1/2012",
		};
		const m = mapRow(row);
		expect(m.name).toBe("Faisal Ali");
		expect(m.email).toBe("ifaisalali@me.com");
		expect(m.phone).toBe("+15103666802"); // mobile only
		expect(m.joinedAt?.getFullYear()).toBe(2024);
		expect(m.originalJoinDate?.getFullYear()).toBe(2012);
	});
	it("nulls missing email/phone/dates", () => {
		const m = mapRow({ Name: "Mahbuba Khan" });
		expect(m.email).toBeNull();
		expect(m.phone).toBeNull();
		expect(m.joinedAt).toBeNull();
		expect(m.originalJoinDate).toBeNull();
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: FAIL — `isPaid`/`parseMDY`/`mapRow` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/members-csv.ts`:

```ts
export interface MappedMember {
	name: string;
	email: string | null;
	phone: string | null;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
}

/** Only rows whose Toastmasters status is a paid membership are imported. */
export function isPaid(row: Record<string, string>): boolean {
	return row["Status (*)"] === "PaidMember";
}

/** Parse a Toastmasters M/D/YYYY string into a local-midnight Date, or null. */
export function parseMDY(value: string | undefined): Date | null {
	if (!value) return null;
	const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (!m) return null;
	const month = Number(m[1]);
	const day = Number(m[2]);
	const year = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return new Date(year, month - 1, day);
}

function nonEmpty(value: string | undefined): string | null {
	const v = (value ?? "").trim();
	return v === "" ? null : v;
}

/** Map one CSV row to the member fields we persist (Mobile Phone only). */
export function mapRow(row: Record<string, string>): MappedMember {
	return {
		name: (row.Name ?? "").trim(),
		email: nonEmpty(row.Email),
		phone: nonEmpty(row["Mobile Phone"]),
		joinedAt: parseMDY(row["Member of Club Since"]),
		originalJoinDate: parseMDY(row["Original Join Date"]),
	};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/members-csv.ts src/lib/members-csv.test.ts
git commit -m "feat(import): paid filter + date parse + row mapping"
```

---

## Task 4: Two-pass match decision + fill-only (pure)

**Files:**
- Modify: `src/lib/members-csv.ts`
- Modify: `src/lib/members-csv.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/lib/members-csv.test.ts`:

```ts
import { chooseMatch, fillOnly } from "./members-csv";

const existing = [
	{ id: "a", email: "ada@x.io", name: "Ada Lovelace" },
	{ id: "b", email: null, name: "Bob Khan" },
	{ id: "c", email: null, name: "Bob Khan" }, // duplicate name
];

describe("chooseMatch", () => {
	it("matches by email (case-insensitive) first", () => {
		expect(chooseMatch({ email: "ADA@x.io", name: "Different" }, existing)).toEqual(
			{ kind: "email", id: "a" },
		);
	});
	it("falls back to exact normalized name when no email match", () => {
		expect(
			chooseMatch({ email: "new@x.io", name: "  ada lovelace " }, existing),
		).toEqual({ kind: "name", id: "a" });
	});
	it("returns ambiguous when a name matches more than one member", () => {
		expect(chooseMatch({ email: null, name: "Bob Khan" }, existing)).toEqual({
			kind: "ambiguous",
		});
	});
	it("returns insert when nothing matches", () => {
		expect(chooseMatch({ email: "z@x.io", name: "Zed" }, existing)).toEqual({
			kind: "insert",
		});
	});
});

describe("fillOnly", () => {
	it("keeps a non-empty existing value", () => {
		expect(fillOnly("Rasheed Bustamam", "Abdul-Rasheed Bustamam")).toBe(
			"Rasheed Bustamam",
		);
	});
	it("uses the incoming value when existing is null/empty", () => {
		expect(fillOnly(null, "new@x.io")).toBe("new@x.io");
		expect(fillOnly("  ", "+1555")).toBe("+1555");
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: FAIL — `chooseMatch`/`fillOnly` not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/members-csv.ts`:

```ts
export interface ExistingMember {
	id: string;
	email: string | null;
	name: string;
}

export type Match =
	| { kind: "email"; id: string }
	| { kind: "name"; id: string }
	| { kind: "insert" }
	| { kind: "ambiguous" };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Decide how a CSV member reconciles against the club's existing members:
 * email match first, then exact normalized-name match, else insert. A name that
 * matches more than one existing member is ambiguous (skip — never guess).
 */
export function chooseMatch(
	incoming: { email: string | null; name: string },
	existing: ExistingMember[],
): Match {
	const email = norm(incoming.email);
	if (email !== "") {
		const hit = existing.find((e) => norm(e.email) === email);
		if (hit) return { kind: "email", id: hit.id };
	}
	const name = norm(incoming.name);
	const byName = existing.filter((e) => norm(e.name) === name);
	if (byName.length === 1) return { kind: "name", id: byName[0].id };
	if (byName.length > 1) return { kind: "ambiguous" };
	return { kind: "insert" };
}

/** Fill-only: keep a non-empty existing value; otherwise take the incoming one. */
export function fillOnly(
	existing: string | null,
	incoming: string | null,
): string | null {
	return existing && existing.trim() !== "" ? existing : incoming;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bunx vitest run src/lib/members-csv.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/members-csv.ts src/lib/members-csv.test.ts
git commit -m "feat(import): two-pass match decision + fill-only helper"
```

---

## Task 5: The import runner script

**Files:**
- Create: `scripts/import-members.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the runner**

Create `scripts/import-members.ts`:

```ts
/**
 * One-off seed: import a Toastmasters club-membership CSV export into `members`.
 *
 * Usage:
 *   bun run scripts/import-members.ts --club <clubId> [--file <path>]
 *
 * - Imports only PaidMember rows.
 * - Two-pass match per club: email → exact name → insert; ambiguous names are
 *   skipped and warned.
 * - Overwrite policy: joinedAt/originalJoinDate always written; name/email/phone
 *   are fill-only (never overwrite a non-empty stored value). office is untouched.
 * Idempotent. Bun auto-loads .env.local for DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { members } from "#/db/schema";
import {
	chooseMatch,
	fillOnly,
	isPaid,
	mapRow,
	parseCsv,
} from "#/lib/members-csv";

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const clubId = arg("--club");
	const file = arg("--file") ?? "ref/Club-Membership20260630.csv";
	if (!clubId) {
		console.error("Missing --club <clubId>");
		process.exit(1);
	}

	const rows = parseCsv(readFileSync(file, "utf8"));
	const paid = rows.filter(isPaid);
	const skippedUnpaid = rows.length - paid.length;

	const existing = await db
		.select({ id: members.id, email: members.email, name: members.name, phone: members.phone })
		.from(members)
		.where(eq(members.clubId, clubId));

	let inserted = 0;
	let updatedEmail = 0;
	let updatedName = 0;
	let skippedAmbiguous = 0;

	for (const row of paid) {
		const m = mapRow(row);
		const match = chooseMatch(m, existing);

		if (match.kind === "ambiguous") {
			console.warn(`SKIP ambiguous name: ${m.name}`);
			skippedAmbiguous++;
			continue;
		}

		if (match.kind === "insert") {
			const [created] = await db
				.insert(members)
				.values({
					clubId,
					name: m.name,
					email: m.email,
					phone: m.phone,
					joinedAt: m.joinedAt,
					originalJoinDate: m.originalJoinDate,
				})
				.returning({ id: members.id });
			existing.push({ id: created.id, email: m.email, name: m.name, phone: m.phone });
			inserted++;
			console.log(`INSERT ${m.name}`);
			continue;
		}

		const current = existing.find((e) => e.id === match.id);
		if (!current) continue;
		await db
			.update(members)
			.set({
				name: fillOnly(current.name, m.name) ?? current.name,
				email: fillOnly(current.email, m.email),
				phone: fillOnly(current.phone, m.phone),
				joinedAt: m.joinedAt,
				originalJoinDate: m.originalJoinDate,
			})
			.where(eq(members.id, match.id));
		if (match.kind === "email") updatedEmail++;
		else updatedName++;
		console.log(`UPDATE (${match.kind}) ${m.name}`);
	}

	console.log(
		`\nDone. inserted=${inserted} updated-by-email=${updatedEmail} ` +
			`updated-by-name=${updatedName} skipped-ambiguous=${skippedAmbiguous} ` +
			`skipped-unpaid=${skippedUnpaid}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

Note: `existing` is selected with `phone` too (needed for fill-only on update), though `chooseMatch` only reads `id`/`email`/`name` — the extra `phone` field is harmless to the `ExistingMember` shape.

- [ ] **Step 2: Add the package.json script**

In `package.json` `"scripts"`, add:

```json
		"import-members": "bun run scripts/import-members.ts",
```

- [ ] **Step 3: Verify it type-checks / lints**

Run: `bun run check`
Expected: no errors for `scripts/import-members.ts` or `src/lib/members-csv.ts`.

- [ ] **Step 4: Commit**

```bash
git add scripts/import-members.ts package.json
git commit -m "feat(import): one-off members CSV seed runner"
```

---

## Task 6: Expose the new dates from server selects

**Files:**
- Modify: `src/server/club.ts` (`listClubMembers` ~line 30-75; `getMemberProfile` ~line 160-210)

- [ ] **Step 1: Add columns to `listClubMembers`**

In `listClubMembers`, extend the roster `.select({ ... })` (currently `id,name,email,office,userId,createdAt`) to include:

```ts
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				originalJoinDate: members.originalJoinDate,
```

and add them to the returned object in `roster.map((m) => ({ ... }))`:

```ts
			createdAt: m.createdAt,
			joinedAt: m.joinedAt,
			originalJoinDate: m.originalJoinDate,
			speeches: speechByMember.get(m.id) ?? 0,
```

- [ ] **Step 2: Add columns to `getMemberProfile`**

In `getMemberProfile`, extend the member `.select({ ... })` to include `joinedAt: members.joinedAt` and `originalJoinDate: members.originalJoinDate`, and add both to the returned `member: { ... }` object.

- [ ] **Step 3: Verify build**

Run: `bun run build`
Expected: compiles (the route files still reference `createdAt`, which remains).

- [ ] **Step 4: Commit**

```bash
git add src/server/club.ts
git commit -m "feat(club): expose joinedAt/originalJoinDate from member selects"
```

---

## Task 7: Trim the mock-pathway module

**Files:**
- Modify: `src/data/club.ts`

- [ ] **Step 1: Delete the mock exports, keep the avatar/status helpers**

Remove from `src/data/club.ts`:
- `RosterSegment` interface + `rosterSegments` array
- `MockPathway` interface, `PATHS`, `PROJECTS`, `hash`, `mockPathway`
- `LevelState`, `LevelStep`, `levelSteps`
- `Award`, `mockAwards`

Keep: `MemberTone`, `avatarGradient`, `MemberStatus`, `StatusMeta`, `statusMeta`. (`avatarGradient`/`MemberTone` are used by `member-avatar.tsx` + `lib/avatar.ts`; `statusMeta`/`MemberStatus` are retained as exports for the future progress issue #61.)

- [ ] **Step 2: Verify nothing else imports the deleted symbols**

Run: `grep -rn "mockPathway\|levelSteps\|mockAwards\|rosterSegments\|RosterSegment\|MockPathway\|LevelStep\|LevelState" src/ | grep -v "src/data/club.ts"`
Expected: only the three route files (`index.tsx`, `members.$id.tsx`, `dashboard.tsx`) — those are fixed in Tasks 8–10. If anything else appears, stop and reassess.

- [ ] **Step 3: Commit** (build will be green after Tasks 8–10; commit the module trim now)

```bash
git add src/data/club.ts
git commit -m "refactor(club): remove mock Pathways progress helpers"
```

---

## Task 8: Dashboard — remove hero ring + "Next up"

**Files:**
- Modify: `src/routes/_authed/dashboard.tsx`

- [ ] **Step 1: Remove the mock imports + usage**

- Delete `import { ProgressRing } from "#/components/club/progress-ring";` (line 3).
- Delete `import { mockPathway } from "#/data/club";` (line 5).
- Delete the `const pathway = mockPathway(authUser.id);` line (~46) and its comment.

- [ ] **Step 2: Delete the hero card**

Remove the entire "Hero (mock Pathway)" `<div>` block (the `flex flex-wrap items-center gap-6 rounded-[18px] ...` div containing `<ProgressRing .../>`, "My Pathway", buttons) — lines ~62-82.

- [ ] **Step 3: Delete the "Next up" card**

Remove the entire "Next up (mock)" `<div>` block (contains `{pathway.project}`, "Your next recommended project", `Level {pathway.level}`, "Schedule this speech") — lines ~135-158.

- [ ] **Step 4: Verify build + lint**

Run: `bun run build && bun run check`
Expected: no errors; `dashboard.tsx` has no unused imports (`Link` is still used by quick actions / upcoming roles — confirm; if `Link` became unused, remove it).

- [ ] **Step 5: Commit**

```bash
git add src/routes/_authed/dashboard.tsx
git commit -m "feat(dashboard): remove fabricated Pathway hero + next-up card"
```

---

## Task 9: Roster — real tenure, drop progress/status columns

**Files:**
- Modify: `src/routes/_authed/index.tsx`

- [ ] **Step 1: Fix imports**

- Remove `StatusPill` import (line 6).
- Change the `#/data/club` import (lines 17-22) to import nothing from it (delete the whole import — `MemberStatus`, `mockPathway`, `RosterSegment`, `rosterSegments` are all gone).
- Change `import { formatTenure, isNewMember } from "#/lib/members";` → `import { formatTenure } from "#/lib/members";` (`isNewMember` no longer used).

- [ ] **Step 2: Shrink `RosterRow` + `TABLE_COLS`**

Replace `TABLE_COLS` (line 45) with:

```ts
const TABLE_COLS = "1fr 150px 34px";
```

Replace the `RosterRow` interface (lines 47-59) with:

```ts
interface RosterRow {
	id: string;
	name: string;
	initials: string;
	tone: ReturnType<typeof toneFromSeed>;
	tenure: string;
	speeches: number;
}
```

- [ ] **Step 3: Simplify the row mapping + remove segments/filter**

Replace the `rows` mapping (lines 68-86) with:

```ts
	// Identity + tenure + speeches are real; Pathways progress is not modeled (#61).
	const rows: RosterRow[] = members.map((m) => {
		const joined = m.joinedAt ?? m.createdAt;
		return {
			id: m.id,
			name: m.name,
			initials: initialsOf(m.name),
			tone: toneFromSeed(m.id),
			tenure: m.office ? `${formatTenure(joined)} · ${m.office}` : formatTenure(joined),
			speeches: m.speeches,
		};
	});
```

Delete the `visible` / `countFor` lines (88-90) and the `const [seg, setSeg] = ...` state (line 65). The table will render `rows` directly.

- [ ] **Step 4: Trim the stat cards**

In the `stats` array (lines 92-116) remove the "Level completions" object (100-103) and the "Needs attention" object (104-109). Keep Active members, Speeches given, Open roles.

- [ ] **Step 5: Remove the segment-filter UI**

Delete the entire "Segment filters" `<div className="mb-4 flex flex-wrap gap-2">...</div>` block (lines 154-165) and the `SegmentChip` component definition (lines 464-499).

- [ ] **Step 6: Update the table header + body**

In the header grid (lines 169-179) remove the `<div>Pathway</div>`, `<div>Level progress</div>`, and `<div>Status</div>` cells — leaving `<div>Member</div>`, `<div>Speeches</div>`, `<div />`.

Change `visible.map(...)` (line 186) to `rows.map(...)`. Inside the row `<Link>`, delete the "Pathway" block (lines 205-213), the "Level progress" block (lines 215-238), and the "Status" `<StatusPill .../>` (line 250).

- [ ] **Step 7: Verify build + lint**

Run: `bun run build && bun run check`
Expected: no errors, no unused symbols. If `cn` or others became unused, remove them.

- [ ] **Step 8: Commit**

```bash
git add src/routes/_authed/index.tsx
git commit -m "feat(roster): real tenure; drop mock Pathway/level/status columns"
```

---

## Task 10: Member detail — real tenure, drop pathway/awards/status

**Files:**
- Modify: `src/routes/_authed/members.$id.tsx`

- [ ] **Step 1: Fix imports**

- Remove `AwardIcon` from the lucide import (line 7): keep `ChevronLeft` only.
- Remove `StatusPill` import (line 11).
- Delete the `#/data/club` import block (lines 24-29: `LevelStep`, `levelSteps`, `mockAwards`, `mockPathway`).
- Change `import { formatTenure, isNewMember } from "#/lib/members";` → `import { formatTenure } from "#/lib/members";`.

- [ ] **Step 2: Replace the mock derivations**

Replace lines 80-87 (the `mockPathway`/`status`/`levels`/`awards`/`tenure` block) with:

```ts
	// Identity, speech log and roles served are real; Pathways progress is not modeled (#61).
	const joined = member.joinedAt ?? member.createdAt;
	const tenure = member.office
		? `${formatTenure(joined)} · ${member.office}`
		: formatTenure(joined);
```

- [ ] **Step 3: Update the header line**

In the header (line 105-111) change `joined {joinedLabel(member.createdAt)}` → `joined {joinedLabel(joined)}`, and delete the status pill markup:

```tsx
					<span className="text-[13.5px] text-[var(--sea-ink-soft)]">
						{tenure} · joined {joinedLabel(joined)}
					</span>
```

(remove the `<span className="size-1 ...">` dot separator and `<StatusPill status={status} long />`).

- [ ] **Step 4: Delete the pathway card + awards card + LevelNode**

- Delete the entire "Pathway + level stepper (mock)" `<div>` block (lines 127-153).
- Delete the entire "Awards earned" side-card `<div>` block (lines 217-234).
- Delete the `LevelNode` function (lines 464-505).

The side-cards column now contains only "Roles served this year".

- [ ] **Step 5: Verify build + lint**

Run: `bun run build && bun run check`
Expected: no errors, no unused symbols (`speeches` is still used by the loader return / speech log header count — confirm; if the removed pathway card was its only use, drop it from the destructure).

- [ ] **Step 6: Commit**

```bash
git add src/routes/_authed/members.$id.tsx
git commit -m "feat(member): real tenure; drop mock pathway/awards/status"
```

---

## Task 11: Delete now-unused components

**Files:**
- Delete: `src/components/club/progress-ring.tsx`
- Delete: `src/components/club/status-pill.tsx`

- [ ] **Step 1: Confirm no importers remain**

Run: `grep -rn "progress-ring\|ProgressRing\|status-pill\|StatusPill" src/`
Expected: no matches (all removed in Tasks 8–10). If any remain, fix them first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/components/club/progress-ring.tsx src/components/club/status-pill.tsx
```

- [ ] **Step 3: Verify build + full check**

Run: `bun run build && bun run check && bun run test`
Expected: build compiles, Biome clean, all Vitest suites pass (including `server-modules.guard.test.ts`).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove unused progress-ring + status-pill components"
```

---

## Task 12: Seed local dev + verify end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Run the seed against local dev**

Run:
```bash
bun run import-members --club 7abb80ca-223a-4cb5-86ed-e90d77c01671
```
Expected: log ends with roughly `inserted=0 updated-by-email=14 updated-by-name=0 skipped-ambiguous=0 skipped-unpaid=0` (all 14 dev members match by email). Note: if a member's stored name matched instead, counts shift but total updates = 14.

- [ ] **Step 2: Verify dates landed**

Run:
```bash
docker exec dev-postgres psql -U dev -d tm_scheduler -tA -F'|' -c "select name, to_char(joined_at,'YYYY-MM-DD'), to_char(original_join_date,'YYYY-MM-DD') from members where club_id='7abb80ca-223a-4cb5-86ed-e90d77c01671' order by name;"
```
Expected: real dates, e.g. `Rasheed Bustamam|2024-10-01|2012-02-01`, `Faisal Ali|2024-05-01|2012-10-01`. Name stays "Rasheed Bustamam" (fill-only). `email`/`office` unchanged.

- [ ] **Step 3: Verify idempotency**

Re-run Step 1's command. Expected: same 14 updates, still `inserted=0` (no duplicates created).

- [ ] **Step 4: Verify the UI renders real tenure (dev server)**

Start dev (`bun run dev`) and open the roster; confirm tenure reads years (e.g. "2 yrs", "1 yr") instead of "today"/weeks, and that no Pathway/level/progress/awards/status UI remains on roster, member detail, or dashboard. (Optional: use the `/browse` skill for a headless check.)

- [ ] **Step 5: No commit** (verification only). If any issue surfaces, fix in the relevant task and re-run.

---

## Self-review notes (coverage)

- Spec §1 schema → Task 1. §2 importer (filter/match/overwrite/mapping/log) → Tasks 2–5. §3 server selects → Task 6. §4 display (tenure + removals across roster/detail/dashboard + club.ts trim + component deletes) → Tasks 7–11. §5 issues → already created (#61–64). Verification (seed dev, idempotency, guard test) → Tasks 11–12.
- Out-of-scope items (office, customerId, real progress) are intentionally not implemented.
