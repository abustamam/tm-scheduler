/**
 * DB-backed tests for members → people email reconciliation (#306, widened).
 *
 * `people.email` is the identity key: `linkPersonToUser` reads it exclusively,
 * and `prepareMemberInvite` / `claimPersonForUser` prefer it over
 * `members.email`. `applyMemberEdit` reconciles it from the membership under a
 * BLAST-RADIUS guard — the Person must have no account (`user_id IS NULL`) and
 * no membership outside the editing club.
 *
 * Why that shape, and what these tests are really holding: the guard used to be
 * `people.email IS NULL`, which made a typo unrepairable and locked a real member
 * out for two days. The obvious repair — "also allow it when the Person still
 * carries the address this membership seeded" — is NOT safe and is pinned
 * against here, because `current.email` is membership state the same admin
 * writes: two consecutive saves satisfy it, and in the common case one does,
 * since every path that creates a shared Person writes the same address to both
 * rows. The takeover cases below fail against that design and pass against this
 * one.
 *
 * Drives `applyMemberEdit` directly against the test DB (`#/db` → test DB), plus
 * `linkPersonToUser` for the end-to-end sign-in cases.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/member-email-reconciliation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");
const { linkPersonToUser } = await import("./account-link-logic");

describe.skipIf(!hasTestDb)("member email reconciliation (#306)", () => {
	let club: SeededClub;
	/** Extra `user` rows minted by a test. `cleanup` only removes the ids it is
	 *  handed, so track them or they leak into the next run (CLAUDE.md). */
	let extraUserIds: string[];
	/** Extra clubs seeded by a test, cleaned up in reverse. */
	let extraClubs: SeededClub[];

	beforeEach(async () => {
		club = await seedClub();
		extraUserIds = [];
		extraClubs = [];
	});
	afterEach(async () => {
		for (const c of extraClubs) {
			await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		await cleanup(club.clubId, [
			club.adminUserId,
			club.memberUserId,
			...extraUserIds,
		]);
	});

	/** A sign-in account with `email`, cleaned up with the rest of the fixture. */
	async function seedUser(email: string): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(user)
			.values({ id, name: "", email, emailVerified: true });
		extraUserIds.push(id);
		return id;
	}

	/** A (person, membership) pair in the seeded club. */
	async function seedMember(opts: {
		personEmail?: string | null;
		memberEmail?: string | null;
		/** Set to make the Person a signed-in account (ADR-0008 people.user_id). */
		personUserId?: string | null;
	}): Promise<{ memberId: string; personId: string }> {
		const personId = await seedPerson({
			name: "Recon Person",
			email: opts.personEmail ?? null,
			userId: opts.personUserId ?? null,
		});
		const [member] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId,
				name: "Recon Person",
				email: opts.memberEmail ?? null,
				clubRole: "member",
			})
			.returning({ id: members.id });
		if (!member) throw new Error("member insert failed");
		return { memberId: member.id, personId };
	}

	/** Put the same human on a SECOND club's roster (ADR-0008: one Person row). */
	async function alsoInAnotherClub(personId: string, email: string | null) {
		const other = await seedClub();
		extraClubs.push(other);
		await testDb.insert(members).values({
			clubId: other.clubId,
			personId,
			name: "Recon Person",
			email,
			clubRole: "member",
		});
		return other;
	}

	function edit(memberId: string, email: string | null) {
		return applyMemberEdit({
			actorMemberId: null,
			clubId: club.clubId,
			memberId,
			name: "Recon Person",
			email,
		});
	}

	async function personEmail(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		return row?.email ?? null;
	}

	async function personUserId(personId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ userId: people.userId })
			.from(people)
			.where(eq(people.id, personId));
		return row?.userId ?? null;
	}

	/** The `personEmailSynced` value on this club's own member_edit log row. */
	async function loggedSync(): Promise<boolean | null | undefined> {
		const [row] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "member_edit"),
				),
			);
		return (row?.detail as { personEmailSynced?: boolean | null })
			?.personEmailSynced;
	}

	async function memberEmail(memberId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ email: members.email })
			.from(members)
			.where(eq(members.id, memberId));
		return row?.email ?? null;
	}

	it("copies the membership email up when the Person has none", async () => {
		const { memberId, personId } = await seedMember({});
		const email = `copyup-${randomUUID()}@test.example`;

		const res = await edit(memberId, email);

		expect(await personEmail(personId)).toBe(email);
		expect(await memberEmail(memberId)).toBe(email);
		expect(res.personEmailSynced).toBe(true);
	});

	it("repairs a member whose roster email was ALREADY corrected", async () => {
		// The production state, and the one a value comparison cannot reach: the
		// admin fixed the roster days ago, so `members.email` is right and
		// `people.email` is still the typo. Re-saving the roster — which is exactly
		// what an admin does when the first fix appears not to have worked — must
		// repair it.
		const n = randomUUID();
		const typo = `jensivarn-${n}@test.example`;
		const corrected = `jensivorn-${n}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: typo,
			memberEmail: corrected,
		});

		const res = await edit(memberId, corrected);

		expect(await personEmail(personId)).toBe(corrected);
		expect(res.personEmailSynced).toBe(true);
	});

	it("a corrected address makes sign-in linking resolve the membership", async () => {
		// The correction is only worth anything if it reaches the auth match key.
		const n = randomUUID();
		const corrected = `real-${n}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: `typo-${n}@test.example`,
			memberEmail: `typo-${n}@test.example`,
		});
		const userId = await seedUser(corrected);

		await edit(memberId, corrected);
		const { linkedPersonIds } = await linkPersonToUser(userId);

		expect(linkedPersonIds).toContain(personId);
		expect(await personUserId(personId)).toBe(userId);
	});

	it("clearing the membership email leaves the Person's intact", async () => {
		// Deliberately NOT symmetric with the preferred-name clear. Two reasons, both
		// demonstrated: `loadMemberProfile` binds the form to `members.email` raw, so
		// a Person-only address renders blank and an unrelated save submits null —
		// clearing here would make a name edit a permanent lockout. And a null
		// `people.email` is not fail-safe: it is exactly the state where
		// `claimPersonForUser` falls back to `members.email`, which any officer of
		// any of this Person's clubs controls.
		const existing = `keepme-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: existing,
			memberEmail: existing,
		});

		const res = await edit(memberId, null);

		expect(await personEmail(personId)).toBe(existing);
		expect(await memberEmail(memberId)).toBeNull();
		expect(res.personEmailSynced).toBeNull();
	});

	it("reports null when the Person already carries the address", async () => {
		// The third state. `null` and `false` are both falsy, so a caller that
		// collapses them warns on every no-op save; this pins them apart.
		const same = `same-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({
			personEmail: same,
			memberEmail: same,
		});

		const res = await edit(memberId, same);

		expect(res.personEmailSynced).toBeNull();
	});

	it("a case-only difference is not reported as a refusal", async () => {
		// Every identity reader normalises (`lower(...)` / `.trim().toLowerCase()`),
		// so a capitalisation edit changes nothing for any of them. Reporting it as
		// a refusal would fire a lockout warning on a routine save, and a false
		// alarm is how the real one gets ignored.
		const n = randomUUID();
		const verified = `case-${n}@test.example`;
		const userId = await seedUser(verified);
		const { memberId } = await seedMember({
			personEmail: verified,
			memberEmail: verified,
			personUserId: userId,
		});

		const res = await edit(memberId, `CASE-${n}@TEST.EXAMPLE`);

		expect(res.personEmailSynced).toBeNull();
	});

	it("does not re-report a refusal on a save that left the address alone", async () => {
		// A linked member can legitimately carry a work address on the membership
		// and a personal one on the Person, permanently. Reporting that divergence
		// on every unrelated save (a name fix, an officer checkbox) would keep the
		// alarm lit forever on a healthy row.
		const n = randomUUID();
		const work = `work-${n}@test.example`;
		const personal = `personal-${n}@test.example`;
		const userId = await seedUser(personal);
		const { memberId } = await seedMember({
			personEmail: personal,
			memberEmail: work,
			personUserId: userId,
		});

		const res = await edit(memberId, work);

		expect(res.personEmailSynced).toBeNull();
	});

	it("trims a padded address before it reaches either row", async () => {
		const addr = `pad-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({});

		await edit(memberId, `  ${addr}  `);

		expect(await personEmail(personId)).toBe(addr);
		expect(await memberEmail(memberId)).toBe(addr);
	});

	it("a case-only difference on the PERSON row is not reported as a refusal", async () => {
		// The mirror of the test above, and the one that pins the PERSON side of the
		// comparison. Every fixture here stores lowercase, so dropping
		// `.trim().toLowerCase()` from the person side survived a full-suite
		// mutation run — the normalisation was real behaviour held by nothing.
		// The Person is deliberately UNLINKED and single-club, so the guard would
		// ALLOW a write here. That is what makes this test able to fail: if the
		// comparison stops normalising, a case-only edit looks like a change and
		// churns the stored row. With an account holder the write is refused anyway
		// and the normalised report rescues it, so that fixture proves nothing.
		const n = randomUUID();
		const stored = `MIXED-${n}@TEST.EXAMPLE`;
		const { memberId, personId } = await seedMember({
			personEmail: stored,
			memberEmail: stored,
		});

		const res = await edit(memberId, `mixed-${n}@test.example`);

		expect(res.personEmailSynced).toBeNull();
		expect(await personEmail(personId)).toBe(stored);
	});

	it("a padded PERSON address is not reported as a divergence", async () => {
		// `.trim()` specifically: a legacy padded row must not read as a change.
		const addr = `padp-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({
			personEmail: `  ${addr}  `,
			memberEmail: addr,
		});

		expect((await edit(memberId, addr)).personEmailSynced).toBeNull();
	});

	it("a refusal on an UNLINKED Person is reported on every save, not just the first", async () => {
		// The lockout case. After the first corrective save `members.email` already
		// holds the new value, so a report keyed on "did this save move the roster
		// address" goes quiet from the second save onward — and re-opening the
		// record is exactly what an admin does when the first correction looks
		// ineffective. A shared Person is unlinked and stale: say so every time.
		const n = randomUUID();
		const stale = `stale-${n}@test.example`;
		const corrected = `corrected-${n}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: stale,
			memberEmail: stale,
		});
		await alsoInAnotherClub(personId, stale);

		expect((await edit(memberId, corrected)).personEmailSynced).toBe(false);
		// Same address again — the roster did not move this time.
		expect((await edit(memberId, corrected)).personEmailSynced).toBe(false);
	});

	it("records a refused reconciliation in the activity log", async () => {
		// The only durable record that the identity key was left stale. Without a
		// gate, the observability half of this change can be deleted with the whole
		// repo green, and the next lockout is un-diagnosable exactly as before.
		const shared = `shared-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: shared,
			memberEmail: shared,
		});
		await alsoInAnotherClub(personId, shared);

		await edit(memberId, `attacker-${randomUUID()}@test.example`);

		const [row] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "member_edit"),
				),
			);
		expect(
			(row?.detail as { personEmailSynced?: boolean | null })
				?.personEmailSynced,
		).toBe(false);
	});

	it("records a SUCCESSFUL reconciliation in the activity log as true", async () => {
		// The refusal case alone proves the field is PRESENT, not that it says
		// anything true: hard-coding it to `false` — an audit trail claiming every
		// member edit left someone locked out — survived a full-suite mutation run.
		const { memberId } = await seedMember({});

		await edit(memberId, `logged-${randomUUID()}@test.example`);

		expect(await loggedSync()).toBe(true);
	});

	it("records a no-op save in the activity log as null", async () => {
		const same = `same-${randomUUID()}@test.example`;
		const { memberId } = await seedMember({
			personEmail: same,
			memberEmail: same,
		});

		await edit(memberId, same);

		expect(await loggedSync()).toBeNull();
	});

	// ---- blast radius: what the guard refuses -------------------------------

	it("never moves the address of a Person who has an account", async () => {
		// Once someone has signed in, their address is one they PROVED they own via
		// magic link. No club admin may move it.
		const verified = `verified-${randomUUID()}@test.example`;
		const userId = await seedUser(verified);
		const { memberId, personId } = await seedMember({
			personEmail: verified,
			memberEmail: verified,
			personUserId: userId,
		});

		const res = await edit(memberId, `different-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBe(verified);
		expect(res.personEmailSynced).toBe(false);
	});

	it("never seeds an address onto an account holder whose Person email is null", async () => {
		// (people.email NULL, user_id SET) — reachable via people-merge-logic, which
		// reconciles `email` and `userId` independently. The old predicate let any
		// club admin write the auth-adjacent address of a signed-in human here.
		const userId = await seedUser(`acct-${randomUUID()}@test.example`);
		const { memberId, personId } = await seedMember({ personUserId: userId });

		const res = await edit(memberId, `set-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBeNull();
		expect(res.personEmailSynced).toBe(false);
	});

	it("one club cannot retarget a Person another club also holds", async () => {
		// The realistic shared shape: one human, two clubs, every row carrying the
		// same real address — which is what the importers and the seed arm produce.
		// A value comparison PASSES here, which is why the guard is not one.
		const shared = `shared-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: shared,
			memberEmail: shared,
		});
		await alsoInAnotherClub(personId, shared);

		const res = await edit(memberId, `attacker-${randomUUID()}@test.example`);

		expect(await personEmail(personId)).toBe(shared);
		expect(res.personEmailSynced).toBe(false);
	});

	it("two consecutive saves cannot retarget a shared Person either", async () => {
		// `current.email` is membership state the editing admin writes, so any guard
		// derived from it is defeated by saving twice: once to the address the
		// Person carries, then to one the attacker controls. The blast-radius guard
		// does not care how many times you save.
		const victim = `victim-${randomUUID()}@test.example`;
		const attacker = `attacker-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: victim,
			memberEmail: `ours-${randomUUID()}@test.example`,
		});
		await alsoInAnotherClub(personId, victim);

		await edit(memberId, victim);
		await edit(memberId, attacker);

		expect(await personEmail(personId)).toBe(victim);
	});

	it("a retarget attempt does not hand the attacker the other club's membership", async () => {
		// The consequence the guard exists to prevent, driven end to end: after the
		// refused retarget, the attacker's own sign-in must not bind the Person.
		const shared = `shared-${randomUUID()}@test.example`;
		const attacker = `attacker-${randomUUID()}@test.example`;
		const { memberId, personId } = await seedMember({
			personEmail: shared,
			memberEmail: shared,
		});
		await alsoInAnotherClub(personId, shared);
		const attackerUserId = await seedUser(attacker);

		await edit(memberId, attacker);
		const { linkedPersonIds } = await linkPersonToUser(attackerUserId);

		expect(linkedPersonIds).not.toContain(personId);
		expect(await personUserId(personId)).toBeNull();
	});

	it("leaves people.email null when the edit sets no email (null edit)", async () => {
		const { memberId, personId } = await seedMember({});

		await edit(memberId, null);

		expect(await personEmail(personId)).toBeNull();
		expect(await memberEmail(memberId)).toBeNull();
	});
});
