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
 * every message). The panel names who is behind; asking them is the officer's
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

export interface ReadinessGap {
	slotId: string;
	/** The agenda's own label, from `slotLabel` / `buildRoleCounts` ("Speaker 2"). */
	slotLabel: string;
	/** Null when the owning slot is open. A display name and nothing else. */
	holderName: string | null;
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
const SKIPPED_DUTY_IDS: ReadonlySet<DutyId> = new Set<DutyId>(["timing"]);

/** Every duty this view reports; adding a `DutyId` without deciding fails to compile. */
type ReportedDutyId = Exclude<DutyId, "timing">;

const isReportedDuty = (id: DutyId): id is ReportedDutyId =>
	!SKIPPED_DUTY_IDS.has(id);

/**
 * `meeting`: one fact about the whole meeting, so it is ONE item with `total: 1`
 * however many slots own the duty (two Table Topics Masters do not make two
 * topics). `slot`: one fact per owning slot (each speaker's own title).
 */
const DUTY_ITEMS: Record<
	ReportedDutyId,
	{ label: string; scope: "meeting" | "slot" }
> = {
	meeting_theme: { label: "Theme set", scope: "meeting" },
	word_of_the_day: { label: "Word of the Day set", scope: "meeting" },
	table_topics: { label: "Table Topics set", scope: "meeting" },
	speech_details: { label: "Speech details added", scope: "slot" },
};

/** The order the duty items are shown in, after the two role items. */
const DUTY_ITEM_ORDER: readonly ReportedDutyId[] = [
	"meeting_theme",
	"word_of_the_day",
	"table_topics",
	"speech_details",
];

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
 * ORDER: this never sorts. It preserves the order of `slots`, and "agenda
 * order" means that order. Both callers pass `loadMeetingSlots` rows unchanged,
 * which that loader already orders by `role_definitions.sort_order`, then
 * `slot_index`.
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
}): MeetingReadiness {
	const { meeting, slots } = input;
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

	addItem(
		buildItem(
			"roles_filled",
			"Roles filled",
			slots.length,
			slots.filter((s) => s.status === "open").map(gapFor),
		),
	);
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
		ReportedDutyId,
		{ total: number; gaps: ReadinessGap[] }
	>();
	for (const slot of slots) {
		for (const duty of dutiesForRole(slot)) {
			if (!isReportedDuty(duty.id)) continue;
			const spec = DUTY_ITEMS[duty.id];
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
	for (const id of DUTY_ITEM_ORDER) {
		const acc = byDuty.get(id);
		if (acc) addItem(buildItem(id, DUTY_ITEMS[id].label, acc.total, acc.gaps));
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
 * Who sees the panel: an officer (`canManage`, which already means an admin
 * membership or an open office) who is not previewing as a member, OR this
 * meeting's Toastmaster of the Day.
 *
 * Preview-as-member (#320) drops only the OFFICER arm. The TMOD arm stays,
 * because the page derives `isTmod` from the viewer's own slot whether
 * previewing or not, so an officer who is also this meeting's TMOD still sees
 * the panel in preview, exactly as a non-officer TMOD would.
 */
export function canSeeMeetingReadiness(input: {
	canManage: boolean;
	previewAsMember: boolean;
	isTmod: boolean;
}): boolean {
	return (input.canManage && !input.previewAsMember) || input.isTmod;
}
