/**
 * DB-backed tests for `claim_open_role` (#1283), called with a real minted token.
 *
 * Card (shared): protects=a member's agent claims an OPEN role for THEMSELVES
 * only, with the app's own claim rules, after a preview, and not when someone
 * else got there first; fails_when=the wrong slot is chosen, a taken slot is
 * overwritten, a member who said they cannot come is given a role, or another
 * club's meeting answers differently from a stranger's; no_claim=tokens are
 * minted directly (no OAuth round trip) and speech details are not exercised
 * (the tool takes none).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	meetingAttendancePlan,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { claimOpenRoleTool } = await import(
	"#/server/mcp/tools/claim-open-role"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
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
	plan: { slotLabel: string | null; alsoOpen: string[] };
	planHash: string;
	blocking: { code: string; message: string }[];
};

function call(token: string, args: Record<string, unknown>) {
	return claimOpenRoleTool.handler(args, {
		rawToken: token,
		audience: "member",
	});
}
const preview = (token: string, meetingId: string, role: string) =>
	call(token, { meetingId, role }) as Promise<Preview>;

/** A role with `count` open slots, in agenda order after the seeded Timer. */
async function addRole(
	s: SeededClub,
	name: string,
	count: number,
	sortOrder: number,
	isSpeakerRole = false,
): Promise<string[]> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name,
			category: isSpeakerRole ? "speaker" : "functionary",
			isSpeakerRole,
			sortOrder,
		})
		.returning({ id: roleDefinitions.id });
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: s.meetingId,
				roleDefinitionId: def?.id ?? "",
				slotIndex: i,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		ids.push(slot?.id ?? "");
	}
	return ids;
}

async function holderOf(slotId: string) {
	const [row] = await testDb
		.select({ holder: roleSlots.assignedMemberId, status: roleSlots.status })
		.from(roleSlots)
		.where(eq(roleSlots.id, slotId));
	return row;
}

async function expectMcpError(p: Promise<unknown>, code: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	return err as InstanceType<typeof McpError>;
}

describe.skipIf(!hasTestDb)("claim_open_role (#1283)", () => {
	// Card: protects=the single-match claim end to end, matched case-insensitively,
	// writing the claim, the "coming" answer and activity rows tagged connector (AC8);
	// fails_when=the preview writes, the slot is not the caller's, or a row lacks
	// via connector; no_claim=a speaker role (speech capture) is the next case.
	it("previews, then claims the one open slot for the caller", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "timer");
		expect(p.blocking).toEqual([]);
		expect(p.plan).toMatchObject({ slotLabel: "Timer", alsoOpen: [] });
		expect((await holderOf(s.slotId))?.status).toBe("open");

		const out = await call(token, {
			meetingId: s.meetingId,
			role: "timer",
			planHash: p.planHash,
		});
		expect(out).toEqual({ claimed: "Timer" });
		expect(await holderOf(s.slotId)).toEqual({
			holder: s.memberId,
			status: "claimed",
		});
		const rows = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, s.clubId));
		expect(rows.find((r) => r.action === "claim")?.detail).toMatchObject({
			via: "connector",
			proof: "connector",
		});
		expect(rows.find((r) => r.action === "plan_set")?.detail).toMatchObject({
			via: "connector",
			proof: "connector",
			status: "coming",
		});
	});

	// Card: protects=AC6, "speaker" with three open slots claims the FIRST in
	// agenda order and lists the other two; fails_when=a later slot is chosen or
	// alsoOpen is wrong; no_claim=none beyond protects.
	it("claims the first of several open speaker slots and lists the rest", async () => {
		const s = await club();
		const [first, second, third] = await addRole(s, "Speaker", 3, 5, true);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "Speaker");
		expect(p.plan).toMatchObject({
			slotLabel: "Speaker 1",
			alsoOpen: ["Speaker 2", "Speaker 3"],
		});
		await call(token, {
			meetingId: s.meetingId,
			role: "Speaker",
			planHash: p.planHash,
		});
		expect((await holderOf(first ?? ""))?.holder).toBe(s.memberId);
		expect((await holderOf(second ?? ""))?.status).toBe("open");
		expect((await holderOf(third ?? ""))?.status).toBe("open");
	});

	// Card: protects=an exact numbered label picks exactly that slot;
	// fails_when="Speaker 2" claims Speaker 1; no_claim=none beyond protects.
	it("a numbered label matches only that slot", async () => {
		const s = await club();
		const [, second] = await addRole(s, "Speaker", 3, 5, true);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "speaker 2");
		expect(p.plan).toMatchObject({ slotLabel: "Speaker 2", alsoOpen: [] });
		await call(token, {
			meetingId: s.meetingId,
			role: "speaker 2",
			planHash: p.planHash,
		});
		expect((await holderOf(second ?? ""))?.holder).toBe(s.memberId);
	});

	// Card: protects=AC6 second half, no open slot is a blocking item naming what
	// IS open, and apply refuses; fails_when=NO_OPEN_SLOT lacks the open labels or
	// apply proceeds; no_claim=none beyond protects.
	it("NO_OPEN_SLOT lists the open labels; apply is BLOCKED", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "Ah-Counter");
		expect(p.plan.slotLabel).toBeNull();
		expect(p.blocking).toHaveLength(1);
		expect(p.blocking[0]).toMatchObject({ code: "NO_OPEN_SLOT" });
		expect(p.blocking[0]?.message).toContain("Timer");
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Ah-Counter",
					planHash: p.planHash,
				}),
			),
			"BLOCKED",
		);
	});

	// Card: protects=AC7, a member who said they cannot come is not given a role;
	// fails_when=NOT_COMING is absent or the claim lands; no_claim=none beyond protects.
	it("NOT_COMING when the member said they can't make it", async () => {
		const s = await club();
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "Timer");
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_COMING"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					planHash: p.planHash,
				}),
			),
			"BLOCKED",
		);
		expect((await holderOf(s.slotId))?.status).toBe("open");
	});

	// Card: protects=AC2 for claims: another member taking ANY matching slot
	// changes the hash, nothing is overwritten; fails_when=the stale hash applies
	// or the other member's role is replaced; no_claim=none beyond protects.
	it("PLAN_STALE when another member took the slot after the preview", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "Timer");
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: s.adminMemberId, status: "claimed" })
			.where(eq(roleSlots.id, s.slotId));
		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({ plan: { slotLabel: null } });
		expect(await holderOf(s.slotId)).toEqual({
			holder: s.adminMemberId,
			status: "claimed",
		});
	});

	// Card: protects=a cancelled meeting is blocked in the preview and LOCKED at
	// apply; fails_when=a claim lands on it; no_claim=started/completed share the
	// helper and are covered in set-my-attendance.
	it("a cancelled meeting is blocked, then LOCKED", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "Timer");
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		expect(
			(await preview(token, s.meetingId, "Timer")).blocking.map((b) => b.code),
		).toContain("MEETING_CANCELLED");
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					role: "Timer",
					planHash: p.planHash,
				}),
			),
			"LOCKED",
		);
		expect((await holderOf(s.slotId))?.status).toBe("open");
	});

	// Card: protects=AC3, a foreign club's meeting answers as a stranger's would
	// and the input has no member id; fails_when=the refusal differs or a member id
	// is accepted; no_claim=none beyond protects.
	it("a meeting in a club the caller is not in is FORBIDDEN", async () => {
		const mine = await club();
		const theirs = await club();
		const token = await tokenFor(mine.memberUserId);
		const err = await expectMcpError(
			Promise.resolve(
				call(token, { meetingId: theirs.meetingId, role: "Timer" }),
			),
			"FORBIDDEN",
		);
		expect(err.message).toBe(NOT_OFFICER_MESSAGE);
		expect(
			Object.keys(claimOpenRoleTool.config.inputSchema ?? {}).sort(),
		).toEqual(["meetingId", "planHash", "role"]);
		expect(
			(
				await testDb
					.select({ id: meetingAttendancePlan.id })
					.from(meetingAttendancePlan)
					.where(and(eq(meetingAttendancePlan.meetingId, theirs.meetingId)))
			).length,
		).toBe(0);
	});
});
