/**
 * The pre-meeting jobs each role owns, keyed by `role_definitions.key` (#660).
 *
 * The pure spine behind role checklists, duty-aware nudge drafts and the
 * personal confirm page. Each duty knows three things: how to tell it is
 * ALREADY DONE from data the caller already loaded, WHERE to go and do it, and
 * the CLAUSE a nudge should use while it is still outstanding.
 *
 * ## Why this lives in `src/lib`
 *
 * Both halves of the app need it — the checklist UI and nudge draft on the
 * client, the reminder-email producer on the server — and a module that reaches
 * the database layer cannot be imported by a client route at all (the driver
 * drags `Buffer` in and white-screens the page). It also has to be ASSERTABLE:
 * per the #519/#522 lesson, a predicate living inside a `createServerFn`
 * handler, or beside a database import, is unreachable from vitest and can be
 * gutted with the whole suite green. So the registry is db-free by
 * construction, and `role-duties.test.ts` fails if that ever stops being true.
 *
 * ## Only three duties, and the emptiness is the design
 *
 * Every other role — Timer, Ah-Counter, General Evaluator, Vote Counter, Table
 * Topics Master, Evaluator, and any club-invented role — owns ZERO duties and
 * gets `ROLE_CONFIRM_PROMPT` instead. Their prep is real, but it has nowhere to
 * be recorded, so a checkbox for it could only be a self-report nobody can
 * verify — and an unverifiable tick must never be allowed to SUPPRESS a nudge.
 * Table Topics' "prepare 8-10 questions" is the one that most looks like it
 * belongs here; it is out because giving it a duty means giving it a column and
 * a write path, which is its own issue if we ever want it.
 */
import {
	GRAMMARIAN_ROLE_KEY,
	isGrammarianRoleName,
	isTmodRoleName,
	type RoleIdentity,
	TMOD_ROLE_KEY,
} from "#/lib/meeting-roles";
import { isRealSpeechTitle } from "#/lib/speech-title";

/**
 * The keys of every role whose holder owes a SPEECH. Declared here rather than
 * imported from `meeting-roles.ts`, which deliberately holds only the three
 * roles carrying a CAPABILITY (self-serve editing, the Word of the Day, the
 * digital votes); owing a duty is a different thing.
 *
 * `contestant_prepared` is the one that is easy to miss, and leaving it out was
 * a real bug in this module's first cut. `contest-template.ts` declares it the
 * template's ONLY `isSpeakerRole` def and states plainly that "a contest speech
 * is still a speech, so the speech record, the project picker and Pathways
 * attribution all work against a contestant slot with no special-casing" — so a
 * contestant has a `speeches` row with a title exactly like a Speaker, and
 * keying only on `speaker` told the one person in the room who demonstrably
 * owes a speech that they owe nothing.
 *
 * Note the shape of the near-miss: everywhere ELSE in the app, "is this slot a
 * speech?" is answered from the `role_definitions.isSpeakerRole` COLUMN
 * (`pickSpeakerAndEvaluatorRoles`, `pairedRoleIds`, `updateSpeakerDetails`'s own
 * guard), so a key list here is a second and narrower definition than the one
 * the database models. It stays a list because the duty must be resolvable from
 * a role identity alone, with no column to hand — and `role-duties.test.ts`
 * closes the gap by sweeping BOTH role templates and failing on any
 * `isSpeakerRole` seed that is not registered here. A new speaker-ish template
 * role is therefore enrolled by a failing test rather than by memory.
 */
const SPEAKER_ROLE_KEY = "speaker";
const CONTESTANT_ROLE_KEY = "contestant_prepared";

/**
 * Canonical NAME → key, for the name fallback a key-NULL row falls to. Matched
 * EXACTLY (trimmed, case-folded), never as a prefix — the same rule, and the
 * same reason, as `isTmodRoleName` next door: every club-invented role has a
 * NULL key, so a prefix match would hand "Speaker Coach" a speech to write
 * (#464).
 *
 * A MAP from name to key, rather than comparing a name against the key
 * constant, because the two are different things and this module briefly
 * conflated them: `name.trim().toLowerCase() === SPEAKER_ROLE_KEY` worked only
 * because the Speaker's name and key happen to coincide. Renaming the key would
 * then have silently redefined which human name matches — and `contestant_prepared`
 * does not coincide at all, so the bug had no way to stay hidden once the
 * contestant was registered.
 */
const SPEECH_ROLE_KEY_BY_CANONICAL_NAME: ReadonlyMap<string, string> = new Map([
	["speaker", SPEAKER_ROLE_KEY],
	["contestant", CONTESTANT_ROLE_KEY],
]);

/** Stable ids, safe to persist and to switch on. Never the label, which is copy. */
export type DutyId = "meeting_theme" | "word_of_the_day" | "speech_details";

/**
 * What `done` reads: a plain object the caller ALREADY holds, never a db
 * handle. Every consumer — checklist, nudge draft, reminder email — therefore
 * asks the identical question, which is the point. Two consumers each deriving
 * "is the theme set?" is how they come to disagree, and disagreement here means
 * nudging somebody about a job they already did.
 *
 * Every field is optional so a caller that loaded only what it needs can pass
 * only that; an absent field is NOT DONE, exactly like a blank one.
 */
export interface DutyContext {
	/** `meetings.theme`. */
	theme?: string | null;
	/** `meetings.word_of_the_day`. */
	wordOfTheDay?: string | null;
	/** The slot's `speeches.title`. */
	speechTitle?: string | null;
}

/** The meeting a duty is being resolved against — the `href` route params. */
export interface DutyTarget {
	clubId: string;
	meetingId: string;
}

export interface RoleDuty {
	id: DutyId;
	/** Sentence-case, for a checklist row. */
	label: string;
	/** Lower-case verb phrase, interpolated MID-SENTENCE into a nudge draft. */
	clause: string;
	/** True when the data says this is already handled. */
	done: (ctx: DutyContext) => boolean;
	/** App-relative path to where it gets done. Prepend an origin for an email. */
	href: (target: DutyTarget) => string;
}

/**
 * What a role that owns nothing gets instead. Deliberately NOT a `RoleDuty`:
 * it carries no `done`, because there is nothing recorded to derive one from.
 * Giving it an always-false `done` would put a permanently-unticked box on the
 * checklist, and giving it a truthful one would need a self-report — the two
 * outcomes the empty registry above exists to avoid.
 */
export interface RoleConfirmPrompt {
	label: string;
	clause: string;
	href: (target: DutyTarget) => string;
}

/**
 * Blank and whitespace-only are NOT done, or a theme of `"  "` silently
 * suppresses the nudge that exists to get a real one set.
 */
const isFilled = (value: string | null | undefined): boolean =>
	typeof value === "string" && value.trim() !== "";

/**
 * All three duties are performed on the meeting page, which is where the theme
 * dialog, the Word of the Day dialog and the speech-details sheet all live
 * today. Kept per-duty rather than shared, because it is the seam #666 narrows
 * when the focused phone-sized subroutes land.
 *
 * Every segment is URL-safe by construction — a club slug, and a date-key or
 * uuid meeting id — so nothing needs escaping, the same argument
 * `buildAgendaSharePath` makes.
 */
const meetingHref = ({ clubId, meetingId }: DutyTarget): string =>
	`/club/${clubId}/meeting/${meetingId}`;

const MEETING_THEME_DUTY: RoleDuty = {
	id: "meeting_theme",
	label: "Set the meeting theme",
	clause: "set the meeting theme",
	done: (ctx) => isFilled(ctx.theme),
	href: meetingHref,
};

const WORD_OF_THE_DAY_DUTY: RoleDuty = {
	id: "word_of_the_day",
	label: "Set the Word of the Day",
	clause: "set the Word of the Day",
	done: (ctx) => isFilled(ctx.wordOfTheDay),
	href: meetingHref,
};

const SPEECH_DETAILS_DUTY: RoleDuty = {
	id: "speech_details",
	label: "Add your speech details",
	clause: "add your speech details",
	// NOT `isFilled`: a blank title is STORED as the `TBA` sentinel, so a
	// plain non-blank check reads the app's own placeholder as a finished
	// speech and suppresses the nudge this duty exists to send.
	done: (ctx) => isRealSpeechTitle(ctx.speechTitle),
	href: meetingHref,
};

/**
 * FROZEN, and that is load-bearing rather than tidy. This registry is a
 * module-level singleton, so `dutiesForRole` hands every caller the same array
 * and the same duty objects; `readonly` on the return type stops an in-repo
 * caller from pushing at COMPILE time and stops nothing at runtime. A cast, or
 * a consumer reassigning `duty.done`, would change the answer for every later
 * caller in the process — and on the server that process answers for every
 * club, so one bad write would suppress nudges club-wide until a redeploy.
 * Freezing is one pass at module load and removes the class.
 *
 * Shallow is enough: a duty's fields are strings and functions, with no nested
 * object to reach past.
 */
const freezeDuties = (duties: RoleDuty[]): readonly RoleDuty[] =>
	Object.freeze(duties.map((duty) => Object.freeze(duty)));

/** One shared empty result, so callers can compare cheaply and none can mutate
 *  a per-role array into another role's answer. */
const NO_DUTIES: readonly RoleDuty[] = Object.freeze([]);

/**
 * A `Map`, not an object literal: an object answers for `__proto__` and
 * `constructor`, so a `role_definitions.key` of either would resolve to
 * something that is not a duty list at all. The keys come from a database
 * column, so failing closed on every key we do not recognise has to be
 * structural rather than assumed.
 */
const DUTIES_BY_ROLE_KEY = new Map<string, readonly RoleDuty[]>([
	[TMOD_ROLE_KEY, freezeDuties([MEETING_THEME_DUTY])],
	[GRAMMARIAN_ROLE_KEY, freezeDuties([WORD_OF_THE_DAY_DUTY])],
	[SPEAKER_ROLE_KEY, freezeDuties([SPEECH_DETAILS_DUTY])],
	[CONTESTANT_ROLE_KEY, freezeDuties([SPEECH_DETAILS_DUTY])],
]);

/**
 * The role's canonical key, or null when nothing here recognises it.
 *
 * KEY FIRST, and a keyed row never falls through to the name pass — that
 * fall-through IS #464. A row keyed `table_topics_master` but named
 * "Toastmaster of the Day" must own no duty: the key is the identity and the
 * name merely looks like one. The name pass therefore runs only for a NULL key,
 * which is what every club-invented role carries (`createClubRole` never writes
 * one), and it matches canonical names exactly.
 *
 * An empty-string key is treated as a key — unrecognised, so no duties. That
 * matches `findCapabilityRole`'s `== null` gate next door; consistency with it
 * is worth more here than guessing that a blank key meant NULL, and both
 * directions fail closed.
 */
function resolveRoleKey(role: RoleIdentity): string | null {
	if (role.roleKey != null) return role.roleKey;
	if (isTmodRoleName(role.roleName)) return TMOD_ROLE_KEY;
	if (isGrammarianRoleName(role.roleName)) return GRAMMARIAN_ROLE_KEY;
	return (
		SPEECH_ROLE_KEY_BY_CANONICAL_NAME.get(role.roleName.trim().toLowerCase()) ??
		null
	);
}

/**
 * The pre-meeting duties this role owns, in the order they should be shown.
 * Empty for every role that has nowhere to record an answer — see the module
 * header — and empty for an unknown or NULL key, never a throw: this is read
 * while rendering a roster, so one club-invented role must not take the page
 * down with it.
 */
export function dutiesForRole(role: RoleIdentity): readonly RoleDuty[] {
	const key = resolveRoleKey(role);
	if (key === null) return NO_DUTIES;
	return DUTIES_BY_ROLE_KEY.get(key) ?? NO_DUTIES;
}

/**
 * The ask for a role with no recordable duty: confirm you are doing it, and
 * here is what it involves. Points at the club's own roles guide, which already
 * lists that club's roles and its own descriptions (#318).
 */
export const ROLE_CONFIRM_PROMPT: RoleConfirmPrompt = Object.freeze({
	label: "Confirm the role",
	clause: "confirm the role",
	href: ({ clubId }: DutyTarget) => `/club/${clubId}/roles-guide`,
});
