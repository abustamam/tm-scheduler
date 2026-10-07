// A member's preferred contact method (#1093): the db half. The pure half —
// which methods a Person can have, and what a stored choice means — is
// `#/lib/preferred-contact`, which the client imports too.
//
// Lives apart from `contact-preference.ts` for the reasons in
// CODING_STANDARDS.md ("Data layer"): a server-fn module may export only
// `createServerFn`s and types, and a handler body cannot be reached from a test.
//
// There are exactly two writers of `people.preferred_contact`, and both put the
// availability condition below in the UPDATE's OWN WHERE rather than checking a
// prior SELECT: the member's own, here, and a club admin's roster edit
// (`applyMemberEdit`), which instead requires the preference not to have been
// chosen by the member (`contact_preference_by` NULL or 'officer', #1110). A phone cleared
// between a form's load and its save therefore makes the write match nothing,
// and zero rows matched is the refusal.
import { and, eq, type SQL, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import {
	availableContactMethods,
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	type ContactMethod,
	effectivePreferredContact,
	NON_BLANK_PATTERN,
} from "#/lib/preferred-contact";
import { resolveUserPersonId } from "./person-identity-logic";

/** Refusal for an account with no Person behind it at all. */
export const NO_LINKED_PERSON_MESSAGE =
	"Your account isn't linked to a club member yet.";

/**
 * `availableContactMethods`, as a predicate on the `people` row an UPDATE is
 * about to write. The SQL spelling of the same two tests: a phone method needs
 * a digit in `people.phone` (`hasDialablePhone`, `/\d/`), and email needs a
 * character outside `TRIM_WHITESPACE` in `people.email` (`NON_BLANK_PATTERN`,
 * the same pattern the JS check is built from). Evaluated against the row as
 * the statement sees it, which inside `applyMemberEdit`'s transaction includes
 * that edit's own phone and email writes. `null` ("no preference") is always
 * available.
 */
export function contactMethodAvailableSql(
	method: ContactMethod | null,
): SQL | undefined {
	if (method === null) return undefined;
	if (method === "email") {
		// A BOUND parameter, not SQL text: the class reaches Postgres byte for
		// byte, with no string-literal escaping in between. Not `btrim(…) <> ''`
		// (spaces only) and not `\S` (Postgres's own idea of whitespace, which
		// disagrees with JS `.trim()` on NBSP and the BOM).
		return sql`coalesce(${people.email}, '') ~ ${NON_BLANK_PATTERN}`;
	}
	return sql`${people.phone} ~ '[0-9]'`;
}

/**
 * The signed-in member sets their own preference (#1093).
 *
 * Writes only the caller's own Person: `people.user_id = userId` is in the
 * WHERE, and nothing about WHICH Person comes from the request. An account with
 * duplicate Persons (see `person-identity-logic.ts`) has the choice written to
 * each of them it is available on — but the write must land on the one
 * `resolveUserPersonId` picks, because that is the one the /account card and
 * every person-level surface read. If it did not (that Person has no phone, a
 * duplicate does), the whole write rolls back and is refused: answering "saved"
 * while the card goes on showing the old value is the bug this prevents.
 *
 * Refuses a method whose data is missing with
 * `CONTACT_METHOD_UNAVAILABLE_MESSAGE`; `null` always saves.
 */
export async function applySetMyPreferredContact(input: {
	userId: string;
	preferredContact: ContactMethod | null;
}): Promise<{ ok: true; preferredContact: ContactMethod | null }> {
	const canonical = await resolveUserPersonId(input.userId);
	if (!canonical) throw new Error(NO_LINKED_PERSON_MESSAGE);
	await db.transaction(async (tx) => {
		const written = await tx
			.update(people)
			.set({
				preferredContact: input.preferredContact,
				contactPreferenceBy: "member",
			})
			.where(
				and(
					eq(people.userId, input.userId),
					contactMethodAvailableSql(input.preferredContact),
				),
			)
			.returning({ id: people.id });
		// Throwing rolls back the duplicates written above too.
		if (!written.some((w) => w.id === canonical)) {
			throw new Error(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
		}
	});
	return { ok: true, preferredContact: input.preferredContact };
}

export interface MyContactPreference {
	/** False when the account has no Person: there is nothing to set. */
	linked: boolean;
	/** The methods the member may pick, from their Person's email and phone. */
	available: ContactMethod[];
	/** The EFFECTIVE preference — never the raw column. */
	preferredContact: ContactMethod | null;
	/** The RAW provenance (#1110): who set it, or null when nobody has. */
	setBy: "member" | "officer" | null;
}

/** What the /account card shows for the signed-in member. */
export async function loadMyContactPreference(
	userId: string,
): Promise<MyContactPreference> {
	const personId = await resolveUserPersonId(userId);
	if (!personId) {
		return {
			linked: false,
			available: [],
			preferredContact: null,
			setBy: null,
		};
	}
	const [row] = await db
		.select({
			email: people.email,
			phone: people.phone,
			stored: people.preferredContact,
			setBy: people.contactPreferenceBy,
		})
		.from(people)
		.where(and(eq(people.id, personId), eq(people.userId, userId)))
		.limit(1);
	if (!row) {
		return {
			linked: false,
			available: [],
			preferredContact: null,
			setBy: null,
		};
	}
	return {
		linked: true,
		available: availableContactMethods(row),
		preferredContact: effectivePreferredContact(row.stored, row),
		setBy: row.setBy,
	};
}

/**
 * Each of a club's memberships' EFFECTIVE preference, keyed by membership id —
 * for `find_people`, whose output must never carry an email or phone. Those
 * two are read here only to decide availability and do not leave this
 * function. The caller authorizes.
 */
export async function loadClubContactPreferences(
	clubId: string,
): Promise<Map<string, ContactMethod | null>> {
	const rows = await db
		.select({
			memberId: members.id,
			email: people.email,
			phone: people.phone,
			stored: people.preferredContact,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.clubId, clubId));
	return new Map(
		rows.map((r) => [r.memberId, effectivePreferredContact(r.stored, r)]),
	);
}
