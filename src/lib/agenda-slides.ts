import type {
	AgendaSlot,
	LegendEntry,
	RunOfShowConfig,
} from "./agenda-runsheet";
import {
	assigneeDisplay,
	buildLegend,
	DEFAULT_SPEAKER_MINUTES,
	hasAnyFunctionaryRole,
	matchesRole,
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
			/** The club's own meeting number ("Meeting #56", #358); null ⇒ omitted. */
			meetingNumber: number | null;
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
	| {
			/** Beat 4 of the run-of-show (#367): the functionaries are introduced
			 *  and each explains their own role. Owned by the Toastmaster of the
			 *  Day in the standard flow, by the General Evaluator under MCF's
			 *  variant — this slide was `geIntro`, which hardcoded the latter. */
			kind: "functionaryIntro";
			/** Display name of the role that introduces them. */
			owner: string;
			/** Who holds that role, or the open placeholder. */
			name: string;
			team: LegendEntry[];
	  }
	| {
			/** Beat 12 (#367, absorbs #353): the General Evaluator calls for the
			 *  functionary reports, between evaluating the evaluators and the
			 *  overall meeting evaluation. Not affected by the flag — MCF's
			 *  closing sequence is the same as everyone else's. */
			kind: "functionaryReports";
			/** Who holds the General Evaluator role, or the open placeholder. */
			name: string;
			team: LegendEntry[];
	  }
	| {
			kind: "speech";
			label: string;
			speaker: string;
			title: string | null;
			projectLevel: string | null;
			time: string;
			link: string | null;
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

/** The standard roles the deck binds slides to (mirrors the beats
 *  `buildRunOfShow` emits in agenda-runsheet.ts). Each carries the immutable
 *  `role_definitions.key` (#368) as well as the canonical name, so a slide
 *  keeps finding its slots after a club renames the role — the same binding
 *  rule the run sheet uses (`matchesRole`), which is what keeps print and deck
 *  from disagreeing about which sections exist. */
type RoleRef = { key: string; name: string };
const ROLE = {
	toastmaster: {
		key: "toastmaster_of_the_day",
		name: "Toastmaster of the Day",
	},
	generalEvaluator: { key: "general_evaluator", name: "General Evaluator" },
	tableTopicsMaster: {
		key: "table_topics_master",
		name: "Table Topics Master",
	},
	evaluator: { key: "evaluator", name: "Evaluator" },
} as const satisfies Record<string, RoleRef>;

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

const byRole = (slots: AgendaSlot[], role: RoleRef) =>
	slots.filter((s) => matchesRole(s, role.key, role.name));

const assigneeOrOpen = (slots: AgendaSlot[], role: RoleRef): string => {
	const slot = byRole(slots, role)[0];
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

/** Everything the deck is built from. An options object rather than positional
 *  parameters: the club's run-of-show config (#367) would have made this a
 *  sixth positional argument behind two optional ones. */
export type SlideDeckInput = Partial<RunOfShowConfig> & {
	meeting: MeetingForDeck;
	club: ClubForDeck;
	slots: AgendaSlot[];
	/** Backs the Thank-You slide; null when the club has nothing scheduled after. */
	nextMeetingAt?: Date | null;
	/** The club's effective meeting number (#358) — stored or derived upstream. */
	meetingNumber?: number | null;
};

export function buildSlideDeck({
	meeting,
	club,
	slots,
	nextMeetingAt = null,
	meetingNumber = null,
	// Defaults to the standard flow, like `RUN_OF_SHOW` does for the run sheet.
	geIntroducesFunctionaries = false,
}: SlideDeckInput): Slide[] {
	const deck: Slide[] = [];

	deck.push({
		kind: "title",
		clubName: club.name,
		district: club.district,
		clubNumber: club.clubNumber,
		meetingNumber,
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

	const generalEvaluator = byRole(slots, ROLE.generalEvaluator);
	// Beat 4. Gated exactly as the run sheet gates it: the owning role has a
	// slot AND the club runs at least one functionary to introduce.
	const introOwner = geIntroducesFunctionaries
		? ROLE.generalEvaluator
		: ROLE.toastmaster;
	const introOwnerSlots = byRole(slots, introOwner);
	const anyFunctionary = hasAnyFunctionaryRole(slots);
	if (introOwnerSlots.length > 0 && anyFunctionary) {
		deck.push({
			kind: "functionaryIntro",
			owner: introOwner.name,
			name: assigneeDisplay(introOwnerSlots[0]),
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
				link: s.presentationUrl ?? null,
			});
		});
		deck.push({ kind: "voteSpeaker", names: assignedNames(speakers) });
	}

	const tableTopics = byRole(slots, ROLE.tableTopicsMaster);
	if (tableTopics.length > 0) {
		deck.push({
			kind: "tableTopics",
			master: assigneeDisplay(tableTopics[0]),
			timing: TABLE_TOPICS_TIMING,
		});
		deck.push({ kind: "voteTableTopics" });
	}

	const evaluators = orderEvaluators(byRole(slots, ROLE.evaluator), slots);
	if (evaluators.length > 0) {
		const geName = generalEvaluator[0]?.assigneeName
			? assigneeDisplay(generalEvaluator[0])
			: ROLE.generalEvaluator.name;
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

	// Beats 12 then 13: the GE calls for the functionary reports, then gives the
	// overall meeting evaluation. The reports beat needs functionaries to call
	// for; the overall evaluation only needs a GE.
	if (generalEvaluator.length > 0 && anyFunctionary) {
		deck.push({
			kind: "functionaryReports",
			name: assigneeDisplay(generalEvaluator[0]),
			team: buildLegend(slots),
		});
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
