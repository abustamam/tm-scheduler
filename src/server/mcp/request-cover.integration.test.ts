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
import { readFileSync } from "node:fs";
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

// A driver-style failure inside the undo core, armed per test.
const boom = vi.hoisted(() => ({ on: false }));
vi.mock("#/server/cover-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/server/cover-logic")>();
	return {
		...actual,
		undoReleaseForCoverCore: (
			...a: Parameters<typeof actual.undoReleaseForCoverCore>
		) => {
			if (boom.on) {
				throw new Error(
					'Failed query: update "role_slots" set "assigned_member_id" = $1 params: 0000-secret',
				);
			}
			return actual.undoReleaseForCoverCore(...a);
		},
	};
});

const { requestCoverTool } = await import("#/server/mcp/tools/request-cover");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");
const { claimSlotCore } = await import("#/server/slots-logic");
const { ALREADY_TAKEN_MESSAGE, ONLY_RELEASER_MESSAGE } = await import(
	"#/server/cover-logic"
);

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

async function expectBlocked(
	p: Promise<unknown>,
	code: string,
	message?: string,
) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	if (message) expect((err as Error).message).toBe(message);
}

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
		expect(await requests(s)).toEqual([
			{ kind: "finding_cover", by: s.memberId },
		]);

		await call(token, { ...args, planHash: p.planHash });
		expect(await slotRow(s)).toEqual({ holder: s.memberId, status: "claimed" });
		expect(await requests(s)).toEqual([]);
	});

	it("undo: refused once another member claims the role", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const p = await preview(token, args);
		await testDb.transaction((tx) =>
			claimSlotCore(tx, {
				slotId: s.slotId,
				memberId: s.adminMemberId,
				actorMemberId: s.adminMemberId,
			}),
		);
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"PLAN_STALE",
		);
		const fresh = await preview(token, args);
		expect(fresh.blocking).toEqual([
			{ code: "ALREADY_TAKEN", message: ALREADY_TAKEN_MESSAGE },
		]);
		await expectBlocked(
			Promise.resolve(call(token, { ...args, planHash: fresh.planHash })),
			"BLOCKED",
			ALREADY_TAKEN_MESSAGE,
		);
		expect((await slotRow(s))?.holder).toBe(s.adminMemberId);
	});

	it("undo with no cover request ever made says so", async () => {
		const s = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, {
			meetingId: s.meetingId,
			role: "Timer",
			action: "undo",
		});
		expect(p.blocking).toEqual([
			{
				code: "NO_COVER_REQUEST",
				message: "You have no cover request on that role.",
			},
		]);
	});

	it("undo by another member names the releaser rule", async () => {
		const s = await club();
		await released(s, await tokenFor(s.memberUserId), "dropped");
		const p = await preview(await tokenFor(s.adminUserId), {
			meetingId: s.meetingId,
			role: "Timer",
			action: "undo",
		});
		expect(p.blocking).toEqual([
			{ code: "NOT_YOURS", message: ONLY_RELEASER_MESSAGE },
		]);
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

	it("a core driver error is not surfaced as BLOCKED", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const p = await preview(token, args);
		boom.on = true;
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const err = await Promise.resolve(
				call(token, { ...args, planHash: p.planHash }),
			).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).not.toBeNull();
			// Not turned into a BLOCKED refusal; the route's toMcpError hides it.
			expect(err).not.toBeInstanceOf(McpError);
			const { toMcpError } = await import("#/server/mcp/errors");
			const mapped = toMcpError(err, "request_cover");
			expect(mapped.code).toBe("INTERNAL");
			expect(mapped.message).not.toContain("secret");
		} finally {
			boom.on = false;
			spy.mockRestore();
		}
		expect(await requests(s)).toHaveLength(1);
	});

	it("a request undone and re-made between preview and apply is PLAN_STALE", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const old = await preview(token, args);
		const fresh = await preview(token, args);
		await call(token, { ...args, planHash: fresh.planHash });
		await released(s, token, "finding_cover");
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: old.planHash })),
			"PLAN_STALE",
		);
		expect(await requests(s)).toHaveLength(1);
		expect((await slotRow(s))?.holder).toBeNull();
	});

	it("a changed prior_* column changes the plan hash", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "undo" };
		const a = await preview(token, args);
		await testDb
			.update(slotCoverRequests)
			.set({ priorStatus: "confirmed" })
			.where(eq(slotCoverRequests.slotId, s.slotId));
		const b = await preview(token, args);
		expect(b.planHash).not.toBe(a.planHash);
	});

	it("ask on a request that is already finding_cover leaves it so", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "finding_cover");
		const args = { meetingId: s.meetingId, role: "Timer", action: "ask" };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		await call(token, { ...args, planHash: p.planHash });
		expect(await requests(s)).toEqual([
			{ kind: "finding_cover", by: s.memberId },
		]);
	});

	it.each([
		["undo", "completed"],
		["undo", "cancelled"],
		["ask", "completed"],
		["ask", "cancelled"],
	] as const)("%s on a %s meeting is LOCKED at apply", async (action, status) => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		await released(s, token, "dropped");
		const args = { meetingId: s.meetingId, role: "Timer", action };
		const p = await preview(token, args);
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, s.meetingId));
		await expectMcpError(
			Promise.resolve(call(token, { ...args, planHash: p.planHash })),
			"LOCKED",
		);
		expect(await requests(s)).toEqual([{ kind: "dropped", by: s.memberId }]);
	});

	it("a member holding two matching slots gets AMBIGUOUS_ROLE; a numbered label picks one", async () => {
		const s = await club();
		const [def] = await testDb
			.select({ id: roleSlots.roleDefinitionId, idx: roleSlots.slotIndex })
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		const [second] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: s.meetingId,
				roleDefinitionId: def?.id ?? "",
				slotIndex: (def?.idx ?? 0) + 1,
				status: "claimed",
				assignedMemberId: s.memberId,
			})
			.returning({ id: roleSlots.id });
		await hold(s, s.memberId);
		const token = await tokenFor(s.memberUserId);
		const base = { meetingId: s.meetingId, action: "release", kind: "dropped" };
		const amb = await preview(token, { ...base, role: "Timer" });
		expect(amb.blocking.map((b) => b.code)).toEqual(["AMBIGUOUS_ROLE"]);
		await expectMcpError(
			Promise.resolve(
				call(token, { ...base, role: "Timer", planHash: amb.planHash }),
			),
			"BLOCKED",
		);

		const args = { ...base, role: "Timer 2" };
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan.slotLabel).toBe("Timer 2");
		await call(token, { ...args, planHash: p.planHash });
		expect((await slotRow(s))?.holder).toBe(s.memberId);
		const [row] = await testDb
			.select({ status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, second?.id ?? ""));
		expect(row?.status).toBe("open");
	});

	it("a token from another club is FORBIDDEN", async () => {
		const s = await club();
		const other = await club();
		await hold(s, s.memberId);
		const token = await tokenFor(other.memberUserId);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					action: "release",
					kind: "dropped",
				}),
			),
			"FORBIDDEN",
		);
		expect((await slotRow(s))?.holder).toBe(s.memberId);
	});

	it("imports no mail, email or notification module", () => {
		const src = readFileSync(
			new URL("./tools/request-cover.ts", import.meta.url),
			"utf8",
		);
		const imports = src
			.split("\n")
			.filter((l) => /^\s*(import|\} from)\b/.test(l) || /^\} from /.test(l));
		expect(imports.length).toBeGreaterThan(5);
		for (const l of imports) {
			expect(l).not.toMatch(/mail|notif|resend|sms/i);
		}
	});

	it("takes no member id", () => {
		expect(
			Object.keys(requestCoverTool.config.inputSchema ?? {}).sort(),
		).toEqual(["action", "kind", "meetingId", "planHash", "role"]);
	});
});
