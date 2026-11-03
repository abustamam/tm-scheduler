// src/lib/toastmaster-script.ts
//
// The Toastmaster's script (#1480): the whole meeting, in this meeting's order,
// with the Toastmaster's own lines and the real names. A PURE builder over the
// rows the printed agenda renders, so the script and the paper cannot disagree
// about a time or a name.
//
// ## What it does not do
//
// It never computes a clock: every `time` is read off a `TimelineRow`, which is
// what `applyFlex` then `buildTimeline` produced for print. And it never reads a
// row's English to learn what kind of cue it is: a stored agenda carries no cue
// type, so only two shapes are structural and only those are recognised — a
// speech row (its `slotId` is a speech slot) and the per-speech preamble (a
// Toastmaster `handoff` row directly before a speech row).

import { GUEST_MARKER, VISITING_TOASTMASTER_MARKER } from "./agenda";
import {
	type AgendaSlot,
	matchesRole,
	OPEN_LABEL,
	pairedEvaluatorNames,
} from "./agenda-runsheet";
import type { TimelineRow } from "./agenda-timing";
import { TMOD_ROLE_KEY } from "./meeting-roles";

export type ScriptLine =
	| {
			kind: "mine";
			time: string;
			minutes: number;
			detail: string;
			/** "You're back when {holder} hands back." on the first `mine` line
			 *  directly after an `others` line, else null. */
			backCue: string | null;
	  }
	| {
			kind: "speech";
			time: string;
			minutes: number;
			speaker: string;
			title: string | null;
			/** The paired evaluator's display name(s), or null when none is linked. */
			evaluator: string | null;
			/** The quoted evaluator ask, or null when `evaluator` is null. */
			evaluatorAsk: string | null;
			/** The quoted introduction line. */
			say: string;
			introduction: "shown" | "members-only" | "none";
			/** Set whenever `title` is null; rendered as a note, never inside the
			 *  quoted line. */
			prepNote: string | null;
	  }
	| { kind: "others"; time: string; minutes: number; summary: string };

export const MISSING_TITLE_NOTE =
	"Their title isn't on the agenda yet. Ask them before the meeting.";

/**
 * The evaluator ask. `sheetScripts().toastmaster` carries the same sentence for
 * the PDF with "our Evaluator, named on your agenda" where this has the name;
 * `toastmaster-script.test.ts` pins the two together so the wording cannot
 * drift (#508, #509).
 */
export function evaluatorAskFor(names: string): string {
	return `Evaluating this speech is ${names}. Before we begin — would you give us the objectives for this project, and the time our speaker is working to?`;
}

/** A speech slot: a speaker or contestant, NOT an evaluator (`isSpeakerRole` is
 *  true for all three). */
function isSpeechSlot(slot: AgendaSlot): boolean {
	return (
		slot.isSpeakerRole &&
		slot.evaluatesSlotId == null &&
		!matchesRole(slot, "evaluator", "Evaluator")
	);
}

function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function buildToastmasterScript(input: {
	/** The flexed, timed rows — the same rows print renders. */
	rows: TimelineRow[];
	slots: AgendaSlot[];
	/** Keyed by speech slot id. Null for a non-member viewer. */
	introductions: Record<string, string> | null;
}): ScriptLine[] {
	const { slots, introductions } = input;
	// A templated agenda's full-width section bands ("OPENING") belong to no one;
	// left in, each would read as a run "OPENING runs it" (the stored-template
	// path through `resolveAgendaRows` keeps them).
	const rows = input.rows.filter((r) => r.section !== true);
	const slotById = new Map(slots.map((s) => [s.id, s]));
	const speechSlotOf = (row: TimelineRow | undefined): AgendaSlot | null => {
		if (!row?.slotId) return null;
		const slot = slotById.get(row.slotId);
		return slot && isSpeechSlot(slot) ? slot : null;
	};
	const isMine = (row: TimelineRow) => row.roleKey === TMOD_ROLE_KEY;

	const lines: ScriptLine[] = [];
	// The cue for the end of the latest `others` run; read only when the very
	// next line is the Toastmaster's own.
	let pendingBack: string | null = null;
	let i = 0;
	while (i < rows.length) {
		const row = rows[i] as TimelineRow;
		const speechSlot = speechSlotOf(row);

		// The per-speech preamble folds into the speech that follows it.
		if (isMine(row) && row.handoff === true && speechSlotOf(rows[i + 1])) {
			i += 1;
			continue;
		}

		if (speechSlot) {
			const speaker = row.holder ?? OPEN_LABEL;
			// The marker is for the eye; the Toastmaster reads the bare name aloud.
			const spoken = speaker
				.replace(` \u00b7 ${GUEST_MARKER}`, "")
				.replace(` ${VISITING_TOASTMASTER_MARKER}`, "");
			const title = speechSlot.speechTitle?.trim() || null;
			const evaluators = pairedEvaluatorNames(speechSlot.id, slots);
			const written = introductions?.[speechSlot.id]?.trim() || null;
			const introduction: "shown" | "members-only" | "none" =
				introductions === null ? "members-only" : written ? "shown" : "none";
			const say =
				introduction === "shown" && written
					? written
					: title
						? `${title} – ${spoken} – ${spoken} – ${title}`
						: `Introduce ${spoken}.`;
			const names = evaluators.length > 0 ? joinNames(evaluators) : null;
			lines.push({
				kind: "speech",
				time: row.time,
				minutes: row.minutes,
				speaker,
				title,
				evaluator: names,
				evaluatorAsk: names === null ? null : evaluatorAskFor(names),
				say,
				introduction,
				prepNote: title === null ? MISSING_TITLE_NOTE : null,
			});
			i += 1;
			continue;
		}

		if (isMine(row)) {
			const prev = lines[lines.length - 1];
			const backCue = prev?.kind === "others" ? pendingBack : null;
			lines.push({
				kind: "mine",
				time: row.time,
				minutes: row.minutes,
				detail: row.detail,
				backCue,
			});
			i += 1;
			continue;
		}

		// A run of rows the Toastmaster neither owns nor speaks collapses to one.
		const first = row;
		let last = row;
		let minutes = 0;
		while (i < rows.length) {
			const r = rows[i] as TimelineRow;
			if (isMine(r) || speechSlotOf(r)) break;
			minutes += r.minutes;
			last = r;
			i += 1;
		}
		const label = first.roleLabel ?? first.who;
		lines.push({
			kind: "others",
			time: first.time,
			minutes,
			summary: first.holder
				? `${label}: ${first.holder} runs it (~${minutes} min)`
				: `${label} runs it (~${minutes} min)`,
		});
		pendingBack = `You're back when ${last.holder ?? last.roleLabel ?? last.who} hands back.`;
	}
	return lines;
}

/**
 * Where the members-only note's "Sign in" link goes, or null for no link. Keyed
 * on the parent route's `hasSession` (is there a session at all), NOT on
 * `authCtx`, which is null for a signed-in non-member too: that visitor is
 * already signed in, so a sign-in link would be wrong for them.
 */
export function scriptSignInRedirect(args: {
	showMembersOnlyNote: boolean;
	hasSession: boolean;
	clubId: string;
	meetingKey: string;
}): string | null {
	if (!args.showMembersOnlyNote || args.hasSession) return null;
	return `/club/${args.clubId}/meeting/${args.meetingKey}/me/script`;
}
