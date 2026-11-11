/**
 * The guest merge (#1609) is still behind its gates, and still handles every
 * column that names a guest.
 *
 * `guest-merge.integration.test.ts` proves what the logic does against a real
 * database. It cannot prove the server fns are what call `requireClubRole`: a
 * `createServerFn` has no session under vitest, so the handler body is
 * unreachable. This pins that wiring, comment-blind (`readSource`).
 *
 * The second half is the enumeration (acceptance criterion 8): it re-derives
 * every column in `schema.ts` that references `guests.id` (or is named
 * `*guest_id`) and fails when the merge's source does not touch it. A table
 * that gains a guest column tomorrow fails HERE instead of cascading rows away
 * (a guest FK with ON DELETE CASCADE deletes them with the absorbed row).
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const SERVER_FNS = readSource(resolve(__dirname, "guest-merge.ts"));
const LOGIC = readSource(resolve(__dirname, "guest-merge-logic.ts"));
const SCHEMA = readSource(resolve(__dirname, "../db/schema.ts"));

describe("guest merge authz wiring (#1609)", () => {
	// The candidate list only reads, so it is a GET (club-logo-method.guard, #504);
	// the preview runs the merge in a rolled-back transaction under the club lock.
	for (const [name, method] of [
		["mergeGuests", "POST"],
		["previewMergeGuests", "POST"],
		["listMergeGuestCandidates", "GET"],
	] as const) {
		it(`${name} is a ${method} that resolves a session and requires the club admin role before it reads or writes`, () => {
			const body = serverFnBody(SERVER_FNS, name);
			expect(serverFnDecl(name)).toMatch(new RegExp(`method:\\s*"${method}"`));
			expect(body).toContain("await requireUser()");
			expect(body).toMatch(
				/requireClubRole\(\s*currentUser\.id,\s*data\.clubId,\s*\[\s*["']admin["'],?\s*\]\s*\)/,
			);
			const gate = body.indexOf("requireClubRole(");
			const work = Math.max(
				body.indexOf("applyMergeGuests("),
				body.indexOf("previewMergeGuestsLogic("),
				body.indexOf("listMergeGuestCandidatesLogic("),
			);
			expect(gate).toBeGreaterThanOrEqual(0);
			expect(gate).toBeLessThan(work);
		});
	}

	it("the apply re-asks admin standing and the archive gate under the club lock, in the ADR-0031 order", () => {
		const apply = functionBody(LOGIC, "applyMergeGuests");
		const lock = apply.indexOf("lockClubForWrite(");
		const standing = apply.indexOf("assertStillClubAdmin(");
		const persons = apply.indexOf("lockPersonsInOrder(");
		const guestRows = apply.indexOf("readGuestForUpdate(");
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(lock).toBeLessThan(standing);
		expect(standing).toBeLessThan(persons);
		expect(persons).toBeLessThan(guestRows);
	});

	it("the Person delete rides deleteGuestPersonIfUnreferenced and a refusal there rolls the merge back", () => {
		const apply = functionBody(LOGIC, "applyMergeGuests");
		expect(apply).toMatch(/deleteGuestPersonIfUnreferenced\(/);
		expect(apply).toMatch(/unboundGuestOnlyPerson\(\)/);
		// The contact fill carries the officer-edit predicate in its own WHERE.
		expect(apply.match(/guestContactWritable\(clubId\)/g)).toHaveLength(2);
	});
});

/** The `createServerFn(...)` declaration text, for the `method` check. */
function serverFnDecl(name: string): string {
	const at = SERVER_FNS.indexOf(`export const ${name} =`);
	expect(at, `${name} is not declared`).toBeGreaterThanOrEqual(0);
	return SERVER_FNS.slice(at, at + 120);
}

/** One top-level function's source: from its declaration to `\n}\n`. */
function functionBody(source: string, fn: string): string {
	const start = new RegExp(
		`(?:^|\\n)(?:export )?(?:async )?function ${fn}\\b`,
	).exec(source);
	expect(start, `${fn} is not in the file`).not.toBeNull();
	const from = start?.index ?? 0;
	const end = source.indexOf("\n}\n", from + 1);
	return source.slice(from, end === -1 ? undefined : end + 3);
}

interface GuestColumn {
	/** The SQL table name. */
	table: string;
	/** The SQL column name. */
	column: string;
	/** The drizzle export (`guestInvites`) and property (`guestId`). */
	exportName: string;
	prop: string;
}

/**
 * Every column of `schema.ts` that references `guests.id` or is named
 * `*guest_id`. Re-derived from the source text on every run.
 */
function guestColumns(): GuestColumn[] {
	const out: GuestColumn[] = [];
	const tableRe = /export const (\w+) = pgTable\(\s*"([a-z_]+)",\s*\{/g;
	const starts: Array<{ exportName: string; table: string; at: number }> = [];
	for (const m of SCHEMA.matchAll(tableRe)) {
		starts.push({
			exportName: m[1] ?? "",
			table: m[2] ?? "",
			at: m.index ?? 0,
		});
	}
	starts.forEach((t, i) => {
		const block = SCHEMA.slice(t.at, starts[i + 1]?.at ?? SCHEMA.length);
		// A column: `prop: uuid("col")` plus its chained modifiers, up to the next
		// column or the end of the column object.
		const colRe =
			/\n\t{1,2}(\w+): uuid\("([a-z_]+)"\)([\s\S]*?)(?=\n\t{1,2}\w+: |\n\t{1,2}\},?)/g;
		for (const c of block.matchAll(colRe)) {
			const [, prop, column, tail] = c;
			const named = /guest_id$/.test(column ?? "");
			const refs = /references\(\(\) => guests\.id/.test(tail ?? "");
			if (named || refs) {
				out.push({
					table: t.table,
					column: column ?? "",
					exportName: t.exportName,
					prop: prop ?? "",
				});
			}
		}
	});
	return out;
}

/** Named exemptions: the merge deliberately leaves these alone. */
const EXEMPT = new Set([
	// A forensic copy of contact details, a PK with no FK, kept as history.
	"guests_contact_backup.guest_id",
]);

describe("guest merge column enumeration (#1609, AC 8)", () => {
	const cols = guestColumns();

	it("finds the columns the issue's table lists (the scan itself works)", () => {
		const keys = cols.map((c) => `${c.table}.${c.column}`);
		for (const expected of [
			"guest_invites.guest_id",
			"role_slots.assigned_guest_id",
			"slot_cover_requests.covered_guest_id",
			"meeting_guest_rsvps.guest_id",
			"meeting_attendance.guest_id",
			"table_topics_speakers.guest_id",
			"meeting_awards.guest_id",
			"meeting_votes.voter_guest_id",
			"meeting_votes.candidate_guest_id",
			"meeting_ballot_guests.guest_id",
			"meeting_candidate_disqualifications.candidate_guest_id",
			"speeches.guest_id",
		]) {
			expect(keys, `the scan lost ${expected}`).toContain(expected);
		}
	});

	it("every guest-referencing column is handled by the merge, or is a named exemption", () => {
		const listed = (
			/GUEST_MERGE_TABLES = \[([\s\S]*?)\] as const/.exec(LOGIC)?.[1] ?? ""
		).match(/"([a-z_]+)"/g);
		const tables = new Set((listed ?? []).map((s) => s.replaceAll('"', "")));
		const unhandled: string[] = [];
		for (const c of cols) {
			const key = `${c.table}.${c.column}`;
			if (EXEMPT.has(key)) continue;
			// Handled = the logic's source names the drizzle column AND the table is
			// in the exported list the preview reports against.
			if (
				!LOGIC.includes(`${c.exportName}.${c.prop}`) ||
				!tables.has(c.table)
			) {
				unhandled.push(key);
			}
		}
		expect(
			unhandled,
			`a column naming guests.id is not handled by guest-merge-logic.ts (a guest FK that cascades deletes these rows with the absorbed guest): ${unhandled.join(", ")}`,
		).toEqual([]);
	});

	it("import_refs (no FK, kind guest and attendance) is handled", () => {
		expect(LOGIC).toMatch(/eq\(importRefs\.kind,\s*"guest"\)/);
		expect(LOGIC).toMatch(/ir\.kind = 'attendance'/);
	});

	it("the exemptions are real columns, so a rename cannot hide one", () => {
		for (const key of EXEMPT) {
			expect(
				cols.map((c) => `${c.table}.${c.column}`),
				`${key} is exempt but no longer exists`,
			).toContain(key);
		}
	});
});
