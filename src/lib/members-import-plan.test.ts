import { describe, expect, it } from "vitest";
import type { MappedMember } from "./members-csv";
import { batchSharedEmails } from "./members-csv";
import {
	classifyMembership,
	type ExistingMembershipRow,
	type ExistingPersonRow,
	planImport,
	resolvePersonDecision,
} from "./members-import-plan";

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
		},
		{ id: "p2", customerId: null, email: "bob@x.io", name: "Bob", phone: "+1" },
	];

	it("matches by Customer ID and fills only empty person fields", () => {
		const d = resolvePersonDecision(
			row({ customerId: "PN-1", name: "Ada Newname", email: "new@x.io" }),
			people,
			new Set(),
		);
		expect(d.kind).toBe("customerId");
		if (d.kind !== "customerId") throw new Error("expected match");
		// Name/email already present → not overwritten (fill-only).
		expect(d.set.name).toBe("Ada");
		expect(d.set.email).toBe("ada@x.io");
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
			},
		];
		const memberships: ExistingMembershipRow[] = [
			{ id: "m1", personId: "p1", name: "Ada", email: "ada@x.io", phone: null },
		];
		const plan = planImport(people, memberships, [
			row({ name: "Ada", email: "ada@x.io", phone: "+1" }), // update (fills phone)
			row({ name: "Bob", email: "bob@x.io" }), // insert
			row({ name: "" }), // skip (blank name)
		]);
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
			},
		];
		const memberships: ExistingMembershipRow[] = [
			{ id: "m1", personId: "p1", name: "Ada", email: "ada@x.io", phone: "+1" },
		];
		const plan = planImport(people, memberships, [
			row({ customerId: "PN-1", name: "Ada", email: "ada@x.io", phone: "+1" }),
		]);
		expect(plan.summary.toUpdate).toBe(1);
		expect(plan.summary.toInsert).toBe(0);
	});
});
