// Contact loaders for the VPE tap-to-nudge (#37). Called ONLY from the
// canManage-gated branch of `loadMeetingDetail`, so member/guest phone+email is
// never fetched for a public caller. In a `*-logic.ts` (never imported by
// client) per the server-bundle rule; exported so integration tests call the
// real code. See `docs/superpowers/specs/2026-07-20-tap-to-nudge-design.md`.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, members } from "#/db/schema";

export interface Contact {
	phone: string | null;
	email: string | null;
}

export interface RosterContact extends Contact {
	id: string;
	name: string;
}

/** Active members of the club with contact — the recruiting pool. */
export async function loadRosterWithContact(
	clubId: string,
): Promise<RosterContact[]> {
	return db
		.select({
			id: members.id,
			name: members.name,
			phone: members.phone,
			email: members.email,
		})
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(members.name);
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

	if (memberIds.length > 0) {
		const rows = await db
			.select({ id: members.id, phone: members.phone, email: members.email })
			.from(members)
			.where(and(eq(members.clubId, clubId), inArray(members.id, memberIds)));
		for (const r of rows) {
			map.set(`member:${r.id}`, { phone: r.phone, email: r.email });
		}
	}

	if (guestIds.length > 0) {
		const rows = await db
			.select({ id: guests.id, phone: guests.phone, email: guests.email })
			.from(guests)
			.where(and(eq(guests.clubId, clubId), inArray(guests.id, guestIds)));
		for (const r of rows) {
			map.set(`guest:${r.id}`, { phone: r.phone, email: r.email });
		}
	}

	return map;
}
