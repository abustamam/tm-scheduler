import { describe, expect, it } from "vitest";
import {
	CLUB_TEMPLATE_KEY_FALLBACK,
	CLUB_TEMPLATE_KEY_MAX,
	clubTemplateKeySlug,
	firstFreeClubTemplateKey,
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
