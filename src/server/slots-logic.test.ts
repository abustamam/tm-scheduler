import { describe, expect, it, vi } from "vitest";

// slots-logic.ts imports #/db at the top level; mock it so this pure-unit
// test runs without a DATABASE_URL and without touching Postgres.
vi.mock("#/db", () => ({ db: {} }));

import { normalizeSpeech } from "./slots-logic";

describe("normalizeSpeech", () => {
	it("treats empty/missing input as no content (TBA), title defaults to TBA", () => {
		const empty = normalizeSpeech();
		expect(empty.hasContent).toBe(false);
		expect(empty.content).toEqual({
			title: "TBA",
			introduction: null,
			pathwayPath: null,
			projectName: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
			presentationUrl: null,
		});
		// A literal "TBA" title with nothing else is still not content.
		expect(normalizeSpeech({ speechTitle: "  TBA  " }).hasContent).toBe(false);
		expect(normalizeSpeech({ speechTitle: "   " }).hasContent).toBe(false);
	});

	it("flags a real title as content and trims/passes through fields", () => {
		const result = normalizeSpeech({
			speechTitle: "  Ice Breaker  ",
			pathwayPath: "Presentation Mastery",
			minMinutes: 4,
			maxMinutes: 6,
		});
		expect(result.hasContent).toBe(true);
		expect(result.content).toEqual({
			title: "Ice Breaker",
			introduction: null,
			pathwayPath: "Presentation Mastery",
			projectName: null,
			projectLevel: null,
			minMinutes: 4,
			maxMinutes: 6,
			presentationUrl: null,
		});
	});

	it("normalizes a presentation link and counts it as content (#175)", () => {
		const result = normalizeSpeech({
			presentationUrl: "docs.google.com/d/abc",
		});
		expect(result.hasContent).toBe(true);
		expect(result.content.presentationUrl).toBe(
			"https://docs.google.com/d/abc",
		);
		// Junk links drop to null and don't count as content on their own.
		expect(
			normalizeSpeech({ presentationUrl: "tbd" }).content.presentationUrl,
		).toBeNull();
		expect(normalizeSpeech({ presentationUrl: "tbd" }).hasContent).toBe(false);
	});

	it("flags non-title fields as content even when the title is blank/TBA", () => {
		// A pathway with no real title still means there's a speech worth keeping;
		// title falls back to "TBA".
		const result = normalizeSpeech({ pathwayPath: "Dynamic Leadership" });
		expect(result.hasContent).toBe(true);
		expect(result.content.title).toBe("TBA");
		expect(result.content.pathwayPath).toBe("Dynamic Leadership");
	});
});
