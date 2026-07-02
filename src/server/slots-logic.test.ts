import { describe, expect, it, vi } from "vitest";

// slots-logic.ts imports #/db at the top level; mock it so this pure-unit
// test runs without a DATABASE_URL and without touching Postgres.
vi.mock("#/db", () => ({ db: {} }));

import { normalizeSpeakerDetails } from "./slots-logic";

describe("normalizeSpeakerDetails", () => {
	it("defaults an empty/missing title to TBA and optional fields to null", () => {
		expect(normalizeSpeakerDetails()).toEqual({
			speechTitle: "TBA",
			pathwayPath: null,
			projectName: null,
			projectLevel: null,
			minMinutes: null,
			maxMinutes: null,
		});
		expect(normalizeSpeakerDetails({ speechTitle: "   " }).speechTitle).toBe(
			"TBA",
		);
	});

	it("trims a provided title and passes through optional fields", () => {
		expect(
			normalizeSpeakerDetails({
				speechTitle: "  Ice Breaker  ",
				pathwayPath: "Presentation Mastery",
				minMinutes: 4,
				maxMinutes: 6,
			}),
		).toEqual({
			speechTitle: "Ice Breaker",
			pathwayPath: "Presentation Mastery",
			projectName: null,
			projectLevel: null,
			minMinutes: 4,
			maxMinutes: 6,
		});
	});
});
