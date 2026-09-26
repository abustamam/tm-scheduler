import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { FEATURE_KEYS } from "#/lib/whats-new";
import { requireUser } from "./guards";
import {
	loadWhatsNewState,
	markFeatureSeenLogic,
	markWhatsNewSeenLogic,
	type WhatsNewState,
} from "./whats-new-logic";

// The db-touching logic lives in `whats-new-logic.ts`; this module exports ONLY
// createServerFns + types (see `server-modules.guard.test.ts`).
export type { WhatsNewState } from "./whats-new-logic";

/**
 * "What's new" seen state for the signed-in user (#947). User-level, not
 * club-level: which entries a person has seen does not change with the club
 * they are looking at, only which entries they are ELIGIBLE for does, and that
 * filtering is the client's (`eligibleEntries`) because the entries themselves
 * are bundled content, not data. None of these takes an id — the session is
 * the only subject.
 */
export const getWhatsNewState = createServerFn({ method: "GET" }).handler(
	async (): Promise<WhatsNewState> => {
		const u = await requireUser();
		return loadWhatsNewState(u.id);
	},
);

/** Opening the panel clears the header dot. */
export const markWhatsNewSeen = createServerFn({ method: "POST" }).handler(
	async (): Promise<{ seenAt: string }> => {
		const u = await requireUser();
		return { seenAt: await markWhatsNewSeenLogic(u.id) };
	},
);

const featureSeenSchema = z.object({ featureKey: z.enum(FEATURE_KEYS) });

/** A "New" badge is cleared, by use or by dismissal. */
export const markFeatureSeen = createServerFn({ method: "POST" })
	.validator((input: unknown) => featureSeenSchema.parse(input))
	.handler(async ({ data }): Promise<{ ok: true }> => {
		const u = await requireUser();
		await markFeatureSeenLogic(u.id, data.featureKey);
		return { ok: true };
	});
