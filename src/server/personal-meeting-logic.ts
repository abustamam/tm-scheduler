/**
 * The read seam behind the personal meeting page (#665).
 *
 * NOTE ON THE ENTRY POINT, because an earlier draft of this header asserted one
 * that does not exist: nothing in the repo links to that page yet and nothing
 * produces the `?as=` param. `nudgeShareUrl` still points at the full meeting
 * page. The producer is #667. What matters HERE is that the `meetingKey` this
 * function takes is shaped like the link that will arrive — `meetingUrlKey`
 * emits a club-local `YYYY-MM-DD`, not a uuid.
 *
 * PUBLIC and SESSION-LESS, so it carries its own archive gate: a
 * `createServerFn` is addressable directly with no session and no router, and
 * the `/club/$clubId` shell's `beforeLoad` guards the CALLER, not the data
 * (CLAUDE.md, "Public `createServerFn` readers"). It gates through
 * `resolvePublicMeetingKey`, which folds the archive check, the club scoping
 * and the URL-segment resolution into one call, and returns `null` rather than
 * throwing, so an archived club is indistinguishable from one that never
 * existed and the route needs no new error path.
 *
 * It takes the CLUB and the raw `$meetingId` segment, never a bare meeting id.
 * Both halves of that are load-bearing and both were wrong in the first cut:
 * that segment is a club-local date key in every producer the app already has
 * (`meetingUrlKey`), and without the club the pairing is unchecked, so a club-A
 * URL would serve a club-B meeting. `loadPublicPersonalMeetingView`'s own
 * comment spells out the three jobs that one resolver call does.
 *
 * It lives in a `*-logic.ts` module rather than inline in the handler for the
 * SECOND reason the split exists: a `createServerFn` handler cannot be invoked
 * from vitest, so a query living inside one is unreachable — it could be
 * neither integration-tested nor enrolled by the archive-gate sweep, which is
 * exactly the gap #544 and #560 were.
 *
 * ## `?as=<memberId>` is validated HERE, and that is the whole validation
 *
 * The route seeds the visitor's localStorage identity from `?as=`. Storing an
 * unchecked id would write junk into that identity and make every later
 * self-assert fail confusingly, so the id is checked against the meeting's own
 * club roster server-side first — and this function returning a non-null view
 * IS that check. A rejected id collapses to `null` alongside every other
 * not-found, so the caller has one path, not four.
 *
 * Membership is tested the way `requireMemberInClub` (`guards.ts`) tests it —
 * present, in THIS club, and not `inactive` — so a link cannot seed an identity
 * that the write paths it leads to would then refuse.
 *
 * ## The payload carries no contact details, deliberately
 *
 * `members.name` and nothing else off the roster row. This page is reachable by
 * anyone holding a forwarded link, and #576 already established the rule that a
 * self-asserted (session-less) caller gets the ladder and the names but never
 * phone or email — `loadTmodPanelData` is the precedent. `personal-meeting.integration.test.ts`
 * asserts the absence rather than trusting this comment.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	type meetingStatusEnum,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { getPlanStatus } from "#/server/attendance-plan-logic";
import { resolvePublicMeetingKey } from "#/server/meeting-resolve-logic";

/** Matches `club-readable-logic.ts`'s `UUID_RE`: comparing a non-uuid string
 *  against a `uuid` column makes Postgres THROW rather than return zero rows,
 *  which would surface a 500 where a malformed `?as=` must simply be rejected. */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One role this member holds on this meeting. `roleKey` and `roleName` are
 *  what `dutiesForRole` matches on, so both travel — a club-renamed role still
 *  resolves by key, and a key-less custom role still resolves by name. */
export interface PersonalMeetingRole {
	slotId: string;
	roleName: string;
	roleKey: string | null;
	/** The slot's `speeches.title`, for the `speech_details` duty's `done`.
	 *  Null for every non-speaking role.
	 *
	 *  Passed to `dutiesForRole`'s `done` RAW, never pre-checked here: `title` is
	 *  NOT NULL and the app stores the literal "TBA" for an undecided speech, so
	 *  a local "is it non-blank" test would read the placeholder as a finished
	 *  talk. `isRealSpeechTitle` inside the duty registry is the one predicate
	 *  that knows about the sentinel — do not re-derive it. */
	speechTitle: string | null;
}

export interface PersonalMeetingView {
	/** `timezone` travels because the page renders a DATE and the reader is on a
	 *  phone that may be anywhere: formatting `scheduledAt` in the viewer's zone
	 *  is how a Tuesday evening meeting reads as Wednesday to someone abroad. */
	club: { id: string; name: string; timezone: string };
	meeting: {
		id: string;
		/**
		 * `Date | string`, not `Date` — and the union is the honest type, not a
		 * looseness. A server fn serializes Dates to strings over the wire, so this
		 * field is a real `Date` during the SSR pass and a string after hydration.
		 * Declaring it `Date` would let the next consumer write
		 * `scheduledAt.getTime()`, typecheck clean, and throw in the browser.
		 * `formatMeetingDate` and `isMeetingOver` both accept the union for exactly
		 * this reason.
		 */
		scheduledAt: Date | string;
		theme: string | null;
		wordOfTheDay: string | null;
		/**
		 * Off the pgEnum, never a bare `string`. The route branches on this three
		 * ways, and `attendance-plan.ts`'s own schema comment says the status union
		 * must be DERIVED because a hand-listed one "would be invisible to tsc".
		 * Widening to `string` is that failure with the check removed entirely: the
		 * US spelling `"canceled"` would compile and silently show answer buttons.
		 */
		status: (typeof meetingStatusEnum.enumValues)[number];
	};
	/** The resolved member — `name` only, never contact details. */
	member: { id: string; name: string };
	roles: PersonalMeetingRole[];
	/**
	 * The member's OWN answer, or null for "no answer".
	 *
	 * Narrower than `AttendancePlanStatus` on purpose: `reached_out` can never
	 * appear here. That rung is an OFFICER's private record of having asked, not
	 * an answer the member gave, and this is a public session-less payload — the
	 * meeting reader filters it out of its public half for exactly this reason
	 * ("`reached_out` is filtered out HERE, once, rather than at each consumer",
	 * `meetings.ts`'s `answeredRungs`). Shipping it would tell any visitor
	 * holding a roster id which members an officer has already chased.
	 *
	 * Collapsing it to null is also the right answer for the page: to the member,
	 * "an officer asked me" is not something they said, so the surface must offer
	 * them both buttons rather than reflect a state back at them.
	 *
	 * Note this is the STORED status, not the officer rail's derived one:
	 * `buildPlanPanel`'s inferred Coming is a display derivation and deliberately
	 * does not travel here, because this page asks the member to state an answer
	 * rather than showing them one inferred on their behalf.
	 */
	planStatus: "coming" | "not_coming" | null;
}

/**
 * The personal view of one meeting for one member, or `null` when the meeting
 * does not exist, its club is archived, the member id is malformed, or the
 * member is not an active member of that club.
 *
 * Collapsing all four into `null` is the same not-found collapse every other
 * public reader here makes: an anonymous caller must not be able to tell an
 * archived club from an unknown meeting from a bad member id.
 */
export async function loadPublicPersonalMeetingView(args: {
	/** The club's UUID, resolved by the `/club/$clubId` shell. */
	clubId: string;
	/** The RAW `$meetingId` URL segment — a club-local date key, a date-HHmm key,
	 *  or a uuid. Not assumed to be any one of them; see below. */
	meetingKey: string;
	memberId: string;
}): Promise<PersonalMeetingView | null> {
	// FIRST, and it does THREE jobs that were three separate bugs before it.
	//
	// 1. It resolves the URL SEGMENT. `$meetingId` is a club-local date key
	//    across this app — every existing producer (`nudgeShareUrl`,
	//    `meeting-nav.ts`, the club index) builds it from `meetingUrlKey`, not
	//    from `meeting.id`. A seam that assumed a uuid rejected every one of
	//    those shapes as "out of date". `resolveMeetingKey` takes date,
	//    date-HHmm OR uuid, so both the key-shaped and uuid-shaped link work.
	// 2. It CLUB-SCOPES. Without a club predicate, a club-A URL carrying a
	//    club-B meeting id rendered club B's meeting — and because the route
	//    keys stored identity on the club URL segment, it then wrote a club-B
	//    member into club A's identity slot. The resolver "returns null for a
	//    uuid that belongs to a different club (so callers get not-found, not a
	//    leak)", which is the same guarantee the sibling meeting route gets.
	// 3. It carries the ARCHIVE gate (`isReadableClub` inside the Public
	//    variant), so an archived club is not-found here like everywhere else.
	//
	// All three collapse into `null`, which is the not-found shape this whole
	// module returns — the caller still has one path.
	// The free synchronous shape check goes FIRST. This endpoint takes no
	// session, so an anonymous request carrying a junk `?as=` would otherwise pay
	// three indexed lookups inside the resolver before a regex that costs nothing
	// rejects it. Safe to hoist above the archive gate: a malformed member id
	// answers `null` regardless of club state, so it reveals nothing about the
	// club and opens no existence oracle.
	if (!UUID_RE.test(args.memberId)) return null;

	const meetingId = await resolvePublicMeetingKey(args.clubId, args.meetingKey);
	if (!meetingId) return null;

	const [meeting] = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			theme: meetings.theme,
			wordOfTheDay: meetings.wordOfTheDay,
			status: meetings.status,
			clubId: clubs.id,
			clubName: clubs.name,
			clubTimezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting) return null;

	// Selected explicitly, never `select()` — a bare select would ship the whole
	// roster row, and `members` carries email and phone (#560). The payload
	// shape is asserted in the integration test for exactly that reason.
	const [member] = await db
		.select({
			id: members.id,
			name: members.name,
			status: members.status,
		})
		.from(members)
		.where(
			and(eq(members.id, args.memberId), eq(members.clubId, meeting.clubId)),
		)
		.limit(1);
	// Mirrors `requireMemberInClub`: present, in THIS club, and not inactive.
	if (!member || member.status === "inactive") return null;

	const slotRows = await db
		.select({
			slotId: roleSlots.id,
			roleName: roleDefinitions.name,
			roleKey: roleDefinitions.key,
			speechTitle: speeches.title,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		// `role_slots.speech_id` is the link — the FK lives on the SLOT, not on
		// `speeches`. Left-joined so a speaking slot with no speech row yet still
		// returns its role (with a null title, which `speech_details` reads as NOT
		// DONE, exactly as an absent field should).
		.leftJoin(speeches, eq(speeches.id, roleSlots.speechId))
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.assignedMemberId, args.memberId),
			),
		)
		.orderBy(roleSlots.slotIndex);

	// Through the seam, not an inline query: `attendance-plan-logic.ts` is where
	// the two status predicates live, and `attendance-plan-store.guard.test.ts`
	// fails any non-test source outside it that names the plan table.
	const storedRung = await getPlanStatus(db, {
		memberId: args.memberId,
		meetingId,
	});
	// `reached_out` collapses to null before it leaves the seam — see
	// `planStatus`'s docblock. Done HERE rather than at the route so an inline
	// consumer added later cannot reintroduce the leak, which is the same reason
	// `meetings.ts` filters it once in its loader instead of per consumer.
	const planStatus = storedRung === "reached_out" ? null : storedRung;

	return {
		club: {
			id: meeting.clubId,

			name: meeting.clubName,
			timezone: meeting.clubTimezone,
		},
		meeting: {
			id: meeting.id,
			scheduledAt: meeting.scheduledAt,
			theme: meeting.theme,
			wordOfTheDay: meeting.wordOfTheDay,
			status: meeting.status,
		},
		member: { id: member.id, name: member.name },
		roles: slotRows.map((r) => ({
			slotId: r.slotId,
			roleName: r.roleName,
			roleKey: r.roleKey,
			speechTitle: r.speechTitle,
		})),
		planStatus,
	};
}
