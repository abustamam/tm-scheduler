import { eq } from "drizzle-orm";
import { db } from "#/db";
import { user, userFeatureSeen } from "#/db/schema";
import type { FeatureKey } from "#/lib/whats-new";

/**
 * The per-user "What's new" seen state (#947). Db-touching, so it lives here
 * rather than in `whats-new.ts` (server-fn modules export only server fns and
 * types — `server-modules.guard.test.ts`). Every function takes the SESSION
 * user's id from its caller and nothing else: there is no path by which one
 * user reads or writes another's seen state.
 */

export interface WhatsNewState {
	/** ISO timestamp of the last time the panel was opened, or null. */
	seenAt: string | null;
	/** Feature keys whose "New" badge this user has used or dismissed. */
	featuresSeen: string[];
}

export async function loadWhatsNewState(
	userId: string,
): Promise<WhatsNewState> {
	const [[row], seen] = await Promise.all([
		db
			.select({ seenAt: user.whatsNewSeenAt })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1),
		db
			.select({ featureKey: userFeatureSeen.featureKey })
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, userId)),
	]);
	return {
		seenAt: row?.seenAt ? row.seenAt.toISOString() : null,
		featuresSeen: seen.map((s) => s.featureKey),
	};
}

/** Opening the panel: everything dated up to now is seen. Returns the stamp. */
export async function markWhatsNewSeenLogic(
	userId: string,
	now: Date = new Date(),
): Promise<string> {
	await db.update(user).set({ whatsNewSeenAt: now }).where(eq(user.id, userId));
	return now.toISOString();
}

/**
 * A feature's badge is cleared: the user used it or dismissed the badge.
 * Idempotent — the unique index on (user, feature) makes a second call a no-op,
 * and the first `seen_at` is the one kept.
 */
export async function markFeatureSeenLogic(
	userId: string,
	featureKey: FeatureKey,
): Promise<void> {
	await db
		.insert(userFeatureSeen)
		.values({ userId, featureKey })
		.onConflictDoNothing({
			target: [userFeatureSeen.userId, userFeatureSeen.featureKey],
		});
}
