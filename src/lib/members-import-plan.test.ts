import { describe, expect, it } from "vitest";
import type { MappedMember } from "./members-csv";
import { batchSharedEmails } from "./members-csv";
import {
	ADDRESS_CONFLICT_NOTE,
	type AddressHolders,
	addressConflictFor,
	classifyMembership,
	EMAIL_REFUSED_NOTE,
	type ExistingMembershipRow,
	type ExistingPersonRow,
	emailDecision,
	FOREIGN_SKIP_NOTE,
	normalizeAddress,
	planImport,
	resolvePersonDecision,
	writtenAddress,
} from "./members-import-plan";

/** A Person the importing club holds, not linked to an account. */
const HERE = {
	heldBy: "this_club",
	heldElsewhere: false,
	linked: false,
} as const;
const NO_HOLDERS: AddressHolders = new Map();
/** An address held by unlinked Persons. */
const held = (address: string, ...ids: string[]): AddressHolders =>
	new Map([[address, ids.map((id) => ({ id, linked: false }))]]);

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

	it("fill-only update: keeps a non-empty stored name, fills an empty one", () => {
		const kept = classifyMembership(
			row({ name: "CSV Name", email: "csv@x.io", phone: "+2" }),
			{ name: "Stored Name" },
		);
		if (kept.kind !== "update") throw new Error("expected update");
		expect(kept.set.name).toBe("Stored Name");
		expect(kept.fills).toEqual([]);
		const filled = classifyMembership(row({ name: "CSV Name" }), { name: " " });
		if (filled.kind !== "update") throw new Error("expected update");
		expect(filled.set.name).toBe("CSV Name");
		expect(filled.fills.map((f) => f.field)).toEqual(["name"]);
	});

	it("carries no contact at all — email and phone are the Person's (#906, #907)", () => {
		const ins = classifyMembership(
			row({ name: "N", email: "n@x.io", phone: "+1" }),
			undefined,
		);
		if (ins.kind !== "insert") throw new Error("expected insert");
		expect(Object.keys(ins.values).sort()).toEqual(["joinedAt", "name"]);
		const upd = classifyMembership(row({ name: "N", email: "n@x.io" }), {
			name: "N",
		});
		if (upd.kind !== "update") throw new Error("expected update");
		expect(Object.keys(upd.set).sort()).toEqual(["joinedAt", "name"]);
	});

	it("always (re)writes joinedAt on an update", () => {
		const joined = new Date("2024-05-01");
		const d = classifyMembership(row({ name: "X", joinedAt: joined }), {
			name: "X",
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
			{ id: "m1", personId: "p1", name: "Ada" },
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
			{ id: "m1", personId: "p1", name: "Ada" },
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

	it("refuses a Customer-ID match onto a Person no club holds and this club did not release (#855)", () => {
		// The roster row a match would mint is the orphan's only membership, so
		// it alone vouches for their bind, carrying the address this file typed.
		const d = resolvePersonDecision(
			row({ customerId: "PN-O", name: "Orphan", email: "typed@x.io" }),
			[person({ id: "o", customerId: "PN-O", heldBy: "nobody" })],
			new Set(),
		);
		expect(d).toEqual({ kind: "foreign", reason: "customerId" });
	});

	it("refuses an email match onto a Person no club holds and this club did not release (#855)", () => {
		const d = resolvePersonDecision(
			row({ name: "Orphan", email: "Orphan@x.io" }),
			[person({ id: "o", email: "orphan@x.io", heldBy: "nobody" })],
			new Set(),
		);
		expect(d).toEqual({ kind: "foreign", reason: "email" });
	});

	it("re-attaches an orphan this club last removed, by Customer ID and by email (#855)", () => {
		// Remove-then-reimport, for the club that did the removing. A refusal
		// here would leave a member number nobody can ever import again: a
		// fresh Person cannot carry it past `people_customer_id_unique`.
		const released = [
			person({
				id: "r",
				customerId: "PN-R",
				heldBy: "released_by_this_club",
			}),
			// No Customer ID, or an email match would be a distinct human.
			person({ id: "e", email: "eli@x.io", heldBy: "released_by_this_club" }),
		];
		expect(
			resolvePersonDecision(
				row({ customerId: "PN-R", name: "Rae" }),
				released,
				new Set(),
			),
		).toMatchObject({ kind: "customerId", id: "r" });
		expect(
			resolvePersonDecision(
				row({ name: "Eli", email: "ELI@x.io" }),
				released,
				new Set(),
			),
		).toMatchObject({ kind: "email", id: "e" });
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
					heldElsewhere: true,
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
					heldElsewhere: true,
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
			held("shared@x.io", "someone-else"),
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
			[{ id: "m1", personId: "p1", name: "Ada" }],
			[row({ customerId: "PN-1", name: "Ada", email: "ada@x.io" })],
			held("ada@x.io", "p1"),
		);
		expect(plan.summary.toUpdate).toBe(1);
		expect(plan.rows[0]?.note).toContain("Fills email");
		expect(plan.summary.addressConflicts).toBe(0);
	});

	it("reports nothing when fill-only keeps the Person's own address", () => {
		const plan = planImport(
			[
				{
					id: "p1",
					customerId: "PN-1",
					email: "own@x.io",
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
				},
			],
			[row({ customerId: "PN-1", name: "Ada", email: "taken@x.io" })],
			held("taken@x.io", "someone-else"),
		);
		expect(plan.summary.addressConflicts).toBe(0);
	});
});

describe("planImport — orphans (#855)", () => {
	const orphan = (heldBy: ExistingPersonRow["heldBy"]): ExistingPersonRow => ({
		id: "o",
		customerId: "PN-O",
		email: null,
		name: "Orphan",
		phone: null,
		heldBy,
		heldElsewhere: false,
		linked: false,
	});

	it("skips a row naming an unreleased orphan, on the foreign counter, with a note that names no club", () => {
		const plan = planImport(
			[orphan("nobody")],
			[],
			[row({ customerId: "PN-O", name: "Orphan", email: "typed@x.io" })],
			NO_HOLDERS,
		);
		expect(plan.summary.foreignSkipped).toBe(1);
		expect(plan.summary.toInsert).toBe(0);
		expect(plan.summary.peopleCreated).toBe(0);
		expect(plan.summary.peopleMatched).toBe(0);
		expect(plan.rows[0]).toMatchObject({
			action: "skip",
			note: FOREIGN_SKIP_NOTE.customerId,
		});
	});

	it("inserts one roster row for an orphan this club released, and creates no Person", () => {
		const plan = planImport(
			[orphan("released_by_this_club")],
			[],
			[row({ customerId: "PN-O", name: "Orphan", email: "back@x.io" })],
			NO_HOLDERS,
		);
		expect(plan.summary.foreignSkipped).toBe(0);
		expect(plan.summary.peopleMatched).toBe(1);
		expect(plan.summary.peopleCreated).toBe(0);
		expect(plan.summary.toInsert).toBe(1);
	});

	it("never claims an orphan is on another club's roster", () => {
		// The note serves both refusals, and "another club's roster" is false of
		// an orphan. Naming a club would also tell the importer which one.
		for (const note of Object.values(FOREIGN_SKIP_NOTE)) {
			expect(note).not.toMatch(/another club/i);
			expect(note).toMatch(/not on this club's roster/);
		}
	});
});

describe("planImport — review fixes (#759)", () => {
	it("refuses a foreign Customer ID even when the row's email is shared in the file", () => {
		// The shared-email override used to run FIRST, forcing `ambiguous` and
		// skipping the foreign post-check — and the writer then inserted a
		// Customer ID the unique index already held, throwing mid-file.
		const plan = planImport(
			[
				{
					id: "v",
					customerId: "PN-V",
					email: null,
					name: "Vic",
					phone: null,
					heldBy: "other_club_only",
					heldElsewhere: true,
					linked: false,
				},
			],
			[],
			[
				row({ customerId: "PN-V", name: "Vic", email: "fam@x.io" }),
				row({ name: "Sam", email: "fam@x.io" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.foreignSkipped).toBe(1);
		expect(plan.rows[0]?.action).toBe("skip");
		expect(plan.summary.peopleCreated).toBe(1);
	});

	it("reports an address two rows of the SAME file give two different Persons", () => {
		// Same name, so `batchSharedEmails` does not flag them, but different
		// Customer IDs, so they are two Persons on one address: neither can bind.
		const plan = planImport(
			[],
			[],
			[
				row({ customerId: "PN-1", name: "Alex Smith", email: "alex@x.io" }),
				row({ customerId: "PN-2", name: "Alex Smith", email: "Alex@x.io" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.ambiguous).toBe(0);
		expect(plan.summary.peopleCreated).toBe(2);
		expect(plan.summary.addressConflicts).toBe(1);
		expect(plan.rows[1]?.note).toBe(ADDRESS_CONFLICT_NOTE);
	});

	it("does not re-report the in-file collision the ambiguous count already covers", () => {
		const plan = planImport(
			[],
			[],
			[
				row({ name: "Pat", email: "fam@x.io" }),
				row({ name: "Sam", email: "fam@x.io" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.ambiguous).toBe(2);
		expect(plan.summary.addressConflicts).toBe(0);
	});
});

describe("addressConflictFor", () => {
	const holders = held("x@x.io", "p1");

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

	it("reports a linked subject when another holder has not signed in yet", () => {
		// The linked subject keeps their own sign-in, but arm 3 now refuses the
		// OTHER holder, who may be in a club the importing admin cannot see. An
		// earlier cut returned early here and hid exactly that lockout.
		expect(
			addressConflictFor(holders, "x@x.io", { id: "p2", linked: true }),
		).toBe(true);
	});

	it("reports nothing when everyone involved is already bound, or for no address", () => {
		const bound: AddressHolders = new Map([
			["x@x.io", [{ id: "p1", linked: true }]],
		]);
		expect(
			addressConflictFor(bound, "x@x.io", { id: "p2", linked: true }),
		).toBe(false);
		// An unlinked subject is still blocked by a linked holder.
		expect(
			addressConflictFor(bound, "x@x.io", { id: "p2", linked: false }),
		).toBe(true);
		expect(addressConflictFor(holders, null, null)).toBe(false);
		expect(addressConflictFor(holders, "  ", null)).toBe(false);
	});
});

describe("emailDecision (#907)", () => {
	const person = (
		over: Partial<
			Pick<ExistingPersonRow, "email" | "linked" | "heldElsewhere">
		>,
	) => ({ email: null, linked: false, heldElsewhere: false, ...over });

	it("fills a blank address on an unbound Person this club alone holds", () => {
		expect(emailDecision(person({}), " new@x.io ")).toEqual({
			kind: "fill",
			to: "new@x.io",
		});
	});

	it("keeps an existing address (fill-only) without reporting", () => {
		expect(emailDecision(person({ email: "old@x.io" }), "new@x.io")).toEqual({
			kind: "none",
		});
	});

	it("refuses a new address for a BOUND Person", () => {
		expect(
			emailDecision(person({ email: "me@x.io", linked: true }), "new@x.io"),
		).toEqual({ kind: "refused", reason: "bound" });
	});

	it("refuses a new address for a Person another club also holds", () => {
		expect(emailDecision(person({ heldElsewhere: true }), "new@x.io")).toEqual({
			kind: "refused",
			reason: "multi_club",
		});
	});

	it("is not a refusal when the address is the same one, normalised", () => {
		expect(
			emailDecision(person({ email: "Me@X.io", linked: true }), " me@x.io"),
		).toEqual({ kind: "none" });
		expect(emailDecision(person({ linked: true }), "  ")).toEqual({
			kind: "none",
		});
	});
});

describe("planImport — email is the Person's (#907)", () => {
	it("reports a row whose new address cannot reach a bound or shared Person", () => {
		const plan = planImport(
			[
				{
					id: "b",
					customerId: "PN-B",
					email: "bound@x.io",
					name: "Bound",
					phone: null,
					...HERE,
					linked: true,
				},
				{
					id: "s",
					customerId: "PN-S",
					email: null,
					name: "Shared",
					phone: null,
					...HERE,
					heldElsewhere: true,
				},
			],
			[
				{ id: "mb", personId: "b", name: "Bound" },
				{ id: "ms", personId: "s", name: "Shared" },
			],
			[
				row({ customerId: "PN-B", name: "Bound", email: "other@x.io" }),
				row({ customerId: "PN-S", name: "Shared", email: "s@x.io" }),
			],
			NO_HOLDERS,
		);
		expect(plan.summary.emailNotWritten).toBe(2);
		expect(plan.rows[0]?.note).toContain(EMAIL_REFUSED_NOTE.bound);
		expect(plan.rows[1]?.note).toContain(EMAIL_REFUSED_NOTE.multi_club);
	});

	it("previews a fill on a single-club unbound Person", () => {
		const plan = planImport(
			[
				{
					id: "p",
					customerId: "PN-P",
					email: null,
					name: "P",
					phone: null,
					...HERE,
				},
			],
			[{ id: "m", personId: "p", name: "P" }],
			[row({ customerId: "PN-P", name: "P", email: "p@x.io" })],
			NO_HOLDERS,
		);
		expect(plan.summary.emailNotWritten).toBe(0);
		expect(plan.rows[0]?.note).toContain("Fills email");
	});
});

describe("writtenAddress", () => {
	it("is the fill, not the CSV cell, on a match", () => {
		// Fill-only leaves an existing address in place, so the CSV's differing
		// address is never written and must not be checked.
		const base = {
			customerId: "PN-A",
			name: "A",
			phone: null,
			...HERE,
		};
		const kept = resolvePersonDecision(
			row({ customerId: "PN-A", name: "A", email: "new@x.io" }),
			[{ id: "a", email: "old@x.io", ...base }],
			new Set(),
		);
		if (kept.kind === "foreign") throw new Error("expected a match");
		expect(writtenAddress(kept)).toBeNull();
		const filled = resolvePersonDecision(
			row({ customerId: "PN-A", name: "A", email: "new@x.io" }),
			[{ id: "a", email: null, ...base }],
			new Set(),
		);
		if (filled.kind === "foreign") throw new Error("expected a match");
		expect(writtenAddress(filled)).toBe("new@x.io");
		const inserted = resolvePersonDecision(
			row({ email: "i@x.io" }),
			[],
			new Set(),
		);
		if (inserted.kind === "foreign") throw new Error("expected an insert");
		expect(writtenAddress(inserted)).toBe("i@x.io");
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
