// The demo club (#1199, part of #1114): one club, marked by `clubs.is_demo`,
// built from the Harbor City fixture (#1198) and rebuilt on demand from the
// superadmin console. Its people are made up (`@example.com`), so no real
// member's name, email or phone ever sits on a shared screen. Its only real user
// is the dedicated demo account named by `DEMO_ACCOUNT_EMAIL`.
//
// DB logic only: the session and superadmin gates live in `onboarding.ts`, and
// this module may not be imported by a client route (see server-modules.guard).

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { buildFixtureClub } from "#/db/fixtures/club-fixture";
import { clubs, guests, members, officerTerms, people } from "#/db/schema";
import { isReservedRecipient } from "#/lib/email";
import { user } from "../db/auth-schema";
import {
	CLUB_WRITE_LOCK_TIMEOUT,
	takeAdvisoryLockWithin,
} from "./club-write-lock";
import { isDemoClub } from "./demo-club-flag";
import { assertStillClubAdmin } from "./guards";
import type { DbOrTx } from "./meeting-templates-logic";
import {
	membershipPickOpenTermJoin,
	membershipPickOrder,
} from "./membership-pick-order";
import { deleteClubCore } from "./onboarding-logic";

export const DEMO_CLUB_NAME = "GavelUp Demo Club";
export const DEMO_CLUB_SLUG = "gavelup-demo-club";
export const DEMO_ADMIN_NAME = "Demo Presenter";
export const DEMO_TIMEZONE = "America/Chicago";

/**
 * The advisory-lock namespace every demo rebuild takes (ASCII "Demo"), with a
 * fixed key: there is one demo club, so there is one queue. Distinct from
 * `CLUB_WRITE_LOCK_NAMESPACE`, which is per club id.
 */
export const DEMO_LOCK_NAMESPACE = 0x44656d6f;
export const DEMO_LOCK_KEY = "demo-club";

export type DemoErrorCode =
	| "NOT_CONFIGURED"
	| "ACCOUNT_IN_REAL_CLUB"
	| "ACCOUNT_IS_SUPERADMIN"
	| "NOT_DEMO_CLUB"
	| "NOT_AUTHORIZED";

const DEMO_ERROR_MESSAGES: Record<DemoErrorCode, string> = {
	NOT_CONFIGURED: "Set DEMO_ACCOUNT_EMAIL before building the demo club.",
	ACCOUNT_IN_REAL_CLUB:
		"The demo account belongs to a real club. Use an account that is in no other club.",
	ACCOUNT_IS_SUPERADMIN:
		"The demo account is a superadmin. Use an account that is not.",
	NOT_DEMO_CLUB: "That club is not the demo club.",
	NOT_AUTHORIZED: "You no longer have permission to rebuild the demo club.",
};

export class DemoError extends Error {
	readonly code: DemoErrorCode;
	constructor(code: DemoErrorCode) {
		super(DEMO_ERROR_MESSAGES[code]);
		this.name = "DemoError";
		this.code = code;
	}
}

/**
 * The configured demo account's address: trimmed and lowercased. Null when the
 * value is unset, blank, or holds a comma or whitespace — a list, or a typo,
 * must never be read as one account.
 */
export function parseDemoAccountEmail(
	raw: string | undefined | null,
): string | null {
	if (raw == null) return null;
	const email = raw.trim().toLowerCase();
	if (email === "" || /[\s,]/u.test(email)) return null;
	return email;
}

export { isDemoClub };

export interface DemoClubState {
	/** `DEMO_ACCOUNT_EMAIL` is set to a usable address. */
	configured: boolean;
	club: { id: string; builtAt: Date } | null;
}

export async function getDemoClubState(): Promise<DemoClubState> {
	const [row] = await db
		.select({ id: clubs.id, builtAt: clubs.createdAt })
		.from(clubs)
		.where(eq(clubs.isDemo, true))
		.limit(1);
	return {
		configured: parseDemoAccountEmail(process.env.DEMO_ACCOUNT_EMAIL) != null,
		club: row ?? null,
	};
}

export interface ResetDemoClubOptions {
	/** The instant the fixture is "today" at. */
	now: Date;
	/** Who asked. Re-checked inside the transaction, after the locks. */
	actor: { kind: "superadmin" | "clubAdmin"; userId: string };
	/** The club the caller believes is the demo club; refuses when it is not. */
	expectClubId?: string;
	/** How long to wait for the rebuild lock, as a Postgres interval. A
	 *  parameter only so a test can wait less than the production value. */
	lockTimeout?: string;
}

/**
 * Delete the demo club if there is one and build it again from the fixture, in
 * ONE transaction: any throw rolls back everything, so a failed rebuild leaves
 * the previous demo club intact. Two rebuilds queue behind one advisory lock; one
 * that waits past `CLUB_WRITE_LOCK_TIMEOUT` throws `CLUB_BUSY_MESSAGE`.
 *
 * The delete is `deleteClubCore` (#914). It keeps the demo account and every
 * user whose address is NOT reserved — a presenter who changed their email, or a
 * real person added by hand — so a rebuild removes their demo Person and
 * membership but never their account. The fixture's `@example.com` accounts go.
 *
 * Creates `user` rows only for the fixture's fictional members; never sends
 * mail and never creates the demo account.
 */
export async function resetDemoClub(
	opts: ResetDemoClubOptions,
): Promise<{ clubId: string }> {
	return db.transaction(async (tx) => {
		await takeAdvisoryLockWithin(
			tx,
			sql`select pg_advisory_xact_lock(${DEMO_LOCK_NAMESPACE}::int4, hashtext(${DEMO_LOCK_KEY}))`,
			opts.lockTimeout ?? CLUB_WRITE_LOCK_TIMEOUT,
		);

		const email = parseDemoAccountEmail(process.env.DEMO_ACCOUNT_EMAIL);
		if (!email) throw new DemoError("NOT_CONFIGURED");

		const [demoUser] = await tx
			.select({ id: user.id, isSuperadmin: user.isSuperadmin })
			.from(user)
			.where(sql`lower(${user.email}) = ${email}`)
			.limit(1);
		if (demoUser) {
			const [inRealClub] = await tx
				.select({ clubId: members.clubId })
				.from(members)
				.innerJoin(people, eq(people.id, members.personId))
				.innerJoin(clubs, eq(clubs.id, members.clubId))
				.leftJoin(officerTerms, membershipPickOpenTermJoin())
				.where(and(eq(people.userId, demoUser.id), eq(clubs.isDemo, false)))
				// Only whether a row exists matters, but the pick still takes the shared
				// order so the repo has ONE way to keep a single membership (#804).
				.groupBy(members.id)
				.orderBy(...membershipPickOrder())
				.limit(1);
			if (inRealClub) throw new DemoError("ACCOUNT_IN_REAL_CLUB");
			if (demoUser.isSuperadmin) throw new DemoError("ACCOUNT_IS_SUPERADMIN");
		}

		const [existing] = await tx
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.isDemo, true))
			.for("update");
		if (opts.expectClubId && existing?.id !== opts.expectClubId) {
			throw new DemoError("NOT_DEMO_CLUB");
		}

		await assertActorStillAuthorized(tx, opts.actor, existing?.id ?? null);

		if (existing) {
			const keepUserIds = await accountsToKeep(
				tx,
				existing.id,
				demoUser?.id ?? null,
			);
			await deleteClubCore(tx, existing.id, { keepUserIds });
		}

		const { clubId } = await buildFixtureClub(tx, {
			name: DEMO_CLUB_NAME,
			slug: DEMO_CLUB_SLUG,
			timeZone: DEMO_TIMEZONE,
			isDemo: true,
			now: opts.now,
			admin: {
				name: DEMO_ADMIN_NAME,
				email,
				userId: demoUser?.id ?? null,
			},
		});
		return { clubId };
	});
}

/**
 * The actor's authority, read again on the snapshot the delete will act on: the
 * request was authorised before it queued, and the flag or the membership may
 * have moved since. A superadmin is asked about `user.is_superadmin`; a club
 * admin about `assertStillClubAdmin` on the demo club.
 */
async function assertActorStillAuthorized(
	tx: DbOrTx,
	actor: ResetDemoClubOptions["actor"],
	existingId: string | null,
): Promise<void> {
	if (actor.kind === "superadmin") {
		const [row] = await tx
			.select({ isSuperadmin: user.isSuperadmin })
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		if (!row?.isSuperadmin) throw new DemoError("NOT_AUTHORIZED");
		return;
	}
	if (!existingId) throw new DemoError("NOT_AUTHORIZED");
	try {
		await assertStillClubAdmin(tx, actor.userId, existingId);
	} catch {
		throw new DemoError("NOT_AUTHORIZED");
	}
}

/**
 * Accounts a rebuild must not delete: the demo account, and every user linked to
 * one of the club's Persons (a member, or a guest who signed in) whose address is
 * not on a reserved domain. Only the fixture's own `@example.com`-style accounts
 * are the demo club's to remove.
 */
async function accountsToKeep(
	tx: DbOrTx,
	clubId: string,
	demoUserId: string | null,
): Promise<string[]> {
	// Two plain reads and an `inArray`: a hand-written correlated subquery in
	// `sql` can drop its qualifiers and match every row.
	const memberPersons = await tx
		.select({ id: members.personId })
		.from(members)
		.where(eq(members.clubId, clubId));
	const guestPersons = await tx
		.select({ id: guests.personId })
		.from(guests)
		.where(eq(guests.clubId, clubId));
	const personIds = [
		...new Set(
			[...memberPersons, ...guestPersons].flatMap((r) => (r.id ? [r.id] : [])),
		),
	];
	const linked =
		personIds.length === 0
			? []
			: await tx
					.selectDistinct({ id: user.id, email: user.email })
					.from(people)
					.innerJoin(user, eq(user.id, people.userId))
					.where(inArray(people.id, personIds));
	const keep = new Set<string>();
	for (const u of linked) if (!isReservedRecipient(u.email)) keep.add(u.id);
	if (demoUserId) keep.add(demoUserId);
	return [...keep];
}
