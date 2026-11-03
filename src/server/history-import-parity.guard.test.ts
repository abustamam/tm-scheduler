/**
 * Source guard: **every database write the Easy-Speak import makes, and every
 * read of `people` it makes, is named here** (#1492).
 *
 * A club's own admin now runs the import, so each write has to follow the rule of
 * the equivalent manual admin edit (the issue's W1-W16 table) and each read of a
 * Person has to be club-scoped or deliberately not. A new `.insert(`,
 * `.update(`, `.delete(` or `execute(` in `history-import-logic.ts` or
 * `mentor-import-logic.ts`, or a new `from(people)`, fails here until somebody
 * names its function, its count and the rule it follows. The same shape as
 * `person-email-writers.guard.test.ts`: by function and by count, so a second
 * write inside a function already on the list is not silently exempt.
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
		count: 1,
		rule: "W1 insert club_imports: import-only table, club-scoped",
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
		rule: "W16 update members.willing_to_mentor, club + active in the statement",
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

	it("names every read of the people table, by function and count", () => {
		const found = countByFunction(/\.from\(people\)/g);
		expect(found).toEqual(
			Object.fromEntries(
				Object.entries(PEOPLE_READS).map(([k, v]) => [k, v.count]),
			),
		);
	});

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

	it("the email write keeps both member-edit predicates in its own statement", () => {
		const source = readSource("src/server/history-import-logic.ts");
		const body =
			/async function fillMemberContact[\s\S]*?\n}\n/.exec(source)?.[0] ?? "";
		expect(body).toContain("isNull(people.userId)");
		expect(body).toContain("soleHoldingClub(clubId)");
	});
});
