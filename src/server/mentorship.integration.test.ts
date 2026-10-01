/**
 * Mentorship (#939), DB-backed: what the DATABASE refuses (self-pairing, a
 * duplicate active pairing), what the WRITE PATH refuses (those two, plus a
 * cross-club or inactive membership), the admin writes and their activity
 * rows, the member's own "willing to mentor" flag and whose row it touches,
 * and what each read returns to whom.
 *
 * The server fns cannot be invoked from vitest, so their gates are tested two
 * ways: the guard functions against real rows here, and their wiring into each
 * fn by `mentorship-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	impersonationSessions,
	members,
	mentorships,
	people,
	user,
} from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Same stand-in as `orientation.integration.test.ts`: the impersonation marker
// is keyed on the object `getRequest()` returns, and outside a request it
// silently no-ops, which would let the attribution test pass vacuously.
let requestRef: object | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		if (!requestRef) throw new Error("No request context");
		return requestRef;
	},
}));

const logic = await import("./mentorship-logic");
const {
	MENTORSHIP_DUPLICATE_MESSAGE,
	MENTORSHIP_ENDED_MESSAGE,
	MENTORSHIP_MEMBER_INACTIVE_MESSAGE,
	MENTORSHIP_MEMBER_NOT_FOUND_MESSAGE,
	MENTORSHIP_NOT_FOUND_MESSAGE,
	MENTORSHIP_NOT_YOURS_MESSAGE,
	MENTORSHIP_SELF_MESSAGE,
	createMentorshipSchema,
	setWillingToMentorSchema,
} = logic;
const { requireClubRole, requireClubViewAccess, NO_PERMISSION_MESSAGE } =
	await import("./guards");

const createdClubs: string[] = [];
const createdUsers: string[] = [];
const createdSuperadmins: string[] = [];

afterEach(async () => {
	if (createdSuperadmins.length > 0) {
		await testDb
			.delete(impersonationSessions)
			.where(
				inArray(impersonationSessions.superadminUserId, createdSuperadmins),
			);
		await testDb.delete(user).where(inArray(user.id, createdSuperadmins));
		createdSuperadmins.length = 0;
	}
	for (const clubId of createdClubs) await cleanup(clubId, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
});

async function seed() {
	const s = await seedClub();
	createdClubs.push(s.clubId);
	createdUsers.push(s.adminUserId, s.memberUserId);
	return s;
}

/** A further membership in the club (no sign-in account). */
async function addMember(
	clubId: string,
	opts: {
		name?: string;
		status?: "active" | "inactive";
		willing?: boolean;
		phone?: string;
	} = {},
) {
	const name = opts.name ?? `Member ${randomUUID().slice(0, 8)}`;
	const [person] = await testDb
		.insert(people)
		// The phone is the Person's (#906).
		.values({ name, phone: opts.phone ?? null })
		.returning({ id: people.id });
	if (!person) throw new Error("fixture");
	const [m] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: person.id,
			name,
			email: `${randomUUID()}@test.example`,
			status: opts.status ?? "active",
			willingToMentor: opts.willing ?? false,
		})
		.returning({ id: members.id });
	if (!m) throw new Error("fixture");
	return m.id;
}

async function superadmin(
	clubId: string,
	mode: "read_only" | "read_write",
): Promise<string> {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "Super Admin",
		email: `super-${id}@test.example`,
		emailVerified: true,
		isSuperadmin: true,
	});
	createdSuperadmins.push(id);
	await testDb.insert(impersonationSessions).values({
		superadminUserId: id,
		clubId,
		mode,
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
	});
	return id;
}

async function pairingsIn(clubId: string) {
	return testDb
		.select()
		.from(mentorships)
		.where(eq(mentorships.clubId, clubId));
}

async function mentorshipLogRows(clubId: string) {
	const rows = await testDb
		.select()
		.from(activityLog)
		.where(eq(activityLog.clubId, clubId));
	return rows.filter(
		(r) =>
			r.action === "member_edit" &&
			(r.detail as { mentorship?: string } | null)?.mentorship !== undefined,
	);
}

async function snapshot(clubId: string) {
	const [pairs, flags] = await Promise.all([
		pairingsIn(clubId),
		testDb
			.select({ id: members.id, willing: members.willingToMentor })
			.from(members)
			.where(eq(members.clubId, clubId)),
	]);
	return JSON.stringify({
		pairs: pairs.map((p) => p.id).sort(),
		ended: pairs.map((p) => `${p.id}:${p.endedAt?.toISOString()}`).sort(),
		flags: flags.map((f) => `${f.id}:${f.willing}`).sort(),
	});
}

/** The SQLSTATE the driver hung on a rejected statement, wherever it sits. */
async function sqlStateOf(p: Promise<unknown>): Promise<string | undefined> {
	try {
		await p;
	} catch (err) {
		let e: unknown = err;
		for (let i = 0; i < 8 && e; i++) {
			const code = (e as { code?: unknown }).code;
			if (typeof code === "string") return code;
			e = (e as { cause?: unknown }).cause;
		}
		return "no-code";
	}
	return undefined;
}

describe.skipIf(!hasTestDb)("what the DATABASE refuses (#939)", () => {
	it("a self-pairing violates the CHECK", async () => {
		const s = await seed();
		expect(
			await sqlStateOf(
				testDb.insert(mentorships).values({
					clubId: s.clubId,
					mentorMemberId: s.memberId,
					menteeMemberId: s.memberId,
				}),
			),
		).toBe("23514");
	});

	it("a duplicate ACTIVE pairing with the same focus violates the partial unique index", async () => {
		const s = await seed();
		const row = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			focus: "new_member" as const,
		};
		await testDb.insert(mentorships).values(row);
		expect(await sqlStateOf(testDb.insert(mentorships).values(row))).toBe(
			"23505",
		);
	});

	it("a duplicate active pairing with NO focus is refused too (the second index)", async () => {
		const s = await seed();
		const row = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
		};
		await testDb.insert(mentorships).values(row);
		expect(await sqlStateOf(testDb.insert(mentorships).values(row))).toBe(
			"23505",
		);
	});

	it("allows the same pair with another focus, and again once the first has ended", async () => {
		const s = await seed();
		const base = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
		};
		await testDb
			.insert(mentorships)
			.values({ ...base, focus: "new_member", endedAt: new Date() });
		await testDb.insert(mentorships).values({ ...base, focus: "new_member" });
		await testDb.insert(mentorships).values({ ...base, focus: "contest" });
		expect(await pairingsIn(s.clubId)).toHaveLength(3);
	});

	it("focus_other without focus 'other' violates its CHECK", async () => {
		const s = await seed();
		expect(
			await sqlStateOf(
				testDb.insert(mentorships).values({
					clubId: s.clubId,
					mentorMemberId: s.adminMemberId,
					menteeMemberId: s.memberId,
					focus: "contest",
					focusOther: "stray",
				}),
			),
		).toBe("23514");
	});

	it("deleting a membership cascades its pairings; deleting the creator only nulls the attribution", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId);
		const creator = await addMember(s.clubId);
		await testDb.insert(mentorships).values({
			clubId: s.clubId,
			mentorMemberId: mentor,
			menteeMemberId: s.memberId,
			createdByMemberId: creator,
		});
		await testDb.delete(members).where(eq(members.id, creator));
		let rows = await pairingsIn(s.clubId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.createdByMemberId).toBeNull();
		await testDb.delete(members).where(eq(members.id, mentor));
		rows = await pairingsIn(s.clubId);
		expect(rows).toHaveLength(0);
	});
});

describe.skipIf(!hasTestDb)("what the WRITE PATH refuses (#939)", () => {
	it("self-pairing", async () => {
		const s = await seed();
		await expect(
			logic.createMentorship({
				clubId: s.clubId,
				mentorMemberId: s.memberId,
				menteeMemberId: s.memberId,
				focus: "new_member",
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_SELF_MESSAGE);
		expect(await pairingsIn(s.clubId)).toHaveLength(0);
	});

	it("cross-club pairing, either side", async () => {
		const a = await seed();
		const b = await seed();
		for (const [mentor, mentee] of [
			[b.memberId, a.memberId],
			[a.adminMemberId, b.memberId],
		] as const) {
			await expect(
				logic.createMentorship({
					clubId: a.clubId,
					mentorMemberId: mentor,
					menteeMemberId: mentee,
					focus: null,
					actorMemberId: a.adminMemberId,
				}),
			).rejects.toThrow(MENTORSHIP_MEMBER_NOT_FOUND_MESSAGE);
		}
		expect(await pairingsIn(a.clubId)).toHaveLength(0);
		expect(await pairingsIn(b.clubId)).toHaveLength(0);
	});

	it("a duplicate active pairing (the index's refusal, translated)", async () => {
		const s = await seed();
		const input = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			focus: "new_member" as const,
			actorMemberId: s.adminMemberId,
		};
		await logic.createMentorship(input);
		await expect(logic.createMentorship(input)).rejects.toThrow(
			MENTORSHIP_DUPLICATE_MESSAGE,
		);
		expect(await pairingsIn(s.clubId)).toHaveLength(1);
		// The failed attempt logged nothing: the log commits with the insert.
		expect(await mentorshipLogRows(s.clubId)).toHaveLength(1);
	});

	it("two admins pairing the same two AT ONCE leave exactly one row", async () => {
		const s = await seed();
		const input = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			focus: null,
			actorMemberId: s.adminMemberId,
		};
		const results = await Promise.allSettled([
			logic.createMentorship(input),
			logic.createMentorship(input),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason.message).toBe(
			MENTORSHIP_DUPLICATE_MESSAGE,
		);
		expect(await pairingsIn(s.clubId)).toHaveLength(1);
	});

	it("an inactive (former) member on either side", async () => {
		const s = await seed();
		const lapsed = await addMember(s.clubId, { status: "inactive" });
		for (const [mentor, mentee] of [
			[lapsed, s.memberId],
			[s.adminMemberId, lapsed],
		] as const) {
			await expect(
				logic.createMentorship({
					clubId: s.clubId,
					mentorMemberId: mentor,
					menteeMemberId: mentee,
					focus: null,
					actorMemberId: s.adminMemberId,
				}),
			).rejects.toThrow(MENTORSHIP_MEMBER_INACTIVE_MESSAGE);
		}
		expect(await pairingsIn(s.clubId)).toHaveLength(0);
	});

	it("changing focus into a duplicate is refused and changes nothing", async () => {
		const s = await seed();
		const base = {
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			actorMemberId: s.adminMemberId,
		};
		await logic.createMentorship({ ...base, focus: "new_member" });
		const { id } = await logic.createMentorship({ ...base, focus: "contest" });
		await expect(
			logic.setMentorshipFocus({
				clubId: s.clubId,
				mentorshipId: id,
				focus: "new_member",
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_DUPLICATE_MESSAGE);
		const [row] = await testDb
			.select({ focus: mentorships.focus })
			.from(mentorships)
			.where(eq(mentorships.id, id));
		expect(row?.focus).toBe("contest");
	});

	it("ending or re-focusing a pairing from another club, or an ended one", async () => {
		const a = await seed();
		const b = await seed();
		const { id } = await logic.createMentorship({
			clubId: b.clubId,
			mentorMemberId: b.adminMemberId,
			menteeMemberId: b.memberId,
			focus: null,
			actorMemberId: b.adminMemberId,
		});
		await expect(
			logic.endMentorship({
				clubId: a.clubId,
				mentorshipId: id,
				actorMemberId: a.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_NOT_FOUND_MESSAGE);
		await expect(
			logic.setMentorshipFocus({
				clubId: a.clubId,
				mentorshipId: id,
				focus: "contest",
				actorMemberId: a.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_NOT_FOUND_MESSAGE);
		expect((await pairingsIn(b.clubId))[0]?.endedAt).toBeNull();

		await logic.endMentorship({
			clubId: b.clubId,
			mentorshipId: id,
			actorMemberId: b.adminMemberId,
		});
		await expect(
			logic.endMentorship({
				clubId: b.clubId,
				mentorshipId: id,
				actorMemberId: b.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_ENDED_MESSAGE);
	});

	it("the create schema is strict and requires a real focus value", () => {
		const ok = {
			clubId: randomUUID(),
			mentorMemberId: randomUUID(),
			menteeMemberId: randomUUID(),
			focus: null,
		};
		expect(createMentorshipSchema.safeParse(ok).success).toBe(true);
		expect(
			createMentorshipSchema.safeParse({ ...ok, focus: "club_mentor" }).success,
		).toBe(false);
		expect(
			createMentorshipSchema.safeParse({ ...ok, createdByMemberId: "x" })
				.success,
		).toBe(false);
	});
});

describe.skipIf(!hasTestDb)("the admin writes (#939)", () => {
	it("create, change focus and end: the row, the history and the log", async () => {
		const s = await seed();
		const { id } = await logic.createMentorship({
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			focus: "other",
			focusOther: "  Toastmasters speech contest judging  ",
			actorMemberId: s.adminMemberId,
		});
		let [row] = await pairingsIn(s.clubId);
		expect(row).toMatchObject({
			id,
			focus: "other",
			focusOther: "Toastmasters speech contest judging",
			endedAt: null,
			createdByMemberId: s.adminMemberId,
		});

		await logic.setMentorshipFocus({
			clubId: s.clubId,
			mentorshipId: id,
			focus: "leadership",
			focusOther: "dropped: not 'other'",
			actorMemberId: s.adminMemberId,
		});
		[row] = await pairingsIn(s.clubId);
		expect(row).toMatchObject({ focus: "leadership", focusOther: null });

		await logic.endMentorship({
			clubId: s.clubId,
			mentorshipId: id,
			actorMemberId: s.adminMemberId,
		});
		[row] = await pairingsIn(s.clubId);
		expect(row?.endedAt).toBeInstanceOf(Date);

		const log = await mentorshipLogRows(s.clubId);
		expect(
			log.map((r) => (r.detail as { mentorship: string }).mentorship).sort(),
		).toEqual(["created", "ended", "focus_changed"]);
		for (const r of log) {
			expect(r).toMatchObject({
				actorMemberId: s.adminMemberId,
				impersonatedBy: null,
				targetType: "member",
				targetId: s.memberId,
			});
		}
	});

	it("under a read-write impersonation, the log names the real superadmin", async () => {
		const s = await seed();
		const superadminId = await superadmin(s.clubId, "read_write");
		requestRef = { id: "req" };
		try {
			const actor = await requireClubRole(superadminId, s.clubId, ["admin"]);
			expect(actor.id).toBeNull();
			await logic.createMentorship({
				clubId: s.clubId,
				mentorMemberId: s.adminMemberId,
				menteeMemberId: s.memberId,
				focus: "new_member",
				actorMemberId: actor.id,
			});
		} finally {
			requestRef = null;
		}
		const rows = await mentorshipLogRows(s.clubId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBeNull();
		expect(rows[0]?.impersonatedBy).toBe(superadminId);
	});

	it("the admin write gate refuses a plain member (so no pairing is written)", async () => {
		const s = await seed();
		await expect(
			requireClubRole(s.memberUserId, s.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
	});
});

describe.skipIf(!hasTestDb)(
	"willing to mentor, the member's own flag (#939)",
	() => {
		it("defaults to false, and the member sets and clears their own", async () => {
			const s = await seed();
			const flag = async (id: string) =>
				(
					await testDb
						.select({ w: members.willingToMentor })
						.from(members)
						.where(eq(members.id, id))
				)[0]?.w;
			expect(await flag(s.memberId)).toBe(false);
			await logic.setMyWillingToMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				willing: true,
			});
			expect(await flag(s.memberId)).toBe(true);
			expect(await flag(s.adminMemberId)).toBe(false);
			await logic.setMyWillingToMentor({
				userId: s.memberUserId,
				clubId: s.clubId,
				willing: false,
			});
			expect(await flag(s.memberId)).toBe(false);
		});

		it("a member cannot toggle someone else's flag: the input names no member", () => {
			const base = { clubId: randomUUID(), willing: true };
			expect(setWillingToMentorSchema.safeParse(base).success).toBe(true);
			for (const extra of ["memberId", "userId", "membershipId"]) {
				expect(
					setWillingToMentorSchema.safeParse({ ...base, [extra]: randomUUID() })
						.success,
					extra,
				).toBe(false);
			}
		});

		it("an admin toggling it writes THEIR OWN row, never the member's", async () => {
			const s = await seed();
			await logic.setMyWillingToMentor({
				userId: s.adminUserId,
				clubId: s.clubId,
				willing: true,
			});
			const rows = await testDb
				.select({ id: members.id, w: members.willingToMentor })
				.from(members)
				.where(eq(members.clubId, s.clubId));
			expect(rows.filter((r) => r.w).map((r) => r.id)).toEqual([
				s.adminMemberId,
			]);
		});

		it("a member of another club cannot write into this one", async () => {
			const a = await seed();
			const b = await seed();
			const before = await snapshot(a.clubId);
			await expect(
				logic.setMyWillingToMentor({
					userId: b.memberUserId,
					clubId: a.clubId,
					willing: true,
				}),
			).rejects.toThrow();
			expect(await snapshot(a.clubId)).toEqual(before);
		});

		it("a read-write impersonator (no membership of their own) is refused", async () => {
			const s = await seed();
			const superadminId = await superadmin(s.clubId, "read_write");
			const before = await snapshot(s.clubId);
			await expect(
				logic.setMyWillingToMentor({
					userId: superadminId,
					clubId: s.clubId,
					willing: true,
				}),
			).rejects.toThrow(MENTORSHIP_NOT_YOURS_MESSAGE);
			expect(await snapshot(s.clubId)).toEqual(before);
		});
	},
);

describe.skipIf(!hasTestDb)("who reads what (#939)", () => {
	async function pairedClub() {
		const s = await seed();
		const mentor = await addMember(s.clubId, {
			name: "Maya Mentor",
			phone: "(555) 555-0100",
			willing: true,
		});
		const other = await addMember(s.clubId, { name: "Otto Other" });
		const { id } = await logic.createMentorship({
			clubId: s.clubId,
			mentorMemberId: mentor,
			menteeMemberId: s.memberId,
			focus: "new_member",
			actorMemberId: s.adminMemberId,
		});
		return { ...s, mentor, other, pairingId: id };
	}

	it("the mentee sees the mentor with contact; the mentor sees the mentee with contact", async () => {
		const c = await pairedClub();
		const mine = await logic.loadMyMentorships(c.memberId);
		expect(mine?.mentees).toEqual([]);
		expect(mine?.mentors).toHaveLength(1);
		expect(mine?.mentors[0]).toMatchObject({
			id: c.pairingId,
			focus: "new_member",
			member: { id: c.mentor, name: "Maya Mentor" },
		});
		expect(mine?.mentors[0]?.member.email).toMatch(/@test\.example$/);
		expect(mine?.mentors[0]?.member.phone).toMatch(/^\+\d+$/);

		const theirs = await logic.loadMyMentorships(c.mentor);
		expect(theirs?.willingToMentor).toBe(true);
		expect(theirs?.mentors).toEqual([]);
		expect(theirs?.mentees.map((m) => m.member.id)).toEqual([c.memberId]);
		expect(theirs?.mentees[0]?.member.email).toMatch(/^member-/);
	});

	const deactivate = (id: string) =>
		testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, id));
	const reactivate = (id: string) =>
		testDb.update(members).set({ status: "active" }).where(eq(members.id, id));

	it("a deactivated mentor's pairing is dormant on both dashboards, and back on reactivation", async () => {
		const c = await pairedClub();
		await deactivate(c.mentor);
		expect((await logic.loadMyMentorships(c.memberId))?.mentors).toEqual([]);
		expect((await logic.loadMyMentorships(c.mentor))?.mentees).toEqual([]);
		// The row is untouched, so reactivating restores it with no data change.
		expect((await pairingsIn(c.clubId))[0]?.endedAt).toBeNull();
		await reactivate(c.mentor);
		expect(
			(await logic.loadMyMentorships(c.memberId))?.mentors.map(
				(m) => m.member.id,
			),
		).toEqual([c.mentor]);
	});

	it("the club list drops a pairing with a deactivated mentor, and its mentee counts as unpaired", async () => {
		const c = await pairedClub();
		await deactivate(c.mentor);
		const list = await logic.loadClubMentorships(c.clubId);
		expect(list.active).toEqual([]);
		expect(list.unpaired.map((u) => u.id)).toContain(c.memberId);
		expect(list.unpaired.map((u) => u.id)).not.toContain(c.mentor);
	});

	it("re-focusing a pairing whose mentor is inactive is refused and changes nothing", async () => {
		const c = await pairedClub();
		await deactivate(c.mentor);
		await expect(
			logic.setMentorshipFocus({
				clubId: c.clubId,
				mentorshipId: c.pairingId,
				focus: "contest",
				actorMemberId: c.adminMemberId,
			}),
		).rejects.toThrow(MENTORSHIP_MEMBER_INACTIVE_MESSAGE);
		expect((await pairingsIn(c.clubId))[0]?.focus).toBe("new_member");
		expect(
			(await mentorshipLogRows(c.clubId)).filter(
				(r) =>
					(r.detail as { mentorship: string }).mentorship === "focus_changed",
			),
		).toHaveLength(0);
	});

	it("a member who is neither party sees nothing of it", async () => {
		const c = await pairedClub();
		const mine = await logic.loadMyMentorships(c.other);
		expect(mine?.mentors).toEqual([]);
		expect(mine?.mentees).toEqual([]);
	});

	it("an ended pairing disappears from both dashboards", async () => {
		const c = await pairedClub();
		await logic.endMentorship({
			clubId: c.clubId,
			mentorshipId: c.pairingId,
			actorMemberId: c.adminMemberId,
		});
		expect((await logic.loadMyMentorships(c.memberId))?.mentors).toEqual([]);
		expect((await logic.loadMyMentorships(c.mentor))?.mentees).toEqual([]);
	});

	it("a read-only impersonator's dashboard read has no membership (so no pairing)", async () => {
		const c = await pairedClub();
		const superadminId = await superadmin(c.clubId, "read_only");
		const access = await requireClubViewAccess(superadminId, c.clubId);
		expect(access.membership).toBeNull();
	});

	it("the admin's member read: that member's pairings and the picker, willing first, without the member", async () => {
		const c = await pairedClub();
		const view = await logic.loadMemberMentorships({
			clubId: c.clubId,
			memberId: c.memberId,
		});
		expect(view?.mentors.map((m) => m.member.id)).toEqual([c.mentor]);
		const ids = view?.candidates.map((x) => x.id) ?? [];
		expect(ids[0]).toBe(c.mentor);
		expect(ids).not.toContain(c.memberId);
		expect(ids).toContain(c.other);
	});

	it("the admin's member read of another club's member answers null", async () => {
		const a = await seed();
		const b = await seed();
		expect(
			await logic.loadMemberMentorships({
				clubId: a.clubId,
				memberId: b.memberId,
			}),
		).toBeNull();
	});

	it("the club list: active pairings, members with no active mentor, who is willing", async () => {
		const c = await pairedClub();
		const lapsed = await addMember(c.clubId, { status: "inactive" });
		const list = await logic.loadClubMentorships(c.clubId);
		expect(list.active.map((p) => [p.mentor.id, p.mentee.id])).toEqual([
			[c.mentor, c.memberId],
		]);
		const unpaired = list.unpaired.map((u) => u.id);
		expect(unpaired).not.toContain(c.memberId);
		expect(unpaired).toEqual(
			expect.arrayContaining([c.mentor, c.other, c.adminMemberId]),
		);
		expect(unpaired).not.toContain(lapsed);
		expect(list.willing.map((w) => w.id)).toEqual([c.mentor]);

		await logic.endMentorship({
			clubId: c.clubId,
			mentorshipId: c.pairingId,
			actorMemberId: c.adminMemberId,
		});
		const after = await logic.loadClubMentorships(c.clubId);
		expect(after.active).toEqual([]);
		expect(after.unpaired.map((u) => u.id)).toContain(c.memberId);
	});

	it("reads write nothing", async () => {
		const c = await pairedClub();
		const before = await snapshot(c.clubId);
		const logBefore = (await mentorshipLogRows(c.clubId)).length;
		await logic.loadMyMentorships(c.memberId);
		await logic.loadMemberMentorships({
			clubId: c.clubId,
			memberId: c.memberId,
		});
		await logic.loadClubMentorships(c.clubId);
		expect(await snapshot(c.clubId)).toEqual(before);
		expect(await mentorshipLogRows(c.clubId)).toHaveLength(logBefore);
	});
});
