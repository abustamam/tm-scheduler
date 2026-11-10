import { describe, expect, it } from "vitest";
import { MAX_MOVES, MAX_SPEAKER_COUNT } from "#/lib/speaker-slot-limits";

describe("speaker slot limits (#1576)", () => {
	it("keeps the caps at the values the tool's description promises", () => {
		expect(MAX_SPEAKER_COUNT).toBe(5);
		expect(MAX_MOVES).toBe(20);
	});
});
