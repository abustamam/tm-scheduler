/**
 * `upsert_agendas`' PURE half (#808) — the parts of the agenda confirm flow with
 * no database and no request in them.
 *
 * The tool writes nothing. It plans a set of club-local dates against live data,
 * stores what was ASKED as a pending plan, and hands back a link; an admin opens
 * that link signed in, reads the per-date diff, and applies it. The planner lives
 * in `src/server/agenda-plan.ts` and the page in
 * `src/routes/_authed/agenda-plan.$planId.tsx`; what is HERE is what both of them
 * and the MCP tool must agree on — the field set, the tri-state normalisation,
 * the diff, and the two refusal sentences whose difference is load-bearing.
 *
 * Client-safe on purpose: the confirm route imports this, so it must pull in no
 * `node:` builtin and no database module. That is why `agendaPlanConfirmUrl`
 * takes the origin as an argument rather than reading `BETTER_AUTH_URL` here —
 * the server passes `appBaseUrl()`, whose fallback stays declared in exactly one
 * place (`src/lib/unsubscribe-token.ts`). Same rule, same reason, as
 * `src/lib/guest-book-pending.ts`.
 */

/**
 * The meeting-meta columns this tool may write, listed ONCE so the diff, the
 * create insert and the patch call cannot disagree about the set.
 *
 * `notes` and `reminders` are deliberately absent although
 * `applyMeetingMetaPatch` owns them. `reminders` feeds the reminder poller,
 * which SENDS EMAIL to members — an LLM proposing changes to what lands in
 * someone's inbox is a different risk class from proposing a theme — and
 * `notes` is internal prose that renders on printed agendas. Neither is worth
 * the blast radius on this tool's first release (#808). Do not add them without
 * reopening that decision.
 *
 * `location` is here and `time` is not: both come from the club's recurrence
 * rule on a create, but `location` is ordinary meta a later call may also change
 * on an existing meeting, while moving a meeting is a reschedule with its own
 * authorization (ADR-0010) and is out of scope.
 */
export const AGENDA_META_FIELDS = [
	"theme",
	"wordOfTheDay",
	"wodDefinition",
	"wodExample",
	"location",
] as const;

export type AgendaMetaField = (typeof AGENDA_META_FIELDS)[number];

/**
 * One date as the caller named it, and as the pending row stores it.
 *
 * Every meta field is a TRI-STATE and the distinction is the whole interface,
 * exactly as `MeetingMetaPatchInput` states it one layer down:
 *
 *   omitted / `undefined`   leave the stored value alone
 *   `null` or blank         clear it
 *   a value                 store it, trimmed
 *
 * Stored rather than resolved, because a pending row is re-planned on every
 * render and inside the apply transaction: storing "set the theme to Harvest"
 * survives a meeting being rescheduled under it, where storing a meeting id
 * would not.
 */
export interface AgendaEntry {
	/** Club-local `YYYY-MM-DD`. */
	date: string;
	/** Club-local `HH:MM`. Only ever read on a create; see `plan()`. */
	time?: string;
	theme?: string | null;
	wordOfTheDay?: string | null;
	wodDefinition?: string | null;
	wodExample?: string | null;
	location?: string | null;
}

/**
 * What a tri-state field means once normalised: `undefined` is "not mentioned",
 * `null` is "clear it", a string is "store this".
 *
 * Blank and whitespace-only collapse to `null` alongside an explicit null — the
 * same rule `applyMeetingMetaPatch` applies to the same columns, restated here
 * so the PLAN shows what the write will actually do rather than what was typed.
 * A plan that displayed `theme: — → "  "` and then stored null would be a diff
 * the reader could not have predicted from.
 */
export function normalizeMetaValue(
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) return undefined;
	return value?.trim() || null;
}

/** One field the apply would move, in the form the page renders. */
export interface AgendaFieldChange {
	field: AgendaMetaField;
	/** What is stored now. Null on a create, and for a column that is empty. */
	from: string | null;
	to: string | null;
}

/**
 * The fields an entry would actually CHANGE on an existing meeting.
 *
 * Only the ones that move: a field the caller sent whose normalised value
 * already equals what is stored contributes nothing, so an `update` line shows
 * the diff rather than everything the call happened to mention (AC2). That is
 * also what keeps the patch SPARSE — `applyMeetingMetaPatch` is sent only these
 * fields, so no column this tool was not asked about is named in the SQL.
 */
export function agendaFieldChanges(
	entry: AgendaEntry,
	stored: Record<AgendaMetaField, string | null>,
): AgendaFieldChange[] {
	const changes: AgendaFieldChange[] = [];
	for (const field of AGENDA_META_FIELDS) {
		const next = normalizeMetaValue(entry[field]);
		if (next === undefined) continue;
		const from = stored[field];
		if (next === from) continue;
		changes.push({ field, from, to: next });
	}
	return changes;
}

/**
 * The meta a CREATE writes, as `insertMeetingWithSlots` takes it.
 *
 * `location` is excluded because it is not meta on the insert — it is a column
 * `NewMeeting` already carries, defaulted from the club's recurrence rule when
 * the entry does not name one. Splitting it out here is what lets the create
 * branch pass one object through without the caller re-deciding the split.
 */
export function agendaCreateMeta(entry: AgendaEntry): {
	theme: string | null;
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
} {
	return {
		theme: normalizeMetaValue(entry.theme) ?? null,
		wordOfTheDay: normalizeMetaValue(entry.wordOfTheDay) ?? null,
		wodDefinition: normalizeMetaValue(entry.wodDefinition) ?? null,
		wodExample: normalizeMetaValue(entry.wodExample) ?? null,
	};
}

/** Human labels for the five fields, for the diff table's first column. */
export const AGENDA_FIELD_LABEL: Record<AgendaMetaField, string> = {
	theme: "Theme",
	wordOfTheDay: "Word of the Day",
	wodDefinition: "Definition",
	wodExample: "Example",
	location: "Location",
};

/**
 * What a re-opened link says when the plan was applied BEFORE this call started
 * — the cheap, unlocked pre-check's sentence.
 *
 * Declared beside its sibling because the pair carries a constraint neither
 * declaration can state alone: the two must DIFFER. #806 shipped them identical
 * twice, and that made the locked double-apply guard untestable — the pre-check
 * short-circuits every serial case, so an assertion matching both sentences
 * passed without the locked guard ever running. `agenda-upsert.test.ts` asserts
 * they are not equal.
 */
export const AGENDA_ALREADY_APPLIED_MESSAGE =
	"These agendas have already been saved.";

/**
 * What the LOCKED double-apply guard says: another click saved this plan while
 * this one waited on the club lock. Only that guard says this (AC10, AC13).
 */
export const AGENDA_APPLIED_WHILE_OPEN_MESSAGE =
	"These agendas were saved while this page was open.";

/** What the pre-check says for a link that had already expired. */
export const AGENDA_EXPIRED_MESSAGE = "That confirmation link has expired.";

/** What the locked guard says for a link that expired during the lock wait. */
export const AGENDA_EXPIRED_IN_LOCK_MESSAGE =
	"That confirmation link expired while this page was open. Ask for the dates again.";

/** What a reader says when a stored payload cannot be read. */
export const AGENDA_UNREADABLE_MESSAGE =
	"This plan was stored by an older version of GavelUp and can no longer be read. Ask for the dates again.";

/** Where the confirm page lives. One spelling, shared by the link and the route. */
export function agendaPlanConfirmPath(pendingId: string): string {
	return `/agenda-plan/${pendingId}`;
}

/**
 * The absolute link a preview hands back.
 *
 * ABSOLUTE, not relative: the caller is an LLM in someone else's client, and a
 * path alone is not something a person can open.
 */
export function agendaPlanConfirmUrl(
	origin: string,
	pendingId: string,
): string {
	return `${origin.replace(/\/+$/, "")}${agendaPlanConfirmPath(pendingId)}`;
}

/**
 * What the LOCKED re-check says when a meeting was completed between the page
 * rendering and the click (AC13).
 *
 * The plan-time sentence is `MEETING_LOCKED_BLOCKING_MESSAGE`
 * (`#/lib/assign-roles-plan`), imported rather than re-spelled: one fact about
 * the meeting lock, one sentence, wherever the tool that first declared it
 * happens to live. This one is DIFFERENT on purpose and by the same rule as
 * `AGENDA_APPLIED_WHILE_OPEN_MESSAGE` — the plan-time refusal short-circuits
 * every serial case, so a test can only prove the in-lock check fires if the
 * in-lock check says something only it says. `agenda-upsert.test.ts` asserts
 * they are not equal.
 */
export const AGENDA_MEETING_LOCKED_IN_LOCK_MESSAGE =
	"That meeting was completed while this page was open, so its agenda no longer accepts changes.";

/** The in-lock refusal for any OTHER blocking item that appeared during the wait. */
export const AGENDA_STILL_BLOCKED_MESSAGE =
	"Some dates still need attention before these agendas can be saved.";

/** A date naming two meetings is not a date this tool can act on. */
export function ambiguousDateMessage(date: string): string {
	return `${date} names more than one meeting of this club, so there is no single agenda to set. Say which meeting you mean in GavelUp.`;
}

/** A club with no standing rule has no time to fall back on. */
export function missingTimeMessage(date: string): string {
	return `There is no meeting on ${date} and this club has no standing schedule to take a time from, so say what time it should start (HH:MM).`;
}
