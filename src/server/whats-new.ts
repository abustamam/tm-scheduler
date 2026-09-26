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

const panelSeenSchema = z.object({
	entryIds: z.array(z.string().max(200)).max(500),
});

/** Opening the panel marks the entries it showed as seen (clears the dot). */
export const markWhatsNewSeen = createServerFn({ method: "POST" })
	.validator((input: unknown) => panelSeenSchema.parse(input))
	.handler(async ({ data }): Promise<{ seenIds: string[] }> => {
		const u = await requireUser();
		return { seenIds: await markWhatsNewSeenLogic(u.id, data.entryIds) };
	});

const featureSeenSchema = z.object({ featureKey: z.enum(FEATURE_KEYS) });

/** A "New" badge is cleared by use. */
export const markFeatureSeen = createServerFn({ method: "POST" })
	.validator((input: unknown) => featureSeenSchema.parse(input))
	.handler(async ({ data }): Promise<{ ok: true }> => {
		const u = await requireUser();
		await markFeatureSeenLogic(u.id, data.featureKey);
		return { ok: true };
	});
