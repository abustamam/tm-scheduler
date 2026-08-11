// The two CONTACT queries behind `club.ts`'s server fns — `loadClubMembers` and
// `loadMemberProfile`. A `createServerFn` cannot be called from a test (no
// session, no RPC layer), so these live here and the wrappers' handlers call
// them; the same split as `members-logic.ts`.
//
// Deliberately not "every query in `club.ts` moves here": the speech-count
// aggregate and `loadRolesServed` are still inline there, and moving them was
// never the point. What these two have that those do not is member EMAIL and
// PHONE on the payload, which makes them worth reaching directly from an
// integration test (`club-contact.integration.test.ts`) and worth guarding
// (`club-contact-gate.guard.test.ts` requires every `club.ts` server fn that
// calls one of them to gate on `requireClubViewAccess`, and holds this module to
// exactly one importer).
//
// Neither function gates on its own — the gate is the caller's — so a new
// importer is a new place the whole roster's contact can escape.
//
// Keeping them out of `club.ts` also keeps that module to `createServerFn`s and
// types, which `server-modules.guard.test.ts` enforces: a plain db-touching
// export there drags `#/db` → `pg` → `Buffer` into the client bundle.
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { coalesceToE164 } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";

export interface ClubMemberRow {
	id: string;
	name: string;
	email: string | null;
	/**
	 * DISPLAY phone: E.164 where it can be derived, otherwise the stored value
	 * verbatim (`coalesceToE164`). Not a guarantee of E.164 — a digit-less value
	 * like "ask at church" comes back unchanged, which is exactly what
	 * `WhatsAppPhoneLink`'s plain-text branch exists to render.
	 *
	 * Never bind an EDIT FORM to this. Coalescing is a country-code GUESS, and a
	 * form that round-trips the guess writes it back over the stored digits on
	 * save — see `phoneRaw` on `loadMemberProfile`'s row.
	 */
	phone: string | null;
	userId: string | null;
	invitedAt: Date | null;
	status: "active" | "inactive";
	createdAt: Date;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
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
	return rows.map((r) => ({ ...r, phone: coalesceToE164(r.phone, cc) }));
}

/**
 * One roster member's identity + contact, scoped to the club. `undefined` when
 * the member isn't in that club — the `clubId` predicate is the scope check, so
 * an authorized member of club A can't read club B's row by id. Caller has
 * already authorized (`getMemberProfile` gates on `requireClubViewAccess`).
 *
 * Carries the phone TWICE, on purpose:
 *   - `phone` — coalesced for display, so the WhatsApp link is a full number.
 *   - `phoneRaw` — the `members.phone` column byte-for-byte, for the edit form.
 *
 * One field cannot serve both, for two reasons of very different weight.
 *
 * The one that BITES TODAY is display. Coalescing is a country-code GUESS: it
 * prepends the club default to anything not already `+`/`00`-prefixed, so
 * `"415-555-2671 x12"` reads back as `"+1415555267112"`. An officer opening the
 * dialog to fix a NAME is then shown a number nobody typed, in the only screen
 * that shows what is actually on file, with no way to tell a stored value from a
 * server-side rendering of it.
 *
 * The one that would bite LATER is data loss, and it is currently held off by an
 * accident: `applyMemberEdit` normalizes on write with `toStoredPhone`, which
 * happens to be a fixed point over `coalesceToE164` — `toStoredPhone(coalesce(x))
 * === toStoredPhone(x)` for every input (pinned by
 * `phone.test.ts`'s "toStoredPhone is a fixed point over coalesceToE164"). So the
 * guess survives a round trip today only because the write path re-derives it.
 * Nothing states that as a requirement of either function, and the moment one
 * drifts — a `coalesceToE164` taught to strip extensions, say — a coalesced
 * prefill starts writing the guess over the stored digits on every save.
 * Round-tripping the raw bytes does not depend on that coincidence.
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
	// `phone` is for DISPLAY (the WhatsApp link); `phoneRaw` is the column
	// verbatim, for the edit form. See `ClubMemberRow.phoneRaw`'s comment — a
	// dialog bound to `phone` writes the country-code GUESS back over the stored
	// digits on any save, including a name-only one.
	return { ...row, phone: coalesceToE164(row.phone, cc), phoneRaw: row.phone };
}
