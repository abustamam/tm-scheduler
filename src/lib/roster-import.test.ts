import { describe, expect, it } from "vitest";
import {
	buildImportPreview,
	isValidEmail,
	parseRosterText,
} from "./roster-import";

describe("parseRosterText", () => {
	it("parses comma-separated rows", () => {
		const rows = parseRosterText(
			"Jane Doe, jane@club.org, 19165551234, President\nJohn Smith, john@club.org, 19165555678",
		);
		expect(rows).toEqual([
			{
				name: "Jane Doe",
				email: "jane@club.org",
				phone: "19165551234",
				office: "President",
			},
			{
				name: "John Smith",
				email: "john@club.org",
				phone: "19165555678",
				office: "",
			},
		]);
	});

	it("parses tab-separated rows (spreadsheet paste)", () => {
		const rows = parseRosterText(
			"Jane Doe\tjane@club.org\t19165551234\tPresident",
		);
		expect(rows).toEqual([
			{
				name: "Jane Doe",
				email: "jane@club.org",
				phone: "19165551234",
				office: "President",
			},
		]);
	});

	it("trims whitespace and drops blank lines", () => {
		const rows = parseRosterText("  Jane , a@b.co \n\n   \nBob , b@c.co\n");
		expect(rows).toEqual([
			{ name: "Jane", email: "a@b.co", phone: "", office: "" },
			{ name: "Bob", email: "b@c.co", phone: "", office: "" },
		]);
	});

	it("keeps phone digits exactly as pasted (no reformatting)", () => {
		const [row] = parseRosterText("Jane,j@b.co,19165968820");
		expect(row.phone).toBe("19165968820");
	});
});

describe("isValidEmail", () => {
	it("accepts well-formed and rejects malformed emails", () => {
		expect(isValidEmail("a@b.co")).toBe(true);
		expect(isValidEmail("not-an-email")).toBe(false);
		expect(isValidEmail("missing@tld")).toBe(false);
	});
});

describe("buildImportPreview", () => {
	it("flags blank names", () => {
		const [row] = buildImportPreview(
			[{ name: "  ", email: "a@b.co", phone: "", office: "" }],
			[],
		);
		expect(row.issues).toContain("blank-name");
		expect(row.willImport).toBe(false);
	});

	it("flags malformed emails", () => {
		const [row] = buildImportPreview(
			[{ name: "Jane", email: "nope", phone: "", office: "" }],
			[],
		);
		expect(row.issues).toContain("invalid-email");
		expect(row.willImport).toBe(false);
	});

	it("flags duplicates against the existing roster (name or email, case-insensitive)", () => {
		const preview = buildImportPreview(
			[
				{ name: "jane doe", email: "x@y.co", phone: "", office: "" },
				{ name: "New Person", email: "JOHN@club.org", phone: "", office: "" },
			],
			[
				{ name: "Jane Doe", email: null },
				{ name: "Someone", email: "john@club.org" },
			],
		);
		expect(preview[0].issues).toContain("duplicate");
		expect(preview[1].issues).toContain("duplicate");
	});

	it("flags duplicates within the pasted batch", () => {
		const preview = buildImportPreview(
			[
				{ name: "Jane", email: "j@b.co", phone: "", office: "" },
				{ name: "jane", email: "other@b.co", phone: "", office: "" },
			],
			[],
		);
		expect(preview[0].willImport).toBe(true);
		expect(preview[1].issues).toContain("duplicate");
	});

	it("marks clean rows as importable", () => {
		const [row] = buildImportPreview(
			[{ name: "Jane", email: "jane@club.org", phone: "555", office: "VPE" }],
			[],
		);
		expect(row.issues).toEqual([]);
		expect(row.willImport).toBe(true);
	});
});
