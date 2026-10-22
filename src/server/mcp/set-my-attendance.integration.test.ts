/**
 * DB-backed tests for `set_my_attendance` (#1283), called with a real minted token.
 *
 * Card (shared): protects=a member's agent can say "I'm not coming" / "I'm
 * coming" for THEIR OWN row and nobody else's, with the app's own effect (roles
 * freed, answer recorded, duty text) and a preview-before-apply guarantee;
 * fails_when=a role is not freed, a stale hash applies, another club's meeting
 * answers differently from a stranger's, or the activity feed cannot tell an
 * agent from a browser; no_claim=tokens are minted directly (no OAuth round
 * trip), the Toastmaster is a seeded slot, and the browser path's own suites
 * (`availability`, `attendance-decline`) prove the seams' session behaviour.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	meetingAttendancePlan,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { roleFreedDutyText } from "#/lib/role-duty-copy";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Two injection points, each armed by one test and disarmed in `afterEach`:
// `failAfterRelease` makes the Toastmaster lookup (which runs AFTER the release)
// throw; `beforeRelease` runs inside the seam, after the tool's hash check and
// before the attendance lock, i.e. in the window an assign can land in.
const hooks = vi.hoisted(() => ({
	failAfterRelease: false,
	beforeRelease: null as null | (() => Promise<void>),
}));
vi.mock("#/server/meeting-authz-logic", async (orig) => {
	const m = await orig<typeof import("#/server/meeting-authz-logic")>();
	return {
		...m,
		loadTmodMemberId: (...a: Parameters<typeof m.loadTmodMemberId>) => {
			if (hooks.failAfterRelease) throw new Error("boom after release");
			return m.loadTmodMemberId(...a);
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

const { setMyAttendanceTool } = await import(
	"#/server/mcp/tools/set-my-attendance"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const { McpError } = await import("#/server/mcp/errors");
const { releaseSlotsAndMarkUnavailable } = await import(
	"#/server/availability-logic"
);
const { declinePlannedAttendance } = await import(
	"#/server/attendance-decline-logic"
);
const { SELF_ONLY_MESSAGE } = await import("#/server/attendance-actor-logic");
const { confirmSlotCore } = await import("#/server/slots-logic");

const seeded: SeededClub[] = [];
afterEach(async () => {
	hooks.failAfterRelease = false;
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
		meeting: { clubName: string };
	};
	planHash: string;
	blocking: { code: string; message: string }[];
};
type Applied = {
	released: string[];
	dutyText: string | null;
	draftMessage: string | null;
};

function call(token: string, args: Record<string, unknown>) {
	return setMyAttendanceTool.handler(args, {
		rawToken: token,
		audience: "member",
	});
}
const preview = (token: string, meetingId: string, status: string) =>
	call(token, { meetingId, status }) as Promise<Preview>;

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

/** The seeded open Timer slot, given to the member (a second Timer slot would
 *  number the labels "Timer 1" / "Timer 2"). */
async function holdSeededTimer(s: SeededClub): Promise<string> {
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: s.memberId, status: "claimed" })
		.where(eq(roleSlots.id, s.slotId));
	return s.slotId;
}

async function planOf(s: SeededClub, memberId = s.memberId) {
	const [row] = await testDb
		.select({ status: meetingAttendancePlan.status })
		.from(meetingAttendancePlan)
		.where(
			and(
				eq(meetingAttendancePlan.memberId, memberId),
				eq(meetingAttendancePlan.meetingId, s.meetingId),
			),
		);
	return row?.status ?? null;
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

describe.skipIf(!hasTestDb)("set_my_attendance (#1283)", () => {
	// Card: protects=AC1, the whole not-coming flow end to end;
	// fails_when=a held role stays assigned, the answer is not recorded, the duty
	// sentence or the draft naming the Toastmaster is missing, or the preview
	// writes anything; no_claim=the draft is only drafted, never sent.
	it("previews both roles, then frees them, records not_coming and drafts the message", async () => {
		const s = await club();
		await holdSeededTimer(s);
		await addSlot(s, "Grammarian", s.memberId, 2);
		await addSlot(s, "Toastmaster of the Day", s.adminMemberId, 0);
		const token = await tokenFor(s.memberUserId);

		const p = await preview(token, s.meetingId, "not_coming");
		expect(p.blocking).toEqual([]);
		expect(p.plan.rolesToFree).toEqual(["Timer", "Grammarian"]);
		expect(await planOf(s)).toBeNull();

		const out = (await call(token, {
			meetingId: s.meetingId,
			status: "not_coming",
			planHash: p.planHash,
		})) as Applied;
		expect(out.released).toEqual(["Timer", "Grammarian"]);
		expect(out.dutyText).toBe(roleFreedDutyText(2));
		expect(out.dutyText).toMatch(
			/^Roles freed\. Now tell the Toastmaster or VPE/,
		);
		expect(out.draftMessage).toMatch(
			/^Hi Admin, I can't make the \w{3}, \w{3} \d{1,2} meeting, so I've freed Timer and Grammarian\. Could you help find cover\?$/,
		);
		expect(await planOf(s)).toBe("not_coming");
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toEqual([]);
	});

	// Card: protects=a member holding nothing gets no duty sentence and no draft;
	// fails_when=dutyText appears for a freed-nothing decline; no_claim=none
	// beyond protects.
	it("frees nothing for a member with no role: no duty text, no draft", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		expect(p.plan.rolesToFree).toEqual([]);
		const out = (await call(token, {
			meetingId: s.meetingId,
			status: "not_coming",
			planHash: p.planHash,
		})) as Applied;
		expect(out).toEqual({ released: [], dutyText: null, draftMessage: null });
		expect(await planOf(s)).toBe("not_coming");
	});

	// Card: protects=the draft goes to the VPE when the caller IS the Toastmaster;
	// fails_when=it greets the caller by their own name; no_claim=none beyond protects.
	it("addresses the VPE when the caller is the Toastmaster", async () => {
		const s = await club();
		await addSlot(s, "Toastmaster of the Day", s.memberId, 0);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		const out = (await call(token, {
			meetingId: s.meetingId,
			status: "not_coming",
			planHash: p.planHash,
		})) as Applied;
		expect(out.draftMessage).toMatch(/^Hi VPE, /);
	});

	// Card: protects=coming overwrites a not_coming, so a later claim is not
	// blocked; fails_when=the not_coming row survives; no_claim=none beyond protects.
	it("coming clears a not_coming mark", async () => {
		const s = await club();
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "coming");
		expect(p.blocking).toEqual([]);
		const out = (await call(token, {
			meetingId: s.meetingId,
			status: "coming",
			planHash: p.planHash,
		})) as Applied;
		expect(out).toEqual({ released: [], dutyText: null, draftMessage: null });
		expect(await planOf(s)).toBe("coming");
	});

	// Card: protects=AC2, a hash from before another member's claim at the same
	// meeting is refused with the fresh plan and nothing is written;
	// fails_when=the stale hash applies, or the fresh plan is absent;
	// no_claim=the change here is the caller's own slot set, the state the hash
	// covers.
	it("PLAN_STALE when the member's roles changed since the preview; nothing written", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		await addSlot(s, "Grammarian", s.memberId, 2);

		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					status: "not_coming",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({
			plan: { rolesToFree: ["Timer", "Grammarian"] },
		});
		expect(await planOf(s)).toBeNull();
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toHaveLength(2);
	});

	// Card: protects=blocking codes name why a write cannot happen, and apply
	// refuses with the matching error; fails_when=a cancelled, completed or
	// started meeting, or a repeat answer, is accepted;
	// no_claim=MEETING_PAST uses a scheduledAt in the past with status scheduled.
	it("blocks a cancelled, completed or started meeting and a repeat answer", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		expect(
			(await preview(token, s.meetingId, "coming")).blocking.map((b) => b.code),
		).toEqual(["MEETING_CANCELLED"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
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
		expect(
			(await preview(token, s.meetingId, "coming")).blocking.map((b) => b.code),
		).toEqual(["MEETING_COMPLETED"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
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
		const past = await preview(token, s.meetingId, "coming");
		expect(past.blocking.map((b) => b.code)).toEqual(["MEETING_PAST"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					status: "coming",
					planHash: past.planHash,
				}),
			),
			"BLOCKED",
		);

		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() + 86_400_000) })
			.where(eq(meetings.id, s.meetingId));
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "coming",
		});
		const again = await preview(token, s.meetingId, "coming");
		expect(again.blocking.map((b) => b.code)).toEqual(["ALREADY_THAT_STATUS"]);
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					status: "coming",
					planHash: again.planHash,
				}),
			),
			"BLOCKED",
		);
	});

	// Card: protects=AC3, another club's meeting answers exactly as a stranger's;
	// the input has no member id; fails_when=the refusal differs or a member id
	// is accepted; no_claim=the stranger is a member of a different seeded club.
	it("a meeting in a club the caller is not in is FORBIDDEN, byte-identical to the officer tools'", async () => {
		const mine = await club();
		const theirs = await club();
		const token = await tokenFor(mine.memberUserId);
		const err = await expectMcpError(
			Promise.resolve(
				call(token, { meetingId: theirs.meetingId, status: "coming" }),
			),
			"FORBIDDEN",
		);
		expect(err.message).toBe(NOT_OFFICER_MESSAGE);
		expect(
			Object.keys(setMyAttendanceTool.config.inputSchema ?? {}).sort(),
		).toEqual(["meetingId", "planHash", "status"]);
	});

	// Card: protects=AC8, the feed tells an agent action from a browser one;
	// fails_when=the release or plan rows lack via/proof connector;
	// no_claim=only the rows this tool writes.
	it("records via and proof connector on every activity row it writes", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		await call(token, {
			meetingId: s.meetingId,
			status: "not_coming",
			planHash: p.planHash,
		});
		const rows = await testDb
			.select({ action: activityLog.action, detail: activityLog.detail })
			.from(activityLog)
			.where(eq(activityLog.clubId, s.clubId));
		const plan = rows.find((r) => r.action === "plan_set");
		const release = rows.find((r) => r.action === "release");
		expect(plan?.detail).toMatchObject({
			via: "connector",
			proof: "connector",
		});
		expect(release?.detail).toMatchObject({
			via: "connector",
			proof: "connector",
		});
	});

	// Card: protects=AC4 at the seams: connector proof with actor !== subject is
	// SELF_ONLY, for the release and the decline seam alike, before any write;
	// fails_when=either seam admits it; no_claim=ids are two members of one club.
	it("both seams refuse a connector proof naming another member", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const args = {
			memberId: s.memberId,
			claimedActorMemberId: s.adminMemberId,
			meetingId: s.meetingId,
			clubId: s.clubId,
			proof: "connector" as const,
		};
		await expect(releaseSlotsAndMarkUnavailable(testDb, args)).rejects.toThrow(
			SELF_ONLY_MESSAGE,
		);
		await expect(
			declinePlannedAttendance(testDb, { ...args, releaseHeldRoles: true }),
		).rejects.toThrow(SELF_ONLY_MESSAGE);
		expect(await planOf(s)).toBeNull();
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toHaveLength(1);
	});

	// Card: protects=AC5, the confirm gate refuses a connector proof;
	// fails_when=confirming a held role accepts it; no_claim=voting, ballot and
	// minutes are pinned by the guard test, not executed here.
	it("slot confirm refuses a connector proof that would otherwise confirm", async () => {
		const s = await club();
		const slotId = await holdSeededTimer(s);
		// The holder, signed in, naming themselves: every other gate passes.
		const same = {
			slotId,
			sessionUserId: s.memberUserId,
			selfMemberId: s.memberId,
		};
		await expect(
			confirmSlotCore({ ...same, proof: "connector" }),
		).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
		const statusOf = async () =>
			(
				await testDb
					.select({ status: roleSlots.status })
					.from(roleSlots)
					.where(eq(roleSlots.id, slotId))
			)[0]?.status;
		expect(await statusOf()).toBe("claimed");
		// The control: the same call with a session proof confirms, so the refusal
		// above is the connector's and nothing else's.
		await confirmSlotCore({ ...same, proof: "session" });
		expect(await statusOf()).toBe("confirmed");
	});

	// Card: protects=the not-coming apply is ONE transaction: a failure after the
	// release leaves every role held and no not_coming answer;
	// fails_when=the release runs on a second pooled connection and commits alone;
	// no_claim=the failure is injected into the Toastmaster lookup.
	it("rolls the release back when a later step throws", async () => {
		const s = await club();
		await holdSeededTimer(s);
		await addSlot(s, "Toastmaster of the Day", s.adminMemberId, 0);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		hooks.failAfterRelease = true;
		await expect(
			call(token, {
				meetingId: s.meetingId,
				status: "not_coming",
				planHash: p.planHash,
			}),
		).rejects.toThrow("boom after release");
		expect(await planOf(s)).toBeNull();
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toHaveLength(1);
		const releases = await testDb
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, s.clubId),
					eq(activityLog.action, "release"),
				),
			);
		expect(releases).toEqual([]);
	});

	// Card: protects=a role assigned AFTER the hash check and before the release is
	// never freed unseen; fails_when=the seam frees a slot the user did not
	// preview; no_claim=the assign is injected into the seam's first lock.
	it("PLAN_STALE when a slot lands between the hash check and the release; nothing written", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		hooks.beforeRelease = async () => {
			await addSlot(s, "Grammarian", s.memberId, 2);
		};
		const err = await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					status: "not_coming",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(err.detail).toMatchObject({
			plan: { rolesToFree: ["Timer", "Grammarian"] },
		});
		expect(await planOf(s)).toBeNull();
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toHaveLength(2);
	});

	// Card: protects=the hash covers the member's answer and unavailability, not
	// only their slots; fails_when=a changed answer with no slot change applies;
	// no_claim=none beyond protects.
	it("PLAN_STALE when only the plan status changed (no slot change)", async () => {
		const s = await club();
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "coming");
		expect(p.blocking).toEqual([]);
		await testDb.insert(meetingAttendancePlan).values({
			memberId: s.memberId,
			meetingId: s.meetingId,
			status: "not_coming",
		});
		await expectMcpError(
			Promise.resolve(
				call(token, {
					meetingId: s.meetingId,
					status: "coming",
					planHash: p.planHash,
				}),
			),
			"PLAN_STALE",
		);
		expect(await planOf(s)).toBe("not_coming");
	});

	// Card: protects=a takedown refuses both previews and applies;
	// fails_when=an archived club accepts a member's agent write;
	// no_claim=the refusal's wording is the archive gate's, not asserted here.
	it("an archived club refuses preview and apply", async () => {
		const s = await club();
		await holdSeededTimer(s);
		const token = await tokenFor(s.memberUserId);
		const p = await preview(token, s.meetingId, "not_coming");
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		await expect(preview(token, s.meetingId, "not_coming")).rejects.toThrow();
		await expect(
			call(token, {
				meetingId: s.meetingId,
				status: "not_coming",
				planHash: p.planHash,
			}),
		).rejects.toThrow();
		expect(await planOf(s)).toBeNull();
		const held = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.assignedMemberId, s.memberId));
		expect(held).toHaveLength(1);
	});
});
