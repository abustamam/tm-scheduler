/**
 * DB-backed tests for `create_meetings` (#1572): preview writes nothing, apply
 * goes through `applyBatchCreateMeetings`, each new meeting is logged
 * `meeting_create` crediting the caller, a date taken between preview and apply
 * is `PLAN_STALE`, and the role gate and archive gate hold.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	meetings,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// A hook the collision test arms: runs once, just before the first real insert,
// to put a competing row at the same instant (a concurrent writer winning).
const beforeInsert = vi.hoisted(() => ({
	run: null as null | ((m: { scheduledAt: Date }) => Promise<void>),
}));
// Armed by the atomicity test: makes the first activity-log write fail.
const failLog = vi.hoisted(() => ({ armed: false }));
vi.mock("#/server/activity", async (importOriginal) => {
	const orig = await importOriginal<typeof import("#/server/activity")>();
	return {
		...orig,
		logActivity: async (...args: Parameters<typeof orig.logActivity>) => {
			if (failLog.armed) throw new Error("log write failed");
			return orig.logActivity(...args);
		},
	};
});
vi.mock("#/server/meeting-create-logic", async (importOriginal) => {
	const orig =
		await importOriginal<typeof import("#/server/meeting-create-logic")>();
	return {
		...orig,
		insertMeetingWithSlots: async (
			...args: Parameters<typeof orig.insertMeetingWithSlots>
		) => {
			const hook = beforeInsert.run;
			beforeInsert.run = null;
			if (hook) await hook(args[1]);
			return orig.insertMeetingWithSlots(...args);
		},
	};
});

const { hashApiToken } = await import("#/server/api-tokens-logic");
const { McpError } = await import("#/server/mcp/errors");

const { createMeetingsTool, BLOCKED_MESSAGE } = await import(
	"#/server/mcp/tools/create-meetings"
);

async function mintToken(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw) });
	return raw;
}

async function expectMcpError(
	p: Promise<unknown>,
	code: string,
	message?: string,
) {
	const err = await p.catch((e: unknown) => e);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	if (message !== undefined) {
		expect((err as InstanceType<typeof McpError>).message).toBe(message);
	}
}

interface Plan {
	lines: { date: string; status: string; reason?: string }[];
	blocking: { date: string; reason: string }[];
}
interface Preview {
	applied: false;
	plan: Plan;
	planHash: string;
}
interface Applied {
	applied: true;
	created: { meetingId: string; date: string }[];
	skipped: { date: string }[];
}

describe.skipIf(!hasTestDb)("create_meetings (#1572)", () => {
	let seed: SeededClub;
	let adminToken: string;
	let memberToken: string;

	const run = (token: string, input: Record<string, unknown>) =>
		createMeetingsTool.handler(
			{ clubId: seed.clubId, ...input },
			{ rawToken: token },
		);
	const count = async () =>
		(
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.clubId, seed.clubId))
		).length;

	beforeEach(async () => {
		seed = await seedClub();
		adminToken = await mintToken(seed.adminUserId);
		memberToken = await mintToken(seed.memberUserId);
	});
	afterEach(async () => {
		beforeInsert.run = null;
		failLog.armed = false;
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("preview reports would_create per date and writes nothing", async () => {
		const before = await count();
		const r = (await run(adminToken, {
			dates: ["2031-01-02T19:00", "2031-01-09T19:00"],
		})) as Preview;
		expect(r.applied).toBe(false);
		expect(r.plan.lines.map((l) => l.status)).toEqual([
			"would_create",
			"would_create",
		]);
		expect(await count()).toBe(before);
	});

	it("apply creates the dates with the default slots, logs meeting_create for the caller, and returns ids", async () => {
		const input = {
			dates: ["2031-01-02T19:00", "2031-01-09T19:00"],
			location: "Room 4",
		};
		const p = (await run(adminToken, input)) as Preview;
		const r = (await run(adminToken, {
			...input,
			planHash: p.planHash,
		})) as Applied;
		expect(r.applied).toBe(true);
		expect(r.created.map((c) => c.date)).toEqual(["2031-01-02", "2031-01-09"]);
		const rows = await testDb
			.select()
			.from(meetings)
			.where(
				inArray(
					meetings.id,
					r.created.map((c) => c.meetingId),
				),
			);
		expect(rows).toHaveLength(2);
		for (const m of rows) expect(m.location).toBe("Room 4");
		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, r.created[0]?.meetingId ?? ""));
		expect(slots.length).toBeGreaterThan(0);
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_create"),
				),
			);
		// Compared with the ids the DATABASE holds, not the tool's own output.
		const dbIds = (
			await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(
					and(
						eq(meetings.clubId, seed.clubId),
						gte(meetings.scheduledAt, new Date("2031-01-01T00:00:00Z")),
					),
				)
		).map((m) => m.id);
		expect(dbIds).toHaveLength(2);
		expect(logs.map((l) => l.targetId).sort()).toEqual(dbIds.sort());
		for (const l of logs) expect(l.actorMemberId).toBe(seed.adminMemberId);
	});

	it("a date that already has a meeting is skipped, in preview and apply, never duplicated", async () => {
		const first = (await run(adminToken, {
			dates: ["2031-02-06T19:00"],
		})) as Preview;
		await run(adminToken, {
			dates: ["2031-02-06T19:00"],
			planHash: first.planHash,
		});
		const input = { dates: ["2031-02-06T19:00", "2031-02-13T19:00"] };
		const p = (await run(adminToken, input)) as Preview;
		expect(p.plan.lines.map((l) => l.status)).toEqual([
			"skipped",
			"would_create",
		]);
		const before = await count();
		const r = (await run(adminToken, {
			...input,
			planHash: p.planHash,
		})) as Applied;
		expect(r.created).toHaveLength(1);
		expect(r.skipped.map((s) => s.date)).toEqual(["2031-02-06"]);
		expect(await count()).toBe(before + 1);
	});

	it("a date taken between preview and apply is PLAN_STALE and writes nothing", async () => {
		const input = { dates: ["2031-03-06T19:00"] };
		const p = (await run(adminToken, input)) as Preview;
		await testDb.insert(meetings).values({
			clubId: seed.clubId,
			scheduledAt: new Date("2031-03-06T19:00:00Z"),
			status: "scheduled",
		});
		const before = await count();
		const err = await run(adminToken, { ...input, planHash: p.planHash }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(McpError);
		expect((err as InstanceType<typeof McpError>).code).toBe("PLAN_STALE");
		expect(await count()).toBe(before);
	});

	it("a date inside a DST gap is blocking, and applying it is refused", async () => {
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago" })
			.where(eq(clubs.id, seed.clubId));
		const input = { dates: ["2031-03-09T02:30"] };
		const p = (await run(adminToken, input)) as Preview;
		expect(p.plan.blocking).toHaveLength(1);
		await expectMcpError(
			run(adminToken, { ...input, planHash: p.planHash }),
			"BLOCKED",
			BLOCKED_MESSAGE,
		);
	});

	it("a row a concurrent writer puts at the same instant is not credited to the caller, and its date is reported skipped", async () => {
		const input = { dates: ["2031-05-01T19:00", "2031-05-08T19:00"] };
		const p = (await run(adminToken, input)) as Preview;
		let rival = "";
		beforeInsert.run = async (m) => {
			// Only the first insert: the rival takes that instant.
			const [row] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: m.scheduledAt,
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			rival = row?.id ?? "";
		};
		const r = (await run(adminToken, {
			...input,
			planHash: p.planHash,
		})) as Applied;
		expect(rival).not.toBe("");
		expect(r.created.map((c) => c.date)).toEqual(["2031-05-08"]);
		expect(r.skipped.map((s) => s.date)).toEqual(["2031-05-01"]);
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "meeting_create"),
				),
			);
		expect(logs.map((l) => l.targetId)).toEqual([r.created[0]?.meetingId]);
		expect(logs.map((l) => l.targetId)).not.toContain(rival);
	});

	it("is atomic: a failure after the inserts rolls the meetings back too", async () => {
		const input = { dates: ["2031-06-05T19:00", "2031-06-12T19:00"] };
		const p = (await run(adminToken, input)) as Preview;
		const before = await count();
		failLog.armed = true;
		await expect(
			run(adminToken, { ...input, planHash: p.planHash }),
		).rejects.toThrow();
		failLog.armed = false;
		expect(await count()).toBe(before);
	});

	it("53 dates is refused at the schema", async () => {
		const dates = Array.from(
			{ length: 53 },
			(_, i) => `2032-01-${String((i % 28) + 1).padStart(2, "0")}T19:00`,
		);
		await expectMcpError(run(adminToken, { dates }), "VALIDATION");
	});

	it("a plain member is refused, and an archived club returns ARCHIVED", async () => {
		await expectMcpError(
			run(memberToken, { dates: ["2031-04-03T19:00"] }),
			"FORBIDDEN",
		);
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expectMcpError(
			run(adminToken, { dates: ["2031-04-03T19:00"] }),
			"ARCHIVED",
			CLUB_ARCHIVED_MESSAGE,
		);
	});
});
