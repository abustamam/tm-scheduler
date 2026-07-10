import type { AgendaSlot, LegendEntry } from "./agenda-runsheet";
import {
	assigneeDisplay,
	buildLegend,
	DEFAULT_SPEAKER_MINUTES,
	numbered,
	OPEN_LABEL,
	orderEvaluators,
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
	| { kind: "toastmasterIntro"; theme: string | null; word: string | null }
	| {
			kind: "wordOfDay";
			word: string;
			definition: string | null;
			example: string | null;
	  }
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
	| {
			kind: "evaluation";
			label: string;
			evaluator: string;
			speaker: string | null;
			time: string;
	  }
	| { kind: "voteEvaluator"; names: string[] }
	| { kind: "generalEvaluation"; name: string; time: string }
	| { kind: "awards"; categories: string[] }
	| { kind: "reminders"; text: string }
	| {
			kind: "thankYou";
			meetingSchedule: string | null;
			nextMeetingAt: Date | null;
			timezone: string;
	  };

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

// Assigned names for the vote slides, each with the "· Guest" marker (#151).
const assignedNames = (slots: AgendaSlot[]): string[] =>
	slots.filter((s) => s.assigneeName != null).map((s) => assigneeDisplay(s));

const byRoleName = (slots: AgendaSlot[], name: string) =>
	slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

const assigneeOrOpen = (slots: AgendaSlot[], name: string): string => {
	const slot = byRoleName(slots, name)[0];
	return slot ? assigneeDisplay(slot) : OPEN_LABEL;
};

const SPEECH_ORDINALS = [
	"First",
	"Second",
	"Third",
	"Fourth",
	"Fifth",
] as const;

/** "First Speech" … "Fifth Speech", then "Speech N"; a lone speech is "Speech". */
function speechLabel(index: number, multi: boolean): string {
	if (!multi) return "Speech";
	return index < SPEECH_ORDINALS.length
		? `${SPEECH_ORDINALS[index]} Speech`
		: `Speech ${index + 1}`;
}

export function buildSlideDeck(
	meeting: MeetingForDeck,
	club: ClubForDeck,
	slots: AgendaSlot[],
	nextMeetingAt: Date | null = null,
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

	deck.push({
		kind: "toastmaster",
		name: assigneeOrOpen(slots, ROLE.toastmaster),
	});

	const themeText = meeting.theme?.trim() || null;
	const wodWord = meeting.wordOfTheDay?.trim() || null;
	if (themeText || wodWord) {
		deck.push({ kind: "toastmasterIntro", theme: themeText, word: wodWord });
	}

	const generalEvaluator = byRoleName(slots, ROLE.generalEvaluator);
	if (generalEvaluator.length > 0) {
		deck.push({
			kind: "geIntro",
			name: assigneeDisplay(generalEvaluator[0]),
			team: buildLegend(slots),
		});
	}

	const wodDefinition = meeting.wodDefinition?.trim() || null;
	const wodExample = meeting.wodExample?.trim() || null;
	if (wodWord && (wodDefinition || wodExample)) {
		deck.push({
			kind: "wordOfDay",
			word: wodWord,
			definition: wodDefinition,
			example: wodExample,
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
				label: speechLabel(i, multi),
				speaker: assigneeDisplay(s),
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
			master: assigneeDisplay(tableTopics[0]),
			timing: TABLE_TOPICS_TIMING,
		});
		deck.push({ kind: "voteTableTopics" });
	}

	const evaluators = orderEvaluators(byRoleName(slots, ROLE.evaluator), slots);
	if (evaluators.length > 0) {
		const geName = generalEvaluator[0]?.assigneeName
			? assigneeDisplay(generalEvaluator[0])
			: ROLE.generalEvaluator;
		deck.push({ kind: "evalIntro", name: geName, time: EVAL_SESSION_TIMING });
		const multi = evaluators.length > 1;
		evaluators.forEach((s, i) => {
			deck.push({
				kind: "evaluation",
				label: numbered("Evaluation", i, multi),
				evaluator: assigneeDisplay(s),
				speaker: s.evaluates?.speakerName ?? null,
				time: EVALUATION_TIMING,
			});
		});
		deck.push({ kind: "voteEvaluator", names: assignedNames(evaluators) });
	}

	if (generalEvaluator.length > 0) {
		deck.push({
			kind: "generalEvaluation",
			name: assigneeDisplay(generalEvaluator[0]),
			time: GENERAL_EVALUATION_TIMING,
		});
	}

	const awardCategories: string[] = [];
	if (tableTopics.length > 0) awardCategories.push("Best Table Topic");
	if (evaluators.length > 0) awardCategories.push("Best Evaluator");
	if (speakers.length > 0) awardCategories.push("Best Speaker");
	if (awardCategories.length > 0) {
		deck.push({ kind: "awards", categories: awardCategories });
	}

	if (meeting.reminders?.trim()) {
		deck.push({ kind: "reminders", text: meeting.reminders.trim() });
	}

	deck.push({
		kind: "thankYou",
		meetingSchedule: club.meetingSchedule,
		nextMeetingAt,
		timezone: club.timezone,
	});

	return deck;
}
