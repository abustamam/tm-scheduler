// The demo club (#1199, part of #1114): one club, marked by `clubs.is_demo`,
// built from the Harbor City fixture (#1198) and rebuilt on demand from the
// superadmin console. Its people are made up (`@example.com`), so no real
// member's name, email or phone ever sits on a shared screen. Its only real user
// is the dedicated demo account named by `DEMO_ACCOUNT_EMAIL`.
//
// DB logic only: the session and superadmin gates live in `onboarding.ts`, and
// this module may not be imported by a client route (see server-modules.guard).

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { user } from "#/db/auth-schema";
import { buildFixtureClub } from "#/db/fixtures/club-fixture";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	clubVisits,
	districts,
	divisions,
	guests,
	members,
	officerTerms,
	people,
} from "#/db/schema";
import { programYearIsoWindow } from "#/lib/area-visits";
import { currentProgramYear } from "#/lib/dcp";
import { isReservedRecipient } from "#/lib/email";
import { normalizedEmail, normalizeEmail } from "./account-link-logic";
import { isoDayIn } from "./area-visits-logic";
import {
	CLUB_WRITE_LOCK_TIMEOUT,
	lockClubForWrite,
	takeAdvisoryLockWithin,
} from "./club-write-lock";
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

// The demo hierarchy (#1278): one district flagged `is_demo`, and in each
// program year one division and one area around the demo club.
export const DEMO_DISTRICT_NUMBER = "DEMO";
export const DEMO_DIVISION_LETTER = "A";
export const DEMO_AREA_NUMBER = "1";
export const DEMO_AREA_CLUB_NAMES = [
	"Bayfront Speakers",
	"Lighthouse Orators",
	"Pier Nine Toastmasters",
] as const;
export const DEMO_VISIT_LEAD_DAYS = 14;

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
	| "ADDRESS_IN_REAL_CLUB"
	| "ACCOUNT_IS_SUPERADMIN"
	| "NOT_DEMO_CLUB"
	| "NOT_AUTHORIZED";

const DEMO_ERROR_MESSAGES: Record<DemoErrorCode, string> = {
	NOT_CONFIGURED: "Set DEMO_ACCOUNT_EMAIL before building the demo club.",
	ACCOUNT_IN_REAL_CLUB:
		"The demo account belongs to a real club. Use an account that is in no other club.",
	ADDRESS_IN_REAL_CLUB:
		"A person at the demo account's address is already in a real club. Use an address that is in no other club.",
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
	// The binder's own normalisation (`normalizeEmail`), so the address compared
	// here is the address sign-in binds on.
	const email = normalizeEmail(raw);
	if (email == null || /[\s,]/u.test(email)) return null;
	return email;
}

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
			.where(sql`${normalizedEmail(user.email)} = ${email}`)
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

		// The same refusal for a Person at the demo address that has no account yet:
		// `people.email` is not unique, so the fixture would insert a SECOND Person
		// at the address and the real member's first sign-in would find two and bind
		// neither (`linkPersonToUser`).
		const unboundMemberships = await tx
			.select({ id: members.id })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.innerJoin(clubs, eq(clubs.id, members.clubId))
			.where(
				and(
					sql`${normalizedEmail(people.email)} = ${email}`,
					isNull(people.userId),
					eq(clubs.isDemo, false),
				),
			);
		const unboundGuestRows = await tx
			.select({ id: guests.id })
			.from(guests)
			.innerJoin(people, eq(people.id, guests.personId))
			.innerJoin(clubs, eq(clubs.id, guests.clubId))
			.where(
				and(
					sql`${normalizedEmail(people.email)} = ${email}`,
					isNull(people.userId),
					eq(clubs.isDemo, false),
				),
			);
		if (unboundMemberships.length > 0 || unboundGuestRows.length > 0) {
			throw new DemoError("ADDRESS_IN_REAL_CLUB");
		}

		// Lock order matches every other club writer (#925): the club write lock,
		// THEN the club row. A guest conversion holds the former while it waits for
		// the latter, so taking the row first deadlocks with it. There is at most
		// one demo club and the rebuild lock above is held, so the id read here is
		// the id the row lock below finds.
		const [named] = await tx
			.select({ id: clubs.id })
			.from(clubs)
			.where(eq(clubs.isDemo, true))
			.limit(1);
		if (named) await lockClubForWrite(tx, named.id);
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
			await deleteClubCore(tx, existing.id, {
				keepUser: demoKeepRule(email),
			});
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
		await buildDemoArea(tx, {
			clubId,
			demoUserId: demoUser?.id ?? null,
			actorUserId: opts.actor.userId,
			now: opts.now,
		});
		return { clubId };
	});
}

/**
 * The calendar date `DEMO_VISIT_LEAD_DAYS` before today in `DEMO_TIMEZONE`,
 * raised to the program year's first day when earlier. Calendar arithmetic on
 * the ISO date, not `now` minus 14 x 24h, so a DST change cannot shift it.
 */
export function demoVisitDay(now: Date, programYear: number): string {
	const [y, m, d] = isoDayIn(now, DEMO_TIMEZONE).split("-").map(Number);
	const back = new Date(
		Date.UTC(
			y as number,
			(m as number) - 1,
			(d as number) - DEMO_VISIT_LEAD_DAYS,
		),
	);
	const day = back.toISOString().slice(0, 10);
	const { start } = programYearIsoWindow(programYear);
	return day < start ? start : day;
}

/**
 * Build, or keep, the demo district, this program year's division and area, the
 * area's four clubs (the demo club and three name-only), two round-1 visits and
 * the demo account's director term (#1278). Runs inside `resetDemoClub`'s
 * transaction, so a throw rolls the whole rebuild back. The district, division
 * and area are found, never recreated; last year's are not touched.
 */
export async function buildDemoArea(
	tx: DbOrTx,
	opts: {
		clubId: string;
		demoUserId: string | null;
		actorUserId: string;
		now: Date;
	},
): Promise<{ areaId: string }> {
	const { now } = opts;
	const year = currentProgramYear(now);

	let [district] = await tx
		.select({ id: districts.id })
		.from(districts)
		.where(eq(districts.isDemo, true))
		.limit(1);
	if (!district) {
		[district] = await tx
			.insert(districts)
			.values({ number: DEMO_DISTRICT_NUMBER, isDemo: true })
			.returning({ id: districts.id });
	}
	if (!district) throw new Error("demo district");

	let [division] = await tx
		.select({ id: divisions.id })
		.from(divisions)
		.where(
			and(
				eq(divisions.districtId, district.id),
				eq(divisions.programYear, year),
				eq(divisions.letter, DEMO_DIVISION_LETTER),
			),
		)
		.limit(1);
	if (!division) {
		[division] = await tx
			.insert(divisions)
			.values({
				districtId: district.id,
				programYear: year,
				letter: DEMO_DIVISION_LETTER,
			})
			.returning({ id: divisions.id });
	}
	if (!division) throw new Error("demo division");

	let [area] = await tx
		.select({ id: areas.id })
		.from(areas)
		.where(
			and(
				eq(areas.divisionId, division.id),
				eq(areas.number, DEMO_AREA_NUMBER),
			),
		)
		.limit(1);
	if (!area) {
		[area] = await tx
			.insert(areas)
			.values({ divisionId: division.id, number: DEMO_AREA_NUMBER })
			.returning({ id: areas.id });
	}
	if (!area) throw new Error("demo area");
	const areaId = area.id;

	// Visits first: `club_visits.area_club_id` is RESTRICT. The area itself stays.
	await tx
		.delete(clubVisits)
		.where(
			inArray(
				clubVisits.areaClubId,
				tx
					.select({ id: areaClubs.id })
					.from(areaClubs)
					.where(eq(areaClubs.areaId, areaId)),
			),
		);
	await tx.delete(areaClubs).where(eq(areaClubs.areaId, areaId));

	// No club number on any row, so the console's link offer can never match a
	// real club.
	const [demoRow, bayfrontRow] = await tx
		.insert(areaClubs)
		.values([
			{
				areaId,
				clubId: opts.clubId,
				name: DEMO_CLUB_NAME,
				clubNumber: null,
			},
			...DEMO_AREA_CLUB_NAMES.map((name) => ({
				areaId,
				clubId: null,
				name,
				clubNumber: null,
			})),
		])
		.returning({ id: areaClubs.id, name: areaClubs.name });
	if (!demoRow || !bayfrontRow) throw new Error("demo area clubs");

	const day = demoVisitDay(now, year);
	await tx.insert(clubVisits).values(
		[demoRow, bayfrontRow].map((row) => ({
			areaClubId: row.id,
			round: 1,
			visitedOn: day,
			recordedBy: opts.demoUserId,
		})),
	);

	// The term bypasses `assignAreaDirector`, which refuses the demo district.
	if (opts.demoUserId) {
		const [open] = await tx
			.select({ id: areaDirectors.id, userId: areaDirectors.userId })
			.from(areaDirectors)
			.where(
				and(eq(areaDirectors.areaId, areaId), isNull(areaDirectors.endedAt)),
			)
			.limit(1);
		if (open?.userId !== opts.demoUserId) {
			if (open) {
				await tx
					.update(areaDirectors)
					.set({ endedAt: now, endedBy: opts.actorUserId })
					.where(eq(areaDirectors.id, open.id));
			}
			await tx.insert(areaDirectors).values({
				areaId,
				userId: opts.demoUserId,
				displayName: DEMO_ADMIN_NAME,
				startedAt: now,
				assignedBy: opts.actorUserId,
			});
		}
	}
	return { areaId };
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
 * Which accounts a rebuild must not delete, decided by `deleteClubCore` on the
 * `FOR UPDATE`-locked users of the Persons it is deleting: the demo account, and
 * any account whose address is deliverable (not on a reserved domain). Only the
 * fixture's own `@example.com`-style accounts are the demo club's to remove.
 *
 * It is a predicate and not a list because a list is read before the locks: a
 * real person added to the club by hand can click their magic link while the
 * rebuild is queued, and the sign-in then binds their Person to their account
 * after the list was made. The predicate sees the binding the lock saw.
 */
export function demoKeepRule(
	demoEmail: string,
): (account: { id: string; email: string }) => boolean {
	return (account) =>
		normalizeEmail(account.email) === demoEmail ||
		!isReservedRecipient(account.email);
}
