// The club's own wording for the four guest invite drafts (#1547). Pure and
// client-safe: the editor, the VP Membership page and `buildNudge` all read it,
// so there is no `#/db` here.
//
// The built-in texts stay hard-coded in `nudge.ts` (`INVITE_DRAFTS`) and are
// what a club that never opens the editor keeps getting, byte for byte. The
// `DEFAULT_GUEST_INVITE_TEMPLATES` below restate them as templates ONLY to
// pre-fill the editor and to tell "left at the default" from "edited": a field
// that equals its default is stored as unset, so it keeps rendering through the
// hard-coded builder (and its conditional ", at <location>").
//
// `{joinLink}` is an opt-in variable, as in Promote: it appears in no default
// text and is filled only from the officer-gated invite context.

import { z } from "zod";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatShortDate,
} from "#/lib/format";
import type { InviteKind } from "#/lib/guest-invite";
import { promoVariable, type TemplateVariable } from "#/lib/promo-template";

export const GUEST_INVITE_LIMITS = { body: 1000, subject: 200 } as const;

const draftSchema = z.object({
	body: z.string().max(GUEST_INVITE_LIMITS.body).optional(),
	subject: z.string().max(GUEST_INVITE_LIMITS.subject).optional(),
});

export const guestInviteTemplatesSchema = z.object({
	never: draftSchema.optional(),
	firstRecent: draftSchema.optional(),
	repeatRecent: draftSchema.optional(),
	lapsed: draftSchema.optional(),
});

export type GuestInviteTemplates = z.infer<typeof guestInviteTemplatesSchema>;

export const INVITE_KINDS = [
	"never",
	"firstRecent",
	"repeatRecent",
	"lapsed",
] as const satisfies readonly InviteKind[];

export type GuestInviteField = "body" | "subject";

/** Shown on the editor's tabs. */
export const INVITE_KIND_LABELS: Record<InviteKind, string> = {
	never: "Never visited",
	firstRecent: "First visit, recent",
	repeatRecent: "Repeat visit, recent",
	lapsed: "Lapsed",
};

/** A shared key keeps Promote's label, so a pill reads the same in both editors. */
const shared = (key: "club" | "date" | "time" | "location" | "agendaLink") =>
	promoVariable(key).label;
const sharedJoin = () => promoVariable("joinLink").label;

/** Every guest invite variable, in menu order. */
export const GUEST_INVITE_VARIABLES = [
	{
		key: "guestName",
		label: "Guest first name",
		description: "The name the draft greets the guest by",
		group: "guest",
	},
	{
		key: "firstVisit",
		label: "First visit",
		description: "The date of their first visit, e.g. Oct 9",
		group: "guest",
	},
	{
		key: "lastVisit",
		label: "Last visit",
		description: "The date of their latest visit, e.g. Oct 23",
		group: "guest",
	},
	{
		key: "visitCount",
		label: "Visit count",
		description: "How many meetings they have visited",
		group: "guest",
	},
	{
		key: "date",
		label: shared("date"),
		description: "The next meeting day, e.g. Tuesday, November 18",
		group: "meeting",
	},
	{
		key: "time",
		label: shared("time"),
		description: "Start time, in the club's time zone",
		group: "meeting",
	},
	{
		key: "location",
		label: shared("location"),
		description: "The venue, or nothing when none is set",
		group: "meeting",
	},
	{
		key: "agendaLink",
		label: shared("agendaLink"),
		description: "The next meeting's public agenda",
		group: "links",
	},
	{
		key: "joinLink",
		label: sharedJoin(),
		description:
			"The video call link. Anyone with it can join, so add it on purpose",
		group: "links",
	},
	{
		key: "club",
		label: shared("club"),
		description: "Your club's name",
		group: "club",
	},
] as const satisfies readonly TemplateVariable[];

export type GuestInviteKey = (typeof GUEST_INVITE_VARIABLES)[number]["key"];
export type GuestInviteValues = Record<GuestInviteKey, string>;

const GUEST_KEYS: ReadonlySet<string> = new Set(
	GUEST_INVITE_VARIABLES.map((v) => v.key),
);

/** Today's four texts as templates. They pre-fill the editor and are what a
 *  field is compared against; they do not render drafts. */
export const DEFAULT_GUEST_INVITE_TEMPLATES: Record<
	InviteKind,
	{ body: string; subject: string }
> = {
	never: {
		body: "Hi {guestName}, we'd love to have you visit {club}! We meet on {date} at {time}, at {location}. Agenda: {agendaLink}",
		subject: "Join us at {club} on {date}?",
	},
	firstRecent: {
		body: "Hi {guestName}, thanks for visiting {club} for the first time! We meet again on {date} at {time}, at {location}. We'd love to have you back. Agenda: {agendaLink}",
		subject: "Thanks for visiting {club}",
	},
	repeatRecent: {
		body: "Hi {guestName}, great to see you again at {club}. Our next meeting is {date} at {time}, at {location}. Hope you can make it! Agenda: {agendaLink}",
		subject: "See you at {club} on {date}?",
	},
	lapsed: {
		body: "Hi {guestName}, it's been a little while. We'd love to see you back at {club}! We meet next on {date} at {time}, at {location}. Agenda: {agendaLink}",
		subject: "We'd love to see you back at {club}",
	},
};

/** A stored value read safely: anything that fails the schema is `{}`. */
export function resolveGuestInviteTemplates(
	stored: unknown,
): GuestInviteTemplates {
	const parsed = guestInviteTemplatesSchema.safeParse(stored);
	return parsed.success ? parsed.data : {};
}

/** True when `text` is blank or is exactly the field's default, i.e. it should
 *  not be stored. */
export function isDefaultOrBlank(
	kind: InviteKind,
	field: GuestInviteField,
	text: string | undefined,
): boolean {
	if (text === undefined || text.trim() === "") return true;
	return text === DEFAULT_GUEST_INVITE_TEMPLATES[kind][field];
}

/** The club's text for one draft field, or null when the draft should use the
 *  built-in text (unset, blank after trim, or equal to the default). */
export function customTemplateFor(
	templates: GuestInviteTemplates,
	kind: InviteKind,
	field: GuestInviteField,
): string | null {
	const text = templates[kind]?.[field];
	if (text === undefined || isDefaultOrBlank(kind, field, text)) return null;
	return text;
}

/** `{key}` becomes its value; an unknown `{token}` stays as typed. A blank value
 *  is an empty string: nothing is dropped and nothing is collapsed. */
export function renderGuestInviteText(
	text: string,
	values: GuestInviteValues,
): string {
	return text.replace(/\{([^{}\n]+)\}/g, (whole, name: string) =>
		GUEST_KEYS.has(name) ? values[name as GuestInviteKey] : whole,
	);
}

type DateInput = Date | string | null | undefined;

/** The values a real draft fills in. `joinLink` is the next meeting's link, or
 *  null; `guestName` is the already-chosen greeting name. */
export function guestInviteValues(input: {
	guestName: string;
	clubName: string;
	meeting: { scheduledAt: Date | string; location?: string | null };
	shareUrl: string;
	joinLink: string | null;
	guest: {
		firstVisitAt: DateInput;
		lastVisitAt: DateInput;
		inviteVisitCount: number;
	};
	timeZone: string;
}): GuestInviteValues {
	const { meeting, guest, timeZone } = input;
	const day = (d: DateInput) => (d ? formatShortDate(d, timeZone) : "");
	return {
		guestName: input.guestName,
		club: input.clubName,
		date: formatMeetingDate(meeting.scheduledAt, timeZone),
		time: formatMeetingTime(meeting.scheduledAt, timeZone),
		location: meeting.location?.trim() ?? "",
		agendaLink: input.shareUrl,
		joinLink: input.joinLink?.trim() ?? "",
		firstVisit: day(guest.firstVisitAt),
		lastVisit: day(guest.lastVisitAt),
		visitCount: String(Math.max(0, Math.trunc(guest.inviteVisitCount))),
	};
}

const EXAMPLE_VISITS: Record<
	InviteKind,
	{ count: number; first: number; last: number } | null
> = {
	never: null,
	firstRecent: { count: 1, first: -7, last: -7 },
	repeatRecent: { count: 3, first: -35, last: -7 },
	lapsed: { count: 2, first: -49, last: -21 },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Preview values for one draft: a made-up guest and a next meeting a week out.
 *  `never` has empty visit fields. */
export function exampleGuestInviteValues(
	kind: InviteKind,
	now: Date,
	timeZone: string,
	origin = "https://gavelup.app",
): GuestInviteValues {
	const visits = EXAMPLE_VISITS[kind];
	const at = (days: number) => new Date(now.getTime() + days * DAY_MS);
	return guestInviteValues({
		guestName: "Alex",
		clubName: "Your Club",
		meeting: { scheduledAt: at(7), location: "Community Library, Room 2" },
		shareUrl: `${origin}/club/your-club/meeting/next`,
		joinLink: "https://meet.example.com/your-club",
		guest: {
			firstVisitAt: visits ? at(visits.first) : null,
			lastVisitAt: visits ? at(visits.last) : null,
			inviteVisitCount: visits?.count ?? 0,
		},
		timeZone,
	});
}
