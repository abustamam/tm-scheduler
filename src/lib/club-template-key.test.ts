import { describe, expect, it } from "vitest";
import {
	CLUB_TEMPLATE_DESCRIPTION_MAX,
	CLUB_TEMPLATE_KEY_FALLBACK,
	CLUB_TEMPLATE_KEY_MAX,
	CLUB_TEMPLATE_NAME_MAX,
	clubTemplateKeySlug,
	firstFreeClubTemplateKey,
	parseClubTemplateFields,
	RETIRED_TEMPLATE_KEY_PREFIX,
	retiredTemplateKey,
} from "./club-template-key";

describe("clubTemplateKeySlug", () => {
	it("lowercases and collapses every run of non-alphanumerics to one hyphen", () => {
		expect(clubTemplateKeySlug("  Contest Night!!  ")).toBe("contest-night");
		expect(clubTemplateKeySlug("Speech_contest — Area 4")).toBe(
			"speech-contest-area-4",
		);
		expect(clubTemplateKeySlug("Café night")).toBe("cafe-night");
	});

	it("falls back when nothing survives, and caps without a trailing hyphen", () => {
		expect(clubTemplateKeySlug("!!!")).toBe(CLUB_TEMPLATE_KEY_FALLBACK);
		expect(clubTemplateKeySlug("会议")).toBe(CLUB_TEMPLATE_KEY_FALLBACK);
		// 59 letters then a space: the cut at 60 lands on the separator.
		const slug = clubTemplateKeySlug(`${"a".repeat(59)} bcd`);
		expect(slug).toBe("a".repeat(59));
		expect(clubTemplateKeySlug("x".repeat(200))).toHaveLength(
			CLUB_TEMPLATE_KEY_MAX,
		);
	});
});

describe("firstFreeClubTemplateKey", () => {
	it("takes the bare slug when free, else the first free -N from 2", () => {
		expect(firstFreeClubTemplateKey("contest-night", new Set())).toBe(
			"contest-night",
		);
		expect(
			firstFreeClubTemplateKey("contest-night", new Set(["contest-night"])),
		).toBe("contest-night-2");
		expect(
			firstFreeClubTemplateKey(
				"contest-night",
				new Set(["contest-night", "contest-night-2", "contest-night-4"]),
			),
		).toBe("contest-night-3");
	});
});

describe("retiredTemplateKey", () => {
	it("can never be produced by the slugger, whatever the template is named", () => {
		const id = "0df19e73-b58b-40b4-8611-dffeb31d91f3";
		const key = retiredTemplateKey(id);
		expect(key.startsWith(RETIRED_TEMPLATE_KEY_PREFIX)).toBe(true);
		for (const name of [
			key,
			`retired-${id}`,
			`Retired ${id}`,
			`_retired:${id}`,
			"retired",
		]) {
			const slug = clubTemplateKeySlug(name);
			expect(slug).toMatch(/^[a-z0-9-]+$/);
			expect(slug).not.toBe(key);
			expect(slug.startsWith(RETIRED_TEMPLATE_KEY_PREFIX)).toBe(false);
			// Nor any suffixed variant the key read could pick.
			expect(firstFreeClubTemplateKey(slug, new Set([slug]))).not.toBe(key);
		}
	});
});

describe("parseClubTemplateFields", () => {
	it("trims, and turns a blank description into none", () => {
		expect(parseClubTemplateFields("  Contest night ", "   ")).toEqual({
			name: "Contest night",
			description: null,
		});
		expect(parseClubTemplateFields("A", " Area 4 ")).toEqual({
			name: "A",
			description: "Area 4",
		});
		expect(parseClubTemplateFields("A", null)).toEqual({
			name: "A",
			description: null,
		});
	});

	it("refuses a blank name and over-long fields, counted in code points", () => {
		expect(parseClubTemplateFields("   ", null)).toEqual({
			error: "Give the template a name.",
		});
		// Exactly the cap is allowed; one more is not.
		expect(
			parseClubTemplateFields("x".repeat(CLUB_TEMPLATE_NAME_MAX), null),
		).not.toHaveProperty("error");
		expect(
			parseClubTemplateFields("x".repeat(CLUB_TEMPLATE_NAME_MAX + 1), null),
		).toEqual({
			error: `That name is too long (max ${CLUB_TEMPLATE_NAME_MAX} characters).`,
		});
		// 80 emoji are 160 UTF-16 units and still within the cap.
		expect(
			parseClubTemplateFields("🎤".repeat(CLUB_TEMPLATE_NAME_MAX), null),
		).not.toHaveProperty("error");
		expect(
			parseClubTemplateFields(
				"A",
				"d".repeat(CLUB_TEMPLATE_DESCRIPTION_MAX + 1),
			),
		).toEqual({
			error: `That description is too long (max ${CLUB_TEMPLATE_DESCRIPTION_MAX} characters).`,
		});
	});
});
