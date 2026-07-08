import type { AgendaSlot, LegendEntry } from "./agenda-runsheet";
import { OPEN_LABEL } from "./agenda-runsheet";

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

	deck.push({ kind: "thankYou", meetingSchedule: club.meetingSchedule });

	return deck;
}
