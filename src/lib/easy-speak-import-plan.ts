/**
 * The Easy-Speak import PLAN (#1051, part of #1054): a bundle plus what the club
 * already holds, turned into the exact set of things an apply would do, with
 * nothing written. Pure and client-safe (no `#/db`), so the preview page and the
 * apply see the same plan and a unit test can drive every case.
 *
 * What the plan decides, and what it refuses to decide:
 *
 * - **People** (decision 7). Each distinct person the imported records name
 *   resolves to a roster member by exact name, then by name ignoring case and
 *   accents. Two or more candidates is AMBIGUOUS and none is UNMATCHED, and both
 *   wait for a human: nobody is merged by guessing. The one automatic outcome for
 *   an unmatched name is a GUEST, and only for a name Easy-Speak itself lists in
 *   a guest category (guest speaker, visitor, past visitor, visitor from another
 *   club) and not on its member list. Any other unmatched name needs a human
 *   choice: a member, a guest, or a skip with a reason.
 * - **Roles.** `EASY_SPEAK_ROLE_MAP` names the standard roles; anything else
 *   becomes a role definition of the club's own.
 * - **People who are on a list only** (#1203). The member list, the mentor chart
 *   (both columns) and the speech requesters are people too: the mentor and
 *   speech-request steps find a person only through the `person` ref an apply
 *   wrote. They go through the same matching, but a person seen ONLY there is
 *   matched to the roster and never made: no match leaves them unmatched, they do
 *   not block the apply, and the later steps report them unresolved. Only a
 *   meeting appearance makes a guest. An AMBIGUOUS name from a list asks the same
 *   decision as one from a meeting, except that a guest is not on offer.
 * - **Meetings.** Past meetings only, each imported as `completed`. A future
 *   meeting keeps the live schedule and is listed, not written.
 *
 * The same module owns the RECONCILIATION arithmetic: what the bundle holds
 * ({@link expectedFromBundle}) against the source ids an apply left behind
 * ({@link buildReconciliation}). It lives beside the plan because both read the
 * bundle's records the same way, and two readers of one shape is how a count and
 * the thing it counts drift apart.
 */
import { z } from "zod";
import { zonedWallTimeToUtc } from "./datetime";
import type { EasySpeakBundleV1, EsPersonRef } from "./easy-speak-bundle";
import { ownRoleDisplayName, standardRoleKeyFor } from "./easy-speak-roles";
import {
	GUEST_KINDS,
	type GuestKind,
	readLegacyGuestKind,
} from "./guest-profile";
import { type OfficerPosition, parseOfficerPosition } from "./officers";
import { isValidEmail, parseRosterText } from "./roster-import";

type EsGuestCategory =
	EasySpeakBundleV1["meetings"][number]["guests"][number]["category"];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Case-, accent- and spacing-insensitive form of a name, for the second match pass. */
export function foldName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim();
}

/**
 * The key one person goes by across the whole bundle: Easy-Speak's user id when
 * the page linked a profile, else the folded name. `import_refs` rows of kind
 * `person` and `guest` use it as their `source_id`.
 */
export function personKeyOf(ref: EsPersonRef): string {
	return ref.esUserId ? `es:${ref.esUserId}` : `name:${foldName(ref.name)}`;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlanRosterMember {
	memberId: string;
	name: string;
}

export interface PlanRoleDefinition {
	id: string;
	key: string | null;
	name: string;
}

export interface PlanRef {
	kind: string;
	sourceId: string;
	targetId: string;
}

export interface PlanExistingMeeting {
	id: string;
	scheduledAt: Date;
	/** `meetings.status`: only a `completed` meeting may be adopted or updated (D1 of #1196). */
	status: string;
}

export interface PlanContext {
	/** What "past" is measured against: a meeting after this is future and not imported. */
	now: Date;
	/** The club's own zone, for a bundle instant that carries no offset. */
	clubTimezone: string;
	/** Every membership of the club, inactive ones included. */
	roster: PlanRosterMember[];
	roleDefinitions: PlanRoleDefinition[];
	/** The club's guests, by id, so a stale `guest` ref is not trusted. */
	guestIds: ReadonlySet<string>;
	existingMeetings: PlanExistingMeeting[];
	/** `import_refs` for this club and source. */
	refs: PlanRef[];
	/**
	 * Member ids the club removed (a `member_remove` activity row names them). A
	 * `person` ref to one of them whose row is gone is a removal, not a merge: not
	 * re-created. A merged-away member is not in it and is matched by name (D4).
	 */
	removedMemberIds?: ReadonlySet<string>;
	/** The human's choices, by person key. They win over every automatic outcome but a tombstone. */
	resolutions?: Readonly<Record<string, PersonResolution>>;
	/**
	 * The optional pasted contacts (`name, email, phone`, #1240). Read by the plan
	 * only to say which person gets which value; never stored by the import.
	 */
	contacts?: string;
	/**
	 * What the roster members already hold, by member id, and which Persons (any
	 * club) hold an email, by lower-cased email. Read only to place `contacts`.
	 */
	contactState?: {
		members: ReadonlyMap<
			string,
			{ personId: string; email: string | null; phone: string | null }
		>;
		emailHolders: ReadonlyMap<string, ReadonlySet<string>>;
	};
}

// ---------------------------------------------------------------------------
// Text that has to survive a jsonb column
// ---------------------------------------------------------------------------

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * Whether Postgres can keep this text in a `jsonb` value: no NUL (`\u0000`) and
 * no unpaired UTF-16 surrogate. Either one makes the whole statement fail, so
 * text a client chose is checked before it is bound, never after.
 */
export function isJsonbSafeText(text: string): boolean {
	return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

/** `text` with NUL removed and each unpaired surrogate replaced by U+FFFD, cut to `max` first. */
export function scrubJsonbText(text: string, max = Number.POSITIVE_INFINITY) {
	return text
		.slice(0, max)
		.replaceAll("\u0000", "")
		.replace(new RegExp(LONE_SURROGATE.source, "gu"), "\uFFFD");
}

const MAX_RESOLUTION_KEY = 300;
/** Easy-Speak's name for an account it erased, folded: see {@link foldName}. */
const ERASED_ACCOUNT_NAME = "forgotten user";
/** The member list's status for a member who has lapsed. */
const INACTIVE_STATUS = /^\s*inactive member\s*$/iu;
const MAX_SKIP_REASON = 500;

/** A human's answer for one person the plan could not place. */
export const personResolutionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("member"), memberId: z.string().uuid() }),
	z.object({
		action: z.literal("guest"),
		// A decision saved before #1208 can hold `guest_speaker`; reading it as
		// `visiting_toastmaster` keeps the rest of the saved map from being dropped.
		kind: z
			.preprocess(readLegacyGuestKind, z.enum(GUEST_KINDS))
			.default("visitor"),
	}),
	z.object({
		action: z.literal("skip"),
		reason: z
			.string()
			.transform((r) => r.replaceAll("\u0000", "").trim())
			.pipe(
				z
					.string()
					.min(1, "Say why this person is skipped.")
					.max(MAX_SKIP_REASON, "Keep the reason under 500 characters.")
					.refine(
						isJsonbSafeText,
						"That reason has a character that cannot be stored.",
					),
			),
	}),
]);

export type PersonResolution = z.infer<typeof personResolutionSchema>;

export const resolutionsSchema = z.record(
	z
		.string()
		.max(MAX_RESOLUTION_KEY)
		.refine(isJsonbSafeText, "That person key cannot be stored."),
	personResolutionSchema,
);

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanPersonOutcome =
	| {
			status: "member";
			memberId: string;
			via: "ref" | "exact" | "folded" | "chosen";
	  }
	| {
			status: "guest";
			kind: GuestKind;
			via: "ref" | "category" | "chosen";
			/** Set when a ref already names the guest row. */
			guestId: string | null;
	  }
	| { status: "skipped"; reason: string }
	/**
	 * Nobody on the roster is this person, and they are on Easy-Speak's member list
	 * or named by a meeting outside the guest categories: the apply makes them a
	 * member (#1240). `former` has `ended_at` NULL, which means "unknown".
	 */
	| {
			status: "create";
			membership: "active" | "former";
			position: OfficerPosition | null;
			joinedAt: string | null;
			/**
			 * Name-only person keys that are this same human (their meeting
			 * references): they resolve to the member made here.
			 */
			mergedKeys?: string[];
	  }
	/**
	 * An earlier import created a guest for this person and a human has since
	 * deleted it: a tombstone. Nothing is created for them and nothing asks a human again
	 * (D2 of #1196).
	 */
	| { status: "deleted" }
	| { status: "ambiguous"; candidates: PlanRosterMember[] }
	| { status: "unmatched" };

export interface PlanPerson {
	key: string;
	esUserId: string | null;
	name: string;
	/** Where the imported records name them, so a human can tell two Alexes apart. */
	appearances: {
		roles: number;
		attendance: number;
		awards: number;
		tableTopics: number;
		introducedBy: number;
		/** The bundle's member list (`bundle.people`). */
		memberList: number;
		/** The mentoring chart, as the row's member or as its mentor. */
		mentorChart: number;
		/** The speech-request queue, as the requester. */
		speechRequests: number;
		guestCategories: EsGuestCategory[];
	};
	/**
	 * Named only by the member list, the mentor chart or the speech requests, never
	 * by a meeting. Such a person is matched to the roster and never created, and
	 * stays unmatched without blocking the apply (#1203).
	 */
	listOnly: boolean;
	outcome: PlanPersonOutcome;
	/** A chosen member id the roster does not hold: shown, and the person stays unresolved. */
	rejectedChoice: string | null;
}

/** Why an erased Easy-Speak account ("Forgotten User") is skipped. */
export const ERASED_ACCOUNT_REASON = "Erased Easy-Speak account";

/** Why a name-only reference is left out of this import (a fold collision). */
export const DEFERRED_NAMESAKES_REASON =
	"Deferred: the name matches more than one person on Easy-Speak's member list";
export const DEFERRED_ANSWERED_REASON =
	"Deferred: an answer is saved for a person with this name";
export const DEFERRED_REJECTED_REASON =
	"Deferred: the saved answer for this name no longer applies";

/** What one contact row sets on one person; blank means "leave as it is". */
export interface ContactFill {
	/** `PlanPerson.key` of the person it lands on. */
	personKey: string;
	/** For the warning text only: never the email or the phone. */
	name: string;
	/** Which pasted row (1-based, blank lines not counted). */
	row: number;
	email: string | null;
	phone: string | null;
}

export interface PlanRoleDefinitionPlan {
	/** `std:<key>` for a standard role, `own:<folded name>` for a club's own. */
	planKey: string;
	name: string;
	standardKey: string | null;
	existingId: string | null;
	/** The Easy-Speak labels that landed here. */
	labels: string[];
}

export interface PlanSpeech {
	sourceId: string;
	title: string;
	path: string | null;
	project: string | null;
	level: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	introduction: string | null;
}

export interface PlanSlot {
	/** `import_refs` source id of the role slot: `<esMeetingId>:<slot>`. */
	sourceId: string;
	esSlot: number;
	label: string;
	roleKey: string;
	slotIndex: number;
	holderKey: string | null;
	speech: PlanSpeech | null;
	evaluatesEsSlot: number | null;
}

/** Why a past meeting is left alone: see {@link MeetingDisposition}. */
export type MeetingSkipKind = "exists" | "deleted";

export interface PlanMeeting {
	esMeetingId: string;
	scheduledAt: Date;
	/**
	 * How the apply finds the row: by ref, by an existing COMPLETED meeting at the
	 * same instant, or new. `skip` writes nothing: a meeting at that instant is
	 * not a completed one, or an earlier import's meeting has been deleted since.
	 */
	action: "update" | "adopt" | "create" | "skip";
	existingMeetingId: string | null;
	/** Set only for `skip`. */
	skip: { kind: MeetingSkipKind; reason: string } | null;
	venue: string | null;
	joinUrl: string | null;
	theme: string | null;
	wordOfTheDay: string | null;
	slots: PlanSlot[];
	attendance: Array<{
		sourceId: string;
		personKey: string;
		mode: "in_person" | "online";
	}>;
	plans: Array<{
		personKey: string;
		status: "coming" | "not_coming";
	}>;
	awards: Array<{
		sourceId: string;
		category: "best_speaker" | "best_evaluator" | "best_table_topics";
		personKey: string;
	}>;
	tableTopics: Array<{
		sourceId: string;
		personKey: string;
		topic: string | null;
		sortOrder: number;
	}>;
}

export interface PlanCounts {
	meetings: number;
	meetingsToCreate: number;
	meetingsToAdopt: number;
	meetingsToUpdate: number;
	/** Past meetings left alone: a non-completed meeting is there, or a human deleted the imported one. */
	meetingsToSkip: number;
	futureMeetingsSkipped: number;
	roleAssignments: number;
	speeches: number;
	speechesWithIntroduction: number;
	evaluatorLinks: number;
	attendanceRecords: number;
	awards: number;
	tableTopicsSpeakers: number;
	newGuests: number;
	newRoleDefinitions: number;
	/** People who already have a member here: linked, never duplicated. */
	linkedMembers: number;
	/** Members the apply creates (#1240). */
	newActiveMembers: number;
	/** Of the active ones, the number who hold an office (and so become admins). */
	newOfficers: number;
	newFormerMembers: number;
	/** People left out because Easy-Speak erased their account. */
	erasedAccounts: number;
}

export interface ImportPlan {
	people: PlanPerson[];
	/**
	 * Persons that still need a human: ambiguous, or unmatched with a meeting
	 * appearance. An unmatched person who is on a list only is not here.
	 */
	unresolved: PlanPerson[];
	roleDefinitions: PlanRoleDefinitionPlan[];
	meetings: PlanMeeting[];
	futureMeetings: Array<{ esMeetingId: string; startsAt: string }>;
	/** Guest -> introducer, from the chart of visitors introduced. */
	introductions: Array<{ visitorKey: string; introducerKey: string }>;
	counts: PlanCounts;
	/** What the pasted contacts set, per person (#1240). */
	contactFills: ContactFill[];
	/** Rows that set nothing, or a value left blank, each naming the row and the person: never a value. */
	contactWarnings: string[];
	/**
	 * Plain-language notes the preview shows beside its warnings: a person left out
	 * of this import and why, a saved answer set aside. Each names the person,
	 * never pasted text.
	 */
	notes: string[];
	/** True when nothing is left for a human: apply is allowed. */
	canApply: boolean;
}

/** The instant an Easy-Speak timestamp denotes, in the club's zone when it has no offset. */
export function instantOf(startsAt: string, clubTimezone: string): Date {
	if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(startsAt)) return new Date(startsAt);
	return zonedWallTimeToUtc(startsAt, clubTimezone);
}

function kindForCategories(categories: EsGuestCategory[]): GuestKind {
	// Easy-Speak's "Guest Speaker" section is a Toastmaster from another club who
	// spoke: a visiting Toastmaster here (#1208), not a kind of its own.
	if (
		categories.includes("guest_speaker") ||
		categories.includes("visitor_other_club")
	)
		return "visiting_toastmaster";
	return "visitor";
}

/** The bundle's past meetings, with their instants, in date order. */
export function pastMeetings(
	bundle: EasySpeakBundleV1,
	now: Date,
	clubTimezone: string,
) {
	const all = bundle.meetings
		.map((meeting) => ({
			meeting,
			at: instantOf(meeting.startsAt, clubTimezone),
		}))
		.sort((a, b) => a.at.getTime() - b.at.getTime());
	return {
		past: all.filter((m) => m.at.getTime() <= now.getTime()),
		future: all.filter((m) => m.at.getTime() > now.getTime()),
	};
}

interface Seen {
	ref: EsPersonRef;
	appearances: PlanPerson["appearances"];
	onMemberList: boolean;
	/** The member list's row for this person (`bundle.people`), when it has one. */
	listRow: { status: string; joined: string | null } | null;
	/**
	 * Every spelling the records gave this key, case and spacing aside. A name-only
	 * key folds accents away, so two spellings ("José", "Jose") share one key: the
	 * exact-name matcher must not pick one of them for both.
	 */
	spellings: Set<string>;
	/**
	 * A real meeting signal: a role, an award, Table Topics, an introducer link, a
	 * guest category, or an attendance row with a record or an attending /
	 * tentative reply. A guest-section row with no reply and no record is only a
	 * line on the attendance list ("Unknown"): it names nobody.
	 */
	signalled: boolean;
}

/** A spelling that keeps its accents: the fold's own key throws them away. */
function spellingOf(name: string): string {
	return name.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Whether a person needs a human before the apply: an ambiguous match, and only
 * that (#1240): nobody else needs asking, because a person the roster does not
 * hold is created, a guest, or skipped by rule. The one rule the plan's
 * `unresolved` and the preview's `needsDecision` both read.
 */
export function needsDecision(p: PlanPerson): boolean {
	return p.outcome.status === "ambiguous";
}

/** Why an existing meeting is left as it is: the report says it in these words. */
export function leftAloneReason(status: string): string {
	return status === "completed"
		? "Exists in GavelUp, not imported: its date is now in the future."
		: `Exists in GavelUp, not imported: a ${status} meeting is already at this time.`;
}

/** Build the plan. Never touches a database: everything it needs is in `ctx`. */
export function buildImportPlan(
	bundle: EasySpeakBundleV1,
	ctx: PlanContext,
): ImportPlan {
	const { past: allPast, future } = pastMeetings(
		bundle,
		ctx.now,
		ctx.clubTimezone,
	);
	const refTarget = (kind: string, key: string) =>
		ctx.refs.find((r) => r.kind === kind && r.sourceId === key)?.targetId ??
		null;

	// -- What each past meeting meets in the club (D1, D2 of #1196) ---------------
	// An existing meeting is adopted or updated ONLY when it is already a
	// completed one in the past; anything else at that instant (scheduled,
	// cancelled) is left exactly as it is and reported, because writing "completed"
	// onto it would un-cancel it, freeze a meeting nobody closed, or complete a
	// rescheduled future one. An earlier import's meeting that a human has since
	// deleted is not re-created.
	const dispositionOf = (esMeetingId: string, at: Date) => {
		const refId = refTarget("meeting", esMeetingId);
		const referenced = refId
			? ctx.existingMeetings.find((m) => m.id === refId)
			: undefined;
		const acceptable = (m: PlanExistingMeeting) =>
			m.status === "completed" && m.scheduledAt.getTime() <= ctx.now.getTime();
		const left = (m: PlanExistingMeeting) => ({
			action: "skip" as const,
			existing: null,
			skip: {
				kind: "exists" as const,
				reason: leftAloneReason(m.status),
			},
		});
		if (refId && !referenced) {
			return {
				action: "skip" as const,
				existing: null,
				skip: {
					kind: "deleted" as const,
					reason: "Deleted in GavelUp since import: not created again.",
				},
			};
		}
		if (referenced) {
			return acceptable(referenced)
				? { action: "update" as const, existing: referenced, skip: null }
				: left(referenced);
		}
		const atInstant = ctx.existingMeetings.filter(
			(m) => m.scheduledAt.getTime() === at.getTime(),
		);
		const adoptable = atInstant.find(acceptable);
		if (adoptable) {
			return { action: "adopt" as const, existing: adoptable, skip: null };
		}
		const blocker = atInstant[0];
		if (blocker) return left(blocker);
		return { action: "create" as const, existing: null, skip: null };
	};
	const dispositions = new Map(
		allPast.map(({ meeting, at }) => [
			meeting.esMeetingId,
			dispositionOf(meeting.esMeetingId, at),
		]),
	);
	// A meeting that is left alone names nobody: its people need no decision.
	const past = allPast.filter(
		({ meeting }) => dispositions.get(meeting.esMeetingId)?.action !== "skip",
	);

	// -- Who the imported records name ---------------------------------------
	const memberListIds = new Set(bundle.people.map((p) => p.esUserId));
	const listRows = new Map(bundle.people.map((p) => [p.esUserId, p] as const));
	const seen = new Map<string, Seen>();
	const touch = (
		ref: EsPersonRef,
		field: keyof Omit<PlanPerson["appearances"], "guestCategories">,
		category?: EsGuestCategory,
		signal = field === "roles" ||
			field === "awards" ||
			field === "tableTopics" ||
			field === "introducedBy",
	) => {
		const key = personKeyOf(ref);
		let entry = seen.get(key);
		if (!entry) {
			entry = {
				ref,
				onMemberList: ref.esUserId ? memberListIds.has(ref.esUserId) : false,
				listRow: ref.esUserId
					? (() => {
							const row = listRows.get(ref.esUserId);
							return row ? { status: row.status, joined: row.joined } : null;
						})()
					: null,
				spellings: new Set(),
				signalled: false,
				appearances: {
					roles: 0,
					attendance: 0,
					awards: 0,
					tableTopics: 0,
					introducedBy: 0,
					memberList: 0,
					mentorChart: 0,
					speechRequests: 0,
					guestCategories: [],
				},
			};
			seen.set(key, entry);
		}
		entry.spellings.add(spellingOf(ref.name));
		if (signal || category) entry.signalled = true;
		entry.appearances[field]++;
		if (category && !entry.appearances.guestCategories.includes(category)) {
			entry.appearances.guestCategories.push(category);
		}
	};
	for (const { meeting } of past) {
		for (const role of meeting.roles)
			if (role.holder) touch(role.holder, "roles");
		for (const row of meeting.attendance) {
			touch(
				row.who,
				"attendance",
				undefined,
				row.record !== null ||
					row.plan === "attending" ||
					row.plan === "tentative",
			);
		}
		for (const g of meeting.guests) touch(g.who, "attendance", g.category);
		for (const award of meeting.awards) touch(award.who, "awards");
		for (const tt of meeting.tableTopics) touch(tt.who, "tableTopics");
	}
	for (const intro of bundle.visitorsIntroduced) {
		touch(intro.visitor, "attendance", "visitor");
		touch(intro.introducedBy, "introducedBy");
	}
	// The lists (#1203). After the meetings, so a person a meeting names keeps the
	// reference the meeting gave. A club's whole bundle is read here, not only its
	// past meetings: a request or a chart row does not belong to a meeting.
	for (const row of bundle.people) {
		touch({ esUserId: row.esUserId, name: row.name }, "memberList");
	}
	for (const row of bundle.mentors) {
		touch(row.mentee, "mentorChart");
		if (row.mentor) touch(row.mentor, "mentorChart");
	}
	for (const request of bundle.speechRequests) {
		touch(request.who, "speechRequests");
	}

	// -- Resolve them ----------------------------------------------------------
	const rosterByName = new Map<string, PlanRosterMember[]>();
	const rosterByFold = new Map<string, PlanRosterMember[]>();
	for (const m of ctx.roster) {
		const exact = m.name.trim();
		rosterByName.set(exact, [...(rosterByName.get(exact) ?? []), m]);
		const fold = foldName(m.name);
		rosterByFold.set(fold, [...(rosterByFold.get(fold) ?? []), m]);
	}
	const rosterIds = new Set(ctx.roster.map((m) => m.memberId));

	const people: PlanPerson[] = [];
	const notes: string[] = [];
	for (const [key, entry] of seen) {
		const { ref, appearances } = entry;
		// A person no meeting names: matched, never created (#1203).
		const listOnly =
			appearances.roles +
				appearances.attendance +
				appearances.awards +
				appearances.tableTopics +
				appearances.introducedBy ===
			0;
		let outcome: PlanPersonOutcome = { status: "unmatched" };
		let rejectedChoice: string | null = null;

		const memberRef = refTarget("person", key);
		const guestRef = refTarget("guest", key);
		if (memberRef && rosterIds.has(memberRef)) {
			outcome = { status: "member", memberId: memberRef, via: "ref" };
		} else if (guestRef && ctx.guestIds.has(guestRef)) {
			outcome = {
				status: "guest",
				kind: kindForCategories(appearances.guestCategories),
				via: "ref",
				guestId: guestRef,
			};
		} else if (guestRef) {
			// Named by an earlier import, and the guest row is gone: a human deleted a
			// row the import itself created.
			outcome = { status: "deleted" };
		} else if (foldName(ref.name) === ERASED_ACCOUNT_NAME) {
			// An erased Easy-Speak account is nobody: never matched, never asked about
			// (#1236). Only a saved answer, below, can say otherwise.
			outcome = { status: "skipped", reason: ERASED_ACCOUNT_REASON };
		} else {
			// A vanished MEMBER ref is a tombstone only when the club logged the
			// member's removal (`member_remove`, below), except a convert undo that
			// kept the membership. A merge logs none, so a merged-away member is
			// matched by name again (D4 of #1196).
			// Two spellings under one name-only key (José / Jose) cannot take the exact
			// pass: it would match the first spelling and hand the second its member.
			// The fold's candidates go to a human, or to nobody if the roster has none.
			const collided = !ref.esUserId && entry.spellings.size > 1;
			const exact = collided ? [] : (rosterByName.get(ref.name.trim()) ?? []);
			const folded = rosterByFold.get(foldName(ref.name)) ?? [];
			const candidates = exact.length > 0 ? exact : folded;
			const first = candidates[0];
			if (candidates.length === 1 && first && !collided) {
				outcome = {
					status: "member",
					memberId: first.memberId,
					via: exact.length > 0 ? "exact" : "folded",
				};
			} else if (candidates.length > 1 || (collided && first)) {
				outcome = { status: "ambiguous", candidates };
			} else if (memberRef && ctx.removedMemberIds?.has(memberRef)) {
				// The ref names a member row that is gone, the club logged its removal
				// and nobody on the roster is that person. Re-creating
				// them would bring back a removed officer as an admin (#1240), so it is
				// a tombstone, the way a vanished guest is.
				outcome = { status: "deleted" };
			} else if (entry.listRow) {
				// Easy-Speak lists them as a member: that wins over a guest category.
				const inactive = INACTIVE_STATUS.test(entry.listRow.status);
				outcome = {
					status: "create",
					membership: inactive ? "former" : "active",
					position: inactive
						? null
						: parseOfficerPosition(entry.listRow.status),
					joinedAt: entry.listRow.joined,
				};
			} else if (appearances.guestCategories.length > 0) {
				outcome = {
					status: "guest",
					kind: kindForCategories(appearances.guestCategories),
					via: "category",
					guestId: null,
				};
			} else if (entry.signalled) {
				// A past person a meeting names (a real signal, not a bare attendance
				// line) and nobody lists: a former member.
				outcome = {
					status: "create",
					membership: "former",
					position: null,
					joinedAt: null,
				};
			}
			// else: named by the mentor chart or the speech requests only. Matched to
			// the roster when it has them, otherwise left alone and not asked about
			// (#1203).
		}
		// A saved answer wins over every automatic outcome but a tombstone (D2).
		// A list-only person is never made a guest, and with no roster match and no
		// row of the member list there is nothing to decide, so no answer is read.
		if (outcome.status !== "deleted") {
			const saved = ctx.resolutions?.[key];
			if (
				saved?.action === "guest" &&
				guestRef &&
				!ctx.guestIds.has(guestRef)
			) {
				// A guest the club deleted stays deleted, even beside a live member
				// ref: the answer does not mint it again, and the preview says so.
				notes.push(
					`${ref.name}: the saved answer "guest" is set aside because the club deleted that guest; they stay a member.`,
				);
			}
			const choice =
				listOnly &&
				(saved?.action === "guest" ||
					(outcome.status === "unmatched" && saved !== undefined))
					? undefined
					: saved;
			if (choice?.action === "member") {
				if (rosterIds.has(choice.memberId)) {
					outcome = {
						status: "member",
						memberId: choice.memberId,
						via: "chosen",
					};
				} else {
					rejectedChoice = choice.memberId;
				}
			} else if (
				choice?.action === "guest" &&
				guestRef &&
				!ctx.guestIds.has(guestRef)
			) {
				// Set aside (noted above): the deleted guest stays deleted.
			} else if (choice?.action === "guest") {
				// A guest the ref already names stays that guest: a saved "guest" answer
				// must not mint a second one on every re-apply.
				outcome = {
					status: "guest",
					kind: choice.kind,
					via: "chosen",
					guestId: guestRef && ctx.guestIds.has(guestRef) ? guestRef : null,
				};
			} else if (choice?.action === "skip") {
				outcome = { status: "skipped", reason: choice.reason };
			}
		}
		people.push({
			key,
			esUserId: ref.esUserId,
			name: ref.name,
			appearances,
			listOnly,
			outcome,
			rejectedChoice,
		});
	}
	// Creates folding to one name are one human or several (never two Persons for
	// one human). The fold is KEPT only when it is certain: a folded-name group
	// with EXACTLY ONE `es:` create (listed or not) and no saved answer on that
	// create or on any name-only key of the group. The name-only references then
	// join that create, so one Person is made and every key resolves to it.
	// Every other collision is DEFERRED, never blocked: two or more `es:` creates
	// are namesakes, and a saved answer means a human already spoke about one of
	// them. The name-only creates of such a group become a non-blocking `skipped`
	// outcome that imports nothing and writes no ref and no answer; the `es:`
	// creates stay ordinary separate creates. Once they are on the roster the
	// next import's exact-name match gives the reference its real candidates.
	const answered = (p: PlanPerson) => ctx.resolutions?.[p.key] !== undefined;
	const peopleByFold = new Map<string, PlanPerson[]>();
	for (const p of people) {
		const fold = foldName(p.name);
		peopleByFold.set(fold, [...(peopleByFold.get(fold) ?? []), p]);
	}
	const merged = new Set<PlanPerson>();
	for (const group of peopleByFold.values()) {
		const esCreates = group.filter(
			(p) => p.esUserId !== null && p.outcome.status === "create",
		);
		// A name-only create with a saved answer that took effect is no longer a
		// create, so it is outside this list; one whose answer was rejected (a member
		// the roster no longer holds) stays a create and is an answered key here.
		const nameOnly = group.filter(
			(p) => p.esUserId === null && p.outcome.status === "create",
		);
		if (nameOnly.length === 0 || esCreates.length === 0) continue;
		const target = esCreates[0];
		const targetAnswered = target !== undefined && answered(target);
		const nameOnlyAnswered = nameOnly.some(answered);
		if (esCreates.length > 1 || targetAnswered || nameOnlyAnswered || !target) {
			for (const p of nameOnly) {
				const [reason, note] =
					esCreates.length > 1
						? [
								DEFERRED_NAMESAKES_REASON,
								`${p.name}: the name matches more than one person on Easy-Speak's member list, so their meeting records are left out this time and the next import will ask which person it is.`,
							]
						: targetAnswered
							? [
									DEFERRED_ANSWERED_REASON,
									`${p.name}: the name matches a person on Easy-Speak's member list who has a saved answer, so their meeting records are left out this time and the next import will match them against the roster.`,
								]
							: [
									DEFERRED_REJECTED_REASON,
									`${p.name}: there is a saved answer for this name that no longer applies, and the name matches a person on Easy-Speak's member list, so their meeting records are left out this time and the next import will match them against the roster.`,
								];
				p.outcome = { status: "skipped", reason };
				notes.push(note);
			}
			continue;
		}
		if (target.outcome.status !== "create") continue;
		const mergedKeys = nameOnly.map((p) => p.key).sort();
		target.outcome = { ...target.outcome, mergedKeys };
		for (const p of nameOnly) {
			target.appearances.roles += p.appearances.roles;
			target.appearances.attendance += p.appearances.attendance;
			target.appearances.awards += p.appearances.awards;
			target.appearances.tableTopics += p.appearances.tableTopics;
			target.appearances.introducedBy += p.appearances.introducedBy;
			for (const c of p.appearances.guestCategories) {
				if (!target.appearances.guestCategories.includes(c)) {
					target.appearances.guestCategories.push(c);
				}
			}
			merged.add(p);
		}
		target.listOnly = false;
	}
	if (merged.size > 0) {
		for (let i = people.length - 1; i >= 0; i--) {
			const p = people[i];
			if (p && merged.has(p)) people.splice(i, 1);
		}
	}
	people.sort(
		(a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
	);
	const unresolved = people.filter(needsDecision);
	const { fills: contactFills, warnings: contactWarnings } = placeContacts(
		ctx,
		people,
	);

	// -- Role definitions ------------------------------------------------------
	const defsByKey = new Map(
		ctx.roleDefinitions
			.filter((d) => d.key)
			.map((d) => [d.key as string, d] as const),
	);
	const defsByFold = new Map<string, PlanRoleDefinition>();
	for (const d of ctx.roleDefinitions) {
		const fold = foldName(d.name);
		if (!defsByFold.has(fold)) defsByFold.set(fold, d);
	}
	const roleDefs = new Map<string, PlanRoleDefinitionPlan>();
	const roleKeyFor = (label: string): string => {
		const standard = standardRoleKeyFor(label);
		const planKey = standard
			? `std:${standard}`
			: `own:${foldName(ownRoleDisplayName(label))}`;
		let def = roleDefs.get(planKey);
		if (!def) {
			const display = ownRoleDisplayName(label);
			const existing = standard
				? defsByKey.get(standard)
				: defsByFold.get(foldName(display));
			def = {
				planKey,
				name: existing?.name ?? display,
				standardKey: standard,
				existingId: existing?.id ?? null,
				labels: [],
			};
			roleDefs.set(planKey, def);
		}
		if (!def.labels.includes(label)) def.labels.push(label);
		return planKey;
	};

	// -- Meetings --------------------------------------------------------------
	const meetings: PlanMeeting[] = [];
	for (const { meeting, at } of allPast) {
		const disposition = dispositions.get(meeting.esMeetingId);
		if (!disposition) continue;
		if (disposition.action === "skip") {
			meetings.push({
				esMeetingId: meeting.esMeetingId,
				scheduledAt: at,
				action: "skip",
				existingMeetingId: null,
				skip: disposition.skip,
				venue: null,
				joinUrl: null,
				theme: null,
				wordOfTheDay: null,
				slots: [],
				attendance: [],
				plans: [],
				awards: [],
				tableTopics: [],
			});
			continue;
		}
		const existing = disposition.existing;
		const perRole = new Map<string, number>();
		const slots: PlanSlot[] = [...meeting.roles]
			.sort((a, b) => a.slot - b.slot)
			.map((role) => {
				const roleKey = roleKeyFor(role.role);
				const slotIndex = perRole.get(roleKey) ?? 0;
				perRole.set(roleKey, slotIndex + 1);
				const sourceId = `${meeting.esMeetingId}:${role.slot}`;
				return {
					sourceId,
					esSlot: role.slot,
					label: role.role,
					roleKey,
					slotIndex,
					holderKey: role.holder ? personKeyOf(role.holder) : null,
					speech: role.speech
						? {
								sourceId: role.speech.esSpeechId ?? sourceId,
								title: role.speech.title?.trim() || "TBA",
								path: role.speech.path,
								project: role.speech.project,
								level:
									role.speech.level === null ? null : String(role.speech.level),
								minMinutes:
									role.speech.minMin === null
										? null
										: Math.round(role.speech.minMin),
								maxMinutes:
									role.speech.maxMin === null
										? null
										: Math.round(role.speech.maxMin),
								introduction: role.speech.introduction?.trim()
									? role.speech.introduction
									: null,
							}
						: null,
					evaluatesEsSlot: role.evaluates ?? null,
				};
			});
		const attendance: PlanMeeting["attendance"] = [];
		const plans: PlanMeeting["plans"] = [];
		const seenAttendance = new Set<string>();
		for (const row of meeting.attendance) {
			const personKey = personKeyOf(row.who);
			if (seenAttendance.has(personKey)) continue;
			seenAttendance.add(personKey);
			if (row.record) {
				attendance.push({
					sourceId: `${meeting.esMeetingId}:${personKey}`,
					personKey,
					mode: row.record === "attended_online" ? "online" : "in_person",
				});
			} else if (row.plan === "attending" || row.plan === "not_attending") {
				// A past meeting's plan is superseded by its record (decision 10): only
				// a plan with NO record behind it is kept, and Tentative / Unknown never.
				plans.push({
					personKey,
					status: row.plan === "attending" ? "coming" : "not_coming",
				});
			}
		}
		meetings.push({
			esMeetingId: meeting.esMeetingId,
			scheduledAt: at,
			action: disposition.action,
			existingMeetingId: existing?.id ?? null,
			skip: null,
			venue: meeting.venue,
			joinUrl: meeting.joinUrl,
			theme: meeting.theme,
			wordOfTheDay: meeting.wordOfTheDay,
			slots,
			attendance,
			plans,
			awards: meeting.awards.map((a) => ({
				sourceId: `${meeting.esMeetingId}:${a.category}`,
				category: a.category,
				personKey: personKeyOf(a.who),
			})),
			tableTopics: meeting.tableTopics.map((t, i) => ({
				sourceId: `${meeting.esMeetingId}:${i}`,
				personKey: personKeyOf(t.who),
				topic: t.topic,
				sortOrder: i,
			})),
		});
	}

	const introductions = bundle.visitorsIntroduced.map((i) => ({
		visitorKey: personKeyOf(i.visitor),
		introducerKey: personKeyOf(i.introducedBy),
	}));

	const allSlots = meetings.flatMap((m) => m.slots);
	const counts: PlanCounts = {
		meetings: meetings.length,
		meetingsToCreate: meetings.filter((m) => m.action === "create").length,
		meetingsToAdopt: meetings.filter((m) => m.action === "adopt").length,
		meetingsToUpdate: meetings.filter((m) => m.action === "update").length,
		meetingsToSkip: meetings.filter((m) => m.action === "skip").length,
		futureMeetingsSkipped: future.length,
		roleAssignments: allSlots.filter((s) => s.holderKey).length,
		speeches: allSlots.filter((s) => s.speech && s.holderKey).length,
		speechesWithIntroduction: allSlots.filter(
			(s) => s.speech?.introduction && s.holderKey,
		).length,
		evaluatorLinks: allSlots.filter((s) => s.evaluatesEsSlot !== null).length,
		attendanceRecords: meetings.reduce((n, m) => n + m.attendance.length, 0),
		awards: meetings.reduce((n, m) => n + m.awards.length, 0),
		tableTopicsSpeakers: meetings.reduce((n, m) => n + m.tableTopics.length, 0),
		newGuests: people.filter(
			(p) => p.outcome.status === "guest" && !p.outcome.guestId,
		).length,
		newRoleDefinitions: [...roleDefs.values()].filter((d) => !d.existingId)
			.length,
		linkedMembers: people.filter((p) => p.outcome.status === "member").length,
		newActiveMembers: people.filter(
			(p) => p.outcome.status === "create" && p.outcome.membership === "active",
		).length,
		newOfficers: people.filter(
			(p) => p.outcome.status === "create" && p.outcome.position !== null,
		).length,
		newFormerMembers: people.filter(
			(p) => p.outcome.status === "create" && p.outcome.membership === "former",
		).length,
		erasedAccounts: people.filter(
			(p) =>
				p.outcome.status === "skipped" &&
				p.outcome.reason === ERASED_ACCOUNT_REASON,
		).length,
	};

	return {
		people,
		unresolved,
		roleDefinitions: [...roleDefs.values()],
		meetings,
		futureMeetings: future.map(({ meeting }) => ({
			esMeetingId: meeting.esMeetingId,
			startsAt: meeting.startsAt,
		})),
		introductions,
		counts,
		contactFills,
		contactWarnings,
		notes,
		canApply: unresolved.length === 0,
	};
}

// ---------------------------------------------------------------------------
// Contacts (#1240)
// ---------------------------------------------------------------------------

const isBlank = (v: string | null | undefined) => !v || v.trim() === "";

/**
 * Place the pasted contact rows on the people the import creates or links. A row
 * matches by the plan's own name matcher (exact, then case and accent folded)
 * against those people only. A value is set only where the person has none; the
 * warnings name the row and the person, never an email or a phone, because the
 * report keeps them.
 */
function placeContacts(
	ctx: PlanContext,
	people: PlanPerson[],
): { fills: ContactFill[]; warnings: string[] } {
	const text = ctx.contacts ?? "";
	if (text.trim() === "") return { fills: [], warnings: [] };
	const rows = parseRosterText(text);
	const state = ctx.contactState;
	const rosterName = new Map(ctx.roster.map((m) => [m.memberId, m.name]));

	interface Target {
		/** One id per person who would receive a value: a member's, or a created person's key. */
		id: string;
		personKey: string;
		name: string;
		memberId: string | null;
	}
	const targets = new Map<string, Target>();
	for (const p of people) {
		const o = p.outcome;
		if (o.status === "member") {
			targets.set(`m:${o.memberId}`, {
				id: `m:${o.memberId}`,
				personKey: p.key,
				name: rosterName.get(o.memberId) ?? p.name,
				memberId: o.memberId,
			});
		} else if (o.status === "create") {
			targets.set(`c:${p.key}`, {
				id: `c:${p.key}`,
				personKey: p.key,
				name: p.name,
				memberId: null,
			});
		}
	}
	const byExact = new Map<string, Target[]>();
	const byFold = new Map<string, Target[]>();
	for (const t of targets.values()) {
		const exact = t.name.trim();
		byExact.set(exact, [...(byExact.get(exact) ?? []), t]);
		const fold = foldName(t.name);
		byFold.set(fold, [...(byFold.get(fold) ?? []), t]);
	}

	const warnings: string[] = [];
	const firstRow = new Map<
		string,
		{ target: Target; row: number; email: string | null; phone: string | null }
	>();
	rows.forEach((r, i) => {
		const row = i + 1;
		if (r.name.trim() === "") {
			warnings.push(`Contact row ${row} has no name; it is applied to no one.`);
			return;
		}
		const exact = byExact.get(r.name.trim()) ?? [];
		const candidates =
			exact.length > 0 ? exact : (byFold.get(foldName(r.name)) ?? []);
		if (candidates.length === 0) {
			warnings.push(
				`Contact row ${row} matches no one being linked or created; it is applied to no one.`,
			);
			return;
		}
		const [target] = candidates;
		if (candidates.length > 1 || !target) {
			warnings.push(
				`Contact row ${row} matches ${candidates.length} people; it is applied to no one.`,
			);
			return;
		}
		if (firstRow.has(target.id)) {
			warnings.push(
				`Contact row ${row} is a second row for ${target.name}; the first row is used and this one is ignored.`,
			);
			return;
		}
		let email: string | null = r.email.trim() === "" ? null : r.email.trim();
		if (email && !isValidEmail(email)) {
			warnings.push(
				`The email in contact row ${row} is not valid; left blank for ${target.name}.`,
			);
			email = null;
		}
		firstRow.set(target.id, {
			target,
			row,
			email,
			phone: r.phone.trim() === "" ? null : r.phone.trim(),
		});
	});

	// The same email on the rows of two different people goes to neither.
	const owners = new Map<string, string[]>();
	for (const [id, v] of firstRow) {
		if (!v.email) continue;
		const k = v.email.toLowerCase();
		owners.set(k, [...(owners.get(k) ?? []), id]);
	}
	const fills: ContactFill[] = [];
	for (const v of firstRow.values()) {
		let email = v.email;
		const emailKey = email?.toLowerCase() ?? "";
		const memberState = v.target.memberId
			? state?.members.get(v.target.memberId)
			: undefined;
		if (email && (owners.get(emailKey)?.length ?? 0) > 1) {
			warnings.push(
				`The email in contact row ${v.row} is also on another person's row; left blank for ${v.target.name}.`,
			);
			email = null;
		} else if (email) {
			const holders = state?.emailHolders.get(emailKey);
			const heldByOther = holders
				? [...holders].some((pid) => pid !== memberState?.personId)
				: false;
			if (heldByOther) {
				warnings.push(
					`An email in row ${v.row} already belongs to someone else; left blank for ${v.target.name}.`,
				);
				email = null;
			}
		}
		let phone = v.phone;
		// A linked member keeps what they have.
		if (memberState) {
			if (!isBlank(memberState.email)) email = null;
			if (!isBlank(memberState.phone)) phone = null;
		}
		if (email || phone) {
			fills.push({
				personKey: v.target.personKey,
				name: v.target.name,
				row: v.row,
				email,
				phone,
			});
		}
	}
	return { fills, warnings };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/** One Definition-of-Done count: the bundle's number, GavelUp's, and what differs. */
export interface ReconciliationCount {
	key:
		| "meetings"
		| "role_assignments"
		| "speeches"
		| "speeches_with_introduction"
		| "awards"
		| "table_topics_speakers"
		| "attended_records";
	label: string;
	bundle: number;
	gavelup: number;
	/** Source ids the bundle holds that GavelUp does not. */
	missing: string[];
}

export interface ReconciliationBreakdownRow {
	/** The person key or role name. */
	key: string;
	label: string;
	bundle: number;
	gavelup: number;
}

export interface NotImportedRow {
	what: string;
	count: number;
	reason: string;
	/** Source ids, when the rows have them; capped so the report stays small. */
	sourceIds?: string[];
}

export interface ImportReport {
	generatedAt: string;
	bundleSha256: string;
	meetings: {
		applied: number;
		failed: Array<{ esMeetingId: string; message: string }>;
	};
	counts: ReconciliationCount[];
	/** Role assignments per role (by name) and per person; completed speeches per person. */
	roleAssignmentsPerRole: ReconciliationBreakdownRow[];
	roleAssignmentsPerPerson: ReconciliationBreakdownRow[];
	speechesPerPerson: ReconciliationBreakdownRow[];
	notImported: NotImportedRow[];
	skippedPeople: Array<{ key: string; name: string; reason: string }>;
	created: {
		guests: number;
		roleDefinitions: string[];
		/** Members made from the member list and the meetings (#1240); absent on an older report. */
		members?: { active: number; former: number; officers: number };
	};
	/**
	 * What the pasted contacts did not do, each naming a row and a person, never
	 * a value. Absent on an older report.
	 */
	contactNotes?: string[];
	/** True only when every count matched and no meeting failed. */
	reconciled: boolean;
}

/** What an apply left behind, by kind: the `import_refs` source ids whose target qualifies. */
export interface FoundSourceIds {
	meeting: ReadonlySet<string>;
	roleAssignment: ReadonlySet<string>;
	speech: ReadonlySet<string>;
	speechWithIntroduction: ReadonlySet<string>;
	award: ReadonlySet<string>;
	tableTopic: ReadonlySet<string>;
	attendance: ReadonlySet<string>;
}

/** The kinds of record an apply can leave out on purpose, named as `FoundSourceIds` names them. */
export type OmissionKind =
	| "meeting"
	| "roleAssignment"
	| "speech"
	| "award"
	| "tableTopic"
	| "attendance";

/**
 * A record the apply left out ON PURPOSE (an existing meeting it must not touch,
 * a row a human deleted since an earlier import). The reconciliation does not
 * expect it, and the report lists it with its `what` and `reason` and the source
 * id, so "not imported" is stated rather than read off a count that does not add up.
 */
export interface Omission {
	kind: OmissionKind;
	/** The `import_refs` source id; for `meeting`, the Easy-Speak meeting id. */
	sourceId: string;
	what: string;
	reason: string;
}

export const DELETED_SINCE_IMPORT = {
	what: "Deleted in GavelUp since import",
	reason:
		"A person deleted this in GavelUp after an earlier import, so it was not created again.",
} as const;

export const MEETING_LEFT_ALONE = "Meetings left as they are in GavelUp";

/** The bundle's records the reconciliation counts, with the keys the apply writes refs under. */
export interface ExpectedRecords {
	meetings: string[];
	roleAssignments: Array<{ sourceId: string; personKey: string; role: string }>;
	speeches: Array<{
		sourceId: string;
		personKey: string;
		hasIntroduction: boolean;
	}>;
	awards: string[];
	tableTopics: string[];
	attendance: Array<{ sourceId: string; personKey: string }>;
	/** Display names for the breakdown rows. */
	names: Map<string, string>;
}

/** What the bundle holds for the meetings an import covers, read the way the plan reads it. */
export function expectedFromBundle(
	bundle: EasySpeakBundleV1,
	now: Date,
	clubTimezone: string,
	/** Meetings the apply left alone: none of their records are expected. */
	leftAlone: ReadonlySet<string> = new Set(),
): ExpectedRecords {
	const past = pastMeetings(bundle, now, clubTimezone).past.filter(
		({ meeting }) => !leftAlone.has(meeting.esMeetingId),
	);
	const out: ExpectedRecords = {
		meetings: [],
		roleAssignments: [],
		speeches: [],
		awards: [],
		tableTopics: [],
		attendance: [],
		names: new Map(),
	};
	for (const { meeting } of past) {
		const id = meeting.esMeetingId;
		out.meetings.push(id);
		for (const role of meeting.roles) {
			if (!role.holder) continue;
			const personKey = personKeyOf(role.holder);
			out.names.set(personKey, role.holder.name);
			const sourceId = `${id}:${role.slot}`;
			out.roleAssignments.push({
				sourceId,
				personKey,
				role: ownRoleDisplayName(role.role),
			});
			if (role.speech) {
				out.speeches.push({
					sourceId: role.speech.esSpeechId ?? sourceId,
					personKey,
					hasIntroduction: Boolean(role.speech.introduction?.trim()),
				});
			}
		}
		for (const a of meeting.awards) {
			out.awards.push(`${id}:${a.category}`);
			out.names.set(personKeyOf(a.who), a.who.name);
		}
		meeting.tableTopics.forEach((_t, i) => {
			out.tableTopics.push(`${id}:${i}`);
		});
		const seen = new Set<string>();
		for (const row of meeting.attendance) {
			const personKey = personKeyOf(row.who);
			if (!row.record || seen.has(personKey)) continue;
			seen.add(personKey);
			out.names.set(personKey, row.who.name);
			out.attendance.push({ sourceId: `${id}:${personKey}`, personKey });
		}
	}
	return out;
}

const NOT_IMPORTED_ID_CAP = 200;

/** Everything in the bundle that is intentionally not imported, each with its reason. */
export function notImportedFromBundle(
	bundle: EasySpeakBundleV1,
	now: Date,
	clubTimezone: string,
	leftAlone: ReadonlySet<string> = new Set(),
): NotImportedRow[] {
	const { future, past: allPast } = pastMeetings(bundle, now, clubTimezone);
	const past = allPast.filter(
		({ meeting }) => !leftAlone.has(meeting.esMeetingId),
	);
	const rows: NotImportedRow[] = [];
	const cap = (ids: string[]) => ids.slice(0, NOT_IMPORTED_ID_CAP);
	if (future.length > 0) {
		rows.push({
			what: "Future meetings",
			count: future.length,
			reason:
				"They keep the club's live schedule; only meetings that have happened are imported.",
			sourceIds: cap(future.map((m) => m.meeting.esMeetingId)),
		});
	}
	let tentative = 0;
	let unknown = 0;
	let superseded = 0;
	for (const { meeting } of past) {
		for (const row of meeting.attendance) {
			if (row.record && row.plan) superseded++;
			else if (row.plan === "tentative") tentative++;
			else if (row.plan === "unknown") unknown++;
		}
	}
	if (tentative > 0) {
		rows.push({
			what: "Tentative plan answers",
			count: tentative,
			reason:
				"Not imported into the attendance plan (decision 10 of #1054); kept in the stored bundle.",
		});
	}
	if (unknown > 0) {
		rows.push({
			what: "Unknown plan answers",
			count: unknown,
			reason:
				'"Unknown" is the row-absent state already; kept in the stored bundle.',
		});
	}
	if (superseded > 0) {
		rows.push({
			what: "Plan answers on a meeting with a recorded attendance",
			count: superseded,
			reason: "A past meeting's plan is superseded by its record.",
		});
	}
	const managers = past.filter(({ meeting }) => meeting.manager).length;
	if (managers > 0) {
		rows.push({
			what: "Meeting manager names",
			count: managers,
			reason:
				"GavelUp has no meeting-manager field; kept in the stored bundle.",
		});
	}
	if (bundle.speechRequests.length > 0) {
		rows.push({
			what: "Speech requests",
			count: bundle.speechRequests.length,
			reason:
				"Imported by the speech-request queue (#1052), not by this import.",
		});
	}
	if (bundle.mentors.length > 0) {
		rows.push({
			what: "Mentor pairs",
			count: bundle.mentors.length,
			reason: "Imported by the mentor import (#1053), not by this import.",
		});
	}
	if (bundle.evaluations.length > 0) {
		rows.push({
			what: "Written evaluations",
			count: bundle.evaluations.length,
			reason:
				"GavelUp has no home for written evaluations; kept in the stored bundle.",
		});
	}
	return rows;
}

/** The omissions, one row per cause, with the source ids that were left out. */
function omissionRows(omissions: Omission[]): NotImportedRow[] {
	const rows = new Map<string, NotImportedRow>();
	for (const o of omissions) {
		const { what } = o;
		const key = `${what}\u0000${o.reason}`;
		const row = rows.get(key) ?? {
			what,
			count: 0,
			reason: o.reason,
			sourceIds: [],
		};
		row.count++;
		if ((row.sourceIds?.length ?? 0) < NOT_IMPORTED_ID_CAP) {
			row.sourceIds?.push(o.sourceId);
		}
		rows.set(key, row);
	}
	return [...rows.values()];
}

function breakdown(
	expected: Array<{ key: string; label: string }>,
	found: (key: string) => number,
): ReconciliationBreakdownRow[] {
	const byKey = new Map<string, ReconciliationBreakdownRow>();
	for (const e of expected) {
		const row = byKey.get(e.key) ?? {
			key: e.key,
			label: e.label,
			bundle: 0,
			gavelup: 0,
		};
		row.bundle++;
		byKey.set(e.key, row);
	}
	for (const row of byKey.values()) row.gavelup = found(row.key);
	return [...byKey.values()].sort(
		(a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
	);
}

/** The report: the bundle's counts against what the apply left, by source id. */
export function buildReconciliation(input: {
	bundle: EasySpeakBundleV1;
	bundleSha256: string;
	now: Date;
	clubTimezone: string;
	found: FoundSourceIds;
	failed: Array<{ esMeetingId: string; message: string }>;
	appliedMeetings: number;
	skippedPeople: ImportReport["skippedPeople"];
	created: ImportReport["created"];
	/** What the apply left out on purpose; not expected, and listed under "not imported". */
	omissions?: Omission[];
}): ImportReport {
	const { found } = input;
	const omissions = input.omissions ?? [];
	const leftAlone = new Set(
		omissions.filter((o) => o.kind === "meeting").map((o) => o.sourceId),
	);
	const omitted = (kind: OmissionKind) =>
		new Set(omissions.filter((o) => o.kind === kind).map((o) => o.sourceId));
	const full = expectedFromBundle(
		input.bundle,
		input.now,
		input.clubTimezone,
		leftAlone,
	);
	const noRole = omitted("roleAssignment");
	const noSpeech = omitted("speech");
	const noAward = omitted("award");
	const noTopic = omitted("tableTopic");
	const noAttendance = omitted("attendance");
	const expected: ExpectedRecords = {
		...full,
		roleAssignments: full.roleAssignments.filter(
			(r) => !noRole.has(r.sourceId),
		),
		speeches: full.speeches.filter((sp) => !noSpeech.has(sp.sourceId)),
		awards: full.awards.filter((id) => !noAward.has(id)),
		tableTopics: full.tableTopics.filter((id) => !noTopic.has(id)),
		attendance: full.attendance.filter((a) => !noAttendance.has(a.sourceId)),
	};
	const count = (
		key: ReconciliationCount["key"],
		label: string,
		ids: string[],
		foundSet: ReadonlySet<string>,
	): ReconciliationCount => {
		const missing = ids.filter((id) => !foundSet.has(id));
		return {
			key,
			label,
			bundle: ids.length,
			gavelup: ids.length - missing.length,
			missing,
		};
	};
	const counts = [
		count("meetings", "Meetings", expected.meetings, found.meeting),
		count(
			"role_assignments",
			"Role assignments",
			expected.roleAssignments.map((r) => r.sourceId),
			found.roleAssignment,
		),
		count(
			"speeches",
			"Completed speeches",
			expected.speeches.map((s) => s.sourceId),
			found.speech,
		),
		count(
			"speeches_with_introduction",
			"Speeches with an introduction",
			expected.speeches.filter((s) => s.hasIntroduction).map((s) => s.sourceId),
			found.speechWithIntroduction,
		),
		count("awards", "Awards", expected.awards, found.award),
		count(
			"table_topics_speakers",
			"Table Topics speakers",
			expected.tableTopics,
			found.tableTopic,
		),
		count(
			"attended_records",
			"Attended records",
			expected.attendance.map((a) => a.sourceId),
			found.attendance,
		),
	];
	const nameOf = (key: string) => expected.names.get(key) ?? key;
	const roleAssignmentsPerRole = breakdown(
		expected.roleAssignments.map((r) => ({ key: r.role, label: r.role })),
		(role) =>
			expected.roleAssignments.filter(
				(r) => r.role === role && found.roleAssignment.has(r.sourceId),
			).length,
	);
	const roleAssignmentsPerPerson = breakdown(
		expected.roleAssignments.map((r) => ({
			key: r.personKey,
			label: nameOf(r.personKey),
		})),
		(key) =>
			expected.roleAssignments.filter(
				(r) => r.personKey === key && found.roleAssignment.has(r.sourceId),
			).length,
	);
	const speechesPerPerson = breakdown(
		expected.speeches.map((s) => ({
			key: s.personKey,
			label: nameOf(s.personKey),
		})),
		(key) =>
			expected.speeches.filter(
				(s) => s.personKey === key && found.speech.has(s.sourceId),
			).length,
	);
	const reconciled =
		input.failed.length === 0 && counts.every((c) => c.missing.length === 0);
	return {
		generatedAt: input.now.toISOString(),
		bundleSha256: input.bundleSha256,
		meetings: { applied: input.appliedMeetings, failed: input.failed },
		counts,
		roleAssignmentsPerRole,
		roleAssignmentsPerPerson,
		speechesPerPerson,
		notImported: [
			...notImportedFromBundle(
				input.bundle,
				input.now,
				input.clubTimezone,
				leftAlone,
			),
			...omissionRows(omissions),
		],
		skippedPeople: input.skippedPeople,
		created: input.created,
		reconciled,
	};
}
