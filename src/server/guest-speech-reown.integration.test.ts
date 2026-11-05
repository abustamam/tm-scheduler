/**
 * DB-backed tests for #1523: converting or linking a guest moves their speaker
 * slots to the member, and the speeches those slots point at must move too.
 * Left guest-owned (`speeches.guest_id`), the speech log (read through the
 * slot) showed the speech while Pathways progress (filtered on
 * `speeches.person_id`) did not. The undo of each gives back exactly the
 * speeches the forward step transferred.
 *
 * Beside `guest-pipeline.integration.test.ts` to keep the issue to one cited
 * source file. `#/db` is mocked to the TEST_DATABASE_URL client; the suite
 * skips when unset.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	meetings,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { UNDO_MEMBER_HAS_HISTORY_MESSAGE } from "#/lib/guest-convert";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyConvertGuestToMember,
	applyLinkGuestToMember,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
} = await import("#/server/guest-pipeline-logic");
const { pathwaysForPerson } = await import("#/server/pathways-read-logic");
const { loadSpeechLog } = await import("#/server/my-activity-logic");
const { loadMilestoneCounts } = await import("#/server/milestones-logic");

/**
 * Every statement issued inside a transaction while `fn` runs. The shared
 * `statementsDuring` spies the Pool, which a `db.transaction()` bypasses (its
 * statements run on a checked-out client), so this wraps each client the pool
 * hands out for the duration and restores it after.
 */
async function txStatementsDuring(
	fn: () => Promise<unknown>,
): Promise<string[]> {
	// biome-ignore lint/suspicious/noExplicitAny: the pg Pool is not typed on the drizzle handle
	const pool = testDb.$client as any;
	const seen: string[] = [];
	const restores: Array<() => void> = [];
	const connect = pool.connect.bind(pool);
	const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
		const c = await connect();
		const original = c.query;
		// biome-ignore lint/suspicious/noExplicitAny: pg overloads
		c.query = (...args: any[]) => {
			const a = args[0] as string | { text?: string } | undefined;
			seen.push(typeof a === "string" ? a : (a?.text ?? ""));
			return original.apply(c, args);
		};
		restores.push(() => {
			c.query = original;
		});
		return c;
	});
	try {
		await fn();
	} finally {
		spy.mockRestore();
		for (const r of restores) r();
	}
	return seen;
}

describe.skipIf(!hasTestDb)(
	"guest speeches follow convert/link (#1523)",
	() => {
		let seed: SeededClub;
		let strayPeople: string[] = [];
		let pathIds: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			strayPeople = [];
			pathIds = [];
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			if (pathIds.length > 0) {
				await testDb
					.delete(pathwaysPaths)
					.where(inArray(pathwaysPaths.id, pathIds));
			}
			if (strayPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, strayPeople));
			}
		});

		/** A guest holding a past speaker slot whose speech is linked to a project. */
		async function guestWithSpeech() {
			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson(
						{ clubId: seed.clubId, name: "Speaker Guest" },
						testDb,
					),
				)
				.returning({ id: guests.id });
			if (!g) throw new Error("Failed to seed guest");

			const [path] = await testDb
				.insert(pathwaysPaths)
				.values({
					courseCode: `RE-${randomUUID().slice(0, 8)}`,
					name: "Reown Path",
				})
				.returning({ id: pathwaysPaths.id });
			if (!path) throw new Error("Failed to seed path");
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
			if (!project) throw new Error("Failed to seed project");

			const [meeting] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!meeting) throw new Error("Failed to seed meeting");
			const [speech] = await testDb
				.insert(speeches)
				.values({
					guestId: g.id,
					title: "Guest's Ice Breaker",
					projectId: project.id,
				})
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to seed speech");
			const [speakerRole] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			if (!speakerRole) throw new Error("Failed to seed role");
			await testDb.insert(roleSlots).values({
				meetingId: meeting.id,
				roleDefinitionId: speakerRole.id,
				assignedGuestId: g.id,
				status: "claimed",
				speechId: speech.id,
			});
			return { guestId: g.id, speechId: speech.id, pathId: path.id };
		}

		async function owner(speechId: string) {
			const [s] = await testDb
				.select({ personId: speeches.personId, guestId: speeches.guestId })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			if (!s) throw new Error("speech vanished");
			return s;
		}

		async function pathwaysWins(personId: string, pathId: string) {
			// Enrolment is what makes the path appear in the member's Pathways view.
			const [enr] = await testDb
				.insert(pathEnrollments)
				.values({ personId, pathId })
				.returning({ id: pathEnrollments.id });
			if (!enr) throw new Error("Failed to enrol");
			await testDb.insert(pathLevelProgress).values({
				enrollmentId: enr.id,
				level: 1,
				completed: 0,
				total: 1,
				approved: false,
			});
			const vms = await pathwaysForPerson(personId);
			return vms.flatMap((vm) => vm.wins.map((w) => w.speechTitle));
		}

		async function milestoneSpeeches(membershipId: string) {
			return (await loadMilestoneCounts(membershipId)).speechesDelivered;
		}

		/** Hand a speech to a Person other than the one it was transferred to. */
		async function moveToOtherPerson(speechId: string) {
			const [other] = await testDb
				.insert(people)
				.values({ name: `Merged Keeper ${randomUUID().slice(0, 8)}` })
				.returning({ id: people.id });
			if (!other) throw new Error("Failed to seed person");
			strayPeople.push(other.id);
			await testDb
				.update(speeches)
				.set({ personId: other.id })
				.where(eq(speeches.id, speechId));
			return other.id;
		}

		/** An older-style record: drop `speechIds` from every activity detail. */
		async function stripSpeechIds() {
			await testDb
				.update(activityLog)
				.set({ detail: sql`${activityLog.detail} - 'speechIds'` })
				.where(eq(activityLog.clubId, seed.clubId));
		}

		async function inSpeechLog(membershipId: string) {
			const log = await loadSpeechLog([membershipId], seed.clubId, null);
			return log.rows.map((r) => r.speechTitle);
		}

		describe("convert", () => {
			async function convert(guestId: string) {
				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				strayPeople.push(res.personId);
				return res;
			}
			const undo = (guestId: string) =>
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

			it("moves the speech to the member's Person: owner, log and milestones agree", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				const { personId, membershipId } = await convert(guestId);
				expect(await owner(speechId)).toEqual({ personId, guestId: null });
				expect(await inSpeechLog(membershipId)).toContain(
					"Guest's Ice Breaker",
				);
				expect(await milestoneSpeeches(membershipId)).toBe(1);
			});

			// Only the Pathways read is asserted, so the person_id write is what a
			// mutation of the transfer must fail on (it filters on person_id).
			it("the converted member's Pathways progress shows the speech", async () => {
				const { guestId, pathId } = await guestWithSpeech();
				const { personId } = await convert(guestId);
				expect(await pathwaysWins(personId, pathId)).toContain(
					"Guest's Ice Breaker",
				);
			});

			it("undo leaves a recorded speech a merge moved to another Person with that Person", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await convert(guestId);
				const keeper = await moveToOtherPerson(speechId);
				await undo(guestId);
				expect(await owner(speechId)).toEqual({
					personId: keeper,
					guestId: null,
				});
			});

			it("undo of a record without speechIds succeeds and issues no speech UPDATE", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				const { personId } = await convert(guestId);
				await stripSpeechIds();
				const statements = await txStatementsDuring(() => undo(guestId));
				// Anti-vacuity: the spy saw the undo's other writes.
				expect(
					statements.some((q) => /update\s+"role_slots"/i.test(q)),
					"no transaction statement observed — the spy has stopped working",
				).toBe(true);
				expect(
					statements.filter((q) => /update\s+"speeches"/i.test(q)),
				).toEqual([]);
				// Not handed back by a guess: the speech stays with the member's Person.
				expect((await owner(speechId)).personId).toBe(personId);
			});

			it("undo succeeds (the speech is not post-conversion history) and the guest owns it again", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				const { personId } = await convert(guestId);
				expect((await owner(speechId)).personId).toBe(personId);
				await undo(guestId);
				expect(await owner(speechId)).toEqual({ personId: null, guestId });
			});

			it("a speech saved for the member after the conversion still blocks the undo, and nothing moves", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				const { personId } = await convert(guestId);
				await testDb.insert(speeches).values({ personId, title: "Later" });
				await expect(undo(guestId)).rejects.toThrow(
					UNDO_MEMBER_HAS_HISTORY_MESSAGE("speeches"),
				);
				expect((await owner(speechId)).personId).toBe(personId);
			});
		});

		describe("link", () => {
			const link = (guestId: string) =>
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: seed.memberId,
					actorMemberId: seed.adminMemberId,
				});
			const unlink = (guestId: string) =>
				applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

			it("moves the speech to the member's Person: owner, log and milestones agree", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await link(guestId);
				expect(await owner(speechId)).toEqual({
					personId: seed.personId,
					guestId: null,
				});
				expect(await inSpeechLog(seed.memberId)).toContain(
					"Guest's Ice Breaker",
				);
				expect(await milestoneSpeeches(seed.memberId)).toBe(1);
			});

			it("the linked member's Pathways progress shows the speech", async () => {
				const { guestId, pathId } = await guestWithSpeech();
				await link(guestId);
				expect(await pathwaysWins(seed.personId, pathId)).toContain(
					"Guest's Ice Breaker",
				);
			});

			it("unlink leaves a recorded speech a merge moved to another Person with that Person", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await link(guestId);
				const keeper = await moveToOtherPerson(speechId);
				await unlink(guestId);
				expect(await owner(speechId)).toEqual({
					personId: keeper,
					guestId: null,
				});
			});

			it("unlink of a record without speechIds succeeds and issues no speech UPDATE", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await link(guestId);
				await stripSpeechIds();
				const statements = await txStatementsDuring(() => unlink(guestId));
				expect(
					statements.some((q) => /update\s+"guests"/i.test(q)),
					"no transaction statement observed — the spy has stopped working",
				).toBe(true);
				expect(
					statements.filter((q) => /update\s+"speeches"/i.test(q)),
				).toEqual([]);
				expect((await owner(speechId)).personId).toBe(seed.personId);
			});

			it("unlink gives the guest the speech back", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await link(guestId);
				await unlink(guestId);
				expect(await owner(speechId)).toEqual({ personId: null, guestId });
			});

			it("unlink returns only the transferred speech; one saved for the member since stays with them", async () => {
				const { guestId, speechId } = await guestWithSpeech();
				await link(guestId);
				const [later] = await testDb
					.insert(speeches)
					.values({ personId: seed.personId, title: "Later" })
					.returning({ id: speeches.id });
				if (!later) throw new Error("Failed to seed speech");
				await unlink(guestId);
				expect(await owner(speechId)).toEqual({ personId: null, guestId });
				expect(await owner(later.id)).toEqual({
					personId: seed.personId,
					guestId: null,
				});
			});
		});
	},
);
