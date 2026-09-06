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
 * 2. The ARM. A product ceiling, NOT a security boundary — see the seam's header
 *    and THE RESIDUAL case below, which executes the hole and asserts it is open.
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
	speeches,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
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

	beforeEach(async () => {
		seed = await seedClub();
		sessionUserId = null;
		otherMemberId = await addRosterMember(seed.clubId, "Someone Else");
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
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
			await holdSeededSlot();
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
			expect((await planSetLogs(seed.meetingId))[0]?.detail).toMatchObject({
				grantedVia: "self",
			});
		});

		it("records the rung with nothing to free when the member holds no role", async () => {
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

		it("THE RESIDUAL: an anonymous caller who asserts NOTHING releases the subject's roles", async () => {
			// Executed, not described, because an earlier draft of this change
			// defended the arm gate as a security boundary and this is the case that
			// disproves it. With no session and no claim, `resolveActor`'s last arm
			// resolves the caller TO the subject and returns `via: "self"` — a
			// releasing arm. So the cheap forgery is to OMIT the claim, once per
			// member, and it is quieter than asserting one: the feed credits the
			// victim as the actor.
			//
			// That is the product's identity model (#317), the same honour system
			// `claimSlot` and `releaseSlot` run on, and closing it is a much larger
			// change than #663. `availability.integration.test.ts` has asserted the
			// same residual for the sibling endpoint since #675. The arm gate is a
			// product ceiling on what a Toastmaster can do in a few honest taps; it
			// is not authorization, and this test is here so nobody re-describes it
			// as one.
			await holdSeededSlot();
			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});
			expect(released).toBe(1);
			expect((await seededSlot())?.status).toBe("open");
			const [log] = await planSetLogs(seed.meetingId);
			expect(log?.detail).toMatchObject({ grantedVia: "self" });
			expect(
				log?.actorMemberId,
				"the write is credited to the SUBJECT, which is what makes this quiet",
			).toBe(seed.memberId);
		});
	});

	describe("the TMOD arm", () => {
		it("frees NOTHING on another member's row", async () => {
			// The product ceiling: a Toastmaster running the panel cannot sweep a
			// meeting's whole programme in a few taps. The rung is still written —
			// they run the meeting, and recording who is not coming is the panel's
			// job.
			await holdSeededSlot();
			await addTmodSlot(seed, otherMemberId);

			const { released } = await declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: otherMemberId,
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
			expect(log?.actorMemberId).toBe(otherMemberId);
			expect(log?.detail).toMatchObject({ grantedVia: "tmod" });
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
		it("refuses a release once the meeting's day has PASSED, though it is not completed", async () => {
			// `assertMeetingNotLocked` is `status === "completed"` and nothing else,
			// and clubs routinely never press Complete — so last month's meeting
			// sits at "scheduled" forever while its nudge link stays in a chat
			// scrollback. A release there erases who actually did what.
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

			// Put it back and move the meeting into the past.
			await holdSeededSlot();
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })
				.where(eq(meetings.id, seed.meetingId));

			await expect(declinePlannedAttendance(testDb, args)).rejects.toThrow(
				RELEASE_AFTER_MEETING_MESSAGE,
			);
			const slot = await seededSlot();
			expect(slot?.assignedMemberId).toBe(seed.memberId);
			expect(slot?.status).toBe("claimed");
		});

		it("refuses a release on a COMPLETED meeting", async () => {
			// The lock the handler also carries, asserted here because the seam is
			// reachable from a direct POST that never went through the handler's
			// guard order.
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
			).rejects.toThrow(RELEASE_AFTER_MEETING_MESSAGE);
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
});
