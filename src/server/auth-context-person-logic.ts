/**
 * The display name behind a signed-in account (#707).
 *
 * ## Why this exists
 *
 * `getAuthContext` used to hand back Better-Auth's `user.name` verbatim, and
 * every consumer reads it as `user.name || user.email`. That `||` arm looked
 * like a defensive nicety and was in fact the branch **100% of production
 * accounts took**, so the dashboard `<h1>` greeted real members with their raw
 * email address:
 *
 *   - magic-link is the only sign-in method here, and Better-Auth's plugin
 *     creates the account with `name: name || ""`
 *     (`better-auth/dist/plugins/magic-link/index.mjs`);
 *   - neither `signIn.magicLink` call site passes a name (`routes/signin.tsx`,
 *     `routes/club.$clubId.index.tsx`) — a magic-link sender has none to give;
 *   - nothing in `src/` ever writes `user.name` afterwards. The only writer of
 *     the `user` table outside the seed is `reconcileSuperadminFlag`
 *     (`lib/superadmin.ts`), which sets `is_superadmin` and nothing else.
 *
 * So the name has to come from the roster, which is the only place the club
 * actually knows this human's name: user → Person (`people.user_id`, ADR-0008
 * Phase B, linked on sign-in by `linkPersonToUser`) → `people.name`.
 *
 * ## Why its own module rather than the handler
 *
 * `auth-context.ts` is imported by the client layout, so a db-touching
 * top-level export there drags `pg` → `Buffer` into the browser bundle
 * (`server-modules.guard.test.ts`), and a query written inline in the handler
 * is unreachable from vitest — CLAUDE.md lists that as its own coverage trap,
 * and it is the reason `auth-context-logic.ts` exists beside it. Same split,
 * same reason. The call site is pinned by `auth-context-name-wiring.guard.test.ts`.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { people } from "#/db/schema";
import { resolveUserPersonId } from "./person-identity-logic";

/**
 * The roster name for a signed-in account, or null when there is none to show.
 *
 * Resolved through `resolveUserPersonId` rather than a `where(eq(people.userId,
 * …))` of its own, deliberately. `people.user_id` is NOT unique — ADR-0008
 * makes one human one Person but real duplicates predate #329's
 * dedupe-on-write, and `linkPersonToUser` links EVERY unlinked Person matching
 * the verified email in one statement, so a duplicated human gets several at
 * once. An ad-hoc pick here would name a different Person than every other
 * person-level surface (Pathways enrollment, progress marks, the project
 * picker) resolves to — the exact divergence #437 and #329 exist to close, and
 * a second ordering that has to be kept in step with theirs by hand.
 *
 * Costs one extra round trip over folding the name into that resolver's own
 * select. That buys a single ordering instead of two, and the second query is a
 * primary-key lookup on the row the first already found.
 *
 * Null, not `""`, in all three "nothing to show" cases — no linked Person, the
 * Person disappeared between the two reads, or a blank/whitespace name. The
 * caller's `?? user.name` then falls through to the existing `|| user.email`
 * arm at every consumer, which is the pre-#707 behaviour and still the right
 * last resort. Returning `""` would work by accident today (falsy) and break
 * the moment a caller switches to a nullish check.
 */
export async function loadPersonDisplayName(
	userId: string,
): Promise<string | null> {
	const personId = await resolveUserPersonId(userId);
	if (!personId) return null;
	const [row] = await db
		.select({ name: people.name })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	// `people.name` is NOT NULL, but not CHECK-constrained against blanks.
	return row?.name.trim() || null;
}
