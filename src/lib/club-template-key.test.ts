import { describe, expect, it } from "vitest";
import {
	CLUB_TEMPLATE_KEY_FALLBACK,
	CLUB_TEMPLATE_KEY_MAX,
	clubTemplateKeySlug,
	firstFreeClubTemplateKey,
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
