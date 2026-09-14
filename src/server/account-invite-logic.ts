// Account-invite + "claim your name" DB logic (#266, re-keyed by #756), split
// out from the createServerFn wrappers in `account-invite.ts` so it is directly
// integration-testable and its `#/db` → `pg` import never leaks into the client
// bundle (the server-modules.guard.test.ts rule; see `members-logic.ts`).
//
// Both entry points read ONE address, `members.email` — the club's own contact
// record. `people.email` is the verified identity address and is written only by
// `bindVerifiedPerson`; nothing here treats it as a key, because every value it
// can hold before a bind was typed by a club-scoped actor (the CSV importer, the
// guest-book conversion, the create-club form) rather than proved by anybody.
//
// Two entry points:
//  - `prepareMemberInvite` — the admin roster action (Part A). Resolves the
//    picked membership to its Person, refuses to re-invite an already-joined
//    account, and stamps `invited_at`. Returns the address the magic link should
//    go to; the wrapper sends it via `auth.api.signInMagicLink`. It writes no
//    identity at all — correcting a typo is an ordinary roster edit now.
//  - `claimPersonForUser` — the post-sign-in finish step for BOTH the admin
//    invite and the public "This is me" claim (Part B). Binds the picked Person
//    to the freshly-signed-in account, IDEMPOTENTLY and SAFELY: it links ONLY
//    when the verified sign-in email matches the membership's on-file address
//    AND only one club holds the Person, so nobody can adopt another member's
//    identity by picking their name.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { clubs, members, people, user } from "#/db/schema";
import {
	bindVerifiedPerson,
	personHeldBySingleClub,
} from "./account-link-logic";

export type InvitePrepOutcome =
	| "ready"
	| "already_joined"
	| "no_email"
	| "recently_invited";

/** Cooldown for the BULK invite path: skip re-inviting an un-joined member who
 *  was invited within this window (24h), so one bulk click can't resend to the
 *  same person on every press. The single explicit invite ignores this. */
export const INVITE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

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
 * targets the MEMBERSHIP's own email — the club's contact record, and the same
 * address `claimPersonForUser` will require — so acceptance provably links
 * exactly this Person and nothing else. Idempotent: an already-linked Person
 * returns `already_joined` (no resend); a membership with no email returns
 * `no_email` so the caller can ask the admin to add one first. When
 * `respectCooldown` is set (the bulk path passes it; the single explicit invite
 * omits it), a Person invited within `INVITE_COOLDOWN_MS` returns
 * `recently_invited` WITHOUT re-stamping `invited_at` or sending.
 *
 * It deliberately does NOT fall back to `people.email` (#756). The link has to
 * go where the claim will look, and a person-level address that the roster
 * disagrees with delivers a magic link that then refuses to bind — a silent
 * half-failure with nothing on screen to explain it. `no_email` puts the admin
 * on the one surface they own: add the address to the roster row, invite again.
 */
export async function prepareMemberInvite(input: {
	clubId: string;
	memberId: string;
	respectCooldown?: boolean;
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
		.select({
			id: people.id,
			userId: people.userId,
			invitedAt: people.invitedAt,
		})
		.from(people)
		.where(eq(people.id, member.personId))
		.limit(1);
	if (!person) throw new Error("Member not found in this club.");

	// Already has an account — nothing to send (safe, idempotent).
	if (person.userId) return { outcome: "already_joined" };

	const email = member.email?.trim() || null;
	if (!email) return { outcome: "no_email" };

	// Bulk cooldown: with a usable email but an invite stamped within the window,
	// skip this member (no resend, no re-stamp). Single explicit invite omits
	// `respectCooldown`, so an admin "resend" always sends.
	if (
		input.respectCooldown &&
		person.invitedAt &&
		Date.now() - person.invitedAt.getTime() < INVITE_COOLDOWN_MS
	) {
		return { outcome: "recently_invited" };
	}

	// Stamp the invite. Guarded on `user_id IS NULL` so a concurrent sign-in that
	// just linked the Person is never clobbered.
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
 * ALWAYS requires the verified sign-in email to match the MEMBERSHIP's on-file
 * address, so picking a name can never adopt someone else's identity:
 *   - `already_yours`  — the Person is already linked to THIS user (idempotent).
 *   - `already_other`  — linked to a DIFFERENT user: never reassigned (no theft).
 *   - `email_mismatch` — the membership has an on-file email that isn't the one
 *                        the user just proved they own: not adopted.
 *   - `needs_invite`   — the membership has NO email, or more than one club holds
 *                        this Person: un-claimable here, never adopted under an
 *                        arbitrary verified address.
 *   - `linked`         — the on-file email matches the verified sign-in email.
 *
 * The two refusals that are not about the address:
 *   - **More than one club holds this Person** → `needs_invite`. `members.email`
 *     is a column any officer of ANY of that Person's clubs controls, so it
 *     cannot be the key that binds a Person other clubs rely on: club A's
 *     officer would type their own address onto their membership row and inherit
 *     club B's membership at whatever role the victim held. Same rule, same
 *     definition (`personHeldBySingleClub`), as the sign-in auto-link.
 *   - **`people.email` is not consulted at all.** It is written at Person
 *     CREATION from values the importer, the guest book or the create-club form
 *     carried, so treating it as a claim key is treating a typed string as a
 *     credential — which is the defect this whole change removes.
 */
export async function claimPersonForUser(input: {
	memberId: string;
	userId: string;
}): Promise<ClaimOutcome> {
	const [member] = await db
		.select({
			id: members.id,
			clubId: members.clubId,
			personId: members.personId,
			email: members.email,
		})
		.from(members)
		.where(eq(members.id, input.memberId))
		.limit(1);
	if (!member) return "not_found";

	const [person] = await db
		.select({ id: people.id, userId: people.userId })
		.from(people)
		.where(eq(people.id, member.personId))
		.limit(1);
	if (!person) return "not_found";

	if (person.userId) {
		return person.userId === input.userId ? "already_yours" : "already_other";
	}

	// Checked BEFORE the address comparison, deliberately: a shared Person is
	// un-claimable here whether or not the address happens to match, and saying
	// `email_mismatch` to an officer who typed the right address would invite
	// them to "fix" it by typing a different one.
	if (!(await personHeldBySingleClub(db, person.id))) return "needs_invite";

	const onFileEmail = member.email?.trim().toLowerCase() || null;
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

	// Match proven. The bind stamps the VERIFIED address onto the Person, which is
	// what makes the next sign-in's auto-link a no-op rather than a re-derivation.
	if (
		await bindVerifiedPerson({
			personId: person.id,
			userId: input.userId,
			verifiedEmail,
		})
	) {
		return "linked";
	}

	// 0 rows updated — a concurrent claim won the race. Report the final state.
	const [now] = await db
		.select({ userId: people.userId })
		.from(people)
		.where(eq(people.id, person.id))
		.limit(1);
	return now?.userId === input.userId ? "already_yours" : "already_other";
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
