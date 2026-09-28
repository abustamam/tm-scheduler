// Lineup blast (#1024): one message listing every role slot on a meeting, in
// agenda order, with whether each is confirmed, only claimed, or still open.
//
// Pure and client-safe: no `#/db`. The meeting page's Lineup blast sheet and
// the `get_lineup_blast` MCP tool both build their text HERE, from the same
// `LineupBlastData` the server loads, so the button and the connector cannot
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
 * The ONE statement of that rule. The server fn (`lineup-blast-logic.ts`) and
 * the MCP tool both decide through it, and the meeting page shows the button
 * only on the server's answer, so the three cannot disagree.
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

/** A slot's state, as `slot_status` stores it. */
export type LineupSlotStatus = "open" | "claimed" | "confirmed";

/** One role slot, as the draft needs it — and nothing else (no contact). */
export interface LineupSlot {
	roleName: string;
	slotIndex: number;
	slotsUnordered?: boolean;
	status: LineupSlotStatus;
	assigneeName: string | null;
}

/** Everything a lineup draft is built from. Loaded by `loadLineupBlastData`. */
export interface LineupBlastData {
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

export function lineupLines(slots: readonly LineupSlot[]): LineupLine[] {
	const counts = buildRoleCounts([...slots]);
	return slots.map((slot) => {
		const state = lineState(slot);
		return {
			label: slotLabel(slot, counts),
			state,
			name: state === "open" ? null : (slot.assigneeName?.trim() ?? null),
		};
	});
}

/** The role an open line asks for, unnumbered: "Need a Speaker", not
 *  "Need a Speaker 3". */
function neededText(slot: LineupSlot): string {
	return `Need ${withArticle(slot.roleName)}`;
}

function openSummary(openCount: number): string {
	return openCount === 1
		? "1 role still open"
		: `${openCount} roles still open`;
}

/** The public meeting page, absolute when `origin` is known. Guests can open
 *  it signed out, and it is where a role is claimed or confirmed. */
export function lineupMeetingUrl(data: LineupBlastData, origin: string) {
	return `${origin}${promoMeetingPath(data.club.slug, data.meeting.urlKey)}`;
}

/**
 * Build the draft. `origin` makes the footer link absolute
 * (`window.location.origin` in the browser, `appBaseUrl()` on the server).
 */
export function buildLineupBlast(
	data: LineupBlastData,
	origin: string,
): LineupBlast {
	const tz = data.club.timezone;
	const date = promoDate(data.meeting.scheduledAt, tz);
	const time = promoTime(data.meeting.scheduledAt, tz);
	const lines = lineupLines(data.slots);
	const openCount = lines.filter((l) => l.state === "open").length;
	const url = lineupMeetingUrl(data, origin);

	const heading = `🎤 ${data.club.name} lineup`;
	const when = `📅 ${date}, ${time}`;
	const subject = `${data.club.name} lineup: ${date}`;

	const textLines = lines.map((line, i) => {
		const slot = data.slots[i];
		if (line.state === "confirmed") {
			return `${line.label} – ${line.name} – ${CONFIRMED_MARK}`;
		}
		// Left blank the way the source email does it: the trailing dash is the
		// prompt to confirm. No "please confirm" text (decision, 2026-09-28).
		if (line.state === "claimed") return `${line.label} – ${line.name} –`;
		return `${line.label} – ${OPEN_MARK} ${neededText(slot)}`;
	});

	const footer = `Claim or confirm your role: ${url}`;
	const text = [
		`*${heading}*\n${when}`,
		textLines.join("\n"),
		openCount > 0 ? openSummary(openCount) : "",
		footer,
	]
		.filter(Boolean)
		.join("\n\n");

	const htmlLines = lines.map((line, i) => {
		const slot = data.slots[i];
		const label = escapeHtml(line.label);
		if (line.state === "confirmed") {
			return `${label} – ${escapeHtml(line.name ?? "")} – <span style="${HIGHLIGHT_STYLE}">${escapeHtml(CONFIRMED_MARK)}</span>`;
		}
		if (line.state === "claimed") {
			return `${label} – ${escapeHtml(line.name ?? "")} –`;
		}
		return `${label} – <span style="${NEEDED_STYLE}">${escapeHtml(`${OPEN_MARK} ${neededText(slot)}`)}</span>`;
	});
	const html = [
		`<p><strong>${escapeHtml(heading)}</strong><br>${escapeHtml(when)}</p>`,
		lines.length > 0 ? `<p>${htmlLines.join("<br>")}</p>` : "",
		openCount > 0
			? `<p><span style="${NEEDED_STYLE}">${escapeHtml(openSummary(openCount))}</span></p>`
			: "",
		`<p>Claim or confirm your role: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
	]
		.filter(Boolean)
		.join("\n");

	return { subject, text, html, lines, openCount };
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
