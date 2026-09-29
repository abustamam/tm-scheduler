/**
 * New-member orientation (#940), DB-backed: the facts the checklist is derived
 * from, the member's own writes (Base Camp self-tick, "I'm all set") and whose
 * row they touch, the admin's "Start orientation" and the gate it sits behind,
 * reads that write nothing, and which membership-creating paths put a member
 * into orientation (the column default) and which do not (roster import).
 *
 * The server fns cannot be invoked from vitest, so the gates are tested two
 * ways: the guard functions and the logic's own session resolution against
 * real rows here, and their wiring into each fn by
 * `orientation-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	impersonationSessions,
	meetings,
	members,
	pathEnrollments,
	pathwaysPaths,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { DEFAULT_CLUB_TIMEZONE } from "#/lib/club-timezone";
import type { MappedMember } from "#/lib/members-csv";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// The impersonation marker is keyed on the object `getRequest()` returns
// (impersonation-actor.ts); outside a request that throws and the marker
// silently no-ops. Same stand-in as `write-actor.integration.test.ts`, so the
// impersonated-attribution test below can actually fail.
let requestRef: object | null = null;
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		if (!requestRef) throw new Error("No request context");
		return requestRef;
	},
}));

const logic = await import("./orientation-logic");
const {
	ORIENTATION_NOT_YOURS_MESSAGE,
	ORIENTATION_MEMBER_NOT_FOUND_MESSAGE,
	ORIENTATION_MEMBER_INACTIVE_MESSAGE,
	dismissOrientationSchema,
	setBasecampSetupSchema,
	startOrientationSchema,
} = logic;
const {
	requireClubAdminView,
	requireClubRole,
	requireClubViewAccess,
	NO_PERMISSION_MESSAGE,
} = await import("./guards");

const createdClubs: string[] = [];
const createdUsers: string[] = [];
const createdSuperadmins: string[] = [];
const createdPaths: string[] = [];

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
	// Club-less catalog rows: delete only the ones this file made.
	if (createdPaths.length > 0) {
		await testDb
			.delete(pathwaysPaths)
			.where(inArray(pathwaysPaths.id, createdPaths));
		createdPaths.length = 0;
	}
});

async function seed() {
	const s = await seedClub();
	createdClubs.push(s.clubId);
	createdUsers.push(s.adminUserId, s.memberUserId);
	return s;
}

async function orientationRow(memberId: string) {
	const [row] = await testDb
		.select({
			startedAt: members.orientationStartedAt,
			dismissedAt: members.orientationDismissedAt,
			basecampSetupAt: members.basecampSetupAt,
		})
		.from(members)
		.where(eq(members.id, memberId));
	if (!row) throw new Error("no member");
	return row;
}

/** A slot in a new meeting of the given status, assigned to the member. */
async function assignSlot(
	clubId: string,
	memberId: string,
	opts: { speaker: boolean; status: "scheduled" | "cancelled" | "completed" },
) {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: opts.speaker ? `Speaker ${randomUUID()}` : `Timer ${randomUUID()}`,
			category: opts.speaker ? "speaker" : "functionary",
			isSpeakerRole: opts.speaker,
		})
		.returning({ id: roleDefinitions.id });
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
			status: opts.status,
		})
		.returning({ id: meetings.id });
	if (!def || !meeting) throw new Error("fixture");
	await testDb.insert(roleSlots).values({
		meetingId: meeting.id,
		roleDefinitionId: def.id,
		assignedMemberId: memberId,
		status: "claimed",
	});
}

async function enroll(personId: string, archived = false) {
	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: `T940-${randomUUID()}`, name: "Test Path 940" })
		.returning({ id: pathwaysPaths.id });
	if (!path) throw new Error("no path");
	createdPaths.push(path.id);
	await testDb.insert(pathEnrollments).values({
		personId,
		pathId: path.id,
		archivedAt: archived ? new Date() : null,
	});
}

/** The `member_edit` rows startOrientation wrote in a club. */
async function startRows(clubId: string) {
	const rows = await testDb
		.select()
		.from(activityLog)
		.where(eq(activityLog.clubId, clubId));
	return rows.filter(
		(r) =>
			r.action === "member_edit" &&
			(r.detail as { orientation?: string } | null)?.orientation === "started",
	);
}

async function orientationSnapshot(clubId: string) {
	return (
		await testDb
			.select({
				id: members.id,
				startedAt: members.orientationStartedAt,
				dismissedAt: members.orientationDismissedAt,
				basecampSetupAt: members.basecampSetupAt,
			})
			.from(members)
			.where(eq(members.clubId, clubId))
	).map((r) => JSON.stringify(r));
}

describe.skipIf(!hasTestDb)("orientation facts and view (#940)", () => {
	it("a membership inserted after rollout starts in orientation (column default)", async () => {
		const s = await seed();
		const row = await orientationRow(s.memberId);
		expect(row.startedAt).toBeInstanceOf(Date);
		expect(row.dismissedAt).toBeNull();
		const view = await logic.getOrientation(s.memberId);
		expect(view?.visible).toBe(true);
		expect(view?.doneCount).toBe(0);
	});

	it("a veteran (started_at null) has no visible checklist", async () => {
		const s = await seed();
		await testDb
			.update(members)
			.set({ orientationStartedAt: null })
			.where(eq(members.id, s.memberId));
		const view = await logic.getOrientation(s.memberId);
		expect(view?.inOrientation).toBe(false);
		expect(view?.visible).toBe(false);
	});

	it("derives the path item from a live enrollment, not an archived one", async () => {
		const s = await seed();
		await enroll(s.personId, true);
		expect(
			(await logic.loadOrientationFacts(s.memberId))?.activePathCount,
		).toBe(0);
		await enroll(s.personId);
		const facts = await logic.loadOrientationFacts(s.memberId);
		expect(facts?.activePathCount).toBe(1);
	});

	it("derives the slot items from real slots, excluding cancelled meetings", async () => {
		const s = await seed();
		await assignSlot(s.clubId, s.memberId, {
			speaker: true,
			status: "cancelled",
		});
		await assignSlot(s.clubId, s.memberId, {
			speaker: false,
			status: "cancelled",
		});
		let view = await logic.getOrientation(s.memberId);
		const done = (key: string) => view?.items.find((i) => i.key === key)?.done;
		expect(done("ice-breaker")).toBe(false);
		expect(done("supporting-role")).toBe(false);

		await assignSlot(s.clubId, s.memberId, {
			speaker: true,
			status: "completed",
		});
		view = await logic.getOrientation(s.memberId);
		expect(done("ice-breaker")).toBe(true);
		expect(done("supporting-role")).toBe(false);

		await assignSlot(s.clubId, s.memberId, {
			speaker: false,
			status: "scheduled",
		});
		view = await logic.getOrientation(s.memberId);
		expect(done("supporting-role")).toBe(true);
	});

	it("another member's slots do not count", async () => {
		const s = await seed();
		await assignSlot(s.clubId, s.adminMemberId, {
			speaker: true,
			status: "scheduled",
		});
		const view = await logic.getOrientation(s.memberId);
		expect(view?.items.find((i) => i.key === "ice-breaker")?.done).toBe(false);
	});

	it("disappears on its own once all four items are done", async () => {
		const s = await seed();
		await enroll(s.personId);
		await assignSlot(s.clubId, s.memberId, {
			speaker: true,
			status: "scheduled",
		});
		await assignSlot(s.clubId, s.memberId, {
			speaker: false,
			status: "scheduled",
		});
		expect((await logic.getOrientation(s.memberId))?.visible).toBe(true);
		const view = await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: true,
		});
		expect(view?.complete).toBe(true);
		expect(view?.visible).toBe(false);
	});

	it("reads write nothing", async () => {
		const s = await seed();
		const before = await orientationSnapshot(s.clubId);
		await logic.getOrientation(s.memberId);
		await logic.loadOrientationFacts(s.memberId);
		await logic.getMemberOrientation({
			clubId: s.clubId,
			memberId: s.memberId,
		});
		expect(await orientationSnapshot(s.clubId)).toEqual(before);
	});

	it("an admin's read of a member in another club answers null", async () => {
		const a = await seed();
		const b = await seed();
		expect(
			await logic.getMemberOrientation({
				clubId: a.clubId,
				memberId: b.memberId,
			}),
		).toBeNull();
	});
});

describe.skipIf(!hasTestDb)("the member's own writes (#940)", () => {
	it("Base Camp toggles on the caller's own row", async () => {
		const s = await seed();
		const on = await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: true,
		});
		expect(on?.items.find((i) => i.key === "base-camp")?.done).toBe(true);
		expect((await orientationRow(s.memberId)).basecampSetupAt).toBeInstanceOf(
			Date,
		);
		const off = await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: false,
		});
		expect(off?.items.find((i) => i.key === "base-camp")?.done).toBe(false);
		expect((await orientationRow(s.memberId)).basecampSetupAt).toBeNull();
	});

	it("dismiss hides the checklist permanently", async () => {
		const s = await seed();
		const view = await logic.dismissMyOrientation({
			userId: s.memberUserId,
			clubId: s.clubId,
		});
		expect(view?.dismissed).toBe(true);
		expect(view?.visible).toBe(false);
		const first = (await orientationRow(s.memberId)).dismissedAt;
		expect(first).toBeInstanceOf(Date);
		// A second dismiss does not move the timestamp.
		await logic.dismissMyOrientation({
			userId: s.memberUserId,
			clubId: s.clubId,
		});
		expect((await orientationRow(s.memberId)).dismissedAt).toEqual(first);
		// Unticking Base Camp afterwards does not bring it back.
		const later = await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: false,
		});
		expect(later?.visible).toBe(false);
	});

	it("a member's tick and dismiss write only their OWN row", async () => {
		const s = await seed();
		const adminBefore = await orientationRow(s.adminMemberId);
		await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: true,
		});
		await logic.dismissMyOrientation({
			userId: s.memberUserId,
			clubId: s.clubId,
		});
		expect(await orientationRow(s.adminMemberId)).toEqual(adminBefore);
		const mine = await orientationRow(s.memberId);
		expect(mine.basecampSetupAt).toBeInstanceOf(Date);
		expect(mine.dismissedAt).toBeInstanceOf(Date);
	});

	it("an ADMIN's self-writes also touch only the admin's own row", async () => {
		const s = await seed();
		const memberBefore = await orientationRow(s.memberId);
		await logic.dismissMyOrientation({
			userId: s.adminUserId,
			clubId: s.clubId,
		});
		expect(await orientationRow(s.memberId)).toEqual(memberBefore);
		expect((await orientationRow(s.adminMemberId)).dismissedAt).toBeInstanceOf(
			Date,
		);
	});

	it("the self-write schemas refuse a member id, so no input can name another row", () => {
		const clubId = randomUUID();
		const memberId = randomUUID();
		expect(() =>
			setBasecampSetupSchema.parse({ clubId, done: true, memberId }),
		).toThrow();
		expect(() =>
			dismissOrientationSchema.parse({ clubId, memberId }),
		).toThrow();
		expect(() =>
			setBasecampSetupSchema.parse({ clubId, done: true, userId: "x" }),
		).toThrow();
		expect(setBasecampSetupSchema.parse({ clubId, done: true })).toEqual({
			clubId,
			done: true,
		});
	});

	it("a user with no membership in the club is refused and nothing changes", async () => {
		const a = await seed();
		const b = await seed();
		const before = await orientationSnapshot(a.clubId);
		await expect(
			logic.setMyBasecampSetup({
				userId: b.memberUserId,
				clubId: a.clubId,
				done: true,
			}),
		).rejects.toThrow();
		await expect(
			logic.dismissMyOrientation({ userId: b.memberUserId, clubId: a.clubId }),
		).rejects.toThrow();
		expect(await orientationSnapshot(a.clubId)).toEqual(before);
	});

	it("a read-write impersonator (no membership of their own) is refused", async () => {
		const s = await seed();
		const superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super Admin",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		createdSuperadmins.push(superadminId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: s.clubId,
			mode: "read_write",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		const before = await orientationSnapshot(s.clubId);
		await expect(
			logic.setMyBasecampSetup({
				userId: superadminId,
				clubId: s.clubId,
				done: true,
			}),
		).rejects.toThrow(ORIENTATION_NOT_YOURS_MESSAGE);
		await expect(
			logic.dismissMyOrientation({ userId: superadminId, clubId: s.clubId }),
		).rejects.toThrow(ORIENTATION_NOT_YOURS_MESSAGE);
		expect(await orientationSnapshot(s.clubId)).toEqual(before);
	});

	it("a read-only impersonator's dashboard read has no membership (so null), and writes nothing", async () => {
		const s = await seed();
		const superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super Admin",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		createdSuperadmins.push(superadminId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: s.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		const access = await requireClubViewAccess(superadminId, s.clubId);
		expect(access.membership).toBeNull();
		const before = await orientationSnapshot(s.clubId);
		await expect(
			logic.setMyBasecampSetup({
				userId: superadminId,
				clubId: s.clubId,
				done: true,
			}),
		).rejects.toThrow();
		expect(await orientationSnapshot(s.clubId)).toEqual(before);
	});
});

describe.skipIf(!hasTestDb)("Start orientation, the admin write (#940)", () => {
	it("an admin can start orientation for an existing member", async () => {
		const s = await seed();
		await testDb
			.update(members)
			.set({ orientationStartedAt: null })
			.where(eq(members.id, s.memberId));
		await expect(
			requireClubRole(s.adminUserId, s.clubId, ["admin"]),
		).resolves.toBeTruthy();
		const view = await logic.startOrientation({
			...startOrientationSchema.parse({
				clubId: s.clubId,
				memberId: s.memberId,
			}),
			actorMemberId: s.adminMemberId,
		});
		expect(view?.inOrientation).toBe(true);
		expect(view?.visible).toBe(true);
	});

	it("restarting clears a previous dismissal and keeps the Base Camp tick", async () => {
		const s = await seed();
		await logic.setMyBasecampSetup({
			userId: s.memberUserId,
			clubId: s.clubId,
			done: true,
		});
		await logic.dismissMyOrientation({
			userId: s.memberUserId,
			clubId: s.clubId,
		});
		const view = await logic.startOrientation({
			clubId: s.clubId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
		});
		expect(view?.dismissed).toBe(false);
		expect(view?.visible).toBe(true);
		expect((await orientationRow(s.memberId)).basecampSetupAt).toBeInstanceOf(
			Date,
		);
	});

	it("a plain member is refused by the gate the write sits behind", async () => {
		const s = await seed();
		await expect(
			requireClubRole(s.memberUserId, s.clubId, ["admin"]),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		await expect(
			requireClubAdminView(s.memberUserId, s.clubId),
		).rejects.toThrow();
	});

	it("refuses a member of another club", async () => {
		const a = await seed();
		const b = await seed();
		const before = await orientationRow(b.memberId);
		await expect(
			logic.startOrientation({
				clubId: a.clubId,
				memberId: b.memberId,
				actorMemberId: a.adminMemberId,
			}),
		).rejects.toThrow(ORIENTATION_MEMBER_NOT_FOUND_MESSAGE);
		expect(await orientationRow(b.memberId)).toEqual(before);
		expect(await startRows(a.clubId)).toHaveLength(0);
	});

	it("refuses an INACTIVE member server-side, writing nothing", async () => {
		const s = await seed();
		await testDb
			.update(members)
			.set({ status: "inactive", orientationStartedAt: null })
			.where(eq(members.id, s.memberId));
		const before = await orientationRow(s.memberId);
		await expect(
			logic.startOrientation({
				clubId: s.clubId,
				memberId: s.memberId,
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow(ORIENTATION_MEMBER_INACTIVE_MESSAGE);
		expect(await orientationRow(s.memberId)).toEqual(before);
		expect(await startRows(s.clubId)).toHaveLength(0);
	});

	it("logs a member_edit attributed to the admin", async () => {
		const s = await seed();
		await logic.startOrientation({
			clubId: s.clubId,
			memberId: s.memberId,
			actorMemberId: s.adminMemberId,
		});
		const rows = await startRows(s.clubId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actorMemberId: s.adminMemberId,
			impersonatedBy: null,
			targetType: "member",
			targetId: s.memberId,
		});
		expect(rows[0]?.detail).toMatchObject({ orientation: "started" });
	});

	it("under a read-write impersonation, the log names the real superadmin", async () => {
		const s = await seed();
		const superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super Admin",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		createdSuperadmins.push(superadminId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: s.clubId,
			mode: "read_write",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		requestRef = { id: "req" };
		try {
			// The server fn's composition: the gate, then the logic with its id.
			const actor = await requireClubRole(superadminId, s.clubId, ["admin"]);
			expect(actor.id).toBeNull();
			await logic.startOrientation({
				clubId: s.clubId,
				memberId: s.memberId,
				actorMemberId: actor.id,
			});
		} finally {
			requestRef = null;
		}
		const rows = await startRows(s.clubId);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBeNull();
		expect(rows[0]?.impersonatedBy).toBe(superadminId);
	});
});

describe.skipIf(!hasTestDb)(
	"which membership-creating paths start orientation (#940)",
	() => {
		it("a ROSTER IMPORT does not (maintainer decision: explicit null)", async () => {
			const s = await seed();
			const { importPeopleAndMembers } = await import("./import-members-logic");
			const row = (over: Partial<MappedMember>): MappedMember => ({
				customerId: null,
				name: "Unnamed",
				email: null,
				phone: null,
				joinedAt: null,
				originalJoinDate: null,
				officerPosition: null,
				currentPosition: null,
				...over,
			});
			const suffix = randomUUID().slice(0, 8);
			const stats = await importPeopleAndMembers(s.clubId, [
				row({ customerId: `PN-${suffix}-A`, name: `Veteran A ${suffix}` }),
				row({ customerId: `PN-${suffix}-B`, name: `Veteran B ${suffix}` }),
			]);
			expect(stats.membersCreated).toBe(2);
			const imported = await testDb
				.select({
					name: members.name,
					startedAt: members.orientationStartedAt,
				})
				.from(members)
				.where(eq(members.clubId, s.clubId));
			const veterans = imported.filter((m) => m.name.includes(suffix));
			expect(veterans).toHaveLength(2);
			for (const v of veterans) expect(v.startedAt).toBeNull();
		});

		it("CONVERT-TO-MEMBER does", async () => {
			const s = await seed();
			const { applyConvertGuestToMember } = await import(
				"./guest-pipeline-logic"
			);
			const [g] = await testDb
				.insert(guests)
				.values({
					clubId: s.clubId,
					name: `Convert Guest ${randomUUID()}`,
					stage: "prospect",
				})
				.returning({ id: guests.id, name: guests.name });
			if (!g) throw new Error("no guest");
			await applyConvertGuestToMember({
				clubId: s.clubId,
				guestId: g.id,
				actorMemberId: null,
			});
			const [m] = await testDb
				.select({ startedAt: members.orientationStartedAt })
				.from(members)
				.where(eq(members.name, g.name));
			expect(m?.startedAt).toBeInstanceOf(Date);
		});

		/** Rows through `applyBulkImport`, composed the way the server fn is:
		 *  validator (`bulkImportSchema.parse`), then logic. */
		async function bulkAdd(
			s: Awaited<ReturnType<typeof seed>>,
			names: string[],
			extra: Record<string, unknown> = {},
		) {
			const { applyBulkImport, bulkImportSchema } = await import(
				"./members-logic"
			);
			const input = bulkImportSchema.parse({
				clubId: s.clubId,
				rows: names.map((name) => ({ name, email: "", phone: "", office: "" })),
				...extra,
			});
			const result = await applyBulkImport({
				...input,
				actorMemberId: s.adminMemberId,
			});
			expect(result.insertedIds).toHaveLength(names.length);
			return testDb
				.select({ startedAt: members.orientationStartedAt })
				.from(members)
				.where(inArray(members.id, result.insertedIds));
		}

		it("QUICK ADD (one row, startOrientation: true) does", async () => {
			const s = await seed();
			const rows = await bulkAdd(s, [`Quick Add ${randomUUID()}`], {
				startOrientation: true,
			});
			expect(rows[0]?.startedAt).toBeInstanceOf(Date);
		});

		it("a PASTED ROSTER (startOrientation: false) does not (maintainer decision)", async () => {
			const s = await seed();
			const rows = await bulkAdd(
				s,
				[`Pasted A ${randomUUID()}`, `Pasted B ${randomUUID()}`],
				{ startOrientation: false },
			);
			expect(rows).toHaveLength(2);
			for (const r of rows) expect(r.startedAt).toBeNull();
		});

		it("a bulk add with the flag OMITTED (the paste dialog, or a pre-deploy tab) does not", async () => {
			const s = await seed();
			const rows = await bulkAdd(s, [`Omitted ${randomUUID()}`]);
			expect(rows[0]?.startedAt).toBeNull();
		});

		it("ONBOARDING's founding admin does not (maintainer decision)", async () => {
			const { createClubSchema, createClubWithAdmin } = await import(
				"./onboarding-logic"
			);
			const res = await createClubWithAdmin(
				createClubSchema.parse({
					charterStatus: "chartering",
					clubName: `Orientation Club ${randomUUID()}`,
					adminName: "Casey Admin",
					adminEmail: `casey-${randomUUID()}@example.com`,
					timezone: DEFAULT_CLUB_TIMEZONE,
				}),
			);
			createdClubs.push(res.clubId);
			const rows = await testDb
				.select({ startedAt: members.orientationStartedAt })
				.from(members)
				.where(eq(members.clubId, res.clubId));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.startedAt).toBeNull();
		});
	},
);
