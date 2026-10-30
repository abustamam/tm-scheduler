/**
 * DB-backed integration tests for `declinePlannedAttendance` (#663) — the seam
 * `setPlannedAttendance` reaches when the rung it is asked to write is
 * `not_coming`.
 *
 * Three gates decide whether the roles are actually freed, and they are asserted
 * separately because they fail in different directions:
 *
 * 1. `releaseHeldRoles` — the caller opted in. The DEPLOY-WINDOW gate: this
 *    endpoint's URL, method and payload shape did not change with #663, and
 *    `public/sw.js` claims open tabs without reloading them, so without this a
 *    pre-#663 client would send its usual request and get a destructive release
 *    with no dialog and no toast. The first block below is that regression test,
 *    and it is the one that matters most: everything after it passes `true`.
 * 2. The ARM. A product ceiling, NOT a security boundary — see the seam's
 *    header. The boundary is the third gate, added by #762.
 * 2b. The PROOF (#762, ADR-0026). Freeing roles needs a session bound to a
 *    member of this club, whichever arm admitted the caller, so every case
 *    below that releases now signs someone in. The case that used to be
 *    marked THE RESIDUAL executed the hole and asserted it was open; it now
 *    asserts the refusal, and the arm cases beside it keep their own meaning
 *    only because their callers have sessions — an anonymous fixture there
 *    would pass with `mayRelease` deleted.
 * 3. The meeting window. `assertMeetingNotLocked` is `status === "completed"`
 *    only, and clubs routinely never press Complete.
 *
 * The officer/self and TMOD-on-someone-else outcomes differ ONLY in
 * `role_slots` — the plan row is identical and the `plan_set` row differs only
 * in `grantedVia` — so a suite that asserted the rung would pass with the arm
 * gate inverted, deleted, or with the release dropped entirely, which is the
 * state the rail shipped in.
 *
 * A `createServerFn` handler cannot be invoked in vitest, which is why all of
 * this lives in a seam (CODING_STANDARDS.md, "WRITES are closed too"). What the
 * handler contributes — that it reaches this seam for `not_coming` and not for
 * the other two rungs, that it forwards the flag rather than hard-coding it, and
 * that the zod default is `false` — is pinned by
 * `attendance-decline-wiring.guard.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/attendance-decline.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetingAttendancePlan,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	slotCoverRequests,
	speeches,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The officer arm reads the SESSION off the current request, which vitest has
 * none of — `getSessionUser` catches the missing context and returns null, so
 * without these two mocks every case here would silently be an anonymous one and
 * the officer test would prove nothing. Mocked at the LIBRARY boundary, so
 * `requireClubRole` / `requireMembership` stay real and run against real rows;
 * what is faked is only the cookie → session lookup a test process cannot have.
 */
let sessionUserId: string | null = null;
/** One stable object, because the impersonation marker is keyed on identity. */
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { declinePlannedAttendance, RELEASE_AFTER_MEETING_MESSAGE } =
	await import("./attendance-decline-logic");
const { SELF_ONLY_MESSAGE } = await import("./attendance-actor-logic");

async function planRows(memberId: string, meetingId: string) {
	return testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, meetingId),
			),
		);
}

async function planSetLogs(meetingId: string) {
	return testDb
		.select({
			actorMemberId: activityLog.actorMemberId,
			detail: activityLog.detail,
		})
		.from(activityLog)
		.where(
			and(
				eq(activityLog.targetId, meetingId),
				eq(activityLog.action, "plan_set"),
			),
		)
		.orderBy(activityLog.createdAt);
}

async function releaseLogs(slotIds: string[]) {
	const rows = await testDb
		.select({ targetId: activityLog.targetId, detail: activityLog.detail })
		.from(activityLog)
		.where(eq(activityLog.action, "release"));
	// SCOPED to the slots this run created: `activity_log` is shared and vitest
	// runs test files in parallel against one `tm_test`, so an unscoped count is
	// order-dependent by construction.
	return rows.filter((r) => r.targetId && slotIds.includes(r.targetId));
}

/** An extra ACTIVE roster member. Every membership needs a Person (ADR-0008 /
 *  #64); `cleanup` cascades both from the club. */
async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");
	return m.id;
}

/**
 * A roster member who can also SIGN IN — a Person carrying `user_id`, plus the
 * `user` row behind it.
 *
 * `addRosterMember` above deliberately makes neither, and since #762 that is
 * the difference between a caller who may free roles and one who may not. The
 * arms that used to be reachable anonymously (self, TMOD) still exist and still
 * differ from each other; what changed is that reaching them for a DESTRUCTIVE
 * write needs a session. A test that wants to prove the ARM still behaves as it
 * did therefore needs a member with a user behind them, or it proves only that
 * the new gate fires.
 *
 * The caller must pass the returned `userId` to `cleanup`: `user` rows are
 * referenced across clubs, so the club cascade does not take them.
 */
async function addSignedInMember(
	clubId: string,
	name: string,
): Promise<{ memberId: string; userId: string }> {
	const userId = randomUUID();
	const email = `${userId}@test.example`;
	await testDb
		.insert(user)
		.values({ id: userId, name, email, emailVerified: true });
	const personId = await seedPerson({ name, email, userId });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("Failed to insert member");
	return { memberId: m.id, userId };
}

/** A second slot on the seeded meeting, held by `memberId`. Returns its id. */
async function addHeldSlot(
	club: SeededClub,
	memberId: string,
	roleName: string,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: roleName,
			key: null,
			category: "leadership",
			isSpeakerRole: false,
			sortOrder: 2,
		})
		.returning({ id: roleDefinitions.id });
	if (!def) throw new Error("Failed to insert role definition");
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: "claimed",
			assignedMemberId: memberId,
			claimedAt: new Date(),
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("Failed to insert role slot");
	return slot.id;
}

/** Give the meeting a canonically-named Toastmaster of the Day slot held by
 *  `memberId` — the shape `findTmodSlot`'s name fallback has to keep resolving. */
async function addTmodSlot(
	club: SeededClub,
	memberId: string,
): Promise<string> {
	return addHeldSlot(club, memberId, "Toastmaster of the Day");
}

describe.skipIf(!hasTestDb)("declinePlannedAttendance (#663)", () => {
	let seed: SeededClub;
	/** A second ACTIVE roster member of the same club, holding no office. */
	let otherMemberId: string;
	/** `user` rows a case created itself. They are referenced across clubs, so
	 *  the club cascade does not take them — `cleanup` needs them by id or the
	 *  next run of this file inherits them. */
	let extraUserIds: string[];

	beforeEach(async () => {
		seed = await seedClub();
		sessionUserId = null;
		extraUserIds = [];
		otherMemberId = await addRosterMember(seed.clubId, "Someone Else");
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [
			seed.adminUserId,
			seed.memberUserId,
			...extraUserIds,
		]);
	});

	/** Put the subject on the seeded slot, so a write that is wrongly admitted is
	 *  VISIBLE as a released slot rather than only as a plan row. */
	async function holdSeededSlot(memberId = seed.memberId) {
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, seed.slotId));
	}

	async function seededSlot() {
		const [slot] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				claimedAt: roleSlots.claimedAt,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId))
			.limit(1);
		return slot;
	}

	describe("the releaseHeldRoles opt-in (the deploy-window gate)", () => {
		it("frees NOTHING when the caller did not ask, even on the officer arm", async () => {
			// THE regression test for the stale-tab hazard. A client from before
			// #663 sends this exact payload — same URL, same method, same fields —
			// from a bundle with no confirm dialog in it, and push-to-main
			// auto-deploys while the service worker claims open tabs without
			// reloading them. The old behaviour is the ONLY safe answer here, and
			// the arm is deliberately the most permissive one so this cannot pass by
			// being rejected for some other reason.
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			});
			expect(released).toBe(0);

			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);

			// The RUNG still lands — that is what the old client came for, and
			// refusing it would break the stale tab in the other direction.
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
		});

		it("records the rung on a meeting that already happened, when nothing is being freed", async () => {
			// The other half of "do not newly break the old client". The release is
			// refused after the meeting (below), but a plain rung write on a past
			// meeting is harmless and is exactly what a stale tab does.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
				.where(eq(meetings.id, seed.meetingId));

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: false,
				}),
			).resolves.toMatchObject({ released: 0 });
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
		});
	});

	describe("the officer arm", () => {
		it("frees EVERY role the member holds, and records the decline", async () => {
			await holdSeededSlot();
			const secondSlotId = await addHeldSlot(seed, seed.memberId, "Timer 2");
			sessionUserId = seed.adminUserId;

			const result = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(result.released).toBe(2);

			// BOTH slots, not just the first: the rail's own role badge shows one
			// role per member, so a release that stopped after one would look right
			// on the surface the officer is reading.
			const slotRows = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					claimedAt: roleSlots.claimedAt,
				})
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, seed.meetingId));
			expect(slotRows).toHaveLength(2);
			for (const slot of slotRows) {
				expect(slot.status).toBe("open");
				expect(slot.assignedMemberId).toBeNull();
				// `claimed_at` too: left set, the slot reads as claimed to anything
				// that sorts or reports on it while being open.
				expect(slot.claimedAt).toBeNull();
			}

			const rows = await planRows(seed.memberId, seed.meetingId);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("not_coming");

			// ONE plan_set and one release PER SLOT, attributed to the officer.
			const setLogs = await planSetLogs(seed.meetingId);
			expect(setLogs).toHaveLength(1);
			expect(setLogs[0]?.actorMemberId).toBe(seed.adminMemberId);
			expect(setLogs[0]?.detail).toMatchObject({
				memberId: seed.memberId,
				status: "not_coming",
				grantedVia: "officer",
			});
			const rels = await releaseLogs([seed.slotId, secondSlotId]);
			expect(rels).toHaveLength(2);
			expect(rels[0]?.detail).toMatchObject({ fromMemberId: seed.memberId });
		});

		it("carries `via` into the activity detail on the RELEASING branch", async () => {
			// The destructive branch must not record LESS provenance than the
			// harmless one. It used to drop `via` on the floor, so every release
			// read `manual` in the feed however it was triggered — on the one branch
			// whose audit trail is the only record that survives it.
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;
			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
				via: "nudge",
			});
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				via: "nudge",
			});
		});

		it("keeps the SPEECH row, only unlinking it (ADR-0009)", async () => {
			// The speech is the member's own record of a talk they prepared; the
			// slot going back to the open pool must not delete it. Deleting it would
			// pass every assertion above. It matters more than it looks: re-claiming
			// the slot runs `attachSpeechToSlot`, which INSERTs, so a deleted speech
			// is unrecoverable and a kept one is at least reattachable by hand.
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: seed.personId, title: "My Icebreaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to insert speech");
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.memberId,
					status: "claimed",
					claimedAt: new Date(),
					speechId: speech.id,
				})
				.where(eq(roleSlots.id, seed.slotId));
			sessionUserId = seed.adminUserId;

			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

			expect((await seededSlot())?.speechId).toBeNull();
			const kept = await testDb
				.select({ title: speeches.title })
				.from(speeches)
				.where(eq(speeches.id, speech.id));
			expect(kept).toHaveLength(1);
			expect(kept[0]?.title).toBe("My Icebreaker");
		});
	});

	describe("the self arm", () => {
		it("frees the member's own roles when they answer for themselves", async () => {
			// SIGNED IN since #762: the arm is the same one, and the release is the
			// same release, but freeing roles needs a session bound to a member of
			// this club. `seed.memberUserId` is the user behind `seed.memberId`.
			await holdSeededSlot();
			sessionUserId = seed.memberUserId;
			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(released).toBe(1);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			// BOTH halves of the provenance: which arm admitted it, and how the
			// identity behind it was established. They answer different questions
			// and #762 is the reason the second one exists.
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "self",
				proof: "session",
			});
		});

		it("records the rung with nothing to free when the member holds no role", async () => {
			sessionUserId = seed.memberUserId;
			const { released, changed } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(released).toBe(0);
			expect(changed).toBe(true);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);
		});

		it("REJECTS another member asserting themselves as the actor", async () => {
			await holdSeededSlot();
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(SELF_ONLY_MESSAGE);

			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});

		it("REFUSES an anonymous caller who asserts NOTHING — the closed residual (#699)", async () => {
			// This case used to assert the opposite, and it was RIGHT to: #663 could
			// not close the hole and a comment claiming otherwise would have been a
			// lie. What it executed was the cheapest forgery the product had. With
			// no session and no claim, `resolveActor`'s last arm resolves the caller
			// TO the subject and returned `via: "self"` — a releasing arm — so one
			// request per member emptied a meeting's whole programme, quieter than
			// asserting an id because the feed then credits the victim as the actor.
			//
			// #762 closes it on the PROOF rather than on the arm (ADR-0026). Naming
			// nobody resolves as `proof: "asserted"`, exactly like naming the victim,
			// and freeing roles needs `"session"`. The arm gate is untouched and is
			// still a product ceiling, not authorization — which is now a statement
			// about a gate that is no longer the only thing standing there.
			await holdSeededSlot();
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

			// Refused, not partially applied. The throw alone would pass for a
			// fixture that broke for an unrelated reason, and the RUNG matters as
			// much as the slot: a refusal that still recorded "not coming" would
			// take the member off the assign picker while leaving them on the
			// programme.
			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
			expect(await planSetLogs(seed.meetingId)).toHaveLength(0);
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);
		});

		it("REFUSES a release that names the victim as the actor", async () => {
			// The other half of the same forgery, and the one an attacker reaches
			// for first because the id is public — `loadMeetingDetail` ships it as
			// `assigneeId`. Naming the subject and naming nobody resolve to the same
			// place, so both have to be executed or a fix that only handled the
			// no-claim shape would look complete.
			await holdSeededSlot();
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect((await seededSlot())?.assignedMemberId).toBe(seed.memberId);
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});
	});

	describe("an ASSERTED answer fills a blank and nothing else (#762)", () => {
		// The non-releasing rung write, which stays open to a session-less caller
		// because the honour-system sign-up sheet IS the product (ADR-0010). What
		// #762 takes away is the OVERWRITE.
		it("records a first answer, logging proof: asserted", async () => {
			const { changed, released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			});
			expect(changed).toBe(true);
			expect(released).toBe(0);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			const logs = await planSetLogs(seed.meetingId);
			expect(logs).toHaveLength(1);
			expect(logs[0]?.detail).toMatchObject({
				status: "not_coming",
				grantedVia: "self",
				proof: "asserted",
			});
		});

		it("re-sending the SAME answer is a quiet no-op, not a refusal", async () => {
			// The case that makes this a fill-blank rule rather than a one-shot
			// one. A double-tap, or a retry off a flaky mobile connection, must not
			// read as a permission failure to the member who gave the answer.
			const args = {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			};
			await declinePlannedAttendance(testDb, args);
			const { changed } = await declinePlannedAttendance(testDb, args);
			expect(changed).toBe(false);
			// And nothing is logged twice: a `plan_set` for a change that did not
			// happen is a lie the feed tells forever.
			expect(await planSetLogs(seed.meetingId)).toHaveLength(1);
		});

		it("answers OVER an officer's reached_out — the nudge round trip", async () => {
			// The regression #762's review caught, on the seam the nudge link's
			// "Can't make it" reaches. The officer taps the member's WhatsApp draft,
			// which INSERTs `reached_out` onto a blank row; the member then opens
			// the session-less personal meeting page and answers. Counting the ASK
			// as an answer refused them — the officer asked and the member could not
			// reply, which is the whole feature.
			//
			// `reached_out` is the officer's record of having asked, never a reply,
			// so it is still a blank for ADR-0026's purposes (UNANSWERED_RUNGS).
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "reached_out",
			});
			const { changed } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			});
			expect(changed).toBe(true);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				status: "not_coming",
				proof: "asserted",
			});
		});

		it("REFUSES to overwrite an answer that says something else", async () => {
			// The bug, on the rung that carries it: a member who said `coming` is
			// flipped to `not_coming` by anyone who can read their id, they lose
			// their place on the programme, and re-answering needs them to NOTICE.
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "coming",
			});
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: false,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"coming",
			);
			expect(await planSetLogs(seed.meetingId)).toHaveLength(0);
		});

		it("REFUSES the overwrite through the no-caller fallback too", async () => {
			// Same row, same refusal, reached by asserting NOTHING. The fallback
			// resolves the caller to the subject, so without this the fix could be
			// half-applied and the cheaper shape would still work.
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "coming",
			});
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: false,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"coming",
			);
		});

		it("REFUSES the overwrite on an asserted TMOD arm", async () => {
			// The widest of the three asserted shapes: the Toastmaster's id is
			// published on the public agenda payload, so this arm is reachable by
			// any visitor who reads the agenda. The arm keeps the rung write it is
			// there for — recording who is not coming is the panel's job — and
			// loses the overwrite, which is what "that arm loses its destructive
			// writes now" means.
			await addTmodSlot(seed, otherMemberId);
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "coming",
			});
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: false,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"coming",
			);
		});

		it("still lets an asserted TMOD record a FIRST answer for someone", async () => {
			// The control beside it. Without this the refusal above would pass just
			// as well with the whole TMOD arm deleted, which is a different and
			// larger change than the one #762 makes.
			await addTmodSlot(seed, otherMemberId);
			const { changed } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: otherMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			});
			expect(changed).toBe(true);
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "tmod",
				proof: "asserted",
			});
		});
	});

	describe("the TMOD arm", () => {
		it("frees NOTHING on another member's row", async () => {
			// The product ceiling: a Toastmaster running the panel cannot sweep a
			// meeting's whole programme in a few taps. The rung is still written —
			// they run the meeting, and recording who is not coming is the panel's
			// job.
			//
			// The Toastmaster here SIGNS IN, and that is what keeps this a test of
			// the ceiling. Since #762 an asserted caller asking for a release is
			// refused outright, so an anonymous fixture would pass with `mayRelease`
			// deleted, inverted, or gone — the guard-vacuity shape, on the one gate
			// this block exists for.
			await holdSeededSlot();
			const tmod = await addSignedInMember(seed.clubId, "Signed-in TMOD");
			extraUserIds.push(tmod.userId);
			await addTmodSlot(seed, tmod.memberId);
			sessionUserId = tmod.userId;

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: tmod.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(released).toBe(0);

			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
			expect(await releaseLogs([seed.slotId])).toHaveLength(0);

			// The write itself landed, and the feed says which arm admitted it — an
			// honour-system grant and a session-authenticated one must not look the
			// same afterwards.
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
			const [log] = await planSetLogs(seed.meetingId);
			expect(log?.actorMemberId).toBe(tmod.memberId);
			expect(log?.detail).toMatchObject({
				grantedVia: "tmod",
				proof: "session",
			});
		});

		it("REFUSES an asserted Toastmaster asking for a release, rather than quietly writing the rung", async () => {
			// The two gates are independent, and this is what that buys. Without
			// it, an asserted TMOD on another member's row would be refused by
			// `mayRelease` and silently fall through to a rung write — the caller
			// asked to free roles, freed none, and is told nothing went wrong.
			// Refusing on the FLAG means "sign in" instead, which is an answer the
			// person can act on.
			await holdSeededSlot();
			await addTmodSlot(seed, otherMemberId);
			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: otherMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			expect((await seededSlot())?.assignedMemberId).toBe(seed.memberId);
			expect(await planRows(seed.memberId, seed.meetingId)).toHaveLength(0);
		});

		it("DOES free the Toastmaster's own roles on their own row", async () => {
			// Their own answer about their own attendance, and the member most
			// likely to hold a role. It needs saying because the arm ORDER makes it
			// non-obvious: officer → TMOD → self, self last so it cannot swallow the
			// TMOD arm, which means a Toastmaster declining for themselves resolves
			// to `tmod` rather than `self`. Leaving that on the withholding side was
			// a silent divergence — the rail would say "not coming" and the agenda
			// would keep them on the programme, with nothing explaining why.
			const tmodSlotId = await addTmodSlot(seed, seed.memberId);
			await holdSeededSlot();
			sessionUserId = seed.memberUserId;

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			// Both of them: the TMOD slot and the other role they held.
			expect(released).toBe(2);
			const [slot] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, tmodSlotId))
				.limit(1);
			expect(slot?.assignedMemberId).toBeNull();
			// Still credited to the arm that admitted it, not relabelled `self`.
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "tmod",
			});
		});
	});

	describe("the meeting window", () => {
		// BEFORE/AFTER pairs: a write that throws proves nothing on its own, since
		// any broken fixture also throws. The "before" half is what fails if the
		// gate is deleted.
		const DAY = 24 * 3600 * 1000;
		async function moveIntoThePast() {
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 30 * DAY) })
				.where(eq(meetings.id, seed.meetingId));
		}

		it("an OFFICER releases once the meeting's day has PASSED (#1256), a scheduled meeting that was never completed", async () => {
			// protects=the officer's release on a scheduled meeting whose day passed: the
			//   slot is open and the rung is not_coming; the release is attributed to them
			// fails_when=the window refusal runs before the actor is known (the pre-#1256
			//   order), which refuses an officer exactly like a stale nudge link
			// no_claim=self and TMOD are still refused (next two cases); a COMPLETED
			//   meeting (last case)
			// CHANGED from "refuses a release once the meeting's day has PASSED": that
			// asserted the officer was refused, which #1256 §3 reverses. The roll turning
			// out different from the plan is what the officer is correcting.
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;
			await moveIntoThePast();

			const result = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(result.released).toBe(1);
			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBeNull();
			expect(slot?.status).toBe("open");
			expect((await planRows(seed.memberId, seed.meetingId))[0]?.status).toBe(
				"not_coming",
			);
		});

		it("a SELF answer is still refused once the meeting's day has PASSED (#1256)", async () => {
			// protects=the stale-nudge-link refusal for the member's own answer: roles
			//   stay assigned and no plan row is written
			// fails_when=the window is dropped for every arm rather than only the officer
			// no_claim=the before-the-day half is the officer-arm case above and the
			//   "officer arm" block; this one asserts only the refusal
			await holdSeededSlot();
			sessionUserId = seed.memberUserId;
			const args = {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			};
			// BEFORE half: the same call on a meeting in the future releases, so the
			// refusal below is the window and not a broken fixture.
			await expect(
				declinePlannedAttendance(testDb, args),
			).resolves.toMatchObject({ released: 1 });
			await holdSeededSlot();
			await moveIntoThePast();

			await expect(declinePlannedAttendance(testDb, args)).rejects.toThrow(
				RELEASE_AFTER_MEETING_MESSAGE,
			);
			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
		});

		it("a TMOD answering for their OWN row is still refused once the day has PASSED (#1256)", async () => {
			// protects=the window on the TMOD arm: a Toastmaster is not an officer, so
			//   their own release after the day is refused and their TMOD slot stays
			// fails_when=the window skips every non-self actor, or `via` for a TMOD on
			//   their own row is read as officer
			// no_claim=a TMOD on SOMEONE ELSE's row never frees anything (the TMOD arm
			//   block above)
			const tmod = await addSignedInMember(seed.clubId, "Signed-in TMOD");
			extraUserIds.push(tmod.userId);
			const tmodSlotId = await addTmodSlot(seed, tmod.memberId);
			sessionUserId = tmod.userId;
			await moveIntoThePast();

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: tmod.memberId,
					claimedActorMemberId: tmod.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(RELEASE_AFTER_MEETING_MESSAGE);
			const [held] = await testDb
				.select({ assignedMemberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, tmodSlotId));
			expect(held?.assignedMemberId).toBe(tmod.memberId);
		});

		it("an officer is refused on a COMPLETED meeting by the plan refusal, with the slot kept (#1256)", async () => {
			// protects=a completed meeting still refuses the PLAN path for an officer
			//   (roll Absent is the release there): the slot stays assigned
			// fails_when=dropping the officer's window also drops the completed refusal
			//   inside the release, so a completed meeting's roles are freed by Not coming
			// no_claim=the refusal's wording is the lifecycle's, asserted by name
			// CHANGED from "refuses a release on a COMPLETED meeting" expecting
			// RELEASE_AFTER_MEETING_MESSAGE: an officer now skips that window, and what
			// refuses is `assertMeetingAccepts(status, "plan")` (MEETING_LOCKED_MESSAGE).
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, seed.meetingId));

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.adminMemberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(MEETING_LOCKED_MESSAGE);
			expect((await seededSlot())?.assignedMemberId).toBe(seed.memberId);
		});
	});

	describe("the archive gate", () => {
		it("refuses on the RELEASING arm once the club is archived", async () => {
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;
			const args = {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			};
			await expect(
				declinePlannedAttendance(testDb, args),
			).resolves.toMatchObject({ released: 1 });

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(declinePlannedAttendance(testDb, args)).rejects.toThrow(
				CLUB_ARCHIVED_MESSAGE,
			);
		});

		it("refuses on the NON-releasing branch too", async () => {
			// The branch that reaches `setPlanStatus` directly, so it inherits no
			// archive check from the release seam — and takes a self-asserted member
			// id with no session, so `requireMembership`'s check (#186) never runs
			// for it either. Without this seam's own assert, an archived club would
			// still accept the write on exactly one of the two branches.
			const args = {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: false,
			};
			await expect(
				declinePlannedAttendance(testDb, args),
			).resolves.toMatchObject({ released: 0 });

			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(declinePlannedAttendance(testDb, args)).rejects.toThrow(
				CLUB_ARCHIVED_MESSAGE,
			);
		});

		it("refuses BEFORE the meeting window is even considered", async () => {
			// Takedown outranks every other reason to refuse (ADR-0016): an archived
			// club must not answer differently depending on which other gate would
			// also have rejected it.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
				.where(eq(meetings.id, seed.meetingId));
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});
	});

	describe("late drops leave a cover request (#1438, D2)", () => {
		async function coverRows() {
			return testDb
				.select({
					slotId: slotCoverRequests.slotId,
					kind: slotCoverRequests.kind,
					releasedByMemberId: slotCoverRequests.releasedByMemberId,
					coveredAt: slotCoverRequests.coveredAt,
					priorStatus: slotCoverRequests.priorStatus,
				})
				.from(slotCoverRequests)
				.where(eq(slotCoverRequests.meetingId, seed.meetingId));
		}

		async function meetingStartsInHours(hours: number) {
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() + hours * 3_600_000) })
				.where(eq(meetings.id, seed.meetingId));
		}

		it("writes one `dropped` request per freed slot when the meeting is under 48h away", async () => {
			// protects=a late "Can't make it" is not a silent blank: every freed slot
			//   gets a durable `dropped` row naming who left and what the slot was
			// fails_when=`recordLateDrops` is not called from `releaseHeldSlotsForPlan`,
			//   writes one row for two slots, or records the wrong releaser
			// no_claim=the cover flow after the drop (#1439-#1441)
			await meetingStartsInHours(24);
			await holdSeededSlot();
			const secondSlotId = await addHeldSlot(seed, seed.memberId, "Timer 2");
			sessionUserId = seed.memberUserId;

			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

			const rows = await coverRows();
			expect(rows.map((r) => r.slotId).sort()).toEqual(
				[seed.slotId, secondSlotId].sort(),
			);
			for (const r of rows) {
				expect(r.kind).toBe("dropped");
				expect(r.releasedByMemberId).toBe(seed.memberId);
				expect(r.coveredAt).toBeNull();
				expect(r.priorStatus).toBe("claimed");
			}
		});

		it("credits the member who DECLINED, not the officer who did it for them", async () => {
			// protects=`released_by_member_id` is the subject, so the story reads
			//   "Sam dropped Timer" and not "the VPE dropped Timer"
			// fails_when=the officer's actor id is written instead of `args.memberId`
			// no_claim=the activity row, which does credit the officer
			await meetingStartsInHours(24);
			await holdSeededSlot();
			sessionUserId = seed.adminUserId;

			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

			const rows = await coverRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.releasedByMemberId).toBe(seed.memberId);
		});

		it("replaces a stale open request on a freed slot instead of colliding with the unique index", async () => {
			// protects=an open request left on a held slot (a fill site that missed
			//   closing it) does not make the decline throw, and the decline's row wins
			// fails_when=the delete before the insert in `recordLateDrops` is removed
			// no_claim=how the stale row got there
			await meetingStartsInHours(24);
			await holdSeededSlot();
			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.adminMemberId,
				kind: "finding_cover",
				priorStatus: "claimed",
			});
			sessionUserId = seed.memberUserId;

			await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

			const rows = await coverRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.kind).toBe("dropped");
			expect(rows[0]?.releasedByMemberId).toBe(seed.memberId);
		});

		it("snapshots the slot AFTER a writer holding its lock commits", async () => {
			// protects=the `prior_*` columns Undo restores are read under the slot lock:
			//   a slot confirmed while the decline waits is recorded as confirmed
			// fails_when=`readHeldSlots` stops locking the member's slots before it
			//   reads them (the snapshot then shows the pre-commit `claimed`)
			// no_claim=what Undo does with it (cover-logic.integration.test.ts)
			await meetingStartsInHours(24);
			await holdSeededSlot();
			sessionUserId = seed.memberUserId;

			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			let locked!: () => void;
			const held = new Promise<void>((r) => {
				locked = r;
			});
			const writer = testDb.transaction(async (tx) => {
				await tx
					.update(roleSlots)
					.set({ status: "confirmed" })
					.where(eq(roleSlots.id, seed.slotId));
				locked();
				await gate;
			});
			await held;
			const decline = declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			// Long enough for the decline to reach its snapshot read and block (with
			// the fix) or pass it with the stale value (without).
			await new Promise((r) => setTimeout(r, 500));
			release();
			await Promise.all([writer, decline]);

			const rows = await coverRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.priorStatus).toBe("confirmed");
		});

		it("writes none when the meeting is more than 48h away", async () => {
			// protects=an early decline is not a cover request: there is time to
			//   fill the role the ordinary way
			// fails_when=the `isLateDrop` gate is removed
			// no_claim=the release itself, which still happens
			await meetingStartsInHours(72);
			await holdSeededSlot();
			sessionUserId = seed.memberUserId;

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

			expect(released).toBe(1);
			expect(await coverRows()).toHaveLength(0);
		});

		it("writes none, and frees nothing, for a signed-out caller", async () => {
			// protects=the signed-out path cannot mint a cover request: since #762 a
			//   session-less decline is refused before anything is freed
			// fails_when=the proof gate is relaxed and the write runs without a session
			// no_claim=that a signed-out member can decline at all
			await meetingStartsInHours(24);
			await holdSeededSlot();
			sessionUserId = null;

			await expect(
				declinePlannedAttendance(testDb, {
					memberId: seed.memberId,
					claimedActorMemberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
					releaseHeldRoles: true,
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

			expect(await coverRows()).toHaveLength(0);
			expect((await seededSlot())?.assignedMemberId).toBe(seed.memberId);
		});
	});
});
