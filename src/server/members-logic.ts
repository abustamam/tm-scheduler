// VPE roster-management DB logic, split out from the createServerFn wrappers in
// `members.ts`. These are plain `applyX` functions (directly unit-testable —
// the wrappers need the Start runtime). They MUST live here, away from the
// server-fn module, because `members.ts` is imported by the client app shell:
// the Start compiler strips the createServerFn handler bodies (and their `db`
// imports) from the client bundle, but a plain db-touching export sitting in
// that same module is NOT stripped and drags `pg` → `Buffer` into the browser
// (ReferenceError: Buffer is not defined). Keeping the db logic in this
// never-client-imported module keeps `pg` server-side. See `auth-context.ts`.
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	clubActionItems,
	clubs,
	meetingAttendance,
	meetingAwards,
	meetings,
	members,
	people,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { MEMBERSHIP_ENDED_CHANGE } from "#/lib/activity-format";
import { localDateKey } from "#/lib/meeting-url";
import { pastAgendaRemoveRefusal } from "#/lib/member-remove";
import { isOnRoster } from "#/lib/membership-status";
import {
	OFFICER_POSITIONS,
	type OfficerPosition,
	parseOfficerPosition,
} from "#/lib/officers";
import { toStoredPhone } from "#/lib/phone";
import {
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	CONTACT_METHODS,
	CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE,
	CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE,
	effectivePreferredContact,
} from "#/lib/preferred-contact";
import { buildImportPreview } from "#/lib/roster-import";
import {
	type EmailWriteRefusal,
	emailWriteRefusalFor,
	normalizeEmail,
	type RosterObstacle,
	rosterConflictFor,
	soleHoldingClub,
} from "./account-link-logic";
import { logActivity } from "./activity";
import { deletePlanRowsOfEndedMember } from "./attendance-plan-logic";
import { isReadableClub } from "./club-readable-logic";
import { CLUB_BUSY_MESSAGE, lockClubForWrite } from "./club-write-lock";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { contactMethodAvailableSql } from "./contact-preference-logic";
import { withDeadlockRetry } from "./deadlock-retry";
import { lockMeetingForSlotEdit } from "./meeting-slot-lock";
import { meetingAcceptsWrite } from "./meeting-write-gate";
import { PLAN_ACCEPTING_CANCELLED } from "./meeting-write-options";
import {
	collapseMemberships,
	endOfficerTermsOfEndedMember,
} from "./membership-collapse-logic";
import {
	lockMembershipForMerge,
	lockMembershipsAgainstMerge,
} from "./membership-merge-lock";
import {
	currentOfficersByMember,
	currentOfficersFor,
	reconcileOfficerTerms,
} from "./officer-terms-logic";

/** One row of the public member picker. `officerPositions` keeps the NARROW
 *  `OfficerPosition` union rather than `string[]` — the pickers feed it straight
 *  into `officerPositionLabel`, which only accepts the union. */
export interface PublicRosterMember {
	id: string;
	name: string;
	/**
	 * The membership's own "goes by" name (#776 item 4, decided on #788).
	 *
	 * A NAME, not contact: the "members carry no contact" rule (#37) is about
	 * phone and email and is untouched by this column. It was added because
	 * `find_people` declared the field and returned a hardcoded `null` for every
	 * member while the guests in the same list carried theirs — one result
	 * answering the same question two ways depending on `kind`, which reads as
	 * "nobody on the roster has a preferred name".
	 *
	 * `members.preferred_name` only. There is no COALESCE onto
	 * `people.preferred_name` here, deliberately: that fallback belongs to the
	 * contact reader (`meeting-contacts-logic.ts`), and reaching for it would
	 * mean joining `people` onto a PUBLIC, session-less reader to surface a name
	 * a member set in a DIFFERENT club. Null here means this club has none on
	 * file, which is the club's own record.
	 *
	 * OPTIONAL on the interface, always present on the row. `loadPublicClubRoster`
	 * is the only producer and always selects the column; the `?` is for the
	 * picker fixtures that build a `MemberRow` by hand and have no use for a
	 * "goes by" name. `find-people.integration.test.ts` is the behavioural gate
	 * that the reader really does populate it.
	 */
	preferredName?: string | null;
	officerPositions: OfficerPosition[];
}

/**
 * The club's ACTIVE roster for the member-facing name picker — the seam behind
 * the PUBLIC, session-less `listMembers`. Inactive members are hidden here; the
 * VPE roster manager loads them separately. Each row carries its current
 * office(s) derived from open officer terms (#100).
 *
 * Returns `[]` for an archived (or unknown) club (#544). Lifted out of the
 * `createServerFn` handler in `members.ts` — where it was an inline query — for
 * the reason the header above gives about `applyX`: a handler body cannot be
 * reached from a test, so the gate would have been unassertable where it stood.
 * That matters more here than at the other public readers, because this list is
 * ROSTER NAMES: the takedown lever (ADR-0016) is worth little if an archived
 * club's membership stays enumerable through a bare endpoint call.
 */
export async function loadPublicClubRoster(
	clubId: string,
): Promise<PublicRosterMember[]> {
	if (!(await isReadableClub(clubId))) return [];
	const roster = await db
		.select({
			id: members.id,
			name: members.name,
			preferredName: members.preferredName,
		})
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(asc(members.name));
	const officers = await currentOfficersByMember(roster.map((m) => m.id));
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		preferredName: m.preferredName,
		officerPositions: officers.get(m.id) ?? [],
	}));
}

/**
 * Whether a Person is linked to a sign-in account (people.user_id). Gates the
 * merge/remove guards that must not destroy a member who can sign in (ADR-0008
 * Phase B — the auth link moved off the membership row onto the Person).
 */
async function personHasAccount(
	personId: string,
	conn: Pick<typeof db, "select"> = db,
): Promise<boolean> {
	const [row] = await conn
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	return Boolean(row?.userId);
}

/** A drizzle transaction handle (the arg the `db.transaction` callback gets). */
type Tx = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Enforce the "a club always keeps ≥1 active admin" invariant (#187). Throws
 * `message` when NO membership other than `exceptMemberId` is both `active` and
 * `club_role = 'admin'`. Run inside the mutating transaction (read + write
 * commit together) on the two paths that could strand a club with zero admins:
 * demoting an admin (applySetMemberRole) and deactivating an admin
 * (applySetMemberStatus).
 */
async function assertKeepsAnActiveAdmin(
	tx: Tx,
	clubId: string,
	exceptMemberId: string,
	message: string,
): Promise<void> {
	const others = await tx
		.select({ id: members.id })
		.from(members)
		.where(
			and(
				eq(members.clubId, clubId),
				eq(members.status, "active"),
				eq(members.clubRole, "admin"),
				ne(members.id, exceptMemberId),
			),
		)
		.limit(1);
	if (others.length === 0) throw new Error(message);
}

/**
 * The roster member to credit in `activity_log` for a roster write. Deliberately
 * NOT part of the zod schemas below (#396): these fns are all reached through an
 * admin-gated server fn, so the actor is the membership that guard already
 * resolved from the session. Accepting it on the wire is what let an admin of one
 * club post a row crediting another club's member. Null = a system/impersonated
 * write (`logActivity` stamps `impersonated_by` in that case).
 */
interface RosterActor {
	actorMemberId: string | null;
}

export const editSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	name: z.string().trim().min(1),
	// What this member is actually called, when it isn't the first token of
	// `name` (#486). Trimmed-empty is stored as NULL, not "" — a cleared input
	// submits "" and `greetingName` must see "nobody told us", not a blank.
	// OMITTING it clears it, UNLIKE `email`, `phone` and `officerPositions`
	// (whose `undefined` means "leave untouched").
	// Capped because THIS field really can land on a Person other clubs share: its
	// seed-up is guarded only on `people.preferred_name IS NULL`. 80 was the cap
	// the deleted public self-add used for a name (#326/#630); it stays the
	// ceiling for a person-level name here.
	preferredName: z.string().trim().max(80).nullable().optional(),
	// The PERSON's address (#907, ADR-0029). Omitted means leave it alone; `null`
	// (or a blank) clears it. Written only while nobody has signed in as this
	// Person AND this club is their sole holder — otherwise the rest of the
	// edit saves and the response names the refusal (`emailRefused`). A blank
	// is turned into `null` BEFORE `.email()`, which would otherwise reject it.
	email: z.preprocess(
		(v) => (typeof v === "string" && v.trim() === "" ? null : v),
		z.string().trim().email().nullable().optional(),
	),
	// The PERSON's phone (#906), shared by every club that holds them. Omitted
	// (`undefined`) means LEAVE IT ALONE — no write, no log entry — so a
	// name-only save from a stale page cannot revert a number another club has
	// since corrected. An explicit `null` (or a blank) clears it. The member
	// page sends this key only when the field differs from what it loaded.
	phone: z.string().trim().nullable().optional(),
	// How the member wants officers to reach them (#1093), a Person fact.
	// Omitted means leave it alone, like `phone`; the member page sends it only
	// when the officer changed it, and never for a Person who has signed in (the
	// choice is then theirs). `null` clears it. Validated against the email and
	// phone AS THIS SAME EDIT LEAVES THEM, in the write's own WHERE.
	preferredContact: z.enum(CONTACT_METHODS).nullable().optional(),
	// The full set of offices this membership should currently hold (#100). The
	// membership's open officer terms are reconciled to exactly this set: offices
	// added here open a term, offices dropped close their open term (history is
	// kept). Omitted = leave officer terms untouched (edits to name/contact only).
	officerPositions: z.array(z.enum(OFFICER_POSITIONS)).optional(),
});
type EditInput = z.infer<typeof editSchema> & RosterActor;

export type ContactPreferenceRefusal =
	/** The member chose it themselves (including "No preference"). */
	| "member_set"
	/** Another club holds this Person too (or this club does not hold them). */
	| "multi_club";

/**
 * The READ form of the officer preference write's WHERE (#1110), for explaining
 * a refusal and rendering the field read-only. Never the gate: that lives in
 * `applyMemberEdit`'s own UPDATE. Member-set is checked first, then multi-club;
 * null means neither, so a refusal that still happened is "unavailable".
 */
export async function contactPreferenceRefusalFor(
	personId: string,
	clubId: string,
	executor: Pick<typeof db, "select" | "selectDistinct"> = db,
): Promise<ContactPreferenceRefusal | null> {
	const [row] = await executor
		.select({ by: people.contactPreferenceBy })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	if (!row) return "multi_club";
	if (row.by === "member") return "member_set";
	const clubs = await executor
		.selectDistinct({ clubId: members.clubId })
		.from(members)
		.where(eq(members.personId, personId));
	return clubs.length === 1 && clubs[0]?.clubId === clubId
		? null
		: "multi_club";
}

/**
 * Update a roster member's name/contact and reconcile their office set (#100);
 * logs member_edit with the office change.
 *
 * **The phone written here is `people.phone`** (#906): a phone number is a
 * Person fact, so an edit in any club that holds the Person changes it in every
 * club. It is not a credential, so there is no cross-club authority question.
 *
 * **The email written here is `people.email`** (#907, ADR-0029) — the Person's
 * one address, which is also what binds a sign-in. An officer may correct it
 * (a typo) only while nobody has signed in as this Person AND this club is the
 * Person's sole holder; both predicates sit in the UPDATE's own WHERE, so a
 * bind landing between the form's load and this save makes the write a no-op.
 * A refused email does not refuse the edit: the other fields still save, and
 * `emailRefused` says why (`bound` | `multi_club`). An input that normalises to
 * the address already on file is not part of the write at all — never refused,
 * never logged — so a bound member's profile saves cleanly.
 *
 * @returns `rosterConflict`, the obstacle that would now stop this member
 * binding an account, or null. **Reported, not refused** — and it is not only
 * about the member being edited: typing an address another active member already
 * carries makes the roster ambiguous and revokes THEIR sign-in too, on a screen
 * that shows no sign of them. `member-email-ownership.integration.test.ts` holds
 * the rule.
 */
export async function applyMemberEdit(input: EditInput) {
	// A deadlock with a speaker claim (#1388) aborts one side; run the whole
	// edit again once, reads and outer state included.
	return withDeadlockRetry(async () => {
		const [current] = await db
			.select()
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			);
		if (!current) throw new Error("Member not found.");
		// Standardize the phone to E.164 on write (#295), using the club default
		// country code for numbers entered without one.
		const cc = await loadClubDefaultCountryCode(input.clubId);
		const next = {
			name: input.name,
			// Trim HERE, not only in the zod schema: `applyMemberEdit` is exported and
			// called directly (tests, and any future server-side caller) with the
			// validator bypassed. A whitespace-only value would otherwise store "   "
			// AND seed "   " onto people.preferred_name, permanently defeating the
			// isNull guard below so the real name could never seed up.
			preferredName: input.preferredName?.trim() || null,
		};
		// Trimmed HERE for the same reason as `preferredName` above: the zod schema
		// trims, but `applyMemberEdit` is exported and reached directly with the
		// validator bypassed. `undefined` = leave the Person's address alone.
		const email =
			input.email === undefined ? undefined : input.email?.trim() || null;
		// Person-level, written to `people` below rather than to the membership —
		// and only when the caller sent one (`undefined` = leave it alone).
		const phone =
			input.phone === undefined ? undefined : toStoredPhone(input.phone, cc);
		// `undefined` = leave the Person's preference alone (#1093).
		const preferredContact = input.preferredContact;
		// Current offices before the edit — derived from open terms, for the log.
		const beforeOffices = await currentOfficersFor(input.memberId);
		let emailChange: { before: string | null; after: string | null } | null =
			null;
		let emailRefused: EmailWriteRefusal | null = null;
		await db.transaction(async (tx) => {
			// LOCK ORDER: the Person, THEN the membership. Guest conversion
			// (`applyConvertGuestToMember`) writes the Person (its phone fill and its
			// goes-by seed) and then takes the membership `FOR UPDATE`; taking them
			// here in the opposite order deadlocks the two (#906 review).
			// `edit-convert-lock-order.integration.test.ts` drives both orders.
			//
			// The Person lock is also what the email write below relies on (#907): a
			// bind that commits first is seen by its WHERE, one that arrives later
			// waits for this transaction.
			const [currentPerson] = await tx
				.select({
					phone: people.phone,
					email: people.email,
					userId: people.userId,
					storedPreferredContact: people.preferredContact,
				})
				.from(people)
				.where(eq(people.id, current.personId))
				.for("update");
			if (!currentPerson) throw new Error("Member's person not found.");
			if (phone !== undefined) {
				// The phone is the Person's (#906), so it goes to `people`, keyed by
				// the membership's own `person_id` — never a membership row.
				await tx
					.update(people)
					.set({ phone })
					.where(eq(people.id, current.personId));
			}
			// The email (#907): written whenever the stored STRING differs, so an
			// officer can repair a stored address carrying a NBSP or U+FEFF — JS
			// `.trim()` hides those and SQL `[[:space:]]` does not, so comparing
			// normalised values reported success while the bind kept failing. A
			// refusal is only REPORTED when the address actually differs
			// (normalised): a case- or whitespace-only difference on a bound or
			// shared Person is the same address, never refused and never logged.
			if (email !== undefined && email !== currentPerson.email) {
				const written = await tx
					.update(people)
					.set({ email })
					.where(
						and(
							eq(people.id, current.personId),
							isNull(people.userId),
							soleHoldingClub(input.clubId),
						),
					)
					.returning({ id: people.id });
				if (written.length > 0) {
					emailChange = { before: currentPerson.email, after: email };
				} else if (
					normalizeEmail(email) !== normalizeEmail(currentPerson.email)
				) {
					emailRefused =
						(await emailWriteRefusalFor(current.personId, input.clubId, tx)) ??
						"multi_club";
				}
			}
			// The contact preference (#1093, #1110). AFTER the phone and email writes, so
			// its WHERE judges availability against the row as this edit leaves it:
			// clearing the phone and choosing SMS in one save matches nothing. Three
			// rules sit in the UPDATE's own WHERE, not in a prior read: the member
			// has not chosen it themselves (provenance is NULL or 'officer'); this club is
			// their SOLE holder (the rule `people.email` has, ADR-0029, applied to
			// the preference too; the phone has no such rule); and the method's
			// data exists.
			//
			// Zero rows refuses the WHOLE edit — unlike the email, whose refusal lets
			// the rest of the save land. The throw rolls back every write above, so
			// nothing in this save lands. The WHERE decides; the message is
			// BEST-EFFORT. It comes from a read after the UPDATE that holds no
			// membership lock, so another club removing its membership in between
			// can turn a multi-club refusal into "add a phone number or email". No
			// lock is taken for that: the outcome (refused, nothing written) is right
			// either way, and only the sentence can be stale.
			if (preferredContact !== undefined) {
				const written = await tx
					.update(people)
					.set({ preferredContact, contactPreferenceBy: "officer" })
					.where(
						and(
							eq(people.id, current.personId),
							or(
								isNull(people.contactPreferenceBy),
								eq(people.contactPreferenceBy, "officer"),
							),
							soleHoldingClub(input.clubId),
							contactMethodAvailableSql(preferredContact),
						),
					)
					.returning({ id: people.id });
				if (written.length === 0) {
					// Ownership before availability, so a multi-club Person whose
					// email write was just refused hears "another club", not "add an
					// email" (#1093 review) — subject to the race described above.
					const owner = await contactPreferenceRefusalFor(
						current.personId,
						input.clubId,
						tx,
					);
					throw new Error(
						owner === "member_set"
							? CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE
							: owner === "multi_club"
								? CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE
								: CONTACT_METHOD_UNAVAILABLE_MESSAGE,
					);
				}
			}
			// The "goes by" name below is the only other person-level write this form makes
			// besides the phone above (which is a Person fact outright, #906), and it
			// is scoped by VALUE rather than by blast radius. That is
			// deliberate: `preferred_name` is a display fallback, so the worst a stale
			// copy costs is a wrong greeting in another club, and one club overwriting
			// another's answer is the only risk worth guarding. The email used to sit
			// here under a much stricter rule because it could re-key an identity; #756
			// removed the write instead of tightening the rule again. Do not read that
			// as licence to seed anything else up from a roster row without asking what
			// its worst case is.
			//
			// The "goes by" name (#486): it is a person-level fact
			// (ADR-0008) that should travel with them, so seed it UP when the Person
			// has none. Guarded on NULL so a second club's admin can't overwrite what
			// this person recorded elsewhere — the membership row is always authoritative
			// for THIS club either way.
			if (next.preferredName !== null) {
				await tx
					.update(people)
					.set({ preferredName: next.preferredName })
					.where(
						and(eq(people.id, current.personId), isNull(people.preferredName)),
					);
			} else if (current.preferredName !== null) {
				// CLEARING has to clear both, or it does nothing at all. The read is a
				// coalesce onto `people.preferred_name`, so leaving the Person copy
				// behind resurrects the exact name the admin just deleted — and the form
				// promises "leave blank to use their first name". Scoped to the value
				// this membership seeded, so a different answer recorded by another club
				// survives untouched.
				await tx
					.update(people)
					.set({ preferredName: null })
					.where(
						and(
							eq(people.id, current.personId),
							eq(people.preferredName, current.preferredName),
						),
					);
			}
			// A former member (#1239) holds no office: opening a term would put them
			// back on the officers list and grant admin-adjacent access. Read under
			// the row lock so an end-membership racing this edit cannot slip past.
			if (input.officerPositions !== undefined) {
				const [locked] = await tx
					.select({ status: members.status })
					.from(members)
					.where(eq(members.id, input.memberId))
					.for("update");
				if (locked?.status === "former" && input.officerPositions.length > 0) {
					throw new Error(
						"A former member can't hold an office — reactivate them first.",
					);
				}
			}
			// The membership last — see LOCK ORDER above.
			await tx.update(members).set(next).where(eq(members.id, input.memberId));
			// Reconcile the office set only when the caller sent one (undefined = leave
			// terms alone). Dedupe first so a repeated office can't open two terms.
			if (input.officerPositions !== undefined) {
				await reconcileOfficerTerms(tx, input.memberId, [
					...new Set(input.officerPositions),
				]);
			}
			const afterOffices =
				input.officerPositions !== undefined
					? [...new Set(input.officerPositions)]
					: beforeOffices;
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "member_edit",
				targetType: "member",
				targetId: input.memberId,
				detail: {
					before: {
						name: current.name,
						preferredName: current.preferredName,
						// Logged only when the edit wrote it.
						...(emailChange ? { email: emailChange.before } : {}),
						// Logged only when the edit wrote it.
						...(phone !== undefined ? { phone: currentPerson.phone } : {}),
						// Logged only when the edit wrote it: the preference as it was
						// SHOWN, never the raw column (#1093).
						...(preferredContact !== undefined
							? {
									preferredContact: effectivePreferredContact(
										currentPerson.storedPreferredContact,
										currentPerson,
									),
								}
							: {}),
						officerPositions: beforeOffices,
					},
					after: {
						...next,
						...(emailChange ? { email: emailChange.after } : {}),
						...(phone !== undefined ? { phone } : {}),
						...(preferredContact !== undefined ? { preferredContact } : {}),
						officerPositions: afterOffices,
					},
				},
			});
		});

		// Did this edit leave the member unable to sign in? Reported, never refused.
		//
		// The case that makes this necessary is not only the member being edited:
		// typing an address ANOTHER Person already carries makes it ambiguous, and
		// the bind then refuses BOTH of them. So a save on Alice's row can silently
		// revoke Bob's sign-in — a member the admin was not editing and cannot see
		// from this screen. The invite button and the bulk dialog both ask this
		// question; the edit form is where the address is actually typed.
		//
		// Skipped for a Person who already holds an account: nothing this form can
		// write affects their sign-in.
		const rosterConflict = await personEmailObstacle(current.personId);
		return { ok: true as const, rosterConflict, emailRefused };
	});
}

/** The bind obstacle for a member's Person, or null — including for an already
 *  linked Person or one with no address. */
async function personEmailObstacle(
	personId: string,
): Promise<RosterObstacle | null> {
	const [person] = await db
		.select({ userId: people.userId, email: people.email })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	if (!person || person.userId || !normalizeEmail(person.email)) return null;
	return rosterConflictFor(personId, person.email ?? "");
}

export const setStatusSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	status: z.enum(["active", "inactive", "former"]),
});
type SetStatusInput = z.infer<typeof setStatusSchema> & RosterActor;

/** Toggle a roster member active/inactive. Inactive members are hidden from
 *  sign-up / roster / season / picker views and can't claim or be assigned new
 *  roles, but their past role history is preserved (never deleted) and
 *  reactivating restores them everywhere. Ending a membership (→ former) also
 *  deletes the member's planned-attendance answers on meetings that are not
 *  completed (#1342); going inactive keeps them. Logs member_edit with the status
 *  before/after. On an active→inactive transition their UPCOMING role slots are
 *  released (mirrors applyMemberRemove); past slots are left untouched.
 *  "Upcoming" includes a CANCELLED future meeting (#1057): cancelling keeps its
 *  assignments so a restore loses nothing, so a slot left held here would come
 *  back on the live agenda in the name of someone no longer active.
 *
 *  **"Restores them everywhere" is true HERE and deliberately NOT true of the
 *  other reactivation path.** There are two, and they mean different things
 *  (#501 review):
 *
 *  - THIS one is an admin on the roster naming a member and saying "they are
 *    back". inactive → active writes `{ status }` and nothing else, so
 *    `club_role` survives untouched and the member returns with exactly the
 *    standing they lapsed with. That is the intent: the admin picked this
 *    human on purpose. **former → active restores role `member` (#1340):**
 *    ending a membership writes `club_role = 'member'` in the same UPDATE, and
 *    a stale `admin` on a former row (data from before #1340) is written down
 *    too, so coming back is never a promotion. An admin who wants them as an
 *    admin again says so with Set role.
 *  - `applyConvertGuestToMember`'s REUSE branch wakes a lapsed membership as a
 *    side effect of converting a GUEST, and the row it lands on is chosen by
 *    Person dedup, which can match the wrong human (#561). So it writes an
 *    elevated `club_role` back DOWN to `member` and tells the admin it did.
 *    Reactivating there asserts visibility, never authority.
 *
 *  The asymmetry is load-bearing because `status` IS the write-authorization
 *  gate: `requireMembership` sends a non-active membership to
 *  `requireReadWriteImpersonation`, so nothing below `status` is ever consulted
 *  while a membership is lapsed and a stale `club_role: admin` is invisible
 *  until something sets `status` back. That is why this fn may leave it alone
 *  and convert may not. If a third reactivation path ever appears, it has to
 *  choose one of these two meanings explicitly — and say which, here. */
export async function applySetMemberStatus(input: SetStatusInput) {
	await db.transaction(async (tx) => {
		// The club write lock (#1327), FIRST, as the merge takes it: it serializes
		// this with every other status and role change in the club, so the
		// last-admin count below cannot be taken against a snapshot two admins
		// ending each other both pass. Club write lock -> merge lock -> row locks.
		await lockClubForWrite(tx, input.clubId);
		// The membership merge lock (#1035), SHARED, before any row lock or write
		// (#1189): the global rule, see `applyMemberRemove`. A removal holds it
		// EXCLUSIVE for its whole transaction, so the two never interleave. Without
		// it this UPDATE took the member row, then the member's slots, while the
		// removal took the slots, then the member row: 40P01. A member the removal
		// deleted while this waited is refused with `CLUB_BUSY_MESSAGE`.
		await lockMembershipsAgainstMerge(tx, [input.memberId]);
		// The status is read HERE, under the row lock (#1239): two admins racing
		// (end + reactivate) each decide from the state the other left, never
		// from a stale pre-transaction read.
		const [current] = await tx
			.select()
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			// NO KEY UPDATE, not UPDATE (#1327): FOR UPDATE blocks the key-share an
			// FK insert takes on this row, so End deadlocked (40P01) with a member
			// releasing their own role (its activity-log insert key-shares them
			// while End waits on that release's slot), and with a second admin
			// ending this one (the audit insert key-shares the actor row).
			// Everything this transaction writes to the row is a plain UPDATE,
			// which takes this mode anyway.
			.for("no key update");
		if (!current) throw new Error("Member not found.");
		// Same → same (including former → former) is a no-op: no write, no log.
		if (current.status === input.status) return;
		const deactivating =
			current.status === "active" && input.status === "inactive";
		// Leaving the roster for good (#1239): same release of upcoming slots as
		// going inactive, plus the end date and the open officer terms.
		const ending = isOnRoster(current.status) && input.status === "former";
		const releasing = deactivating || ending;
		// #1340: a membership that ends, or comes back from former, holds role
		// `member`. Ending is when the permission stops; coming back is never a
		// promotion, so a stale `admin` on a former row is not restored.
		const demotes = ending || current.status === "former";
		const now = new Date();
		// Guardrail (#187): deactivating an admin must not strand the club with
		// zero active admins — that would silently bypass the demote guard. Only an
		// ACTIVE admin counts toward that (#1326): an inactive one is already out
		// of the active-admin count, so ending them cannot lower it.
		if (
			(deactivating || ending) &&
			current.clubRole === "admin" &&
			current.status === "active"
		) {
			await assertKeepsAnActiveAdmin(
				tx,
				input.clubId,
				input.memberId,
				ending
					? "You can't end the membership of the club's last admin — promote another member to admin first."
					: "You can't deactivate the club's last admin — promote another member to admin first.",
			);
		}
		// `ended_at` is the club-local day the membership ended; any move away from
		// former clears it (#1239).
		let endedAt: string | null = current.endedAt;
		if (ending) {
			const [club] = await tx
				.select({ timezone: clubs.timezone })
				.from(clubs)
				.where(eq(clubs.id, input.clubId));
			endedAt = localDateKey(now, club?.timezone || "UTC");
		} else if (current.status === "former") {
			endedAt = null;
		}
		await tx
			.update(members)
			.set({
				status: input.status,
				endedAt,
				// Ending drops the role; leaving former restores `member` (#1340).
				// Also clears a stale `admin` an ended row still carries.
				...(demotes ? { clubRole: "member" as const } : {}),
			})
			.where(eq(members.id, input.memberId));
		// What an End did beyond the status flip, recorded on the activity row
		// (#1328) the way convert records `closedOfficerPositions`: nothing else
		// readable afterwards says which offices ended or how many roles let go.
		const closedOfficerPositions: string[] = [];
		let releasedSlots = 0;
		if (ending) {
			// Every open officer term closes today, in this transaction, so a
			// failure here leaves the status unchanged (`endOfficerTermsOfEndedMember`).
			closedOfficerPositions.push(
				...(await endOfficerTermsOfEndedMember(tx, input.memberId, now)),
			);
		}
		// Free up their upcoming roles so the VPE can re-fill them; past slots
		// and a completed meeting's slots stay assigned (history preserved).
		// A cancelled future meeting is released too (#1057, #1154).
		if (releasing) {
			const upcoming = await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(
					and(
						eq(roleSlots.assignedMemberId, input.memberId),
						gte(meetings.scheduledAt, new Date()),
					),
				)
				// In slot-id order, the order `applyMoveSlot` writes a pair in, so an
				// End and a reorder of the member's slots cannot wait on each other
				// (#1327).
				.orderBy(asc(roleSlots.id));
			for (const s of upcoming) {
				// Unlink any speech (speech_id → NULL); the speech persists
				// Person-owned and unscheduled (ADR-0009 — never destroyed).
				// The meeting's status rides in the UPDATE (#1154): `scheduledAt >= now` is an
				// instant, `completeMeeting` closes by the club-local day, so a meeting completed
				// this afternoon and scheduled for this evening matches the SELECT above. The
				// UPDATE refuses it, so the release keeps its status, claimedAt and speechId.
				// A cancelled future meeting is still released (#1057). The log follows
				// RETURNING, so it names only the slots actually released.
				const released = await tx
					.update(roleSlots)
					.set({
						assignedMemberId: null,
						status: "open",
						claimedAt: null,
						speechId: null,
					})
					.where(
						and(
							eq(roleSlots.id, s.id),
							// Still held by THIS member at UPDATE time: the SELECT above is a snapshot, and
							// a slot reassigned since must not lose its new holder or speech link.
							eq(roleSlots.assignedMemberId, input.memberId),
							meetingAcceptsWrite(
								tx,
								"plan",
								roleSlots.meetingId,
								PLAN_ACCEPTING_CANCELLED,
							),
						),
					)
					.returning({ id: roleSlots.id });
				if (released.length === 0) continue;
				releasedSlots++;
				await logActivity(tx, {
					clubId: input.clubId,
					actorMemberId: input.actorMemberId,
					action: "release",
					targetType: "slot",
					targetId: s.id,
					detail: { fromMemberId: input.memberId },
				});
			}
		}
		// Their planned-attendance answers on meetings still to come go with the
		// membership (#1342): a person who has left has none to give, and a row
		// left here would keep naming them on the meeting's public "not coming"
		// list. A completed meeting's answers stay, like its slots and roll.
		if (ending) await deletePlanRowsOfEndedMember(tx, input.memberId);
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				before: { status: current.status, clubRole: current.clubRole },
				after: {
					status: input.status,
					clubRole: demotes ? "member" : current.clubRole,
				},
				...(ending || current.status === "former"
					? { endedAt: { before: current.endedAt, after: endedAt } }
					: {}),
				// An End is told apart from a field edit by `change` (the feed reads
				// it, `activity-format.ts`) and names who it ended by `memberId`.
				...(ending
					? {
							change: MEMBERSHIP_ENDED_CHANGE,
							memberId: input.memberId,
							closedOfficerPositions,
							releasedSlots,
							// Only when the role actually changed.
							...(current.clubRole !== "member"
								? { releasedClubRole: current.clubRole }
								: {}),
						}
					: {}),
			},
		});
	});
	return { ok: true as const, status: input.status };
}

export const setRoleSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	clubRole: z.enum(["admin", "member"]),
});
type SetRoleInput = z.infer<typeof setRoleSchema> & RosterActor;

/**
 * Set a member's `club_role` (admin ⇄ member) — a PERMISSION change (#187),
 * ORTHOGONAL to officer position: officer terms are deliberately left untouched
 * (`club_role` and offices diverged at insert time and never reconcile). A
 * no-op when the role is unchanged (no write, no log). Enforces the club-keeps-
 * ≥1-active-admin invariant on the demote path (admin→member) and logs
 * member_edit with the role before/after.
 */
export async function applySetMemberRole(input: SetRoleInput) {
	return db.transaction(async (tx) => {
		// The club write lock (#1327), first: the last-admin check below reads
		// other rows, so it runs serialized with every status change in the club.
		await lockClubForWrite(tx, input.clubId);
		// Read under the row lock (#1340): an end-membership racing this change
		// cannot be overwritten by a promotion computed from a stale read. NO KEY
		// UPDATE, not UPDATE: the activity insert below key-shares the ACTOR's
		// member row, so two admins changing each other's role would deadlock
		// under FOR UPDATE (#1327 item 3).
		const [current] = await tx
			.select()
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.for("no key update");
		if (!current) throw new Error("Member not found.");
		// A former member holds no role (#1340): ending one writes `member`, and
		// reactivating restores `member`; a role is set on an active or inactive row.
		if (current.status === "former") {
			throw new Error(
				"A former member holds no club role — reactivate them first.",
			);
		}
		// Idempotent: nothing changed → nothing to write or log.
		if (current.clubRole === input.clubRole) {
			return { ok: true as const, clubRole: current.clubRole };
		}
		const demoting =
			current.clubRole === "admin" && input.clubRole === "member";
		// Guardrail (#187): a demote can lower the active-admin count (a promote
		// only raises it). An INACTIVE admin isn't counted, so a demote can only
		// strand the club when the target is currently an active admin.
		if (demoting && current.status === "active") {
			await assertKeepsAnActiveAdmin(
				tx,
				input.clubId,
				input.memberId,
				"You can't remove the club's last admin — promote another member to admin first.",
			);
		}
		await tx
			.update(members)
			.set({ clubRole: input.clubRole })
			.where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				before: { clubRole: current.clubRole },
				after: { clubRole: input.clubRole },
			},
		});
		return { ok: true as const, clubRole: input.clubRole };
	});
}

export const mergeSchema = z.object({
	clubId: z.string().uuid(),
	keeperId: z.string().uuid(),
	absorbedId: z.string().uuid(),
});
type MergeInput = z.infer<typeof mergeSchema> & RosterActor;

/** Merge an absorbed member into a keeper: re-point assignments, availability
 *  (dedupe meeting conflicts), and activity history; delete the absorbed; log
 *  member_merge. A user-linked member may not be absorbed. */
export async function applyMemberMerge(input: MergeInput) {
	const { clubId, keeperId, absorbedId } = input;
	if (keeperId === absorbedId) {
		throw new Error("Pick two different members to merge.");
	}
	const rows = await db
		.select()
		.from(members)
		.where(
			and(
				inArray(members.id, [keeperId, absorbedId]),
				eq(members.clubId, clubId),
			),
		);
	const keeper = rows.find((m) => m.id === keeperId);
	const absorbed = rows.find((m) => m.id === absorbedId);
	if (!keeper || !absorbed) throw new Error("Member not found in this club.");
	// "Signed-in account?" is a Person-level fact now (ADR-0008 Phase B): the auth
	// link lives on people.user_id. Don't absorb a member whose person can sign in.
	if (await personHasAccount(absorbed.personId)) {
		throw new Error(
			"That member is a signed-in account — merge the other direction (keep it).",
		);
	}

	await db.transaction(async (tx) => {
		await collapseMemberships(tx, clubId, keeperId, absorbedId, {
			actorMemberId: input.actorMemberId,
		});
		await logActivity(tx, {
			clubId,
			actorMemberId: input.actorMemberId,
			action: "member_merge",
			targetType: "member",
			targetId: keeperId,
			detail: {
				absorbedId,
				absorbedName: absorbed.name,
				keeperName: keeper.name,
			},
		});
	});
	return { ok: true as const };
}

export const removeSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
});
type RemoveInput = z.infer<typeof removeSchema> & RosterActor;

const SIGNED_IN_REMOVE_MESSAGE =
	"That member is a signed-in account and can't be removed.";

/** The foreign keys to `members.id` that print a name on an agenda and are
 *  ON DELETE SET NULL, so deleting the member blanks that name on a finished
 *  agenda and its minutes (#1189). One row per key: the table, its member column,
 *  and the column naming the meeting. The sweep test in
 *  `member-remove-past-agenda.integration.test.ts` reads the database for every
 *  such key and fails on one that is neither here nor in its "considered" list.
 *  Votes, vote sessions and project marks also null out, but print no name on an
 *  agenda, so they are not here. Action items are not here either: they carry no
 *  meeting column, so they have their own list just below. */
export const PAST_AGENDA_MEMBER_KEYS = [
	{
		table: roleSlots,
		memberColumn: roleSlots.assignedMemberId,
		meetingColumn: roleSlots.meetingId,
	},
	{
		table: meetingAttendance,
		memberColumn: meetingAttendance.memberId,
		meetingColumn: meetingAttendance.meetingId,
	},
	{
		table: tableTopicsSpeakers,
		memberColumn: tableTopicsSpeakers.memberId,
		meetingColumn: tableTopicsSpeakers.meetingId,
	},
	{
		table: meetingAwards,
		memberColumn: meetingAwards.memberId,
		meetingColumn: meetingAwards.meetingId,
	},
] as const;

/** Keys to `members.id` that print a name on a past agenda but have NO meeting
 *  column (#1189, maintainer decision: minutes are part of the meeting's record).
 *  `club_action_items` is "deliberately NOT owned by a meeting" (schema.ts), so the
 *  meeting is derived from time exactly as the minutes derive it: an item is printed,
 *  with its owner, in the minutes of every meeting `P` of its club with
 *  `createdAt <= P.scheduledAt` and (`resolvedAt` null or `resolvedAt >
 *  P.scheduledAt`) (`openAsOf`, `loadActionItemsForMinutes`). A CLOSED item prints its
 *  text only, never its owner, so it prints a name only in those windows. The owner
 *  therefore blocks removal when any such `P` is a past agenda meeting
 *  (`isPastAgendaMeeting`, the same definition as above). The sweep test checks
 *  this list alongside `PAST_AGENDA_MEMBER_KEYS`. The row caps on the minutes' lists
 *  are ignored: refusing is the safe direction. */
export const PAST_AGENDA_TIME_WINDOW_KEYS = [
	{
		table: clubActionItems,
		memberColumn: clubActionItems.ownerMemberId,
	},
] as const;

/** A meeting whose agenda is already history (#1189): `completed`, or its time has
 *  passed and it was not cancelled. Completing is a manual step, so a past meeting
 *  often stays `scheduled`; its agenda prints the same names. A cancelled one
 *  printed nothing, so it does not count. `now` is the caller's ONE clock: the
 *  release below uses `>= now` on the same value, so a meeting is on exactly one
 *  side of the line. */
function isPastAgendaMeeting(
	meeting: { status: string; scheduledAt: Date },
	now: Date,
): boolean {
	return (
		meeting.status === "completed" ||
		(meeting.scheduledAt.getTime() < now.getTime() &&
			meeting.status !== "cancelled")
	);
}

/** Every meeting the member appears on through the keys above, plus every meeting
 *  of the club whose minutes print an action item they own (see
 *  `PAST_AGENDA_TIME_WINDOW_KEYS`). Plain reads: no lock is taken. */
async function footprintMeetingIds(tx: Tx, memberId: string, clubId: string) {
	const meetingIds = new Set<string>();
	for (const key of PAST_AGENDA_MEMBER_KEYS) {
		const rows = await tx
			.select({ meetingId: key.meetingColumn })
			.from(key.table)
			.where(eq(key.memberColumn, memberId));
		for (const r of rows) meetingIds.add(r.meetingId);
	}
	// Action items have no meeting: join on the minutes' own window (`openAsOf`).
	const windowed = await tx
		.selectDistinct({ id: meetings.id })
		.from(meetings)
		.innerJoin(
			clubActionItems,
			and(
				eq(clubActionItems.ownerMemberId, memberId),
				gte(meetings.scheduledAt, clubActionItems.createdAt),
				or(
					isNull(clubActionItems.resolvedAt),
					lt(meetings.scheduledAt, clubActionItems.resolvedAt),
				),
			),
		)
		.where(eq(meetings.clubId, clubId));
	for (const r of windowed) meetingIds.add(r.id);
	return meetingIds;
}

/** The footprint above, plus every slot the member holds and every action item
 *  they own, read fresh. Slots and items come back in id order, the order they
 *  are locked in. */
async function memberFootprint(tx: Tx, memberId: string, clubId: string) {
	const meetingIds = await footprintMeetingIds(tx, memberId, clubId);
	const slots = await tx
		.select({ id: roleSlots.id, meetingId: roleSlots.meetingId })
		.from(roleSlots)
		.where(eq(roleSlots.assignedMemberId, memberId))
		.orderBy(asc(roleSlots.id));
	const items = await tx
		.select({ id: clubActionItems.id })
		.from(clubActionItems)
		.where(eq(clubActionItems.ownerMemberId, memberId))
		.orderBy(asc(clubActionItems.id));
	return { meetingIds, slots, itemIds: items.map((i) => i.id) };
}

/** Does the member look to be on a past agenda right now? Plain reads, no lock of
 *  any kind (the early refusal in `applyMemberRemove`). A meeting's status can
 *  change right after, which is why a member this finds NOT on one still goes
 *  through the locked path; a wrong "yes" here is the safe direction. */
async function appearsOnPastAgenda(
	tx: Tx,
	memberId: string,
	clubId: string,
	now: Date,
): Promise<boolean> {
	const ids = [...(await footprintMeetingIds(tx, memberId, clubId))];
	if (ids.length === 0) return false;
	const rows = await tx
		.select({ status: meetings.status, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(inArray(meetings.id, ids));
	return rows.some((m) => isPastAgendaMeeting(m, now));
}

/** Remove a member: release their upcoming slots (logged) then delete them
 *  (availability cascades). A user-linked member can't be removed, and neither can
 *  one who appears on a past agenda (#1189): the foreign keys would blank their
 *  name there, so an officer marks them inactive instead. "Upcoming"
 *  includes a CANCELLED future meeting (#1057): a slot left there would be
 *  `claimed` by nobody once the FK nulls the holder — unclaimable, per
 *  `membership-merge-lock.ts` — and a restore would put it on the live agenda.
 *
 *  THE GLOBAL LOCK RULE (#1189, maintainer decision 2026-10-13): **the membership
 *  merge lock first.** A writer that can hold a row lock on one of a member's rows
 *  and then ask for a meeting, slot or member lock takes the merge lock before ANY
 *  row lock, SHARED; the removal takes it EXCLUSIVE, so the two can never interleave.
 *
 *    removal: [unlocked early refusal] → merge lock (exclusive) → meeting rows,
 *    ascending id (FOR NO KEY UPDATE) → the member's slot rows, id order (FOR
 *    UPDATE) → the member's action items, id order (FOR UPDATE) → member row (FOR
 *    UPDATE) → releases, delete
 *
 *  Takes the merge lock first (shared): `claimSlotCore`, `castVote` and the
 *  candidate write in `voting-logic.ts`, `createSpeechRequest` and, since #1189,
 *  `scheduleSpeechRequest` (its request-row lock, then the meeting, then
 *  cascade-deleted by the removal's DELETE: 40P01 without it) and
 *  `applySetMemberStatus`. Deactivate is the case that needs it: its member-row
 *  UPDATE, then the member's slots, against the removal's slots, then member row
 *  (40P01 without it). Reactivate touches no slots; it takes the lock too, harmlessly,
 *  so both directions share one path. Exclusive: `collapseMemberships` (the absorbed
 *  member) and this function.
 *
 *  Do NOT take it, and cannot deadlock with the removal, because each asks for the
 *  slot or the meeting BEFORE the member row (the removal's order) and none
 *  holds a row the removal's DELETE cascades into while it waits: `reassignSlotCore`
 *  and `releaseSlotCore` (slot row only: NEITHER takes a meeting lock, the meeting's
 *  status rides in their UPDATE through `meetingAcceptsWrite`), `rescheduleSpeech`
 *  (`attachSpeechToOpenSlot`: slot rows, then the FK on the new holder), the guest
 *  convert and link (guest-held slots re-pointed at the member: the FK is their only
 *  touch), the minutes writers (attendance, Table Topics, awards: an insert or
 *  update, the FK KEY SHARE last) and the action-item writers (item row, then the
 *  FK). If one of them lands a row on the member first, the removal's member-row
 *  lock waits for it, re-reads, and stops with CLUB_BUSY_MESSAGE when the row is on
 *  a meeting or slot it does not hold; if the removal is first the writer waits on
 *  the member row and then fails its FK check. A writer that takes a meeting lock
 *  takes it FIRST, before any of the member's rows: complete, reopen, cancel,
 *  restore, digital voting, `assign_roles` (its batch calls the reassign and release
 *  cores under that lock), the slot add, remove and move writers,
 *  `backfillMissingRoleSlots`, the template conversion and the speech-log edit. Each
 *  takes the meeting lock before it locks a slot or writes a row naming a member.
 *
 *  These five writers used to form a cycle with the removal and deadlock (40P01), and
 *  no longer do (#1217): each takes the membership merge lock before its first row lock
 *  (`membership-merge-lock.ts`), which the removal holds EXCLUSIVE. Shared for unlinking a
 *  guest, `setMentorshipFocus`, a full-year dues payment and
 *  `releaseSlotsAndMarkUnavailable`; EXCLUSIVE for undoing a guest conversion, which
 *  deletes the membership as this does.
 *  `src/server/writers-vs-member-removal.integration.test.ts` reproduces each cycle.
 *  The mentorship writers other than `setMentorshipFocus`, `undoDues` and `waiveDues`
 *  take no such lock and are not covered.
 *
 *  Not covered, by design: a meeting INSERTED into an action item's window, or a
 *  meeting RESCHEDULED into it from outside, after the second footprint read below
 *  (neither is a meeting this transaction holds, so neither is serialised; the
 *  second read catches the ones that commit before it).
 *
 *  - Early refusal: before any lock the member's footprint is read with plain
 *    selects. On a past agenda it refuses at once, so a long-tenured member, or one
 *    owning an old open action item (every later meeting of the club is in its
 *    window), never costs the club a lock per meeting just to be told no. A wrong
 *    refusal there is the safe direction (the member really was on one a moment
 *    ago). A member who looks removable proceeds and is judged again under the locks.
 *  - Action items (#1189): an item has no meeting, so the meetings read and locked
 *    are every meeting of the club inside the window of an item the member owns
 *    (`PAST_AGENDA_TIME_WINDOW_KEYS`), future and cancelled ones included, because a
 *    completion, restore or reschedule would make one of them a past agenda. The item
 *    writers (`updateActionItem`, resolve, reopen) are single statements that take the
 *    item row, then the FK's KEY SHARE on the member row: the same order as here, so
 *    no cycle. Locking the items stops a reopen (which widens an item's window) from
 *    landing between the check and the delete.
 *  - Holding the meeting rows is what makes the status the check reads the status the
 *    delete acts on: a completion, cancellation or restore waits for this transaction,
 *    or has committed before it. A reschedule is a plain UPDATE of the meeting row,
 *    which also waits on that row lock.
 *  - `assign_roles` locks slots in id order, then assigns one to a member (the FK takes
 *    KEY SHARE on the member row). The member row is therefore last here: no lock is
 *    requested after it that a writer holding a KEY SHARE on it could be sitting on.
 *    Taking it BEFORE the slot locks deadlocks with `assign_roles` (and is what #1031
 *    backed out of the merge).
 *  - The member row lock is what stops a writer that does not take the merge lock (a
 *    reassignment, an attendance row) from landing a row between the check and the
 *    delete: its FK KEY SHARE waits for the lock. If one landed first on a meeting this
 *    transaction does not hold, the removal stops with CLUB_BUSY_MESSAGE rather than
 *    judge a meeting whose status can still change. */
export async function applyMemberRemove(input: RemoveInput) {
	await db.transaction(async (tx) => {
		const [inClub] = await tx
			.select({
				id: members.id,
				name: members.name,
				personId: members.personId,
			})
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			);
		if (!inClub) throw new Error("Member not found.");

		// The early refusal: NO lock of any kind yet. The same two refusals as the
		// locked path below, in the same order, so the answer is identical.
		if (await personHasAccount(inClub.personId, tx)) {
			throw new Error(SIGNED_IN_REMOVE_MESSAGE);
		}
		if (
			await appearsOnPastAgenda(tx, input.memberId, input.clubId, new Date())
		) {
			throw new Error(pastAgendaRemoveRefusal(inClub.name));
		}

		await lockMembershipForMerge(tx, input.memberId);

		// Meetings first, in ascending id. The status and time they return are stable
		// until this transaction ends.
		const seen = await memberFootprint(tx, input.memberId, input.clubId);
		const meetingById = new Map<
			string,
			Awaited<ReturnType<typeof lockMeetingForSlotEdit>>
		>();
		for (const meetingId of [...seen.meetingIds].sort()) {
			meetingById.set(meetingId, await lockMeetingForSlotEdit(tx, meetingId));
		}
		// Then the member's slots, in id order. After the meeting locks the holder of a
		// slot on a held meeting cannot change; a claim for ANOTHER member does not
		// touch these.
		const heldSlotIds = (
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.assignedMemberId, input.memberId))
				.orderBy(asc(roleSlots.id))
				.for("update")
		).map((s) => s.id);
		// Then the action items they own, in id order.
		const heldItemIds = (
			await tx
				.select({ id: clubActionItems.id })
				.from(clubActionItems)
				.where(eq(clubActionItems.ownerMemberId, input.memberId))
				.orderBy(asc(clubActionItems.id))
				.for("update")
		).map((i) => i.id);
		// Last, the member row itself.
		const [locked] = await tx
			.select({
				id: members.id,
				name: members.name,
				personId: members.personId,
			})
			.from(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.for("update");
		if (!locked) throw new Error("Member not found.");
		// A member whose Person can sign in (people.user_id) can't be removed. Read
		// inside the transaction, after the locks: an invite accepted before this
		// point is seen. (Accepting writes `people`, not `members`, so it does not
		// wait on these locks; the window that remains is the delete below.)
		if (await personHasAccount(locked.personId, tx)) {
			throw new Error(SIGNED_IN_REMOVE_MESSAGE);
		}

		// ONE clock for both the refusal and the release.
		const now = new Date();
		const current = await memberFootprint(tx, input.memberId, input.clubId);
		// Refuse first, on any meeting this transaction holds.
		for (const meetingId of current.meetingIds) {
			const meeting = meetingById.get(meetingId);
			if (meeting && isPastAgendaMeeting(meeting, now)) {
				throw new Error(pastAgendaRemoveRefusal(locked.name));
			}
		}
		// A row landed on a meeting, or a slot was taken, that this transaction does
		// not hold. Its status is not stable, so do not decide on it.
		const heldSlots = new Set(heldSlotIds);
		const heldItems = new Set(heldItemIds);
		if (
			[...current.meetingIds].some((id) => !meetingById.has(id)) ||
			current.slots.some((s) => !heldSlots.has(s.id)) ||
			current.itemIds.some((id) => !heldItems.has(id))
		) {
			throw new Error(CLUB_BUSY_MESSAGE);
		}

		// Upcoming: scheduled at or after `now`, on a meeting held above.
		const upcoming = current.slots.filter((s) => {
			const meeting = meetingById.get(s.meetingId);
			return (
				meeting !== undefined && meeting.scheduledAt.getTime() >= now.getTime()
			);
		});
		for (const s of upcoming) {
			// Unlink any speech (speech_id → NULL); the speech persists
			// Person-owned and unscheduled (ADR-0009 — never destroyed).
			// A completed meeting never reaches here: it is a past agenda, refused above,
			// under the meeting lock that keeps it from completing in between. The status
			// still rides in the UPDATE (`meetingAcceptsWrite`) as the writers' guard
			// requires. A cancelled future meeting is still released (#1057). The log
			// follows RETURNING, so it names only the slots actually released.
			// `released.length === 0` below is DEFENSIVE: the meeting and slot locks held
			// here mean this UPDATE cannot lose to a status change or a reassignment, and
			// no test can reach it (a mutation of that line survives). Deactivate's copy
			// of the guard is reachable and is tested.
			const released = await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					status: "open",
					claimedAt: null,
					speechId: null,
				})
				.where(
					and(
						eq(roleSlots.id, s.id),
						// Still held by THIS member at UPDATE time.
						eq(roleSlots.assignedMemberId, input.memberId),
						meetingAcceptsWrite(
							tx,
							"plan",
							roleSlots.meetingId,
							PLAN_ACCEPTING_CANCELLED,
						),
					),
				)
				.returning({ id: roleSlots.id });
			if (released.length === 0) continue;
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: s.id,
				detail: { fromMemberId: input.memberId },
			});
		}
		// RETURNING, scoped to id AND club, and checked: a delete that removes nothing
		// must not log a removal. The log row is the release record the CSV importer
		// trusts (#855), and a stale second removal writing it would make this club the
		// Person's releaser after another club had since removed them. Throwing rolls
		// back the slot releases above with it.
		const [deleted] = await tx
			.delete(members)
			.where(
				and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
			)
			.returning({ id: members.id, personId: members.personId });
		if (!deleted) throw new Error("Member not found.");
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_remove",
			targetType: "member",
			targetId: input.memberId,
			// `personId` is the release record the CSV importer reads (#855): a
			// Person no club holds is re-attachable by file only for the club whose
			// removal is the LATEST naming them (`loadPersonCandidates`). Only an
			// unlinked Person gets here (`personHasAccount` above), which is exactly
			// the kind that rule is about. App-written, never client text.
			detail: { name: locked.name, personId: deleted.personId },
		});
	});
	return { ok: true as const };
}

export const bulkImportSchema = z.object({
	clubId: z.string().uuid(),
	// Rows are parsed client-side (see #/lib/roster-import). The server
	// re-validates and dedupes against the live roster — never trust the client.
	rows: z
		.array(
			z.object({
				name: z.string(),
				email: z.string(),
				phone: z.string(),
				office: z.string(),
			}),
		)
		.min(1),
	// New-member orientation (#940, maintainer decision): only the one-row
	// Quick add passes `true`. A pasted roster brings in existing members, so it
	// sends nothing and every row lands with `orientation_started_at` null.
	// OMITTED means null on purpose: a tab loaded before this deploy sends no
	// flag, and failing that way never shows a veteran the checklist, while an
	// admin can still start it from the member page.
	startOrientation: z.boolean().optional(),
});
type BulkImportInput = z.infer<typeof bulkImportSchema> & RosterActor;

export interface RosterMemberInsert {
	clubId: string;
	name: string;
	email: string | null;
	/** Already stored-form (`toStoredPhone`). */
	phone: string | null;
	status: "active" | "former";
	/** Club-local `YYYY-MM-DD`; null = unknown (a `former` member from an import). */
	endedAt: string | null;
	joinedAt: Date | null;
	clubRole: "member" | "admin";
	/** Start the new-member checklist (#940): only the one-row Quick add does. */
	orientation: boolean;
}

/**
 * Insert one new Person and their membership. The one place a roster row is
 * made from a pasted or imported line: `applyBulkImport` and the Easy-Speak
 * import (#1240) both call it, inside a transaction of their own. It logs
 * nothing: the caller owns the `member_add` and who it is attributed to.
 */
export async function insertRosterMember(
	tx: Tx,
	input: RosterMemberInsert,
): Promise<{ id: string; personId: string }> {
	const [person] = await tx
		.insert(people)
		.values({ name: input.name, email: input.email, phone: input.phone })
		.returning({ id: people.id });
	if (!person) throw new Error("Failed to insert person.");
	const [m] = await tx
		.insert(members)
		.values({
			clubId: input.clubId,
			personId: person.id,
			name: input.name,
			clubRole: input.clubRole,
			status: input.status,
			endedAt: input.endedAt,
			...(input.joinedAt ? { joinedAt: input.joinedAt } : {}),
			...(input.orientation ? {} : { orientationStartedAt: null }),
		})
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member.");
	return { id: m.id, personId: person.id };
}

export interface BulkImportResult {
	skippedOfficerAssignments: number;
	insertedIds: string[];
	inserted: number;
	skipped: number;
}

/**
 * Insert the valid pasted rows into `members`, skipping blank names, malformed
 * emails, and duplicates (against the live roster + within the batch — same
 * rules as the client preview). Logs one `member_add` per inserted member. #630
 * deleted the public self-add, which leaves TWO producers of that action rather
 * than one: this, and `applyConvertGuestToMember` in `guest-pipeline-logic.ts`
 * — the same seam the `member-write-authz` census names. Phone is standardized
 * to E.164 on write with the club default country code (#295).
 */
export async function applyBulkImport(
	input: BulkImportInput,
): Promise<BulkImportResult> {
	const existing = await db
		.select({ name: members.name, email: people.email })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubId, input.clubId));

	const preview = buildImportPreview(input.rows, existing);
	const toInsert = preview.filter((r) => r.willImport);
	const skippedOfficerAssignments = input.rows.filter((r) =>
		parseOfficerPosition(r.office),
	).length;
	if (toInsert.length === 0) {
		return {
			insertedIds: [],
			inserted: 0,
			skipped: preview.length,
			skippedOfficerAssignments,
		};
	}

	// Club default country code for E.164 normalization on write (#295), loaded
	// once for the whole batch.
	const cc = await loadClubDefaultCountryCode(input.clubId);

	const insertedIds = await db.transaction(async (tx) => {
		const ids: string[] = [];
		for (const row of toInsert) {
			const name = row.name.trim();
			const email = row.email.trim() || null;
			const phone = toStoredPhone(row.phone, cc);
			// Each pasted row is a new person (ADR-0008); cross-club dedupe is the
			// CSV importer's job, and buildImportPreview already drops in-club dupes.
			const m = await insertRosterMember(tx, {
				clubId: input.clubId,
				name,
				email,
				phone,
				status: "active",
				endedAt: null,
				joinedAt: null,
				clubRole: "member",
				// Leave the column to its DEFAULT now() only when asked; see
				// `startOrientation` on the schema above.
				orientation: input.startOrientation === true,
			});
			ids.push(m.id);
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "member_add",
				targetType: "member",
				targetId: m.id,
				detail: { name },
			});
		}
		return ids;
	});

	return {
		skippedOfficerAssignments,
		insertedIds,
		inserted: insertedIds.length,
		skipped: preview.length - insertedIds.length,
	};
}

export const listFormerMembersSchema = z.object({ clubId: z.string().uuid() });

export interface FormerMemberRow {
	id: string;
	name: string;
	/** Club-local `YYYY-MM-DD`, or null when the end date is unknown. */
	endedAt: string | null;
}

/** The club's former members (#1239), newest end first, unknown dates last,
 *  then by name. The caller's admin gate is `requireClubRole` in `members.ts`. */
export async function loadFormerMembers(
	clubId: string,
): Promise<FormerMemberRow[]> {
	return db
		.select({ id: members.id, name: members.name, endedAt: members.endedAt })
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "former")))
		.orderBy(sql`${members.endedAt} DESC NULLS LAST`, asc(members.name));
}
