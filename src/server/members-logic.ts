// VPE roster-management DB logic, split out from the createServerFn wrappers in
// `members.ts`. These are plain `applyX` functions (directly unit-testable —
// the wrappers need the Start runtime). They MUST live here, away from the
// server-fn module, because `members.ts` is imported by the client app shell:
// the Start compiler strips the createServerFn handler bodies (and their `db`
// imports) from the client bundle, but a plain db-touching export sitting in
// that same module is NOT stripped and drags `pg` → `Buffer` into the browser
// (ReferenceError: Buffer is not defined). Keeping the db logic in this
// never-client-imported module keeps `pg` server-side. See `auth-context.ts`.
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, members, people, roleSlots } from "#/db/schema";
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
import { isReadableClub } from "./club-readable-logic";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { contactMethodAvailableSql } from "./contact-preference-logic";
import { collapseMemberships } from "./membership-collapse-logic";
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
		.where(and(eq(members.clubId, clubId), ne(members.status, "inactive")))
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
async function personHasAccount(personId: string): Promise<boolean> {
	const [row] = await db
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
		// The contact preference (#1093). AFTER the phone and email writes, so
		// its WHERE judges availability against the row as this edit leaves it:
		// clearing the phone and choosing SMS in one save matches nothing. Three
		// rules sit in the UPDATE's own WHERE, not in a prior read: the Person
		// has not signed in (once they have, the choice is theirs); this club is
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
				.set({ preferredContact })
				.where(
					and(
						eq(people.id, current.personId),
						isNull(people.userId),
						soleHoldingClub(input.clubId),
						contactMethodAvailableSql(preferredContact),
					),
				)
				.returning({ id: people.id });
			if (written.length === 0) {
				// Ownership before availability, so a multi-club Person whose
				// email write was just refused hears "another club", not "add an
				// email" (#1093 review) — subject to the race described above.
				const owner = await emailWriteRefusalFor(
					current.personId,
					input.clubId,
					tx,
				);
				throw new Error(
					owner === "bound"
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
	status: z.enum(["active", "inactive"]),
});
type SetStatusInput = z.infer<typeof setStatusSchema> & RosterActor;

/** Toggle a roster member active/inactive. Inactive members are hidden from
 *  sign-up / roster / season / picker views and can't claim or be assigned new
 *  roles, but their past role history is preserved (never deleted) and
 *  reactivating restores them everywhere. Logs member_edit with the status
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
 *    back". It writes `{ status }` and nothing else, so `club_role` and any
 *    open officer term survive untouched and the member returns with exactly
 *    the standing they lapsed with. That is the intent: the admin picked this
 *    human on purpose.
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
	const [current] = await db
		.select()
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!current) throw new Error("Member not found.");
	const deactivating =
		current.status === "active" && input.status === "inactive";
	await db.transaction(async (tx) => {
		// Guardrail (#187): deactivating an admin must not strand the club with
		// zero active admins — that would silently bypass the demote guard.
		if (deactivating && current.clubRole === "admin") {
			await assertKeepsAnActiveAdmin(
				tx,
				input.clubId,
				input.memberId,
				"You can't deactivate the club's last admin — promote another member to admin first.",
			);
		}
		await tx
			.update(members)
			.set({ status: input.status })
			.where(eq(members.id, input.memberId));
		// Free up their upcoming roles so the VPE can re-fill them; past slots
		// stay assigned (history preserved). No status filter, a cancelled
		// future meeting included (#1057): its slots survive the cancel by design,
		// and a restore must not hand the role back to an inactive member. This
		// is its own UPDATE rather than `releaseSlotCore`, so the cancelled
		// meeting's write guard does not apply to it — on purpose.
		if (deactivating) {
			const upcoming = await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(
					and(
						eq(roleSlots.assignedMemberId, input.memberId),
						gte(meetings.scheduledAt, new Date()),
					),
				);
			for (const s of upcoming) {
				// Unlink any speech (speech_id → NULL); the speech persists
				// Person-owned and unscheduled (ADR-0009 — never destroyed).
				await tx
					.update(roleSlots)
					.set({
						assignedMemberId: null,
						status: "open",
						claimedAt: null,
						speechId: null,
					})
					.where(eq(roleSlots.id, s.id));
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
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: input.memberId,
			detail: {
				before: { status: current.status },
				after: { status: input.status },
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
	const [current] = await db
		.select()
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!current) throw new Error("Member not found.");
	// Idempotent: nothing changed → nothing to write or log.
	if (current.clubRole === input.clubRole) {
		return { ok: true as const, clubRole: current.clubRole };
	}
	const demoting = current.clubRole === "admin" && input.clubRole === "member";
	await db.transaction(async (tx) => {
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
	});
	return { ok: true as const, clubRole: input.clubRole };
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
		await collapseMemberships(tx, clubId, keeperId, absorbedId);
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

/** Remove a member: release their upcoming slots (logged) then delete them
 *  (availability cascades). A user-linked member can't be removed. "Upcoming"
 *  includes a CANCELLED future meeting (#1057): a slot left there would be
 *  `claimed` by nobody once the FK nulls the holder — unclaimable, per
 *  `membership-merge-lock.ts` — and a restore would put it on the live agenda. */
export async function applyMemberRemove(input: RemoveInput) {
	const [member] = await db
		.select()
		.from(members)
		.where(
			and(eq(members.id, input.memberId), eq(members.clubId, input.clubId)),
		);
	if (!member) throw new Error("Member not found.");
	// A member whose Person can sign in (people.user_id) can't be removed.
	if (await personHasAccount(member.personId)) {
		throw new Error("That member is a signed-in account and can't be removed.");
	}

	await db.transaction(async (tx) => {
		// No status filter: a cancelled future meeting's slots are released too
		// (#1057, see the docblock).
		const upcoming = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, input.memberId),
					gte(meetings.scheduledAt, new Date()),
				),
			);
		for (const s of upcoming) {
			// Unlink any speech (speech_id → NULL); the speech persists
			// Person-owned and unscheduled (ADR-0009 — never destroyed).
			await tx
				.update(roleSlots)
				.set({
					assignedMemberId: null,
					status: "open",
					claimedAt: null,
					speechId: null,
				})
				.where(eq(roleSlots.id, s.id));
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "release",
				targetType: "slot",
				targetId: s.id,
				detail: { fromMemberId: input.memberId },
			});
		}
		// RETURNING, scoped to id AND club, and checked. The read above is outside
		// this transaction, so a concurrent removal of the same row can land in
		// between; a delete that removes nothing must not log a removal. The log
		// row is the release record the CSV importer trusts (#855), and a stale
		// second removal writing it would make this club the Person's releaser
		// after another club had since removed them. Throwing rolls back the
		// slot releases above with it.
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
			detail: { name: member.name, personId: deleted.personId },
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
			const [person] = await tx
				.insert(people)
				.values({ name, email, phone })
				.returning({ id: people.id });
			if (!person) throw new Error("Failed to insert person.");
			const [m] = await tx
				.insert(members)
				.values({
					clubId: input.clubId,
					personId: person.id,
					name,
					clubRole: "member",
					// Leave the column to its DEFAULT now() only when asked; see
					// `startOrientation` on the schema above.
					...(input.startOrientation === true
						? {}
						: { orientationStartedAt: null }),
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to insert member.");
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
