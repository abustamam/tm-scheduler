/**
 * The import preview reports a PERSON phone fill (#906): the phone is a Person
 * fact, so the membership arm no longer carries one, and the note is derived
 * from the Person decision itself. It must show on either membership arm —
 * including a row that INSERTS this club's membership for an existing Person
 * (a member this club released and is re-adding), where the fill used to be
 * invisible in the preview.
 */
import { describe, expect, it } from "vitest";
import type { MappedMember } from "./members-csv";
import {
	type ExistingMembershipRow,
	type ExistingPersonRow,
	planImport,
} from "./members-import-plan";

const NO_HOLDERS = new Map();

function row(over: Partial<MappedMember>): MappedMember {
	return {
		customerId: null,
		name: "Ada",
		email: null,
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
		...over,
	};
}

function person(over: Partial<ExistingPersonRow>): ExistingPersonRow {
	return {
		id: "p1",
		customerId: "PN-1",
		email: null,
		name: "Ada",
		phone: null,
		heldBy: "this_club",
		heldElsewhere: false,
		linked: false,
		...over,
	};
}

const MEMBERSHIP: ExistingMembershipRow = {
	id: "m1",
	personId: "p1",
	name: "Ada",
};

describe("planImport's Person phone note (#906)", () => {
	it("update arm: notes a Person phone the row fills", () => {
		const plan = planImport(
			[person({})],
			[MEMBERSHIP],
			[row({ customerId: "PN-1", phone: "+14155550401" })],
			NO_HOLDERS,
		);
		expect(plan.rows[0]?.action).toBe("update");
		expect(plan.rows[0]?.note).toContain("Fills phone");
	});

	it("update arm: says nothing about a phone already on the Person", () => {
		const plan = planImport(
			[person({ phone: "+14155550400" })],
			[MEMBERSHIP],
			[row({ customerId: "PN-1", phone: "+14155550401" })],
			NO_HOLDERS,
		);
		expect(plan.rows[0]?.note).not.toContain("phone");
	});

	it("insert arm: notes the fill when the row adds this club's membership for an existing Person", () => {
		const plan = planImport(
			[person({ heldBy: "released_by_this_club" })],
			[],
			[row({ customerId: "PN-1", phone: "+14155550402" })],
			NO_HOLDERS,
		);
		expect(plan.rows[0]?.action).toBe("insert");
		expect(plan.rows[0]?.note).toContain("Fills phone");
	});

	it("insert arm: no note when the existing Person already has a phone", () => {
		const plan = planImport(
			[person({ heldBy: "released_by_this_club", phone: "+14155550400" })],
			[],
			[row({ customerId: "PN-1", phone: "+14155550402" })],
			NO_HOLDERS,
		);
		expect(plan.rows[0]?.note ?? "").not.toContain("phone");
	});

	it("a brand-new Person carries no fill note — the phone is simply inserted", () => {
		const plan = planImport(
			[],
			[],
			[row({ name: "New Person", phone: "+14155550403" })],
			NO_HOLDERS,
		);
		expect(plan.rows[0]?.action).toBe("insert");
		expect(plan.rows[0]?.note ?? "").not.toContain("phone");
	});
});
