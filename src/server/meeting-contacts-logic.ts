// Contact loaders for the VPE tap-to-nudge (#37). Called ONLY from the
// canManage-gated branch of `loadMeetingDetail`, so member/guest phone+email is
// never fetched for a public caller. In a `*-logic.ts` (never imported by
// client) per the server-bundle rule; exported so integration tests call the
// real code. See `docs/superpowers/specs/2026-07-20-tap-to-nudge-design.md`.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, members } from "#/db/schema";
import { toE164 } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";

export interface Contact {
	phone: string | null;
	email: string | null;
}

export interface RosterContact extends Contact {
	id: string;
	name: string;
}

/** Map key for a holder contact — kept in one place so the write side
 *  (loadHolderContacts) and read side (loadMeetingDetail) can't drift. */
export function contactKey(kind: "member" | "guest", id: string): string {
	return `${kind}:${id}`;
}

/** Active members of the club with contact — the recruiting pool. Phone is
 *  normalized to E.164 with the club default country code (#295) so the
 *  tap-to-nudge WhatsApp link is a valid full number. */
export async function loadRosterWithContact(
	clubId: string,
): Promise<RosterContact[]> {
	const [rows, cc] = await Promise.all([
		db
			.select({
				id: members.id,
				name: members.name,
				phone: members.phone,
				email: members.email,
			})
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
			.orderBy(members.name),
		loadClubDefaultCountryCode(clubId),
	]);
	return rows.map((r) => ({ ...r, phone: toE164(r.phone, cc) }));
}

/**
 * Resolve contact for held slots, keyed `member:<id>` / `guest:<id>`. Handles
 * holders who are NOT in the active roster (inactive members, guests). Runs no
 * query for an empty id list. Scoped by `clubId` as defense-in-depth: this is a
 * PII-boundary function, so it never returns another club's contact even if a
 * caller passes a foreign id.
 */
export async function loadHolderContacts(
	clubId: string,
	memberIds: string[],
	guestIds: string[],
): Promise<Map<string, Contact>> {
	const map = new Map<string, Contact>();
	if (memberIds.length === 0 && guestIds.length === 0) return map;

	// Phone normalized to E.164 with the club default country code (#295).
	const cc = await loadClubDefaultCountryCode(clubId);

	if (memberIds.length > 0) {
		const rows = await db
			.select({ id: members.id, phone: members.phone, email: members.email })
			.from(members)
			.where(and(eq(members.clubId, clubId), inArray(members.id, memberIds)));
		for (const r of rows) {
			map.set(contactKey("member", r.id), {
				phone: toE164(r.phone, cc),
				email: r.email,
			});
		}
	}

	if (guestIds.length > 0) {
		const rows = await db
			.select({ id: guests.id, phone: guests.phone, email: guests.email })
			.from(guests)
			.where(and(eq(guests.clubId, clubId), inArray(guests.id, guestIds)));
		for (const r of rows) {
			map.set(contactKey("guest", r.id), {
				phone: toE164(r.phone, cc),
				email: r.email,
			});
		}
	}

	return map;
}
