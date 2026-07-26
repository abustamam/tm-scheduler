// The server-side guarantee behind #394's both-or-neither rule.
//
// The two edit surfaces check this before submitting, but speech details are
// reachable from the public no-auth path — so this schema, which every
// speaker-details write goes through (`claimSlot`, `updateSpeakerDetails`), is
// the only thing that actually keeps a half-pair out of the database.
import { describe, expect, it } from "vitest";
import {
	SPEECH_WINDOW_HALF_PAIR_MESSAGE,
	SPEECH_WINDOW_ORDER_MESSAGE,
} from "#/lib/speech-window";
import { speakerDetailsSchema } from "./speaker-details-schema";

const messages = (input: unknown): string[] => {
	const r = speakerDetailsSchema.safeParse(input);
	return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("speakerDetailsSchema — min/max are both-or-neither (#394)", () => {
	it("accepts both ends set", () => {
		const r = speakerDetailsSchema.safeParse({
			speechTitle: "The Ice Breaker",
			minMinutes: 4,
			maxMinutes: 6,
		});
		expect(r.success).toBe(true);
	});

	it("accepts neither end set", () => {
		expect(speakerDetailsSchema.safeParse({ speechTitle: "TBA" }).success).toBe(
			true,
		);
	});

	it("rejects a min with no max", () => {
		expect(messages({ minMinutes: 5 })).toEqual([
			SPEECH_WINDOW_HALF_PAIR_MESSAGE,
		]);
	});

	it("rejects a max with no min", () => {
		expect(messages({ maxMinutes: 7 })).toEqual([
			SPEECH_WINDOW_HALF_PAIR_MESSAGE,
		]);
	});

	it("rejects min above max", () => {
		expect(messages({ minMinutes: 7, maxMinutes: 5 })).toEqual([
			SPEECH_WINDOW_ORDER_MESSAGE,
		]);
	});

	it("points the half-pair error at the field that is still blank", () => {
		const minOnly = speakerDetailsSchema.safeParse({ minMinutes: 5 });
		const maxOnly = speakerDetailsSchema.safeParse({ maxMinutes: 7 });
		expect(minOnly.success).toBe(false);
		expect(maxOnly.success).toBe(false);
		if (minOnly.success || maxOnly.success) return;
		expect(minOnly.error.issues[0]?.path).toEqual(["maxMinutes"]);
		expect(maxOnly.error.issues[0]?.path).toEqual(["minMinutes"]);
	});

	it("still rejects non-positive and non-integer minutes", () => {
		expect(
			speakerDetailsSchema.safeParse({ minMinutes: 0, maxMinutes: 6 }).success,
		).toBe(false);
		expect(
			speakerDetailsSchema.safeParse({ minMinutes: 4.5, maxMinutes: 6 })
				.success,
		).toBe(false);
	});
});
