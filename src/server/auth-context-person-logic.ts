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
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { resolveUserPersonId } from "./person-identity-logic";

/**
 * The roster name for a signed-in account, or null when there is none to show.
 *
 * Two rungs, in the order #707 asks for.
 *
 * **1. The ACTIVE club's Person.** `people.user_id` is not unique — ADR-0008
 * makes one human one Person, but real duplicates predate #329's
 * dedupe-on-write, and `linkPersonToUser` binds EVERY unlinked Person matching
 * the verified email in one statement, so a duplicated human gets several at
 * once with a different name on each. The club you are looking at is the one
 * whose roster spelling you expect to be greeted by, so its membership decides.
 * `people.createdAt, people.id` breaks a tie between two duplicates inside that
 * one club — the same tail `resolveUserPersonId` uses, deliberately, so the two
 * can never order a tie differently.
 *
 * **2. The canonical Person**, via `resolveUserPersonId`, when there is no
 * active club (a signed-in account on nobody's roster, or one whose only club
 * was archived) or when the active club's row carries no usable name. That
 * resolver is the shared one — `pathwaysForUser` (`pathways-read-logic.ts`),
 * `selfPersonId` in `path-enrollment-logic.ts` and the same in
 * `progress-marks-logic.ts` all read through it — so the fallback names the
 * same Person those person-level surfaces write to. An ad-hoc
 * `where(eq(people.userId, …))` here would be an unordered pick, which is the
 * defect #329 and #437 exist to close, re-opened on a new surface. (The speech
 * project picker is NOT one of them: it resolves a `memberId` through
 * `resolveMemberSubject` → `members.person_id`, which rung 1 above matches.)
 *
 * The ladder ENDS there — it does not go hunting through the remaining
 * duplicates for any row that happens to carry a name. Doing so would need a
 * third ordering to keep in step with `resolveUserPersonId` by hand, and it
 * buys nothing real: `people.name` is NOT NULL and every write path demands
 * one, so a blank is a data defect whose answer degrades to the email — the
 * pre-#707 behaviour for that account, not a regression.
 *
 * Under impersonation this still names the SUPERADMIN, correctly:
 * `getSessionUser` never swaps `user.id`, so `id`/`email` on the context are
 * theirs too, and a superadmin viewing a club they are not on simply misses
 * rung 1 and falls to rung 2. The identity stays internally consistent.
 *
 * Null, not `""`, in every "nothing to show" case — no linked Person, the
 * Person disappeared between two reads, or a blank/whitespace name. The
 * caller's `?? user.name` then falls through to the existing `|| user.email`
 * arm at every consumer, which is the pre-#707 behaviour and still the right
 * last resort. Returning `""` would work by accident today (falsy) and break
 * the moment a caller switches to a nullish check.
 */
export async function loadPersonDisplayName(
	userId: string,
	activeClubId: string | null,
): Promise<string | null> {
	if (activeClubId) {
		const [row] = await db
			.select({ name: people.name })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(people.userId, userId), eq(members.clubId, activeClubId)))
			.orderBy(people.createdAt, people.id)
			.limit(1);
		// `people.name` is NOT NULL, but not CHECK-constrained against blanks.
		const clubName = row?.name.trim();
		if (clubName) return clubName;
	}

	const personId = await resolveUserPersonId(userId);
	if (!personId) return null;
	const [row] = await db
		.select({ name: people.name })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	return row?.name.trim() || null;
}
