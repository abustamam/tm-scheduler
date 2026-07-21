// Account-invite + "claim your name" DB logic (#266), split out from the
// createServerFn wrappers in `account-invite.ts` so it is directly
// integration-testable and its `#/db` → `pg` import never leaks into the client
// bundle (the server-modules.guard.test.ts rule; see `members-logic.ts`).
//
// Two entry points:
//  - `prepareMemberInvite` — the admin roster action (Part A). Resolves the
//    picked membership to its Person, refuses to re-invite an already-joined
//    account, ensures the Person has an email on file (copying the membership
//    email up when absent), and stamps `invited_at`. Returns the address the
//    magic link should go to; the wrapper sends it via `auth.api.signInMagicLink`.
//  - `claimPersonForUser` — the post-sign-in finish step for BOTH the admin
//    invite and the public "This is me" claim (Part B). Binds the picked Person
//    to the freshly-signed-in account, IDEMPOTENTLY and SAFELY (never steals a
//    Person already linked to a different account; never adopts a Person whose
//    real email differs; guards privilege escalation on emailless admins).
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, user } from "#/db/schema";

/** Does this Person hold an `admin` club role in ANY club? Used to block the
 *  emailless-adoption path from silently granting admin (see claimPersonForUser). */
async function personHoldsAdminRole(personId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: members.id })
		.from(members)
		.where(and(eq(members.personId, personId), eq(members.clubRole, "admin")))
		.limit(1);
	return Boolean(row);
}

export type InvitePrepOutcome = "ready" | "already_joined" | "no_email";

export interface InvitePrep {
	outcome: InvitePrepOutcome;
	/** The address to send the magic link to (present only when `ready`). */
	email?: string;
	personId?: string;
	/** The club's display name, for the invite email copy (present when `ready`). */
	clubName?: string;
}

/**
 * Admin roster invite (Part A). `memberId` must belong to `clubId`. The invite
 * always targets the Person's OWN email on file — you cannot invite an arbitrary
 * address — so acceptance provably links exactly that Person (email-match +
 * `claimPersonForUser`). Idempotent: an already-linked Person returns
 * `already_joined` (no resend); a Person with no email anywhere returns
 * `no_email` so the caller can ask the admin to add one first.
 */
export async function prepareMemberInvite(input: {
	clubId: string;
	memberId: string;
}): Promise<InvitePrep> {
	const [member] = await db
		.select({
			id: members.id,
			clubId: members.clubId,
			email: members.email,
			personId: members.personId,
		})
		.from(members)
		.where(eq(members.id, input.memberId))
		.limit(1);
	if (!member || member.clubId !== input.clubId) {
		throw new Error("Member not found in this club.");
	}

	const [person] = await db
		.select({ id: people.id, email: people.email, userId: people.userId })
		.from(people)
		.where(eq(people.id, member.personId))
		.limit(1);
	if (!person) throw new Error("Member not found in this club.");

	// Already has an account — nothing to send (safe, idempotent).
	if (person.userId) return { outcome: "already_joined" };

	// Prefer the Person-level email (the auth match key); fall back to the
	// membership email and copy it up so `claimPersonToUser`/email-match works.
	const email = (person.email ?? member.email)?.trim() || null;
	if (!email) return { outcome: "no_email" };

	// Persist the effective email on the Person if it was missing, and stamp the
	// invite. Both guarded on `user_id IS NULL` so a concurrent sign-in that just
	// linked the Person is never clobbered.
	if (!person.email) {
		await db
			.update(people)
			.set({ email })
			.where(and(eq(people.id, person.id), isNull(people.userId)));
	}
	await db
		.update(people)
		.set({ invitedAt: new Date() })
		.where(and(eq(people.id, person.id), isNull(people.userId)));

	const [club] = await db
		.select({ name: clubs.name })
		.from(clubs)
		.where(eq(clubs.id, input.clubId))
		.limit(1);

	return {
		outcome: "ready",
		email,
		personId: person.id,
		clubName: club?.name,
	};
}

export type ClaimOutcome =
	| "linked"
	| "already_yours"
	| "already_other"
	| "email_mismatch"
	| "not_found";

/**
 * Bind the Person behind `memberId` to the signed-in `userId` (the finish step
 * for invite-accept AND the public claim). SECURITY — the whole point of this
 * function is that it stays safe on a public, honor-system surface:
 *   - `already_yours`  — the Person is already linked to THIS user (idempotent).
 *   - `already_other`  — linked to a DIFFERENT user: never reassigned (no theft).
 *   - `email_mismatch` — the Person has a real email that isn't the one the user
 *                        just proved they own: not adopted (you can't grab a
 *                        Person with someone else's address).
 *   - `linked`         — the Person was unlinked and adoptable:
 *        · its email already matches the verified sign-in email, OR
 *        · it had NO email (a walk-in self-add): we set the verified email and
 *          link — but ONLY when the Person holds no admin role anywhere, so an
 *          emailless officer can't be silently claimed into admin.
 * The link write is guarded on `user_id IS NULL` and re-checks on a 0-row result
 * so two concurrent claims resolve deterministically.
 */
export async function claimPersonForUser(input: {
	memberId: string;
	userId: string;
}): Promise<ClaimOutcome> {
	const [member] = await db
		.select({ id: members.id, personId: members.personId })
		.from(members)
		.where(eq(members.id, input.memberId))
		.limit(1);
	if (!member) return "not_found";

	const [person] = await db
		.select({ id: people.id, email: people.email, userId: people.userId })
		.from(people)
		.where(eq(people.id, member.personId))
		.limit(1);
	if (!person) return "not_found";

	if (person.userId) {
		return person.userId === input.userId ? "already_yours" : "already_other";
	}

	// The signed-in account's email is the address the magic link proved ownership
	// of — the only credential we trust for adoption.
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, input.userId))
		.limit(1);
	const verifiedEmail = account?.email?.trim().toLowerCase() ?? null;

	if (person.email) {
		// Real email on file: only link when it matches the verified address.
		if (!verifiedEmail || person.email.trim().toLowerCase() !== verifiedEmail) {
			return "email_mismatch";
		}
		return await bindPerson({ personId: person.id, userId: input.userId });
	}

	// Emailless Person (a public self-add): adopt it under the verified email, but
	// never let that silently confer admin.
	if (!verifiedEmail) return "email_mismatch";
	if (await personHoldsAdminRole(person.id)) return "email_mismatch";
	return await bindPerson({
		personId: person.id,
		userId: input.userId,
		setEmail: verifiedEmail,
	});
}

/** Atomically claim an unlinked Person (guarded on `user_id IS NULL`); on a lost
 *  race, re-read to report whether it became ours or someone else's. */
async function bindPerson(input: {
	personId: string;
	userId: string;
	setEmail?: string;
}): Promise<ClaimOutcome> {
	const linked = await db
		.update(people)
		.set(
			input.setEmail
				? { userId: input.userId, email: input.setEmail }
				: { userId: input.userId },
		)
		.where(and(eq(people.id, input.personId), isNull(people.userId)))
		.returning({ id: people.id });
	if (linked.length > 0) return "linked";

	// 0 rows updated — a concurrent claim won the race. Report the final state.
	const [now] = await db
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, input.personId))
		.limit(1);
	if (now?.userId === input.userId) return "already_yours";
	return "already_other";
}

/** Resolve the club a membership belongs to (the invite-accept landing lands the
 *  user in this club's workspace). Null when the member no longer exists. */
export async function clubIdForMember(
	memberId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ clubId: members.clubId })
		.from(members)
		.where(eq(members.id, memberId))
		.limit(1);
	return row?.clubId ?? null;
}
