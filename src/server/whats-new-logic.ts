import { eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { user, userFeatureSeen } from "#/db/schema";
import {
	type FeatureKey,
	isFeatureKey,
	isWhatsNewEntryId,
} from "#/lib/whats-new";

/**
 * The per-user "What's new" seen state (#947). Db-touching, so it lives here
 * rather than in `whats-new.ts` (server-fn modules export only server fns and
 * types — `server-modules.guard.test.ts`). Every function takes the SESSION
 * user's id from its caller and nothing else: there is no path by which one
 * user reads or writes another's seen state.
 */

export interface WhatsNewState {
	/** Ids of the entries this user has seen in the panel. */
	seenIds: string[];
	/** Feature keys whose "New" badge this user has used. Unknown keys (a key
	 *  since removed from `FEATURE_KEYS`) are dropped on the way out. */
	featuresSeen: FeatureKey[];
}

export async function loadWhatsNewState(
	userId: string,
): Promise<WhatsNewState> {
	const [[row], seen] = await Promise.all([
		db
			.select({ seenIds: user.whatsNewSeenIds })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1),
		db
			.select({ featureKey: userFeatureSeen.featureKey })
			.from(userFeatureSeen)
			.where(eq(userFeatureSeen.userId, userId)),
	]);
	return {
		seenIds: row?.seenIds ?? [],
		featuresSeen: seen.map((s) => s.featureKey).filter(isFeatureKey),
	};
}

/**
 * Opening the panel: the entries it showed are seen. A union, in one
 * statement, so two tabs opening at once cannot drop each other's ids; ids
 * that are not shipped entries are dropped first, so the column only ever
 * holds real ids. Leaves `updated_at` alone — reading a panel is not an edit
 * to the account (the column's `$onUpdate` would otherwise bump it).
 * Returns the stored set.
 */
export async function markWhatsNewSeenLogic(
	userId: string,
	entryIds: readonly string[],
): Promise<string[]> {
	const ids = entryIds.filter(isWhatsNewEntryId);
	const [row] = await db
		.update(user)
		.set({
			whatsNewSeenIds: sql`array(select distinct x from unnest(${user.whatsNewSeenIds} || array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))) as x order by x)`,
			updatedAt: sql`${user.updatedAt}`,
		})
		.where(eq(user.id, userId))
		.returning({ seenIds: user.whatsNewSeenIds });
	return row?.seenIds ?? [];
}

/**
 * A feature's badge is cleared: the user used the feature.
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
