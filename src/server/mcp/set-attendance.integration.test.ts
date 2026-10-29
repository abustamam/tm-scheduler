/**
 * DB-backed tests for `set_attendance` (#1303), called with real minted tokens.
 *
 * Card: protects=a club admin's agent can mark ANOTHER member coming / not
 * coming (freeing their roles after preview and confirm) and nobody else's
 * agent can; fails_when=a non-admin, another club's admin or a Toastmaster
 * writes, a stale hash applies, a locked meeting is written, or the activity
 * feed cannot name the officer via the connector; no_claim=tokens are minted
 * directly (no OAuth), and the member-audience refusal is the dispatcher's
 * stamp, exercised here by calling with `audience: "officer"` as it does.
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

const hooks = vi.hoisted(() => ({
	beforeRelease: null as null | (() => Promise<void>),
}));
vi.mock("#/server/membership-merge-lock", async (orig) => {
	const m = await orig<typeof import("#/server/membership-merge-lock")>();
	return {
		...m,
		lockMembershipsAgainstMerge: async (
			...a: Parameters<typeof m.lockMembershipsAgainstMerge>
		) => {
			const run = hooks.beforeRelease;
			hooks.beforeRelease = null;
			if (run) await run();
			return m.lockMembershipsAgainstMerge(...a);
		},
	};
});

const { setAttendanceTool } = await import("#/server/mcp/tools/set-attendance");
const { setMyAttendanceTool } = await import(
	"#/server/mcp/tools/set-my-attendance"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const { McpError } = await import("#/server/mcp/errors");
const { releaseSlotsAndMarkUnavailable, connectorOfficerActor } = await import(
	"#/server/availability-logic"
);
const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { SELF_ONLY_MESSAGE } = await import("#/server/attendance-actor-logic");

const seeded: SeededClub[] = [];
afterEach(async () => {
	hooks.beforeRelease = null;
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
		status: string;
		rolesToFree: string[];
		warning: string | null;
		member: { name: string | null };
	};
	planHash: string;
	blocking: { code: string; message: string }[];
};

function call(token: string, args: Record<string, unknown>) {
	return setAttendanceTool.handler(args, {
		rawToken: token,
		audience: "officer",
	});
}
const preview = (
	token: string,
	s: SeededClub,
	status: string,
	memberId = s.memberId,
) =>
	call(token, { meetingId: s.meetingId, memberId, status }) as Promise<Preview>;

async function expectMcpError(p: Promise<unknown>, code: string) {
	const err = await p.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(McpError);
	expect((err as InstanceType<typeof McpError>).code).toBe(code);
	return err as InstanceType<typeof McpError>;
}

async function addSlot(
	s: SeededClub,
	roleName: string,
	holder: string | null,
	sortOrder: number,
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: roleName,
			category: "functionary",
			isSpeakerRole: false,
			sortOrder,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: s.meetingId,
			roleDefinitionId: def?.id ?? "",
			status: holder ? "claimed" : "open",
			assignedMemberId: holder,
		})
		.returning({ id: roleSlots.id });
	return slot?.id ?? "";
}

async function holdSeededTimer(s: SeededClub): Promise<void> {
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: s.memberId, status: "claimed" })
		.where(eq(roleSlots.id, s.slotId));
}

async function planOf(s: SeededClub) {
	const [row] = await testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, s.memberId),
				eq(meetingAttendancePlan.meetingId, s.meetingId),
			),
		);
	return row?.status ?? null;
}

const heldBy = (id: string) =>
	testDb
		.select({ id: roleSlots.id })
		.from(roleSlots)
		.where(eq(roleSlots.assignedMemberId, id));

describe.skipIf(!hasTestDb)("set_attendance (#1303)", () => {
	// Card: protects=AC1, the officer's not-coming flow end to end and its
	// attribution; fails_when=a held role stays, the plan row is wrong, or the
	// feed names the member as the actor / omits the connector; no_claim=none.
	it("previews the held roles, frees them on apply, and attributes the officer via the connector", async () => {
		const s = await club();
		await holdSeededTimer(s);
		await addSlot(s, "Grammarian", s.memberId, 2);
		const token = await tokenFor(s.adminUserId);

		const p = await preview(token, s, "not_coming");
		expect(p.blocking).toEqual([]);
		expect(p.plan.rolesToFree).toEqual(["Timer", "Grammarian"]);
		expect(p.plan.warning).toMatch(/frees .*Timer, Grammarian/);
		expect(await planOf(s)).toBeNull();

		const out = (await call(token, {
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "not_coming",
			planHash: p.planHash,
		})) as { released: string[]; note: string | null };
		expect(out.released).toEqual(["Timer", "Grammarian"]);
		expect(out.note).toMatch(/find cover/);
		expect(await planOf(s)).toBe("not_coming");
		expect(await heldBy(s.memberId)).toEqual([]);

		const rows = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, s.clubId));
		const release = rows.find((r) => r.action === "release");
		expect(release?.actorMemberId).toBe(s.adminMemberId);
		expect(release?.detail).toMatchObject({
			fromMemberId: s.memberId,
			via: "connector",
			proof: "connector",
		});
		const plan = rows.find((r) => r.action === "plan_set");
		expect(plan?.actorMemberId).toBe(s.adminMemberId);
		expect(plan?.detail).toMatchObject({
			memberId: s.memberId,
			status: "not_coming",
			via: "connector",
			grantedVia: "officer",
			proof: "connector",
		});
	});

	// Card: protects=AC2, coming overwrites an earlier not_coming, attributed to
	// the officer; fails_when=the not_coming row survives or the grant is not
	// recorded as officer; no_claim=none.
	it("coming overwrites a not_coming mark, credited to the officer", async () => {
		const s = await club();
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "coming");
		expect(p.blocking).toEqual([]);
		await call(token, {
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "coming",
			planHash: p.planHash,
		});
		expect(await planOf(s)).toBe("coming");
		const rows = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, s.clubId),
					eq(activityLog.action, "plan_set"),
				),
			);
		expect(rows[0]?.actorMemberId).toBe(s.adminMemberId);
		expect(rows[0]?.detail).toMatchObject({
			via: "connector",
			grantedVia: "officer",
			proof: "connector",
		});
	});

	// Card: protects=AC3, a plain member's token cannot use the officer tool and
	// set_my_attendance still cannot name another subject; fails_when=either
	// writes; no_claim=none.
	it("a member token is refused, and set_my_attendance has no way to name another member", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const err = await expectMcpError(
			preview(token, s, "not_coming"),
			"FORBIDDEN",
		);
		expect(err.message).toBe(NOT_OFFICER_MESSAGE);
		expect(setAttendanceTool.audience).toBe("officer");
		expect(
			Object.keys(setMyAttendanceTool.config.inputSchema ?? {}),
		).not.toContain("memberId");
		expect(await heldBy(s.memberId)).toHaveLength(1);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=AC4, only an admin of THIS meeting's club; fails_when=an
	// admin of another club, or this meeting's Toastmaster who is not an admin,
	// writes; no_claim=none.
	it("refuses an admin of another club and a non-admin Toastmaster", async () => {
		const s = await club();
		const other = await club();
		await holdSeededTimer(s);
		const tm = await addSlot(s, "Toastmaster of the Day", s.memberId, 0);
		expect(tm).not.toBe("");

		const foreign = await tokenFor(other.adminUserId);
		await expectMcpError(preview(foreign, s, "not_coming"), "FORBIDDEN");
		await expectMcpError(
			Promise.resolve(
				call(foreign, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "not_coming",
					planHash: "x",
				}),
			),
			"FORBIDDEN",
		);

		const tmod = await tokenFor(s.memberUserId);
		await expectMcpError(preview(tmod, s, "not_coming"), "FORBIDDEN");
		expect(await heldBy(s.memberId)).toHaveLength(2);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=AC5, a slot assigned between preview and apply frees nothing;
	// fails_when=the stale hash applies or the late slot is freed unseen;
	// no_claim=two injection points: before the tool's hash check (hash drift)
	// and inside the seam (HeldSlotsChangedError).
	it("PLAN_STALE when a role lands on the member after the preview; nothing freed", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "not_coming");
		await addSlot(s, "Grammarian", s.memberId, 2);
		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "not_coming",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({
			plan: { rolesToFree: ["Timer", "Grammarian"] },
		});
		expect(await heldBy(s.memberId)).toHaveLength(2);
		expect(await planOf(s)).toBeNull();
	});

	it("PLAN_STALE (seam re-check) when a role lands between the hash check and the release", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "not_coming");
		hooks.beforeRelease = async () => {
			await addSlot(s, "Grammarian", s.memberId, 2);
		};
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "not_coming",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(await heldBy(s.memberId)).toHaveLength(2);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=AC6, the same blocking codes as set_my_attendance, plus a
	// subject who is not an active member of the club; fails_when=any is accepted;
	// no_claim=none.
	it("blocks cancelled, completed, past, a repeat answer and a foreign or unknown subject", async () => {
		const s = await club();
		const other = await club();
		const token = await tokenFor(s.adminUserId);
		const codes = async (status = "coming") =>
			(await preview(token, s, status)).blocking.map((b) => b.code);

		const stranger = await preview(token, s, "coming", other.memberId);
		expect(stranger.blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
		expect(stranger.plan.member.name).toBeNull();
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: other.memberId,
					status: "coming",
					planHash: stranger.planHash,
				}),
			),
			"BLOCKED",
		);

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		expect(await codes()).toEqual(["MEETING_CANCELLED"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "coming",
					planHash: "x",
				}),
			),
			"LOCKED",
		);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, s.meetingId));
		expect(await codes()).toEqual(["MEETING_COMPLETED"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "coming",
					planHash: "x",
				}),
			),
			"LOCKED",
		);
		await testDb
			.update(meetings)
			.set({ status: "scheduled", scheduledAt: new Date(Date.now() - 60_000) })
			.where(eq(meetings.id, s.meetingId));
		expect(await codes()).toEqual(["MEETING_PAST"]);
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() + 86_400_000) })
			.where(eq(meetings.id, s.meetingId));
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "coming",
		});
		expect(await codes()).toEqual(["ALREADY_THAT_STATUS"]);
	});

	// Card: protects=the seams keep refusing a connector actor writing someone
	// else unless it comes through the officer path; fails_when=connectorStanding
	// is ignored, a member standing is admitted, or setPlanStatus admits an
	// unmarked connector write for another member; no_claim=direct seam calls.
	it("the seams refuse a connector write for another member without the officer path", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const base = {
			memberId: s.memberId,
			claimedActorMemberId: s.adminMemberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			via: "connector" as const,
			proof: "connector" as const,
		};
		await expect(releaseSlotsAndMarkUnavailable(testDb, base)).rejects.toThrow(
			SELF_ONLY_MESSAGE,
		);
		await expect(
			releaseSlotsAndMarkUnavailable(testDb, {
				...base,
				connectorStanding: "member",
			}),
		).rejects.toThrow();
		expect(() => connectorOfficerActor("member", s.adminMemberId)).toThrow();
		expect(connectorOfficerActor("admin", s.adminMemberId)).toMatchObject({
			via: "officer",
			proof: "connector",
			actorMemberId: s.adminMemberId,
		});
		await expect(
			setPlanStatus(testDb, {
				memberId: s.memberId,
				meetingId: s.meetingId,
				clubId: s.clubId,
				status: "not_coming",
				actorMemberId: s.adminMemberId,
				via: "connector",
				proof: "connector",
			}),
		).rejects.toThrow(SELF_ONLY_MESSAGE);
		expect(await heldBy(s.memberId)).toHaveLength(1);
		expect(await planOf(s)).toBeNull();
	});
});
