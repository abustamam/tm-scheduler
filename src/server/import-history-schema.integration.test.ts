/**
 * #1046: the storage imported club history lands in, against the REAL
 * constraints, plus every reader of `speeches` that a guest-owned speech could
 * reach now that `speeches.person_id` is nullable.
 *
 * Criteria covered here:
 *   2. a speech with both owners, or neither, is refused by `speeches_single_owner`;
 *   3. deleting a guest deletes their speeches; deleting a member nulls
 *      `guests.introduced_by_member_id`;
 *   4. the same `(club_id, source, kind, source_id)` in `import_refs` conflicts;
 *   5. each reader seeded with one guest-owned speech excludes it (or handles
 *      it as that reader intends);
 *   6. the export carries the new columns, and `mergePeople` still re-points
 *      speeches by `person_id` while leaving a guest's alone.
 *
 * Every row hangs off a club this suite seeds (guests, their speeches,
 * `club_imports`, `import_refs` all cascade from it), except the extra Persons
 * and paths, which are tracked and deleted by id.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	clubImports,
	clubs,
	guests,
	importRefs,
	meetingAttendance,
	meetings,
	members,
	pathEnrollments,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
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

const {
	attachSpeechToOpenSlot,
	GUEST_SPEECH_NOT_SCHEDULABLE_MESSAGE,
	listUnscheduledSpeeches,
	SPEECH_NOT_IN_CLUB_MESSAGE,
	setSpeechArchived,
} = await import("./speeches-logic");
const { historyCounts, getMergePreview } = await import("./people-logic");
const { pathwaysForPerson, pathwaysByMember } = await import(
	"./pathways-read-logic"
);
const { mergePeople } = await import("./people-merge-logic");
const { loadClubExport } = await import("./club-export-logic");
const { deleteClubPermanently } = await import("./onboarding-logic");

const RUN = randomUUID().slice(0, 8);

/** The Postgres error under drizzle's wrapper, a few `cause`s down. */
async function pgError(
	p: Promise<unknown>,
): Promise<{ code?: string; constraint?: string }> {
	try {
		await p;
	} catch (err) {
		for (let e: unknown = err, i = 0; e && i < 4; i++) {
			const c = e as { code?: unknown; constraint?: unknown; cause?: unknown };
			if (typeof c.code === "string") {
				return {
					code: c.code,
					constraint:
						typeof c.constraint === "string" ? c.constraint : undefined,
				};
			}
			e = c.cause;
		}
		throw err;
	}
	throw new Error("expected the statement to be refused");
}

describe.skipIf(!hasTestDb)("#1046 import-history schema", () => {
	let a: SeededClub;
	let b: SeededClub;
	const extraClubIds: string[] = [];
	const extraUserIds: string[] = [];
	const personIds: string[] = [];
	const pathIds: string[] = [];

	/** A speaker role in `clubId`, so speeches can sit on its slots. */
	async function speakerDef(clubId: string): Promise<string> {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId,
				name: `Speaker ${RUN}`,
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		return def.id;
	}

	async function makeGuest(
		clubId: string,
		over: Partial<typeof guests.$inferInsert> = {},
	): Promise<string> {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId, name: `Guest ${RUN}`, ...over })
			.returning({ id: guests.id });
		return g.id;
	}

	async function guestSpeech(
		guestId: string,
		over: Partial<typeof speeches.$inferInsert> = {},
	): Promise<string> {
		const [s] = await testDb
			.insert(speeches)
			.values({ guestId, title: `Guest speech ${RUN}`, ...over })
			.returning({ id: speeches.id });
		return s.id;
	}

	async function personSpeech(
		personId: string,
		over: Partial<typeof speeches.$inferInsert> = {},
	): Promise<string> {
		const [s] = await testDb
			.insert(speeches)
			.values({ personId, title: `Person speech ${RUN}`, ...over })
			.returning({ id: speeches.id });
		return s.id;
	}

	async function pastMeeting(clubId: string): Promise<string> {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId,
				scheduledAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
				status: "completed",
			})
			.returning({ id: meetings.id });
		return m.id;
	}

	beforeAll(async () => {
		a = await seedClub();
		b = await seedClub();
	});

	afterAll(async () => {
		for (const c of [a, b]) {
			if (c) await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
		}
		for (const id of extraClubIds) await cleanup(id, []);
		if (extraUserIds.length) {
			await testDb.delete(user).where(inArray(user.id, extraUserIds));
		}
		if (pathIds.length) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, pathIds));
		}
		if (personIds.length) {
			await testDb.delete(people).where(inArray(people.id, personIds));
		}
	});

	// -------------------------------------------------------------------------
	// Criterion 2: exactly one owner
	// -------------------------------------------------------------------------

	describe("speeches_single_owner", () => {
		it("refuses a speech with BOTH a person and a guest", async () => {
			const guestId = await makeGuest(a.clubId);
			const err = await pgError(
				testDb
					.insert(speeches)
					.values({ personId: a.personId, guestId, title: "both" }),
			);
			expect(err).toEqual({
				code: "23514",
				constraint: "speeches_single_owner",
			});
		});

		it("refuses a speech with NEITHER owner", async () => {
			const err = await pgError(
				testDb.insert(speeches).values({ title: "orphan" }),
			);
			expect(err).toEqual({
				code: "23514",
				constraint: "speeches_single_owner",
			});
		});

		it("refuses an UPDATE that clears the only owner", async () => {
			const id = await personSpeech(a.personId);
			const err = await pgError(
				testDb
					.update(speeches)
					.set({ personId: null })
					.where(eq(speeches.id, id)),
			);
			expect(err).toEqual({
				code: "23514",
				constraint: "speeches_single_owner",
			});
		});

		it("accepts a person-owned speech and a guest-owned speech", async () => {
			const guestId = await makeGuest(a.clubId);
			const p = await personSpeech(a.personId);
			const g = await guestSpeech(guestId);
			const rows = await testDb
				.select({
					id: speeches.id,
					personId: speeches.personId,
					guestId: speeches.guestId,
				})
				.from(speeches)
				.where(inArray(speeches.id, [p, g]));
			expect(rows).toHaveLength(2);
			expect(rows.find((r) => r.id === g)).toEqual({
				id: g,
				personId: null,
				guestId,
			});
		});
	});

	// -------------------------------------------------------------------------
	// Criterion 3: the two new foreign keys' delete rules
	// -------------------------------------------------------------------------

	describe("delete rules", () => {
		it("deleting a guest deletes the guest's speeches (ON DELETE CASCADE)", async () => {
			const guestId = await makeGuest(a.clubId);
			const g = await guestSpeech(guestId);
			const p = await personSpeech(a.personId);
			await testDb.delete(guests).where(eq(guests.id, guestId));
			const left = await testDb
				.select({ id: speeches.id })
				.from(speeches)
				.where(inArray(speeches.id, [g, p]));
			expect(left.map((r) => r.id)).toEqual([p]);
		});

		it("deleting the introducing member nulls introduced_by_member_id and keeps the guest", async () => {
			const personId = await seedPerson({ name: `Introducer ${RUN}` });
			personIds.push(personId);
			const [m] = await testDb
				.insert(members)
				.values({ clubId: a.clubId, personId, name: `Introducer ${RUN}` })
				.returning({ id: members.id });
			const guestId = await makeGuest(a.clubId, { introducedByMemberId: m.id });
			await testDb.delete(members).where(eq(members.id, m.id));
			const [g] = await testDb
				.select({ id: guests.id, introducedBy: guests.introducedByMemberId })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toEqual({ id: guestId, introducedBy: null });
		});
	});

	// -------------------------------------------------------------------------
	// Criterion 4 + the rest of the new storage
	// -------------------------------------------------------------------------

	describe("import storage", () => {
		it("the same (club_id, source, kind, source_id) in import_refs conflicts", async () => {
			const row = {
				clubId: a.clubId,
				source: "easy_speak" as const,
				kind: "meeting",
				sourceId: `m-${RUN}`,
				targetId: randomUUID(),
			};
			await testDb.insert(importRefs).values(row);
			const err = await pgError(
				testDb.insert(importRefs).values({ ...row, targetId: randomUUID() }),
			);
			expect(err.code).toBe("23505");
			expect(err.constraint).toBe(
				"import_refs_club_id_source_kind_source_id_pk",
			);
			// A different kind, or another club, with the same source id is a
			// different key.
			await testDb.insert(importRefs).values({ ...row, kind: "speech" });
			await testDb.insert(importRefs).values({ ...row, clubId: b.clubId });
			const refs = await testDb
				.select({ clubId: importRefs.clubId, kind: importRefs.kind })
				.from(importRefs)
				.where(eq(importRefs.sourceId, row.sourceId));
			expect(refs).toHaveLength(3);
		});

		it("the same bundle hash twice in one club conflicts; in another club it does not", async () => {
			const row = {
				clubId: a.clubId,
				source: "easy_speak" as const,
				bundle: { meetings: [] },
				bundleSha256: `sha-${RUN}`,
				uploadedByUserId: a.adminUserId,
			};
			const [first] = await testDb.insert(clubImports).values(row).returning({
				appliedAt: clubImports.appliedAt,
				createdAt: clubImports.createdAt,
			});
			expect(first.appliedAt).toBeNull();
			expect(first.createdAt).toBeInstanceOf(Date);
			const err = await pgError(testDb.insert(clubImports).values(row));
			expect(err).toEqual({
				code: "23505",
				constraint: "club_imports_club_sha_unique",
			});
			await testDb.insert(clubImports).values({ ...row, clubId: b.clubId });
		});

		it("a new guest defaults to kind 'visitor', a new attendance row to mode NULL", async () => {
			const guestId = await makeGuest(a.clubId);
			const [g] = await testDb
				.select({ kind: guests.kind, homeClub: guests.homeClub })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toEqual({ kind: "visitor", homeClub: null });
			const [att] = await testDb
				.insert(meetingAttendance)
				.values({ meetingId: a.meetingId, guestId, status: "present" })
				.returning({ mode: meetingAttendance.mode });
			expect(att.mode).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// Criterion 5: readers
	// -------------------------------------------------------------------------

	describe("speeches-logic", () => {
		it("listUnscheduledSpeeches never lists a guest's speech, scoped or not", async () => {
			const guestId = await makeGuest(a.clubId, { kind: "guest_speaker" });
			const g = await guestSpeech(guestId);
			const p = await personSpeech(a.personId);
			for (const filter of [
				{ clubId: a.clubId },
				{ clubId: a.clubId, includeArchived: true },
				{},
			]) {
				const ids = (await listUnscheduledSpeeches(testDb, filter)).map(
					(s) => s.id,
				);
				expect(ids).toContain(p);
				expect(ids).not.toContain(g);
			}
		});

		it("setSpeechArchived archives a guest's speech for the guest's own club", async () => {
			const guestId = await makeGuest(a.clubId);
			const g = await guestSpeech(guestId);
			await setSpeechArchived(testDb, {
				speechId: g,
				clubId: a.clubId,
				archived: true,
			});
			const [row] = await testDb
				.select({ archived: speeches.archived })
				.from(speeches)
				.where(eq(speeches.id, g));
			expect(row.archived).toBe(true);
		});

		it("setSpeechArchived refuses another club's guest's speech", async () => {
			const guestId = await makeGuest(b.clubId);
			const g = await guestSpeech(guestId);
			await expect(
				setSpeechArchived(testDb, {
					speechId: g,
					clubId: a.clubId,
					archived: true,
				}),
			).rejects.toThrow(SPEECH_NOT_IN_CLUB_MESSAGE);
		});

		it("attachSpeechToOpenSlot refuses a guest's speech and leaves the slot open", async () => {
			const guestId = await makeGuest(a.clubId);
			const g = await guestSpeech(guestId);
			const defId = await speakerDef(a.clubId);
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: a.meetingId,
					roleDefinitionId: defId,
					slotIndex: 7,
				})
				.returning({ id: roleSlots.id });
			await expect(
				attachSpeechToOpenSlot(testDb, {
					speechId: g,
					slotId: slot.id,
					actorMemberId: null,
				}),
			).rejects.toThrow(GUEST_SPEECH_NOT_SCHEDULABLE_MESSAGE);
			const [after] = await testDb
				.select({ speechId: roleSlots.speechId, status: roleSlots.status })
				.from(roleSlots)
				.where(eq(roleSlots.id, slot.id));
			expect(after).toEqual({ speechId: null, status: "open" });
		});
	});

	describe("people-logic", () => {
		it("historyCounts counts a Person's speeches and never a guest's", async () => {
			const personId = await seedPerson({ name: `History ${RUN}` });
			personIds.push(personId);
			await personSpeech(personId);
			const guestId = await makeGuest(a.clubId);
			await guestSpeech(guestId);
			await guestSpeech(guestId);
			const counts = await historyCounts(testDb, [personId]);
			expect([...counts.entries()]).toEqual([[personId, 1]]);
		});

		it("getMergePreview counts only the absorbed Person's own speeches", async () => {
			const keeper = await seedPerson({ name: `Keeper ${RUN}` });
			const absorbed = await seedPerson({ name: `Absorbed ${RUN}` });
			personIds.push(keeper, absorbed);
			await personSpeech(absorbed);
			await guestSpeech(await makeGuest(a.clubId));
			const preview = await getMergePreview(keeper, absorbed);
			expect(preview.movedCounts.speeches).toBe(1);
		});
	});

	describe("pathways-read-logic", () => {
		it("a guest's delivered speech on a member's path project is never the member's win", async () => {
			const [path] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: `GS-${RUN}`, name: `Guest Path ${RUN}` })
				.returning({ id: pathwaysPaths.id });
			pathIds.push(path.id);
			const [project] = await testDb
				.insert(pathwaysProjects)
				.values({
					pathId: path.id,
					level: 1,
					name: "Ice Breaker",
					isRequired: true,
				})
				.returning({ id: pathwaysProjects.id });
			await testDb
				.insert(pathEnrollments)
				.values({ personId: a.personId, pathId: path.id });

			const meetingId = await pastMeeting(a.clubId);
			const defId = await speakerDef(a.clubId);
			const guestId = await makeGuest(a.clubId, { kind: "guest_speaker" });
			const g = await guestSpeech(guestId, { projectId: project.id });
			const p = await personSpeech(a.personId, {
				projectId: project.id,
				title: `Mine ${RUN}`,
			});
			await testDb.insert(roleSlots).values([
				{
					meetingId,
					roleDefinitionId: defId,
					slotIndex: 0,
					assignedGuestId: guestId,
					speechId: g,
					status: "confirmed",
				},
				{
					meetingId,
					roleDefinitionId: defId,
					slotIndex: 1,
					assignedMemberId: a.memberId,
					speechId: p,
					status: "confirmed",
				},
			]);

			const [vm] = await pathwaysForPerson(a.personId);
			expect(vm.wins.map((w) => w.speechTitle)).toEqual([`Mine ${RUN}`]);
			const byMember = await pathwaysByMember(a.clubId);
			const mine = byMember
				.get(a.memberId)
				?.find((v) => v.courseCode === `GS-${RUN}`);
			expect(mine?.wins.map((w) => w.speechTitle)).toEqual([`Mine ${RUN}`]);
		});
	});

	describe("people-merge-logic", () => {
		it("re-points the absorbed Person's speeches by person_id and leaves a guest's untouched", async () => {
			const keeper = await seedPerson({ name: `MKeeper ${RUN}` });
			const absorbed = await seedPerson({ name: `MAbsorbed ${RUN}` });
			personIds.push(keeper, absorbed);
			const moved = await personSpeech(absorbed);
			const guestId = await makeGuest(a.clubId);
			const g = await guestSpeech(guestId);

			const res = await mergePeople({
				keeperPersonId: keeper,
				absorbedPersonId: absorbed,
			});
			expect(res.movedCounts.speeches).toBe(1);

			const rows = await testDb
				.select({
					id: speeches.id,
					personId: speeches.personId,
					guestId: speeches.guestId,
				})
				.from(speeches)
				.where(inArray(speeches.id, [moved, g]));
			expect(rows.find((r) => r.id === moved)).toEqual({
				id: moved,
				personId: keeper,
				guestId: null,
			});
			expect(rows.find((r) => r.id === g)).toEqual({
				id: g,
				personId: null,
				guestId,
			});
		});
	});

	describe("onboarding-logic", () => {
		it("deleteClubPermanently deletes a club whose guest gave a speech, and the speech with it", async () => {
			const doomed = await seedClub();
			extraClubIds.push(doomed.clubId);
			extraUserIds.push(doomed.adminUserId, doomed.memberUserId);
			const guestId = await makeGuest(doomed.clubId, { kind: "guest_speaker" });
			const g = await guestSpeech(guestId);
			const defId = await speakerDef(doomed.clubId);
			await testDb.insert(roleSlots).values({
				meetingId: doomed.meetingId,
				roleDefinitionId: defId,
				slotIndex: 3,
				assignedGuestId: guestId,
				speechId: g,
				status: "confirmed",
			});
			// The member person spoke too, only here: deleted with the club.
			await personSpeech(doomed.personId);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, doomed.clubId));

			const res = await deleteClubPermanently(doomed.clubId, "Test Club");
			expect(res.peopleDeleted).toBe(2);
			const left = await testDb
				.select({ id: speeches.id })
				.from(speeches)
				.where(eq(speeches.id, g));
			expect(left).toEqual([]);
		});

		// `personsWithOtherClubHistory` keeps a Person whose speech sits on a
		// surviving slot. A guest's speech on ANOTHER club's slot survives the
		// cascade and is exactly what that query reads, so it must not make
		// anyone count as having other-club history.
		it("deleteClubPermanently: another club's guest speech on a surviving slot keeps nobody", async () => {
			const doomed = await seedClub();
			extraClubIds.push(doomed.clubId);
			extraUserIds.push(doomed.adminUserId, doomed.memberUserId);
			const otherGuest = await makeGuest(b.clubId, { kind: "guest_speaker" });
			const g = await guestSpeech(otherGuest);
			await testDb.insert(roleSlots).values({
				meetingId: b.meetingId,
				roleDefinitionId: await speakerDef(b.clubId),
				slotIndex: 4,
				assignedGuestId: otherGuest,
				speechId: g,
				status: "confirmed",
			});
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, doomed.clubId));

			const res = await deleteClubPermanently(doomed.clubId, "Test Club");
			expect(res).toMatchObject({ peopleDeleted: 2, peopleKept: 0 });
			// The other club's guest speech is untouched.
			const [kept] = await testDb
				.select({ id: speeches.id, guestId: speeches.guestId })
				.from(speeches)
				.where(eq(speeches.id, g));
			expect(kept).toEqual({ id: g, guestId: otherGuest });
		});
	});

	// -------------------------------------------------------------------------
	// Criterion 6: the export carries the new columns
	// -------------------------------------------------------------------------

	describe("club-export-logic", () => {
		it("exports guest kind, home club, introducer, attendance mode, and a guest's speech", async () => {
			const club = await seedClub();
			extraClubIds.push(club.clubId);
			extraUserIds.push(club.adminUserId, club.memberUserId);
			const meetingId = await pastMeeting(club.clubId);
			const defId = await speakerDef(club.clubId);
			const guestId = await makeGuest(club.clubId, {
				name: `Visiting ${RUN}`,
				kind: "guest_speaker",
				homeClub: "Laguna Speakers #1234",
				introducedByMemberId: club.memberId,
			});
			// Introduced by ANOTHER club's member: a bad row must not name them.
			const strayId = await makeGuest(club.clubId, {
				name: `Stray ${RUN}`,
				introducedByMemberId: b.memberId,
			});
			const g = await guestSpeech(guestId, { title: `Visiting talk ${RUN}` });
			await testDb.insert(roleSlots).values({
				meetingId,
				roleDefinitionId: defId,
				slotIndex: 0,
				assignedGuestId: guestId,
				speechId: g,
				status: "confirmed",
			});
			// Another club's guest's speech on THIS club's slot: never exported.
			const foreign = await guestSpeech(await makeGuest(b.clubId), {
				title: `Foreign ${RUN}`,
			});
			await testDb.insert(roleSlots).values({
				meetingId,
				roleDefinitionId: defId,
				slotIndex: 1,
				speechId: foreign,
				status: "confirmed",
			});
			await testDb.insert(meetingAttendance).values([
				{ meetingId, guestId, status: "present", mode: "online" },
				{ meetingId, memberId: club.memberId, status: "present" },
			]);

			const out = await loadClubExport(club.clubId);
			const files = Object.fromEntries(
				(out?.files ?? []).map((f) => [f.filename, f]),
			);

			expect(files["guests.csv"].columns).toEqual(
				expect.arrayContaining([
					"kind",
					"home_club",
					"introduced_by_member_id",
				]),
			);
			expect(files["guests.csv"].rows).toContainEqual(
				expect.objectContaining({
					guest_id: guestId,
					kind: "guest_speaker",
					home_club: "Laguna Speakers #1234",
					introduced_by_member_id: club.memberId,
				}),
			);
			expect(files["guests.csv"].rows).toContainEqual(
				expect.objectContaining({
					guest_id: strayId,
					kind: "visitor",
					home_club: null,
					introduced_by_member_id: null,
				}),
			);

			expect(files["attendance.csv"].columns).toContain("mode");
			expect(files["attendance.csv"].rows).toContainEqual(
				expect.objectContaining({
					member_or_guest_id: guestId,
					mode: "online",
				}),
			);
			expect(files["attendance.csv"].rows).toContainEqual(
				expect.objectContaining({
					member_or_guest_id: club.memberId,
					mode: null,
				}),
			);

			expect(files["speeches.csv"].rows).toEqual([
				expect.objectContaining({
					meeting_id: meetingId,
					speaker: `Visiting ${RUN}`,
					member_or_guest_id: guestId,
					speaker_type: "guest",
					title: `Visiting talk ${RUN}`,
				}),
			]);
		});
	});
});
