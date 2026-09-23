import { describe, expect, it } from "vitest";
import type { MappedMember } from "./members-csv";
import { batchSharedEmails } from "./members-csv";
import {
	ADDRESS_CONFLICT_NOTE,
	addressConflictFor,
	classifyMembership,
	type ExistingMembershipRow,
	type ExistingPersonRow,
	FOREIGN_SKIP_NOTE,
	normalizeAddress,
	planImport,
	resolvePersonDecision,
	writtenAddress,
} from "./members-import-plan";

/** A Person the importing club holds, not linked to an account. */
const HERE = { heldBy: "this_club", linked: false } as const;
const NO_HOLDERS = new Map<string, string[]>();

/** Minimal mapped-CSV row builder (all fields default to null). */
function row(over: Partial<MappedMember>): MappedMember {
	return {
		customerId: null,
		name: "Unnamed",
		email: null,
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
		...over,
	};
}

describe("resolvePersonDecision", () => {
	const people: ExistingPersonRow[] = [
		{
			id: "p1",
			customerId: "PN-1",
			email: "ada@x.io",
			name: "Ada",
			phone: null,
			...HERE,
		},
		{
			id: "p2",
			customerId: null,
			email: "bob@x.io",
			name: "Bob",
			phone: "+1",
			...HERE,
		},
	];

	it("matches by Customer ID and fills only empty person fields", () => {
		const d = resolvePersonDecision(
			row({ customerId: "PN-1", name: "Ada Newname", email: "new@x.io" }),
			people,
			new Set(),
		);
		expect(d.kind).toBe("customerId");
		if (d.kind !== "customerId") throw new Error("expected match");
		// Name already present → not overwritten (fill-only).
		expect(d.set.name).toBe("Ada");
		// And the SET carries no `email` at all (#756): a match never re-keys an
		// existing Person's identity, so the field is gone from the type. Asserted
		// on the VALUE rather than left to the compiler, because this is the shape
		// the committing writer and the dry-run preview must agree on — the last
		// time they disagreed, a row that previewed as a match minted a duplicate
		// Person and a duplicate roster row on commit.
		expect(Object.hasOwn(d.set, "email")).toBe(false);
	});

	it("matches by email and inserts when nothing matches", () => {
		expect(
			resolvePersonDecision(row({ email: "BOB@x.io" }), people, new Set()).kind,
		).toBe("email");
		expect(
			resolvePersonDecision(row({ email: "z@x.io" }), people, new Set()).kind,
		).toBe("insert");
	});

	it("forces ambiguous when the email is shared this batch", () => {
		const rows = [
			row({ name: "Pat", email: "fam@x.io" }),
			row({ name: "Sam", email: "fam@x.io" }),
		];
		const shared = batchSharedEmails(rows);
		expect(resolvePersonDecision(rows[0], people, shared).kind).toBe(
			"ambiguous",
		);
	});
});

describe("classifyMembership", () => {
	it("inserts when there is no existing membership", () => {
		const d = classifyMembership(
			row({ name: "New", email: "n@x.io", joinedAt: new Date("2024-01-01") }),
			undefined,
		);
		expect(d.kind).toBe("insert");
	});

	it("fill-only update: keeps a non-empty stored value, fills an empty one", () => {
		const existing = { name: "Stored Name", email: null, phone: "+1" };
		const d = classifyMembership(
			row({ name: "CSV Name", email: "csv@x.io", phone: "+2" }),
			existing,
		);
		expect(d.kind).toBe("update");
		if (d.kind !== "update") throw new Error("expected update");
		// Name + phone already present → untouched; empty email → filled.
		expect(d.set.name).toBe("Stored Name");
		expect(d.set.phone).toBe("+1");
		expect(d.set.email).toBe("csv@x.io");
		expect(d.fills.map((f) => f.field)).toEqual(["email"]);
	});

	it("always (re)writes joinedAt on an update", () => {
		const joined = new Date("2024-05-01");
		const d = classifyMembership(row({ name: "X", joinedAt: joined }), {
			name: "X",
			email: "x@x.io",
			phone: "+1",
		});
		if (d.kind !== "update") throw new Error("expected update");
		expect(d.set.joinedAt).toBe(joined);
	});
});

describe("planImport", () => {
	it("classifies insert vs update vs skip against the existing roster", () => {
		const people: ExistingPersonRow[] = [
			{
				id: "p1",
				customerId: null,
				email: "ada@x.io",
				name: "Ada",
				phone: null,
				...HERE,
			},
		];
		const memberships: ExistingMembershipRow[] = [
			{ id: "m1", personId: "p1", name: "Ada", email: "ada@x.io", phone: null },
		];
		const plan = planImport(
			people,
			memberships,
			[
				row({ name: "Ada", email: "ada@x.io", phone: "+1" }), // update (fills phone)
				row({ name: "Bob", email: "bob@x.io" }), // insert
				row({ name: "" }), // skip (blank name)
			],
			NO_HOLDERS,
		);
		expect(plan.summary.toUpdate).toBe(1);
		expect(plan.summary.toInsert).toBe(1);
		expect(plan.summary.toSkip).toBe(1);
		expect(plan.rows.map((r) => r.action)).toEqual([
			"update",
			"insert",
			"skip",
		]);
		expect(plan.rows[0].note).toContain("Fills phone");
	});

	it("splits a shared family email into two distinct new members", () => {
		const plan = planImport(
			[],
			[],
			[
				row({ name: "Pat", email: "fam@x.io" }),
				row({ name: "Sam", email: "fam@x.io" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.toInsert).toBe(2);
		expect(plan.summary.ambiguous).toBe(2);
		expect(plan.rows.every((r) => r.action === "insert")).toBe(true);
	});

	it("re-importing the same batch would be all updates (idempotent shape)", () => {
		const people: ExistingPersonRow[] = [
			{
				id: "p1",
				customerId: "PN-1",
				email: "ada@x.io",
				name: "Ada",
				phone: "+1",
				...HERE,
			},
		];
		const memberships: ExistingMembershipRow[] = [
			{ id: "m1", personId: "p1", name: "Ada", email: "ada@x.io", phone: "+1" },
		];
		const plan = planImport(
			people,
			memberships,
			[
				row({
					customerId: "PN-1",
					name: "Ada",
					email: "ada@x.io",
					phone: "+1",
				}),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.toUpdate).toBe(1);
		expect(plan.summary.toInsert).toBe(0);
	});
});

/**
 * The cross-club attach gate (#759). A match onto a Person only ANOTHER club
 * holds would give them a second club, and `rosterPermitsBind` refuses a Person
 * two clubs hold — so an import could deny a stranger sign-in from a club they
 * cannot see. These pin the planner half; the integration suite pins the writer
 * against the same decisions.
 */
describe("resolvePersonDecision — heldBy gate (#759)", () => {
	const person = (
		over: Partial<ExistingPersonRow> & { id: string },
	): ExistingPersonRow => ({
		customerId: null,
		email: null,
		name: "Someone",
		phone: null,
		...HERE,
		...over,
	});

	it("refuses a Customer-ID match onto a Person only another club holds", () => {
		const d = resolvePersonDecision(
			row({ customerId: "PN-V", name: "Vic" }),
			[person({ id: "v", customerId: "PN-V", heldBy: "other_club_only" })],
			new Set(),
		);
		expect(d).toEqual({ kind: "foreign", reason: "customerId" });
	});

	it("refuses an email match onto a Person only another club holds", () => {
		const d = resolvePersonDecision(
			row({ name: "Vic", email: "VIC@x.io" }),
			[person({ id: "v", email: "vic@x.io", heldBy: "other_club_only" })],
			new Set(),
		);
		expect(d).toEqual({ kind: "foreign", reason: "email" });
	});

	it("post-checks: a foreign Customer ID is refused even when the email matches a LOCAL member", () => {
		// The ordering the spec names. Filtering foreign candidates out first
		// would let this row fall through to the email arm and silently attach
		// it to `local` — a DIFFERENT member of this club.
		const d = resolvePersonDecision(
			row({ customerId: "PN-V", name: "Vic", email: "loc@x.io" }),
			[
				person({ id: "v", customerId: "PN-V", heldBy: "other_club_only" }),
				person({ id: "local", email: "loc@x.io" }),
			],
			new Set(),
		);
		expect(d).toEqual({ kind: "foreign", reason: "customerId" });
	});

	it("still matches a Person nobody holds — an orphan left by a remove or an undo", () => {
		// Refusing would make the writer insert a row carrying the orphan's
		// Customer ID, which `people_customer_id_unique` rejects mid-file.
		const d = resolvePersonDecision(
			row({ customerId: "PN-O", name: "Orphan" }),
			[person({ id: "o", customerId: "PN-O", heldBy: "nobody" })],
			new Set(),
		);
		expect(d.kind).toBe("customerId");
	});

	it("still matches a Person this club holds, whatever the membership's status", () => {
		// `this_club` is ANY roster row here; the loader applies no status filter,
		// so an inactive member is as matchable as an active one.
		const d = resolvePersonDecision(
			row({ name: "Kim", email: "kim@x.io" }),
			[person({ id: "k", email: "kim@x.io", heldBy: "this_club" })],
			new Set(),
		);
		expect(d.kind).toBe("email");
	});
});

describe("planImport — foreign rows and shared addresses (#759)", () => {
	it("renders a foreign row as a skip with a reason, on its own counter", () => {
		const plan = planImport(
			[
				{
					id: "v",
					customerId: "PN-V",
					email: null,
					name: "Vic",
					phone: null,
					heldBy: "other_club_only",
					linked: false,
				},
			],
			[],
			[row({ customerId: "PN-V", name: "Vic" }), row({ name: "" })],
			NO_HOLDERS,
		);
		expect(plan.summary.foreignSkipped).toBe(1);
		// NOT folded into the blank-name count, which keeps its one meaning.
		expect(plan.summary.toSkip).toBe(1);
		expect(plan.summary.toInsert).toBe(0);
		expect(plan.summary.peopleCreated).toBe(0);
		expect(plan.rows[0]).toMatchObject({
			action: "skip",
			note: FOREIGN_SKIP_NOTE.customerId,
		});
	});

	it("does not tell the officer-approval pass about a foreign row", () => {
		// `planOfficerAccess` builds its proposals from `onResolved`. A foreign row
		// resolving to the foreign Person would propose granting an office on a
		// membership the commit never creates.
		const seen: number[] = [];
		planImport(
			[
				{
					id: "v",
					customerId: "PN-V",
					email: null,
					name: "Vic",
					phone: null,
					heldBy: "other_club_only",
					linked: false,
				},
			],
			[],
			[row({ customerId: "PN-V", name: "Vic", officerPosition: "president" })],
			NO_HOLDERS,
			(i) => seen.push(i),
		);
		expect(seen).toEqual([]);
	});

	it("resolves a second row for the same NEW person to the first, not as foreign", () => {
		const plan = planImport(
			[],
			[],
			[
				row({ customerId: "PN-N", name: "Nia" }),
				row({ customerId: "PN-N", name: "Nia" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.foreignSkipped).toBe(0);
		expect(plan.summary.peopleCreated).toBe(1);
		expect(plan.summary.toInsert).toBe(1);
		expect(plan.summary.toUpdate).toBe(1);
	});

	it("counts and notes a row whose written address another Person carries", () => {
		const plan = planImport(
			[],
			[],
			[row({ name: "New", email: "Shared@x.io" })],
			new Map([["shared@x.io", ["someone-else"]]]),
		);
		expect(plan.summary.addressConflicts).toBe(1);
		expect(plan.rows[0]?.action).toBe("insert");
		expect(plan.rows[0]?.note).toBe(ADDRESS_CONFLICT_NOTE);
	});

	it("never reports a row's own Person against itself", () => {
		// The row matches p1 and FILLS its empty roster address with one only p1
		// already carries. Without the own-Person exclusion every such fill —
		// and every re-import — would report the club's roster against itself.
		const plan = planImport(
			[
				{
					id: "p1",
					customerId: "PN-1",
					email: null,
					name: "Ada",
					phone: null,
					...HERE,
				},
			],
			[{ id: "m1", personId: "p1", name: "Ada", email: null, phone: null }],
			[row({ customerId: "PN-1", name: "Ada", email: "ada@x.io" })],
			new Map([["ada@x.io", ["p1"]]]),
		);
		expect(plan.summary.toUpdate).toBe(1);
		expect(plan.rows[0]?.note).toContain("Fills email");
		expect(plan.summary.addressConflicts).toBe(0);
	});

	it("reports nothing when fill-only keeps the roster row's own address", () => {
		const plan = planImport(
			[
				{
					id: "p1",
					customerId: "PN-1",
					email: null,
					name: "Ada",
					phone: null,
					...HERE,
				},
			],
			[
				{
					id: "m1",
					personId: "p1",
					name: "Ada",
					email: "own@x.io",
					phone: null,
				},
			],
			[row({ customerId: "PN-1", name: "Ada", email: "taken@x.io" })],
			new Map([["taken@x.io", ["someone-else"]]]),
		);
		expect(plan.summary.addressConflicts).toBe(0);
	});
});

describe("addressConflictFor", () => {
	const holders = new Map([["x@x.io", ["p1"]]]);

	it("excludes the row's own Person", () => {
		expect(
			addressConflictFor(holders, "x@x.io", { id: "p1", linked: false }),
		).toBe(false);
		expect(
			addressConflictFor(holders, "x@x.io", { id: "p2", linked: false }),
		).toBe(true);
	});

	it("counts every holder for a row creating a Person", () => {
		expect(addressConflictFor(holders, " X@x.io ", null)).toBe(true);
	});

	it("reports nothing for a linked subject, or for no address", () => {
		expect(
			addressConflictFor(holders, "x@x.io", { id: "p2", linked: true }),
		).toBe(false);
		expect(addressConflictFor(holders, null, null)).toBe(false);
		expect(addressConflictFor(holders, "  ", null)).toBe(false);
	});
});

describe("writtenAddress", () => {
	it("is the fill, not the CSV cell, on an update", () => {
		// Fill-only leaves an existing address in place, so the CSV's differing
		// address is never written and must not be checked.
		const kept = classifyMembership(row({ name: "A", email: "new@x.io" }), {
			name: "A",
			email: "old@x.io",
			phone: null,
		});
		expect(writtenAddress(kept)).toBeNull();
		const filled = classifyMembership(row({ name: "A", email: "new@x.io" }), {
			name: "A",
			email: null,
			phone: null,
		});
		expect(writtenAddress(filled)).toBe("new@x.io");
		expect(
			writtenAddress(classifyMembership(row({ email: "i@x.io" }), undefined)),
		).toBe("i@x.io");
	});
});

describe("normalizeAddress", () => {
	it("spells the operation exactly as account-link-logic's normalizeEmail", async () => {
		// Restated because this module is pure and that one imports `#/db`; this
		// pins the two together so the conflict map's keys cannot drift from the
		// addresses they are looked up by.
		const src = await import("node:fs").then((fs) =>
			fs.readFileSync("src/server/account-link-logic.ts", "utf8"),
		);
		expect(src).toContain("return value?.trim().toLowerCase() || null;");
		for (const v of [" A@B.io\t", "", null, undefined, "x"]) {
			expect(normalizeAddress(v)).toBe(v?.trim().toLowerCase() || null);
		}
	});
});
