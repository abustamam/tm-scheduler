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
//    to the freshly-signed-in account, IDEMPOTENTLY and SAFELY: it links ONLY
//    when the verified sign-in email matches the member's on-file address, so
//    nobody can adopt another member's identity by picking their name. A member
//    with NO email on file anywhere is un-claimable on the public surface (it
//    needs an officer invite) — never adopted under an arbitrary address.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, user } from "#/db/schema";

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
	| "needs_invite"
	| "not_found";

/**
 * Bind the Person behind `memberId` to the signed-in `userId` (the finish step
 * for invite-accept AND the public claim). SECURITY — the whole point of this
 * function is that it stays safe on a public, honor-system surface. Linking
 * ALWAYS requires the verified sign-in email to match the member's on-file
 * address, so picking a name can never adopt someone else's identity:
 *   - `already_yours`  — the Person is already linked to THIS user (idempotent).
 *   - `already_other`  — linked to a DIFFERENT user: never reassigned (no theft).
 *   - `email_mismatch` — the member has an on-file email that isn't the one the
 *                        user just proved they own: not adopted.
 *   - `needs_invite`   — the member has NO email on file anywhere: un-claimable
 *                        on the public surface (an officer must invite them),
 *                        never adopted under an arbitrary verified address.
 *   - `linked`         — the on-file email matches the verified sign-in email.
 * "On file" coalesces `people.email` with the membership's `members.email`
 * (`applyMemberEdit` writes the latter but not the former), so a member the VPE
 * gave an email still uses the email-match path, not the un-claimable one.
 * The link write is guarded on `user_id IS NULL` and re-checks on a 0-row result
 * so two concurrent claims resolve deterministically.
 */
export async function claimPersonForUser(input: {
	memberId: string;
	userId: string;
}): Promise<ClaimOutcome> {
	const [member] = await db
		.select({
			id: members.id,
			personId: members.personId,
			email: members.email,
		})
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

	// The address the club has for this member — on the Person OR the membership
	// row. NO email anywhere ⇒ un-claimable on the public surface: an officer must
	// invite them, so nobody adopts another member's identity by picking a name.
	const onFileEmail =
		(person.email ?? member.email)?.trim().toLowerCase() || null;
	if (!onFileEmail) return "needs_invite";

	// The signed-in account's email is the address the magic link proved ownership
	// of — the only credential we trust. Link ONLY when it matches the on-file one.
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, input.userId))
		.limit(1);
	const verifiedEmail = account?.email?.trim().toLowerCase() ?? null;
	if (!verifiedEmail || onFileEmail !== verifiedEmail) return "email_mismatch";

	// Match proven. Stamp the address onto the Person if it lived only on the
	// membership row, so future sign-in auto-link resolves it directly.
	return await bindPerson({
		personId: person.id,
		userId: input.userId,
		setEmail: person.email ? undefined : onFileEmail,
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
