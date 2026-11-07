import { and, asc, eq, gte, ne } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import type { InviteKind } from "#/lib/guest-invite";
import {
	type GuestInviteField,
	type GuestInviteTemplates,
	INVITE_KINDS,
	isDefaultOrBlank,
	resolveGuestInviteTemplates,
} from "#/lib/guest-invite-template";

// The db-touching half of the guest invite templates (#1547), kept out of
// `guest-invite-template.ts` so `#/db` -> `pg` never reaches the browser bundle.
//
// Nothing here SENDS anything. The app drafts, a human sends.

const FIELDS: readonly GuestInviteField[] = ["body", "subject"];

/**
 * What to store: every field that is blank or exactly its default dropped (it
 * keeps rendering through the built-in text), an emptied draft removed, and
 * `null` when nothing is left. Pure.
 */
export function normalizeGuestInviteTemplates(
	templates: GuestInviteTemplates,
): GuestInviteTemplates | null {
	const out: GuestInviteTemplates = {};
	for (const kind of INVITE_KINDS) {
		const draft: { body?: string; subject?: string } = {};
		for (const field of FIELDS) {
			const text = templates[kind]?.[field];
			if (text !== undefined && !isDefaultOrBlank(kind, field, text))
				draft[field] = text;
		}
		if (Object.keys(draft).length > 0) out[kind] = draft;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** The club's saved templates; an invalid stored value reads as `{}`. */
export async function loadGuestInviteTemplates(
	clubId: string,
): Promise<GuestInviteTemplates> {
	const [row] = await db
		.select({ stored: clubs.guestInviteTemplates })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!row) throw new Error("Club not found.");
	return resolveGuestInviteTemplates(row.stored);
}

/** Replace the club's templates. The caller validates the shape
 *  (`guestInviteTemplatesSchema`); this normalises, then stores. */
export async function applyUpdateGuestInviteTemplates(
	clubId: string,
	templates: GuestInviteTemplates,
): Promise<{ ok: true }> {
	const updated = await db
		.update(clubs)
		.set({ guestInviteTemplates: normalizeGuestInviteTemplates(templates) })
		.where(eq(clubs.id, clubId))
		.returning({ id: clubs.id });
	if (updated.length === 0) throw new Error("Club not found.");
	return { ok: true };
}

/** Remove one draft's entry; the other drafts keep their text. */
export async function applyResetGuestInviteTemplate(
	clubId: string,
	kind: InviteKind,
): Promise<{ ok: true }> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select({ stored: clubs.guestInviteTemplates })
			.from(clubs)
			.where(eq(clubs.id, clubId))
			.for("update")
			.limit(1);
		if (!row) throw new Error("Club not found.");
		const current = resolveGuestInviteTemplates(row.stored);
		const { [kind]: _removed, ...rest } = current;
		await tx
			.update(clubs)
			.set({ guestInviteTemplates: normalizeGuestInviteTemplates(rest) })
			.where(eq(clubs.id, clubId));
	});
	return { ok: true };
}

/**
 * The club's next non-cancelled meeting's video call link, or null. The same
 * "next" as `loadNextMeetingSummary` (a start at or after `now`), but a query of
 * its own: that summary is shared with slides and reporting and must never carry
 * the link. Reached only through the officer-gated `getGuestInviteContext`.
 */
export async function loadNextMeetingJoinLink(
	clubId: string,
	now: Date,
): Promise<string | null> {
	const [next] = await db
		.select({ joinLink: meetings.joinUrl })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, now),
				ne(meetings.status, "cancelled"),
			),
		)
		.orderBy(asc(meetings.scheduledAt))
		.limit(1);
	return next?.joinLink?.trim() || null;
}
