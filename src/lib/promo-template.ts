// Marketing blasts (#931): the club's ONE blast template, the placeholder
// renderer that fills it in from a meeting, and the three outputs built from
// it — a WhatsApp message, an email draft and a flyer.
//
// Pure and client-safe: no `#/db`. The Promote sheet, the club settings editor
// and the public `/flyer` route all read this module, and so does
// `promo-logic.ts` on the server, so the template's shape and its default are
// stated once.
//
// ## The app drafts; a human sends
//
// Nothing here sends anything. Every output is a draft an officer copies or
// opens in their own app (#899's rule, `nudge.ts`), so a blast needs no mailing
// list, consent store or unsubscribe flow.
//
// ## The video-call link is never in a blast
//
// The value map below has no field for it, by construction: `PromoMeeting`
// carries only `online: boolean`, and `{online}` renders a sentence pointing at
// the public meeting page — which is where the link lives (#731/#754). The
// #731 source guard sweeps this file raw, so it must not
// even NAME the field, comments included.

import { z } from "zod";
import { APP_LOCALE } from "#/lib/format";
import { escapeHtml } from "#/lib/html-escape";

/** Every placeholder a template may use, and nothing else. */
export const PROMO_PLACEHOLDERS = [
	"club",
	"date",
	"time",
	"location",
	"online",
	"theme",
	"wordOfTheDay",
	"meetingNumber",
	"meetingLink",
	"clubLink",
	"note",
] as const;

export type PromoPlaceholder = (typeof PROMO_PLACEHOLDERS)[number];

/** The resolved value of every placeholder. Empty string = no value, and a
 *  line holding an empty placeholder is DROPPED rather than rendered as
 *  "Theme: ". */
export type PromoValues = Record<PromoPlaceholder, string>;

const PLACEHOLDER_SET: ReadonlySet<string> = new Set(PROMO_PLACEHOLDERS);

export function isPromoPlaceholder(name: string): name is PromoPlaceholder {
	return PLACEHOLDER_SET.has(name);
}

/** The parts of the template a channel may include or leave out. The headline
 *  and the meeting link are always included. */
export const PROMO_PARTS = ["intro", "whyJoin", "callToAction"] as const;
export type PromoPart = (typeof PROMO_PARTS)[number];

export const PROMO_CHANNELS = ["whatsapp", "email", "flyer"] as const;
export type PromoChannel = (typeof PROMO_CHANNELS)[number];

export const PROMO_LIMITS = {
	headline: 160,
	intro: 1000,
	bullet: 160,
	bullets: 8,
	callToAction: 300,
	/** A meeting's promo note — one short line. */
	note: 300,
	/** Roughly what reads as one message in a group chat. A soft limit: the
	 *  sheet warns past it, it never truncates. */
	whatsappSoft: 600,
} as const;

const partsSchema = z.object({
	intro: z.boolean(),
	whyJoin: z.boolean(),
	callToAction: z.boolean(),
});

export type PromoChannelParts = z.infer<typeof partsSchema>;

export const promoTemplateSchema = z.object({
	headline: z.string().trim().min(1).max(PROMO_LIMITS.headline),
	intro: z.string().max(PROMO_LIMITS.intro),
	whyJoin: z
		.array(z.string().trim().min(1).max(PROMO_LIMITS.bullet))
		.max(PROMO_LIMITS.bullets),
	callToAction: z.string().max(PROMO_LIMITS.callToAction),
	channels: z.object({
		whatsapp: partsSchema,
		email: partsSchema,
		flyer: partsSchema,
	}),
});

export type PromoTemplate = z.infer<typeof promoTemplateSchema>;

/** What a club gets until an admin edits it. */
export const DEFAULT_PROMO_TEMPLATE: PromoTemplate = {
	headline: "You're invited: {club}, {date}",
	intro: [
		"{note}",
		"When: {date}, {time}",
		"Where: {location}",
		"{online}",
		"Theme: {theme}",
		"Word of the Day: {wordOfTheDay}",
	].join("\n"),
	whyJoin: [
		"Practice public speaking in a supportive room",
		"Build leadership by running part of the meeting",
		"Get specific feedback every time you speak",
		"Meet people from across the community",
		"Guests are always welcome and free",
	],
	callToAction: "Just show up, or reply here and we'll save you a seat.",
	channels: {
		whatsapp: { intro: true, whyJoin: true, callToAction: true },
		email: { intro: true, whyJoin: true, callToAction: true },
		// The flyer draws the date, time, venue and theme itself, in display
		// type, so the intro's "When:/Where:" lines would print twice.
		flyer: { intro: false, whyJoin: true, callToAction: true },
	},
};

/**
 * The stored template, parsed — or the default when there is none or it no
 * longer parses. A stored value is never trusted as-is: it is `jsonb`, and a
 * row written before a field existed must not crash the sheet.
 */
export function resolvePromoTemplate(stored: unknown): PromoTemplate {
	return resolvePromoTemplateState(stored).template;
}

export interface PromoTemplateState {
	template: PromoTemplate;
	/** A template IS stored but no longer parses, so the default is standing
	 *  in for it. The editor says so rather than silently replacing the
	 *  admin's edits with the default on their next save. */
	storedInvalid: boolean;
}

export function resolvePromoTemplateState(stored: unknown): PromoTemplateState {
	if (stored == null) {
		return { template: DEFAULT_PROMO_TEMPLATE, storedInvalid: false };
	}
	const parsed = promoTemplateSchema.safeParse(stored);
	return parsed.success
		? { template: parsed.data, storedInvalid: false }
		: { template: DEFAULT_PROMO_TEMPLATE, storedInvalid: true };
}

const TOKEN = /\{(\w+)\}/g;

/** Every `{name}` in `text` that is not a known placeholder, once each, in
 *  order of first appearance. */
export function unknownPlaceholders(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(TOKEN)) {
		const name = m[1];
		if (!isPromoPlaceholder(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Every unknown placeholder anywhere in a template — what the editor shows as
 *  a warning. */
export function templateWarnings(template: PromoTemplate): string[] {
	const text = [
		template.headline,
		template.intro,
		...template.whyJoin,
		template.callToAction,
	].join("\n");
	return unknownPlaceholders(text);
}

/**
 * Fill `text` in from `values`, line by line.
 *
 *   - A known placeholder is replaced by its value.
 *   - A line holding a known placeholder whose value is EMPTY is dropped whole,
 *     so an unset theme never prints "Theme: ".
 *   - An UNKNOWN placeholder is left exactly as typed, never blanked: blanking
 *     it would hide a typo from the officer about to send it. The editor flags
 *     it (`unknownPlaceholders`).
 *
 * Runs of blank lines left by dropped lines collapse to one, and the result is
 * trimmed.
 */
export function renderPromoText(text: string, values: PromoValues): string {
	const kept: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		let drop = false;
		const rendered = line.replace(TOKEN, (whole, name: string) => {
			if (!isPromoPlaceholder(name)) return whole;
			const value = values[name].trim();
			if (!value) drop = true;
			return value;
		});
		if (drop) continue;
		const trimmed = rendered.trimEnd();
		if (!trimmed.trim() && kept.length > 0 && !kept[kept.length - 1].trim()) {
			continue;
		}
		kept.push(trimmed);
	}
	return kept.join("\n").trim();
}

/** The club, as a blast needs it. */
export interface PromoClub {
	name: string;
	slug: string;
	timezone: string;
}

/**
 * The meeting, as a blast needs it — and nothing else. `online` is a boolean
 * on purpose: the link itself stays on the meeting page.
 */
export interface PromoMeeting {
	/** The canonical public URL key (`resolveMeetingUrlKey`). */
	urlKey: string;
	scheduledAt: Date | string;
	location: string | null;
	/** Whether the meeting has a video-call link — never the link. */
	online: boolean;
	theme: string | null;
	wordOfTheDay: string | null;
	/** Stored or derived (#358); null when the club has never numbered one. */
	meetingNumber: number | null;
	promoNote: string | null;
}

/** What `{online}` says. Points at the meeting page, never at the room. */
export const ONLINE_TEXT = "Also online: the link is on the meeting page";

/** The public meeting page's path. Guests can open it signed out. */
export function promoMeetingPath(clubSlug: string, urlKey: string): string {
	return `/club/${clubSlug}/meeting/${urlKey}`;
}

export function promoDate(scheduledAt: Date | string, timeZone: string) {
	return new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "long",
		month: "long",
		day: "numeric",
		timeZone,
	}).format(new Date(scheduledAt));
}

export function promoTime(scheduledAt: Date | string, timeZone: string) {
	return new Intl.DateTimeFormat(APP_LOCALE, {
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	}).format(new Date(scheduledAt));
}

/**
 * Every placeholder's value for this club and meeting. `origin` makes the two
 * links absolute (`window.location.origin` in the browser); pass `""` where it
 * is not known yet and the lines holding a link drop until it is.
 */
export function promoValues(
	club: PromoClub,
	meeting: PromoMeeting,
	origin: string,
): PromoValues {
	const tz = club.timezone;
	return {
		club: club.name,
		date: promoDate(meeting.scheduledAt, tz),
		time: promoTime(meeting.scheduledAt, tz),
		location: meeting.location?.trim() ?? "",
		online: meeting.online ? ONLINE_TEXT : "",
		theme: meeting.theme?.trim() ?? "",
		wordOfTheDay: meeting.wordOfTheDay?.trim() ?? "",
		meetingNumber:
			meeting.meetingNumber != null ? String(meeting.meetingNumber) : "",
		meetingLink: origin
			? `${origin}${promoMeetingPath(club.slug, meeting.urlKey)}`
			: "",
		clubLink: origin ? `${origin}/club/${club.slug}` : "",
		note: meeting.promoNote?.trim() ?? "",
	};
}

/** The why-join heading every channel uses. */
export const WHY_JOIN_HEADING = "Why come?";

/**
 * The WhatsApp message: WhatsApp's own `*bold*` headline, the parts this
 * channel is set to include, and the meeting link ALONE on the last line so
 * the chat renders its preview card.
 */
export function buildWhatsAppBlast(
	template: PromoTemplate,
	values: PromoValues,
): string {
	const parts = template.channels.whatsapp;
	const blocks: string[] = [];
	const headline = renderPromoText(template.headline, values);
	if (headline) blocks.push(`*${headline}*`);
	if (parts.intro) blocks.push(renderPromoText(template.intro, values));
	if (parts.whyJoin) {
		const bullets = renderBullets(template.whyJoin, values);
		if (bullets.length > 0) {
			blocks.push(
				[WHY_JOIN_HEADING, ...bullets.map((b) => `• ${b}`)].join("\n"),
			);
		}
	}
	if (parts.callToAction) {
		blocks.push(renderPromoText(template.callToAction, values));
	}
	// Appended only when the officer's template has not already placed it —
	// twice in one message reads as a mistake.
	const placed = placesMeetingLink(
		[template.headline, ...channelTexts(template, parts)],
		values,
	);
	if (values.meetingLink && !placed) blocks.push(values.meetingLink);
	return blocks.filter(Boolean).join("\n\n");
}

/** The template texts a channel includes, per its toggles. */
function channelTexts(
	template: PromoTemplate,
	parts: PromoChannelParts,
): string[] {
	return [
		...(parts.intro ? [template.intro] : []),
		...(parts.whyJoin ? template.whyJoin : []),
		...(parts.callToAction ? [template.callToAction] : []),
	];
}

/**
 * Whether one of `texts` puts `{meetingLink}` into the output. A line holding
 * it is dropped only when the link is empty, so with a link present the
 * placeholder always renders.
 */
function placesMeetingLink(texts: string[], values: PromoValues): boolean {
	return (
		Boolean(values.meetingLink) &&
		texts.some((t) => t.includes("{meetingLink}"))
	);
}

export interface EmailBlast {
	subject: string;
	text: string;
	html: string;
}

/** The email draft: the headline is the subject, and the body ends on the
 *  meeting link. Plain text for the mail app, simple HTML for pasting. */
export function buildEmailBlast(
	template: PromoTemplate,
	values: PromoValues,
): EmailBlast {
	const parts = template.channels.email;
	const subject = renderPromoText(template.headline, values).replace(
		/\s*\n\s*/g,
		" ",
	);
	const intro = parts.intro ? renderPromoText(template.intro, values) : "";
	const bullets = parts.whyJoin ? renderBullets(template.whyJoin, values) : [];
	const cta = parts.callToAction
		? renderPromoText(template.callToAction, values)
		: "";
	// Not appended when the body already carries it (the subject does not
	// count: a link in a subject line is not one a reader can open).
	const link = placesMeetingLink(channelTexts(template, parts), values)
		? ""
		: values.meetingLink;

	const text = [
		intro,
		bullets.length > 0
			? [WHY_JOIN_HEADING, ...bullets.map((b) => `- ${b}`)].join("\n")
			: "",
		cta,
		link ? `Details and agenda: ${link}` : "",
	]
		.filter(Boolean)
		.join("\n\n");

	const para = (s: string) =>
		`<p>${s.split("\n").map(escapeHtml).join("<br>")}</p>`;
	const html = [
		intro ? para(intro) : "",
		bullets.length > 0
			? `<p><strong>${escapeHtml(WHY_JOIN_HEADING)}</strong></p><ul>${bullets
					.map((b) => `<li>${escapeHtml(b)}</li>`)
					.join("")}</ul>`
			: "",
		cta ? para(cta) : "",
		link
			? `<p>Details and agenda: <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`
			: "",
	]
		.filter(Boolean)
		.join("\n");

	return { subject, text, html };
}

/**
 * The longest `mailto:` draft this will hand to the browser. Mail clients and
 * OSes truncate or refuse long mailto URLs (Outlook on Windows around 2,000
 * characters), and a silently truncated body is worse than none — so past this
 * the sheet falls back to copying.
 */
export const MAILTO_MAX_LENGTH = 1800;

/**
 * A recipient-less `mailto:` draft carrying the subject and body, or null when
 * it would be too long to open reliably. No address is ever put in it — the
 * officer picks recipients in their own mail app — so there is no address to
 * escape (the rule `#/lib/mailto` exists for).
 */
export function promoMailtoHref(subject: string, body: string): string | null {
	const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
	return href.length <= MAILTO_MAX_LENGTH ? href : null;
}

/** What the flyer prints, already filled in. */
export interface FlyerContent {
	headline: string;
	intro: string;
	whyJoin: string[];
	callToAction: string;
	date: string;
	time: string;
	location: string;
	online: string;
	theme: string;
	meetingNumber: string;
	note: string;
	meetingLink: string;
}

export function buildFlyerContent(
	template: PromoTemplate,
	values: PromoValues,
): FlyerContent {
	const parts = template.channels.flyer;
	return {
		headline: renderPromoText(template.headline, values),
		intro: parts.intro ? renderPromoText(template.intro, values) : "",
		whyJoin: parts.whyJoin ? renderBullets(template.whyJoin, values) : [],
		callToAction: parts.callToAction
			? renderPromoText(template.callToAction, values)
			: "",
		date: values.date,
		time: values.time,
		location: values.location,
		online: values.online,
		theme: values.theme,
		meetingNumber: values.meetingNumber,
		note: values.note,
		meetingLink: values.meetingLink,
	};
}

/**
 * The meeting fields the PUBLIC `/flyer` route may carry, and nothing else — an
 * allowlist for the reason `IN_ROOM_MEETING_FIELDS` is one (#754): a column
 * added to `meetings` next year reaches no flyer until someone adds it here on
 * purpose.
 */
export const FLYER_MEETING_FIELDS = [
	"id",
	"urlKey",
	"scheduledAt",
	"location",
	"online",
	"theme",
	"wordOfTheDay",
	"meetingNumber",
	"promoNote",
] as const satisfies readonly (keyof PromoMeeting | "id")[];

export type FlyerMeeting = PromoMeeting & { id: string };

/** `meeting` narrowed to `FLYER_MEETING_FIELDS`. */
export function projectFlyerMeeting(meeting: FlyerMeeting): FlyerMeeting {
	const kept: Record<string, unknown> = {};
	for (const field of FLYER_MEETING_FIELDS) {
		if (Object.hasOwn(meeting, field)) {
			kept[field] = (meeting as unknown as Record<string, unknown>)[field];
		}
	}
	return kept as unknown as FlyerMeeting;
}

function renderBullets(bullets: string[], values: PromoValues): string[] {
	return bullets.map((b) => renderPromoText(b, values)).filter(Boolean);
}
