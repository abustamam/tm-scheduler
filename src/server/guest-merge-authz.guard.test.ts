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
			// protects=every guest-merge server fn resolves a session and calls requireClubRole(admin) before any read or write, with the declared HTTP method;
			// fails_when=the requireUser or requireClubRole call is removed, moved after the work, loosened to a wider role list, or the method changes;
			// no_claim=that the role check behaves (guards.ts tests), or what the logic does once past the gate (guest-merge.integration.test.ts)
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
		// protects=lockClubForWrite, then assertStillClubAdmin, then lockPersonsInOrder, then the guest row locks, in that source order;
		// fails_when=the standing re-check is removed or moved before the lock, or the Person locks come after the guest row locks (a deadlock order);
		// no_claim=that the lock order is deadlock-free against speech-detail writers (a maintainer decision, not pinned here)
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
		// protects=the absorbed Person is deleted only through deleteGuestPersonIfUnreferenced behind unboundGuestOnlyPerson, and each contact fill statement carries guestContactWritable(clubId);
		// fails_when=a raw people delete replaces the helper, the guest-only check is dropped, or a contact fill loses its guestContactWritable predicate;
		// no_claim=that the helper refuses correctly (guests-logic tests) or the rollback itself (integration test)
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
function guestColumns(schema: string = SCHEMA): GuestColumn[] {
	const out: GuestColumn[] = [];
	const tableRe = /export const (\w+) = pgTable\(\s*"([a-z_]+)",\s*\{/g;
	const starts: Array<{ exportName: string; table: string; at: number }> = [];
	for (const m of schema.matchAll(tableRe)) {
		starts.push({
			exportName: m[1] ?? "",
			table: m[2] ?? "",
			at: m.index ?? 0,
		});
	}
	starts.forEach((t, i) => {
		const block = schema.slice(t.at, starts[i + 1]?.at ?? schema.length);
		const uuidProps = new Map<string, string>();
		const seen = new Set<string>();
		// A column: `prop: uuid("col")` plus its chained modifiers, up to the next
		// column or the end of the column object.
		const colRe =
			/\n\t{1,2}(\w+): uuid\("([a-z_]+)"\)([\s\S]*?)(?=\n\t{1,2}\w+: |\n\t{1,2}\},?)/g;
		for (const c of block.matchAll(colRe)) {
			const [, prop, column, tail] = c;
			uuidProps.set(prop ?? "", column ?? "");
			const named = /guest_id$/.test(column ?? "");
			const refs = /references\(\(\) => guests\.id/.test(tail ?? "");
			if (named || refs) {
				seen.add(prop ?? "");
				out.push({
					table: t.table,
					column: column ?? "",
					exportName: t.exportName,
					prop: prop ?? "",
				});
			}
		}
		// A table-level `foreignKey({ columns: [t.x], foreignColumns: [guests.id] })`
		// names a guest whatever the column is called.
		for (const fk of block.split("foreignKey({").slice(1)) {
			const body = fk.slice(0, fk.indexOf("})"));
			if (!/foreignColumns:\s*\[\s*guests\.id\s*\]/.test(body)) continue;
			const cols = /\bcolumns:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "";
			for (const ref of cols.matchAll(/t\.(\w+)/g)) {
				const prop = ref[1] ?? "";
				const column = uuidProps.get(prop);
				if (column && !seen.has(prop)) {
					seen.add(prop);
					out.push({
						table: t.table,
						column,
						exportName: t.exportName,
						prop,
					});
				}
			}
		}
	});
	return out;
}

/** Named exemptions: the merge deliberately leaves these alone. */
const EXEMPT: Record<string, { kind: "uuid" | "json"; reason: string }> = {
	// A forensic copy of contact details, a PK with no FK, kept as history.
	"guests_contact_backup.guest_id": {
		kind: "uuid",
		reason: "forensic backup keyed by guest id, kept as history",
	},
	// A jsonb column, never a uuid the scan sees: a link may stash the guest's
	// contact in member_merge's detail. Handled by name in the logic (cleared),
	// asserted in its own test below.
	"activity_log.detail": {
		kind: "json",
		reason: "member_merge detail.guestContact; cleared by name, not re-pointed",
	},
};

describe("guest merge column enumeration (#1609, AC 8)", () => {
	const cols = guestColumns();

	it("finds the columns the issue's table lists (the scan itself works)", () => {
		// protects=the scan finds the twelve columns the issue enumerates, so a green enumeration test is not an empty scan;
		// fails_when=the table or column regex stops matching schema.ts's shape;
		// no_claim=that columns outside the issue's list are handled (the next test)
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
		// protects=any uuid column of schema.ts that is named *guest_id or references guests.id (column-level or via a table-level foreignKey) is named in guest-merge-logic.ts and listed in GUEST_MERGE_TABLES;
		// fails_when=a table gains a guest column and the merge is not taught about it (its FK would cascade the rows away with the absorbed guest);
		// no_claim=that the re-point is correct (guest-merge.integration.test.ts)
		const listed = (
			/GUEST_MERGE_TABLES = \[([\s\S]*?)\] as const/.exec(LOGIC)?.[1] ?? ""
		).match(/"([a-z_]+)"/g);
		const tables = new Set((listed ?? []).map((s) => s.replaceAll('"', "")));
		const unhandled: string[] = [];
		for (const c of cols) {
			const key = `${c.table}.${c.column}`;
			if (key in EXEMPT) continue;
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
		// protects=the two import_refs kinds that name a guest or its attendance row are re-pointed;
		// fails_when=either re-point is removed from the logic source;
		// no_claim=that the re-point values are right (integration test)
		expect(LOGIC).toMatch(/eq\(importRefs\.kind,\s*"guest"\)/);
		expect(LOGIC).toMatch(/ir\.kind = 'attendance'/);
	});

	it("the exemptions are real columns, so a rename cannot hide one", () => {
		// protects=every named exemption still exists in schema.ts (a uuid column the scan sees, or the activity_log.detail jsonb), so a rename cannot leave a stale exemption hiding a new column;
		// fails_when=an exempt column is renamed or dropped without the exemption list changing;
		// no_claim=that the exemption is the right call (the reason beside each one)
		for (const [key, ex] of Object.entries(EXEMPT)) {
			if (ex.kind === "uuid") {
				expect(
					cols.map((c) => `${c.table}.${c.column}`),
					`${key} is exempt but no longer exists`,
				).toContain(key);
			} else {
				expect(
					/export const activityLog = pgTable\([\s\S]*?\n\t+detail: jsonb\(/.test(
						SCHEMA,
					),
					`${key} is exempt but no longer exists`,
				).toBe(true);
			}
		}
	});

	it("activity_log.detail is handled by name: the stashed guestContact of the absorbed guest is cleared", () => {
		// protects=the one jsonb place a guest's contact can hide (member_merge detail.guestContact for fromGuestId) is cleaned by the merge;
		// fails_when=the clean-up UPDATE is removed from the logic (the absorbed guest's email and phone would outlive the guest);
		// no_claim=that the clean-up value is right (applyDeleteGuest has the same one)
		expect(LOGIC).toMatch(/- 'guestContact'/);
		expect(LOGIC).toMatch(/detail\}->>'fromGuestId' = \$\{A\}/);
	});

	it("the scan also finds a guests.id foreign key declared at table level on a column not named *guest_id", () => {
		// protects=a table-level foreignKey({ columns: [t.x], foreignColumns: [guests.id] }) is enumerated even when the column is called something else, so it cannot dodge the AC 8 guard by name;
		// fails_when=the table-level foreignKey branch of guestColumns is removed or only matches *guest_id names;
		// no_claim=that schema.ts contains such a column today (it does not; this is a fixture)
		const fixture = `export const weirdTable = pgTable(
	"weird_table",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		meetingId: uuid("meeting_id").notNull(),
		pal: uuid("pal_ref"),
		other: uuid("other_ref"),
	},
	(t) => [
		foreignKey({
			name: "weird_meeting_fk",
			columns: [t.meetingId],
			foreignColumns: [meetings.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "weird_pal_fk",
			columns: [t.pal],
			foreignColumns: [guests.id],
		}).onDelete("cascade"),
	],
);
`;
		expect(guestColumns(fixture).map((c) => `${c.table}.${c.column}`)).toEqual([
			"weird_table.pal_ref",
		]);
	});
});
