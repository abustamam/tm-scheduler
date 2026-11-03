/**
 * Source guard for #1492. It checks ONE thing: the write call sites (`.insert(`,
 * `.update(`, `.delete(`, `execute(`) and the `from(people)` reads written
 * directly in `history-import-logic.ts` and `mentor-import-logic.ts`, by function
 * and by count. A new call site, or one removed or moved to another function,
 * fails here until somebody names it and the rule it follows (the issue's
 * W1-W16 / R1-R2 table). Same shape as `person-email-writers.guard.test.ts`.
 *
 * What it does NOT check: writes made by a helper these files CALL. Those writers
 * are outside the scan and are held by their own tests and rules: W4
 * `insertRosterMember` (the roster paste's helper), `createGuestRecord`, W5
 * `openOfficerTermIfAbsent`, `importPlanAnswers`, `closeCoverRequest` and
 * `logActivity`. P1 (the plan's `emailWritable` rule in `placeContacts`) lives in
 * `src/lib/easy-speak-import-plan.ts`, outside the scan; it is pinned by that
 * module's tests, and below only by the name being present.
 *
 * Read COMMENT-BLIND (`readSource`).
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const FILES = [
	"src/server/history-import-logic.ts",
	"src/server/mentor-import-logic.ts",
];

/** The top-level function each offset falls in, "(module)" before the first. */
function enclosingFunctions(source: string): (at: number) => string {
	const heads = [
		...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm),
	].map((m) => ({ at: m.index ?? 0, name: m[1] as string }));
	return (at) => {
		let name = "(module)";
		for (const h of heads) {
			if (h.at <= at) name = h.name;
			else break;
		}
		return name;
	};
}

/** `file#function` -> number of matches of `pattern`. */
function countByFunction(
	pattern: RegExp,
	files: string[] = FILES,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const file of files) {
		// `createHash(...).update(` is a digest, not a database write.
		const source = readSource(file).replace(
			/createHash\([^)]*\)\s*\.update\(/g,
			"createHash(",
		);
		const where = enclosingFunctions(source);
		for (const m of source.matchAll(pattern)) {
			const key = `${file.replace("src/server/", "")}#${where(m.index ?? 0)}`;
			out[key] = (out[key] ?? 0) + 1;
		}
	}
	return Object.fromEntries(
		Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
	);
}

/**
 * Every write, with the issue's row (W1..W16) and the manual rule it follows.
 * Changing a count means re-reading the row: is the write still club-scoped and
 * fill-only (or insert-only) where the manual edit is?
 */
const WRITES: Record<string, { count: number; rule: string }> = {
	"history-import-logic.ts#storeEasySpeakBundle": {
		count: 2,
		rule: "W1 insert club_imports: import-only table, club-scoped; W1b delete club_imports beyond the newest MAX_UNAPPLIED_IMPORTS unapplied rows of this club (applied_at IS NULL and club_id in the statement), import-only table, no manual equivalent",
	},
	"history-import-logic.ts#putRef": {
		count: 1,
		rule: "W2 insert import_refs: import-only table, club-scoped",
	},
	"history-import-logic.ts#writePeopleAndRoles": {
		count: 2,
		rule: "W3 insert role_definitions (standing: false, an admin role edit); W4's member_add goes through insertRosterMember, the roster paste's helper",
	},
	"history-import-logic.ts#fillMemberContact": {
		count: 2,
		rule: "W6 update people.email carries isNull(userId) + soleHoldingClub (#907); W7 update people.phone fills a blank only (stricter than the member edit)",
	},
	"history-import-logic.ts#applyMeeting": {
		count: 10,
		rule: "W8-W13 guest kind, meeting fill-only/insert, role slot create/fill-empty, speech, attendance, awards, table topics: club-loaded ids, fill-only",
	},
	"history-import-logic.ts#applyUnderImportLock": {
		count: 1,
		rule: "W14 update club_imports applied marker, (id, club_id)",
	},
	"history-import-logic.ts#takeImportLock": {
		count: 1,
		rule: "advisory lock (execute), no row written",
	},
	"history-import-logic.ts#importSpeechRequests": {
		count: 1,
		rule: "W15 insert speech_requests: a speech request, club-scoped",
	},
	"mentor-import-logic.ts#importWillingFlags": {
		count: 1,
		rule: "W16 update members.willing_to_mentor, club + active in the statement. ACCEPTED (maintainer, 2026-11-03): the flag is set only for active members of THIS club named as mentors in the club's own Easy-Speak history; it does not list them on 'Find a mentor' (mentor_listed_at stays null); an admin can already pair members directly, so the import grants nothing new",
	},
	"mentor-import-logic.ts#importMentorPairs": {
		count: 1,
		rule: "W16 insert mentorships: both members in the club, active",
	},
};

/** Every `from(people)` read, and what scopes it. */
const PEOPLE_READS: Record<string, { count: number; scope: string }> = {
	"history-import-logic.ts#loadContactState": {
		count: 2,
		scope:
			"R1 holders: INNER JOIN members on this club (#1492); the writable set reads only the Persons of this club's members, with the member-edit predicates",
	},
	"history-import-logic.ts#emailHeldByOther": {
		count: 1,
		scope:
			"R2 whole table ON PURPOSE: it protects the write (stricter than the roster paste); its answer reaches the report only as one neutral sentence",
	},
	"history-import-logic.ts#fillMemberContact": {
		count: 1,
		scope:
			"the member's own Person, read by id after a club-scoped member read",
	},
};

describe("history import write sites (#1492)", () => {
	// protects=no write call site appears in the two import files without being
	// listed (function and count) with the manual rule it follows;
	// fails_when=a .insert/.update/.delete/execute is added, removed or moved;
	// no_claim=writes inside helpers these files call (see the header).
	it("names every insert, update, delete and execute, by function and count", () => {
		const found = countByFunction(
			/\.(?:insert|update|delete)\(|\bexecute[<(]/g,
		);
		const declared = Object.fromEntries(
			Object.entries(WRITES).map(([k, v]) => [k, v.count]),
		);
		// Compared per function, so a write added ANYWHERE fails.
		expect(found).toEqual(declared);
	});

	// protects=every from(people) read in the two files is listed with its scope;
	// fails_when=a people read is added, removed or moved;
	// no_claim=reads in helpers they call, or what the scope list says is true.
	it("names every read of the people table, by function and count", () => {
		const found = countByFunction(/\.from\(people\)/g);
		expect(found).toEqual(
			Object.fromEntries(
				Object.entries(PEOPLE_READS).map(([k, v]) => [k, v.count]),
			),
		);
	});

	// protects=R1's holder read stays an INNER JOIN on members of THIS club with the
	// member-edit predicates;
	// fails_when=the members.clubId scope, isNull(people.userId) or soleHoldingClub
	// is dropped from loadContactState;
	// no_claim=the rows it returns (the integration suite).
	it("the club-scoped holder read joins members on THIS club", () => {
		const source = readSource("src/server/history-import-logic.ts");
		const body =
			/async function loadContactState[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
		expect(body).toMatch(
			/innerJoin\(\s*members,\s*and\(eq\(members\.personId, people\.id\), eq\(members\.clubId, clubId\)\)/,
		);
		expect(body).toContain("isNull(people.userId)");
		expect(body).toContain("soleHoldingClub(clubId)");
	});

	// protects=W6's update keeps both member-edit predicates inside fillMemberContact;
	// fails_when=isNull(people.userId) or soleHoldingClub is dropped from it;
	// no_claim=that the statement filters on them (person-email-writers.guard.test.ts).
	it("the email write keeps both member-edit predicates in its own statement", () => {
		const source = readSource("src/server/history-import-logic.ts");
		const body =
			/async function fillMemberContact[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
		expect(body).toContain("isNull(people.userId)");
		expect(body).toContain("soleHoldingClub(clubId)");
	});

	// protects=P1's plan-side rule exists where the guard cannot scan: the plan
	// module still carries emailWritable;
	// fails_when=emailWritable is removed from easy-speak-import-plan.ts;
	// no_claim=what placeContacts does with it (easy-speak-import-plan tests).
	it("names P1: the plan module still has the emailWritable rule", () => {
		expect(readSource("src/lib/easy-speak-import-plan.ts")).toContain(
			"emailWritable",
		);
	});
});
