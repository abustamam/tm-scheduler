/**
 * DB-backed tests for the superadmin's permanent club delete (#914):
 * `deleteClubPermanently` removes an ARCHIVED club, everything that cascades
 * from it, every Person it held that no other club holds, and each such
 * Person's sign-in account unless something else still needs that account.
 *
 * `#/db` is redirected to the test database through a thin wrapper whose only
 * job is to let one case force the user delete to throw inside the real
 * transaction, which is how the no-partial-delete claim is executed rather
 * than asserted.
 *
 * Every row here carries a per-run suffix and is deleted by id afterwards:
 * vitest runs files in parallel against one shared database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/delete-club-permanently.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubLogos,
	clubs,
	guests,
	meetings,
	meetingTemplates,
	meetingVoteSessions,
	meetingVotes,
	members,
	oauthClient,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	peopleEmailBackup,
	roleDefinitions,
	roleSlots,
	session,
	speeches,
	syncTokens,
	user,
	verification,
} from "#/db/schema";
import { hasTestDb, openBlockingTx, testDb, waitForLockWait } from "#/test/db";

const flags = vi.hoisted(() => ({
	failUserDelete: false,
	/** Runs right after `DELETE FROM clubs` resolves, inside the delete's
	 *  transaction — the window between the cascade and the Person lock. */
	afterClubDelete: null as null | (() => Promise<void>),
}));

vi.mock("#/db", async () => {
	const { testDb } = await import("#/test/db");
	const schema = await import("#/db/schema");
	function bindAll<T extends object>(
		target: T,
		override: (k: PropertyKey) => unknown,
	) {
		return new Proxy(target, {
			get(t, k, r) {
				const o = override(k);
				if (o !== undefined) return o;
				const v = Reflect.get(t, k, r);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
	}
	type Tx = Parameters<Parameters<typeof testDb.transaction>[0]>[0];
	// Every transaction handle, savepoints included, gets the same `delete`.
	function wrapTx(tx: Tx): Tx {
		return bindAll(tx, (k) => {
			if (k === "delete")
				return (table: typeof schema.user) => {
					if (flags.failUserDelete && table === schema.user) {
						throw new Error("forced user delete failure");
					}
					const builder = tx.delete(table);
					const hook = flags.afterClubDelete;
					if (!hook || (table as unknown) !== schema.clubs) return builder;
					// `.where(…)` is awaited directly; hand back a thenable that runs
					// the real statement, then the hook, then resolves.
					return bindAll(builder, (kk) =>
						kk === "where"
							? (...args: Parameters<typeof builder.where>) => {
									const q = builder.where(...args);
									return {
										// biome-ignore lint/suspicious/noThenProperty: a thenable is the point
										then: (
											res: (v: unknown) => unknown,
											rej: (e: unknown) => unknown,
										) =>
											q
												.then(async (v) => {
													await hook();
													return v;
												})
												.then(res, rej),
									};
								}
							: undefined,
					);
				};
			if (k === "transaction")
				return (fn: (sp: Tx) => Promise<unknown>) =>
					tx.transaction((sp) => fn(wrapTx(sp)));
			return undefined;
		});
	}
	const db = bindAll(testDb, (k) =>
		k === "transaction"
			? (fn: (tx: Tx) => Promise<unknown>) =>
					testDb.transaction((tx) => fn(wrapTx(tx)))
			: undefined,
	);
	return { db };
});

const { requireSuperadmin } = await import("#/server/guards");
const { deleteClubPermanently } = await import("./onboarding-logic");
const { applyMemberRemove } = await import("./members-logic");

const created = {
	clubs: [] as string[],
	people: [] as string[],
	users: [] as string[],
	paths: [] as string[],
	verifications: [] as string[],
	oauthClients: [] as string[],
};

async function teardown() {
	flags.failUserDelete = false;
	flags.afterClubDelete = null;
	if (created.verifications.length)
		await testDb
			.delete(verification)
			.where(inArray(verification.id, created.verifications));
	if (created.oauthClients.length)
		await testDb
			.delete(oauthClient)
			.where(inArray(oauthClient.id, created.oauthClients));
	if (created.clubs.length)
		await testDb.delete(clubs).where(inArray(clubs.id, created.clubs));
	if (created.people.length) {
		await testDb
			.delete(peopleEmailBackup)
			.where(inArray(peopleEmailBackup.personId, created.people));
		await testDb.delete(people).where(inArray(people.id, created.people));
	}
	if (created.users.length)
		await testDb.delete(user).where(inArray(user.id, created.users));
	if (created.paths.length)
		await testDb
			.delete(pathwaysPaths)
			.where(inArray(pathwaysPaths.id, created.paths));
	for (const k of Object.keys(created) as (keyof typeof created)[])
		created[k].length = 0;
}

async function makeClub(name: string, archived: boolean) {
	const id = randomUUID();
	await testDb.insert(clubs).values({
		id,
		name,
		slug: `del-914-${id}`,
		archivedAt: archived ? new Date() : null,
	});
	created.clubs.push(id);
	return id;
}

async function makeUser(opts?: { superadmin?: boolean }) {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "U",
		email: `u-${id}@test.example`,
		emailVerified: true,
		isSuperadmin: opts?.superadmin ?? false,
	});
	created.users.push(id);
	return id;
}

async function makePerson(userId: string | null, email?: string) {
	const [row] = await testDb
		.insert(people)
		.values({ name: "P", userId, email: email ?? null })
		.returning({ id: people.id });
	if (!row) throw new Error("person");
	created.people.push(row.id);
	return row.id;
}

async function join(clubId: string, personId: string) {
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name: "M",
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member");
	return row.id;
}

async function exists(table: "clubs" | "people" | "user", id: string) {
	const t = { clubs, people, user }[table];
	const rows = await testDb
		.select({ id: t.id })
		.from(t)
		.where(eq(t.id, id as never));
	return rows.length === 1;
}

/** Every column in the schema that stores a club id, read off the catalog so a
 *  new club-scoped table is covered without editing this file. */
async function rowsReferencingClub(clubId: string) {
	const cols = await testDb.execute<{
		table_name: string;
		column_name: string;
	}>(
		sql`select table_name, column_name from information_schema.columns
		    where table_schema = 'public' and column_name in ('club_id', 'credited_club_id')`,
	);
	const hits: string[] = [];
	for (const c of cols.rows) {
		const r = await testDb.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(c.table_name)} where ${sql.identifier(c.column_name)} = ${clubId}`,
		);
		if ((r.rows[0]?.n ?? 0) > 0) hits.push(`${c.table_name}.${c.column_name}`);
	}
	return { hits, columns: cols.rows.length };
}

describe.skipIf(!hasTestDb)("deleteClubPermanently (#914)", () => {
	afterEach(teardown);

	/** Club A (archived) with P1 (only in A, signed in), P2 (also in club B), a
	 *  guest, a meeting with a slot and a vote, a club template and a logo. */
	async function fixture() {
		const suffix = randomUUID().slice(0, 8);
		const nameA = `Club A ${suffix}`;
		const a = await makeClub(nameA, true);
		const b = await makeClub(`Club B ${suffix}`, false);

		const u1 = await makeUser();
		const u2 = await makeUser();
		const p1 = await makePerson(u1, `p1-${suffix}@test.example`);
		const p2 = await makePerson(u2);
		const m1 = await join(a, p1);
		await join(a, p2);
		const m2b = await join(b, p2);

		await testDb.insert(peopleEmailBackup).values({
			personId: p1,
			email: `p1-${suffix}@test.example`,
		});
		await testDb.insert(session).values({
			id: randomUUID(),
			token: randomUUID(),
			userId: u1,
			expiresAt: new Date(Date.now() + 86_400_000),
			updatedAt: new Date(),
		});
		await testDb
			.insert(apiTokens)
			.values({ userId: u1, tokenHash: `h-${randomUUID()}` });

		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: `914-${suffix}`, name: "Path" })
			.returning({ id: pathwaysPaths.id });
		if (!path) throw new Error("path");
		created.paths.push(path.id);
		await testDb.insert(pathEnrollments).values([
			{ personId: p1, pathId: path.id },
			{ personId: p2, pathId: path.id },
		]);
		await testDb.insert(speeches).values([
			{ personId: p1, title: "P1 speech" },
			{ personId: p2, title: "P2 speech" },
		]);

		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: a, name: "Guest", email: `g-${suffix}@test.example` })
			.returning({ id: guests.id });
		await testDb
			.insert(meetingTemplates)
			.values({ clubId: a, key: `k-${suffix}`, name: "Club template" });
		const [meeting] = await testDb
			.insert(meetings)
			.values({ clubId: a, scheduledAt: new Date(), status: "scheduled" })
			.returning({ id: meetings.id });
		const [role] = await testDb
			.insert(roleDefinitions)
			.values({ clubId: a, name: "Timer", category: "functionary" })
			.returning({ id: roleDefinitions.id });
		if (!meeting || !role || !guest) throw new Error("fixture");
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: meeting.id,
				roleDefinitionId: role.id,
				assignedMemberId: m1,
				status: "claimed",
			})
			.returning({ id: roleSlots.id });
		const [vs] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: meeting.id, category: "best_speaker" })
			.returning({ id: meetingVoteSessions.id });
		if (!slot || !vs) throw new Error("fixture");
		await testDb.insert(meetingVotes).values({
			sessionId: vs.id,
			voterGuestId: guest.id,
			candidateMemberId: m1,
		});
		await testDb.insert(clubLogos).values({
			clubId: a,
			bytes: Buffer.from([1, 2, 3]),
			mime: "image/png",
			updatedAt: new Date(),
			attestedBy: u1,
			attestedAt: new Date(),
		});

		return {
			a,
			b,
			nameA,
			u1,
			u2,
			p1,
			p2,
			m2b,
			meetingId: meeting.id,
			slotId: slot.id,
			voteSessionId: vs.id,
		};
	}

	it("deletes the club, its sole-club people and their accounts; a member of another club keeps everything", async () => {
		const f = await fixture();

		const res = await deleteClubPermanently(f.a, `  ${f.nameA}  `);
		expect(res).toEqual({
			clubName: f.nameA,
			peopleDeleted: 1,
			peopleKept: 1,
			usersDeleted: 1,
			usersKept: 0,
		});

		// Nothing anywhere still names club A.
		const { hits, columns } = await rowsReferencingClub(f.a);
		expect(columns).toBeGreaterThan(10);
		expect(hits).toEqual([]);
		expect(
			await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, f.slotId)),
		).toHaveLength(0);
		expect(
			await testDb
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.where(eq(meetingVotes.sessionId, f.voteSessionId)),
		).toHaveLength(0);

		// P1 and everything of theirs is gone.
		expect(await exists("people", f.p1)).toBe(false);
		expect(await exists("user", f.u1)).toBe(false);
		for (const [t, col] of [
			[speeches, speeches.personId],
			[pathEnrollments, pathEnrollments.personId],
			[peopleEmailBackup, peopleEmailBackup.personId],
		] as const) {
			expect(await testDb.select().from(t).where(eq(col, f.p1))).toHaveLength(
				0,
			);
		}
		expect(
			await testDb.select().from(session).where(eq(session.userId, f.u1)),
		).toHaveLength(0);
		expect(
			await testDb.select().from(apiTokens).where(eq(apiTokens.userId, f.u1)),
		).toHaveLength(0);

		// P2 keeps their Person, account, Pathways and speeches; B is untouched.
		expect(await exists("people", f.p2)).toBe(true);
		expect(await exists("user", f.u2)).toBe(true);
		expect(
			await testDb.select().from(speeches).where(eq(speeches.personId, f.p2)),
		).toHaveLength(1);
		expect(
			await testDb
				.select()
				.from(pathEnrollments)
				.where(eq(pathEnrollments.personId, f.p2)),
		).toHaveLength(1);
		expect(await exists("clubs", f.b)).toBe(true);
		expect(
			await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, f.b)),
		).toEqual([{ id: f.m2b }]);
	});

	describe("refuses and writes nothing", () => {
		async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
			expect(await exists("clubs", f.a)).toBe(true);
			expect(await exists("people", f.p1)).toBe(true);
			expect(await exists("user", f.u1)).toBe(true);
			expect(
				await testDb
					.select({ id: members.id })
					.from(members)
					.where(eq(members.clubId, f.a)),
			).toHaveLength(2);
		}

		it("when the club is not archived", async () => {
			const f = await fixture();
			await testDb
				.update(clubs)
				.set({ archivedAt: null })
				.where(eq(clubs.id, f.a));
			await expect(deleteClubPermanently(f.a, f.nameA)).rejects.toThrow(
				"Archive the club first.",
			);
			await unchanged(f);
		});

		it("when the name does not match, including by case alone", async () => {
			const f = await fixture();
			for (const wrong of [
				"Club A",
				f.nameA.toUpperCase(),
				f.nameA.toLowerCase(),
				"",
			]) {
				await expect(deleteClubPermanently(f.a, wrong)).rejects.toThrow(
					"The name doesn't match.",
				);
			}
			await unchanged(f);
		});

		it("when the club does not exist", async () => {
			await expect(
				deleteClubPermanently(randomUUID(), "Anything"),
			).rejects.toThrow("Club not found.");
		});
	});

	// `deleteClubPermanently` trusts its caller; the refusal of a non-superadmin
	// lives in the server fn, which vitest cannot invoke. What pins it there is
	// the static guard in `write-proof.guard.test.ts` ("deleteConsoleClub is
	// superadmin-only"): `requireUser()` then `requireSuperadmin(currentUser.id)`,
	// in that order, before the delete. This case only proves the gate itself
	// refuses a non-superadmin — it does not exercise the delete path.
	it("requireSuperadmin, the gate deleteConsoleClub runs first, refuses a non-superadmin", async () => {
		const normal = await makeUser();
		await expect(requireSuperadmin(normal)).rejects.toThrow(/permission/i);
		const admin = await makeUser({ superadmin: true });
		await expect(requireSuperadmin(admin)).resolves.toBeUndefined();
	});

	it("keeps an account another club's sync token or logo names, or another Person links to, and counts it", async () => {
		const suffix = randomUUID().slice(0, 8);
		const nameA = `Club A ${suffix}`;
		const a = await makeClub(nameA, true);
		const b = await makeClub(`Club B ${suffix}`, false);
		const c = await makeClub(`Club C ${suffix}`, false);

		const uToken = await makeUser();
		const uLogo = await makeUser();
		const uLinked = await makeUser();
		const uGone = await makeUser();
		const pToken = await makePerson(uToken);
		const pLogo = await makePerson(uLogo);
		const pLinked = await makePerson(uLinked);
		const pGone = await makePerson(uGone);
		for (const p of [pToken, pLogo, pLinked, pGone]) await join(a, p);
		// A second Person bound to the same account, in another club.
		const pLinkedElsewhere = await makePerson(uLinked);
		await join(b, pLinkedElsewhere);

		await testDb
			.insert(syncTokens)
			.values({ clubId: b, tokenHash: `h-${randomUUID()}`, createdBy: uToken });
		await testDb.insert(clubLogos).values({
			clubId: c,
			bytes: Buffer.from([1]),
			mime: "image/png",
			updatedAt: new Date(),
			attestedBy: uLogo,
			attestedAt: new Date(),
		});

		const res = await deleteClubPermanently(a, nameA);
		expect(res).toEqual({
			clubName: nameA,
			peopleDeleted: 4,
			peopleKept: 0,
			usersDeleted: 1,
			usersKept: 3,
		});
		for (const p of [pToken, pLogo, pLinked, pGone])
			expect(await exists("people", p)).toBe(false);
		expect(await exists("people", pLinkedElsewhere)).toBe(true);
		expect(await exists("user", uToken)).toBe(true);
		expect(await exists("user", uLogo)).toBe(true);
		expect(await exists("user", uLinked)).toBe(true);
		expect(await exists("user", uGone)).toBe(false);
	});

	it("never deletes a superadmin's account, even when the club was their only one", async () => {
		const nameA = `Club A ${randomUUID().slice(0, 8)}`;
		const a = await makeClub(nameA, true);
		const uSuper = await makeUser({ superadmin: true });
		const pSuper = await makePerson(uSuper);
		await join(a, pSuper);

		const res = await deleteClubPermanently(a, nameA);
		expect(res.peopleDeleted).toBe(1);
		expect(res.usersDeleted).toBe(0);
		expect(res.usersKept).toBe(1);
		expect(await exists("user", uSuper)).toBe(true);
	});

	it("rolls the whole delete back when a step after the cascade fails", async () => {
		const f = await fixture();
		flags.failUserDelete = true;
		await expect(deleteClubPermanently(f.a, f.nameA)).rejects.toThrow(
			"forced user delete failure",
		);
		flags.failUserDelete = false;

		expect(await exists("clubs", f.a)).toBe(true);
		expect(await exists("people", f.p1)).toBe(true);
		expect(await exists("user", f.u1)).toBe(true);
		expect(
			await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, f.a)),
		).toHaveLength(2);
		expect(
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.id, f.meetingId)),
		).toHaveLength(1);
		expect(
			await testDb
				.select()
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, f.p1)),
		).toHaveLength(1);
	});

	it("keeps a Person whose other membership is being added while the delete runs", async () => {
		// A real race, not a sequence. Right after the cascade, a second club adds
		// this Person and holds its transaction OPEN. The insert takes a key-share
		// lock on the Person, so the delete must block on its `FOR UPDATE` and,
		// once the membership commits, see it and keep the Person.
		//
		// Without the lock (or with the membership check moved ahead of it) the
		// delete reads "no membership", then its `DELETE FROM people` waits for
		// the insert, and — members.person_id being ON DELETE CASCADE — deletes
		// the Person AND the membership that just committed. `waitForLockWait`
		// proves the delete really was parked behind this writer, so the test
		// cannot pass on an uncontended path.
		const suffix = randomUUID().slice(0, 8);
		const nameA = `Club A ${suffix}`;
		const a = await makeClub(nameA, true);
		const b = await makeClub(`Club B ${suffix}`, false);
		const u = await makeUser();
		const p = await makePerson(u);
		await join(a, p);

		let writer!: { commit: () => Promise<void>; pid: number };
		let writerOpen!: () => void;
		const opened = new Promise<void>((r) => {
			writerOpen = r;
		});
		flags.afterClubDelete = async () => {
			flags.afterClubDelete = null;
			writer = await openBlockingTx(async (tx) => {
				await tx.insert(members).values({
					clubId: b,
					personId: p,
					name: "M",
					clubRole: "member",
					status: "active",
				});
			});
			writerOpen();
		};

		const deleting = deleteClubPermanently(a, nameA);
		deleting.catch(() => {});
		await opened;
		await waitForLockWait("people", writer.pid);
		await writer.commit();
		const out = await deleting;

		expect(out.peopleDeleted).toBe(0);
		expect(out.peopleKept).toBe(1);
		expect(await exists("people", p)).toBe(true);
		expect(await exists("user", u)).toBe(true);
		expect(
			await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.personId, p)),
		).toHaveLength(1);
		expect(await exists("clubs", a)).toBe(false);
	});

	describe("former members (removed before the club was deleted)", () => {
		async function removedMember() {
			const suffix = randomUUID().slice(0, 8);
			const nameA = `Club A ${suffix}`;
			const a = await makeClub(nameA, false);
			const p = await makePerson(null, `gone-${suffix}@test.example`);
			const m = await join(a, p);
			await testDb.insert(speeches).values({ personId: p, title: "Old talk" });
			await testDb
				.insert(peopleEmailBackup)
				.values({ personId: p, email: `gone-${suffix}@test.example` });
			// The real removal, so the log row has the shape production writes.
			await applyMemberRemove({ clubId: a, memberId: m, actorMemberId: null });
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, a));
			return { a, nameA, p, suffix };
		}

		it("deletes a removed member who holds no membership anywhere", async () => {
			const { a, nameA, p } = await removedMember();
			const res = await deleteClubPermanently(a, nameA);
			expect(res.peopleDeleted).toBe(1);
			expect(await exists("people", p)).toBe(false);
			expect(
				await testDb.select().from(speeches).where(eq(speeches.personId, p)),
			).toHaveLength(0);
			expect(
				await testDb
					.select()
					.from(peopleEmailBackup)
					.where(eq(peopleEmailBackup.personId, p)),
			).toHaveLength(0);
		});

		it("keeps a removed member who has since joined another club", async () => {
			const { a, nameA, p, suffix } = await removedMember();
			const b = await makeClub(`Club B ${suffix}`, false);
			await join(b, p);
			const res = await deleteClubPermanently(a, nameA);
			expect(res.peopleDeleted).toBe(0);
			expect(res.peopleKept).toBe(1);
			expect(await exists("people", p)).toBe(true);
		});

		it("skips a malformed personId in the log instead of aborting", async () => {
			const { a, nameA, p } = await removedMember();
			await testDb.execute(
				sql`insert into activity_log (club_id, action, target_type, detail) values
				  (${a}, 'member_remove', 'member', ${JSON.stringify({ personId: "not-a-uuid" })}::jsonb),
				  (${a}, 'member_remove', 'member', ${JSON.stringify({ personId: 42 })}::jsonb),
				  (${a}, 'member_remove', 'member', null)`,
			);
			const res = await deleteClubPermanently(a, nameA);
			expect(res.peopleDeleted).toBe(1);
			expect(await exists("people", p)).toBe(false);
		});

		it("deletes a Person whose only link left is Pathways progress credited here", async () => {
			const suffix = randomUUID().slice(0, 8);
			const nameA = `Club A ${suffix}`;
			const a = await makeClub(nameA, true);
			const p = await makePerson(null);
			const [path] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: `914c-${suffix}`, name: "Path" })
				.returning({ id: pathwaysPaths.id });
			if (!path) throw new Error("path");
			created.paths.push(path.id);
			const [enr] = await testDb
				.insert(pathEnrollments)
				.values({ personId: p, pathId: path.id })
				.returning({ id: pathEnrollments.id });
			if (!enr) throw new Error("enrollment");
			await testDb.insert(pathLevelProgress).values({
				enrollmentId: enr.id,
				level: 1,
				completed: 1,
				total: 3,
				approved: true,
				creditedClubId: a,
			});
			const res = await deleteClubPermanently(a, nameA);
			expect(res.peopleDeleted).toBe(1);
			expect(await exists("people", p)).toBe(false);
		});
	});

	it("deletes a deleted account's pending magic links, and leaves a kept account's alone", async () => {
		const suffix = randomUUID().slice(0, 8);
		const nameA = `Club A ${suffix}`;
		const a = await makeClub(nameA, true);
		const uGone = await makeUser();
		const uKept = await makeUser({ superadmin: true });
		await join(a, await makePerson(uGone));
		await join(a, await makePerson(uKept));
		const [gone] = await testDb
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, uGone));
		const [kept] = await testDb
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, uKept));
		if (!gone || !kept) throw new Error("users");

		// The shape better-auth's magic-link plugin writes: a token identifier and
		// `JSON.stringify({ email, name })` as the value — the case the person
		// typed, not necessarily the account's.
		const link = (email: string) => ({
			id: randomUUID(),
			identifier: randomUUID(),
			value: JSON.stringify({ email, name: "Typed name" }),
			expiresAt: new Date(Date.now() + 300_000),
		});
		const goneLink = link(gone.email.toUpperCase());
		const keptLink = link(kept.email);
		// A value that merely CONTAINS the address, and one Postgres could not
		// read as JSON at all, must not break or widen the match.
		const lookalike = {
			...link(`x${gone.email}`),
		};
		const nul = {
			...link(gone.email),
			value: `{"email":"${gone.email}","name":"\\u0000"}`,
		};
		const rows = [goneLink, keptLink, lookalike, nul];
		await testDb.insert(verification).values(rows);
		created.verifications.push(...rows.map((r) => r.id));

		const res = await deleteClubPermanently(a, nameA);
		expect(res.usersDeleted).toBe(1);
		const left = await testDb
			.select({ id: verification.id })
			.from(verification)
			.where(inArray(verification.id, created.verifications));
		expect(left.map((r) => r.id).sort()).toEqual(
			[keptLink.id, lookalike.id].sort(),
		);
	});

	it("keeps an account that owns an OAuth client, and counts it", async () => {
		const nameA = `Club A ${randomUUID().slice(0, 8)}`;
		const a = await makeClub(nameA, true);
		const u = await makeUser();
		await join(a, await makePerson(u));
		const clientRowId = randomUUID();
		await testDb.insert(oauthClient).values({
			id: clientRowId,
			clientId: `client-${clientRowId}`,
			redirectUris: ["https://example.test/cb"],
			userId: u,
		});
		created.oauthClients.push(clientRowId);

		const res = await deleteClubPermanently(a, nameA);
		expect(res.peopleDeleted).toBe(1);
		expect(res.usersDeleted).toBe(0);
		expect(res.usersKept).toBe(1);
		expect(await exists("user", u)).toBe(true);
	});
});
