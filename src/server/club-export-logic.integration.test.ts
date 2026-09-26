/**
 * `loadClubExport` against real Postgres (#915 AC1): every file in the issue's
 * table comes back with the seeded values, and — the point of the suite — NO
 * row from a second seeded club appears in any file. The second club is seeded
 * with the same shape of data (members, a guest, meetings, slots, attendance, a
 * speech, an enrollment, an award, dues, an action item, Table Topics) and a
 * marker string in every free-text column, so a query that lost its club scope
 * surfaces as a named row rather than as a count that happens to match.
 *
 * Also the size bound: a 60-member, 300-meeting, 5,000-slot club builds its zip
 * in under 3s, the issue's threshold for moving to fflate's streaming `Zip`.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	clubActionItems,
	clubs,
	duesPeriods,
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	memberDues,
	members,
	officerTerms,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	buildClubExportZip,
	CLUB_EXPORT_FILENAMES,
	centsToDecimal,
	clubExportFilename,
	isoWithOffset,
	loadClubExport,
	localDate,
} = await import("./club-export-logic");
const { loadGuestPipeline } = await import("./guest-pipeline-logic");

const RUN = randomUUID().slice(0, 8);
/** In every free-text column of the SECOND club's rows. */
const OTHER = `OTHERCLUB-${RUN}`;

interface Seeded {
	club: SeededClub;
	guestId: string;
	meetingEarlyId: string;
	meetingLateId: string;
	meetingPriorId: string;
	speakerDefId: string;
	speakerSlotId: string;
	speechId: string;
	pathId: string;
	periodId: string;
	/** Every id this club owns, for the tenant-boundary sweep. */
	ids: string[];
}

const pathIds: string[] = [];

/**
 * One club's worth of every exported table. `tag` goes into every free-text
 * column so the other club's rows are recognisable anywhere they leak.
 */
async function seedExportClub(tag: string): Promise<Seeded> {
	const club = await seedClub();
	await testDb
		.update(clubs)
		.set({ name: `${tag} Club`, timezone: "America/Chicago" })
		.where(inArray(clubs.id, [club.clubId]));
	await testDb
		.update(members)
		.set({ phone: "+14155550100", joinedAt: new Date("2024-01-15T00:00:00Z") })
		.where(inArray(members.id, [club.memberId]));
	// A guest converted to a member: `joined_at` is the INSTANT of conversion,
	// 19:30 on 1 Feb in Chicago, which is already 2 Feb in UTC.
	await testDb
		.update(members)
		.set({ joinedAt: new Date("2024-02-02T01:30:00Z") })
		.where(inArray(members.id, [club.adminMemberId]));
	await testDb
		.update(people)
		.set({ customerId: `C-${tag}-${RUN}`.slice(0, 40) })
		.where(inArray(people.id, [club.personId]));

	const [guest] = await testDb
		.insert(guests)
		.values({
			clubId: club.clubId,
			name: `${tag} Guest`,
			email: `guest-${randomUUID()}@test.example`,
			phone: "+14155550199",
		})
		.returning({ id: guests.id });

	// Two meetings on the SAME club-local date (2026-03-09, Chicago is UTC-5 by
	// then), which is why every meeting file carries meeting_id. `prior` is
	// earlier still, and the guest was ABSENT from it: it must not count as a
	// visit, nor become the first one. (`meeting_attendance.status` defaults to
	// 'absent', so a non-present guest row is reachable.)
	const [early, late, prior] = await testDb
		.insert(meetings)
		.values([
			{
				clubId: club.clubId,
				scheduledAt: new Date("2026-03-09T13:00:00Z"), // 08:00 local
				status: "completed",
				theme: `${tag} Morning`,
				wordOfTheDay: `${tag}word`,
				location: `${tag} Hall`,
			},
			{
				clubId: club.clubId,
				scheduledAt: new Date("2026-03-10T00:30:00Z"), // 19:30 local, 3/9
				status: "completed",
				theme: `${tag} Evening`,
			},
			{
				clubId: club.clubId,
				scheduledAt: new Date("2026-02-01T01:00:00Z"), // 19:00 local, 1/31
				status: "completed",
			},
		])
		.returning({ id: meetings.id });

	const [speakerDef] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });

	const [speech] = await testDb
		.insert(speeches)
		.values({
			personId: club.personId,
			title: `${tag} Speech`,
			pathwayPath: "Dynamic Leadership",
			projectName: "Ice Breaker",
			projectLevel: "1",
		})
		.returning({ id: speeches.id });

	const [speakerSlot] = await testDb
		.insert(roleSlots)
		.values([
			{
				meetingId: early.id,
				roleDefinitionId: speakerDef.id,
				assignedMemberId: club.memberId,
				status: "confirmed",
				speechId: speech.id,
			},
		])
		.returning({ id: roleSlots.id });
	await testDb.insert(roleSlots).values({
		meetingId: late.id,
		roleDefinitionId: club.roleDefinitionId,
		assignedGuestId: guest.id,
		status: "claimed",
	});

	await testDb.insert(meetingAttendance).values([
		{ meetingId: early.id, memberId: club.memberId, status: "present" },
		{ meetingId: early.id, guestId: guest.id, status: "present" },
		{ meetingId: late.id, guestId: guest.id, status: "present" },
		{ meetingId: late.id, memberId: club.adminMemberId, status: "excused" },
		{ meetingId: prior.id, guestId: guest.id, status: "absent" },
		{ meetingId: club.meetingId, guestId: guest.id, status: "excused" },
	]);
	// Admin holds a Timer slot at the early meeting: by NAME ("Admin User")
	// it sorts before the Speaker ("Member User"); by role it would not.
	await testDb.insert(roleSlots).values({
		meetingId: early.id,
		roleDefinitionId: club.roleDefinitionId,
		assignedMemberId: club.adminMemberId,
		status: "claimed",
	});

	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: `T${RUN}${tag}`.slice(0, 40), name: `${tag} Path` })
		.returning({ id: pathwaysPaths.id });
	pathIds.push(path.id);
	const [enrollment] = await testDb
		.insert(pathEnrollments)
		.values({ personId: club.personId, pathId: path.id })
		.returning({ id: pathEnrollments.id });
	await testDb.insert(pathLevelProgress).values([
		{
			enrollmentId: enrollment.id,
			level: 1,
			completed: 4,
			total: 4,
			approved: true,
		},
		{
			enrollmentId: enrollment.id,
			level: 2,
			completed: 3,
			total: 3,
			approved: true,
		},
		{
			enrollmentId: enrollment.id,
			level: 3,
			completed: 1,
			total: 4,
			approved: false,
		},
	]);

	await testDb.insert(meetingAwards).values([
		{ meetingId: early.id, category: "best_speaker", memberId: club.memberId },
		{ meetingId: late.id, category: "best_table_topics", guestId: guest.id },
	]);

	const [period] = await testDb
		.insert(duesPeriods)
		.values({
			clubId: club.clubId,
			label: `${tag} Spring`,
			dueDate: new Date("2026-04-01T00:00:00Z"),
			defaultAmountCents: 6000,
		})
		.returning({ id: duesPeriods.id });
	await testDb.insert(memberDues).values({
		membershipId: club.memberId,
		duesPeriodId: period.id,
		status: "paid",
		amountCents: 6050,
	});

	await testDb.insert(clubActionItems).values({
		clubId: club.clubId,
		text: `${tag} Book the room`,
		ownerMemberId: club.adminMemberId,
		dueDate: "2026-03-20",
		createdAt: new Date("2026-03-01T15:00:00Z"),
	});

	await testDb.insert(officerTerms).values({
		membershipId: club.adminMemberId,
		position: "treasurer",
		termStart: new Date("2025-07-01T12:00:00Z"),
	});

	await testDb.insert(tableTopicsSpeakers).values({
		meetingId: early.id,
		guestId: guest.id,
		topic: `${tag} topic`,
	});

	return {
		club,
		guestId: guest.id,
		meetingEarlyId: early.id,
		meetingLateId: late.id,
		meetingPriorId: prior.id,
		speakerDefId: speakerDef.id,
		speakerSlotId: speakerSlot.id,
		speechId: speech.id,
		pathId: path.id,
		periodId: period.id,
		ids: [
			club.clubId,
			club.memberId,
			club.adminMemberId,
			club.meetingId,
			guest.id,
			early.id,
			late.id,
			prior.id,
		],
	};
}

describe.skipIf(!hasTestDb)("loadClubExport (#915)", () => {
	let a: Seeded;
	let b: Seeded;
	const extraClubs: string[] = [];

	beforeAll(async () => {
		a = await seedExportClub(`MINE${RUN}`);
		b = await seedExportClub(OTHER);
		// The other club's member ALSO holds a slot in A's meeting would be a
		// data bug elsewhere; the loader must still not name them. Point one of
		// A's slots at B's member directly to prove the scoped LEFT JOIN.
		await testDb.insert(roleSlots).values({
			meetingId: a.meetingLateId,
			roleDefinitionId: a.club.roleDefinitionId,
			slotIndex: 1,
			assignedMemberId: b.club.memberId,
			status: "claimed",
		});

		// speeches.csv: a speech is PERSON-owned, so a slot in A's meeting can
		// point at a speech whose owner is B's member and not A's. Neither the
		// owner's name nor the title may appear in A's export.
		const [foreignPerson] = await testDb
			.insert(people)
			.values({ name: `${OTHER} Speaker` })
			.returning({ id: people.id });
		await testDb.insert(members).values({
			clubId: b.club.clubId,
			personId: foreignPerson.id,
			name: `${OTHER} Speaker`,
		});
		const [foreignSpeech] = await testDb
			.insert(speeches)
			.values({ personId: foreignPerson.id, title: `${OTHER} foreign speech` })
			.returning({ id: speeches.id });
		await testDb.insert(roleSlots).values({
			meetingId: a.meetingLateId,
			roleDefinitionId: a.speakerDefId,
			speechId: foreignSpeech.id,
			status: "confirmed",
		});

		// roles.csv: a slot in A's meeting pointing at B's role DEFINITION.
		const [foreignDef] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: b.club.clubId,
				name: `${OTHER} Role`,
				category: "functionary",
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: a.meetingLateId,
			roleDefinitionId: foreignDef.id,
			slotIndex: 5,
			status: "open",
		});
	});

	afterAll(async () => {
		for (const s of [a, b]) {
			if (s)
				await cleanup(s.club.clubId, [s.club.adminUserId, s.club.memberUserId]);
		}
		for (const id of extraClubs) await cleanup(id, []);
		if (pathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds));
		}
	});

	async function files() {
		const out = await loadClubExport(a.club.clubId);
		if (!out) throw new Error("club not found");
		return Object.fromEntries(out.files.map((f) => [f.filename, f]));
	}

	it("returns null for an unknown club", async () => {
		expect(await loadClubExport(randomUUID())).toBeNull();
	});

	it("returns every file in the issue's table, in order, and table-topics", async () => {
		const out = await loadClubExport(a.club.clubId);
		expect(out?.files.map((f) => f.filename)).toEqual([
			...CLUB_EXPORT_FILENAMES,
		]);
	});

	it("members.csv: every membership with contact details and the TI customer id", async () => {
		const f = (await files())["members.csv"];
		expect(f.columns).toEqual([
			"member_id",
			"name",
			"preferred_name",
			"email",
			"phone",
			"status",
			"club_role",
			"joined_at",
			"customer_id",
		]);
		const member = f.rows.find((r) => r.member_id === a.club.memberId);
		expect(member).toMatchObject({
			name: "Member User",
			email: expect.stringContaining("@test.example"),
			phone: "+14155550100",
			status: "active",
			club_role: "member",
			joined_at: "2024-01-15",
			customer_id: expect.stringContaining(`C-MINE${RUN}`),
		});
		// Imported (stored UTC midnight) → the UTC date; converted (an instant)
		// → the club-local date.
		expect(
			f.rows.find((r) => r.member_id === a.club.adminMemberId)?.joined_at,
		).toBe("2024-02-01");
		expect(f.rows.map((r) => r.member_id).sort()).toEqual(
			[a.club.memberId, a.club.adminMemberId].sort(),
		);
	});

	it("officer-terms.csv", async () => {
		const f = (await files())["officer-terms.csv"];
		expect(f.rows).toEqual([
			{
				member_id: a.club.adminMemberId,
				name: "Admin User",
				position: "treasurer",
				started_at: "2025-07-01",
				ended_at: null,
			},
		]);
	});

	it("meetings.csv: club-local date and time, and two meetings sharing a date stay distinct", async () => {
		const f = (await files())["meetings.csv"];
		const early = f.rows.find((r) => r.meeting_id === a.meetingEarlyId);
		const late = f.rows.find((r) => r.meeting_id === a.meetingLateId);
		expect(early).toMatchObject({
			meeting_date: "2026-03-09",
			start_time: "08:00",
			status: "completed",
			theme: `MINE${RUN} Morning`,
			word_of_the_day: `MINE${RUN}word`,
			location: `MINE${RUN} Hall`,
		});
		// 00:30 UTC on the 10th is 19:30 on the 9th in Chicago.
		expect(late).toMatchObject({
			meeting_date: "2026-03-09",
			start_time: "19:30",
		});
		// Ordered by date: January's, the two March meetings, then seedClub's
		// future one.
		expect(f.rows.map((r) => r.meeting_id)).toEqual([
			a.meetingPriorId,
			a.meetingEarlyId,
			a.meetingLateId,
			a.club.meetingId,
		]);
	});

	// #915 spec: rows by date, then name. At the early meeting the admin's
	// Timer slot comes before the member's Speaker slot, which is the reverse
	// of role order; at the late meeting the named guest comes before the
	// holderless slots. The other club's role definition and speech owner
	// contribute no row at all.
	it("roles.csv: ordered by date, then holder name, open slots last", async () => {
		const f = (await files())["roles.csv"];
		const early = f.rows.filter((r) => r.meeting_id === a.meetingEarlyId);
		expect(early.map((r) => r.holder_name)).toEqual([
			"Admin User",
			"Member User",
		]);
		const late = f.rows.filter((r) => r.meeting_id === a.meetingLateId);
		expect(late.map((r) => r.holder_name)).toEqual([
			`MINE${RUN} Guest`,
			null,
			null,
		]);
		expect(late.map((r) => r.role)).not.toContain(`${OTHER} Role`);
	});

	it("reads everything on ONE connection, inside one transaction", async () => {
		const select = vi.spyOn(testDb, "select");
		const transaction = vi.spyOn(testDb, "transaction");
		try {
			await loadClubExport(a.club.clubId);
			expect(transaction).toHaveBeenCalledTimes(1);
			// Every read goes through the transaction's `tx`; a read on the pool
			// client would check out a second connection.
			expect(select).not.toHaveBeenCalled();
		} finally {
			select.mockRestore();
			transaction.mockRestore();
		}
	});

	it("roles.csv: member and guest holders, an open slot, and meeting ids", async () => {
		const f = (await files())["roles.csv"];
		expect(f.rows).toContainEqual({
			meeting_id: a.meetingEarlyId,
			meeting_date: "2026-03-09",
			role: "Speaker",
			slot: 1,
			holder_name: "Member User",
			holder_type: "member",
			member_or_guest_id: a.club.memberId,
			status: "confirmed",
		});
		expect(f.rows).toContainEqual(
			expect.objectContaining({
				meeting_id: a.meetingLateId,
				role: "Timer",
				holder_name: `MINE${RUN} Guest`,
				holder_type: "guest",
				member_or_guest_id: a.guestId,
			}),
		);
		expect(f.rows).toContainEqual(
			expect.objectContaining({
				meeting_id: a.club.meetingId,
				holder_name: null,
				holder_type: null,
				status: "open",
			}),
		);
	});

	it("attendance.csv", async () => {
		const f = (await files())["attendance.csv"];
		expect(f.rows).toHaveLength(6);
		expect(f.rows).toContainEqual({
			meeting_id: a.meetingEarlyId,
			meeting_date: "2026-03-09",
			name: `MINE${RUN} Guest`,
			member_or_guest_id: a.guestId,
			type: "guest",
			attended: "yes",
			status: "present",
		});
		expect(f.rows).toContainEqual(
			expect.objectContaining({
				member_or_guest_id: a.club.adminMemberId,
				type: "member",
				attended: "no",
				status: "excused",
			}),
		);
	});

	it("speeches.csv: the speech on this club's agenda", async () => {
		const f = (await files())["speeches.csv"];
		expect(f.rows).toEqual([
			{
				meeting_id: a.meetingEarlyId,
				meeting_date: "2026-03-09",
				speaker: "Member User",
				title: `MINE${RUN} Speech`,
				pathways_path: "Dynamic Leadership",
				project: "Ice Breaker",
				project_level: "1",
			},
		]);
	});

	// Ordered by member name, then path (the file has no date column). The
	// admin's path sorts AFTER the member's by path name, so a path-first order
	// would swap these two rows.
	it("pathways.csv: current_level is the highest APPROVED level, rows by name", async () => {
		const [admin] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(inArray(members.id, [a.club.adminMemberId]));
		const [zeta] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: `Z${RUN}`, name: `Zeta ${RUN}` })
			.returning({ id: pathwaysPaths.id });
		pathIds.push(zeta.id);
		await testDb
			.insert(pathEnrollments)
			.values({ personId: admin.personId, pathId: zeta.id });
		const f = (await files())["pathways.csv"];
		expect(f.rows).toEqual([
			{
				member_id: a.club.adminMemberId,
				name: "Admin User",
				path: `Zeta ${RUN}`,
				current_level: null,
				status: "active",
			},
			{
				member_id: a.club.memberId,
				name: "Member User",
				path: `MINE${RUN} Path`,
				current_level: 2,
				status: "active",
			},
		]);
	});

	it("guests.csv: visits and first_visit derived from participation", async () => {
		const f = (await files())["guests.csv"];
		expect(f.rows).toEqual([
			{
				guest_id: a.guestId,
				name: `MINE${RUN} Guest`,
				email: expect.stringContaining("@test.example"),
				phone: "+14155550199",
				stage: "prospect",
				first_visit: "2026-03-09",
				visits: 2,
			},
		]);
		// The board reads the same rows the same way: the absent and excused
		// rows count on neither.
		const board = (await loadGuestPipeline(a.club.clubId)).find(
			(g) => g.id === a.guestId,
		);
		expect(board?.visitCount).toBe(2);
		expect(localDate(board?.firstVisitAt ?? null, "America/Chicago")).toBe(
			"2026-03-09",
		);
	});

	// A club's export must not show people the club no longer has. An
	// enrollment carries no club, so a LAPSED membership was the only thing
	// joining a former member's Pathways record (including progress made at
	// whatever club they joined next) to this club's admins.
	it("pathways.csv: a lapsed member's enrollments are absent; an active member's archived one stays", async () => {
		const own = await seedClub();
		extraClubs.push(own.clubId);
		const [admin] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(inArray(members.id, [own.adminMemberId]));
		const [kept, archived, lapsed] = await testDb
			.insert(pathwaysPaths)
			.values([
				{ courseCode: `K${RUN}`, name: `Kept ${RUN}` },
				{ courseCode: `A${RUN}`, name: `Archived ${RUN}` },
				{ courseCode: `L${RUN}`, name: `Lapsed ${RUN}` },
			])
			.returning({ id: pathwaysPaths.id });
		pathIds.push(kept.id, archived.id, lapsed.id);
		await testDb.insert(pathEnrollments).values([
			{ personId: own.personId, pathId: kept.id },
			{ personId: own.personId, pathId: archived.id, archivedAt: new Date() },
			// The admin's: active in Pathways, but their membership here lapses.
			{ personId: admin.personId, pathId: lapsed.id },
		]);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(inArray(members.id, [own.adminMemberId]));

		const out = await loadClubExport(own.clubId);
		const byName = Object.fromEntries(
			(out?.files ?? []).map((f) => [f.filename, f]),
		);
		expect(byName["pathways.csv"].rows).toEqual([
			{
				member_id: own.memberId,
				name: "Member User",
				path: `Archived ${RUN}`,
				current_level: null,
				status: "archived",
			},
			{
				member_id: own.memberId,
				name: "Member User",
				path: `Kept ${RUN}`,
				current_level: null,
				status: "active",
			},
		]);
		// Still on the roster file, as a past member: only Pathways is scoped.
		expect(byName["members.csv"].rows).toContainEqual(
			expect.objectContaining({
				member_id: own.adminMemberId,
				status: "inactive",
			}),
		);

		await cleanup(own.clubId, [own.adminUserId, own.memberUserId]);
		extraClubs.pop();
	});

	// guests.csv and the guest pipeline board state one count. The export used
	// to count only attendance rows, cancelled and future meetings included, so
	// the same guest read "3 visits" on the board and "1" in the export.
	it("guests.csv: visits and first_visit agree with the guest pipeline", async () => {
		const own = await seedClub();
		extraClubs.push(own.clubId);
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago" })
			.where(inArray(clubs.id, [own.clubId]));
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: own.clubId, name: `Pipeline Guest ${RUN}` })
			.returning({ id: guests.id });
		const day = 86_400_000;
		const [attended, heldRole, spoke, cancelled, future, missed, excused] =
			await testDb
				.insert(meetings)
				.values([
					// 19:00 Chicago on 31 Jan; already 1 Feb in UTC.
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-02-01T01:00:00Z"),
						status: "completed",
					},
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-02-08T01:00:00Z"),
						status: "completed",
					},
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-02-15T01:00:00Z"),
						status: "completed",
					},
					// Earlier than all of them, but cancelled: neither a visit nor
					// the first one.
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-01-10T01:00:00Z"),
						status: "cancelled",
					},
					{
						clubId: own.clubId,
						scheduledAt: new Date(Date.now() + 30 * day),
						status: "scheduled",
					},
					// Held, and earlier, but the guest's row there is absent / excused:
					// expected and did not come, so not a visit.
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-01-17T01:00:00Z"),
						status: "completed",
					},
					{
						clubId: own.clubId,
						scheduledAt: new Date("2026-01-24T01:00:00Z"),
						status: "completed",
					},
				])
				.returning({ id: meetings.id });
		await testDb.insert(meetingAttendance).values([
			{ meetingId: attended.id, guestId: guest.id, status: "present" },
			{ meetingId: cancelled.id, guestId: guest.id, status: "present" },
			{ meetingId: missed.id, guestId: guest.id, status: "absent" },
			{ meetingId: excused.id, guestId: guest.id, status: "excused" },
		]);
		await testDb.insert(roleSlots).values([
			{
				meetingId: heldRole.id,
				roleDefinitionId: own.roleDefinitionId,
				assignedGuestId: guest.id,
				status: "claimed",
			},
			// A claim on a meeting still to come is a plan, not a visit.
			{
				meetingId: future.id,
				roleDefinitionId: own.roleDefinitionId,
				assignedGuestId: guest.id,
				status: "claimed",
			},
		]);
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: spoke.id, guestId: guest.id, topic: "t" });

		const out = await loadClubExport(own.clubId);
		const row = out?.files
			.find((f) => f.filename === "guests.csv")
			?.rows.find((r) => r.guest_id === guest.id);
		const board = (await loadGuestPipeline(own.clubId)).find(
			(g) => g.id === guest.id,
		);
		expect(row).toMatchObject({ visits: 3, first_visit: "2026-01-31" });
		expect(board?.visitCount).toBe(3);
		expect(row?.visits).toBe(board?.visitCount);
		expect(row?.first_visit).toBe(
			localDate(board?.firstVisitAt ?? null, "America/Chicago"),
		);

		await cleanup(own.clubId, [own.adminUserId, own.memberUserId]);
		extraClubs.pop();
	});

	it("awards.csv", async () => {
		const f = (await files())["awards.csv"];
		expect(f.rows).toEqual([
			{
				meeting_id: a.meetingEarlyId,
				meeting_date: "2026-03-09",
				award: "best_speaker",
				winner: "Member User",
			},
			{
				meeting_id: a.meetingLateId,
				meeting_date: "2026-03-09",
				award: "best_table_topics",
				winner: `MINE${RUN} Guest`,
			},
		]);
	});

	it("dues.csv: member × period, unpaid for an active member with no row, money as a decimal", async () => {
		const f = (await files())["dues.csv"];
		expect(f.rows).toEqual([
			{
				period: `MINE${RUN} Spring`,
				due_date: "2026-04-01",
				member_id: a.club.adminMemberId,
				name: "Admin User",
				status: "unpaid",
				amount: null,
			},
			{
				period: `MINE${RUN} Spring`,
				due_date: "2026-04-01",
				member_id: a.club.memberId,
				name: "Member User",
				status: "paid",
				amount: "60.50",
			},
		]);
	});

	it("action-items.csv: created_at carries the club's offset", async () => {
		const f = (await files())["action-items.csv"];
		expect(f.rows).toEqual([
			{
				created_at: "2026-03-01T09:00:00-06:00",
				title: `MINE${RUN} Book the room`,
				owner: "Admin User",
				status: "open",
				due: "2026-03-20",
			},
		]);
	});

	it("table-topics.csv", async () => {
		const f = (await files())["table-topics.csv"];
		expect(f.rows).toEqual([
			{
				meeting_id: a.meetingEarlyId,
				meeting_date: "2026-03-09",
				speaker: `MINE${RUN} Guest`,
				topic: `MINE${RUN} topic`,
			},
		]);
	});

	// #915 AC1: the tenant boundary.
	it("contains no row from the other club in any file", async () => {
		const out = await loadClubExport(a.club.clubId);
		const zipText = out
			? Object.values(unzipSync(buildClubExportZip(out, new Date())))
					.map((bytes) => strFromU8(bytes))
					.join("\n")
			: "";
		expect(zipText.length).toBeGreaterThan(0);
		expect(zipText).not.toContain(OTHER);
		for (const id of b.ids) expect(zipText).not.toContain(id);
		// Also the Person-scoped rows: B's speech, B's path.
		expect(zipText).not.toContain(b.speechId);
		for (const f of out?.files ?? []) {
			for (const row of f.rows) {
				for (const v of Object.values(row)) {
					if (typeof v === "string") expect(v).not.toContain(OTHER);
				}
			}
		}
	});

	it("names nobody for a slot that points at another club's member", async () => {
		const f = (await files())["roles.csv"];
		const stray = f.rows.find(
			(r) => r.meeting_id === a.meetingLateId && r.slot === 2,
		);
		expect(stray).toMatchObject({
			holder_name: null,
			holder_type: null,
			member_or_guest_id: null,
		});
	});

	it("writes every header, even for a club with no rows at all", async () => {
		const empty = await seedClub();
		extraClubs.push(empty.clubId);
		// Strip seedClub's meeting and slot so meeting files are empty too.
		await testDb
			.delete(meetings)
			.where(inArray(meetings.id, [empty.meetingId]));
		const out = await loadClubExport(empty.clubId);
		const entries = unzipSync(
			buildClubExportZip(out as NonNullable<typeof out>, new Date()),
		);
		const bytes = entries["meetings.csv"];
		// The BOM, as bytes: `strFromU8` (TextDecoder) strips it on decode, so a
		// string comparison could not see it missing.
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(strFromU8(bytes)).toBe(
			"meeting_id,meeting_date,start_time,status,theme,word_of_the_day,location\r\n",
		);
		expect(strFromU8(entries["README.txt"])).toContain("Not included");
		await cleanup(empty.clubId, [empty.adminUserId, empty.memberUserId]);
		extraClubs.pop();
	});

	it("builds a 60-member, 300-meeting, 5,000-slot club's zip in under 3s", async () => {
		const big = await seedClub();
		extraClubs.push(big.clubId);
		const personRows = await testDb
			.insert(people)
			.values(
				Array.from({ length: 58 }, (_, i) => ({ name: `Big Person ${i}` })),
			)
			.returning({ id: people.id });
		const memberRows = await testDb
			.insert(members)
			.values(
				personRows.map((p, i) => ({
					clubId: big.clubId,
					personId: p.id,
					name: `Big Member ${i}`,
					email: `big-${i}-${randomUUID()}@test.example`,
				})),
			)
			.returning({ id: members.id });
		const start = Date.UTC(2020, 0, 1, 1);
		const meetingRows = await testDb
			.insert(meetings)
			.values(
				Array.from({ length: 299 }, (_, i) => ({
					clubId: big.clubId,
					scheduledAt: new Date(start + i * 7 * 86_400_000),
					theme: `Theme ${i}`,
				})),
			)
			.returning({ id: meetings.id });
		const slots = [];
		for (let i = 0; i < 5000; i++) {
			slots.push({
				meetingId: meetingRows[i % meetingRows.length].id,
				roleDefinitionId: big.roleDefinitionId,
				slotIndex: Math.floor(i / meetingRows.length) + 1,
				assignedMemberId: memberRows[i % memberRows.length].id,
				status: "claimed" as const,
			});
		}
		for (let i = 0; i < slots.length; i += 1000) {
			await testDb.insert(roleSlots).values(slots.slice(i, i + 1000));
		}

		const t0 = performance.now();
		const out = await loadClubExport(big.clubId);
		const zip = buildClubExportZip(out as NonNullable<typeof out>, new Date());
		const elapsed = performance.now() - t0;

		const roles = strFromU8(unzipSync(zip)["roles.csv"]).split("\r\n");
		// Header + 5,000 + seedClub's one open slot + trailing empty line.
		expect(roles).toHaveLength(5003);
		expect(elapsed).toBeLessThan(3000);
		await cleanup(big.clubId, [big.adminUserId, big.memberUserId]);
		extraClubs.pop();
	}, 60_000);
});

describe("club-export formatting helpers", () => {
	it("isoWithOffset uses the offset in force at the instant, either side of DST", () => {
		expect(
			isoWithOffset(new Date("2026-01-15T18:00:00Z"), "America/Chicago"),
		).toBe("2026-01-15T12:00:00-06:00");
		expect(
			isoWithOffset(new Date("2026-07-15T18:00:00Z"), "America/Chicago"),
		).toBe("2026-07-15T13:00:00-05:00");
		expect(
			isoWithOffset(new Date("2026-07-15T18:00:00Z"), "Asia/Kolkata"),
		).toBe("2026-07-15T23:30:00+05:30");
		expect(isoWithOffset(new Date("2026-07-15T18:00:00Z"), "UTC")).toBe(
			"2026-07-15T18:00:00+00:00",
		);
		expect(isoWithOffset(null, "UTC")).toBeNull();
	});

	it("centsToDecimal", () => {
		expect(centsToDecimal(6050)).toBe("60.50");
		expect(centsToDecimal(5)).toBe("0.05");
		expect(centsToDecimal(0)).toBe("0.00");
		expect(centsToDecimal(-250)).toBe("-2.50");
		expect(centsToDecimal(null)).toBeNull();
	});

	it("clubExportFilename is the slug and the club-local date, sanitised and capped", () => {
		// 03:00 UTC on the 2nd is still the 1st in Chicago.
		const now = new Date("2026-03-02T03:00:00Z");
		expect(clubExportFilename("downtown-club", "America/Chicago", now)).toBe(
			"downtown-club-export-2026-03-01.zip",
		);
		expect(clubExportFilename('a"b\r\nc;d', "UTC", now)).toBe(
			"abcd-export-2026-03-02.zip",
		);
		expect(clubExportFilename('"";', "UTC", now)).toBe(
			"club-export-2026-03-02.zip",
		);
		const long = clubExportFilename("x".repeat(10_000), "UTC", now);
		expect(long.length).toBeLessThan(120);
	});
});
