/**
 * DB-backed tests for `release_my_role` (#1568), called with a real minted token.
 *
 * Card (shared): protects=a member's agent releases or hands off a role THEY hold,
 * after a preview, through the app's own slot writers; fails_when=a preview
 * writes, another member's role is released or moved, a changed holder is
 * applied over, or a locked meeting or archived club accepts the write;
 * no_claim=tokens are minted directly (no OAuth round trip).
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	meetings,
	members,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { releaseMyRoleTool } = await import(
	"#/server/mcp/tools/release-my-role"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

type Preview = {
	plan: {
		slotLabel: string | null;
		action: string;
		toMember: { memberId: string } | null;
		speech: string | null;
	};
	planHash: string;
	blocking: { code: string; message: string }[];
};

function call(token: string, args: Record<string, unknown>) {
	return releaseMyRoleTool.handler(args, {
		rawToken: token,
		audience: "member",
	});
}
const preview = (token: string, args: Record<string, unknown>) =>
	call(token, args) as Promise<Preview>;

async function expectMcpError(p: Promise<unknown>, code: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	return err as InstanceType<typeof McpError>;
}

async function hold(s: SeededClub, memberId: string | null) {
	await testDb
		.update(roleSlots)
		.set({
			assignedMemberId: memberId,
			status: memberId ? "claimed" : "open",
		})
		.where(eq(roleSlots.id, s.slotId));
}
async function slotRow(s: SeededClub) {
	const [row] = await testDb
		.select({ holder: roleSlots.assignedMemberId, status: roleSlots.status })
		.from(roleSlots)
		.where(eq(roleSlots.id, s.slotId));
	return row;
}
async function log(s: SeededClub, action: string) {
	const rows = await testDb
		.select({
			actor: activityLog.actorMemberId,
			detail: activityLog.detail,
			action: activityLog.action,
		})
		.from(activityLog)
		.where(eq(activityLog.clubId, s.clubId));
	return rows.filter((r) => r.action === action);
}

describe.skipIf(!hasTestDb)("release_my_role (#1568)", () => {
	it("release: previews without writing, then opens the slot and logs it", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "timer" };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan).toMatchObject({ slotLabel: "Timer", action: "release" });
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await log(s, "release")).toEqual([]);

		await call(token, { ...args, planHash: p.planHash });
		expect(await slotRow(s)).toEqual({ holder: null, status: "open" });
		const rows = await log(s, "release");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actor).toBe(s.memberId);
		expect(rows[0]?.detail).toMatchObject({
			fromMemberId: s.memberId,
			proof: "connector",
		});
	});

	it("handoff: previews without writing, then the named member holds it and it logs a reassign", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			role: "Timer",
			toMemberId: s.adminMemberId,
		};
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan).toMatchObject({
			action: "handoff",
			toMember: { memberId: s.adminMemberId },
		});
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });

		await call(token, { ...args, planHash: p.planHash });
		expect(await slotRow(s)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
		const rows = await log(s, "reassign");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actor).toBe(s.memberId);
		expect(rows[0]?.detail).toMatchObject({
			fromMemberId: s.memberId,
			memberId: s.adminMemberId,
			proof: "connector",
		});
	});

	it("a toMemberId equal to the caller is refused as a no-op", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					toMemberId: s.memberId,
				}),
			),
			"VALIDATION",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	it("a role the caller does not hold is blocked in the preview and never written", async () => {
		const s = await club();
		await hold(s, s.adminMemberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer" };
		const p = await preview(token, args);
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_YOURS"]);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"BLOCKED",
		);
		// Nor by naming the slot, nor by handing it on.
		for (const extra of [
			{ slotId: s.slotId },
			{ toMemberId: s.adminMemberId },
		]) {
			const q = await preview(token, { ...args, ...extra });
			expect(q.blocking.map((b) => b.code)).toEqual(["NOT_YOURS"]);
			await expectMcpError(
				Promise.resolve(
					call(token, { ...args, ...extra, planHash: q.planHash }),
				),
				"BLOCKED",
			);
		}
		expect(await slotRow(s)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
		expect(await log(s, "release")).toEqual([]);
		expect(await log(s, "reassign")).toEqual([]);
	});

	it("the holder changing between preview and apply is PLAN_STALE and writes nothing", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer" };
		const p = await preview(token, args);
		await hold(s, s.adminMemberId);
		const err = await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({
			blocking: [expect.objectContaining({ code: "NOT_YOURS" })],
		});
		expect(await slotRow(s)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
		expect(await log(s, "release")).toEqual([]);
	});

	it("two slots with the same label: blocked until slotId picks one of the caller's own", async () => {
		const s = await club();
		const [base] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		if (!base) throw new Error("seed slot missing");
		const { id: _id, ...rest } = base;
		const [second] = await testDb
			.insert(roleSlots)
			.values({
				...rest,
				slotIndex: base.slotIndex + 1,
				assignedMemberId: s.adminMemberId,
				status: "claimed",
			})
			.returning({ id: roleSlots.id });
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		// The caller holds one, the admin the other: the caller's is unambiguous.
		const p = await preview(token, { meetingId: s.meetingId, role: "Timer" });
		expect(p.blocking).toEqual([]);
		// Make both the caller's.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: s.memberId })
			.where(eq(roleSlots.id, second?.id ?? ""));
		const amb = await preview(token, { meetingId: s.meetingId, role: "Timer" });
		expect(amb.blocking.map((b) => b.code)).toEqual(["AMBIGUOUS_SLOT"]);
		expect(amb.blocking[0]?.message).toContain(s.slotId);
		const args = { meetingId: s.meetingId, role: "Timer", slotId: s.slotId };
		const ok = await preview(token, args);
		expect(ok.blocking).toEqual([]);
		await call(token, { ...args, planHash: ok.planHash });
		expect(await slotRow(s)).toEqual({ holder: null, status: "open" });
		const [kept] = await testDb
			.select({ holder: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(eq(roleSlots.id, second?.id ?? ""));
		expect(kept?.holder).toBe(s.memberId);
	});

	it("a recipient who is not an active member of the club is blocking", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const stranger = await club();
		for (const toMemberId of [stranger.memberId, randomUUID()]) {
			const p = await preview(token, {
				meetingId: s.meetingId,
				role: "Timer",
				toMemberId,
			});
			expect(p.blocking.map((b) => b.code)).toEqual(["TARGET_NOT_ACTIVE"]);
		}
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, s.adminMemberId));
		const p = await preview(token, {
			meetingId: s.meetingId,
			role: "Timer",
			toMemberId: s.adminMemberId,
		});
		expect(p.blocking.map((b) => b.code)).toEqual(["TARGET_NOT_ACTIVE"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					toMemberId: s.adminMemberId,
					planHash: p.planHash,
				}),
			),
			"BLOCKED",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	it("completed and cancelled meetings are LOCKED; an archived club is ARCHIVED", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer" };
		const p = await preview(token, args);
		for (const status of ["completed", "cancelled"] as const) {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, s.meetingId));
			await expectMcpError(
				Promise.resolve(call(token, { ...args, planHash: p.planHash })),
				"LOCKED",
			);
		}
		await testDb
			.update(meetings)
			.set({ status: "scheduled" })
			.where(eq(meetings.id, s.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"ARCHIVED",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	it("a stale planHash is PLAN_STALE with a fresh plan", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					planHash: "0".repeat(64),
				}),
			),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({
			plan: { slotLabel: "Timer" },
			planHash: expect.any(String),
		});
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	/** A second Timer slot (same meeting, same role) held by `holder`. */
	async function secondTimer(s: SeededClub, holder: string | null) {
		const [base] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		if (!base) throw new Error("seed slot missing");
		const { id: _id, ...rest } = base;
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				...rest,
				slotIndex: base.slotIndex + 1,
				assignedMemberId: holder,
				status: holder ? "claimed" : "open",
			})
			.returning({ id: roleSlots.id });
		if (!row) throw new Error("insert returned no row");
		return row.id;
	}
	async function holderOf(slotId: string) {
		const [row] = await testDb
			.select({ holder: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return row?.holder ?? null;
	}

	it("another member's slotId is refused even when the caller holds a slot with the same label", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const theirs = await secondTimer(s, s.adminMemberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer", slotId: theirs };
		const p = await preview(token, args);
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_YOURS"]);
		expect(p.plan.slotLabel).toBeNull();
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"BLOCKED",
		);
		expect(await holderOf(theirs)).toBe(s.adminMemberId);
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await log(s, "release")).toEqual([]);
	});

	it("a change of holder on another matching slot alone (plan text identical) is PLAN_STALE", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const other = await secondTimer(s, s.adminMemberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer", slotId: s.slotId };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, status: "open" })
			.where(eq(roleSlots.id, other));
		const fresh = await preview(token, args);
		expect(fresh.plan).toEqual(p.plan);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await log(s, "release")).toEqual([]);
	});

	it("a linked speech warns whatever the role, is unlinked on apply and never deleted; a swapped speech is PLAN_STALE", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const [adminRow] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, s.adminMemberId));
		const personId = adminRow?.personId ?? "";
		const mk = async (title: string) => {
			const [row] = await testDb
				.insert(speeches)
				.values({ personId, title })
				.returning({ id: speeches.id });
			if (!row) throw new Error("insert returned no row");
			return row.id;
		};
		const first = await mk("Ice Breaker");
		const second = await mk("Second");
		const link = (id: string) =>
			testDb
				.update(roleSlots)
				.set({ speechId: id })
				.where(eq(roleSlots.id, s.slotId));
		await link(first);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer" };
		const p = await preview(token, args);
		expect(p.plan.speech).toContain("unlinks it from the slot");
		expect(p.plan.speech).toContain("not deleted");

		// Swap the linked speech: same plan text, different hash.
		await link(second);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);

		const q = await preview(token, args);
		await call(token, { ...args, planHash: q.planHash });
		const [slot] = await testDb
			.select({
				speechId: roleSlots.speechId,
				holder: roleSlots.assignedMemberId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		expect(slot).toEqual({ speechId: null, holder: null });
		const kept = await testDb
			.select({ id: speeches.id })
			.from(speeches)
			.where(eq(speeches.personId, personId));
		expect(kept.map((r) => r.id).sort()).toEqual([first, second].sort());
	});

	it("the holder is re-checked under the slot row's lock: a holder who changes while the apply waits blocks it", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = { meetingId: s.meetingId, role: "Timer" };
		const p = await preview(token, args);

		// Connection A takes the slot row's lock and moves the role to the admin,
		// uncommitted. The apply (connection B) takes the club lock, recomputes
		// against the OLD holder (READ COMMITTED), so the hash still matches, and
		// then blocks in `lockedHolder`'s FOR UPDATE until A commits.
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let locked: () => void = () => {};
		const hasLock = new Promise<void>((r) => {
			locked = r;
		});
		const a = testDb.transaction(async (tx) => {
			await tx
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.id, s.slotId))
				.for("update");
			await tx
				.update(roleSlots)
				.set({ assignedMemberId: s.adminMemberId })
				.where(eq(roleSlots.id, s.slotId));
			locked();
			await gate;
		});
		await hasLock;
		const apply = call(token, { ...args, planHash: p.planHash }).then(
			() => null,
			(e: unknown) => e,
		);
		// Wait until the apply is genuinely blocked on the row lock.
		const deadline = Date.now() + 10_000;
		for (;;) {
			const res = await testDb.execute(
				sql`select count(*)::int as n from pg_stat_activity
					where wait_event_type = 'Lock' and datname = current_database()
					and query ilike '%role_slots%for update%'`,
			);
			if (Number((res.rows[0] as { n: number }).n) > 0) break;
			if (Date.now() > deadline) throw new Error("apply never blocked");
			await new Promise((r) => setTimeout(r, 25));
		}
		release();
		await a;
		const err = await apply;
		expect(err).toBeInstanceOf(McpError);
		expect((err as InstanceType<typeof McpError>).code).toBe("BLOCKED");
		expect((err as InstanceType<typeof McpError>).detail).toMatchObject({
			blocking: [expect.objectContaining({ code: "NOT_YOURS" })],
		});
		expect(await slotRow(s)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
		expect(await log(s, "release")).toEqual([]);
	});
});
