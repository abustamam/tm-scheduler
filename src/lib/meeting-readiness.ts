/**
 * Is this meeting ready? (#963)
 *
 * One db-free answer to "what is still missing before Saturday?", read by two
 * consumers: the meeting page's "Before the meeting" panel and `get_agenda`'s
 * `readiness` field. Two consumers each deriving it would be how they come to
 * disagree, so this is the one place it is derived.
 *
 * It is a VIEW, never a broadcast. It reads, it writes nothing and it sends
 * nothing (`.out-of-scope/automatic-open-role-nudges.md`, ADR-0028: humans send
 * every message). The panel names who is behind; asking them is the reader's
 * own move, from the agenda below it.
 *
 * ## Why this lives in `src/lib`, and takes structural inputs
 *
 * The panel runs on the client and `get_agenda` on the server. A module that
 * reaches the database layer cannot be imported by a client route (the driver
 * drags `Buffer` in and white-screens the page), so this imports no server type:
 * `ReadinessSlot` is satisfied structurally by the page's slots and by
 * `loadMeetingSlots` rows alike. It is also assertable from vitest with no
 * database, which a predicate living in a server handler is not.
 *
 * ## Done-ness comes from the duty registry, never a re-derivation
 *
 * `roles_filled` and `roles_confirmed` follow `role_slots.status`. The four duty
 * items (theme, Word of the Day, Table Topics, speech details) are done exactly
 * when `dutiesForRole(slot)[i].done(ctx)` says so, the same call `/me` makes, so
 * the panel and a role holder's own checklist cannot disagree about whether the
 * theme is set. `role-duties.ts`'s header states that rule; a whitespace theme
 * or the `TBA` speech title are therefore NOT done here for the same reason they
 * are not done there.
 *
 * ## No clock in here
 *
 * `showsMeetingReadiness` takes `now` as a REQUIRED argument. The meeting route
 * reads its clock once per render and hands that instant to every consumer
 * (spec D1, and the route hydration gate); a helper that defaulted to the live
 * clock would put a second clock read in the render.
 */
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { type CoverKind, coverStatus } from "#/lib/cover";
import { APP_LOCALE } from "#/lib/format";
import { meetingPhase } from "#/lib/meeting-lifecycle";
import {
	type DutyContext,
	type DutyId,
	dutiesForRole,
} from "#/lib/role-duties";

export type ReadinessItemId =
	| "roles_filled"
	| "roles_confirmed"
	| "meeting_theme"
	| "word_of_the_day"
	| "table_topics"
	| "speech_details";

/**
 * Structural, so both the page's slots and `loadMeetingSlots` rows fit. Never
 * import a server type here: the page cannot load one.
 */
export interface ReadinessSlot {
	id: string;
	roleName: string;
	roleKey: string | null;
	slotIndex: number;
	/** `role_definitions.slots_unordered`; `slotLabel` drops the number when true (#624). */
	slotsUnordered: boolean;
	status: "open" | "claimed" | "confirmed";
	assigneeName: string | null;
	speechTitle: string | null;
}

/**
 * Structural view of a cover request (#1441), so `MeetingCoverRequest` fits
 * without this module importing a server type. `releasedAt` is a string once
 * the payload has crossed the wire.
 */
export interface ReadinessCoverRequest {
	slotId: string;
	kind: CoverKind;
	releasedName: string;
	releasedAt: Date | string;
	coveredAt: Date | string | null;
}

/** An open slot someone handed back (#1441): what the panel says and drafts. */
export interface ReadinessGapCover {
	status: "dropped" | "finding_cover";
	releasedName: string;
	releasedAt: Date | string;
	/** The meeting's weekday in the club's zone ("Tuesday"), for the group call. */
	weekday: string;
}

export interface ReadinessGap {
	slotId: string;
	/** The agenda's own label, from `slotLabel` / `buildRoleCounts` ("Speaker 2"). */
	slotLabel: string;
	/** Null when the owning slot is open. A display name and nothing else. */
	holderName: string | null;
	/** Set on `roles_filled` gaps whose slot has a live cover request (#1441). */
	cover?: ReadinessGapCover;
}

export interface ReadinessItem {
	id: ReadinessItemId;
	label: string;
	done: boolean;
	doneCount: number;
	total: number;
	/** Every gap, in agenda order. The UI truncates; this never does. */
	gaps: ReadinessGap[];
}

export interface MeetingReadiness {
	ready: boolean;
	items: ReadinessItem[];
}

/**
 * Duties this view does not report, and why: the Timer's `timing` duty can only
 * be done DURING the meeting (`meeting_timings` rows are written by the stopwatch
 * while the speeches run), so before the meeting it would always read "not done"
 * and no meeting could ever be ready. It is the first duty in the registry that
 * is not pre-meeting prep (`role-duties.ts`, `TIMING_DUTY`). `hasTiming` is
 * therefore never passed to a duty's `done` here either.
 */
const SKIPPED_DUTY_IDS = ["timing"] as const satisfies readonly DutyId[];
type SkippedDutyId = (typeof SKIPPED_DUTY_IDS)[number];

/** Every duty id that is not skipped: the ones this view must report. */
type ReportableDutyId = Exclude<DutyId, SkippedDutyId>;

interface ReportedDuty {
	id: Extract<ReportableDutyId, ReadinessItemId>;
	label: string;
	/**
	 * `meeting`: one fact about the whole meeting, so it is ONE item with
	 * `total: 1` however many slots own the duty (two Table Topics Masters do not
	 * make two topics). `slot`: one fact per owning slot (each speaker's own
	 * title).
	 */
	scope: "meeting" | "slot";
}

/**
 * The duty items, in the order they are shown after the two role items. This
 * tuple is the ONE source: the order is its order, the lookup below is built
 * from it, and `ReportedDutyId` is read off it, so none of the three can drift
 * from the others.
 */
const REPORTED_DUTIES = [
	{ id: "meeting_theme", label: "Theme set", scope: "meeting" },
	{ id: "word_of_the_day", label: "Word of the Day set", scope: "meeting" },
	{ id: "table_topics", label: "Table Topics set", scope: "meeting" },
	{ id: "speech_details", label: "Speech details added", scope: "slot" },
] as const satisfies readonly ReportedDuty[];

type ReportedDutyId = (typeof REPORTED_DUTIES)[number]["id"];

/**
 * By id, for the loop below. The ANNOTATION is the compile-time check that every
 * `DutyId` is decided: a duty added to the registry is neither in
 * `SKIPPED_DUTY_IDS` nor in `REPORTED_DUTIES`, so `ReportableDutyId` gains a key
 * the tuple's `ReportedDutyId` lacks and this assignment stops compiling until
 * someone chooses. The same holds the other way: a duty in `REPORTED_DUTIES` that
 * is also skipped fails the tuple's own `satisfies`. The cast is the one place
 * `Object.fromEntries` loses its key type, and the assignment re-checks it.
 */
const REPORTED_DUTY_BY_ID: Readonly<Record<ReportableDutyId, ReportedDuty>> =
	Object.fromEntries(REPORTED_DUTIES.map((duty) => [duty.id, duty])) as Record<
		ReportedDutyId,
		ReportedDuty
	>;

const isReportable = (id: DutyId): id is ReportableDutyId =>
	!(SKIPPED_DUTY_IDS as readonly DutyId[]).includes(id);

function buildItem(
	id: ReadinessItemId,
	label: string,
	total: number,
	gaps: ReadinessGap[],
): ReadinessItem {
	const doneCount = total - gaps.length;
	return { id, label, done: doneCount === total, doneCount, total, gaps };
}

/**
 * What is still missing on a meeting, item by item.
 *
 * ORDER: `slots` order is agenda order, and every gap list keeps it, with ONE
 * exception (#1441): in `roles_filled`, a slot with a live cover request
 * (`dropped` or `finding_cover`) moves to the front, stably, so the UI's cap
 * of three cannot hide it. Both callers pass `loadMeetingSlots` rows
 * unchanged, which that loader already orders by `role_definitions.sort_order`,
 * then `slot_index`.
 *
 * The cover inputs are all optional and travel together: without
 * `coverRequests`, `now`, `timezone` and `scheduledAt` nothing is annotated
 * (`get_agenda` passes none). `now` is the caller's one clock.
 *
 * An item with nothing to measure (`total` 0) is OMITTED rather than shown as
 * done: a meeting with no Grammarian slot has no Word of the Day line. A meeting
 * with no slots at all is vacuously ready.
 */
export function meetingReadiness(input: {
	meeting: {
		theme: string | null;
		wordOfTheDay: string | null;
		tableTopicsNotes: string | null;
	};
	slots: readonly ReadinessSlot[];
	coverRequests?: readonly ReadinessCoverRequest[];
	now?: Date;
	timezone?: string;
	scheduledAt?: Date | string;
}): MeetingReadiness {
	const { meeting, slots } = input;
	const { coverRequests, now, timezone, scheduledAt } = input;
	const coverBySlot = new Map<string, ReadinessGapCover>();
	if (coverRequests && now && timezone && scheduledAt) {
		const at = new Date(scheduledAt);
		const weekday = new Intl.DateTimeFormat(APP_LOCALE, {
			weekday: "long",
			timeZone: timezone,
		}).format(at);
		for (const request of coverRequests) {
			const status = coverStatus(
				{
					kind: request.kind,
					coveredAt: request.coveredAt ? new Date(request.coveredAt) : null,
				},
				{ scheduledAt: at },
				timezone,
				now,
			);
			if (status === "covered") continue;
			coverBySlot.set(request.slotId, {
				status,
				releasedName: request.releasedName,
				releasedAt: request.releasedAt,
				weekday,
			});
		}
	}
	// Numbered over the FULL input, exactly as the agenda numbers them.
	const roleCounts = buildRoleCounts([...slots]);
	const gapFor = (slot: ReadinessSlot): ReadinessGap => ({
		slotId: slot.id,
		slotLabel: slotLabel(slot, roleCounts),
		holderName: slot.status === "open" ? null : slot.assigneeName,
	});

	const items: ReadinessItem[] = [];
	const addItem = (item: ReadinessItem) => {
		if (item.total > 0) items.push(item);
	};

	const openGaps = slots
		.filter((s) => s.status === "open")
		.map((s) => {
			const cover = coverBySlot.get(s.id);
			return cover ? { ...gapFor(s), cover } : gapFor(s);
		});
	// `sort` is stable: cover gaps first, everything else keeps agenda order.
	openGaps.sort((a, b) => Number(!!b.cover) - Number(!!a.cover));
	addItem(buildItem("roles_filled", "Roles filled", slots.length, openGaps));
	const held = slots.filter((s) => s.status !== "open");
	addItem(
		buildItem(
			"roles_confirmed",
			"Roles confirmed",
			held.length,
			held.filter((s) => s.status === "claimed").map(gapFor),
		),
	);

	const meetingCtx: DutyContext = {
		theme: meeting.theme,
		wordOfTheDay: meeting.wordOfTheDay,
		tableTopicsNotes: meeting.tableTopicsNotes,
	};
	const byDuty = new Map<
		ReportableDutyId,
		{ total: number; gaps: ReadinessGap[] }
	>();
	for (const slot of slots) {
		for (const duty of dutiesForRole(slot)) {
			if (!isReportable(duty.id)) continue;
			const spec = REPORTED_DUTY_BY_ID[duty.id];
			const acc = byDuty.get(duty.id) ?? { total: 0, gaps: [] };
			byDuty.set(duty.id, acc);
			// A meeting-level duty counts once, at the first slot that owns it in
			// agenda order; that slot is the one the gap names.
			if (spec.scope === "meeting" && acc.total > 0) continue;
			acc.total += 1;
			const ctx: DutyContext =
				spec.scope === "meeting"
					? meetingCtx
					: { speechTitle: slot.speechTitle };
			if (!duty.done(ctx)) acc.gaps.push(gapFor(slot));
		}
	}
	for (const { id, label } of REPORTED_DUTIES) {
		const acc = byDuty.get(id);
		if (acc) addItem(buildItem(id, label, acc.total, acc.gaps));
	}

	return { ready: items.every((item) => item.done), items };
}

/**
 * Whether a meeting is still one to get ready: scheduled, and not yet over in
 * the club's own calendar. A completed or cancelled meeting has nothing left to
 * prepare, and a scheduled one whose club-local day has passed is as good as
 * completed (`meetingPhase` delegates to `isMeetingOver`, #393). Today counts:
 * people fill roles right up to the meeting.
 */
export function showsMeetingReadiness(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	now: Date;
}): boolean {
	return input.status === "scheduled" && meetingPhase(input) !== "completed";
}

/**
 * Who sees the panel: a club admin (`canManage`) who is not previewing as a
 * member, OR this meeting's Toastmaster of the Day.
 *
 * `canManage` is `canManageClub`'s answer (`src/server/guards.ts`): an active
 * membership whose stored `club_role` is admin or that holds an open officer
 * term (effective admin, #202; the read flag caught up in #1383), or a
 * `read_write` impersonation.
 *
 * Preview-as-member (#320) drops only the ADMIN arm. The TMOD arm stays (AC 8,
 * third row) because the page derives `isTmod` from the viewer's own slot
 * whether previewing or not. That DIFFERS, deliberately, from the route's
 * `runsThisMeeting` (`effectiveCanManage || (isTmod && !previewAsMember)`),
 * which drops the TMOD arm in preview: an admin who is also this meeting's TMOD
 * still sees this panel while previewing, where the plan panel goes away.
 */
export function canSeeMeetingReadiness(input: {
	canManage: boolean;
	previewAsMember: boolean;
	isTmod: boolean;
}): boolean {
	return (input.canManage && !input.previewAsMember) || input.isTmod;
}
