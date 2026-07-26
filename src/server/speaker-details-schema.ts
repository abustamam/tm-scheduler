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
import { speechWindowInputError } from "#/lib/speech-window";

/**
 * Speech details captured when claiming a speaking slot or editing one.
 *
 * `minMinutes`/`maxMinutes` are BOTH-OR-NEITHER (#394). The refinement is not
 * redundant with the two edit surfaces' checks: speech details are reachable
 * from the public no-auth path, so this schema is the only actual guarantee
 * that a half-pair never reaches the database — where it would read as three
 * different durations on three different surfaces.
 */
export const speakerDetailsSchema = z
	.object({
		speechTitle: z.string().trim().optional(),
		introduction: z.string().trim().optional(),
		pathwayPath: z.string().trim().optional(),
		projectName: z.string().trim().optional(),
		projectLevel: z.string().trim().optional(),
		minMinutes: z.number().int().positive().optional(),
		maxMinutes: z.number().int().positive().optional(),
		presentationUrl: z.string().trim().optional(),
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

export type SpeakerDetailsInput = z.infer<typeof speakerDetailsSchema>;
