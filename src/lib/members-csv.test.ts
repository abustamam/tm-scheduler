import { describe, expect, it } from "vitest";
import {
	chooseMatch,
	fillOnly,
	isPaid,
	mapRow,
	parseCsv,
	parseMDY,
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
		expect(parseCsv(text)).toEqual([{ Name: "Bob", Email: "", Phone: "+1555" }]);
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
