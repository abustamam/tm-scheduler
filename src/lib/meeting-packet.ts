import { ROLE_SHEETS, type RoleSheetKey } from "#/data/role-sheets";

/**
 * What goes in a printed meeting packet, and what is ticked when the dialog
 * opens (#589).
 *
 * The packet is CHOSEN, not fixed, and the two examples that decided it are
 * worth keeping because they pull in opposite directions:
 *
 *   "we have digital voting -- we dont need ballot counter tally. But it's
 *    good to have for clubs that don't do digital voting. and our club
 *    doesn't have general evaluator yet so we don't want that either"
 *
 * Both are pages a FIXED packet would print that nobody wants — and both are
 * wanted by SOME club, so neither can simply be dropped. Hence a picker.
 *
 * But a picker whose default is "everything ticked" solves nothing: the
 * complaint is about unwanted paper, and a default nobody edits is the default
 * everybody prints. So the starting state is DERIVED from the meeting, and the
 * two rules below are exactly the two sentences above, generalised.
 *
 * Pure and client-safe so the dialog and the renderer read ONE definition of
 * what a packet can contain — the same reason the caps live in `lib/`. A
 * default computed in the dialog and a default assumed by the endpoint is two
 * definitions that agree until someone edits one.
 */

/** How many copies of the Word of the Day poster, by default.
 *
 *  Three, literally — "3 pieces of paper that have the same thing, so we can
 *  put it in various places of the meeting room". Not per-table scaling, and
 *  not a number derived from the roster: it is a property of the ROOM, which
 *  nothing in the database knows about. */
export const DEFAULT_WORD_POSTER_COPIES = 3;

/**
 * Bounds on the copy count.
 *
 * An upper bound because this renders server-side and synchronously through
 * `@react-pdf/renderer` on a route a phone can hit (ADR-0007, and the #519
 * history): copies multiply pages, so an unbounded count is an unbounded
 * render. Twelve is far above "various places of the meeting room" and far
 * below anything that costs real time.
 */
export const WORD_POSTER_COPIES = { min: 0, max: 12 } as const;

/** Every piece that can go in a packet. Role sheets by key, plus the poster. */
export type PacketPieceKey = RoleSheetKey | "word-poster";

export interface PacketPiece {
	key: PacketPieceKey;
	/** What the checkbox says. */
	title: string;
}

/**
 * The pieces on offer, in the order they print.
 *
 * Poster FIRST: it is the thing that goes on the wall before the meeting
 * starts, and whoever is collating wants it off the top of the stack rather
 * than fished out of the middle.
 */
export const PACKET_PIECES: PacketPiece[] = [
	{ key: "word-poster", title: "Word of the Day poster" },
	...ROLE_SHEETS.map((s) => ({ key: s.key as PacketPieceKey, title: s.title })),
];

/** One role this meeting runs, identified the way every other surface here
 *  identifies one. */
export interface PacketRole {
	/** `role_definitions.key`. NULL for a genuinely custom club role, and for
	 *  data predating the #368 key backfill. */
	key: string | null;
	name: string;
}

/** What the meeting knows about itself, for deriving the default selection. */
export interface PacketContext {
	/** Every role this meeting actually runs. A club that does not run a role
	 *  has no slot for it. */
	roles: PacketRole[];
	/** True when a digital vote session exists for this meeting — i.e. the club
	 *  is voting on phones rather than on paper. */
	usesDigitalVoting: boolean;
	/** True when the meeting has a Word of the Day to print. */
	hasWord: boolean;
}

/**
 * Which role each sheet belongs to. A sheet is ticked when the club runs its
 * role, so a club with no General Evaluator never sees GE notes ticked —
 * without configuring anything, which is the point.
 *
 * `general-evaluator` and `ballot-counter` are the two that motivated this.
 * The other three map to the functionaries almost every club runs, so in
 * practice they are ticked and the derivation is invisible — which is the
 * correct outcome, not a sign it is doing nothing.
 */
const SHEET_ROLE: Record<RoleSheetKey, { key: string; name: string }> = {
	timer: { key: "timer", name: "Timer" },
	"ah-counter": { key: "ah_counter", name: "Ah-Counter" },
	grammarian: { key: "grammarian", name: "Grammarian" },
	"ballot-counter": { key: "vote_counter", name: "Vote Counter" },
	"general-evaluator": {
		key: "general_evaluator",
		name: "General Evaluator",
	},
};

/**
 * Does this club run the role a sheet belongs to?
 *
 * KEY WHEN THERE IS ONE, NAME OTHERWISE — the same rule `matchesRole` uses in
 * `agenda-runsheet.ts`, and not an implementation detail worth diverging on. A
 * key-only match looks correct and quietly fails for two real populations: a
 * genuinely custom club role, and any role definition predating the #368 key
 * backfill. Both have `key: null`, and a club whose Timer is one of them would
 * open the packet dialog with the Timer's log UNTICKED — the derivation
 * silently deciding they do not run a Timer.
 */
function clubRunsRole(roles: readonly PacketRole[], sheet: RoleSheetKey) {
	const want = SHEET_ROLE[sheet];
	return roles.some((r) =>
		r.key != null
			? r.key === want.key
			: r.name.toLowerCase() === want.name.toLowerCase(),
	);
}

/**
 * The starting selection for a meeting.
 *
 * Two rules, both from the deciding comment:
 *
 * 1. A role's sheet is ON when the club runs that role this meeting.
 * 2. The Ballot Counter tally is OFF when the meeting uses digital voting,
 *    even if the club runs a Vote Counter — the paper tally is what digital
 *    voting replaces. Rule 2 overrides rule 1, and only in that direction:
 *    a club with no Vote Counter role does not get the sheet back by not
 *    using digital voting.
 *
 * The poster is on whenever there is a word to print, since a poster of
 * nothing is a blank sheet.
 *
 * This picks the STARTING state, never the final one — everything stays
 * overridable, so a club that wants a spare blank tally sheet ticks it.
 */
export function defaultPacketSelection(ctx: PacketContext): PacketPieceKey[] {
	const out: PacketPieceKey[] = [];
	if (ctx.hasWord) out.push("word-poster");
	for (const sheet of ROLE_SHEETS) {
		if (!clubRunsRole(ctx.roles, sheet.key)) continue;
		if (sheet.key === "ballot-counter" && ctx.usesDigitalVoting) continue;
		out.push(sheet.key);
	}
	return out;
}

/** Clamp a requested copy count into the render-safe range. */
export function clampPosterCopies(n: number): number {
	if (!Number.isFinite(n)) return DEFAULT_WORD_POSTER_COPIES;
	return Math.min(
		WORD_POSTER_COPIES.max,
		Math.max(WORD_POSTER_COPIES.min, Math.floor(n)),
	);
}

/**
 * How many PAGES a selection produces — the packet's whole render cost, since
 * every piece is exactly one page.
 *
 * Exported so the endpoint can bound the work before doing it, rather than
 * discovering the cost by paying it.
 */
export function packetPageCount(
	selection: readonly PacketPieceKey[],
	posterCopies: number,
): number {
	const sheets = selection.filter((k) => k !== "word-poster").length;
	const posters = selection.includes("word-poster")
		? clampPosterCopies(posterCopies)
		: 0;
	return sheets + posters;
}
