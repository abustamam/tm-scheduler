import { describe, expect, it } from "vitest";
import { RUN_OF_SHOW } from "./agenda-runsheet";

describe("RUN_OF_SHOW template", () => {
	it("is an ordered list of 13 beats", () => {
		expect(RUN_OF_SHOW).toHaveLength(13);
	});

	it("every beat has a positive duration", () => {
		for (const beat of RUN_OF_SHOW) {
			expect(beat.minutes).toBeGreaterThan(0);
		}
	});

	it("role beats reference the club's standard role names", () => {
		const roleNames = RUN_OF_SHOW.filter((b) => b.kind === "role").map(
			(b) => (b as { roleName: string }).roleName,
		);
		expect(roleNames).toContain("Toastmaster of the Day");
		expect(roleNames).toContain("Speaker");
		expect(roleNames).toContain("Evaluator");
		expect(roleNames).toContain("Table Topics Master");
		expect(roleNames).toContain("General Evaluator");
	});
});
