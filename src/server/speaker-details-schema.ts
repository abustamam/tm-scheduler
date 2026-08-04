// The speaker-details input contract, shared by `claimSlot` and
// `updateSpeakerDetails` (src/server/slots.ts).
//
// It sits in its own module rather than inline in `slots.ts` because
// `server-modules.guard.test.ts` lets a server-fn module export only server
// functions and types — so a schema declared there cannot be exported, and
// therefore cannot be tested directly. This module declares no server function
// and imports no `#/db`, which is what the guard is really protecting: it is
// pure zod over a pure `#/lib` helper, so it costs the client bundle nothing
// beyond zod, which the validator already needs. It runs on BOTH sides — the
// validator executes client-side before the call and again on the server, which
// is the point (the public no-auth path can skip the client entirely).
import { z } from "zod";
import {
	SPEAKER_FIELDS,
	SPEAKER_UPDATE_FIELDS,
	speechMinutesField,
	speechMinutesUpdateField,
} from "#/lib/speaker-limits";
import { speechWindowInputError } from "#/lib/speech-window";

/**
 * Builds the speaker-details contract over a set of field validators.
 *
 * Two schemas are built from this rather than one, because the create and
 * update paths must handle an over-long value differently — see
 * `SPEAKER_UPDATE_FIELDS` in `#/lib/speaker-limits` for why. Everything else
 * about the two is identical, and sharing the shape here is what keeps the
 * both-or-neither refinement from being written twice and drifting.
 */
function buildSpeakerDetailsSchema<
	F extends typeof SPEAKER_FIELDS | typeof SPEAKER_UPDATE_FIELDS,
	M extends typeof speechMinutesField | typeof speechMinutesUpdateField,
>(fields: F, minutes: M) {
	return z
		.object({
			speechTitle: fields.speechTitle.optional(),
			introduction: fields.introduction.optional(),
			pathwayPath: fields.pathwayPath.optional(),
			projectName: fields.projectName.optional(),
			projectLevel: fields.projectLevel.optional(),
			// A real catalog project (#418). When present the server OVERWRITES the
			// three free-text fields above from the catalog, so they stay the accurate
			// fallback every display surface already reads. `null` clears the link and
			// hands the fields back to whatever was typed.
			//
			// That overwrite runs AFTER this schema, so it is NOT bounded by these
			// caps — which is why `projectName`'s cap is sized to clear the catalog's
			// own longest value rather than the longest one in the speeches table.
			projectId: z.string().uuid().nullable().optional(),
			minMinutes: minutes.optional(),
			maxMinutes: minutes.optional(),
			presentationUrl: fields.presentationUrl.optional(),
		})
		.superRefine((v, ctx) => {
			const message = speechWindowInputError(v.minMinutes, v.maxMinutes);
			if (!message) return;
			// Reported on the field that is present, so a client rendering field-level
			// errors points at the one the person can see a value in.
			ctx.addIssue({
				code: "custom",
				message,
				path: [v.maxMinutes == null ? "maxMinutes" : "minMinutes"],
			});
		});
}

/**
 * Speech details captured when CLAIMING a speaking slot (`claimSlot`).
 *
 * Over-long input is REJECTED here: nothing is prefilled on a fresh claim, so
 * the person is looking at what they just typed and an error is actionable.
 *
 * `minMinutes`/`maxMinutes` are BOTH-OR-NEITHER (#394). The refinement is not
 * redundant with the two edit surfaces' checks: speech details are reachable
 * from the public no-auth path, so this schema is the only actual guarantee
 * that a half-pair never reaches the database — where it would read as three
 * different durations on three different surfaces.
 */
export const speakerDetailsSchema = buildSpeakerDetailsSchema(
	SPEAKER_FIELDS,
	speechMinutesField,
);

/**
 * Speech details captured when EDITING an existing speech
 * (`updateSpeakerDetails`).
 *
 * Over-long input is TRUNCATED here rather than rejected, because
 * `edit-speech-sheet.tsx` prefills and resubmits every field: a value stored
 * before these caps existed would otherwise block edits to all the others, and
 * be unrepairable through the only UI that can repair it.
 */
export const speakerDetailsUpdateSchema = buildSpeakerDetailsSchema(
	SPEAKER_UPDATE_FIELDS,
	speechMinutesUpdateField,
);

export type SpeakerDetailsInput = z.infer<typeof speakerDetailsSchema>;
