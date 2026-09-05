import type {
	AgendaSlot,
	LegendEntry,
	RunOfShowConfig,
} from "./agenda-runsheet";
import {
	assigneeDisplay,
	beatTiming,
	buildLegend,
	buildReportingLegend,
	buildRunOfShow,
	clubRoleName,
	HANDOFF_ROLES,
	hasAnyFunctionaryRole,
	hasAnyReportingFunctionaryRole,
	introducedNames,
	matchesRole,
	numbered,
	orderEvaluators,
} from "./agenda-runsheet";
import type { BeatTiming } from "./agenda-template-slides";
import {
	type SpeechWindowInput,
	speechBookedMinutes,
	speechWindow,
} from "./speech-window";
import {
	formatTableTopicsTiming,
	type TableTopicsLimits,
} from "./table-topics-limits";

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
	/**
	 * Versioned logo URL, or null. Built by the caller via `clubLogoUrl`.
	 *
	 * Required rather than optional, matching `clubNumber`/`district` below: a
	 * new deck caller that omits it should get a type error, not a silently
	 * logo-less deck. The whole point of this feature is that the logo appears
	 * on every surface, and an optional field is how those surfaces drift apart
	 * again. Both existing callers already pass it, so this costs nothing.
	 */
	logoUrl: string | null;
	clubNumber: string | null;
	district: string | null;
	timezone: string;
	meetingSchedule: string | null;
	/**
	 * The club's Table Topics window in SECONDS, or null for the standard one
	 * (#443). Required rather than optional for the same reason `logoUrl` is: a
	 * new deck caller that omits it should get a type error, not a projector
	 * quietly telling the room 1–2 minutes at a club whose own agenda says 2:30.
	 * That contradiction is the bug this feature exists to close.
	 */
	tableTopicsMinSeconds: number | null;
	tableTopicsMaxSeconds: number | null;
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
	/** Absolute URL of this meeting's public ballot (#510), rendered as a QR on
	 *  the slide. The projector is already showing "Vote for Best Speaker" at
	 *  exactly the moment people need to scan, which beats a printed footer. */
	ballotUrl: string;
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
			/** Versioned `/api/club/:id/logo?v=` URL, or null when the club has
			 *  none. Carried on the descriptor so BOTH renderers place the logo
			 *  from one source of truth — the HTML deck uses this URL directly;
			 *  the PPTX export cannot (it runs in the browser and embeds bytes),
			 *  so `deckToPptx` takes the encoded image separately and uses this
			 *  only as the has-a-logo signal. */
			logoUrl: string | null;
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
			/** IDENTITY. Stays canonical English: it keys `HANDOFF_HEADER` (the
			 *  jump-grid label) and `HANDOFF_SECTION` (the parity identity). */
			to: HandoffTarget;
			/** DISPLAY. What the slide actually reads, so a club that renamed the
			 *  target sees ITS name (#462). Equals `to` unless the club renamed the
			 *  role, and only the two singular-role targets can differ — "the
			 *  speakers" and "the speech evaluators" name a group, not a role. */
			toLabel: string;
			/** WHO is being introduced — assigned holders only, in slot order
			 *  (#585). Empty when nobody holds the target role, which is the case a
			 *  club with an open slot lands in; the slide then reads exactly as it
			 *  did before, naming the role alone.
			 *
			 *  Deliberately excludes the "— open —" placeholder, unlike `from.name`
			 *  two fields up. The two are different statements: `from` names the
			 *  person the room is looking at, where an unclaimed role still has to be
			 *  announced as unclaimed, while this is a list of people to introduce
			 *  and an open slot contributes nobody to it. The printed hand-off band's
			 *  `{names:…}` token drops it for the same reason, and
			 *  `agenda-parity.test.ts` holds the two surfaces to the same answer. */
			toNames: string[];
	  }
	| { kind: "toastmasterIntro"; theme: string | null; word: string | null }
	| {
			/** The Word of the Day in full — word, definition, example — projected
			 *  inside the opening, at the beat the Grammarian actually delivers it.
			 *  #354 moved it out of the General Evaluator's closing section, where
			 *  the room saw the word, sat through several beats, and only then
			 *  learned what it meant; #581 moved it the last beat under MCF's
			 *  variant, from ahead of the hand-off to the GE to just after the
			 *  functionary intro. See the two pushes in `buildSlideDeck`.
			 *  Content-gated (needs a definition or an example), not role-gated,
			 *  which is why it has no run-sheet beat of its own. */
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
			/** Display name of the role giving it — see `functionaryReports.owner`.
			 *  No `name`: unlike the other two owner-carrying slides, this one has
			 *  never named the holder (`slideLayout` says why), so carrying one made
			 *  it write-only. */
			owner: string;
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
	/**
	 * The two TEMPLATED-meeting kinds (#agenda-templates). Built by
	 * `buildTemplateSlideDeck`, never by `buildSlideDeck` — a templated meeting
	 * gets one or the other deck, never a mix, because the standard builder's
	 * slides are bound to standard role keys a template does not have.
	 *
	 * They live on this union rather than a parallel one so `slideLayout`,
	 * `slideName`, the jump grid and `deckToPptx` need no new dispatch: a
	 * template deck IS a `Slide[]`, and every consumer already handles one.
	 */
	| {
			/** A round divider — "PREPARED SPEECH CONTEST". */
			kind: "templateSection";
			title: string;
	  }
	| {
			kind: "templateBeat";
			/** The row's `who`: numbered label plus assignee on a role row. */
			label: string;
			detail: string | null;
			minutes: number;
			/** Clock text for the beat's marks, or null when untimed. Precomputed
			 *  like `speech`'s `time`, so both renderers read one string and the
			 *  ±30s grace rule is applied in exactly one place. */
			timing: BeatTiming | null;
	  }
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
	toLabel: string = to,
	// NO DEFAULT, deliberately (#585). `Slide.handoff.toNames` is required for a
	// reason — a sixth hand-off added without names should be a type error, not a
	// slide that silently omits the people, which is the bug this closed. A `= []`
	// here would have disarmed that from the one place it is constructed.
	toNames: string[],
): void {
	if (from != null && present)
		deck.push({ kind: "handoff", from, to, toLabel, toNames });
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
 *  `geIntroducesFunctionaries` is REQUIRED — `buildRunOfShow` requires it too,
 *  and a caller that forgot it would otherwise silently project the standard
 *  flow at a club that runs MCF's variant. `nextMeetingAt`/`meetingNumber` stay
 *  optional because null is a meaningful value for both.
 *
 *  `tableTopicsLimits` is OMITTED from the config rather than inherited: this
 *  builder reads that window off `club` and would silently IGNORE a field of
 *  the same name passed here, which is two ways to state one fact with one of
 *  them inert. Omitting it makes that a type error instead. */
export type SlideDeckInput = Omit<RunOfShowConfig, "tableTopicsLimits"> & {
	meeting: MeetingForDeck;
	club: ClubForDeck;
	slots: AgendaSlot[];
	/** Backs the Thank-You slide; null when the club has nothing scheduled after. */
	nextMeetingAt?: Date | null;
	/** The club's effective meeting number (#358) — stored or derived upstream. */
	meetingNumber?: number | null;
	/** Absolute URL of this meeting's public ballot (#510), carried onto every
	 *  vote slide. Required rather than defaulted: building it needs the
	 *  request's origin, which this pure deck builder has no business knowing —
	 *  a caller that forgot it should get a type error, not a QR that renders
	 *  a relative path nobody's camera can scan. */
	ballotUrl: string;
};

export function buildSlideDeck({
	meeting,
	club,
	slots,
	nextMeetingAt = null,
	meetingNumber = null,
	geIntroducesFunctionaries,
	ballotUrl,
}: SlideDeckInput): Slide[] {
	const deck: Slide[] = [];
	// The same run-of-show the printed agenda expands, built from the same club
	// config — so the durations the deck projects ARE the ones the timeline
	// books, rather than a second set of numbers that happens to match (#356).
	// The club's Table Topics window travels into the run of show too, so the
	// Timer's marks and the "Speaker time:" line this deck projects derive from
	// the same two numbers — the single-sourcing the durations already get
	// (#356).
	//
	// The PRINTED row gets there by its own path: `resolveAgendaRows` takes the
	// same limits and forwards them, and takes them as a REQUIRED field so a
	// route cannot omit them. The first cut wired only this call, which printed
	// red at 2:00 beside a deck saying 2:30 — the contradiction #443 exists to
	// close, inverted. `table-topics-limits-wiring.guard.test.ts` pins both.
	const tableTopicsLimits: TableTopicsLimits = {
		minSeconds: club.tableTopicsMinSeconds,
		maxSeconds: club.tableTopicsMaxSeconds,
	};
	const runOfShow = buildRunOfShow({
		geIntroducesFunctionaries,
		tableTopicsLimits,
	});

	deck.push({
		kind: "title",
		clubName: club.name,
		logoUrl: club.logoUrl ?? null,
		district: club.district,
		clubNumber: club.clubNumber,
		meetingNumber,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone: club.timezone,
	});

	/** The two segment owners the slides below resolve, hoisted for the same
	 *  reason `geOwner` is: they are each read from four or five places, and a
	 *  re-derived `holder()`/`byRole()` is a place that can start answering
	 *  differently. Non-null IS the "the club runs this role" gate — `holder`
	 *  returns an entry for an enabled-but-unclaimed slot too, carrying the open
	 *  placeholder as its name. */
	const tmOwner = holder(slots, ROLE.toastmaster);
	const ttOwner = holder(slots, ROLE.tableTopicsMaster);

	// The Toastmaster of the Day opens the meeting. Gated on the role having a
	// slot, exactly as `expandRunSheet` gates the beat — a club that does not run
	// a Toastmaster of the Day (#368) neither prints the row nor projects the
	// slide. An enabled-but-unclaimed role still has a slot and still renders, as
	// the open placeholder.
	if (tmOwner) {
		deck.push({ kind: "toastmaster", name: tmOwner.name });
	}

	const themeText = meeting.theme?.trim() || null;
	const wodWord = meeting.wordOfTheDay?.trim() || null;
	if (themeText || wodWord) {
		deck.push({ kind: "toastmasterIntro", theme: themeText, word: wodWord });
	}

	// The one signal all three vote slides share (see `VoteTiming`), read once so
	// they cannot disagree about whether the club runs a Timer.
	const hasTimer = byRole(slots, ROLE.timer).length > 0;

	/**
	 * The Word of the Day in full — word, definition, example. Built here and
	 * pushed below at whichever point in the opening the club actually delivers
	 * it; `null` when there is nothing to show. Content-gated (needs a definition
	 * or an example), not role-gated, which is why it has no run-sheet beat of its
	 * own.
	 *
	 * The Grammarian presents it and the slide says so, since sitting inside the
	 * Toastmaster's opening would otherwise imply the Toastmaster does (#354).
	 */
	const wodDefinition = meeting.wodDefinition?.trim() || null;
	const wodExample = meeting.wodExample?.trim() || null;
	const grammarian = byRole(slots, ROLE.grammarian);
	const wodSlide: Slide | null =
		wodWord && (wodDefinition || wodExample)
			? {
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
				}
			: null;

	// Standard flow: still part of the Toastmaster's opening (#354). The word was
	// just announced on the intro slide, so its definition and example belong
	// here — before the functionaries are introduced, not several beats
	// downstream of them, which is where #354 found it and rightly moved it from.
	//
	// Under MCF's variant it moves again, to just after the functionary intro —
	// see the second push below (#581).
	if (!geIntroducesFunctionaries && wodSlide) deck.push(wodSlide);

	const generalEvaluator = byRole(slots, ROLE.generalEvaluator);
	/**
	 * Whoever is actually doing the General Evaluator's job this meeting (#363).
	 *
	 * The `??` IS the run sheet's `GE_COVERED_BY_TOASTMASTER` fallback, which
	 * every GE-owned beat shares: at a club that runs no General Evaluator the
	 * Toastmaster of the Day covers the whole role — introduces the evaluators,
	 * calls the Best-Evaluator vote, evaluates the evaluators, calls for the
	 * functionary reports, gives the overall evaluation, and under MCF's variant
	 * introduces the functionaries too. Read once here so the places below cannot
	 * answer it several ways; the printed rows resolve the same question through
	 * one shared constant for the same reason.
	 *
	 * `null` only when neither role has a slot — then the beats have nowhere to
	 * fall back to and both surfaces drop the section together.
	 */
	const geOwner = holder(slots, ROLE.generalEvaluator) ?? tmOwner;
	// The functionary intro. Gated exactly as the run sheet gates it: the owning
	// role has a slot AND the club runs at least one functionary to introduce.
	// Under MCF's variant the owner IS the General Evaluator, so it resolves
	// through `geOwner` and inherits that role's cover — the beat's own
	// `GE_COVERED_BY_TOASTMASTER` fallback (#363). Without it a club on that
	// variant with functionaries but no GE projected no intro slide while still
	// projecting the reports slide that cues those same functionaries.
	// The CLUB's name for the two hand-off targets that name ONE role (#462), so
	// the slide stops showing our word for a role the club renamed. Falls back to
	// the canonical name, which is exactly what `to` already is.
	const geLabel =
		clubRoleName("general_evaluator", slots) ?? "General Evaluator";
	const ttmLabel =
		clubRoleName("table_topics_master", slots) ?? "Table Topics Master";
	const introOwner = geIntroducesFunctionaries ? geOwner : tmOwner;
	const anyFunctionary = hasAnyFunctionaryRole(slots);
	// MCF's variant only, and only when there is a General Evaluator to introduce
	// (#363): the Toastmaster hands the room to the GE, who then runs the
	// functionary intro below. The standard flow has no early GE appearance, so
	// `buildRunOfShow` emits no such beat there either.
	//
	// Also gated on the functionaries (#449): this hand-off exists solely to set
	// up the functionary intro immediately below, which has its own
	// `anyFunctionary` gate. Without the same gate a club with a GE and no
	// functionaries was handed the room and given it straight back. The printed
	// beat carries `requiresGroup: "functionaries"` for the same reason — both
	// surfaces read the same signal, so both must read this one.
	if (geIntroducesFunctionaries) {
		pushHandoff(
			deck,
			tmOwner,
			"the General Evaluator",
			generalEvaluator.length > 0 && anyFunctionary,
			`the ${geLabel}`,
			introducedNames(slots, HANDOFF_ROLES.generalEvaluator),
		);
	}
	if (introOwner != null && anyFunctionary) {
		deck.push({
			kind: "functionaryIntro",
			// The CLUB's name for the role, per `holder` — the same rule the deck's
			// other owner-carrying slides follow. Resolving the owner through
			// `geOwner` forces the choice: the canonical constant would announce
			// "General Evaluator" over the Toastmaster who is covering.
			owner: introOwner.role,
			name: introOwner.name,
			team: buildLegend(slots),
		});
	}

	/**
	 * MCF's variant: the Word of the Day lands HERE, after the functionaries have
	 * been introduced (#581).
	 *
	 * This is where the run sheet has always said it happens — the
	 * functionary-intro beat reads "…each explains their role · the Grammarian
	 * gives the Word of the Day" (#508). Projecting the definition earlier put it
	 * in front of a room that had not yet met the Grammarian, and #354's own
	 * reasoning asked for this position in the first place: *"the Grammarian gives
	 * the Word of the Day at the top of the meeting, when the Toastmaster
	 * introduces the functionaries and each explains their role."*
	 *
	 * Only under the variant, and the asymmetry is real rather than a hedge. In
	 * the standard flow the earlier slide sits between two Toastmaster beats — one
	 * continuous opening, so it reads as part of it. Under MCF it sits between the
	 * Toastmaster's intro and the hand-off to the General Evaluator, interrupting
	 * a role change to show a word the next role along is about to present.
	 *
	 * Pushed after the intro slide but ahead of everything downstream, so a club
	 * running no functionaries at all (no intro slide) still gets the word inside
	 * the opening rather than losing it.
	 */
	if (geIntroducesFunctionaries && wodSlide) deck.push(wodSlide);

	// Bound by role key, like the run sheet's speaker beat — NOT by the
	// `isSpeakerRole` flag, which a club-invented role can also carry. Such a
	// role binds to no beat (correct, per the spec), so it must project no
	// slide and win no Best-Speaker vote either.
	const speakers = byRole(slots, ROLE.speaker).sort(
		(a, b) => a.slotIndex - b.slotIndex,
	);
	pushHandoff(
		deck,
		tmOwner,
		"the speakers",
		speakers.length > 0,
		"the speakers",
		// Empty, matching the printed row (#585): the speech slides that follow
		// name every one of these people, so listing them here duplicated the next
		// slide. See the run sheet's speakers hand-off for the measurement.
		[],
	);
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
			ballotUrl,
		});
	}

	pushHandoff(
		deck,
		tmOwner,
		"the Table Topics Master",
		ttOwner != null,
		`the ${ttmLabel}`,
		introducedNames(slots, HANDOFF_ROLES.tableTopicsMaster),
	);
	if (ttOwner) {
		deck.push({
			kind: "tableTopics",
			master: ttOwner.name,
			// The one duration on the deck that is NOT a beat's budget (#356), and
			// the reason it is exempt: this is the limit on a SINGLE impromptu
			// answer, while the Table Topics beat books the whole SEGMENT.
			// Deriving it would project "Speaker time: 10 minutes" at a speaker who
			// has one to two — a per-speaker versus per-segment difference, not a
			// disagreement. The segment number is also the one the deck could never
			// state honestly: `applyFlex` resizes that beat at render time to
			// whatever makes the meeting come out to its scheduled length, and the
			// deck is not given that length.
			//
			// #443 made the VALUE per-club. The old `TABLE_TOPICS_TIMING` export is
			// GONE rather than aliased: a grep found no importer anywhere, so a
			// shim would have been dead code whose comment claimed callers that do
			// not exist. (`agenda-runsheet.ts` kept its `TABLE_TOPICS_MARKS`
			// re-export for the opposite reason — that one HAS importers. The two
			// decisions look contradictory four files apart and are not.)
			timing: formatTableTopicsTiming(tableTopicsLimits),
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
			ballotUrl,
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
		`the ${geLabel}`,
		introducedNames(slots, HANDOFF_ROLES.generalEvaluator),
	);

	const evaluators = orderEvaluators(byRole(slots, ROLE.evaluator), slots);
	// Likewise the evaluators' hand-off falls back to the Toastmaster at a club
	// with no General Evaluator — somebody still has to introduce them.
	pushHandoff(
		deck,
		geOwner,
		"the speech evaluators",
		evaluators.length > 0,
		"the speech evaluators",
		// Empty for the same reason as the speakers hand-off above.
		[],
	);
	if (evaluators.length > 0) {
		const multi = evaluators.length > 1;
		evaluators.forEach((s, i) => {
			deck.push({
				kind: "evaluation",
				label: numbered("Evaluation", i, multi),
				evaluator: assigneeDisplay(s),
				speaker: s.evaluates?.speakerName ?? null,
				time: beatTiming(runOfShow, "evaluation"),
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
			ballotUrl,
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
			time: beatTiming(runOfShow, "evaluatorEvaluation"),
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
			time: beatTiming(runOfShow, "generalEvaluation"),
		});
	}

	const awardCategories: string[] = [];
	if (ttOwner) awardCategories.push("Best Table Topics");
	if (evaluators.length > 0) awardCategories.push("Best Evaluator");
	if (speakers.length > 0) awardCategories.push("Best Speaker");
	if (awardCategories.length > 0) {
		deck.push({ kind: "awards", categories: awardCategories });
	}

	// Announcements before guest comments (#442), matching the run sheet's
	// closing order: the club finishes its own business, then hands the floor to
	// visitors and ends on that.
	if (meeting.reminders?.trim()) {
		deck.push({ kind: "reminders", text: meeting.reminders.trim() });
	}

	// Guest comments (#352), after the announcements and before the closing
	// splash. Ungated, like the beat: the club cannot know in advance whether
	// guests will be in the room.
	deck.push({ kind: "guestComments" });

	deck.push({
		kind: "thankYou",
		meetingSchedule: club.meetingSchedule,
		nextMeetingAt,
		timezone: club.timezone,
	});

	return deck;
}
