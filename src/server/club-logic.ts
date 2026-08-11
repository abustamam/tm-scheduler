// Directly-testable db logic behind `club.ts`'s server fns. A `createServerFn`
// cannot be called from a test (no session, no RPC layer), so the queries live
// here and the wrappers' handlers call them — the same split as
// `members-logic.ts`. Keeping them out of `club.ts` also keeps that module to
// `createServerFn`s and types, which `server-modules.guard.test.ts` enforces:
// a plain db-touching export there drags `#/db` → `pg` → `Buffer` into the
// client bundle.
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { toE164 } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";

export interface ClubMemberRow {
	id: string;
	name: string;
	email: string | null;
	/** Coalesced to E.164 with the club default country code (#295), so the
	 *  roster's WhatsApp link is a valid full number even for pre-#397 rows. */
	phone: string | null;
	userId: string | null;
	invitedAt: Date | null;
	status: "active" | "inactive";
	createdAt: Date;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
}

/**
 * Coalesce a stored phone to E.164 for a payload.
 *
 * `?? raw` is load-bearing: `toE164` returns null for a value with no digits
 * ("call the office"), which `toStoredPhone` DELIBERATELY stores verbatim so the
 * user can still see and edit it — and the roster editor validates phone as a
 * plain nullable string with no digit requirement, so such a value is reachable
 * in normal use, not just in legacy data. Dropping to null would make that text
 * vanish from the UI, and it would starve `WhatsAppPhoneLink`'s digit-less
 * branch, which exists to render exactly this as plain text rather than a dead
 * link.
 */
function coalescePhone(raw: string | null, cc: string): string | null {
	return toE164(raw, cc) ?? raw;
}

/**
 * The club's roster rows with contact (email since #266, phone since the
 * WhatsApp-links change). Caller has already authorized — `listClubMembers`
 * gates this behind `requireUser` + `requireClubViewAccess`.
 */
export async function loadClubMembers(
	clubId: string,
): Promise<ClubMemberRow[]> {
	const [rows, cc] = await Promise.all([
		db
			.select({
				id: members.id,
				name: members.name,
				email: members.email,
				phone: members.phone,
				// "Signed-in account?" is now a Person-level fact (ADR-0008 Phase B):
				// the auth link lives on people.user_id, not the membership row.
				userId: people.userId,
				// Account-invite tracking (#266) — drives the roster's per-row
				// invited/joined state alongside `userId`.
				invitedAt: people.invitedAt,
				status: members.status,
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				// Person-level fact (ADR-0008): read off the joined `people` row.
				originalJoinDate: people.originalJoinDate,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name)),
		loadClubDefaultCountryCode(clubId),
	]);
	return rows.map((r) => ({ ...r, phone: coalescePhone(r.phone, cc) }));
}

/**
 * One roster member's identity + contact, scoped to the club. `undefined` when
 * the member isn't in that club — the `clubId` predicate is the scope check, so
 * an authorized member of club A can't read club B's row by id. Caller has
 * already authorized (`getMemberProfile` gates on `requireClubViewAccess`).
 */
export async function loadMemberProfile(clubId: string, memberId: string) {
	const [row, cc] = await Promise.all([
		db
			.select({
				id: members.id,
				personId: members.personId,
				name: members.name,
				// What they're called, when it isn't the first token of `name` (#486).
				// Coalesced the same way the nudge draft reads it, so the edit form
				// shows the name that will ACTUALLY be used. Binding to the raw
				// membership column would render a blank field for a member whose
				// value lives on their Person (the cross-club case) while every draft
				// greeted them by it.
				preferredName: sql<
					string | null
				>`coalesce(${members.preferredName}, ${people.preferredName})`,
				email: members.email,
				phone: members.phone,
				// "Signed-in account?" is now a Person-level fact (ADR-0008 Phase B):
				// the auth link lives on people.user_id, not the membership row.
				userId: people.userId,
				status: members.status,
				// Club-role permission (admin ⇄ member) — orthogonal to office (#187).
				clubRole: members.clubRole,
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				// Person-level fact (ADR-0008): read off the joined `people` row.
				originalJoinDate: people.originalJoinDate,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.id, memberId), eq(members.clubId, clubId)))
			.limit(1)
			.then((r) => r[0]),
		loadClubDefaultCountryCode(clubId),
	]);
	if (!row) return undefined;
	return { ...row, phone: coalescePhone(row.phone, cc) };
}
