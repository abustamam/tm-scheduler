// The server-side guarantee behind #394's both-or-neither rule.
//
// The two edit surfaces check this before submitting, but speech details are
// reachable from the public no-auth path — so this schema, which every
// speaker-details write goes through (`claimSlot`, `updateSpeakerDetails`), is
// the only thing that actually keeps a half-pair out of the database.
import { describe, expect, it } from "vitest";
import { SPEAKER_LIMITS } from "#/lib/speaker-limits";
import {
	SPEECH_WINDOW_HALF_PAIR_MESSAGE,
	SPEECH_WINDOW_ORDER_MESSAGE,
} from "#/lib/speech-window";
import {
	speakerDetailsSchema,
	speakerDetailsUpdateSchema,
} from "./speaker-details-schema";

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

/**
 * The composed contract (#522). `speaker-limits.test.ts` proves each validator
 * in isolation; these prove the two SCHEMAS actually carry them, and that the
 * two variants differ in the one way they are supposed to.
 */
describe("the two variants handle over-long input differently (#522)", () => {
	const oversized = {
		speechTitle: "x".repeat(SPEAKER_LIMITS.speechTitle + 1),
		minMinutes: 4,
		maxMinutes: 6,
	};

	it("REJECTS on the create path, where nothing was prefilled", () => {
		expect(speakerDetailsSchema.safeParse(oversized).success).toBe(false);
	});

	it("TRUNCATES on the update path, where a legacy value must not lock the form", () => {
		const r = speakerDetailsUpdateSchema.safeParse(oversized);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.speechTitle).toHaveLength(SPEAKER_LIMITS.speechTitle);
	});

	it("lets the update path save the OTHER fields despite a hostile stored title", () => {
		// The actual lockout scenario: an admin opens the edit sheet to fix the
		// timing, and the form resubmits the 8MB title it prefilled.
		const r = speakerDetailsUpdateSchema.safeParse({
			speechTitle: "x".repeat(8_000_000),
			pathwayPath: "Dynamic Leadership",
			minMinutes: 5,
			maxMinutes: 7,
		});
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.pathwayPath).toBe("Dynamic Leadership");
		expect(r.data.minMinutes).toBe(5);
		expect(r.data.maxMinutes).toBe(7);
	});

	it("bounds the speech window on create and clamps it on update", () => {
		const past = SPEAKER_LIMITS.maxSpeechMinutes + 1;
		expect(
			speakerDetailsSchema.safeParse({ minMinutes: 1, maxMinutes: past })
				.success,
		).toBe(false);

		const r = speakerDetailsUpdateSchema.safeParse({
			minMinutes: 1,
			maxMinutes: past,
		});
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.maxMinutes).toBe(SPEAKER_LIMITS.maxSpeechMinutes);
	});

	it("keeps both-or-neither on the UPDATE variant too", () => {
		// The refinement is built once and shared; this is what proves the
		// truncating variant did not lose it.
		expect(
			speakerDetailsUpdateSchema.safeParse({ minMinutes: 5 }).success,
		).toBe(false);
		expect(
			speakerDetailsUpdateSchema.safeParse({ minMinutes: 7, maxMinutes: 5 })
				.success,
		).toBe(false);
	});

	it("clamps both ends of an inverted pair without breaking the order rule", () => {
		// Clamping must not manufacture a valid-looking pair out of an invalid one.
		const r = speakerDetailsUpdateSchema.safeParse({
			minMinutes: 999_999,
			maxMinutes: 5,
		});
		expect(r.success).toBe(false);
	});
});
