/**
 * DB-backed tests for `set_member_standing` (#1577): the preview writes nothing
 * and names every role released and answer deleted, the apply writes through
 * the roster's own appliers in one transaction, a refusal leaves nothing half
 * done, and a role claimed between preview and apply is PLAN_STALE.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	meetingAttendancePlan,
	meetings,
	members,
	roleSlots,
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

const { setMemberStandingTool } = await import(
	"#/server/mcp/tools/set-member-standing"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const membersLogic = await import("#/server/members-logic");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

const run = (token: string, input: Record<string, unknown>) =>
	setMemberStandingTool.handler(input, {
		rawToken: token,
		audience: setMemberStandingTool.audience,
	});

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (e) {
		const err = e as { code?: string; message: string; detail?: unknown };
		return { ok: false as const, code: err.code, message: err.message, err };
	}
}

interface Plan {
	plan: {
		status: { before: string; after: string };
		clubRole: { before: string; after: string };
		unchanged: string[];
		releasedRoles: { slotId: string; role: string; meetingDate: string }[];
		deletedPlanAnswers: { meetingId: string; status: string }[];
		adminNote: string | null;
		blocking: { code: string; message: string }[];
	};
	planHash: string;
}

const DAY = 86_400_000;

async function meeting(
	clubId: string,
	daysAhead: number,
	status: "scheduled" | "completed" | "cancelled" = "scheduled",
) {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() + daysAhead * DAY),
			status,
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("no meeting");
	return m.id;
}

async function hold(
	roleDefinitionId: string,
	meetingId: string,
	memberId: string,
) {
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId,
			roleDefinitionId,
			status: "claimed",
			assignedMemberId: memberId,
			claimedAt: new Date(),
		})
		.returning({ id: roleSlots.id });
	if (!slot) throw new Error("no slot");
	return slot.id;
}

async function answer(meetingId: string, memberId: string) {
	await testDb
		.insert(meetingAttendancePlan)
		.values({ meetingId, memberId, status: "not_coming" });
}

const memberOf = async (id: string) =>
	(await testDb.select().from(members).where(eq(members.id, id)))[0];
const logs = (clubId: string, memberId: string) =>
	testDb
		.select()
		.from(activityLog)
		.where(
			and(
				eq(activityLog.clubId, clubId),
				eq(activityLog.targetId, memberId),
				eq(activityLog.action, "member_edit"),
			),
		);

describe.skipIf(!hasTestDb)("set_member_standing (#1577)", () => {
	/** The seeded plain member holds two upcoming roles and three answers: two
	 *  on meetings still to run, one on a completed one. */
	async function fixture() {
		const s = await seedClub();
		seeded.push(s);
		const adminToken = await tokenFor(s.adminUserId);
		const m2 = await meeting(s.clubId, 14);
		const done = await meeting(s.clubId, 21, "completed");
		const slotA = s.slotId;
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: s.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, slotA));
		const slotB = await hold(s.roleDefinitionId, m2, s.memberId);
		await answer(s.meetingId, s.memberId);
		await answer(m2, s.memberId);
		await answer(done, s.memberId);
		return { s, adminToken, m2, done, slotA, slotB };
	}
	const holder = async (slotId: string) =>
		(await testDb.select().from(roleSlots).where(eq(roleSlots.id, slotId)))[0]
			?.assignedMemberId ?? null;
	const answersOf = async (memberId: string) =>
		(
			await testDb
				.select({ meetingId: meetingAttendancePlan.meetingId })
				.from(meetingAttendancePlan)
				.where(eq(meetingAttendancePlan.memberId, memberId))
		)
			.map((r) => r.meetingId)
			.sort();

	it("previews the exact roles and answers, and writes nothing", async () => {
		const { s, adminToken, m2, done, slotA, slotB } = await fixture();
		const toFormer = (await run(adminToken, {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "former",
		})) as Plan;
		expect(toFormer.plan.releasedRoles.map((r) => r.slotId).sort()).toEqual(
			[slotA, slotB].sort(),
		);
		expect(toFormer.plan.releasedRoles.every((r) => r.role === "Timer")).toBe(
			true,
		);
		expect(toFormer.plan.deletedPlanAnswers.map((a) => a.meetingId)).toEqual([
			s.meetingId,
			m2,
		]);
		expect(
			toFormer.plan.deletedPlanAnswers.map((a) => a.meetingId),
		).not.toContain(done);
		expect(toFormer.plan.clubRole).toEqual({
			before: "member",
			after: "member",
		});

		const toInactive = (await run(adminToken, {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "inactive",
		})) as Plan;
		expect(toInactive.plan.releasedRoles).toHaveLength(2);
		expect(toInactive.plan.deletedPlanAnswers).toEqual([]);

		expect((await memberOf(s.memberId))?.status).toBe("active");
		expect(await holder(slotA)).toBe(s.memberId);
		expect(await holder(slotB)).toBe(s.memberId);
		expect(await answersOf(s.memberId)).toHaveLength(3);
		expect(await logs(s.clubId, s.memberId)).toHaveLength(0);
	});

	it("applying inactive releases exactly the previewed roles and keeps the answers", async () => {
		const { s, adminToken, slotA, slotB } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "inactive",
		};
		const p = (await run(adminToken, input)) as Plan;
		const res = await outcome(
			run(adminToken, { ...input, planHash: p.planHash }),
		);
		expect(res).toMatchObject({ ok: true, value: { applied: true } });
		expect((await memberOf(s.memberId))?.status).toBe("inactive");
		expect(await holder(slotA)).toBeNull();
		expect(await holder(slotB)).toBeNull();
		expect(await answersOf(s.memberId)).toHaveLength(3);
		const rows = await logs(s.clubId, s.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBe(s.adminMemberId);
	});

	it("applying former deletes exactly the previewed answers, none on a completed meeting", async () => {
		const { s, adminToken, done } = await fixture();
		const input = { clubId: s.clubId, memberId: s.memberId, status: "former" };
		const p = (await run(adminToken, input)) as Plan;
		const res = await outcome(
			run(adminToken, { ...input, planHash: p.planHash }),
		);
		expect(res.ok).toBe(true);
		expect((await memberOf(s.memberId))?.status).toBe("former");
		expect(await answersOf(s.memberId)).toEqual([done]);
		const rows = await logs(s.clubId, s.memberId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBe(s.adminMemberId);
	});

	it("the last active admin cannot be deactivated, ended or demoted: blocked in preview and apply", async () => {
		const { s, adminToken } = await fixture();
		for (const change of [
			{ status: "inactive" },
			{ status: "former" },
			{ clubRole: "member" },
		]) {
			const input = { clubId: s.clubId, memberId: s.adminMemberId, ...change };
			const p = (await run(adminToken, input)) as Plan;
			expect(p.plan.blocking.map((b) => b.code)).toEqual(["LAST_ADMIN"]);
			expect(
				await outcome(run(adminToken, { ...input, planHash: p.planHash })),
			).toMatchObject({ ok: false, code: "BLOCKED" });
		}
		const admin = await memberOf(s.adminMemberId);
		expect([admin?.status, admin?.clubRole]).toEqual(["active", "admin"]);
		expect(await logs(s.clubId, s.adminMemberId)).toHaveLength(0);
	});

	it("a second admin lets the first be demoted", async () => {
		const { s, adminToken } = await fixture();
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, s.memberId));
		const input = {
			clubId: s.clubId,
			memberId: s.adminMemberId,
			clubRole: "member",
		};
		const p = (await run(adminToken, input)) as Plan;
		expect(p.plan.blocking).toEqual([]);
		expect(
			(await outcome(run(adminToken, { ...input, planHash: p.planHash }))).ok,
		).toBe(true);
		expect((await memberOf(s.adminMemberId))?.clubRole).toBe("member");
	});

	it("a role change on a former member is blocked with the app's message", async () => {
		const { s, adminToken } = await fixture();
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, s.memberId));
		const input = { clubId: s.clubId, memberId: s.memberId, clubRole: "admin" };
		const p = (await run(adminToken, input)) as Plan;
		expect(p.plan.blocking).toEqual([
			{
				code: "FORMER_MEMBER_ROLE",
				message: membersLogic.FORMER_MEMBER_ROLE_MESSAGE,
			},
		]);
		expect(
			await outcome(run(adminToken, { ...input, planHash: p.planHash })),
		).toMatchObject({ ok: false, code: "BLOCKED" });
		expect((await memberOf(s.memberId))?.clubRole).toBe("member");
	});

	it("when the role change is refused, the status change is rolled back too", async () => {
		const { s } = await fixture();
		// Straight at the writer, past the preview's own refusal: status goes
		// first and commits nothing if the role step then throws.
		await expect(
			membersLogic.applyMemberStanding({
				clubId: s.clubId,
				memberId: s.memberId,
				status: "former",
				clubRole: "member",
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow(membersLogic.FORMER_MEMBER_ROLE_MESSAGE);
		expect((await memberOf(s.memberId))?.status).toBe("active");
		expect(await holder(s.slotId)).toBe(s.memberId);
		expect(await answersOf(s.memberId)).toHaveLength(3);
		expect(await logs(s.clubId, s.memberId)).toHaveLength(0);
	});

	it("reactivates a former member and makes them an admin in one call", async () => {
		const { s, adminToken } = await fixture();
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, s.memberId));
		const input = {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "active",
			clubRole: "admin",
		};
		const p = (await run(adminToken, input)) as Plan;
		expect(p.plan.blocking).toEqual([]);
		expect(p.plan.adminNote).toMatch(
			/edit the roster, meetings and club settings/,
		);
		expect(p.plan.clubRole).toEqual({ before: "member", after: "admin" });
		expect(
			(await outcome(run(adminToken, { ...input, planHash: p.planHash }))).ok,
		).toBe(true);
		const m = await memberOf(s.memberId);
		expect([m?.status, m?.clubRole]).toEqual(["active", "admin"]);
		expect(await logs(s.clubId, s.memberId)).toHaveLength(2);
	});

	it("a value equal to the current one is unchanged and writes nothing", async () => {
		const { s, adminToken } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "active",
			clubRole: "member",
		};
		const p = (await run(adminToken, input)) as Plan;
		expect(p.plan.unchanged).toEqual(["status", "clubRole"]);
		const res = await outcome(
			run(adminToken, { ...input, planHash: p.planHash }),
		);
		expect(res).toMatchObject({
			ok: true,
			value: { applied: true, changed: [] },
		});
		expect(await logs(s.clubId, s.memberId)).toHaveLength(0);
	});

	it("a role claimed after the preview is PLAN_STALE, not a silent release", async () => {
		const { s, adminToken } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: s.memberId,
			status: "inactive",
		};
		const p = (await run(adminToken, input)) as Plan;
		const m3 = await meeting(s.clubId, 28);
		const claimed = await hold(s.roleDefinitionId, m3, s.memberId);
		const res = await outcome(
			run(adminToken, { ...input, planHash: p.planHash }),
		);
		expect(res).toMatchObject({ ok: false, code: "PLAN_STALE" });
		const fresh = (res as { err: { detail: Plan } }).err.detail;
		expect(fresh.plan.releasedRoles.map((r) => r.slotId)).toContain(claimed);
		expect((await memberOf(s.memberId))?.status).toBe("active");
		expect(await holder(claimed)).toBe(s.memberId);
	});

	it("the apply re-checks under the lock: a stale verdict handed to the writer writes nothing", async () => {
		const { s } = await fixture();
		await expect(
			membersLogic.applyMemberStanding(
				{
					clubId: s.clubId,
					memberId: s.memberId,
					status: "inactive",
					actorMemberId: s.adminMemberId,
				},
				{ assertFresh: () => false },
			),
		).rejects.toBeInstanceOf(membersLogic.MemberStandingStaleError);
		expect((await memberOf(s.memberId))?.status).toBe("active");
		expect(await holder(s.slotId)).toBe(s.memberId);
	});

	it("refuses a plain member, another club's member and an empty call", async () => {
		const { s, adminToken } = await fixture();
		const other = await seedClub();
		seeded.push(other);
		expect(
			await outcome(
				run(await tokenFor(s.memberUserId), {
					clubId: s.clubId,
					memberId: s.memberId,
					status: "inactive",
				}),
			),
		).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
		expect(
			await outcome(
				run(adminToken, {
					clubId: s.clubId,
					memberId: other.memberId,
					status: "inactive",
				}),
			),
		).toMatchObject({ ok: false, code: "NOT_FOUND" });
		expect((await memberOf(other.memberId))?.status).toBe("active");
		expect(
			await outcome(
				run(adminToken, { clubId: s.clubId, memberId: s.memberId }),
			),
		).toMatchObject({ ok: false, code: "VALIDATION" });
	});

	it("promoting a member logs member_edit crediting the calling officer", async () => {
		const { s, adminToken } = await fixture();
		const extra = await seedPerson({ name: "Extra Person" });
		const [row] = await testDb
			.insert(members)
			.values({
				clubId: s.clubId,
				personId: extra,
				name: "Extra Person",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		const input = {
			clubId: s.clubId,
			memberId: row?.id as string,
			clubRole: "admin",
		};
		const p = (await run(adminToken, input)) as Plan;
		await run(adminToken, { ...input, planHash: p.planHash });
		const rows = await logs(s.clubId, row?.id as string);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBe(s.adminMemberId);
		expect(rows[0]?.detail).toMatchObject({ after: { clubRole: "admin" } });
	});
});
