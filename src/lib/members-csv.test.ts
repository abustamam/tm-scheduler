import { describe, expect, it } from "vitest";
import {
	batchSharedEmails,
	chooseMatch,
	type ExistingPerson,
	fillOnly,
	isPaid,
	mapRow,
	parseCsv,
	parseMDY,
	resolvePerson,
} from "./members-csv";

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
		expect(parseCsv(text)).toEqual([
			{ Name: "Khan, Mois", City: "Folsom, CA" },
		]);
	});

	it("ignores a trailing blank line", () => {
		const text = "Name\nAda\n\n";
		expect(parseCsv(text)).toEqual([{ Name: "Ada" }]);
	});
});

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
	it("maps customerId/name/email/phone(mobile)/dates; empties become null", () => {
		const row = {
			"Customer ID": "PN-67716945",
			Name: "Faisal Ali",
			Email: "ifaisalali@me.com",
			"Home Phone": "+1510",
			"Mobile Phone": "+15103666802",
			"Member of Club Since": "5/1/2024",
			"Original Join Date": "10/1/2012",
		};
		const m = mapRow(row);
		expect(m.customerId).toBe("PN-67716945");
		expect(m.name).toBe("Faisal Ali");
		expect(m.email).toBe("ifaisalali@me.com");
		expect(m.phone).toBe("+15103666802"); // mobile only
		expect(m.joinedAt?.getFullYear()).toBe(2024);
		expect(m.originalJoinDate?.getFullYear()).toBe(2012);
	});
	it("nulls missing customerId/email/phone/dates", () => {
		const m = mapRow({ Name: "Mahbuba Khan" });
		expect(m.customerId).toBeNull();
		expect(m.email).toBeNull();
		expect(m.phone).toBeNull();
		expect(m.joinedAt).toBeNull();
		expect(m.originalJoinDate).toBeNull();
	});
	it("reads Customer ID from a BOM-prefixed header via parseCsv", () => {
		// The Toastmasters export starts with a UTF-8 BOM before "Customer ID".
		const text = "﻿Customer ID,Name\nPN-1,Ada\n";
		const [row] = parseCsv(text);
		expect(mapRow(row).customerId).toBe("PN-1");
	});
});

const existing = [
	{ id: "a", email: "ada@x.io", name: "Ada Lovelace" },
	{ id: "b", email: null, name: "Bob Khan" },
	{ id: "c", email: null, name: "Bob Khan" }, // duplicate name
];

describe("chooseMatch", () => {
	it("matches by email (case-insensitive) first", () => {
		expect(
			chooseMatch({ email: "ADA@x.io", name: "Different" }, existing),
		).toEqual({ kind: "email", id: "a" });
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

describe("batchSharedEmails", () => {
	it("flags an email used by 2+ distinct names (case-insensitive)", () => {
		const shared = batchSharedEmails([
			{ name: "Pat", email: "family@x.io" },
			{ name: "Sam", email: "FAMILY@x.io" },
			{ name: "Ada", email: "ada@x.io" },
		]);
		expect(shared.has("family@x.io")).toBe(true);
		expect(shared.has("ada@x.io")).toBe(false);
	});
	it("does not flag the same person listed twice (same name)", () => {
		const shared = batchSharedEmails([
			{ name: "Ada Lovelace", email: "ada@x.io" },
			{ name: "ada lovelace", email: "ada@x.io" },
		]);
		expect(shared.size).toBe(0);
	});
	it("ignores blank emails", () => {
		const shared = batchSharedEmails([
			{ name: "A", email: null },
			{ name: "B", email: "" },
		]);
		expect(shared.size).toBe(0);
	});
});

describe("resolvePerson", () => {
	const people: ExistingPerson[] = [
		{ id: "p1", customerId: "PN-1", email: "ada@x.io" },
		{ id: "p2", customerId: null, email: "bob@x.io" },
		// Shared family email, two distinct people (both Customer-ID-less).
		{ id: "p3", customerId: null, email: "family@x.io" },
		{ id: "p4", customerId: null, email: "family@x.io" },
	];

	it("matches by Customer ID first (even when email differs)", () => {
		expect(
			resolvePerson({ customerId: "PN-1", email: "moved@x.io" }, people),
		).toEqual({ kind: "customerId", id: "p1" });
	});

	it("matches by unambiguous non-blank email (case-insensitive)", () => {
		expect(
			resolvePerson({ customerId: null, email: "BOB@x.io" }, people),
		).toEqual({ kind: "email", id: "p2" });
	});

	it("is ambiguous when an email is shared by 2+ people (never merges)", () => {
		expect(
			resolvePerson({ customerId: null, email: "family@x.io" }, people),
		).toEqual({ kind: "ambiguous" });
	});

	it("inserts when email is blank (no name fallback)", () => {
		expect(resolvePerson({ customerId: null, email: null }, people)).toEqual({
			kind: "insert",
		});
	});

	it("inserts when nothing matches", () => {
		expect(
			resolvePerson({ customerId: "PN-999", email: "zed@x.io" }, people),
		).toEqual({ kind: "insert" });
	});

	it("does not email-merge into a person with a different Customer ID", () => {
		// Incoming has PN-2 (unknown), same email as PN-1's person → distinct human.
		expect(
			resolvePerson({ customerId: "PN-2", email: "ada@x.io" }, people),
		).toEqual({ kind: "insert" });
	});

	it("email-merges into a Customer-ID-less person, upgrading later", () => {
		expect(
			resolvePerson({ customerId: "PN-77", email: "bob@x.io" }, people),
		).toEqual({ kind: "email", id: "p2" });
	});
});
