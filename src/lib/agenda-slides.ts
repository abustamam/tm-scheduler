import type { AgendaSlot, LegendEntry } from "./agenda-runsheet";
import {
	DEFAULT_SPEAKER_MINUTES,
	numbered,
	OPEN_LABEL,
} from "./agenda-runsheet";

/** The meeting fields the deck needs (structural subset of the DB row). */
export type MeetingForDeck = {
	scheduledAt: Date | string;
	theme: string | null;
	wordOfTheDay: string | null;
	wodDefinition: string | null;
	wodExample: string | null;
	reminders: string | null;
};

/** The club fields the deck needs. */
export type ClubForDeck = {
	name: string;
	clubNumber: string | null;
	district: string | null;
	timezone: string;
	meetingSchedule: string | null;
};

/** One projected slide. Date formatting is deferred to the renderer. */
export type Slide =
	| {
			kind: "title";
			clubName: string;
			district: string | null;
			clubNumber: string | null;
			scheduledAt: Date;
			timezone: string;
	  }
	| { kind: "toastmaster"; name: string }
	| { kind: "theme"; theme: string }
	| { kind: "wordOfDay"; word: string; definition: string | null; example: string | null }
	| { kind: "geIntro"; name: string; team: LegendEntry[] }
	| {
			kind: "speech";
			label: string;
			speaker: string;
			title: string | null;
			projectLevel: string | null;
			time: string;
	  }
	| { kind: "voteSpeaker"; names: string[] }
	| { kind: "tableTopics"; master: string; timing: string }
	| { kind: "voteTableTopics" }
	| { kind: "evalIntro"; name: string; time: string }
	| { kind: "evaluation"; label: string; evaluator: string; speaker: string | null; time: string }
	| { kind: "voteEvaluator"; names: string[] }
	| { kind: "generalEvaluation"; name: string; time: string }
	| { kind: "awards"; categories: string[] }
	| { kind: "reminders"; text: string }
	| { kind: "thankYou"; meetingSchedule: string | null };

/** Standard Toastmasters role names (mirrors RUN_OF_SHOW in agenda-runsheet.ts). */
const ROLE = {
	toastmaster: "Toastmaster of the Day",
	generalEvaluator: "General Evaluator",
	tableTopicsMaster: "Table Topics Master",
	evaluator: "Evaluator",
} as const;

/** Hardcoded standard Toastmasters durations for slots without per-slot timing. */
export const TABLE_TOPICS_TIMING = "1–2 minutes per speaker";
export const EVAL_SESSION_TIMING = "4–6 minutes";
export const EVALUATION_TIMING = "2–3 minutes";
export const GENERAL_EVALUATION_TIMING = "2 minutes";

function speechTime(min: number | null, max: number | null): string {
	if (min != null && max != null) return `${min}–${max} minutes`;
	if (max != null) return `${max} minutes`;
	if (min != null) return `${min} minutes`;
	return `${DEFAULT_SPEAKER_MINUTES} minutes`;
}

const assignedNames = (slots: AgendaSlot[]): string[] =>
	slots.map((s) => s.assigneeName).filter((n): n is string => n != null);

const byRoleName = (slots: AgendaSlot[], name: string) =>
	slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

const assigneeOrOpen = (slots: AgendaSlot[], name: string): string =>
	byRoleName(slots, name)[0]?.assigneeName ?? OPEN_LABEL;

export function buildSlideDeck(
	meeting: MeetingForDeck,
	club: ClubForDeck,
	slots: AgendaSlot[],
): Slide[] {
	const deck: Slide[] = [];

	deck.push({
		kind: "title",
		clubName: club.name,
		district: club.district,
		clubNumber: club.clubNumber,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone: club.timezone,
	});

	deck.push({ kind: "toastmaster", name: assigneeOrOpen(slots, ROLE.toastmaster) });

	if (meeting.theme?.trim()) {
		deck.push({ kind: "theme", theme: meeting.theme.trim() });
	}

	if (meeting.wordOfTheDay?.trim()) {
		deck.push({
			kind: "wordOfDay",
			word: meeting.wordOfTheDay.trim(),
			definition: meeting.wodDefinition?.trim() || null,
			example: meeting.wodExample?.trim() || null,
		});
	}

	const speakers = slots
		.filter((s) => s.isSpeakerRole)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	if (speakers.length > 0) {
		const multi = speakers.length > 1;
		speakers.forEach((s, i) => {
			deck.push({
				kind: "speech",
				label: numbered("Speech", i, multi),
				speaker: s.assigneeName ?? OPEN_LABEL,
				title: s.speechTitle,
				projectLevel: s.projectLevel,
				time: speechTime(s.minMinutes, s.maxMinutes),
			});
		});
		deck.push({ kind: "voteSpeaker", names: assignedNames(speakers) });
	}

	const tableTopics = byRoleName(slots, ROLE.tableTopicsMaster);
	if (tableTopics.length > 0) {
		deck.push({
			kind: "tableTopics",
			master: tableTopics[0].assigneeName ?? OPEN_LABEL,
			timing: TABLE_TOPICS_TIMING,
		});
		deck.push({ kind: "voteTableTopics" });
	}

	deck.push({ kind: "thankYou", meetingSchedule: club.meetingSchedule });

	return deck;
}
