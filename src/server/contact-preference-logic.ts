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
// (`applyMemberEdit`), which adds `isNull(people.userId)`. A phone cleared
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
} from "#/lib/preferred-contact";
import { resolveUserPersonId } from "./person-identity-logic";

/** Refusal for an account with no Person behind it at all. */
export const NO_LINKED_PERSON_MESSAGE =
	"Your account isn't linked to a club member yet.";

/** A POSIX-ARE class: any character that is not whitespace. */
export const NON_WHITESPACE = "\\S";

/**
 * `availableContactMethods`, as a predicate on the `people` row an UPDATE is
 * about to write. The SQL spelling of the same two tests: a phone method needs
 * a digit in `people.phone` (`hasDialablePhone`, `/\d/`), email needs a
 * `people.email` with a non-whitespace character (JS `.trim()`). Evaluated against the row as the statement sees it,
 * which inside `applyMemberEdit`'s transaction includes that edit's own phone
 * and email writes. `null` ("no preference") is always available.
 */
export function contactMethodAvailableSql(
	method: ContactMethod | null,
): SQL | undefined {
	if (method === null) return undefined;
	if (method === "email") {
		// "Has a non-whitespace character", the SQL half of JS `email?.trim()`
		// being non-empty. NOT `btrim(…) <> ''`: `btrim` strips only spaces, so
		// an email of a tab or a newline passed the server while the UI called
		// it blank. The pattern is a BOUND parameter rather than SQL text, so the
		// backslash reaches Postgres exactly as written, with no string-literal
		// escaping in between.
		return sql`coalesce(${people.email}, '') ~ ${NON_WHITESPACE}`;
	}
	return sql`${people.phone} ~ '[0-9]'`;
}

/**
 * The signed-in member sets their own preference (#1093).
 *
 * Writes only the caller's own Person: `people.user_id = userId` is in the
 * WHERE, and nothing about WHICH Person comes from the request. An account with
 * duplicate Persons (see `person-identity-logic.ts`) has the choice written to
 * each of them it is available on, so whichever one a surface resolves agrees.
 *
 * Refuses a method whose data is missing with
 * `CONTACT_METHOD_UNAVAILABLE_MESSAGE`; `null` always saves.
 */
export async function applySetMyPreferredContact(input: {
	userId: string;
	preferredContact: ContactMethod | null;
}): Promise<{ ok: true; preferredContact: ContactMethod | null }> {
	const written = await db
		.update(people)
		.set({ preferredContact: input.preferredContact })
		.where(
			and(
				eq(people.userId, input.userId),
				contactMethodAvailableSql(input.preferredContact),
			),
		)
		.returning({ id: people.id });
	if (written.length === 0) {
		const [any] = await db
			.select({ id: people.id })
			.from(people)
			.where(eq(people.userId, input.userId))
			.limit(1);
		throw new Error(
			any ? CONTACT_METHOD_UNAVAILABLE_MESSAGE : NO_LINKED_PERSON_MESSAGE,
		);
	}
	return { ok: true, preferredContact: input.preferredContact };
}

export interface MyContactPreference {
	/** False when the account has no Person: there is nothing to set. */
	linked: boolean;
	/** The methods the member may pick, from their Person's email and phone. */
	available: ContactMethod[];
	/** The EFFECTIVE preference — never the raw column. */
	preferredContact: ContactMethod | null;
}

/** What the /account card shows for the signed-in member. */
export async function loadMyContactPreference(
	userId: string,
): Promise<MyContactPreference> {
	const personId = await resolveUserPersonId(userId);
	if (!personId) {
		return { linked: false, available: [], preferredContact: null };
	}
	const [row] = await db
		.select({
			email: people.email,
			phone: people.phone,
			stored: people.preferredContact,
		})
		.from(people)
		.where(and(eq(people.id, personId), eq(people.userId, userId)))
		.limit(1);
	if (!row) return { linked: false, available: [], preferredContact: null };
	return {
		linked: true,
		available: availableContactMethods(row),
		preferredContact: effectivePreferredContact(row.stored, row),
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
