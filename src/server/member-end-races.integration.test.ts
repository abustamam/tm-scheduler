/**
 * Ending a membership against everything that races it (#1327).
 *
 * Every case PARKS an End partway: it has flipped the member row (uncommitted),
 * holds the club write lock and the row lock, and waits on a slot row a
 * transaction we control holds (`parkEnd`). The racing writer then starts, and
 * the case proves it is blocked BY THE END (`waitForLockWait`, on the lock graph,
 * not on a timer) before the End is let go. Without that wait the writer could
 * run on the uncontended path and every assertion would still hold.
 *
 * Each case starts from the state the bug leaves and asserts it is not left:
 * a former member holding an upcoming role, a role claimed after the release
 * sweep, a merge that revives an End, a club with no active admin, a 40P01.
 *
 * Run with a bootstrapped worktree (`bun run worktree:setup`):
 *   bunx vitest run src/server/member-end-races.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guests,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEMBER_NOT_ELIGIBLE_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyMemberEdit,
	applyMemberRemove,
	applySetMemberRole,
	applySetMemberStatus,
} = await import("#/server/members-logic");
const { CLUB_BUSY_MESSAGE } = await import("#/server/club-write-lock");
const { lockMembershipForMerge } = await import(
	"#/server/membership-merge-lock"
);
const { attachSpeechToOpenSlot } = await import("#/server/speeches-logic");
const { collapseMemberships } = await import(
	"#/server/membership-collapse-logic"
);
const { applyLinkGuestToMember, LINK_MEMBER_FORMER_MESSAGE } = await import(
	"#/server/guest-pipeline-logic"
);
const { claimSlotCore, reassignSlotCore, releaseSlotCore } = await import(
	"#/server/slots-logic"
);
const { assignRolesTool } = await import("#/server/mcp/tools/assign-roles");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { isDeadlock } = await import("#/server/pg-errors");

/** The error a settled promise threw, or null. */
async function settle(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => null,
		(e: unknown) => e,
	);
}

describe.skipIf(!hasTestDb)("ending a membership vs its races (#1327)", () => {
	let club: SeededClub;
	let extraPeople: string[];

	beforeEach(async () => {
		club = await seedClub();
		extraPeople = [];
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		if (extraPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, extraPeople));
		}
	});

	async function addMember(
		name: string,
		over: Partial<typeof members.$inferInsert> = {},
	) {
		const personId = await seedPerson({ name });
		extraPeople.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({ clubId: club.clubId, personId, name, ...over })
			.returning({ id: members.id });
		if (!m) throw new Error("member insert failed");
		return m.id;
	}

	async function addSlot(
		meetingId: string,
		holder: string | null,
	): Promise<string> {
		const [s] = await testDb
			.insert(roleSlots)
			.values({
				meetingId,
				roleDefinitionId: club.roleDefinitionId,
				status: holder ? "claimed" : "open",
				assignedMemberId: holder,
				claimedAt: holder ? new Date() : null,
			})
			.returning({ id: roleSlots.id });
		if (!s) throw new Error("slot insert failed");
		return s.id;
	}

	async function slot(id: string) {
		const [s] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				assignedGuestId: roleSlots.assignedGuestId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, id));
		if (!s) throw new Error("slot missing");
		return s;
	}

	async function memberRow(id: string) {
		const [m] = await testDb
			.select({
				status: members.status,
				clubRole: members.clubRole,
				endedAt: members.endedAt,
			})
			.from(members)
			.where(eq(members.id, id));
		if (!m) throw new Error("member missing");
		return m;
	}

	const setStatus = (
		memberId: string,
		status: "former" | "inactive",
		actorMemberId = club.adminMemberId,
	) =>
		applySetMemberStatus({
			clubId: club.clubId,
			memberId,
			status,
			actorMemberId,
		});
	const end = (memberId: string, actorMemberId = club.adminMemberId) =>
		setStatus(memberId, "former", actorMemberId);

	/** A writer that is holding locks until `release()`, and the backend it is. */
	type Holder = { pid: number; release: () => Promise<void> };

	/**
	 * Start `start`, prove it is blocked BY `holder` (a statement whose text
	 * contains `match`, on the lock graph, never a timer), let the holder go, and
	 * return what `start` threw (null if nothing). The one shape every "a writer
	 * queued behind X" case here has.
	 */
	async function raceBehind(
		holder: Holder,
		match: string,
		start: () => Promise<unknown>,
	): Promise<unknown> {
		let racer: Promise<unknown> | undefined;
		try {
			racer = start();
			racer.catch(() => {});
			await waitForLockWait(match, holder.pid);
		} finally {
			await holder.release();
		}
		return settle(racer as Promise<unknown>);
	}

	/**
	 * Start ending `memberId` and park it: it holds the club write lock and the
	 * member row, has flipped the row, and waits on `heldSlotId`, a slot a
	 * blocking transaction holds. `finish()` lets the End run to commit.
	 */
	async function parkEnd(
		memberId: string,
		heldSlotId: string,
		actorMemberId = club.adminMemberId,
		status: "former" | "inactive" = "former",
	) {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select 1 from role_slots where id = ${heldSlotId} for update`,
			);
		});
		const ending = setStatus(memberId, status, actorMemberId);
		ending.catch(() => {});
		let endPid: number;
		try {
			endPid = await waitForLockWait("role_slots", blocker.pid);
		} catch (e) {
			await blocker.commit();
			await settle(ending);
			throw e;
		}
		let finished = false;
		const finish = async () => {
			if (finished) return;
			finished = true;
			await blocker.commit();
			await ending;
		};
		return {
			endPid,
			ending,
			finish,
			/** The parked End as a `raceBehind` holder. */
			holder: { pid: endPid, release: finish } as Holder,
		};
	}

	it("a claim queued behind End is refused, and the slot stays open", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		// Blocked on the member row End holds, BEFORE it touches the slot.
		const err = await raceBehind(parked.holder, "share", () =>
			testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: club.slotId,
					memberId: leaver,
					actorMemberId: leaver,
					proof: "asserted",
				}),
			),
		);
		expect(String(err)).toContain(MEMBER_NOT_ELIGIBLE_MESSAGE);
		expect(await slot(club.slotId)).toMatchObject({
			status: "open",
			assignedMemberId: null,
		});
		expect(await slot(held)).toMatchObject({ assignedMemberId: null });
	});

	it("a reassign queued behind End is refused, and the slot stays open", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		const err = await raceBehind(parked.holder, "share", () =>
			testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: club.slotId,
					memberId: leaver,
					actorMemberId: club.adminMemberId,
					proof: "session",
				}),
			),
		);
		expect(String(err)).toContain(MEMBER_NOT_ELIGIBLE_MESSAGE);
		expect(await slot(club.slotId)).toMatchObject({
			status: "open",
			assignedMemberId: null,
		});
	});

	async function speakerSlotAndSpeech(personId: string) {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role definition insert failed");
		const [sl] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: club.meetingId,
				roleDefinitionId: def.id,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		const [sp] = await testDb
			.insert(speeches)
			.values({ personId, title: "Ice Breaker" })
			.returning({ id: speeches.id });
		if (!sl || !sp) throw new Error("speaker fixtures failed");
		return { slotId: sl.id, speechId: sp.id, roleDefinitionId: def.id };
	}

	// protects=scheduling an unscheduled speech into an open speaker slot queued behind a member's End is refused and leaves the slot open and the speech unlinked (#1327, the speech path);
	// fails_when=attachSpeechToOpenSlot reads the member's status without a lock End conflicts with, so the slot lands on a former member after End's release sweep;
	// no_claim=the claim and reassign paths (the two tests above), a merge.
	it("a speech attach queued behind End is refused, and the slot stays open", async () => {
		const leaver = await addMember("Leaving Lee");
		const [row] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, leaver));
		const spk = await speakerSlotAndSpeech(row?.personId as string);
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		const err = await raceBehind(parked.holder, "share", () =>
			testDb.transaction((tx) =>
				attachSpeechToOpenSlot(tx, {
					speechId: spk.speechId,
					slotId: spk.slotId,
					actorMemberId: club.adminMemberId,
				}),
			),
		);
		expect(String(err)).toContain(MEMBER_NOT_ELIGIBLE_MESSAGE);
		expect(await slot(spk.slotId)).toMatchObject({
			status: "open",
			assignedMemberId: null,
		});
	});

	// protects=a speech attach for a member waits for a merge or removal that holds the membership's merge lock EXCLUSIVE, so it cannot land on a membership between the merge's re-point and its DELETE (which would set the holder null);
	// fails_when=attachSpeechToOpenSlot drops the SHARED merge lock on the speaker's membership;
	// no_claim=the outcome after the merge commits (the claim's merge-lock suites cover that).
	it("a speech attach waits for the membership's merge lock", async () => {
		const speaker = await addMember("Speaking Sam");
		const [row] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, speaker));
		const spk = await speakerSlotAndSpeech(row?.personId as string);
		const merge = await openBlockingTx(async (tx) => {
			await lockMembershipForMerge(tx, speaker);
		});
		const err = await raceBehind(
			{ pid: merge.pid, release: merge.commit },
			"advisory",
			() =>
				testDb.transaction((tx) =>
					attachSpeechToOpenSlot(tx, {
						speechId: spk.speechId,
						slotId: spk.slotId,
						actorMemberId: club.adminMemberId,
					}),
				),
		);
		expect(err).toBeNull();
		expect(await slot(spk.slotId)).toMatchObject({ assignedMemberId: speaker });
	});

	it("assign_roles queued behind End does not put the ended member on the agenda", async () => {
		const token = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: club.adminUserId, tokenHash: hashApiToken(token) });
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		const err = (await raceBehind(parked.holder, "share", () =>
			assignRolesTool.handler(
				{
					meetingId: club.meetingId,
					assignments: [{ slotId: club.slotId, memberId: leaver }],
				},
				{ rawToken: token },
			),
		)) as {
			code?: string;
			detail?: { blocking?: { code: string }[] };
		} | null;
		expect(err?.code).toBe("BLOCKED");
		expect(err?.detail?.blocking?.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
		expect(await slot(club.slotId)).toMatchObject({
			status: "open",
			assignedMemberId: null,
		});
	});

	it("a guest link queued behind End is refused and leaves the guest's slot alone", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const guest = await withGuestPerson({
			clubId: club.clubId,
			name: "Guest Gail",
			stage: "prospect",
		});
		const [g] = await testDb.insert(guests).values(guest).returning();
		if (!g) throw new Error("guest insert failed");
		const guestSlot = await addSlot(club.meetingId, null);
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: g.id, status: "claimed" })
			.where(eq(roleSlots.id, guestSlot));

		const parked = await parkEnd(leaver, held);
		const err = await raceBehind(parked.holder, "advisory", () =>
			applyLinkGuestToMember({
				clubId: club.clubId,
				guestId: g.id,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			}),
		);
		expect(String(err)).toContain(LINK_MEMBER_FORMER_MESSAGE);
		// The state the bug left: the guest's slot re-pointed onto a former member.
		expect(await slot(guestSlot)).toMatchObject({
			assignedMemberId: null,
			assignedGuestId: g.id,
		});
		const rows = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, leaver));
		expect(rows).toEqual([]);
	});

	/** A writer that holds the member row ended, uncommitted, WITHOUT the club
	 *  write lock: the row-level half of each guard, which the club lock on End
	 *  would otherwise mask. */
	async function holdEndedRow(memberId: string): Promise<Holder> {
		const held = await openBlockingTx(async (tx) => {
			await tx
				.update(members)
				.set({ status: "former", endedAt: "2026-10-27" })
				.where(eq(members.id, memberId));
		});
		return { pid: held.pid, release: held.commit };
	}

	it("a guest link reads the member row FOR SHARE, so it waits for an End on the row", async () => {
		const leaver = await addMember("Leaving Lee");
		const g = (
			await testDb
				.insert(guests)
				.values(
					await withGuestPerson({
						clubId: club.clubId,
						name: "Guest Gail",
						stage: "prospect",
					}),
				)
				.returning({ id: guests.id })
		)[0];
		if (!g) throw new Error("guest insert failed");
		const err = await raceBehind(await holdEndedRow(leaver), "share", () =>
			applyLinkGuestToMember({
				clubId: club.clubId,
				guestId: g.id,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			}),
		);
		expect(String(err)).toContain(LINK_MEMBER_FORMER_MESSAGE);
	});

	it("a merge locks both rows before deriving the status, so it waits for an End on the row", async () => {
		const keeper = await addMember("Keeper Kay");
		const absorbed = await addMember("Absorbed Abe", {
			status: "former",
			endedAt: "2026-01-01",
		});
		const err = await raceBehind(
			await holdEndedRow(keeper),
			"no key update",
			() =>
				testDb.transaction((tx) =>
					collapseMemberships(tx, club.clubId, keeper, absorbed),
				),
		);
		expect(err).toBeNull();
		expect(await memberRow(keeper)).toMatchObject({
			status: "former",
			endedAt: "2026-10-27",
		});
	});

	// protects=End does not deadlock (40P01) with the member releasing their own role: the release holds the slot, then its activity insert key-shares the member row End holds;
	// fails_when=End takes the member row FOR UPDATE again (it blocks the key-share while waiting on the slot the release holds);
	// no_claim=the interleaving is built by locking the slot first, then calling the REAL releaseSlotCore: the pause between its slot lock and its activity insert cannot be forced from outside.
	it("End does not deadlock with the member releasing their own role", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		let go!: () => void;
		const gate = new Promise<void>((r) => {
			go = r;
		});
		let ready!: (pid: number) => void;
		const started = new Promise<number>((r) => {
			ready = r;
		});
		const release = testDb.transaction(async (tx) => {
			const res = await tx.execute(sql`select pg_backend_pid() as pid`);
			// The slot lock the real release takes first, taken ahead so End can be
			// parked behind it before the release goes on to log.
			await tx.execute(
				sql`select 1 from role_slots where id = ${held} for update`,
			);
			ready(Number((res.rows[0] as { pid: number }).pid));
			await gate;
			await releaseSlotCore(tx, {
				slotId: held,
				actorMemberId: leaver,
				proof: "session",
			});
		});
		release.catch(() => {});
		const releasePid = await started;
		const ending = end(leaver);
		ending.catch(() => {});
		try {
			await waitForLockWait("role_slots", releasePid);
		} finally {
			go();
		}
		const [endErr, releaseErr] = await Promise.all([
			settle(ending),
			settle(release),
		]);
		expect(endErr && isDeadlock(endErr)).toBeFalsy();
		expect(releaseErr && isDeadlock(releaseErr)).toBeFalsy();
		expect(endErr).toBeNull();
		expect(releaseErr).toBeNull();
		expect((await memberRow(leaver)).status).toBe("former");
		expect(await slot(held)).toMatchObject({ assignedMemberId: null });
	});

	async function activeAdminIds() {
		const rows = await testDb
			.select({ id: members.id })
			.from(members)
			.where(
				and(
					eq(members.clubId, club.clubId),
					eq(members.status, "active"),
					eq(members.clubRole, "admin"),
				),
			);
		return rows.map((a) => a.id);
	}

	it("two admins ending each other leave one active admin", async () => {
		const other = await addMember("Second Admin", { clubRole: "admin" });
		const otherSlot = await addSlot(club.meetingId, other);
		// End 1 ends `other` (acting as the seeded admin) and parks, its last-admin
		// check already passed against the seeded admin.
		const first = await parkEnd(other, otherSlot, club.adminMemberId);
		// End 2 ends the seeded admin, acting as `other`. It must wait for End 1.
		const err = await raceBehind(first.holder, "advisory", () =>
			end(club.adminMemberId, other),
		);
		expect(String(err)).toContain("last admin");
		expect(await activeAdminIds()).toEqual([club.adminMemberId]);
	});

	// protects=two admins DEACTIVATING each other at once leave an active admin: the second waits on the club write lock and its last-admin count sees the first's commit;
	// fails_when=applySetMemberStatus drops the club write lock, so both counts see the other admin still active and both deactivate;
	// no_claim=an End (the test above), a role demotion (next).
	it("two admins deactivating each other leave one active admin", async () => {
		const other = await addMember("Second Admin", { clubRole: "admin" });
		const otherSlot = await addSlot(club.meetingId, other);
		const first = await parkEnd(
			other,
			otherSlot,
			club.adminMemberId,
			"inactive",
		);
		const err = await raceBehind(first.holder, "advisory", () =>
			setStatus(club.adminMemberId, "inactive", other),
		);
		expect(String(err)).toContain("last admin");
		expect(await activeAdminIds()).toEqual([club.adminMemberId]);
	});

	// protects=a role demotion racing an End leaves an active admin: the demotion waits on the club write lock End holds, and its last-admin check sees the End's commit;
	// fails_when=applySetMemberRole drops the club write lock, so its check sees the admin End is still ending as active and the club is left with none;
	// no_claim=the demote guard's own rule (members-role tests).
	it("a demotion queued behind an End leaves an active admin", async () => {
		const other = await addMember("Second Admin", { clubRole: "admin" });
		const otherSlot = await addSlot(club.meetingId, other);
		const parked = await parkEnd(other, otherSlot, club.adminMemberId);
		const err = await raceBehind(parked.holder, "advisory", () =>
			applySetMemberRole({
				clubId: club.clubId,
				memberId: club.adminMemberId,
				clubRole: "member",
				actorMemberId: other,
			}),
		);
		expect(String(err)).toContain("last admin");
		expect(await activeAdminIds()).toEqual([club.adminMemberId]);
	});

	// protects=a merge that starts while an End is in flight on the keeper waits for it and derives its status from the ENDED row, so the merged member stays former;
	// fails_when=collapseMemberships reads the keeper without a row lock, so a stale active read overwrites the End and the member is revived;
	// no_claim=the row-level half alone (the merge-locks-both-rows test above holds the row without the club lock).
	it("a merge queued behind End reads the keeper as ended", async () => {
		const keeper = await addMember("Keeper Kay");
		const absorbed = await addMember("Absorbed Abe", {
			status: "former",
			endedAt: "2026-01-01",
		});
		const held = await addSlot(club.meetingId, keeper);
		const parked = await parkEnd(keeper, held);
		const err = await raceBehind(parked.holder, "advisory", () =>
			testDb.transaction((tx) =>
				collapseMemberships(tx, club.clubId, keeper, absorbed),
			),
		);
		expect(err).toBeNull();
		const row = await memberRow(keeper);
		expect(row.status).toBe("former");
		expect(row.endedAt).not.toBeNull();
	});

	// protects=a speaker claim and an officer's profile edit of the same member do not deadlock (40P01): the claim takes the Person before the member row, as the edit does;
	// fails_when=the claim takes the member FOR SHARE before the Person: it holds the member the edit's UPDATE needs while its speech insert key-shares the Person the edit holds FOR UPDATE;
	// no_claim=the edit's own writes (members-edit tests).
	it("a speaker claim and a profile edit of the same member do not deadlock", async () => {
		const speaker = await addMember("Speaking Sam");
		const [row] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, speaker));
		const spk = await speakerSlotAndSpeech(row?.personId as string);
		// Park the claim after its member lock, on the slot's write: a blocker holds
		// the slot row.
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select 1 from role_slots where id = ${spk.slotId} for update`,
			);
		});
		const claim = testDb.transaction((tx) =>
			claimSlotCore(tx, {
				slotId: spk.slotId,
				memberId: speaker,
				actorMemberId: speaker,
				proof: "session",
				speakerDetails: { speechTitle: "My Ice Breaker" },
			}),
		);
		claim.catch(() => {});
		let claimPid: number;
		let edit: Promise<unknown> | undefined;
		try {
			claimPid = await waitForLockWait("role_slots", blocker.pid);
			edit = applyMemberEdit({
				clubId: club.clubId,
				memberId: speaker,
				name: "Speaking Samuel",
				actorMemberId: club.adminMemberId,
			});
			edit.catch(() => {});
			// The edit is queued behind the claim, whichever lock it asks for first.
			await waitForLockWait("", claimPid);
		} finally {
			await blocker.commit();
		}
		const [claimErr, editErr] = await Promise.all([
			settle(claim),
			settle(edit as Promise<unknown>),
		]);
		expect(claimErr && isDeadlock(claimErr)).toBeFalsy();
		expect(editErr && isDeadlock(editErr)).toBeFalsy();
		expect(claimErr).toBeNull();
		expect(editErr).toBeNull();
		expect(await slot(spk.slotId)).toMatchObject({ assignedMemberId: speaker });
	});

	// protects=assign_roles naming a member and an officer's profile edit of that member do not deadlock (40P01): the batch takes the Person before it holds the member row `FOR SHARE`, as the edit does;
	// fails_when=assign_roles holds the member FOR SHARE (loadTargetMembers) with no Person lock ahead of it, so reassignSlotCore's Person lock then waits on the edit's FOR UPDATE while the edit's UPDATE waits on the share;
	// no_claim=the claim path (the speaker-claim test above).
	it("assign_roles and a profile edit of the same member do not deadlock", async () => {
		const token = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: club.adminUserId, tokenHash: hashApiToken(token) });
		const target = await addMember("Target Tess");
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select 1 from role_slots where id = ${club.slotId} for update`,
			);
		});
		const call = assignRolesTool.handler(
			{
				meetingId: club.meetingId,
				assignments: [{ slotId: club.slotId, memberId: target }],
			},
			{ rawToken: token },
		);
		call.catch(() => {});
		let edit: Promise<unknown> | undefined;
		try {
			const callPid = await waitForLockWait("role_slots", blocker.pid);
			edit = applyMemberEdit({
				clubId: club.clubId,
				memberId: target,
				name: "Target Tessa",
				actorMemberId: club.adminMemberId,
			});
			edit.catch(() => {});
			await waitForLockWait("", callPid);
		} finally {
			await blocker.commit();
		}
		const [callErr, editErr] = await Promise.all([
			settle(call),
			settle(edit as Promise<unknown>),
		]);
		expect(callErr && isDeadlock(callErr)).toBeFalsy();
		expect(editErr && isDeadlock(editErr)).toBeFalsy();
		expect(callErr).toBeNull();
		expect(editErr).toBeNull();
		expect(await slot(club.slotId)).toMatchObject({ assignedMemberId: target });
	});

	// protects=a reassign aimed at a member who is being removed does not deadlock with the removal (40P01): the reassign takes the shared merge lock first, so the removal serializes it;
	// fails_when=reassignSlotCore locks the member FOR SHARE without the merge lock: it holds the member the removal's FOR UPDATE needs while it waits for a slot the removal holds;
	// no_claim=reassigning to a member who is not being removed.
	it("a reassign to a member being removed does not deadlock with the removal", async () => {
		const going = await addMember("Going Gus");
		const heldSlot = await addSlot(club.meetingId, going);
		// The removal parks on the slot a blocker holds, merge lock already taken.
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select 1 from role_slots where id = ${heldSlot} for update`,
			);
		});
		const removal = applyMemberRemove({
			clubId: club.clubId,
			memberId: going,
			actorMemberId: club.adminMemberId,
		});
		removal.catch(() => {});
		let reassign: Promise<unknown> | undefined;
		try {
			const removalPid = await waitForLockWait("role_slots", blocker.pid);
			reassign = testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: heldSlot,
					memberId: going,
					actorMemberId: club.adminMemberId,
					proof: "session",
				}),
			);
			reassign.catch(() => {});
			// Queued behind the removal at the merge lock, before it takes the member.
			await waitForLockWait("advisory", removalPid);
		} finally {
			await blocker.commit();
		}
		const [removeErr, reassignErr] = await Promise.all([
			settle(removal),
			settle(reassign as Promise<unknown>),
		]);
		expect(removeErr && isDeadlock(removeErr)).toBeFalsy();
		expect(reassignErr && isDeadlock(reassignErr)).toBeFalsy();
		expect(removeErr).toBeNull();
		// The member is gone when the reassign gets in.
		expect(String(reassignErr)).toContain(CLUB_BUSY_MESSAGE);
	});
});
