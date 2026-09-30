import { describe, expect, it } from "vitest";
import * as logic from "./minutes-email-logic";
import {
	buildMinutesBody,
	buildMinutesFilename,
	buildMinutesSubject,
	resolveMinutesRecipients,
} from "./minutes-email-logic";

describe("resolveMinutesRecipients", () => {
	it("keeps only entries with a non-empty email, skips the rest", () => {
		const { recipients, skipped } = resolveMinutesRecipients({
			members: [
				{ name: "Ada", email: "ada@example.com" },
				{ name: "Grace", email: null },
				{ name: "Alan", email: "   " },
			],
			presentGuests: [{ name: "Guest Gwen", email: "gwen@example.com" }],
		});

		expect(recipients).toEqual([
			{ name: "Ada", email: "ada@example.com" },
			{ name: "Guest Gwen", email: "gwen@example.com" },
		]);
		expect(skipped).toEqual([{ name: "Grace" }, { name: "Alan" }]);
	});

	it("trims surrounding whitespace on kept emails", () => {
		const { recipients } = resolveMinutesRecipients({
			members: [{ name: "Ada", email: "  ada@example.com  " }],
			presentGuests: [],
		});
		expect(recipients).toEqual([{ name: "Ada", email: "ada@example.com" }]);
	});
});

describe("buildMinutesSubject / buildMinutesBody / buildMinutesFilename", () => {
	it("formats the subject with club name and date", () => {
		const subject = buildMinutesSubject(
			"Acme TM",
			new Date("2026-07-10T18:00:00Z"),
		);
		expect(subject).toContain("Acme TM — Minutes for");
	});

	it("the default body names the club, for the officer's draft to edit", () => {
		const body = buildMinutesBody("Acme TM", new Date("2026-07-10T18:00:00Z"));
		expect(body).toMatch(/^Hi,\n\n/);
		expect(body).toContain("minutes for Acme TM's meeting on");
		expect(body).toMatch(/Thanks,\nAcme TM$/);
	});

	it("names the file minutes-<iso date>.pdf", () => {
		expect(buildMinutesFilename(new Date("2026-07-10T18:00:00Z"))).toBe(
			"minutes-2026-07-10.pdf",
		);
	});
});

// #903: GavelUp no longer sends the minutes. The officer does, from a draft.
// This module is imported by the client dialog for its subject/body defaults, so
// a send path reappearing here would be one import away from the browser too.
describe("no send path (#903)", () => {
	it("exports no send orchestration", () => {
		expect(Object.keys(logic).sort()).toEqual([
			"buildMinutesBody",
			"buildMinutesFilename",
			"buildMinutesSubject",
			"resolveMinutesRecipients",
		]);
	});
});
