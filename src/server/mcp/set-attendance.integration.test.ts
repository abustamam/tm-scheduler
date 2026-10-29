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
	members,
	officerTerms,
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
	beforeClubLock: null as null | (() => Promise<void>),
}));
vi.mock("#/server/club-write-lock", async (orig) => {
	const m = await orig<typeof import("#/server/club-write-lock")>();
	return {
		...m,
		lockClubForWrite: async (...a: Parameters<typeof m.lockClubForWrite>) => {
			const run = hooks.beforeClubLock;
			hooks.beforeClubLock = null;
			if (run) await run();
			return m.lockClubForWrite(...a);
		},
	};
});
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
const {
	releaseSlotsAndMarkUnavailable,
	releaseHeldSlotsForPlan,
	connectorOfficerActor,
} = await import("#/server/availability-logic");
const { setPlanStatus } = await import("#/server/attendance-plan-logic");
const { SELF_ONLY_MESSAGE } = await import("#/server/attendance-actor-logic");

const seeded: SeededClub[] = [];
afterEach(async () => {
	hooks.beforeRelease = null;
	hooks.beforeClubLock = null;
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

	// Card: protects=P1 (review of #1416): an uppercase uuid passes the schema and
	// the SQL subject match, so the JS held-slot comparison must not see "no
	// roles" while the release frees every one; fails_when=the preview lists
	// nothing for an uppercase memberId, or the apply frees roles the preview did
	// not show; no_claim=none.
	it("an uppercase memberId and meetingId previews the held roles and the apply frees exactly those", async () => {
		const s = await club();
		await holdSeededTimer(s);
		await addSlot(s, "Grammarian", s.memberId, 2);
		const token = await tokenFor(s.adminUserId);
		const upper = {
			meetingId: s.meetingId.toUpperCase(),
			memberId: s.memberId.toUpperCase(),
			status: "not_coming",
		};
		const p = (await call(token, upper)) as Preview;
		expect(p.plan.rolesToFree).toEqual(["Timer", "Grammarian"]);
		// The lowercase spelling hashes the same, so a preview in one case applies
		// in the other.
		const lower = await preview(token, s, "not_coming");
		expect(lower.planHash).toBe(p.planHash);
		const out = (await call(token, { ...upper, planHash: p.planHash })) as {
			released: string[];
		};
		expect(out.released).toEqual(["Timer", "Grammarian"]);
		expect(await heldBy(s.memberId)).toEqual([]);
	});

	// Card: protects=the cited `set_my_attendance` takes the same uppercase
	// `meetingId`; fails_when=an uppercase meetingId changes what the member's own
	// preview lists or what the apply frees; no_claim=the text-keyed lock is not
	// observable from here, so this pins behaviour, not the lock key.
	it("set_my_attendance with an uppercase meetingId previews and frees the held roles", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const ctx = { rawToken: token, audience: "member" as const };
		const args = {
			meetingId: s.meetingId.toUpperCase(),
			status: "not_coming",
		};
		const p = (await setMyAttendanceTool.handler(args, ctx)) as Preview;
		expect(p.plan.rolesToFree).toEqual(["Timer"]);
		const out = (await setMyAttendanceTool.handler(
			{ ...args, planHash: p.planHash },
			ctx,
		)) as { released: string[] };
		expect(out.released).toEqual(["Timer"]);
		expect(await heldBy(s.memberId)).toEqual([]);
	});

	// Card: protects=the self refusal holds for an uppercase spelling of the
	// caller's own id; fails_when=it is admitted; no_claim=none.
	it("refuses the caller's own id in uppercase", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await expectMcpError(
			preview(token, s, "coming", s.adminMemberId.toUpperCase()),
			"BLOCKED",
		);
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
	// else unless it carries the branded officer actor `connectorOfficerActor`
	// returns; fails_when=a caller's own `grantedVia: "officer"` string, a member
	// standing, or an unmarked connector write for another member is admitted;
	// no_claim=direct seam calls.
	it("the seams refuse a connector write for another member without the officer actor", async () => {
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
		expect(() => connectorOfficerActor("member", s.adminMemberId)).toThrow();
		expect(connectorOfficerActor("admin", s.adminMemberId)).toMatchObject({
			via: "officer",
			proof: "connector",
			actorMemberId: s.adminMemberId,
		});
		const plan = {
			memberId: s.memberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			status: "not_coming" as const,
			actorMemberId: s.adminMemberId,
			via: "connector" as const,
			proof: "connector" as const,
		};
		await expect(setPlanStatus(testDb, plan)).rejects.toThrow(
			SELF_ONLY_MESSAGE,
		);
		// The string a caller can type is not the officer actor.
		await expect(
			setPlanStatus(testDb, { ...plan, grantedVia: "officer" }),
		).rejects.toThrow(SELF_ONLY_MESSAGE);
		// An officer actor for a DIFFERENT actor id does not vouch for this write.
		await expect(
			setPlanStatus(testDb, {
				...plan,
				connectorOfficer: connectorOfficerActor("admin", s.memberId),
			}),
		).rejects.toThrow(SELF_ONLY_MESSAGE);
		expect(await heldBy(s.memberId)).toHaveLength(1);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=P2 (review of #1416): a demotion between the preview and the
	// apply is honoured; fails_when=the apply trusts the preview-time standing and
	// writes after the owner lost admin; no_claim=the demotion lands right before
	// the club lock, after the dispatcher's own authorization.
	it("refuses an apply whose token owner was demoted after the preview, and writes nothing", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "not_coming");
		hooks.beforeClubLock = async () => {
			await testDb
				.update(members)
				.set({ clubRole: "member" })
				.where(eq(members.id, s.adminMemberId));
		};
		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "not_coming",
					planHash: p.planHash,
				}),
			),
			"FORBIDDEN",
		);
		expect(err.message).toBe(NOT_OFFICER_MESSAGE);
		expect(await heldBy(s.memberId)).toHaveLength(1);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=P2 (review of #1416): the release UPDATE is bounded by the
	// previewed slot ids; fails_when=a role the member holds that was not in
	// `slotIds` is freed; no_claim=called on the release writer directly, because
	// the equality re-check before it leaves no window to inject a slot.
	it("releaseHeldSlotsForPlan frees only the slotIds it is given", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const extra = await addSlot(s, "Grammarian", s.memberId, 2);
		const freed = await testDb.transaction((tx) =>
			releaseHeldSlotsForPlan(tx, {
				meetingId: s.meetingId,
				memberId: s.memberId,
				proof: "connector",
				cause: "not_coming",
				clubId: s.clubId,
				actorMemberId: s.adminMemberId,
				slotIds: [s.slotId],
			}),
		);
		expect(freed.map((f) => f.slotId)).toEqual([s.slotId]);
		expect((await heldBy(s.memberId)).map((r) => r.id)).toEqual([extra]);
	});

	// Card: protects=the subject must be an ACTIVE member; fails_when=a former
	// member of the same club can be marked; no_claim=none.
	it("blocks an inactive member of the same club", async () => {
		const s = await club();
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, s.memberId));
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "coming");
		expect(p.blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "coming",
					planHash: p.planHash,
				}),
			),
			"BLOCKED",
		);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=an elected officer who is not a stored admin is admitted, the
	// same gate as assign_roles (the maintainer confirms it stays); fails_when=the
	// gate silently narrows to stored admins; no_claim=none.
	it("admits an officer-term token whose owner is not a stored admin", async () => {
		const s = await club();
		await testDb.insert(officerTerms).values({
			membershipId: s.memberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 86_400_000),
			termEnd: null,
		});
		const tm = s.adminMemberId;
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s, "coming", tm);
		expect(p.blocking).toEqual([]);
		await call(token, {
			meetingId: s.meetingId,
			memberId: tm,
			status: "coming",
			planHash: p.planHash,
		});
		const rows = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, s.clubId),
					eq(activityLog.action, "plan_set"),
				),
			);
		expect(rows[0]?.actorMemberId).toBe(s.memberId);
	});

	// Card: protects=a meeting that started between preview and apply is refused;
	// fails_when=the apply writes to a past meeting; no_claim=the hash covers
	// startsAt, so the refusal is PLAN_STALE carrying the fresh blocking list.
	it("an apply against a meeting that has since started is refused, with MEETING_PAST in the fresh plan", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, s, "not_coming");
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 60_000) })
			.where(eq(meetings.id, s.meetingId));
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
			blocking: [{ code: "MEETING_PAST" }],
		});
		expect(await heldBy(s.memberId)).toHaveLength(1);
		expect(await planOf(s)).toBeNull();
	});

	// Card: protects=the description's "Never the caller's id"; fails_when=an
	// officer marks their own membership through the officer tool; no_claim=none.
	it("refuses the caller's own membership and points at set_my_attendance", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const err = await expectMcpError(
			preview(token, s, "coming", s.adminMemberId),
			"BLOCKED",
		);
		expect(err.message).toMatch(/set_my_attendance/);
		expect(await planOf(s)).toBeNull();
	});
});
