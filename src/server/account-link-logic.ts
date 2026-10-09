// Account-linking DB logic (#188, re-keyed by #756 and again by #907), split out from the
// Better-Auth config in `src/lib/auth.ts` so it is directly integration-testable.
// Kept in a `*-logic.ts` module (never client-imported) so its `#/db` → `pg`
// import stays server-side; see `members-logic.ts` for the pattern and the
// `server-modules.guard.test.ts` rationale.
//
// This module owns the whole identity-binding rule: the bind
// (`bindVerifiedPerson`, which carries the rule in its own WHERE), the read that
// EXPLAINS a refusal to a human (`rosterConflictFor`, which is that rule's exact
// complement), and the predicate every club-side writer of `people.email` must
// carry (`soleHoldingClub`, ADR-0029). Every other module imports these rather than
// restating them — the enumeration, not the predicate, is the thing that kept
// being wrong when four writers each carried their own copy of a guard (#755).
import {
	and,
	countDistinct,
	eq,
	exists,
	isNotNull,
	isNull,
	ne,
	not,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import { db } from "#/db";
import {
	activityLog,
	clubCharterHelpers,
	guests,
	members,
	pathEnrollments,
	people,
	speeches,
	user,
} from "#/db/schema";
import type { GuestContactRefusal } from "#/lib/guest-contact";

/**
 * One spelling of "normalise an address", for the SQL side. **Exported: use it
 * at every reader.** Four copies of this expression drifted apart inside a
 * single change — one of them the `lower(trim(...))` form documented below as a
 * bug — and one index can never serve two spellings.
 *
 * Postgres `trim()` strips SPACES only while JS `.trim()` strips every Unicode
 * space, so spelling one reader `lower(trim(...))` and the other
 * `.trim().toLowerCase()` made a roster address with a trailing TAB match on the
 * claim path and not at sign-in.
 *
 * The POSIX class is still NOT identical to JS: `[[:space:]]` leaves U+00A0
 * (NBSP) and U+FEFF, which `.trim()` removes. Both are reachable by pasting from
 * Word or Outlook. That residual is recorded rather than claimed away — it fails
 * CLOSED on the binding path (the address is harder to vouch for, easier to be
 * dissented from), so it costs a refusal and never a bind.
 */
export function normalizedEmail(column: AnyPgColumn): SQL {
	return sql`lower(regexp_replace(${column}, '^[[:space:]]+|[[:space:]]+$', '', 'g'))`;
}

/** The JS side of the same operation. Keep the two in step. */
export function normalizeEmail(
	value: string | null | undefined,
): string | null {
	return value?.trim().toLowerCase() || null;
}

/** A second, aliased handle on `people`, for the "any OTHER Person" arm. */
const otherPeople = alias(people, "other_people");
/** Aliased `members` for the correlated subqueries below. An alias always
 *  renders qualified; a bare table inside a hand-written `sql` subquery can
 *  lose its qualifier and compare a column to itself (#802). */
const holding = alias(members, "holding_member");
const vouching = alias(members, "vouching_member");
const otherHolding = alias(members, "other_holding_member");
/** Aliased `guests`, `speeches` and `path_enrollments`, for the guest-Person
 *  predicates' correlated subqueries (#802). */
const heldGuest = alias(guests, "held_guest");
const ownedSpeech = alias(speeches, "owned_speech");
const enrolment = alias(pathEnrollments, "person_enrolment");
const charterHelper = alias(clubCharterHelpers, "person_charter_helper");
const otherGuestRow = alias(guests, "other_guest_row");
/** Aliased `guests` and `members` for the guest-contact predicates (#1125): this
 *  club's guest row on the Person, and any guest row of ANOTHER club. */
const clubGuestRow = alias(guests, "club_guest_row");
const otherClubGuestRow = alias(guests, "other_club_guest_row");
const hereMember = alias(members, "here_member");
const elsewhereMember = alias(members, "elsewhere_member");
const personRecord = alias(activityLog, "person_activity");
/** The binding account, re-read INSIDE the bind's own statement (#1091
 *  review). Aliased so it always renders qualified (#802). */
const bindingAccount = alias(user, "binding_account");

/**
 * Does this Person COUNT as a holder of an address, for ambiguity? Only when it
 * is somebody: bound to an account, or on at least one roster (#907 review).
 * A leftover `applyMemberRemove` stripped of every membership is on no roster
 * and nobody's account; it vouches for nothing, and counting it locked a
 * removed-then-re-added member out of their own sign-in.
 *
 * `table` is `people` or an alias of it; the membership subquery is over its
 * own alias, so it always renders qualified.
 */
function countsAsHolder(table: { id: AnyPgColumn; userId: AnyPgColumn }): SQL {
	return or(
		isNotNull(table.userId),
		exists(
			db
				.select({ one: sql`1` })
				.from(otherHolding)
				.where(eq(otherHolding.personId, table.id)),
		),
	) as SQL;
}

/**
 * **The identity rule, as one SQL predicate** (#907, replacing #756's roster
 * vouch). Each arm correlated on `people.id` rather than a JS literal so
 * Postgres evaluates them against the row being updated.
 *
 *  1. **It is their address** — `people.email` normalises to `address`.
 *  2. **A club vouches** — the Person holds at least one membership.
 *  3. **The address is theirs alone** — no OTHER Person carries it who is
 *     somebody: bound to an account, or on at least one roster. A leftover with
 *     neither (`applyMemberRemove` strips the roster row and keeps the Person)
 *     vouches for nothing and must not lock the real member out.
 *
 * (`user_id IS NULL` is the fourth arm; it lives beside this in the bind's own
 * WHERE, because the explainer below answers a different question for a Person
 * that is already linked.)
 *
 * **Why the old "exactly one club holds them" arm is gone.** It existed because
 * the vouch was a per-club `members.email` that any club holding the Person
 * could type, so two clubs could disagree. The address is now ONE column on the
 * Person, and a club-side writer may set it only while it is that Person's SOLE
 * holder and nobody has bound it (`soleHoldingClub` + `isNull(people.userId)`,
 * in every such write's own WHERE). A second club therefore cannot re-key a
 * Person it shares, so a multi-club member can sign in by email again. The
 * exceptions are the bind itself and the superadmin repairs.
 *
 * **Every membership counts for arm 2: no status filter, no archived filter.**
 * A lapsed member is still somebody a club vouched for.
 *
 * Arm 2 is load-bearing on its own: `applyMemberRemove` and undoing a guest
 * conversion both leave Persons with no membership behind, and an address on
 * such a row is nobody's vouch.
 *
 * Arm 3 is the household case. One address on two Persons is an ambiguity the
 * app cannot resolve — picking a name is a claim, not proof, and both spouses
 * read the same inbox (ADR-0008: never auto-merge on a shared email). It counts
 * an already-LINKED other Person too: a typed copy of somebody's sign-in address
 * must not bind a second Person to the same inbox.
 */
function rosterPermitsBind(address: string): SQL {
	return and(
		// 1. It is their address.
		sql`${normalizedEmail(people.email)} = ${address}`,
		// 2. A club vouches.
		exists(
			db
				.select({ one: sql`1` })
				.from(vouching)
				.where(eq(vouching.personId, people.id)),
		),
		// 3. Nobody else who counts carries the address.
		notExists(
			db
				.select({ one: sql`1` })
				.from(otherPeople)
				.where(
					and(
						ne(otherPeople.id, people.id),
						sql`${normalizedEmail(otherPeople.email)} = ${address}`,
						countsAsHolder(otherPeople),
					),
				),
		),
	) as SQL;
}

/**
 * **Who on a club's side may write an existing Person's `people.email`** (#907):
 * the club is the Person's SOLE holder. Two arms, both correlated on
 * `people.id`, for use INSIDE an `update(people)`'s WHERE:
 *
 *  - exactly one distinct club holds a membership of this Person, and
 *  - that club is `clubId`.
 *
 * It is deliberately NOT the whole rule. Every club-side write site must also
 * carry `isNull(people.userId)` in the same statement — once somebody has signed
 * in, the address is theirs — and `person-email-writers.guard.test.ts` holds
 * each waived writer to BOTH tokens, separately, so neither can be dropped
 * without a red test. Being in the statement is what makes a bind that lands
 * between a form's load and its save a no-op rather than an overwrite.
 *
 * Accepted residual (ADR-0029): a second club attaching a membership in the same
 * instant is not serialised against the writer's Person lock. That attach can
 * only have matched the Person by its current address or Customer ID.
 */
export function soleHoldingClub(clubId: string): SQL {
	return and(
		sql`(${db
			.select({ n: countDistinct(holding.clubId) })
			.from(holding)
			.where(eq(holding.personId, people.id))}) = 1`,
		exists(
			db
				.select({ one: sql`1` })
				.from(vouching)
				.where(
					and(eq(vouching.personId, people.id), eq(vouching.clubId, clubId)),
				),
		),
	) as SQL;
}

/**
 * An UNBOUND guest-only Person (#1124, ADR-0031): nobody has signed in as them
 * (`user_id IS NULL`), no club has them as a member, and at least one club has
 * them as a guest. The superadmin merge tool labels such a Person "Guest" so a
 * duplicate can be repaired. It is a READ predicate: what decides whether a
 * convert may adopt a guest's Person is the stricter `pristineGuestPerson`.
 */
export function unboundGuestOnlyPerson(): SQL {
	return and(
		isNull(people.userId),
		notExists(
			db
				.select({ one: sql`1` })
				.from(holding)
				.where(eq(holding.personId, people.id)),
		),
		exists(
			db
				.select({ one: sql`1` })
				.from(heldGuest)
				.where(eq(heldGuest.personId, people.id)),
		),
	) as SQL;
}

/**
 * **Who may write a guest's email and phone: the club that holds a guest row on
 * them, while the Person is guest-only and unbound** (#1125, ADR-0031).
 *
 * A guest's contact lives on their Person (`people.email` / `people.phone`), and
 * the Person owns it; clubs are custodians until the person speaks for themselves
 * (the maintainer, 2026-10-07: "users should have agency over their own data, not
 * clubs"). So an officer may correct it only for a Person that is
 * `unboundGuestOnlyPerson()` (nobody has signed in as them and no club has them as
 * a member), that never was a member (`noMemberHistory()`), AND that THIS club
 * holds a guest row on. Any club holding a guest row on a guest-only Person may
 * correct it, and the fix then shows in every club holding one, because it is one
 * person with one address. For anybody else the edit is refused: a signed-in
 * person changes it themselves (ADR-0030), a member's contact is the roster's
 * (ADR-0029), and a REMOVED member's Person keeps the contact it had: it holds no
 * membership, so it reads guest-only, but a roster re-import re-attaches it
 * (#875) and a contact an officer rewrote through a guest card would become that
 * member's sign-in key.
 *
 * **A guest row never counts as a holder and never locks a member.** This is a
 * guest-side predicate only; `soleHoldingClub` and every member-side writer are
 * untouched, so a guest row in another club cannot stop a roster edit.
 *
 * For use INSIDE an `update(people)`'s WHERE, never as a pre-check: a bind or a
 * membership that lands between a form's load and its save makes the UPDATE match
 * nothing instead of overwriting. `person-email-writers.guard.test.ts` holds each
 * writer to this token in the statement itself.
 */
export function guestContactWritable(clubId: string): SQL {
	return and(
		unboundGuestOnlyPerson(),
		noMemberHistory(),
		exists(
			db
				.select({ one: sql`1` })
				.from(clubGuestRow)
				.where(
					and(
						eq(clubGuestRow.personId, people.id),
						eq(clubGuestRow.clubId, clubId),
					),
				),
		),
	) as SQL;
}

/**
 * **Who may FILL a blank guest contact from the anonymous guest book** (#1125):
 * `guestContactWritable(clubId)` AND no guest row in any OTHER club AND no past
 * as a member (`noMemberHistory()`).
 *
 * Stricter than the officer's rule, because the public book has no session: the
 * club link is the only credential. A visitor typing an address into a club's
 * book may fill a blank on a Person only that club knows about. Once another club
 * also holds a guest row on them, an address typed into THIS club's book would
 * land on a person the other club also reaches, and nobody who can vouch for it
 * has seen it. Nothing is written then, and nothing is written for a Person who
 * holds any membership or is signed in (both are outside `guestContactWritable`).
 *
 * **A former member's Person is refused too**, which the issue's bare "writable
 * and no other club" would let through: a removed member's Person holds no
 * membership, so it reads guest-only, yet it is the Person a roster re-import
 * re-attaches (#875), and an address typed on the anonymous book that landed on
 * it would then be the sign-in key of a member with history. That is the takeover
 * ADR-0031's pristine rule exists to stop, and a guest card stranded after a
 * removal is exactly where a stranger's visit finds a blank to fill.
 *
 * In the UPDATE's own WHERE, like its sibling.
 */
export function guestContactFillable(clubId: string): SQL {
	return and(
		guestContactWritable(clubId),
		notExists(
			db
				.select({ one: sql`1` })
				.from(otherClubGuestRow)
				.where(
					and(
						eq(otherClubGuestRow.personId, people.id),
						ne(otherClubGuestRow.clubId, clubId),
					),
				),
		),
		noMemberHistory(),
	) as SQL;
}

/**
 * Nothing on this Person shows a past as a member (#1125): none of the
 * roster-identity columns that only a membership, an import, a member or an
 * officer sets (`customer_id`, `basecamp_user_id`, `original_join_date`,
 * `invited_at`), and no `member_remove` naming it. The same evidence
 * `pristineGuestPerson` reads, without the arms about ownership (a speech, an
 * enrolment, another guest row), which are not about WHO the Person was.
 *
 * Evidence, not proof (ADR-0031): a membership removed without a record that
 * left no column behind reads clean. Shared by `guestContactFillable` and
 * `identityIgnoredGuestPerson`, so the two cannot disagree about it.
 */
function noMemberHistory(): SQL {
	return and(
		isNull(people.customerId),
		isNull(people.basecampUserId),
		isNull(people.originalJoinDate),
		isNull(people.invitedAt),
		notExists(releasedPersonSubquery()),
	) as SQL;
}

/**
 * Why `guestContactWritable(clubId)` would refuse this Person, as ONE SQL
 * expression: the first of `signed_in`, `member_here`, `member_elsewhere`,
 * `former_member` that applies, else null (#1125).
 *
 * It is the READ form of the writable predicate, never the gate: the writer's
 * own WHERE decides. It exists so the sentence an officer is shown and the
 * refusal a write throws come from one definition, and the pipeline board loads
 * it in the same query as the rows, with no second read per card.
 * `guest-contact-on-person.integration.test.ts` pins that it is null exactly
 * where the predicate matches, for a Person this club holds a guest row on.
 */
export function guestContactRefusalSql(
	clubId: string,
): SQL<GuestContactRefusal | null> {
	return sql<GuestContactRefusal | null>`case
		when ${people.userId} is not null then 'signed_in'
		when ${exists(
			db
				.select({ one: sql`1` })
				.from(hereMember)
				.where(
					and(
						eq(hereMember.personId, people.id),
						eq(hereMember.clubId, clubId),
					),
				),
		)} then 'member_here'
		when ${exists(
			db
				.select({ one: sql`1` })
				.from(elsewhereMember)
				.where(
					and(
						eq(elsewhereMember.personId, people.id),
						ne(elsewhereMember.clubId, clubId),
					),
				),
		)} then 'member_elsewhere'
		when ${not(noMemberHistory())} then 'former_member'
		else null end`;
}

/**
 * The refusal for one Person, read. `null` means the Person is not refused on any
 * of the three grounds (a guest-only, unbound Person); a writer that matched no
 * row for some OTHER reason (the guest moved to another Person, or the Person is
 * gone) gets `null` here and says the record changed.
 */
export async function guestContactRefusalFor(
	personId: string,
	clubId: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<GuestContactRefusal | null> {
	const [row] = await executor
		.select({ refusal: guestContactRefusalSql(clubId) })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	return row?.refusal ?? null;
}

/**
 * A guest-only Person that identity matching must not see (#1125): one only a
 * guest row names, whose contact came from a guest writer.
 *
 * The member-identity paths match `people` by address or phone GLOBALLY: the CSV
 * importer's candidates and its address-holder map, and onboarding's
 * `findBestPersonByEmail`. Since a guest's contact moved onto its Person, an
 * address typed on a club's anonymous guest book is on a `people` row, and
 * without this a roster import, or a new club's first admin, would find that
 * visitor's Person by it and put a membership on it, which is the re-keying
 * ADR-0031's pristine rule exists to prevent. `rosterPermitsBind`,
 * `rosterConflictFor` and `addressHeldByAnother` already ignore such a Person
 * (`countsAsHolder`: it is neither bound nor on a roster).
 *
 * It is `unboundGuestOnlyPerson()` MINUS everything that shows a past, which a
 * match must keep finding:
 *  - a roster-identity column (`customer_id`, `basecamp_user_id`,
 *    `original_join_date`, `invited_at`): the Person was a member's. The importer
 *    matches by Customer ID and that column is UNIQUE, so hiding such a Person
 *    would turn the next import into a unique violation rather than a fill;
 *  - a `member_remove` naming it: it is the release target of an undone convert
 *    (#875), and the undoing club's own roster CSV must still find it.
 *
 * A Person a guest writer made carries none of those, and that is the Person this
 * hides.
 */
export function identityIgnoredGuestPerson(): SQL {
	return and(unboundGuestOnlyPerson(), noMemberHistory()) as SQL;
}

/**
 * **The one definition of a PRISTINE guest Person** (#1124, ADR-0031, the
 * maintainer's ruling of 2026-10-09): the only Person a convert may ADOPT for a
 * guest. Everything else the guest row names gets a fresh Person instead, and the
 * old one is left as it is (or, if nothing at all references it, deleted): it is
 * somebody's history or a release target (#875). "Pristine" means NOTHING a
 * guest's Person is not meant to carry shows on the row or in the tables around
 * it. A Person is pristine for guest `guestId` only if ALL of these hold:
 *
 *  - nobody has signed in as them (`user_id IS NULL`);
 *  - no membership in any club, in any status;
 *  - no speech, no Pathways enrolment, no charter-helper row (nothing a Person
 *    owns that is somebody's record);
 *  - no guest row but this one, in any club (a Person two clubs share is not one
 *    club's to rename and re-key);
 *  - none of the roster-identity columns that only a membership, an import, a
 *    member or an officer sets: `customer_id`, `basecamp_user_id`,
 *    `original_join_date` and `invited_at`. A Person a merge folded a member into
 *    carries those columns (`mergePeople` copies the absorbed Person's contact and
 *    anchors onto the keeper), and so does one a roster collapse left behind, so
 *    the columns, not only the records, are the evidence. The two
 *    contact-preference columns (`preferred_contact`, `contact_preference_by`) are
 *    DELIBERATELY NOT checked: `preferred-contact-reads.guard.test.ts` lets only
 *    the files it names spell that column, this file is not one, and a null test
 *    is not one of its shapes. The accepted gap: a Person whose ONLY remnant of a
 *    membership is one of those two columns reads pristine and can be adopted by
 *    a guest, and a stale contact-channel preference can then come back with it.
 *    **Email and phone are NOT tested any more (#1125).** Until then a contact on
 *    a guest's Person meant it had been, or had been merged with, a member's, and
 *    this arm said so. Since #1125 a guest's own contact IS on its Person (written
 *    by `createGuestRecord`, an officer's edit, or a returning visitor's blank
 *    filled), so testing it would make every guest with an address read as a
 *    former member and no convert would ever adopt. The evidence it carried is
 *    still tested by the arms around it: a member's Person holds a membership, or
 *    has a removal on record, or carries a roster-identity column. What it cannot
 *    see is a membership removed without a record that left no column behind and
 *    only a contact: the same accepted gap as a removal from before #875 (below),
 *    widened by exactly that case. A Person a convert adopts keeps the contact it
 *    has: the convert writes no email or phone onto it that was not already its
 *    guest's;
 *  - no removal on record: a `member_remove` naming it (`detail.personId`, the
 *    shape `applyMemberRemove`, an undo and the importer's release lookup all use).
 *
 * That last arm is spelled like the importer's (a LITERAL `action =
 * 'member_remove'` and the same `->>` expression), because
 * `activity_log_member_remove_person_idx` is partial and on that expression and
 * serves only a query that spells both the same way. A bound `action IN ($1, $2)`
 * does not, and every convert then scanned the whole log across clubs while
 * holding the club and Person locks. There is no `member_add` arm for the same
 * reason and because it proves little: the roster add and the import write no
 * Person on theirs, convert's names one but a roster collapse deletes the
 * absorbed membership's own records, and every deletion that is logged writes a
 * `member_remove`.
 *
 * What this cannot see is a membership that was deleted without a record and
 * left no column behind (a removal from before #875 of a Person with nothing but a
 * name). That Person reads as pristine, and it is the guest's to adopt: nothing
 * about it distinguishes it from one.
 *
 * One function, so the decision and the write cannot disagree: convert puts it
 * in the adopt UPDATE's own WHERE, and the UPDATE matching a row IS the
 * decision. A membership another transaction inserts for the Person between a
 * read and the write makes the UPDATE match nothing, and the convert mints a
 * fresh Person instead.
 */
export function pristineGuestPerson(guestId: string): SQL {
	return and(
		isNull(people.userId),
		isNull(people.customerId),
		isNull(people.basecampUserId),
		isNull(people.originalJoinDate),
		isNull(people.invitedAt),
		notExists(
			db
				.select({ one: sql`1` })
				.from(holding)
				.where(eq(holding.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(ownedSpeech)
				.where(eq(ownedSpeech.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(enrolment)
				.where(eq(enrolment.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(charterHelper)
				.where(eq(charterHelper.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(otherGuestRow)
				.where(
					and(
						eq(otherGuestRow.personId, people.id),
						ne(otherGuestRow.id, guestId),
					),
				),
		),
		notExists(releasedPersonSubquery()),
	) as SQL;
}

/**
 * A `member_remove` naming `people.id`, spelled exactly as the importer's release
 * lookup spells it so the partial index `activity_log_member_remove_person_idx`
 * serves it (a literal action, the same `->>` expression). Shared by
 * `pristineGuestPerson` and the keep-a-release-target rule of a convert's delete.
 * Exported, and takes the Person as text, so a test can EXPLAIN it against a
 * constant and see an index condition on the expression.
 */
export function releasedPersonSubquery(
	personIdText: SQL = sql`${people.id}::text`,
) {
	return db
		.select({ one: sql`1` })
		.from(personRecord)
		.where(
			and(
				sql`${personRecord.action} = 'member_remove'`,
				sql`${personRecord.detail} ->> 'personId' = ${personIdText}`,
			),
		);
}

/**
 * The Person is the release target of a removal (#875): a `member_remove` names
 * it. A convert that moves a guest off a Person it did not adopt deletes that
 * Person when nothing references it, but never one a removal names: that is the
 * record the undoing club's own roster CSV matches by, and its contact is
 * somebody's correction.
 */
export function releasedByRemoval(): SQL {
	return exists(releasedPersonSubquery()) as SQL;
}

/**
 * An unbound Person nothing references any more (#1124): no sign-in account, no
 * membership, no guest row, and nothing the Person owns that a delete would
 * cascade away (a speech or a Pathways enrolment). The one condition under
 * which deleting a guest's Person loses nothing; a guest delete and a link carry
 * it in the DELETE's own WHERE.
 */
export function unreferencedUnboundPerson(): SQL {
	return and(
		isNull(people.userId),
		notExists(
			db
				.select({ one: sql`1` })
				.from(holding)
				.where(eq(holding.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(heldGuest)
				.where(eq(heldGuest.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(ownedSpeech)
				.where(eq(ownedSpeech.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(enrolment)
				.where(eq(enrolment.personId, people.id)),
		),
		notExists(
			db
				.select({ one: sql`1` })
				.from(charterHelper)
				.where(eq(charterHelper.personId, people.id)),
		),
	) as SQL;
}

/** Why a club-side writer may not change a Person's address. */
export type EmailWriteRefusal =
	/** Somebody has signed in as this Person; the address is theirs. */
	| "bound"
	/** Another club holds this Person too (or this club does not hold them). */
	| "multi_club";

/**
 * The READ form of `isNull(people.userId) AND soleHoldingClub(clubId)`, for
 * explaining a refusal and for rendering the field read-only. Never the gate:
 * that lives in each writer's own WHERE.
 *
 * @returns null when `clubId` may write the address, else why not.
 */
export async function emailWriteRefusalFor(
	personId: string,
	clubId: string,
	executor: Pick<typeof db, "select" | "selectDistinct"> = db,
): Promise<EmailWriteRefusal | null> {
	const [row] = await executor
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	if (!row) return "multi_club";
	if (row.userId) return "bound";
	const clubs = await executor
		.selectDistinct({ clubId: members.clubId })
		.from(members)
		.where(eq(members.personId, personId));
	return clubs.length === 1 && clubs[0]?.clubId === clubId
		? null
		: "multi_club";
}

/**
 * Bind a Person to a signed-in account and stamp the VERIFIED address onto it.
 * The one writer of `people.email` that writes a VERIFIED address; every other
 * writer is a named waiver in `person-email-writers.guard.test.ts` (the club-side
 * ones held to `isNull(people.userId)` AND `soleHoldingClub`, ADR-0029).
 *
 * Two properties make the name honest rather than aspirational, and both were
 * review findings against earlier cuts:
 *   - **It reads the address itself** from the `user` row rather than taking it
 *     from the caller, so no call site can label a typed string "verified".
 *   - **It carries the whole rule in its own WHERE** — `user_id IS NULL` plus
 *     `rosterPermitsBind` — rather than trusting a SELECT the caller ran first.
 *     What remains is the READ COMMITTED phantom: a row committed after this
 *     statement's snapshot is invisible to it.
 *
 * @returns whether the bind landed. `false` covers every refusal, so a caller
 * that needs to tell a human WHY asks `rosterConflictFor` — this predicate's
 * exact complement, which must stay that way.
 */
export async function bindVerifiedPerson(input: {
	personId: string;
	userId: string;
}): Promise<boolean> {
	const verified = await verifiedEmailFor(input.userId);
	if (!verified) return false;
	// The STORED address, unnormalised, for the in-statement check below that
	// the account's address is unchanged since it was read (#1091 review). It
	// is compared raw to raw: comparing `verified` (JS `.trim()`) with SQL's
	// `normalizedEmail` would refuse an address stored with a leading BOM or
	// NBSP, which the two trims treat differently, and that bind succeeded
	// before. Read second, so it must agree with `verified`; if a change landed
	// between the two reads they disagree and the bind refuses (fails closed).
	const stored = await storedEmailFor(input.userId);
	if (stored === null || normalizeEmail(stored) !== verified) return false;

	const bound = await db
		.update(people)
		.set({ userId: input.userId, email: verified })
		.where(
			and(
				eq(people.id, input.personId),
				isNull(people.userId),
				rosterPermitsBind(verified),
				// The account's stored address is UNCHANGED since it was read
				// (#1091 review). It was read above, outside this statement; a
				// change of sign-in address confirmed in between would otherwise
				// let the bind stamp the OLD address — one the account no longer
				// holds — onto this Person and bind it, past the household arm the
				// change itself moved. Not a new rule: atomicity only.
				//
				// Known limit (READ COMMITTED): this closes the window before the
				// statement starts. If the UPDATE is already waiting on this
				// Person's row lock when the change commits, Postgres re-checks only
				// the locked row (EvalPlanQual) and this subquery keeps reading the
				// statement's original snapshot.
				exists(
					db
						.select({ one: sql`1` })
						.from(bindingAccount)
						.where(
							and(
								eq(bindingAccount.id, input.userId),
								eq(bindingAccount.email, stored),
							),
						),
				),
			),
		)
		.returning({ id: people.id });
	return bound.length > 0;
}

/** The address a magic link proved this account owns, normalised. */
export async function verifiedEmailFor(userId: string): Promise<string | null> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return normalizeEmail(account?.email);
}

/** The account's address exactly as stored, unnormalised, or null. */
async function storedEmailFor(userId: string): Promise<string | null> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return account?.email ?? null;
}

/** Why a bind for an address would be refused by the ROSTER. */
export type RosterObstacle =
	/** The Person's own address is not this one, or no club holds them. */
	| "no_vouching_row"
	/** Another Person carries the same address. */
	| "shared_address";

/**
 * **The exact complement of `rosterPermitsBind`**, as a read, for messaging.
 * Never for authorization — that lives in the UPDATE's own WHERE.
 *
 * "Exact complement" is the contract, and it has teeth. An earlier cut checked
 * only two of the three arms, and every surface using it as a pre-flight was
 * then blind to the third: the invite reported `ready` for a member no row
 * vouched for, minted a real account through Better-Auth, and the claim then
 * refused — the silent half-failure this release exists to delete, reappearing
 * inside the code written to delete it. `roster-obstacle.guard.test.ts` pins the
 * two against each other.
 *
 * Like the predicate, it says nothing about `user_id`: a caller that needs to
 * know whether the Person is already linked reads that itself.
 *
 * @returns the first obstacle found, or null when the bind would be permitted.
 */
export async function rosterConflictFor(
	personId: string,
	address: string,
): Promise<RosterObstacle | null> {
	const norm = normalizeEmail(address);
	if (!norm) return "no_vouching_row";

	const [person] = await db
		.select({ email: people.email })
		.from(people)
		.where(eq(people.id, personId))
		.limit(1);
	// `normalizeEmail` is the JS spelling of `normalizedEmail`; the residual
	// between them (NBSP, U+FEFF) fails closed here as it does in the bind.
	if (normalizeEmail(person?.email) !== norm) return "no_vouching_row";
	const [membership] = await db
		.select({ id: members.id })
		.from(members)
		.where(eq(members.personId, personId))
		.limit(1);
	if (!membership) return "no_vouching_row";

	const others = await db
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				ne(people.id, personId),
				sql`${normalizedEmail(people.email)} = ${norm}`,
				countsAsHolder(people),
			),
		)
		.limit(1);
	return others.length > 0 ? "shared_address" : null;
}

/**
 * Every space a stored address may carry at either end, for the COLLISION
 * question only (#1091 review): the POSIX class `normalizedEmail` trims, plus
 * the Unicode spaces JS `.trim()` also strips (NBSP, U+1680, U+2000–U+200A,
 * U+2028/9, U+202F, U+205F, U+3000, U+FEFF) and the zero-width space U+200B.
 *
 * `normalizedEmail` leaves those, which fails CLOSED for the bind (it is
 * documented there) but OPEN here: a holder stored as `victim@x.com` plus a
 * NBSP would not block a change TO `victim@x.com`. The bind rule is untouched;
 * only "is this address somebody else's" reads through this.
 */
const HELD_ADDRESS_EDGE_SPACE =
	"^[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+|[[:space:]\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]+$";

/** A stored address, normalised for the collision question. */
function heldAddress(column: AnyPgColumn): SQL {
	return sql`lower(regexp_replace(${column}, ${HELD_ADDRESS_EDGE_SPACE}, '', 'g'))`;
}

/**
 * **Is this address already somebody else's?** (#1091, ADR-0030) The question a
 * member changing their own sign-in address must get "no" to, asked at request
 * time and again inside the confirm transaction.
 *
 * Two arms, either one refuses:
 *  - another `user` row carries it (a second account already signs in with it);
 *  - another Person carries it who COUNTS AS A HOLDER (`countsAsHolder`, the
 *    bind's own rule): bound to an account, or on at least one roster. That is
 *    ADR-0008's household case — moving an address onto this Person would make
 *    it ambiguous, and the bind refuses an ambiguous address for BOTH Persons.
 *
 * "Another" means not `userId`'s own account and not a Person bound to it. It
 * is the same predicate the bind uses, not a restatement, so a change can
 * never create an ambiguity the bind would then refuse.
 *
 * `address` must already be normalised (`normalizeEmail`). `executor` is a
 * transaction handle at confirm time, so the read sees that transaction.
 */
export async function addressHeldByAnother(
	address: string,
	userId: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<boolean> {
	// BOTH arms run every time (#1091 review): the request path answers the
	// same whichever arm hits, so it must also take the same time.
	const [otherUser, otherPerson] = await Promise.all([
		executor
			.select({ id: user.id })
			.from(user)
			.where(
				and(ne(user.id, userId), sql`${heldAddress(user.email)} = ${address}`),
			)
			.limit(1),
		executor
			.select({ id: people.id })
			.from(people)
			.where(
				and(
					or(isNull(people.userId), ne(people.userId, userId)),
					sql`${heldAddress(people.email)} = ${address}`,
					countsAsHolder(people),
				),
			)
			.limit(1),
	]);
	return otherUser.length > 0 || otherPerson.length > 0;
}

/** The DISTINCT Persons whose own address is this one and who count as a
 *  holder (`countsAsHolder`), linked or not. */
async function peopleMatching(address: string): Promise<string[]> {
	const rows = await db
		.select({ id: people.id })
		.from(people)
		.where(
			and(
				sql`${normalizedEmail(people.email)} = ${address}`,
				countsAsHolder(people),
			),
		);
	return rows.map((r) => r.id);
}

/**
 * Auto-link on sign-in: bind the roster `Person` this verified address belongs
 * to (ADR-0008 Phase B — the auth link lives on `people.user_id`).
 *
 * Called from the Better-Auth `session.create.after` hook, so it fires on EVERY
 * successful sign-in (magic-link is the only method), IDEMPOTENTLY: a Person
 * provisioned before or after the account links on the next sign-in either way,
 * and an already-linked Person is never touched.
 *
 * **The match key is `people.email`, the Person's one address (#907).** Before
 * a bind it was typed by a club, but only by a club that was the Person's sole
 * holder at the time (`soleHoldingClub`), so a club that shares a Person can
 * never re-key them. A typo is repairable from the roster edit form until the
 * member signs in — which is what used to lock members out with no UI able to
 * help (THR Speaking Club, 2026-09-12).
 *
 * The candidate count requires **exactly one Person**, counting already-LINKED
 * ones. That is not an oversight: filtering them out let the second spouse
 * become the sole candidate once the first had claimed their own row, binding
 * his membership and his roles to her account on her next sign-in. Two rows
 * carrying one address is an ambiguity whoever holds them; `mergePeople` is the
 * repair when they are genuinely one human, at the cost of the duplicate-Person
 * case no longer self-healing on sign-in.
 *
 * @returns the ids of the People newly linked to this user (empty on a no-op).
 * At most one; kept an array for its callers.
 */
export async function linkPersonToUser(
	userId: string,
): Promise<{ linkedPersonIds: string[] }> {
	const verified = await verifiedEmailFor(userId);
	if (!verified) return { linkedPersonIds: [] };

	// Zero is the ordinary no-match; two or more is an ambiguity we refuse to
	// resolve rather than guess at. The bind re-checks this arm itself, so this
	// is candidate SELECTION, not the guard.
	const candidates = await peopleMatching(verified);
	if (candidates.length !== 1) return { linkedPersonIds: [] };
	const personId = candidates[0];
	if (!personId) return { linkedPersonIds: [] };

	const bound = await bindVerifiedPerson({ personId, userId });
	return { linkedPersonIds: bound ? [personId] : [] };
}
