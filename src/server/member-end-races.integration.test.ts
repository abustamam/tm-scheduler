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
import { apiTokens, guests, members, people, roleSlots } from "#/db/schema";
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

const { applySetMemberStatus } = await import("#/server/members-logic");
const { logActivity } = await import("#/server/activity");
const { collapseMemberships } = await import(
	"#/server/membership-collapse-logic"
);
const { applyLinkGuestToMember, LINK_MEMBER_FORMER_MESSAGE } = await import(
	"#/server/guest-pipeline-logic"
);
const { claimSlotCore, reassignSlotCore } = await import(
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

	const end = (memberId: string, actorMemberId = club.adminMemberId) =>
		applySetMemberStatus({
			clubId: club.clubId,
			memberId,
			status: "former",
			actorMemberId,
		});

	/**
	 * Start ending `memberId` and park it: it holds the club write lock and the
	 * member row, has flipped the row, and waits on `heldSlotId`, a slot a
	 * blocking transaction holds. `finish()` lets the End run to commit.
	 */
	async function parkEnd(
		memberId: string,
		heldSlotId: string,
		actorMemberId = club.adminMemberId,
	) {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select 1 from role_slots where id = ${heldSlotId} for update`,
			);
		});
		const ending = end(memberId, actorMemberId);
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
		return {
			endPid,
			ending,
			finish: async () => {
				if (finished) return;
				finished = true;
				await blocker.commit();
				await ending;
			},
		};
	}

	it("a claim queued behind End is refused, and the slot stays open", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		let claim: Promise<unknown> | undefined;
		try {
			claim = testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: club.slotId,
					memberId: leaver,
					actorMemberId: leaver,
					proof: "asserted",
				}),
			);
			claim.catch(() => {});
			// Blocked on the member row End holds, BEFORE it touches the slot.
			await waitForLockWait("share", parked.endPid);
		} finally {
			await parked.finish();
		}
		expect(String(await settle(claim as Promise<unknown>))).toContain(
			MEMBER_NOT_ELIGIBLE_MESSAGE,
		);
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
		let reassign: Promise<unknown> | undefined;
		try {
			reassign = testDb.transaction((tx) =>
				reassignSlotCore(tx, {
					slotId: club.slotId,
					memberId: leaver,
					actorMemberId: club.adminMemberId,
					proof: "session",
				}),
			);
			reassign.catch(() => {});
			await waitForLockWait("share", parked.endPid);
		} finally {
			await parked.finish();
		}
		expect(String(await settle(reassign as Promise<unknown>))).toContain(
			MEMBER_NOT_ELIGIBLE_MESSAGE,
		);
		expect(await slot(club.slotId)).toMatchObject({
			status: "open",
			assignedMemberId: null,
		});
	});

	it("assign_roles queued behind End does not put the ended member on the agenda", async () => {
		const token = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: club.adminUserId, tokenHash: hashApiToken(token) });
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);
		const parked = await parkEnd(leaver, held);
		let call: Promise<unknown> | undefined;
		try {
			call = assignRolesTool.handler(
				{
					meetingId: club.meetingId,
					assignments: [{ slotId: club.slotId, memberId: leaver }],
				},
				{ rawToken: token },
			);
			call.catch(() => {});
			await waitForLockWait("share", parked.endPid);
		} finally {
			await parked.finish();
		}
		const err = (await settle(call as Promise<unknown>)) as {
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
		let link: Promise<unknown> | undefined;
		try {
			link = applyLinkGuestToMember({
				clubId: club.clubId,
				guestId: g.id,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			});
			link.catch(() => {});
			await waitForLockWait("advisory", parked.endPid);
		} finally {
			await parked.finish();
		}
		expect(String(await settle(link as Promise<unknown>))).toContain(
			LINK_MEMBER_FORMER_MESSAGE,
		);
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
	async function holdEndedRow(memberId: string) {
		return openBlockingTx(async (tx) => {
			await tx
				.update(members)
				.set({ status: "former", endedAt: "2026-10-27" })
				.where(eq(members.id, memberId));
		});
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
		const held = await holdEndedRow(leaver);
		let link: Promise<unknown> | undefined;
		try {
			link = applyLinkGuestToMember({
				clubId: club.clubId,
				guestId: g.id,
				memberId: leaver,
				actorMemberId: club.adminMemberId,
			});
			link.catch(() => {});
			await waitForLockWait("share", held.pid);
		} finally {
			await held.commit();
		}
		expect(String(await settle(link as Promise<unknown>))).toContain(
			LINK_MEMBER_FORMER_MESSAGE,
		);
	});

	it("a merge locks both rows before deriving the status, so it waits for an End on the row", async () => {
		const keeper = await addMember("Keeper Kay");
		const absorbed = await addMember("Absorbed Abe", {
			status: "former",
			endedAt: "2026-01-01",
		});
		const held = await holdEndedRow(keeper);
		let merge: Promise<unknown> | undefined;
		try {
			merge = testDb.transaction((tx) =>
				collapseMemberships(tx, club.clubId, keeper, absorbed),
			);
			merge.catch(() => {});
			await waitForLockWait("no key update", held.pid);
		} finally {
			await held.commit();
		}
		expect(await settle(merge as Promise<unknown>)).toBeNull();
		expect(await memberRow(keeper)).toMatchObject({
			status: "former",
			endedAt: "2026-10-27",
		});
	});

	it("End does not deadlock with the member releasing their own role", async () => {
		const leaver = await addMember("Leaving Lee");
		const held = await addSlot(club.meetingId, leaver);

		// The release, in the order that cycled: it holds the slot, then its
		// activity-log insert needs a key-share on the member row End holds.
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
			await tx.execute(
				sql`select 1 from role_slots where id = ${held} for update`,
			);
			ready(Number((res.rows[0] as { pid: number }).pid));
			await gate;
			await logActivity(tx, {
				clubId: club.clubId,
				actorMemberId: leaver,
				action: "release",
				targetType: "slot",
				targetId: held,
				detail: {},
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

	it("two admins ending each other leave one active admin", async () => {
		const other = await addMember("Second Admin", { clubRole: "admin" });
		const otherSlot = await addSlot(club.meetingId, other);
		// End 1 ends `other` (acting as the seeded admin) and parks, its last-admin
		// check already passed against the seeded admin.
		const first = await parkEnd(other, otherSlot, club.adminMemberId);
		let second: Promise<unknown> | undefined;
		try {
			// End 2 ends the seeded admin, acting as `other`. It must wait for End 1.
			second = end(club.adminMemberId, other);
			second.catch(() => {});
			await waitForLockWait("advisory", first.endPid);
		} finally {
			await first.finish();
		}
		const secondErr = await settle(second as Promise<unknown>);
		expect(String(secondErr)).toContain("last admin");
		const active = await testDb
			.select({ id: members.id })
			.from(members)
			.where(
				and(
					eq(members.clubId, club.clubId),
					eq(members.status, "active"),
					eq(members.clubRole, "admin"),
				),
			);
		expect(active.map((a) => a.id)).toEqual([club.adminMemberId]);
	});

	it("a merge queued behind End reads the keeper as ended", async () => {
		const keeper = await addMember("Keeper Kay");
		const absorbed = await addMember("Absorbed Abe", {
			status: "former",
			endedAt: "2026-01-01",
		});
		const held = await addSlot(club.meetingId, keeper);
		const parked = await parkEnd(keeper, held);
		let merge: Promise<unknown> | undefined;
		try {
			merge = testDb.transaction((tx) =>
				collapseMemberships(tx, club.clubId, keeper, absorbed),
			);
			merge.catch(() => {});
			await waitForLockWait("advisory", parked.endPid);
		} finally {
			await parked.finish();
		}
		expect(await settle(merge as Promise<unknown>)).toBeNull();
		const row = await memberRow(keeper);
		expect(row.status).toBe("former");
		expect(row.endedAt).not.toBeNull();
	});
});
