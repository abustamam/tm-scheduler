/**
 * DB-backed tests for `request_cover` (#1569), called with a real minted token.
 *
 * Card (shared): protects=a member's agent releases, undoes and upgrades a cover
 * request on their OWN role only, after a preview, with the app's own cover
 * rules; fails_when=a preview writes, someone else's role or request is touched,
 * a taken role is overwritten, or a locked meeting accepts the write;
 * no_claim=tokens are minted directly (no OAuth round trip).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	meetingAttendancePlan,
	meetings,
	roleSlots,
	slotCoverRequests,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { requestCoverTool } = await import("#/server/mcp/tools/request-cover");
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
	plan: { slotLabel: string | null; kind: string | null };
	planHash: string;
	blocking: { code: string; message: string }[];
};

function call(token: string, args: Record<string, unknown>) {
	return requestCoverTool.handler(args, {
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
async function requests(s: SeededClub) {
	return testDb
		.select({
			kind: slotCoverRequests.kind,
			by: slotCoverRequests.releasedByMemberId,
		})
		.from(slotCoverRequests)
		.where(eq(slotCoverRequests.slotId, s.slotId));
}

/** The member holds Timer and has released it with `kind`. */
async function released(s: SeededClub, token: string, kind: string) {
	await hold(s, s.memberId);
	const args = {
		meetingId: s.meetingId,
		role: "Timer",
		action: "release",
		kind,
	};
	const p = await preview(token, args);
	await call(token, { ...args, planHash: p.planHash });
}

describe.skipIf(!hasTestDb)("request_cover (#1569)", () => {
	it("release: previews without writing, then reopens the slot with one request", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			role: "timer",
			action: "release",
			kind: "finding_cover",
		};
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan).toMatchObject({ slotLabel: "Timer", kind: "finding_cover" });
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await requests(s)).toEqual([]);

		await call(token, { ...args, planHash: p.planHash });
		expect(await slotRow(s)).toEqual({ holder: null, status: "open" });
		expect(await requests(s)).toEqual([
			{ kind: "finding_cover", by: s.memberId },
		]);
	});

	it("release needs a kind", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, {
			meetingId: s.meetingId,
			role: "Timer",
			action: "release",
		});
		expect(p.blocking.map((b) => b.code)).toEqual(["KIND_REQUIRED"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					action: "release",
					planHash: p.planHash,
				}),
			),
			"BLOCKED",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	it("release: a caller who is not the holder is refused", async () => {
		const s = await club();
		await hold(s, s.adminMemberId);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			role: "Timer",
			action: "release",
			kind: "dropped",
		};
		const p = await preview(token, args);
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_YOURS"]);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"BLOCKED",
		);
		expect(await slotRow(s)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
		expect(await requests(s)).toEqual([]);
	});

	it("undo: previews without writing, then gives the role back", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(await slotRow(s)).toEqual({ holder: null, status: "open" });
		expect(await requests(s)).toHaveLength(1);

		await call(token, { ...args, planHash: p.planHash });
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await requests(s)).toEqual([]);
	});

	it("undo: refused once another member holds the role", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const p = await preview(token, args);
		await hold(s, s.adminMemberId);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		const fresh = await preview(token, args);
		expect(fresh.blocking.length).toBeGreaterThan(0);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: fresh.planHash })),
			"BLOCKED",
		);
		expect((await slotRow(s))?.holder).toBe(s.adminMemberId);
	});

	it("undo: refused while the releaser said not coming", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "dropped");
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		const p = await preview(token, {
			meetingId: s.meetingId,
			role: "Timer",
			action: "undo",
		});
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_COMING"]);
		expect((await slotRow(s))?.holder).toBeNull();
	});

	it("ask: changes the request kind to finding_cover and nothing else", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "dropped");
		const args = { meetingId: s.meetingId, role: "Timer", action: "ask" };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect((await requests(s))[0]?.kind).toBe("dropped");

		await call(token, { ...args, planHash: p.planHash });
		expect(await requests(s)).toEqual([
			{ kind: "finding_cover", by: s.memberId },
		]);
		expect(await slotRow(s)).toEqual({ holder: null, status: "open" });
	});

	it("undo and ask: not the releaser is refused (second member)", async () => {
		const s = await club();
		const memberToken = await tokenFor(s.memberUserId);
		await released(s, memberToken, "dropped");
		const adminToken = await tokenFor(s.adminUserId);
		for (const action of ["undo", "ask"]) {
			const args = { meetingId: s.meetingId, role: "Timer", action };
			const p = await preview(adminToken, args);
			expect(p.blocking.map((b) => b.code)).toEqual(["NOT_YOURS"]);
			await expectMcpError(
				Promise.resolve(call(adminToken, { ...args, planHash: p.planHash })),
				"BLOCKED",
			);
		}
		expect(await requests(s)).toEqual([{ kind: "dropped", by: s.memberId }]);
		expect((await slotRow(s))?.holder).toBeNull();
	});

	it("a completed meeting is LOCKED at apply; a stale hash is PLAN_STALE", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			role: "Timer",
			action: "release",
			kind: "dropped",
		};
		const p = await preview(token, args);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: "0".repeat(64) })),
			"PLAN_STALE",
		);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, s.meetingId));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"LOCKED",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
		expect(await requests(s)).toEqual([]);
	});

	it("a cancelled meeting is LOCKED at apply", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const args = {
			meetingId: s.meetingId,
			role: "Timer",
			action: "release",
			kind: "dropped",
		};
		const p = await preview(token, args);
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"LOCKED",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
		expect(await requests(s)).toEqual([]);
	});

	it("takes no member id", () => {
		expect(
			Object.keys(requestCoverTool.config.inputSchema ?? {}).sort(),
		).toEqual(["action", "kind", "meetingId", "planHash", "role"]);
	});
});
