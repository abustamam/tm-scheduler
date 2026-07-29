import type {
	AgendaSlot,
	LegendEntry,
	RunOfShowConfig,
} from "./agenda-runsheet";
import {
	assigneeDisplay,
	beatDuration,
	buildLegend,
	buildReportingLegend,
	buildRunOfShow,
	hasAnyFunctionaryRole,
	hasAnyReportingFunctionaryRole,
	matchesRole,
	numbered,
	orderEvaluators,
} from "./agenda-runsheet";
import {
	type SpeechWindowInput,
	speechBookedMinutes,
	speechWindow,
} from "./speech-window";

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

/** Carried by all three vote slides — the ends of the speech, Table Topics and
 *  evaluation segments. True when the club runs a Timer, so the slide asks for
 *  the timer's report before the vote. Each of those beats' run-sheet
 *  `fallbacks` drop the timer's-report clause on exactly the same signal
 *  (#367): a club with no Timer still votes, it just has no report to call for
 *  and nobody to call on for it. */
type VoteTiming = {
	hasTimer: boolean;
	/** Who calls for the report and the vote (#363) — the segment leader, the
	 *  same owner the run sheet's vote beat resolves to. `null` when the club
	 *  runs no such role: the printed row keeps its `who` column via
	 *  `renderUnowned` and shows the bare role name, but a slide has no column to
	 *  fill, so it drops the attribution line rather than crediting a role
	 *  nobody holds. The vote still happens either way. */
	caller: LegendEntry | null;
};

/**
 * Every segment a hand-off can hand to (#363). Prose rather than a role
 * reference, because a hand-off's target is sometimes a group.
 *
 * A closed union, not `string`, because the four values are duplicated as
 * lookup keys in two other places — `HANDOFF_HEADER` (slide-layout.ts), which
 * names the slide in the projector's jump grid, and `HANDOFF_SECTION`
 * (agenda-parity.test.ts), which gives it a parity identity. Nothing else
 * type-checks that coupling: with a bare `string`, a fifth target added later
 * would compile fine and silently take the bare "Hand-off" grid label. Now it
 * is a compile error in both maps.
 */
export type HandoffTarget =
	| "the speakers"
	| "the Table Topics Master"
	| "the General Evaluator"
	| "the speech evaluators";

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
	| {
			/** A 0-minute hand-off beat (#363), projected so the person on deck has
			 *  the cue on screen at the moment they need it. See `HandoffTarget`
			 *  for why `to` is a closed union of prose rather than a role. */
			kind: "handoff";
			from: LegendEntry;
			to: HandoffTarget;
	  }
	| { kind: "toastmasterIntro"; theme: string | null; word: string | null }
	| {
			/** The Word of the Day in full — word, definition, example — projected
			 *  inside the Toastmaster's opening, right after the theme+word intro
			 *  (#354). It used to sit after the functionary intro, so the room saw
			 *  the word, sat through another beat, and only then learned what it
			 *  meant. Content-gated (needs a definition or an example), not
			 *  role-gated, which is why it has no run-sheet beat of its own. */
			kind: "wordOfDay";
			word: string;
			definition: string | null;
			example: string | null;
			/** The Grammarian — who actually presents the Word of the Day — under
			 *  the club's own name for the role, plus its holder (or the open
			 *  placeholder). `null` when the club runs no Grammarian at all.
			 *  Without it the slide's position would imply the Toastmaster of the
			 *  Day delivers it (#354). */
			presenter: LegendEntry | null;
	  }
	| {
			/** The functionary-intro beat of the run-of-show (#367): they are
			 *  introduced and each explains their own role. Owned by the Toastmaster
			 *  of the Day in the standard flow, by the General Evaluator under MCF's
			 *  variant — this slide was `geIntro`, which hardcoded the latter. */
			kind: "functionaryIntro";
			/** Display name of the role that introduces them. */
			owner: string;
			/** Who holds that role, or the open placeholder. */
			name: string;
			team: LegendEntry[];
	  }
	| {
			/** The functionary-reports beat (#367, absorbs #353): the GE calls for
			 *  the functionary reports, between evaluating the evaluators and the
			 *  overall meeting evaluation. Not affected by the flag — MCF's closing
			 *  sequence is the same as everyone else's. */
			kind: "functionaryReports";
			/** Display name of the role calling for them — the General Evaluator,
			 *  or the Toastmaster of the Day covering for a club that runs no GE
			 *  (#363). Carried for the same reason `functionaryIntro` carries one:
			 *  the owner varies by club, so the layout cannot hardcode it. Without
			 *  it a Toastmaster-covered slide announced "General Evaluator: Alice". */
			owner: string;
			/** Who holds that role, or the open placeholder. */
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
	| ({ kind: "voteSpeaker"; names: string[] } & VoteTiming)
	| {
			kind: "tableTopics";
			master: string;
			timing: string;
			/** The Word of the Day, kept on screen for the segment that exists to
			 *  use it — the Table Topics beat is literally "Impromptu topics using
			 *  the Word of the Day" (#355). A REMINDER, not a second presentation:
			 *  the standalone `wordOfDay` slide (#354) is where the Grammarian
			 *  presents the word in full, a dozen slides earlier. Hence no example
			 *  and no presenter credit here — nobody is delivering it at this point,
			 *  they are working it into an answer. `null` when the meeting has no
			 *  word. */
			word: string | null;
			/** The word's definition, when the meeting records one. A narrower gate
			 *  than the standalone slide's, which needs a definition or an example
			 *  to exist at all: a club that sets only the word gets no `wordOfDay`
			 *  slide, so by Table Topics the word has not been on screen since the
			 *  opening `toastmasterIntro` — which is the segment that asks the room
			 *  to use it. */
			definition: string | null;
	  }
	| ({ kind: "voteTableTopics" } & VoteTiming)
	| {
			kind: "evaluation";
			label: string;
			evaluator: string;
			speaker: string | null;
			time: string;
	  }
	| ({ kind: "voteEvaluator"; names: string[] } & VoteTiming)
	| {
			/** The evaluator-evaluation beat (#367): the General Evaluator evaluates
			 *  the evaluators, after the Best-Evaluator vote and before the
			 *  functionary reports. Gated exactly as the run sheet gates it — the GE
			 *  role has a slot, OR the Toastmaster of the Day has one to cover with
			 *  (#363) — AND the club runs evaluators to evaluate. That last clause
			 *  reverses #367, which gated the slide on the GE alone; see the beat.
			 *  This slide was `evalIntro`, which sat before the evaluations (matching
			 *  no beat) and printed the literal words "General Evaluator" as a name
			 *  when the club had no GE. */
			kind: "evaluatorEvaluation";
			/** Display name of the role giving it — see `functionaryReports.owner`. */
			owner: string;
			/** Who holds that role, or the open placeholder. */
			name: string;
			time: string;
	  }
	| {
			kind: "generalEvaluation";
			/** Display name of the role giving it — see `functionaryReports.owner`. */
			owner: string;
			name: string;
			time: string;
	  }
	| { kind: "awards"; categories: string[] }
	| {
			/** The guest-comments beat (#352): the President invites them, between
			 *  the awards and the closing announcements. Carries no data — a first
			 *  cut that prompts the room generically rather than reading the
			 *  meeting's recorded guests, since guests who were never booked in are
			 *  the common case and a partial list reads as excluding the rest.
			 *  Ungated, exactly like the beat. */
			kind: "guestComments";
	  }
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
	speaker: { key: "speaker", name: "Speaker" },
	evaluator: { key: "evaluator", name: "Evaluator" },
	timer: { key: "timer", name: "Timer" },
	/** Bound only to credit the Word-of-the-Day slide (#354) — the Grammarian is
	 *  otherwise reached through the shared functionary helpers, never by key. */
	grammarian: { key: "grammarian", name: "Grammarian" },
} as const satisfies Record<string, RoleRef>;

/**
 * The one duration on the deck that is NOT a beat's budget (#356), and the
 * reason it is exempt: this is the limit on a SINGLE impromptu answer, while
 * the Table Topics beat books the whole SEGMENT. Deriving it would project
 * "Speaker time: 10 minutes" at a speaker who has one to two — a per-speaker
 * versus per-segment difference, not a disagreement.
 *
 * The segment number is also the one the deck could never state honestly:
 * `applyFlex` resizes that beat at render time to whatever makes the meeting
 * come out to its scheduled length, and the deck is not given that length.
 */
export const TABLE_TOPICS_TIMING = "1–2 minutes per speaker";

/**
 * The "Time:" line on a prepared-speech slide: the slot's assigned range when
 * it has one, otherwise the minutes the run sheet books for that same row.
 *
 * Both branches end at `speechBookedMinutes` (#394) — the top of the range IS
 * the booked duration — so the number the projector shows the speaker and the
 * number the printed clock reserves can never drift. It used to project the
 * single bound that happened to be set, which showed a min-only slot "5
 * minutes" against a row the run sheet gave 7.
 */
function speechTime(slot: SpeechWindowInput): string {
	const w = speechWindow(slot);
	return w
		? `${w.min}–${w.max} minutes`
		: `${speechBookedMinutes(slot)} minutes`;
}

// Assigned names for the vote slides, each with the "· Guest" marker (#151).
const assignedNames = (slots: AgendaSlot[]): string[] =>
	slots.filter((s) => s.assigneeName != null).map((s) => assigneeDisplay(s));

const byRole = (slots: AgendaSlot[], role: RoleRef) =>
	slots.filter((s) => matchesRole(s, role.key, role.name));

/** The role's holder as a `LegendEntry`, or null when the club runs no such
 *  role — the deck's equivalent of the run sheet's owner resolution. The role
 *  is named as the CLUB names it (`roleName`, not `role.name`), so a rename
 *  follows through to the slide the way it follows through to the printed row. */
function holder(slots: AgendaSlot[], role: RoleRef): LegendEntry | null {
	const [s] = byRole(slots, role);
	return s ? { role: s.roleName, name: assigneeDisplay(s) } : null;
}

/**
 * Push a hand-off slide when both the introducer and the target exist.
 *
 * The two conditions are the run sheet's two, in the same order: `from` is the
 * beat's resolved owner (already through its `fallbacks`, at the call site), and
 * `present` is its `requiresAnyOf` gate — a hand-off must never promise the room
 * someone the club is not running, and carries no `renderUnowned`, so an
 * unowned hand-off is dropped rather than projected against a bare role name.
 */
function pushHandoff(
	deck: Slide[],
	from: LegendEntry | null,
	to: HandoffTarget,
	present: boolean,
): void {
	if (from != null && present) deck.push({ kind: "handoff", from, to });
}

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
 *  sixth positional argument behind two optional ones.
 *
 *  The config is REQUIRED — `buildRunOfShow` requires it too, and a caller that
 *  forgot it would otherwise silently project the standard flow at a club that
 *  runs MCF's variant. `nextMeetingAt`/`meetingNumber` stay optional because
 *  null is a meaningful value for both. */
export type SlideDeckInput = RunOfShowConfig & {
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
	geIntroducesFunctionaries,
}: SlideDeckInput): Slide[] {
	const deck: Slide[] = [];
	// The same run-of-show the printed agenda expands, built from the same club
	// config — so the durations the deck projects ARE the ones the timeline
	// books, rather than a second set of numbers that happens to match (#356).
	const runOfShow = buildRunOfShow({ geIntroducesFunctionaries });

	deck.push({
		kind: "title",
		clubName: club.name,
		district: club.district,
		clubNumber: club.clubNumber,
		meetingNumber,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone: club.timezone,
	});

	// The Toastmaster of the Day opens the meeting. Gated on the role having a
	// slot, exactly as `expandRunSheet` gates the beat — a club that does not run
	// a Toastmaster of the Day (#368) neither prints the row nor projects the
	// slide. An enabled-but-unclaimed role still has a slot and still renders, as
	// the open placeholder.
	const toastmaster = byRole(slots, ROLE.toastmaster);
	if (toastmaster.length > 0) {
		deck.push({ kind: "toastmaster", name: assigneeDisplay(toastmaster[0]) });
	}

	const themeText = meeting.theme?.trim() || null;
	const wodWord = meeting.wordOfTheDay?.trim() || null;
	if (themeText || wodWord) {
		deck.push({ kind: "toastmasterIntro", theme: themeText, word: wodWord });
	}

	// The one signal all three vote slides share (see `VoteTiming`), read once so
	// they cannot disagree about whether the club runs a Timer.
	const hasTimer = byRole(slots, ROLE.timer).length > 0;

	// Still part of the Toastmaster's opening (#354): the word was just announced
	// on the intro slide, so its definition and example belong here — before the
	// functionaries are introduced, not several beats downstream of them. The
	// Grammarian presents it, and the slide says so, since sitting inside the
	// Toastmaster's opening would otherwise imply the Toastmaster does.
	const wodDefinition = meeting.wodDefinition?.trim() || null;
	const wodExample = meeting.wodExample?.trim() || null;
	if (wodWord && (wodDefinition || wodExample)) {
		const grammarian = byRole(slots, ROLE.grammarian);
		deck.push({
			kind: "wordOfDay",
			word: wodWord,
			definition: wodDefinition,
			example: wodExample,
			presenter:
				grammarian.length > 0
					? {
							role: grammarian[0].roleName,
							name: assigneeDisplay(grammarian[0]),
						}
					: null,
		});
	}

	const generalEvaluator = byRole(slots, ROLE.generalEvaluator);
	/** The two other owners the slides below resolve, hoisted for the same reason
	 *  `geOwner` is: they are each read from four or five places, and a re-derived
	 *  `holder()` is a place that can start answering differently. */
	const tmOwner = holder(slots, ROLE.toastmaster);
	const ttOwner = holder(slots, ROLE.tableTopicsMaster);
	/**
	 * Whoever is actually doing the General Evaluator's job this meeting (#363).
	 *
	 * The `??` IS the run sheet's `GE_COVERED_BY_TOASTMASTER` fallback, which the
	 * five GE-owned beats share: at a club that runs no General Evaluator the
	 * Toastmaster of the Day covers the whole role — introduces the evaluators,
	 * calls the Best-Evaluator vote, evaluates the evaluators, calls for the
	 * functionary reports, gives the overall evaluation. Read once here so the
	 * five places below cannot answer it five ways; the printed rows resolve the
	 * same question through one shared constant for the same reason.
	 *
	 * `null` only when neither role has a slot — then the beats have nowhere to
	 * fall back to and both surfaces drop the section together.
	 */
	const geOwner = holder(slots, ROLE.generalEvaluator) ?? tmOwner;
	// The functionary intro. Gated exactly as the run sheet gates it: the owning
	// role has a slot AND the club runs at least one functionary to introduce.
	const introOwner = geIntroducesFunctionaries
		? ROLE.generalEvaluator
		: ROLE.toastmaster;
	const introOwnerSlots = byRole(slots, introOwner);
	const anyFunctionary = hasAnyFunctionaryRole(slots);
	// MCF's variant only, and only when there is a General Evaluator to introduce
	// (#363): the Toastmaster hands the room to the GE, who then runs the
	// functionary intro below. The standard flow has no early GE appearance, so
	// `buildRunOfShow` emits no such beat there either.
	if (geIntroducesFunctionaries) {
		pushHandoff(
			deck,
			tmOwner,
			"the General Evaluator",
			generalEvaluator.length > 0,
		);
	}
	if (introOwnerSlots.length > 0 && anyFunctionary) {
		deck.push({
			kind: "functionaryIntro",
			owner: introOwner.name,
			name: assigneeDisplay(introOwnerSlots[0]),
			team: buildLegend(slots),
		});
	}

	// Bound by role key, like the run sheet's speaker beat — NOT by the
	// `isSpeakerRole` flag, which a club-invented role can also carry. Such a
	// role binds to no beat (correct, per the spec), so it must project no
	// slide and win no Best-Speaker vote either.
	const speakers = byRole(slots, ROLE.speaker).sort(
		(a, b) => a.slotIndex - b.slotIndex,
	);
	pushHandoff(deck, tmOwner, "the speakers", speakers.length > 0);
	if (speakers.length > 0) {
		const multi = speakers.length > 1;
		speakers.forEach((s, i) => {
			deck.push({
				kind: "speech",
				label: speechLabel(i, multi),
				speaker: assigneeDisplay(s),
				title: s.speechTitle,
				projectLevel: s.projectLevel,
				time: speechTime(s),
				link: s.presentationUrl ?? null,
			});
		});
		deck.push({
			kind: "voteSpeaker",
			names: assignedNames(speakers),
			hasTimer,
			caller: tmOwner,
		});
	}

	const tableTopics = byRole(slots, ROLE.tableTopicsMaster);
	pushHandoff(deck, tmOwner, "the Table Topics Master", tableTopics.length > 0);
	if (tableTopics.length > 0) {
		deck.push({
			kind: "tableTopics",
			master: assigneeDisplay(tableTopics[0]),
			timing: TABLE_TOPICS_TIMING,
			// Gated on the word alone (#355) — the definition rides along when the
			// meeting has one. Read from the same trimmed values the opening slides
			// use, so a whitespace-only field is blank everywhere.
			word: wodWord,
			definition: wodWord ? wodDefinition : null,
		});
		deck.push({
			kind: "voteTableTopics",
			hasTimer,
			caller: ttOwner,
		});
	}

	// The Table Topics Master is holding the room when the segment ends, so they
	// hand it to the General Evaluator. The `??` is the beat's `fallbacks: [{
	// unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE }]`: with no Table Topics
	// segment the Toastmaster never gave the room away, so the hand-off stays on
	// them rather than disappearing (#363).
	pushHandoff(
		deck,
		ttOwner ?? tmOwner,
		"the General Evaluator",
		generalEvaluator.length > 0,
	);

	const evaluators = orderEvaluators(byRole(slots, ROLE.evaluator), slots);
	// Likewise the evaluators' hand-off falls back to the Toastmaster at a club
	// with no General Evaluator — somebody still has to introduce them.
	pushHandoff(deck, geOwner, "the speech evaluators", evaluators.length > 0);
	if (evaluators.length > 0) {
		const multi = evaluators.length > 1;
		evaluators.forEach((s, i) => {
			deck.push({
				kind: "evaluation",
				label: numbered("Evaluation", i, multi),
				evaluator: assigneeDisplay(s),
				speaker: s.evaluates?.speakerName ?? null,
				time: beatDuration(runOfShow, "evaluation"),
			});
		});
		deck.push({
			kind: "voteEvaluator",
			names: assignedNames(evaluators),
			hasTimer,
			// The Best-Evaluator vote beat carries TWO fallbacks (#363); this is the
			// second one — the Toastmaster calls the vote at a club with no General
			// Evaluator. The first only rewrites copy (`hasTimer`, above).
			caller: geOwner,
		});
	}

	// The General Evaluator's closing sequence: evaluate the evaluators, call for
	// the functionary reports, then give the overall meeting evaluation. All
	// three follow `geOwner`, so the Toastmaster covers them at a club that runs
	// no GE and they disappear only when there is nobody to cover either; the
	// reports slide additionally needs functionaries to call for.
	// Gated on the EVALUATORS as well as the owner, mirroring the beat's
	// `requiresAnyOf: [EVALUATOR_ROLE]` — which reverses #367's call that this
	// slide follows the General Evaluator alone (#363). There is nothing to
	// evaluate at a club that runs no evaluators, whoever is holding the room.
	if (geOwner != null && evaluators.length > 0) {
		deck.push({
			kind: "evaluatorEvaluation",
			owner: geOwner.role,
			name: geOwner.name,
			time: beatDuration(runOfShow, "evaluatorEvaluation"),
		});
	}

	// The functionary-reports gate is functionaries who REPORT (#371), not
	// functionaries: a club whose only functionary is a Vote Counter has nobody
	// to call on, and the team lists the same subset so the slide never names
	// someone with no report.
	if (geOwner != null && hasAnyReportingFunctionaryRole(slots)) {
		deck.push({
			kind: "functionaryReports",
			owner: geOwner.role,
			name: geOwner.name,
			team: buildReportingLegend(slots),
		});
	}

	if (geOwner != null) {
		deck.push({
			kind: "generalEvaluation",
			owner: geOwner.role,
			name: geOwner.name,
			time: beatDuration(runOfShow, "generalEvaluation"),
		});
	}

	const awardCategories: string[] = [];
	if (tableTopics.length > 0) awardCategories.push("Best Table Topic");
	if (evaluators.length > 0) awardCategories.push("Best Evaluator");
	if (speakers.length > 0) awardCategories.push("Best Speaker");
	if (awardCategories.length > 0) {
		deck.push({ kind: "awards", categories: awardCategories });
	}

	// Guest comments (#352), between the awards and the announcements. Ungated,
	// like the beat: the club cannot know in advance whether guests will be in
	// the room.
	deck.push({ kind: "guestComments" });

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
