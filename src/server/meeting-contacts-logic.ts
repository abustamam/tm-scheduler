// Contact loaders for the VPE tap-to-nudge (#37). Called ONLY from the
// canManage-gated branch of `loadMeetingDetail`, so member/guest phone+email is
// never fetched for a public caller. In a `*-logic.ts` (never imported by
// client) per the server-bundle rule; exported so integration tests call the
// real code. See `docs/superpowers/specs/2026-07-20-tap-to-nudge-design.md`.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "#/db";
import { guests, members, people } from "#/db/schema";
import { toE164 } from "#/lib/phone";
import {
	type ContactMethod,
	effectivePreferredContact,
} from "#/lib/preferred-contact";
import { loadClubDefaultCountryCode } from "./clubs-logic";

/**
 * The goes-by name to greet a member by (#486): this club's membership value,
 * falling back to the Person's.
 *
 * The fallback is what makes `people.preferred_name` a person-level fact rather
 * than dead data (ADR-0008). Someone who records "goes by Rasheed" in club A
 * then joins club B gets a membership row with a NULL `preferred_name` — the
 * paths that create a membership for an EXISTING Person (the CSV importer,
 * club onboarding) have no such field to copy. Resolving it at READ time covers
 * every one of those paths at once, and keeps working for any added later.
 *
 * Membership wins when set, so a club that records a different name for the
 * same human keeps its own.
 */
const memberGoesBy = sql<
	string | null
>`coalesce(${members.preferredName}, ${people.preferredName})`;

export interface Contact {
	phone: string | null;
	email: string | null;
	/** What to call them in a nudge draft, when it isn't the first token of
	 *  their stored name (#486). Null ⇒ nobody recorded one. */
	preferredName: string | null;
	/** The EFFECTIVE preferred contact (#1093), never the raw column: null when
	 *  none is chosen or the chosen method's data is gone. Guests have none. */
	preferredContact?: ContactMethod | null;
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

/**
 * Active members of the club with contact — the recruiting pool. Phone is
 * normalized to E.164 with the club default country code (#295) so the
 * tap-to-nudge WhatsApp link is a valid full number.
 *
 * Bare `toE164`, deliberately NOT `coalesceToE164`: this payload is a dialable
 * target, never rendered text. A digit-less value yields no `whatsappHref`
 * either way (it returns null on empty digits), so coalescing would not add a
 * single working link — it would only make `nudge-recruit-picker`'s `!t.phone`
 * test truthy and SUPPRESS the honest "no contact" badge for someone nobody can
 * message. `NudgeButtons` lands on "No contact on file" through the null href
 * regardless.
 *
 * The roster, profile and season-grid payloads DO use `coalesceToE164` — they
 * DISPLAY the value, so preserving it is the point there. A difference in
 * payload purpose, not an inconsistency to reconcile.
 */
export async function loadRosterWithContact(
	clubId: string,
): Promise<RosterContact[]> {
	const [rows, cc] = await Promise.all([
		db
			.select({
				id: members.id,
				name: members.name,
				preferredName: memberGoesBy,
				phone: people.phone,
				email: people.email,
				storedContact: people.preferredContact,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
			.orderBy(members.name),
		loadClubDefaultCountryCode(clubId),
	]);
	return rows.map(({ storedContact, ...r }) => {
		const phone = toE164(r.phone, cc);
		return {
			...r,
			phone,
			preferredContact: effectivePreferredContact(storedContact, {
				email: r.email,
				phone,
			}),
		};
	});
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
			.select({
				id: members.id,
				phone: people.phone,
				email: people.email,
				preferredName: memberGoesBy,
				storedContact: people.preferredContact,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), inArray(members.id, memberIds)));
		for (const r of rows) {
			const phone = toE164(r.phone, cc);
			map.set(contactKey("member", r.id), {
				// Bare `toE164` on purpose — see `loadRosterWithContact`.
				phone,
				email: r.email,
				preferredName: r.preferredName,
				preferredContact: effectivePreferredContact(r.storedContact, {
					email: r.email,
					phone,
				}),
			});
		}
	}

	if (guestIds.length > 0) {
		const rows = await db
			.select({
				id: guests.id,
				// A guest's contact lives on their Person (#1125).
				phone: people.phone,
				email: people.email,
				preferredName: guests.preferredName,
			})
			.from(guests)
			.innerJoin(people, eq(people.id, guests.personId))
			.where(and(eq(guests.clubId, clubId), inArray(guests.id, guestIds)));
		for (const r of rows) {
			map.set(contactKey("guest", r.id), {
				// Bare `toE164` on purpose — see `loadRosterWithContact`.
				phone: toE164(r.phone, cc),
				email: r.email,
				preferredName: r.preferredName,
				preferredContact: null,
			});
		}
	}

	return map;
}
