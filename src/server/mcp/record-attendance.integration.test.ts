/**
 * DB-backed tests for `record_attendance` (#1573), called with real minted tokens.
 *
 * Card: protects=an officer's agent can record the ROLL (members present /
 * absent / excused, guests added and removed) in one previewed, hash-confirmed
 * transaction, and nobody else's agent can; fails_when=a preview writes, an
 * ambiguous new guest is created unconfirmed, one bad entry leaves the rest
 * written, a completed meeting is refused, a cancelled or future one is
 * accepted, or a plain member / Toastmaster / Ballot Counter writes;
 * no_claim=tokens are minted directly (no OAuth), and the member-audience
 * refusal is the dispatcher's stamp, exercised here by `audience: "officer"`.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordAttendanceTool } = await import(
	"#/server/mcp/tools/record-attendance"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const { McpError } = await import("#/server/mcp/errors");
const { createGuestRecord } = await import("#/server/guests-logic");

const seeded: SeededClub[] = [];
const extraUsers: string[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
	for (const id of extraUsers.splice(0)) {
		await testDb.delete(people).where(eq(people.userId, id));
		await testDb.delete(user).where(eq(user.id, id));
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	// The roll is taken at or after the meeting: put it a day ago.
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
		.where(eq(meetings.id, s.meetingId));
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

type Blocking = { code: string; message: string; entryIndex?: number };
type Line = { verdict: string; [k: string]: unknown };
type Preview = {
	applied: false;
	planHash: string;
	blocking: Blocking[];
	plan: {
		members: Line[];
		guests: Line[];
		removeGuests: Line[];
		summary: Record<string, number>;
	};
};
type Applied = {
	applied: true;
	written: { index: number; guestId: string }[];
	skipped: { index: number }[];
};

function call(token: string, args: Record<string, unknown>) {
	return recordAttendanceTool.handler(args, {
		rawToken: token,
		audience: "officer",
	});
}
const preview = (token: string, args: Record<string, unknown>) =>
	call(token, args) as Promise<Preview>;
async function apply(token: string, args: Record<string, unknown>) {
	const p = await preview(token, args);
	return call(token, { ...args, planHash: p.planHash }) as Promise<Applied>;
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

async function roll(s: SeededClub) {
	return testDb
		.select({
			memberId: meetingAttendance.memberId,
			guestId: meetingAttendance.guestId,
			status: meetingAttendance.status,
			mode: meetingAttendance.mode,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, s.meetingId));
}

async function newGuest(s: SeededClub, name: string) {
	const g = await createGuestRecord(testDb, {
		clubId: s.clubId,
		name,
		email: null,
		phone: null,
	});
	return g.id;
}

/** A member with their own sign-in who holds a slot of `roleName` in the meeting. */
async function holderOf(s: SeededClub, roleName: string) {
	const userId = randomUUID();
	extraUsers.push(userId);
	await testDb.insert(user).values({
		id: userId,
		name: roleName,
		email: `${roleName.replaceAll(" ", "")}-${userId}@test.example`,
		emailVerified: true,
	});
	const [p] = await testDb
		.insert(people)
		.values({ name: roleName, email: `${userId}@test.example`, userId })
		.returning({ id: people.id });
	const [m] = await testDb
		.insert(members)
		.values({
			clubId: s.clubId,
			personId: p?.id as string,
			name: `${roleName} Holder`,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: s.clubId,
			name: roleName,
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleSlots).values({
		meetingId: s.meetingId,
		roleDefinitionId: def?.id as string,
		status: "claimed",
		assignedMemberId: m?.id as string,
	});
	return { userId, memberId: m?.id as string };
}

describe.skipIf(!hasTestDb)("record_attendance (#1573)", () => {
	it("preview writes nothing; a mixed call is one plan and one planHash", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const keep = await newGuest(s, "Kept Guest");
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: s.meetingId, guestId: keep, status: "present" });
		const known = await newGuest(s, "Zorro Visitor");
		const p = await preview(token, {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present", mode: "online" }],
			guests: [{ guestId: known }, { newGuest: { name: "Qwerty Plinth" } }],
			removeGuests: [keep],
		});
		expect(p.applied).toBe(false);
		expect(p.blocking).toEqual([]);
		expect(p.planHash).toMatch(/^[0-9a-f]+$/);
		expect(p.plan.members[0]?.verdict).toBe("change");
		expect(p.plan.guests.map((l) => l.verdict)).toEqual([
			"add",
			"would_create",
		]);
		expect(p.plan.removeGuests[0]?.verdict).toBe("remove");
		expect(await roll(s)).toHaveLength(1);
	});

	it("apply writes the member's status and mode, and re-sending changes nothing", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const args = {
			meetingId: s.meetingId,
			members: [
				{ memberId: s.memberId, status: "present", mode: "online" },
				{ memberId: s.adminMemberId, status: "excused" },
			],
		};
		const r = await apply(token, args);
		expect(r.applied).toBe(true);
		const rows = await roll(s);
		expect(rows).toHaveLength(2);
		expect(rows.find((x) => x.memberId === s.memberId)).toMatchObject({
			status: "present",
			mode: "online",
		});
		expect(rows.find((x) => x.memberId === s.adminMemberId)).toMatchObject({
			status: "excused",
			mode: null,
		});
		const again = await preview(token, args);
		expect(again.plan.members.map((l) => l.verdict)).toEqual([
			"already_recorded",
			"already_recorded",
		]);
		await call(token, { ...args, planHash: again.planHash });
		expect(await roll(s)).toEqual(rows);
	});

	it("an omitted mode on a present entry leaves a recorded mode", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await testDb.insert(meetingAttendance).values({
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "absent",
		});
		await testDb
			.update(meetingAttendance)
			.set({ status: "present", mode: "in_person" })
			.where(eq(meetingAttendance.memberId, s.memberId));
		const p = await preview(token, {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		});
		expect(p.plan.members[0]?.verdict).toBe("already_recorded");
	});

	it("refuses a mode with absent or excused at the schema", () => {
		const schema = (
			recordAttendanceTool.config.inputSchema as unknown as Record<
				string,
				import("zod").ZodType
			>
		).members as import("zod").ZodType;
		for (const status of ["absent", "excused"]) {
			expect(
				schema.safeParse([{ memberId: randomUUID(), status, mode: "online" }])
					.success,
			).toBe(false);
		}
		expect(
			schema.safeParse([
				{ memberId: randomUUID(), status: "present", mode: "online" },
			]).success,
		).toBe(true);
	});

	it("requires at least one list", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await expectMcpError(call(token, { meetingId: s.meetingId }), "VALIDATION");
	});

	it("accepts a completed meeting", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, s.meetingId));
		await apply(token, {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		});
		expect(await roll(s)).toHaveLength(1);
	});

	it("refuses a cancelled meeting and writes nothing", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		const args = {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		};
		const p = await preview(token, args);
		expect(p.blocking[0]).toMatchObject({
			code: "MEETING_CANCELLED",
			message: MEETING_CANCELLED_MESSAGE,
		});
		await expectMcpError(
			call(token, { ...args, planHash: p.planHash }),
			"BLOCKED",
		);
		expect(await roll(s)).toHaveLength(0);
	});

	it("refuses a meeting before its day and writes nothing", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, s.meetingId));
		const args = {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		};
		const p = await preview(token, args);
		expect(p.blocking[0]?.code).toBe("ATTENDANCE_BEFORE_MEETING");
		await expectMcpError(
			call(token, { ...args, planHash: p.planHash }),
			"BLOCKED",
		);
		expect(await roll(s)).toHaveLength(0);
	});

	it("an ambiguous newGuest is skipped unless confirmed, and the rest applies", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await newGuest(s, "Jon Smith");
		const args = {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
			guests: [{ newGuest: { name: "Jon Smith" } }],
		};
		const p = await preview(token, args);
		expect(p.blocking).toEqual([]);
		expect(p.plan.guests[0]?.verdict).toBe("ambiguous");

		const r = await call(token, { ...args, planHash: p.planHash });
		expect((r as Applied).skipped).toHaveLength(1);
		expect(
			await testDb.select().from(guests).where(eq(guests.clubId, s.clubId)),
		).toHaveLength(1);
		expect(await roll(s)).toHaveLength(1);

		// Confirmed: the plan changes, so the old hash is stale.
		const confirmed = { ...args, confirmNew: [0] };
		await expectMcpError(
			call(token, { ...confirmed, planHash: p.planHash }),
			"PLAN_STALE",
		);
		const r2 = (await apply(token, confirmed)) as Applied;
		expect(r2.written).toHaveLength(1);
		expect(
			await testDb.select().from(guests).where(eq(guests.clubId, s.clubId)),
		).toHaveLength(2);
	});

	it("a newGuest close to a member is ambiguous too", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const p = await preview(token, {
			meetingId: s.meetingId,
			guests: [{ newGuest: { name: "Member User" } }],
		});
		expect(p.plan.guests[0]?.verdict).toBe("ambiguous");
	});

	it("confirmNew must point at a newGuest entry", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await expectMcpError(
			call(token, {
				meetingId: s.meetingId,
				guests: [{ newGuest: { name: "Qwerty Plinth" } }],
				confirmNew: [3],
			}),
			"VALIDATION",
		);
	});

	it("removeGuests deletes the roll row and leaves the club guest", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const g = await newGuest(s, "Rollo Visitor");
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: s.meetingId, guestId: g, status: "present" });
		await apply(token, { meetingId: s.meetingId, removeGuests: [g] });
		expect(await roll(s)).toHaveLength(0);
		expect(
			await testDb.select().from(guests).where(eq(guests.id, g)),
		).toHaveLength(1);
	});

	it("a guest mode replaces a recorded one only when given", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const g = await newGuest(s, "Modal Visitor");
		await apply(token, {
			meetingId: s.meetingId,
			guests: [{ guestId: g, mode: "online" }],
		});
		const same = await preview(token, {
			meetingId: s.meetingId,
			guests: [{ guestId: g }],
		});
		expect(same.plan.guests[0]?.verdict).toBe("already_recorded");
		await apply(token, {
			meetingId: s.meetingId,
			guests: [{ guestId: g, mode: "in_person" }],
		});
		expect((await roll(s))[0]?.mode).toBe("in_person");
	});

	it("blocks a member of another club, and writes nothing from the call", async () => {
		const s = await club();
		const other = await club();
		const token = await tokenFor(s.adminUserId);
		const args = {
			meetingId: s.meetingId,
			members: [
				{ memberId: s.memberId, status: "present" },
				{ memberId: other.memberId, status: "present" },
			],
		};
		const p = await preview(token, args);
		expect(p.blocking).toMatchObject([{ code: "NOT_A_MEMBER", entryIndex: 1 }]);
		await expectMcpError(
			call(token, { ...args, planHash: p.planHash }),
			"BLOCKED",
		);
		expect(await roll(s)).toHaveLength(0);
	});

	it("blocks an unknown guest, a duplicate person, and a guest both added and removed", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const g = await newGuest(s, "Twice Visitor");
		const p = await preview(token, {
			meetingId: s.meetingId,
			members: [
				{ memberId: s.memberId, status: "present" },
				{ memberId: s.memberId.toUpperCase(), status: "absent" },
			],
			guests: [{ guestId: randomUUID() }, { guestId: g }],
			removeGuests: [g],
		});
		expect(p.blocking.map((b) => b.code).sort()).toEqual([
			"CONFLICTING_GUEST_ENTRIES",
			"DUPLICATE_PERSON",
			"NOT_A_GUEST",
		]);
	});

	it("a drifted roll makes the hash stale", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		const args = {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		};
		const p = await preview(token, args);
		await testDb.insert(meetingAttendance).values({
			meetingId: s.meetingId,
			memberId: s.memberId,
			status: "absent",
		});
		await expectMcpError(
			call(token, { ...args, planHash: p.planHash }),
			"PLAN_STALE",
		);
	});

	it("never releases roles: an absent member keeps their slot", async () => {
		const s = await club();
		const token = await tokenFor(s.adminUserId);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: s.memberId, status: "claimed" })
			.where(eq(roleSlots.id, s.slotId));
		await apply(token, {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "absent" }],
		});
		const [slot] = await testDb
			.select({ holder: roleSlots.assignedMemberId })
			.from(roleSlots)
			.where(and(eq(roleSlots.id, s.slotId)));
		expect(slot?.holder).toBe(s.memberId);
	});

	it("refuses a plain member, the Toastmaster and the Ballot Counter", async () => {
		const s = await club();
		const tm = await holderOf(s, "Toastmaster");
		const bc = await holderOf(s, "Ballot Counter");
		const args = {
			meetingId: s.meetingId,
			members: [{ memberId: s.memberId, status: "present" }],
		};
		for (const userId of [s.memberUserId, tm.userId, bc.userId]) {
			const token = await tokenFor(userId);
			const err = await expectMcpError(call(token, args), "FORBIDDEN");
			expect(err.message).toBe(NOT_OFFICER_MESSAGE);
		}
		expect(await roll(s)).toHaveLength(0);
	});
});
