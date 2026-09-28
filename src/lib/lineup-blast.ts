// Lineup blast (#1024): one message listing every role slot on a meeting, in
// agenda order, with whether each is confirmed, only claimed, or still open.
//
// Pure and client-safe: no `#/db`. The meeting page's Lineup blast sheet and
// the `get_lineup_blast` MCP tool both build their text HERE, from the same
// `LineupBlastData` the server loads (footer origin included), so the button and the connector cannot
// draft different messages.
//
// ## The app drafts; a human sends
//
// Nothing here sends anything (`nudge.ts`). The output is copied by a person
// and pasted into their own WhatsApp or mail app. This is NOT the automatic
// open-role broadcast rejected in #273 / #7.
//
// ## The video-call link is never in the draft
//
// `LineupBlastData` has no field for it, by construction. The footer links
// the PUBLIC meeting page (`promoMeetingPath`), which is where that link lives
// (#731/#754). `lineup-blast.test.ts` sweeps this file and the sheet raw, so
// neither may even NAME the field, comments included.

import type { slotStatusEnum } from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { escapeHtml } from "#/lib/html-escape";
import {
	MAILTO_MAX_LENGTH,
	promoDate,
	promoMeetingPath,
	promoTime,
} from "#/lib/promo-template";

/**
 * Who may draft a lineup blast (#1024 decision "Who"): a club admin, an
 * officer (an open officer term), or the holder of THIS meeting's Toastmaster
 * slot. Nobody else, and no guest.
 *
 * The ONE statement of that rule. The server fns decide through it
 * (`lineup-blast-logic.ts`), and the meeting page shows the button only on
 * their answer. `get_lineup_blast` is NARROWER: `authorizeTokenForMeeting`
 * admits admins and officers only, so a Toastmaster who is neither has no
 * connector access. It cites this rule, but its gate is the token check.
 */
export function mayDraftLineupBlast(viewer: {
	isAdmin: boolean;
	isOfficer: boolean;
	holdsToastmasterSlot: boolean;
}): boolean {
	return viewer.isAdmin || viewer.isOfficer || viewer.holdsToastmasterSlot;
}

export const LINEUP_BLAST_REFUSED_MESSAGE =
	"Only club admins, officers and this meeting's Toastmaster can draft the lineup.";

/** A slot's state, as `slot_status` stores it. A type-only import, erased at
 *  build, so this module stays client-safe. */
export type LineupSlotStatus = (typeof slotStatusEnum.enumValues)[number];

/** One role slot, as the draft needs it — and nothing else (no contact). */
export interface LineupSlot {
	roleName: string;
	slotIndex: number;
	slotsUnordered?: boolean;
	status: LineupSlotStatus;
	assigneeName: string | null;
}

/** Everything a lineup draft is built from. Loaded by
 *  `loadPublicLineupBlastData`. */
export interface LineupBlastData {
	/**
	 * The app's own base URL (`appBaseUrl()`), chosen by the SERVER so the
	 * button and `get_lineup_blast` link the same page whatever host the
	 * browser happened to load from.
	 */
	origin: string;
	club: { name: string; slug: string; timezone: string };
	meeting: {
		id: string;
		/** The canonical public URL key (`resolveMeetingUrlKey`). */
		urlKey: string;
		scheduledAt: Date | string;
	};
	/** In agenda order: role sort order, then slot index. */
	slots: LineupSlot[];
}

export type LineupLineState = "confirmed" | "claimed" | "open";

export interface LineupLine {
	/** "Speaker 2", numbered the way the agenda numbers it (`slotLabel`). */
	label: string;
	state: LineupLineState;
	/** Null for an open slot. */
	name: string | null;
	/**
	 * What follows the name: `CONFIRMED_MARK`, "" for a claimed line (left
	 * blank, the prompt to confirm), or "🙋 Need a Timer" for an open one. The
	 * text, the HTML and the sheet's preview all print THIS, so no surface
	 * decides a line's wording for itself.
	 */
	mark: string;
}

export interface LineupBlast {
	subject: string;
	/** WhatsApp / plain text: emoji markers stand in for colour. */
	text: string;
	/** Rich text for an email: the yellow "Confirmed" highlight and red
	 *  "needed" text of the email this is modelled on. */
	html: string;
	lines: LineupLine[];
	openCount: number;
	/** "3 roles still open", or null when nothing is. */
	summary: string | null;
}

export const CONFIRMED_MARK = "✅ Confirmed";
export const OPEN_MARK = "🙋";
/** Word-processor yellow and a readable red, as inline styles: a mail client
 *  drops a `<style>` block on paste, never an inline one. */
const HIGHLIGHT_STYLE = "background-color:#ffff00";
const NEEDED_STYLE = "color:#d00000";

/** "a Timer", "an Ah-Counter". By the first letter, which is right for every
 *  standard role name. */
export function withArticle(role: string): string {
	const trimmed = role.trim();
	return /^[aeiou]/i.test(trimmed) ? `an ${trimmed}` : `a ${trimmed}`;
}

/**
 * A slot's state. An assignee is required for anything but open: a `claimed`
 * row whose holder was deleted has no name to print, so it reads as open
 * rather than as "Timer – –".
 */
function lineState(slot: LineupSlot): LineupLineState {
	const name = slot.assigneeName?.trim();
	if (!name || slot.status === "open") return "open";
	return slot.status === "confirmed" ? "confirmed" : "claimed";
}

/** The mark after a line's name. An open line asks for the role unnumbered:
 *  "Need a Speaker", not "Need a Speaker 3". */
function lineMark(state: LineupLineState, slot: LineupSlot): string {
	if (state === "confirmed") return CONFIRMED_MARK;
	if (state === "claimed") return "";
	return `${OPEN_MARK} Need ${withArticle(slot.roleName)}`;
}

export function lineupLines(slots: readonly LineupSlot[]): LineupLine[] {
	const counts = buildRoleCounts([...slots]);
	return slots.map((slot) => {
		const state = lineState(slot);
		return {
			label: slotLabel(slot, counts),
			state,
			name: state === "open" ? null : (slot.assigneeName?.trim() ?? null),
			mark: lineMark(state, slot),
		};
	});
}

export function openSummary(openCount: number): string {
	return openCount === 1
		? "1 role still open"
		: `${openCount} roles still open`;
}

/** The public meeting page. Guests can open it signed out, and it is where a
 *  role is claimed or confirmed. */
export function lineupMeetingUrl(data: LineupBlastData): string {
	return `${data.origin}${promoMeetingPath(data.club.slug, data.meeting.urlKey)}`;
}

/** One line as plain text. A claimed line ends on the bare dash, the way the
 *  source email leaves it: no "please confirm" (decision, 2026-09-28). */
function lineText(line: LineupLine): string {
	if (line.state === "open") return `${line.label} – ${line.mark}`;
	return line.mark
		? `${line.label} – ${line.name} – ${line.mark}`
		: `${line.label} – ${line.name} –`;
}

function lineHtml(line: LineupLine): string {
	const label = escapeHtml(line.label);
	if (line.state === "open") {
		return `${label} – <span style="${NEEDED_STYLE}">${escapeHtml(line.mark)}</span>`;
	}
	const head = `${label} – ${escapeHtml(line.name ?? "")} –`;
	return line.mark
		? `${head} <span style="${HIGHLIGHT_STYLE}">${escapeHtml(line.mark)}</span>`
		: head;
}

/** Build the draft. Everything it prints, the footer link included, comes
 *  from `data`, so two callers handed the same data draft the same bytes. */
export function buildLineupBlast(data: LineupBlastData): LineupBlast {
	const tz = data.club.timezone;
	const date = promoDate(data.meeting.scheduledAt, tz);
	const time = promoTime(data.meeting.scheduledAt, tz);
	const lines = lineupLines(data.slots);
	const openCount = lines.filter((l) => l.state === "open").length;
	const summary = openCount > 0 ? openSummary(openCount) : null;
	const url = lineupMeetingUrl(data);

	const heading = `🎤 ${data.club.name} lineup`;
	const when = `📅 ${date}, ${time}`;
	const subject = `${data.club.name} lineup: ${date}`;

	const text = [
		`*${heading}*\n${when}`,
		lines.map(lineText).join("\n"),
		summary ?? "",
		`Claim or confirm your role: ${url}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const html = [
		`<p><strong>${escapeHtml(heading)}</strong><br>${escapeHtml(when)}</p>`,
		lines.length > 0 ? `<p>${lines.map(lineHtml).join("<br>")}</p>` : "",
		summary
			? `<p><span style="${NEEDED_STYLE}">${escapeHtml(summary)}</span></p>`
			: "",
		`<p>Claim or confirm your role: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
	]
		.filter(Boolean)
		.join("\n");

	return { subject, text, html, lines, openCount, summary };
}

/**
 * The `mailto:` fallback, carrying the plain text. No recipient: the person
 * sending picks their own list. Null when the draft is too long for a
 * `mailto:` URL, where copying is the only honest option.
 */
export function lineupMailtoHref(blast: LineupBlast): string | null {
	const href = `mailto:?subject=${encodeURIComponent(blast.subject)}&body=${encodeURIComponent(blast.text)}`;
	return href.length <= MAILTO_MAX_LENGTH ? href : null;
}
