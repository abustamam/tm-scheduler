// Marketing blasts (#931) — the DB half. Split from the `createServerFn`
// wrappers in `promo.ts` because a server-fn module may export only server fns
// and types, and because a handler body is unreachable from a test.
//
// Nothing here sends anything: the app drafts, a human sends. These readers
// build the SLIM meeting shape a blast is drawn from (`PromoMeeting`), which
// carries whether the meeting is online as a boolean and never the video-call
// link itself (#731/#754) — the column is only ever read here inside an
// `is not null`, so its value cannot reach a payload.

import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { clubLogoUrl } from "#/lib/club-logo-url";
import {
	type FlyerMeeting,
	type PromoClub,
	type PromoTemplate,
	resolvePromoTemplate,
} from "#/lib/promo-template";
import { loadClubLogoMeta } from "./club-logo-logic";
import { isReadableClub } from "./club-readable-logic";
import { resolveMeetingNumber } from "./meeting-number-logic";
import { resolveMeetingKey } from "./meeting-resolve-logic";
import { resolveMeetingUrlKey } from "./meeting-url-key-logic";
import { loadNextMeetingSummary } from "./meetings-logic";

/** How many upcoming meetings the Promote sheet offers to pick from. */
export const PROMO_UPCOMING_LIMIT = 6;

/** The club's blast template — the stored one, parsed, or the seeded default
 *  when it has none (a new club) or it no longer parses. */
export async function loadPromoTemplate(
	clubId: string,
): Promise<PromoTemplate> {
	const [row] = await db
		.select({ promoTemplate: clubs.promoTemplate })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!row) throw new Error("Club not found.");
	return resolvePromoTemplate(row.promoTemplate);
}

/** Replace the club's blast template. The caller validates the shape
 *  (`promoTemplateSchema`); this stores it whole. */
export async function applyUpdatePromoTemplate(
	clubId: string,
	template: PromoTemplate,
): Promise<{ ok: true }> {
	const updated = await db
		.update(clubs)
		.set({ promoTemplate: template })
		.where(eq(clubs.id, clubId))
		.returning({ id: clubs.id });
	if (updated.length === 0) throw new Error("Club not found.");
	return { ok: true };
}

/** Put the club back on the seeded default (the column goes back to NULL). */
export async function applyResetPromoTemplate(
	clubId: string,
): Promise<{ ok: true }> {
	await db
		.update(clubs)
		.set({ promoTemplate: null })
		.where(eq(clubs.id, clubId));
	return { ok: true };
}

/** The club a meeting belongs to, or null. */
export async function clubIdForMeeting(
	meetingId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	return row?.clubId ?? null;
}

/** The columns a blast reads, and nothing else. `online` is computed in SQL so
 *  the link's VALUE never leaves the database. */
const PROMO_COLUMNS = {
	id: meetings.id,
	clubId: meetings.clubId,
	scheduledAt: meetings.scheduledAt,
	location: meetings.location,
	online: sql<boolean>`(${meetings.joinUrl} is not null)`,
	theme: meetings.theme,
	wordOfTheDay: meetings.wordOfTheDay,
	promoNote: meetings.promoNote,
};

type PromoRow = {
	id: string;
	clubId: string;
	scheduledAt: Date;
	location: string | null;
	online: boolean;
	theme: string | null;
	wordOfTheDay: string | null;
	promoNote: string | null;
};

async function toFlyerMeeting(
	row: PromoRow,
	timezone: string,
): Promise<FlyerMeeting> {
	const [urlKey, meetingNumber] = await Promise.all([
		resolveMeetingUrlKey(row.clubId, row.scheduledAt, timezone),
		resolveMeetingNumber(row.id),
	]);
	return {
		id: row.id,
		urlKey,
		scheduledAt: row.scheduledAt,
		location: row.location,
		online: Boolean(row.online),
		theme: row.theme,
		wordOfTheDay: row.wordOfTheDay,
		meetingNumber,
		promoNote: row.promoNote,
	};
}

async function loadClub(clubId: string) {
	const [club] = await db
		.select({
			id: clubs.id,
			name: clubs.name,
			slug: clubs.slug,
			timezone: clubs.timezone,
			promoTemplate: clubs.promoTemplate,
		})
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	return club ?? null;
}

export interface PromoContext {
	club: PromoClub & { id: string };
	template: PromoTemplate;
	/** Versioned logo URL, or null. */
	logoUrl: string | null;
	/** Upcoming meetings, soonest first — plus the requested one when it is
	 *  not among them (a past meeting opened from its own page). */
	meetings: FlyerMeeting[];
	/** The meeting the sheet opens on: the requested one, else the NEXT one
	 *  (`loadNextMeetingSummary`), else null when nothing is scheduled. */
	selectedId: string | null;
}

/**
 * Everything the Promote sheet needs for one club. Gated by the caller
 * (`requireClubAdminView`), like `getGuestInviteContext`.
 */
export async function loadPromoContext(
	clubId: string,
	now: Date,
	meetingId?: string | null,
): Promise<PromoContext> {
	const club = await loadClub(clubId);
	if (!club) throw new Error("Club not found.");

	const [summary, upcomingRows, logoMeta] = await Promise.all([
		loadNextMeetingSummary(clubId, now),
		db
			.select(PROMO_COLUMNS)
			.from(meetings)
			.where(
				and(
					eq(meetings.clubId, clubId),
					gte(meetings.scheduledAt, now),
					ne(meetings.status, "cancelled"),
				),
			)
			.orderBy(asc(meetings.scheduledAt))
			.limit(PROMO_UPCOMING_LIMIT),
		loadClubLogoMeta(clubId),
	]);

	const rows: PromoRow[] = [...upcomingRows];
	if (meetingId && !rows.some((r) => r.id === meetingId)) {
		const [requested] = await db
			.select(PROMO_COLUMNS)
			.from(meetings)
			.where(and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId)))
			.limit(1);
		if (!requested) throw new Error("Meeting not found.");
		rows.unshift(requested);
	}

	const list = await Promise.all(
		rows.map((r) => toFlyerMeeting(r, club.timezone)),
	);
	const selectedId =
		meetingId ?? summary.nextMeeting?.id ?? list[0]?.id ?? null;

	return {
		club: {
			id: club.id,
			name: club.name,
			slug: club.slug,
			timezone: club.timezone,
		},
		template: resolvePromoTemplate(club.promoTemplate),
		logoUrl: clubLogoUrl(club.id, logoMeta?.updatedAt),
		meetings: list,
		selectedId,
	};
}

export interface PublicFlyer {
	club: PromoClub;
	template: PromoTemplate;
	meeting: FlyerMeeting;
	logoUrl: string | null;
}

/**
 * The PUBLIC `/flyer` route's payload: null for an unknown or ARCHIVED club
 * (`isReadableClub`, the `Public` convention every gated seam here follows)
 * and for a key naming no meeting of this club. A cancelled meeting is still
 * served, like every other meeting surface — the officer is the one who
 * decides not to hand it out.
 */
export async function loadPublicFlyer(
	clubId: string,
	key: string,
): Promise<PublicFlyer | null> {
	if (!(await isReadableClub(clubId))) return null;
	const meetingId = await resolveMeetingKey(clubId, key);
	if (!meetingId) return null;
	const club = await loadClub(clubId);
	if (!club) return null;
	const [row] = await db
		.select(PROMO_COLUMNS)
		.from(meetings)
		.where(and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId)))
		.limit(1);
	if (!row) return null;
	const logoMeta = await loadClubLogoMeta(clubId);
	return {
		club: { name: club.name, slug: club.slug, timezone: club.timezone },
		template: resolvePromoTemplate(club.promoTemplate),
		meeting: await toFlyerMeeting(row, club.timezone),
		logoUrl: clubLogoUrl(clubId, logoMeta?.updatedAt),
	};
}
