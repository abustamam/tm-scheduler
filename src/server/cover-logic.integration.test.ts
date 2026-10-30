/**
 * DB-backed tests for cover requests (#1438): the release that records one, the
 * Undo that restores everything, the closing on every fill, the candidate list
 * and the meeting payload.
 *
 * The handlers (`cover.ts`) cannot be invoked from vitest; the session gate they
 * carry is `requireSessionActor`, and what they hand the cores is the resolved
 * member id. These tests call the cores with that id, so "a member who is not the
 * holder" is a different `actorMemberId`.
 *
 * Run with a worktree's own database (`bun run test`), never an exported one.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendancePlan,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	slotCoverRequests,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	ALREADY_TAKEN_MESSAGE,
	COVER_CANDIDATE_LIMIT,
	NOT_A_COVER_RELEASE_MESSAGE,
	NOT_COMING_UNDO_MESSAGE,
	ONLY_HOLDER_MESSAGE,
	ONLY_RELEASER_MESSAGE,
	askForCoverCore,
	loadCoverCandidatesCore,
	loadMeetingCoverRequests,
	releaseOwnSlotForCoverCore,
	undoReleaseForCoverCore,
} = await import("./cover-logic");
const { claimSlotCore, reassignSlotCore } = await import("./slots-logic");
const { applyAssignGuestToSlot } = await import("./guests-logic");
const { attachSpeechToOpenSlot } = await import("./speeches-logic");

const DAY = 86_400_000;

describe.skipIf(!hasTestDb)("cover requests (#1438)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function addMember(
		name: string,
		status: "active" | "inactive" = "active",
	) {
		const personId = await seedPerson({ name });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId, name, status })
			.returning({ id: members.id });
		if (!m) throw new Error("member");
		return m.id;
	}

	/** The seeded Timer slot, held by `seed.memberId`. */
	async function holdSeededSlot(
		overrides: Partial<typeof roleSlots.$inferInsert> = {},
	) {
		const claimedAt = new Date(Date.now() - 3 * DAY);
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: seed.memberId,
				status: "claimed",
				claimedAt,
				...overrides,
			})
			.where(eq(roleSlots.id, seed.slotId));
		return claimedAt;
	}

	const release = (
		actorMemberId: string | null,
		kind = "finding_cover" as const,
	) =>
		testDb.transaction((tx) =>
			releaseOwnSlotForCoverCore(tx, {
				slotId: seed.slotId,
				actorMemberId,
				kind,
			}),
		);

	async function slot() {
		const [row] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, seed.slotId));
		if (!row) throw new Error("slot");
		return row;
	}

	const requests = () =>
		testDb
			.select()
			.from(slotCoverRequests)
			.where(eq(slotCoverRequests.slotId, seed.slotId));

	const claimFor = (memberId: string) =>
		testDb.transaction((tx) =>
			claimSlotCore(tx, {
				slotId: seed.slotId,
				memberId,
				actorMemberId: memberId,
				proof: "session",
			}),
		);

	describe("releaseOwnSlotForCover", () => {
		it("refuses a member who does not hold the role, and leaves the slot untouched", async () => {
			// protects=AC1: `releaseSlot` takes any slot for any member (sheet parity),
			//   so "own" is enforced in the new fn or a member could drop another's role
			// fails_when=the holder check is removed or compares the wrong id
			// no_claim=the officer's own release path, which stays the sheet rule
			await holdSeededSlot();
			await expect(release(seed.adminMemberId)).rejects.toThrow(
				ONLY_HOLDER_MESSAGE,
			);
			await expect(release(null)).rejects.toThrow(ONLY_HOLDER_MESSAGE);
			const after = await slot();
			expect(after.assignedMemberId).toBe(seed.memberId);
			expect(after.status).toBe("claimed");
			expect(await requests()).toHaveLength(0);
		});

		it("opens the slot and leaves exactly one open request that remembers what was wiped", async () => {
			// protects=AC2 and D4: the slot is open for a plain claim, and the request
			//   carries the prior status, claimed_at and speech for Undo
			// fails_when=the insert is skipped, runs twice, or drops a prior_* value
			// no_claim=the activity row, which `releaseSlotCore` owns
			const claimedAt = await holdSeededSlot({ status: "confirmed" });
			await release(seed.memberId);

			const after = await slot();
			expect(after.status).toBe("open");
			expect(after.assignedMemberId).toBeNull();
			expect(after.claimedAt).toBeNull();

			const rows = await requests();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				releasedByMemberId: seed.memberId,
				kind: "finding_cover",
				coveredAt: null,
				priorStatus: "confirmed",
			});
			expect(rows[0]?.priorClaimedAt?.getTime()).toBe(claimedAt.getTime());
		});

		it("replaces a stale open request instead of colliding with the unique index", async () => {
			// protects=an open request left on a held slot (a fill site that missed
			//   closing it) does not make the next release throw
			// fails_when=the delete before the insert is removed
			// no_claim=how the stale row got there
			await holdSeededSlot();
			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.adminMemberId,
				kind: "dropped",
				priorStatus: "claimed",
			});
			await release(seed.memberId);
			const rows = await requests();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.releasedByMemberId).toBe(seed.memberId);
		});
	});

	describe("closing a request on a fill", () => {
		beforeEach(async () => {
			await holdSeededSlot();
			await release(seed.memberId);
		});

		it("a claim marks the request covered by the claimant, and a second open request is impossible", async () => {
			// protects=AC3: every fill closes the request, and the partial unique
			//   index backs "one open request per slot"
			// fails_when=`claimSlotCore` stops calling `closeCoverRequest`, or the
			//   unique index is dropped
			// no_claim=the other fill paths, one test each below
			const other = await addMember("Priya");
			await claimFor(other);
			const [row] = await requests();
			expect(row?.coveredByMemberId).toBe(other);
			expect(row?.coveredAt).not.toBeNull();

			// Open requests: none, so a new release is allowed and makes row two.
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId })
				.where(eq(roleSlots.id, seed.slotId));
			await release(seed.memberId);
			expect(await requests()).toHaveLength(2);

			// And now one IS open: a direct second one is refused by the database.
			await expect(
				testDb.insert(slotCoverRequests).values({
					clubId: seed.clubId,
					meetingId: seed.meetingId,
					slotId: seed.slotId,
					kind: "dropped",
					priorStatus: "claimed",
				}),
			).rejects.toThrow();
		});

		it("an officer's assign (reassignSlotCore) of the open slot closes it", async () => {
			// protects=the officer assign path closes the request
			// fails_when=`reassignSlotCore` stops calling `closeCoverRequest`
			// no_claim=reassigning a HELD slot, which has no open request to close
			const other = await addMember("Priya");
			await testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: seed.slotId,
					memberId: other,
					actorMemberId: seed.adminMemberId,
				}),
			);
			const [row] = await requests();
			expect(row?.coveredByMemberId).toBe(other);
			expect(row?.coveredAt).not.toBeNull();
		});

		it("scheduling a speech into the open speaker slot closes it (attachSpeechToOpenSlot)", async () => {
			// protects=the speech-attach fill site in speeches-logic closes the request
			// fails_when=`attachSpeechToOpenSlot` stops calling `closeCoverRequest`
			// no_claim=attaching to a slot with no open request
			const [slotRow] = await testDb
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			await testDb
				.update(roleDefinitions)
				.set({ isSpeakerRole: true })
				.where(eq(roleDefinitions.id, slotRow?.roleDefinitionId ?? ""));
			const personId = await seedPerson({ name: "Speechy" });
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId,
					name: "Speechy",
					status: "active",
				})
				.returning({ id: members.id });
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!m || !speech) throw new Error("seed");
			await testDb.transaction((tx) =>
				attachSpeechToOpenSlot(tx, {
					speechId: speech.id,
					slotId: seed.slotId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			const [row] = await requests();
			expect(row?.coveredByMemberId).toBe(m.id);
			expect(row?.coveredAt).not.toBeNull();
		});

		it("assigning a GUEST to the open slot closes it, covered by that guest (O4)", async () => {
			// protects=the guest fill site in guests-logic closes the request, with the
			//   guest and not a member recorded
			// fails_when=`applyAssignGuestToSlot` stops calling `closeCoverRequest`
			// no_claim=a guest's later conversion to a member
			const { guestId } = await applyAssignGuestToSlot({
				slotId: seed.slotId,
				newGuest: { name: "Visiting Vi" },
				actorMemberId: seed.adminMemberId,
			});
			const [row] = await requests();
			expect(row?.coveredGuestId).toBe(guestId);
			expect(row?.coveredByMemberId).toBeNull();
			expect(row?.coveredAt).not.toBeNull();
		});

		it("a REFUSED fill leaves the request open", async () => {
			// protects=the close runs after the write succeeded, in its transaction
			// fails_when=the close moves before the conditional UPDATE
			// no_claim=which refusal it was
			const other = await addMember("Priya", "inactive");
			await expect(claimFor(other)).rejects.toThrow();
			const [row] = await requests();
			expect(row?.coveredAt).toBeNull();
		});
	});

	describe("undoReleaseForCover (D4)", () => {
		const undo = (actorMemberId: string | null) =>
			testDb.transaction((tx) =>
				undoReleaseForCoverCore(tx, { slotId: seed.slotId, actorMemberId }),
			);

		it("restores status, claimed_at and speech on a confirmed speaker slot, and the request is gone", async () => {
			// protects=Undo restores EVERYTHING the release wiped; a claim would have
			//   come back `claimed` with `claimed_at` now and no speech
			// fails_when=Undo goes through `claimSlotCore`, or a prior_* is not written back
			// no_claim=undoing a decline's release, a different flow
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: seed.personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("speech");
			const claimedAt = await holdSeededSlot({
				status: "confirmed",
				speechId: speech.id,
			});
			await release(seed.memberId);
			expect((await slot()).speechId).toBeNull();

			await undo(seed.memberId);

			const after = await slot();
			expect(after.status).toBe("confirmed");
			expect(after.assignedMemberId).toBe(seed.memberId);
			expect(after.claimedAt?.getTime()).toBe(claimedAt.getTime());
			expect(after.speechId).toBe(speech.id);
			expect(await requests()).toHaveLength(0);
		});

		it("is refused once someone took the role, and for anyone but the releaser", async () => {
			// protects=Undo cannot take a role back from its new holder or be used by
			//   a bystander
			// fails_when=the status or the releaser check is removed
			// no_claim=the toast copy
			await holdSeededSlot();
			await release(seed.memberId);
			await expect(undo(seed.adminMemberId)).rejects.toThrow(
				ALREADY_TAKEN_MESSAGE,
			);

			const other = await addMember("Priya");
			await claimFor(other);
			await expect(undo(seed.memberId)).rejects.toThrow(ALREADY_TAKEN_MESSAGE);
			const after = await slot();
			expect(after.assignedMemberId).toBe(other);
			// The refusal rolled back: the covered request is still there.
			const [row] = await requests();
			expect(row?.coveredByMemberId).toBe(other);
		});

		it("refuses a decline's `dropped` request and leaves the slot open", async () => {
			// protects=Undo is for a cover release only: a decline's `dropped` row must
			//   not hand the role back confirmed
			// fails_when=the kind check is removed
			// no_claim=the toast copy
			await testDb
				.update(roleSlots)
				.set({ status: "open", assignedMemberId: null, claimedAt: null })
				.where(eq(roleSlots.id, seed.slotId));
			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.memberId,
				kind: "dropped",
				priorStatus: "confirmed",
			});
			await expect(undo(seed.memberId)).rejects.toThrow(
				NOT_A_COVER_RELEASE_MESSAGE,
			);
			const after = await slot();
			expect(after.status).toBe("open");
			expect(after.assignedMemberId).toBeNull();
			expect(await requests()).toHaveLength(1);
		});

		it("is refused after a late `not coming`, and the slot stays open", async () => {
			// protects=a member who said no cannot get the role back confirmed
			//   (`claimSlotCore` refuses the same member the same way)
			// fails_when=the attendance read is removed from Undo
			// no_claim=the lock ordering, which the decline path shares
			await holdSeededSlot();
			await release(seed.memberId);
			await testDb.insert(meetingAttendancePlan).values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "not_coming",
			});
			await expect(undo(seed.memberId)).rejects.toThrow(
				NOT_COMING_UNDO_MESSAGE,
			);
			const after = await slot();
			expect(after.status).toBe("open");
			expect(after.assignedMemberId).toBeNull();
			expect(await requests()).toHaveLength(1);
		});

		it("does not restore a speech another slot took meanwhile", async () => {
			// protects=the unique index on role_slots.speech_id: Undo must not throw
			//   or steal the speech from the slot that now has it
			// fails_when=the elsewhere check is removed (23505 on the restore)
			// no_claim=what the other slot does with the speech
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: seed.personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("speech");
			await holdSeededSlot({ speechId: speech.id });
			await release(seed.memberId);
			const [other] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: seed.roleDefinitionId,
					slotIndex: 1,
					speechId: speech.id,
				})
				.returning({ id: roleSlots.id });
			if (!other) throw new Error("slot");

			await undo(seed.memberId);
			const after = await slot();
			expect(after.assignedMemberId).toBe(seed.memberId);
			expect(after.speechId).toBeNull();
		});
	});

	describe("askForCover (D5)", () => {
		it("upgrades a dropped request for its releaser, and refuses anyone else", async () => {
			// protects=only the member who dropped the role turns it into a request
			//   for cover
			// fails_when=the releaser check is removed, or the kind is not written
			// no_claim=the 06:00 derived flip, which is `coverStatus`'s
			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.memberId,
				kind: "dropped",
				priorStatus: "claimed",
			});
			await expect(
				testDb.transaction((tx) =>
					askForCoverCore(tx, {
						slotId: seed.slotId,
						actorMemberId: seed.adminMemberId,
					}),
				),
			).rejects.toThrow(ONLY_RELEASER_MESSAGE);
			expect((await requests())[0]?.kind).toBe("dropped");

			await testDb.transaction((tx) =>
				askForCoverCore(tx, {
					slotId: seed.slotId,
					actorMemberId: seed.memberId,
				}),
			);
			expect((await requests())[0]?.kind).toBe("finding_cover");
		});
	});

	describe("loadCoverCandidates", () => {
		async function plan(memberId: string, status: "coming" | "not_coming") {
			await testDb
				.insert(meetingAttendancePlan)
				.values({ memberId, meetingId: seed.meetingId, status });
		}
		/** `memberId` held the seeded role at a meeting `daysAgo` before this one. */
		async function servedBefore(memberId: string, daysAgo: number) {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + (7 - daysAgo) * DAY),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!m) throw new Error("meeting");
			await testDb.insert(roleSlots).values({
				meetingId: m.id,
				roleDefinitionId: seed.roleDefinitionId,
				assignedMemberId: memberId,
				status: "claimed",
			});
		}
		const candidates = () =>
			loadCoverCandidatesCore({
				meetingId: seed.meetingId,
				slotId: seed.slotId,
			});

		it("filters to likely-coming members, never the releaser, and carries no contact", async () => {
			// protects=AC4: not the releaser, not a not-coming member, not an inactive
			//   member, no contact field; an explicit not_coming beats an assumed one
			// fails_when=any of those filters is removed, or a contact column is added
			//   to the projection
			// no_claim=the order, next test
			await holdSeededSlot();
			await release(seed.memberId);
			await plan(seed.memberId, "coming"); // the releaser
			const coming = await addMember("Coming Cora");
			await plan(coming, "coming");
			const inactive = await addMember("Inactive Ian", "inactive");
			await plan(inactive, "coming");
			const declined = await addMember("Declined Dee");
			await plan(declined, "not_coming");
			const declinedButConfirmed = await addMember("Confirmed Not Coming");
			await plan(declinedButConfirmed, "not_coming");
			await addMember("Silent Sid"); // no answer, no role: nobody to assume
			// `declinedButConfirmed` holds a CONFIRMED role (assumed coming) but said
			// no, and the explicit answer wins. The role is a DIFFERENT one from the
			// slot being covered, so the "already holds this role" exclusion cannot be
			// what removes them: only the not_coming rule can.
			const [otherRole] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Evaluator",
					category: "evaluator",
					sortOrder: 9,
				})
				.returning({ id: roleDefinitions.id });
			if (!otherRole) throw new Error("role");
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: otherRole.id,
				slotIndex: 0,
				assignedMemberId: declinedButConfirmed,
				status: "confirmed",
			});

			const out = await candidates();
			const names = out.map((c) => c.name);
			expect(names).toContain("Coming Cora");
			expect(names).not.toContain("Member User");
			expect(names).not.toContain("Inactive Ian");
			expect(names).not.toContain("Declined Dee");
			expect(names).not.toContain("Confirmed Not Coming");
			expect(names).not.toContain("Silent Sid");
			for (const c of out) {
				expect(Object.keys(c).sort()).toEqual([
					"lastServedAt",
					"memberId",
					"name",
				]);
			}
		});

		it("excludes someone already holding this role on the meeting, and counts a confirmed role as coming", async () => {
			// protects=O6: the assumed-coming rule comes from `resolveEffectiveRung`
			//   (confirmed roles only), and holding this very role disqualifies
			// fails_when=a claimed-only holder is treated as assumed coming, or the
			//   same-role exclusion is removed
			// no_claim=roles other than the seeded Timer
			await holdSeededSlot();
			await release(seed.memberId);
			const [other] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Grammarian",
					category: "functionary",
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!other) throw new Error("def");
			const confirmedElsewhere = await addMember("Confirmed Elsewhere");
			const claimedElsewhere = await addMember("Claimed Elsewhere");
			const sameRole = await addMember("Same Role");
			await plan(sameRole, "coming");
			await testDb.insert(roleSlots).values([
				{
					meetingId: seed.meetingId,
					roleDefinitionId: other.id,
					assignedMemberId: confirmedElsewhere,
					status: "confirmed",
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: other.id,
					slotIndex: 1,
					assignedMemberId: claimedElsewhere,
					status: "claimed",
				},
				{
					meetingId: seed.meetingId,
					roleDefinitionId: seed.roleDefinitionId,
					slotIndex: 1,
					assignedMemberId: sameRole,
					status: "claimed",
				},
			]);
			const names = (await candidates()).map((c) => c.name);
			expect(names).toContain("Confirmed Elsewhere");
			expect(names).not.toContain("Claimed Elsewhere");
			expect(names).not.toContain("Same Role");
		});

		it("orders never-held first, then the longest ago, and returns at most five", async () => {
			// protects=the order the asker sees and the cap of five
			// fails_when=the sort flips, never-held is not first, or the slice is removed
			// no_claim=ties between two never-held members beyond a stable name order
			await holdSeededSlot();
			await release(seed.memberId);
			const recent = await addMember("Recent Rae");
			const old = await addMember("Old Ola");
			await plan(recent, "coming");
			await plan(old, "coming");
			await servedBefore(recent, 7);
			await servedBefore(old, 70);
			const never = await addMember("Never Nia");
			await plan(never, "coming");

			let out = await candidates();
			expect(out.map((c) => c.name)).toEqual([
				"Never Nia",
				"Old Ola",
				"Recent Rae",
			]);
			expect(out[0]?.lastServedAt).toBeNull();
			expect(out[1]?.lastServedAt).not.toBeNull();

			for (let i = 0; i < 5; i++) {
				const id = await addMember(`Extra ${i}`);
				await plan(id, "coming");
			}
			out = await candidates();
			expect(out).toHaveLength(COVER_CANDIDATE_LIMIT);
			// The two who have served come last, so the cap cuts them first.
			expect(out.every((c) => c.lastServedAt === null)).toBe(true);
		});
	});

	describe("the meeting payload", () => {
		const slotsOf = async () =>
			(
				await testDb
					.select()
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, seed.meetingId))
			).map((s) => ({
				id: s.id,
				assigneeId: s.assignedMemberId,
				assigneeGuestId: s.assignedGuestId,
			}));

		it("hides an open request on a held slot and never falls back to an older covered row", async () => {
			// protects=newest row per slot wins even when it is hidden: the older
			//   covered story must not take its place while its coverer still holds
			//   the slot, and an open request is not shown on a held slot
			// fails_when=the newest-first `seen` guard is removed, or the held-slot
			//   check on an open row is
			// no_claim=how an open request came to sit on a held slot
			await holdSeededSlot();
			await release(seed.memberId);
			const cover = await addMember("Priya");
			await claimFor(cover);
			let out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(1); // the older covered row, cover still holds

			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.memberId,
				kind: "dropped",
				priorStatus: "claimed",
				releasedAt: new Date(Date.now() + 1000),
			});
			out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(0);
		});

		it("names a releaser or coverer who is no longer an active member as Someone", async () => {
			// protects=the payload is public: a member who left is not named on it
			//   (#1342's active-only rule)
			// fails_when=the member joins stop filtering on status = active
			// no_claim=the members' own list, which still shows them to officers
			await holdSeededSlot();
			await release(seed.memberId);
			const cover = await addMember("Priya");
			await claimFor(cover);
			await testDb
				.update(members)
				.set({ status: "inactive" })
				.where(inArray(members.id, [seed.memberId, cover]));
			const out = await loadMeetingCoverRequests(
				seed.meetingId,
				await slotsOf(),
			);
			expect(out).toHaveLength(1);
			expect(out[0]?.releasedName).toBe("Someone");
			expect(out[0]?.coveredName).toBe("Someone");
		});

		it("shows an open request with names only, the covered story while the cover holds it, and nothing after a reassign", async () => {
			// protects=the payload rules: newest per slot, covered shown only while the
			//   covering person still holds the slot, never written to hide it
			// fails_when=a covered row survives a reassign, or an open row shows on a
			//   held slot
			// no_claim=the page that draws it (#1439)
			await holdSeededSlot();
			await release(seed.memberId);
			let out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				slotId: seed.slotId,
				kind: "finding_cover",
				releasedName: "Member User",
				coveredName: null,
				coveredAt: null,
			});

			const cover = await addMember("Priya");
			await claimFor(cover);
			out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({ coveredName: "Priya" });
			expect(out[0]?.coveredAt).not.toBeNull();

			// A plain reassign afterwards hides the story without writing.
			await testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: seed.slotId,
					memberId: seed.adminMemberId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(0);
			const [row] = await requests();
			expect(row?.coveredByMemberId).toBe(cover);

			// An open request on a slot somebody holds is hidden too.
			await testDb.insert(slotCoverRequests).values({
				clubId: seed.clubId,
				meetingId: seed.meetingId,
				slotId: seed.slotId,
				releasedByMemberId: seed.memberId,
				kind: "dropped",
				priorStatus: "claimed",
				releasedAt: new Date(Date.now() + 1000),
			});
			out = await loadMeetingCoverRequests(seed.meetingId, await slotsOf());
			expect(out).toHaveLength(0);
			expect(
				await testDb
					.select()
					.from(slotCoverRequests)
					.where(
						and(
							eq(slotCoverRequests.slotId, seed.slotId),
							isNull(slotCoverRequests.coveredAt),
						),
					),
			).toHaveLength(1);
		});
	});
});
