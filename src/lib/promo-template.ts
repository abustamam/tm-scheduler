// Marketing blasts (#931): the club's ONE blast template, the placeholder
// renderer that fills it in from a meeting, and the three outputs built from
// it — a WhatsApp message, an email draft and a flyer.
//
// Pure and client-safe: no `#/db`. The Promote sheet, the club settings editor
// and the public `/flyer` route all read this module, and so does
// `promo-logic.ts` on the server, so the template's shape and its default are
// stated once.
//
// ## One composer
//
//   template text ──renderPromoLines──▶ PromoLine[]   (every line, kept or dropped)
//        │
//        └──build*Blocks──▶ PromoBlock[]   (channel toggles, headings, bullets, footer)
//                │
//                ├──build*Blast / buildFlyerContent──▶ the string a human sends
//                └──────────────────────────────────▶ the live preview (#1537)
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
// the public meeting page — which is where the link lives (#731/#754), one
// click from the RSVP and agenda pages a blast links to. The
// #731 source guard sweeps this file raw, so it must not
// even NAME the field, comments included.

import { z } from "zod";
import type { meetingStatusEnum } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { APP_LOCALE } from "#/lib/format";
import { escapeHtml } from "#/lib/html-escape";

export type PromoVariableGroup = "meeting" | "links" | "club" | "extras";

/** Every variable, in menu order: groups in this order, rows in this order. The ONE list:
 *  checked against a shape whose `key` is a plain string (so the declaration is not circular),
 *  then the key union, the row type and the key array are all derived from it. */
export const PROMO_VARIABLES = [
	{
		key: "date",
		label: "Date",
		description: "The meeting day, e.g. Tuesday, November 18",
		group: "meeting",
	},
	{
		key: "time",
		label: "Time",
		description: "Start time, in the club's time zone",
		group: "meeting",
	},
	{
		key: "location",
		label: "Location",
		description: "The venue, as written on the meeting",
		group: "meeting",
	},
	{
		key: "theme",
		label: "Theme",
		description: "The meeting's theme, when one is set",
		group: "meeting",
	},
	{
		key: "wordOfTheDay",
		label: "Word of the Day",
		description: "The word set on the meeting",
		group: "meeting",
	},
	{
		key: "meetingNumber",
		label: "Meeting number",
		description: "The club's running count for this meeting",
		group: "meeting",
	},
	{
		key: "meetingLink",
		label: "Meeting link",
		description: "The public meeting page, with the agenda",
		group: "links",
	},
	{
		key: "rsvpLink",
		label: "RSVP link",
		description: "The one-tap RSVP page for this meeting",
		group: "links",
	},
	{
		key: "agendaLink",
		label: "Agenda link",
		description: "The public agenda page for this meeting",
		group: "links",
	},
	{
		key: "clubLink",
		label: "Club link",
		description: "Your club's public page",
		group: "links",
	},
	{
		key: "club",
		label: "Club name",
		description: "Your club's name",
		group: "club",
	},
	{
		key: "note",
		label: "Note",
		description: "The promo note written on the meeting, when there is one",
		group: "extras",
	},
	{
		key: "online",
		label: "Also online",
		description:
			"A line saying the meeting is also online, pointing readers at the meeting page",
		group: "extras",
	},
] as const satisfies readonly {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly group: PromoVariableGroup;
}[];

export type PromoPlaceholder = (typeof PROMO_VARIABLES)[number]["key"];
export type PromoVariable = (typeof PROMO_VARIABLES)[number];

/** Every placeholder a template may use, and nothing else. Derived; an array,
 *  not a tuple: no caller needs the tuple. */
export const PROMO_PLACEHOLDERS: readonly PromoPlaceholder[] =
	PROMO_VARIABLES.map((v) => v.key);

export const PROMO_VARIABLE_GROUPS: readonly {
	id: PromoVariableGroup;
	label: string;
}[] = [
	{ id: "meeting", label: "Meeting" },
	{ id: "links", label: "Links" },
	{ id: "club", label: "Club" },
	{ id: "extras", label: "Extras" },
];

const VARIABLE_BY_KEY: ReadonlyMap<string, PromoVariable> = new Map(
	PROMO_VARIABLES.map((v) => [v.key, v]),
);

export function promoVariable(key: PromoPlaceholder): PromoVariable {
	return VARIABLE_BY_KEY.get(key) as PromoVariable;
}

/** The resolved value of every placeholder. Empty string = no value, and a
 *  line holding an empty placeholder is DROPPED rather than rendered as
 *  "Theme: ". */
export type PromoValues = Record<PromoPlaceholder, string>;

const PLACEHOLDER_SET: ReadonlySet<string> = new Set(PROMO_PLACEHOLDERS);

export function isPromoPlaceholder(name: string): name is PromoPlaceholder {
	return PLACEHOLDER_SET.has(name);
}

/** The parts of the template a channel may include or leave out. The headline
 *  is always included, and so are the links each channel adds after the parts
 *  (`linkFooter` for WhatsApp and email, the QR code on the flyer). */
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
	 *  sheet warns past it, it never truncates. 700, not 600, since the
	 *  message ends on two links (RSVP and agenda) rather than one: the
	 *  default with every optional line filled measures 662 in the tests. A
	 *  club with a long name and slug still goes past it, and gets the warning. */
	whatsappSoft: 700,
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

/** A `{...}` token: anything but braces and line breaks between the braces.
 *  `isPromoPlaceholder` still decides whether it is known. */
const TOKEN = /\{([^{}\n]+)\}/g;

/** Normalise for matching: lowercase, drop everything but [a-z0-9]. */
export function normalizePromoName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Stored → editor: `{wordOfTheDay}` → `{Word of the Day}`.
 *
 * Handles what the DATABASE HOLDS, so it converts exact canonical keys only.
 * A stored `{DATE}` or `{Date!}` renders as a literal today; it is left exactly
 * as typed, so the editor shows it as an unknown token with a "Did you mean
 * Date?" fix and the officer decides. Idempotent: a label is never a key.
 */
export function toEditorText(stored: string): string {
	return stored.replace(TOKEN, (whole, inner: string) =>
		isPromoPlaceholder(inner) ? `{${promoVariable(inner).label}}` : whole,
	);
}

function matchTypedVariable(inner: string): PromoVariable | null {
	if (isPromoPlaceholder(inner)) return promoVariable(inner);
	const byLabel = PROMO_VARIABLES.find((v) => v.label === inner);
	if (byLabel) return byLabel;
	// A name with a space in it could never have rendered as a literal
	// placeholder, so it is matched leniently (case, spacing, punctuation).
	// A single word must be the exact key or label: `{DATE}` and `{Date!}` are
	// what a stored template may hold as a literal, and stay the officer's call.
	if (!/\s/.test(inner)) return null;
	const n = normalizePromoName(inner);
	return (
		PROMO_VARIABLES.find(
			(v) =>
				normalizePromoName(v.label) === n || normalizePromoName(v.key) === n,
		) ?? null
	);
}

/**
 * Editor → stored: `{Word of the Day}`, `{word of the day}`,
 * `{ Word  of the Day }` and `{wordOfTheDay}` all → `{wordOfTheDay}`. Unknown
 * tokens untouched.
 *
 * Handles what the officer TYPED. A name containing whitespace matches a
 * variable's label or key case-, space- and punctuation-insensitively; a
 * single-word token must be the exact key or label (see `toEditorText` for why
 * `{DATE}` is not converted). Idempotent.
 */
export function toStoredText(editor: string): string {
	return editor.replace(TOKEN, (whole, inner: string) => {
		const v = matchTypedVariable(inner);
		return v ? `{${v.key}}` : whole;
	});
}

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
	return collapseLines(renderPromoLines(text, values));
}

export interface PromoLine {
	/** The template line as written (stored form). */
	source: string;
	/** The rendered line; "" when dropped. */
	text: string;
	/** The first known placeholder on the line whose value was empty, or null when the line is kept. */
	droppedBy: PromoPlaceholder | null;
}

/** One entry per source line, nothing collapsed or trimmed. */
export function renderPromoLines(
	text: string,
	values: PromoValues,
): PromoLine[] {
	return text.split(/\r?\n/).map((source) => {
		let droppedBy = null as PromoPlaceholder | null;
		const rendered = source.replace(TOKEN, (whole, name: string) => {
			if (!isPromoPlaceholder(name)) return whole;
			const value = values[name].trim();
			if (!value && droppedBy === null) droppedBy = name;
			return value;
		});
		return {
			source,
			text: droppedBy === null ? rendered.trimEnd() : "",
			droppedBy,
		};
	});
}

/** The kept lines, runs of blank lines collapsed to one, trimmed. */
function collapseLines(lines: readonly PromoLine[]): string {
	const kept: string[] = [];
	for (const line of lines) {
		if (line.droppedBy !== null) continue;
		if (!line.text.trim() && kept.length > 0 && !kept[kept.length - 1].trim()) {
			continue;
		}
		kept.push(line.text);
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

/** What `{online}` says. Points at the meeting page, never at the room; the
 *  RSVP and agenda pages a blast links to both link to it. */
export const ONLINE_TEXT = "Also online: the link is on the meeting page";

/** The public meeting page's path. Guests can open it signed out. */
export function promoMeetingPath(clubSlug: string, urlKey: string): string {
	return `/club/${clubSlug}/meeting/${urlKey}`;
}

/** The one-tap RSVP page under a meeting page's URL or path (#1442). The ONE
 *  place `/rsvp` is appended: the blast, the officer nudge and the page's own
 *  sign-in redirect all build it here. */
export function rsvpPageUrl(meetingUrlOrPath: string): string {
	return `${meetingUrlOrPath}/rsvp`;
}

/** The public RSVP page's path (`club.$clubId_.meeting.$meetingId.rsvp.tsx`). */
export function promoRsvpPath(clubSlug: string, urlKey: string): string {
	return rsvpPageUrl(promoMeetingPath(clubSlug, urlKey));
}

/** The public agenda page's path (`club.$clubId_.meeting.$meetingId.agenda.tsx`). */
export function promoAgendaPath(clubSlug: string, urlKey: string): string {
	return `${promoMeetingPath(clubSlug, urlKey)}/agenda`;
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
 * Every placeholder's value for this club and meeting. `origin` makes the
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
		rsvpLink: origin
			? `${origin}${promoRsvpPath(club.slug, meeting.urlKey)}`
			: "",
		agendaLink: origin
			? `${origin}${promoAgendaPath(club.slug, meeting.urlKey)}`
			: "",
		clubLink: origin ? `${origin}/club/${club.slug}` : "",
		note: meeting.promoNote?.trim() ?? "",
	};
}

/** The why-join heading every channel uses. */
export const WHY_JOIN_HEADING = "Why come?";

const WHATSAPP_BULLET = "• ";
const EMAIL_BULLET = "- ";

/** One part of a channel's output, as lines (kept and dropped alike). */
export interface PromoBlock {
	kind: "headline" | "intro" | "whyJoin" | "callToAction" | "footer";
	lines: PromoLine[];
}

const keptLine = (text: string, source = text): PromoLine => ({
	source,
	text,
	droppedBy: null,
});

/** The text a block contributes to a blast: its kept lines, blank runs
 *  collapsed, trimmed. */
function blockText(block: PromoBlock | undefined): string {
	return block ? collapseLines(block.lines) : "";
}

/** The why-join lines: each bullet's lines with `marker` on the kept ones, and
 *  `heading` first — but only when some bullet is kept, so an all-dropped list
 *  never leaves a heading over nothing. Dropped lines stay, for the preview. */
function whyJoinLines(
	bullets: readonly string[],
	values: PromoValues,
	marker: string,
	heading: boolean,
): PromoLine[] {
	const lines = bullets.flatMap((b) =>
		renderPromoLines(b, values).map((l) =>
			l.droppedBy === null && l.text.trim()
				? { ...l, text: `${marker}${l.text}` }
				: l,
		),
	);
	const anyKept = lines.some((l) => l.droppedBy === null && l.text.trim());
	return heading && anyKept ? [keptLine(WHY_JOIN_HEADING), ...lines] : lines;
}

/** Whether `text` carries `url` as a whole link, not as the front of a longer
 *  one: the meeting page's URL is the start of the RSVP page's. */
function carriesUrl(text: string, url: string): boolean {
	if (!url) return false;
	let i = text.indexOf(url);
	while (i !== -1) {
		const next = text[i + url.length];
		if (next === undefined || !/[\w/%-]/.test(next)) return true;
		i = text.indexOf(url, i + 1);
	}
	return false;
}

/**
 * The RSVP and agenda links appended after the template, minus any the KEPT
 * lines already carry — twice in one message reads as a mistake. A kept line
 * carrying the meeting link has chosen its own link (that page links to both),
 * so nothing is appended at all.
 *
 * Decided from what was rendered, not from the template source: a line that
 * places `{meetingLink}` but drops (an empty placeholder beside it) places
 * nothing, and the footer must still give the reader a link.
 */
function footerBlock(
	kept: readonly PromoBlock[],
	values: PromoValues,
): PromoBlock {
	const text = kept
		.flatMap((b) => b.lines)
		.filter((l) => l.droppedBy === null)
		.map((l) => l.text)
		.join("\n");
	const lines: PromoLine[] = [];
	if (!carriesUrl(text, values.meetingLink)) {
		if (values.rsvpLink && !carriesUrl(text, values.rsvpLink)) {
			lines.push(keptLine(`RSVP: ${values.rsvpLink}`, "RSVP: {rsvpLink}"));
		}
		if (values.agendaLink && !carriesUrl(text, values.agendaLink)) {
			lines.push(
				keptLine(`Agenda: ${values.agendaLink}`, "Agenda: {agendaLink}"),
			);
		}
	}
	return { kind: "footer", lines };
}

/** The parts a channel includes, in order, as blocks (no footer). */
function partBlocks(
	template: PromoTemplate,
	parts: PromoChannelParts,
	values: PromoValues,
	whyJoin: { marker: string; heading: boolean },
): PromoBlock[] {
	const blocks: PromoBlock[] = [];
	if (parts.intro) {
		blocks.push({
			kind: "intro",
			lines: renderPromoLines(template.intro, values),
		});
	}
	if (parts.whyJoin) {
		const lines = whyJoinLines(
			template.whyJoin,
			values,
			whyJoin.marker,
			whyJoin.heading,
		);
		if (lines.length > 0) blocks.push({ kind: "whyJoin", lines });
	}
	if (parts.callToAction) {
		blocks.push({
			kind: "callToAction",
			lines: renderPromoLines(template.callToAction, values),
		});
	}
	return blocks;
}

const withFooter = (
	counted: readonly PromoBlock[],
	blocks: PromoBlock[],
	values: PromoValues,
): PromoBlock[] => {
	const footer = footerBlock(counted, values);
	return footer.lines.length > 0 ? [...blocks, footer] : blocks;
};

/**
 * The WhatsApp message as blocks: the headline, the parts this channel is set
 * to include (bullets marked `•`, under `WHY_JOIN_HEADING`), and the RSVP and
 * agenda footer last. The headline counts when deciding the footer.
 */
export function buildWhatsAppBlocks(
	template: PromoTemplate,
	values: PromoValues,
): PromoBlock[] {
	const headline: PromoBlock = {
		kind: "headline",
		lines: renderPromoLines(template.headline, values),
	};
	const parts = partBlocks(template, template.channels.whatsapp, values, {
		marker: WHATSAPP_BULLET,
		heading: true,
	});
	const body = [headline, ...parts];
	return withFooter(body, body, values);
}

/**
 * The WhatsApp message: WhatsApp's own `*bold*` headline, the parts this
 * channel is set to include, and the RSVP and agenda links last.
 */
export function buildWhatsAppBlast(
	template: PromoTemplate,
	values: PromoValues,
): string {
	return buildWhatsAppBlocks(template, values)
		.map((b) => {
			const text = blockText(b);
			return b.kind === "headline" && text ? `*${text}*` : text;
		})
		.filter(Boolean)
		.join("\n\n");
}

export interface EmailBlast {
	subject: string;
	text: string;
	html: string;
}

/**
 * The email as blocks. `subject` is the headline's lines (so a dropped headline
 * keeps its `droppedBy`); the subject string is their kept text joined with
 * spaces. The subject does not count as placing a link when deciding the
 * footer: a link in a subject line is not one a reader can open.
 */
export function buildEmailBlocks(
	template: PromoTemplate,
	values: PromoValues,
): { subject: PromoLine[]; blocks: PromoBlock[] } {
	const body = partBlocks(template, template.channels.email, values, {
		marker: EMAIL_BULLET,
		heading: true,
	});
	return {
		subject: renderPromoLines(template.headline, values),
		blocks: withFooter(body, body, values),
	};
}

/** The email draft: the headline is the subject, and the body ends on the
 *  RSVP and agenda links. Plain text for the mail app, simple HTML for
 *  pasting. */
export function buildEmailBlast(
	template: PromoTemplate,
	values: PromoValues,
): EmailBlast {
	const { subject: subjectLines, blocks } = buildEmailBlocks(template, values);
	const subject = collapseLines(subjectLines).replace(/\s*\n\s*/g, " ");
	const text = blocks.map(blockText).filter(Boolean).join("\n\n");

	const para = (s: string) =>
		`<p>${s.split("\n").map(escapeHtml).join("<br>")}</p>`;
	const html = blocks
		.map((b) => {
			const t = blockText(b);
			if (!t) return "";
			if (b.kind === "whyJoin") {
				const bullets = b.lines
					.filter(
						(l) => l.droppedBy === null && l.text.startsWith(EMAIL_BULLET),
					)
					.map((l) => l.text.slice(EMAIL_BULLET.length));
				return `<p><strong>${escapeHtml(WHY_JOIN_HEADING)}</strong></p><ul>${bullets
					.map((x) => `<li>${escapeHtml(x)}</li>`)
					.join("")}</ul>`;
			}
			if (b.kind === "footer") {
				return `<p>${b.lines
					.map((l) => {
						const at = l.text.indexOf(": ");
						const url = l.text.slice(at + 2);
						return `${l.text.slice(0, at)}: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
					})
					.join("<br>")}</p>`;
			}
			return para(t);
		})
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

/** The flyer's four template fields (headline, intro, whyJoin, callToAction)
 *  per its toggles. Bullets are plain lines: the flyer draws its own heading
 *  and markers. No footer: the flyer carries a QR code instead. */
export function buildFlyerBlocks(
	template: PromoTemplate,
	values: PromoValues,
): PromoBlock[] {
	return [
		{ kind: "headline", lines: renderPromoLines(template.headline, values) },
		...partBlocks(template, template.channels.flyer, values, {
			marker: "",
			heading: false,
		}),
	];
}

export function buildFlyerContent(
	template: PromoTemplate,
	values: PromoValues,
): FlyerContent {
	const blocks = buildFlyerBlocks(template, values);
	const block = (kind: PromoBlock["kind"]) =>
		blocks.find((b) => b.kind === kind);
	return {
		headline: blockText(block("headline")),
		intro: blockText(block("intro")),
		whyJoin: (block("whyJoin")?.lines ?? [])
			.filter((l) => l.droppedBy === null && l.text.trim())
			.map((l) => l.text),
		callToAction: blockText(block("callToAction")),
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
 *
 * `status` is listed on purpose (#1057): a cancelled meeting's flyer is marked,
 * and the mark is read off the SAME row the flyer is drawn from, so it can
 * never disagree with it or fail open when a second lookup does.
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
	"status",
] as const satisfies readonly (keyof PublicFlyerMeeting)[];

export type FlyerMeeting = PromoMeeting & { id: string };

/** A meeting's lifecycle status, as the schema states it. */
export type FlyerMeetingStatus = (typeof meetingStatusEnum.enumValues)[number];

/** What the PUBLIC `/flyer` reader serves: a `FlyerMeeting` plus its status
 *  (#1057). The Promote sheet's `FlyerMeeting`s carry no status. */
export type PublicFlyerMeeting = FlyerMeeting & { status: FlyerMeetingStatus };

/** `meeting` narrowed to `FLYER_MEETING_FIELDS`. */
export function projectFlyerMeeting(
	meeting: PublicFlyerMeeting,
): PublicFlyerMeeting {
	const kept: Record<string, unknown> = {};
	for (const field of FLYER_MEETING_FIELDS) {
		if (Object.hasOwn(meeting, field)) {
			kept[field] = (meeting as unknown as Record<string, unknown>)[field];
		}
	}
	return kept as unknown as PublicFlyerMeeting;
}

/** Optimal string alignment distance: insert, delete, substitute and adjacent
 *  transposition each cost 1. Private: nothing else here needs one. */
function editDistance(a: string, b: string): number {
	const d: number[][] = [];
	for (let i = 0; i <= a.length; i++) {
		d[i] = [i];
	}
	for (let j = 0; j <= b.length; j++) d[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(
				d[i - 1][j] + 1,
				d[i][j - 1] + 1,
				d[i - 1][j - 1] + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
			}
		}
	}
	return d[a.length][b.length];
}

/** Lowercased alphanumeric words, split on spaces, `_`, `-`, `.` and camelCase. */
function nameWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[\s_.-]+/)
		.map((w) => normalizePromoName(w))
		.filter(Boolean);
}

function isSubsequence(needle: readonly string[], hay: readonly string[]) {
	let i = 0;
	for (const w of hay) if (w === needle[i]) i++;
	return i === needle.length;
}

/**
 * For an UNKNOWN token's inner text, the variable the officer most likely
 * meant, or null. Tiers, first hit wins; within a tier the closest, then the
 * earliest in table order:
 *
 *   1. edit distance to a normalised key or label (1 for names of 4 characters
 *      or fewer, 2 otherwise): `daet` → Date;
 *   2. the name's words are a subsequence of exactly one label's words:
 *      `wordOfDay` → Word of the Day;
 *   3. the name (4+ characters) and exactly one variable's key or label contain
 *      one another: `rsvp` → RSVP link.
 */
export function suggestPlaceholder(name: string): PromoVariable | null {
	const n = normalizePromoName(name);
	if (!n) return null;
	const names = (v: PromoVariable) => [
		normalizePromoName(v.key),
		normalizePromoName(v.label),
	];

	const max = n.length <= 4 ? 1 : 2;
	let best: PromoVariable | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const v of PROMO_VARIABLES) {
		const d = Math.min(...names(v).map((c) => editDistance(n, c)));
		if (d <= max && d < bestDistance) {
			best = v;
			bestDistance = d;
		}
	}
	if (best) return best;

	const words = nameWords(name);
	if (words.length > 0) {
		const hits = PROMO_VARIABLES.filter((v) =>
			isSubsequence(words, nameWords(v.label)),
		);
		if (hits.length === 1) return hits[0];
	}

	if (n.length >= 4) {
		const hits = PROMO_VARIABLES.filter((v) =>
			names(v).some((c) => c.includes(n) || (c.length >= 4 && n.includes(c))),
		);
		if (hits.length === 1) return hits[0];
	}
	return null;
}

/** Whether two templates say the same thing, field by field and independent of
 *  key order (a JSON-string compare is not). */
export function templatesEqual(a: PromoTemplate, b: PromoTemplate): boolean {
	return (
		a.headline === b.headline &&
		a.intro === b.intro &&
		a.callToAction === b.callToAction &&
		a.whyJoin.length === b.whyJoin.length &&
		a.whyJoin.every((x, i) => x === b.whyJoin[i]) &&
		PROMO_CHANNELS.every((c) =>
			PROMO_PARTS.every((p) => a.channels[c][p] === b.channels[c][p]),
		)
	);
}

/** A meeting with every value filled, for a club with nothing scheduled: the
 *  calendar date 14 days after `now`'s date in `timeZone` (calendar arithmetic,
 *  so a DST change never shifts it by an hour), at 19:00 local time. */
export function examplePromoMeeting(now: Date, timeZone: string): FlyerMeeting {
	const today = utcToZonedWallTime(now, timeZone).slice(0, 10);
	const day = new Date(`${today}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + 14);
	const date = day.toISOString().slice(0, 10);
	return {
		id: "example",
		urlKey: "example",
		scheduledAt: zonedWallTimeToUtc(`${date}T19:00`, timeZone).toISOString(),
		location: "Community Hall, Room 2",
		online: true,
		theme: "Gratitude",
		wordOfTheDay: "Serendipity",
		meetingNumber: 412,
		promoNote: "Open house: bring a friend",
	};
}
