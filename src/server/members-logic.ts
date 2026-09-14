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
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, members, people, roleSlots } from "#/db/schema";
import {
	defaultClubRoleForOffices,
	OFFICER_POSITIONS,
	type OfficerPosition,
	parseOfficerPosition,
} from "#/lib/officers";
import { toStoredPhone } from "#/lib/phone";
import { buildImportPreview } from "#/lib/roster-import";
import { logActivity } from "./activity";
import { isReadableClub } from "./club-readable-logic";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { collapseMemberships } from "./membership-collapse-logic";
import {
	currentOfficersByMember,
	currentOfficersFor,
	openOfficerTermIfAbsent,
	reconcileOfficerTerms,
} from "./officer-terms-logic";

/** One row of the public member picker. `officerPositions` keeps the NARROW
 *  `OfficerPosition` union rather than `string[]` — the pickers feed it straight
 *  into `officerPositionLabel`, which only accepts the union. */
export interface PublicRosterMember {
	id: string;
	name: string;
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
		.select({ id: members.id, name: members.name })
		.from(members)
		.where(and(eq(members.clubId, clubId), ne(members.status, "inactive")))
		.orderBy(asc(members.name));
	const officers = await currentOfficersByMember(roster.map((m) => m.id));
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
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
	// OMITTING it clears it, same as `email`/`phone` above and UNLIKE
	// `officerPositions` below (whose `undefined` means "leave untouched").
	// Capped because THIS field really can land on a Person other clubs share: its
	// seed-up is guarded only on `people.preferred_name IS NULL`. The email write
	// below carries a blast-radius guard that refuses whenever any other club holds
	// the Person, so email never reaches a shared record and needs no cap for that
	// reason. 80 was the cap the deleted public self-add used for a name
	// (#326/#630); it stays the ceiling for a person-level name here.
	preferredName: z.string().trim().max(80).nullable().optional(),
	email: z.string().trim().email().nullable().optional(),
	phone: z.string().trim().nullable().optional(),
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
 * @returns `personEmailSynced`, a THREE-state signal — `null` and `false` are
 * both falsy, so never test it with `if (!synced)`:
 *   - `null`  — nothing to do. The Person already carried this address (or the
 *               edit cleared the membership's, which never touches the Person).
 *   - `true`  — the Person row was reconciled; every identity reader now agrees
 *               with the roster.
 *   - `false` — REFUSED. This edit moved the roster address, but the Person has
 *               an account or belongs to another club too, so `people.email`
 *               still holds the old value and sign-in, invite and claim all
 *               still match it. The caller MUST surface this: an admin who is
 *               not told has no way to discover the member is locked out.
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
		// Trimmed HERE for the same reason as `preferredName` above, and it matters
		// more now that this value can overwrite `people.email`: `linkPersonToUser`
		// compares `lower(people.email) = lower(user.email)` with NO trim, so a
		// padded address stored here kills auto-link on every sign-in while
		// `claimPersonForUser` (which does `.trim().toLowerCase()`) still matches —
		// the same "corrected on the roster, still locked out" shape this change
		// exists to remove. The zod schema trims, but `applyMemberEdit` is exported
		// and reached directly with the validator bypassed.
		email: input.email?.trim() || null,
		phone: toStoredPhone(input.phone, cc),
	};
	// Current offices before the edit — derived from open terms, for the log.
	const beforeOffices = await currentOfficersFor(input.memberId);
	// Declared out here so the caller can see it: null = nothing to reconcile,
	// true = `people.email` now matches the roster, false = the write was refused.
	let syncedPersonEmail: boolean | null = null;
	await db.transaction(async (tx) => {
		await tx.update(members).set(next).where(eq(members.id, input.memberId));
		// Reconcile people.email from the membership (#306, widened here).
		//
		// `people.email` is the identity key. `linkPersonToUser` reads it
		// EXCLUSIVELY to bind a sign-in to a roster Person, and it takes precedence
		// at the other two IDENTITY readers, which coalesce
		// `person.email ?? member.email`: `prepareMemberInvite` (where the invite is
		// actually sent) and `claimPersonForUser` (the public claim). So a WRONG
		// `people.email` poisons all three, and `members.email` cannot rescue any of
		// them. (It is read elsewhere too — `pathways-sync-logic`'s Base Camp match,
		// `guest-pipeline-logic`'s convert dedupe, `people-logic`'s lookups — but
		// those are advisory or club-scoped and are not what a wrong value takes
		// over. This list is the auth set, not the complete set of readers.)
		//
		// Until now this only fired `where people.email IS NULL`, which made a
		// mistyped address unrepairable: the roster displayed the correction while
		// all three readers kept matching the typo, so the member signed in and
		// landed on `NoClubScreen` ("You're not in a club yet"), a resent invite went
		// to the mistyped inbox, and nothing reported a problem to anyone. Hit in
		// production 2026-09-12; the member was still locked out two days later.
		//
		// The guard is a BLAST-RADIUS rule, not a value comparison, and the
		// distinction is the whole design:
		//  - `user_id IS NULL` — once someone has signed in, their address is one
		//    they PROVED they own via magic link. No club admin may move it. Applied
		//    to the WHOLE predicate, not just the correction case: an account holder
		//    whose Person email is somehow NULL (reachable via `people-merge-logic`,
		//    which reconciles `email` and `userId` independently) must be just as
		//    unwritable.
		//  - no membership outside THIS club — a Person is one row per human across
		//    every club (ADR-0008), so rewriting it from club A silently re-keys the
		//    identity club B relies on. With no other club on the row, this club is
		//    the only stakeholder and owns the value outright.
		//
		// Do NOT reintroduce a "does the Person still carry the address this
		// membership seeded" comparison in place of the second rule. It reads as a
		// tighter guard and is not one: `current.email` is the MEMBERSHIP's email,
		// which is state this same admin writes. Two consecutive saves — first to the
		// address the Person carries, then to one the attacker controls — satisfy any
		// such comparison, and in the common case one save is enough, because every
		// path that creates a shared Person (`import-members-logic`,
		// `guest-pipeline-logic`, `onboarding-logic`'s `createClubWithAdmin`, and
		// the NULL-`people.email` case of this very write) puts the SAME address on
		// both rows by construction. Both sequences were
		// demonstrated end to end: the retargeted Person binds to the attacker's
		// account on their next sign-in via `linkPersonToUser` — which is an
		// unbounded multi-row UPDATE over a column with no unique constraint — and
		// `auth-context-logic` then hands them every club that Person belongs to, at
		// whatever role the victim held. A value comparison also cannot repair the
		// incident above at all, since by then the two rows have already diverged.
		//
		// `syncedPersonEmail` records whether the write actually landed, because the
		// failure this whole change exists to remove was a SILENT one: a refused
		// reconciliation that looks exactly like a successful one is how a member
		// stays locked out for two days with nobody able to see why.
		const personWritable = and(
			eq(people.id, current.personId),
			isNull(people.userId),
			notExists(
				tx
					.select({ one: sql`1` })
					.from(members)
					.where(
						and(
							eq(members.personId, people.id),
							ne(members.clubId, input.clubId),
						),
					),
			),
		);
		// Compare against the PERSON's address, never the membership's. The incident
		// state is `members.email` already corrected and `people.email` still wrong,
		// so a membership-level "did this edit change anything" check skips the one
		// row that needs repairing — re-saving the roster is exactly what the admin
		// does when the first correction appears not to have worked.
		//
		// NEVER on a null edit, and the asymmetry with the preferred-name CLEAR
		// below is deliberate. Two reasons, both demonstrated rather than reasoned:
		//  - `loadMemberProfile` binds the edit form to `members.email` RAW (unlike
		//    `preferred_name`, which it coalesces), so a member whose address lives
		//    only on their Person renders a BLANK field, and an unrelated save — a
		//    name fix, an officer checkbox — submits null. Clearing here would make
		//    that a permanent lockout triggered by a name edit.
		//  - a null `people.email` is not fail-safe. It is the state where
		//    `claimPersonForUser` falls back to `members.email`, the column any
		//    officer of any of this Person's clubs controls, so blanking it HANDS
		//    OVER the claim key rather than withdrawing it.
		// Clearing the membership address therefore leaves the Person's intact, as
		// it always has. A person-level clear needs its own surface and its own
		// argument; it is not a side effect of editing a roster row.
		const [personNow] = await tx
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, current.personId));
		// Normalised, because every identity reader normalises: `linkPersonToUser`
		// compares `lower(...) = lower(...)` and `claimPersonForUser` does
		// `.trim().toLowerCase()`. A case-only difference changes nothing for any of
		// them, so treating it as a divergence would raise a lockout alarm on a
		// routine capitalisation edit.
		const personEmailNow = personNow?.email?.trim().toLowerCase() ?? null;
		const nextEmailNorm = next.email?.toLowerCase() ?? null;
		if (next.email !== null && personEmailNow !== nextEmailNorm) {
			const synced = await tx
				.update(people)
				.set({ email: next.email })
				.where(personWritable)
				.returning({ id: people.id });
			// A refusal is only worth reporting when THIS edit asked to move the
			// address. A linked member can carry a work address on the membership and
			// a personal one on the Person quite legitimately, and that divergence is
			// permanent — reporting it on every unrelated save would fire the alarm
			// forever on healthy rows, which is how the one real alarm gets ignored.
			syncedPersonEmail =
				synced.length > 0 ? true : next.email !== current.email ? false : null;
		}
		// The "goes by" name below is scoped by VALUE, not by blast radius, and that
		// asymmetry is deliberate rather than an oversight: `preferred_name` is a
		// display fallback, so the worst a stale copy costs is a wrong greeting in
		// another club, and one club overwriting another's answer is the only risk
		// worth guarding. `people.email` is an identity key whose worst case is an
		// account takeover, which is why it gets the stricter rule. Do not "make
		// them consistent" in either direction without re-reading both arguments.
		//
		// Same shape for the "goes by" name (#486): it is a person-level fact
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
					email: current.email,
					phone: current.phone,
					officerPositions: beforeOffices,
				},
				after: { ...next, officerPositions: afterOffices },
				// Null = the Person already carried this address, nothing to do.
				// False = the reconciliation was REFUSED (the Person has signed in,
				// or belongs to another club too), so `people.email` still differs
				// from what the roster now shows and every identity reader still
				// matches the old value. That is the state this change exists to
				// stop being invisible, so it belongs in the audit trail even
				// though no UI reads it yet.
				personEmailSynced: syncedPersonEmail,
			},
		});
	});
	return { ok: true as const, personEmailSynced: syncedPersonEmail };
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
 *  before/after. On an active→inactive transition their UPCOMING, non-cancelled
 *  role slots are released (mirrors applyMemberRemove); past slots are left
 *  untouched. */
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
		// stay assigned (history preserved).
		if (deactivating) {
			const upcoming = await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
				.where(
					and(
						eq(roleSlots.assignedMemberId, input.memberId),
						gte(meetings.scheduledAt, new Date()),
						ne(meetings.status, "cancelled"),
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

/** Remove a member: release their upcoming, non-cancelled slots (logged) then
 *  delete them (availability cascades). A user-linked member can't be removed. */
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
		const upcoming = await tx
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, input.memberId),
					gte(meetings.scheduledAt, new Date()),
					ne(meetings.status, "cancelled"),
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
		await tx.delete(members).where(eq(members.id, input.memberId));
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "member_remove",
			targetType: "member",
			targetId: input.memberId,
			detail: { name: member.name },
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
});
type BulkImportInput = z.infer<typeof bulkImportSchema> & RosterActor;

export interface BulkImportResult {
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
		.select({ name: members.name, email: members.email })
		.from(members)
		.where(eq(members.clubId, input.clubId));

	const preview = buildImportPreview(input.rows, existing);
	const toInsert = preview.filter((r) => r.willImport);
	if (toInsert.length === 0) {
		return { insertedIds: [], inserted: 0, skipped: preview.length };
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
			// Pasted office is free text; parse to the enum (unparseable → null).
			const office = parseOfficerPosition(row.office);
			// Default the membership's role from its office (President / VP Education
			// ⇒ admin), stored explicitly (ADR-0008 Phase B / #99).
			const clubRole = defaultClubRoleForOffices(office ? [office] : []);
			const [m] = await tx
				.insert(members)
				.values({
					clubId: input.clubId,
					personId: person.id,
					name,
					email,
					phone,
					clubRole,
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to insert member.");
			ids.push(m.id);
			// Open a current officer term for the parsed office (#100).
			if (office) {
				await openOfficerTermIfAbsent(tx, m.id, office, new Date());
			}
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
		insertedIds,
		inserted: insertedIds.length,
		skipped: preview.length - insertedIds.length,
	};
}
