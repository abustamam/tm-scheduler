/**
 * Past speeches (#1656): record, edit and delete a speech given outside any
 * meeting, with a loose date. Calls the logic directly (`#/db` is the test
 * database); every card is `protects=…; fails_when=…; no_claim=…`.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { NO_PERMISSION_MESSAGE } from "./guards";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));

const { addPastSpeech, editPastSpeech, deletePastSpeech } = await import(
	"./past-speeches-logic"
);
const { loadSpeechLog } = await import("./my-activity-logic");
const {
	listUnscheduledSpeeches,
	attachSpeechToOpenSlot,
	setSpeechArchived,
	PAST_SPEECH_NOT_ARCHIVABLE_MESSAGE,
} = await import("./speeches-logic");

const input = (over: Record<string, unknown> = {}) => ({
	speakerDetails: { speechTitle: "Ice Breaker" },
	deliveredYear: 2023,
	deliveredMonth: 3,
	...over,
});

describe.skipIf(!hasTestDb)("past speeches (#1656)", () => {
	let a: SeededClub;
	let b: SeededClub;

	beforeEach(async () => {
		a = await seedClub();
		b = await seedClub();
	});
	afterEach(async () => {
		await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
		await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
	});

	async function row(id: string) {
		const [r] = await testDb.select().from(speeches).where(eq(speeches.id, id));
		return r;
	}
	/** The speaker (a's roster member) is also a member of club B. */
	async function joinB() {
		const [mb] = await testDb
			.insert(members)
			.values({
				clubId: b.clubId,
				personId: a.personId,
				name: "Member User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!mb) throw new Error("member of B");
		return mb.id;
	}
	const add = (actor: string, over: Record<string, unknown> = {}) =>
		addPastSpeech({
			memberId: a.memberId,
			actorUserId: actor,
			input: input(over),
		});

	describe("write gate", () => {
		// protects=who may record a past speech for a member
		// fails_when=the requireClubRole call is removed or the speaker arm widens
		// no_claim=impersonation arms
		it("allows the speaker and an officer of the club; records club and date", async () => {
			const byOfficer = await add(a.adminUserId);
			const r = await row(byOfficer.speechId);
			expect(r).toMatchObject({
				deliveredOffSchedule: true,
				deliveredYear: 2023,
				deliveredMonth: 3,
				recordedClubId: a.clubId,
				personId: a.personId,
			});
			await expect(add(a.memberUserId)).resolves.toBeDefined();
		});
		it("refuses a plain member for someone else, and an officer of another club", async () => {
			await expect(
				addPastSpeech({
					memberId: a.adminMemberId,
					actorUserId: a.memberUserId,
					input: input(),
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			await expect(add(b.adminUserId)).rejects.toThrow();
		});
		it("refuses every write, the speaker's own included, on an archived club", async () => {
			const { speechId } = await add(a.memberUserId);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, a.clubId));
			await expect(add(a.memberUserId)).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
			await expect(
				editPastSpeech({
					speechId,
					actorUserId: a.memberUserId,
					input: input(),
				}),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
			await expect(
				deletePastSpeech({ speechId, actorUserId: a.memberUserId }),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		});
		// protects=edit/delete authority follows the RECORDING club
		// fails_when=the gate falls back to any club the person belongs to
		it("edit and delete: speaker and recording-club officer pass; another club's officer and a plain member are refused", async () => {
			// AC6: the speaker is a member of club B too, and B's officer is still refused.
			await joinB();
			const { speechId } = await add(a.adminUserId);
			await expect(
				editPastSpeech({
					speechId,
					actorUserId: b.adminUserId,
					input: input(),
				}),
			).rejects.toThrow();
			await expect(
				deletePastSpeech({ speechId, actorUserId: b.adminUserId }),
			).rejects.toThrow();
			// A plain member of the club who is not the speaker: the admin's own speech.
			const own = await addPastSpeech({
				memberId: a.adminMemberId,
				actorUserId: a.adminUserId,
				input: input(),
			});
			await expect(
				editPastSpeech({
					speechId: own.speechId,
					actorUserId: a.memberUserId,
					input: input(),
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			await expect(
				deletePastSpeech({
					speechId: own.speechId,
					actorUserId: a.memberUserId,
				}),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			await editPastSpeech({
				speechId,
				actorUserId: a.memberUserId,
				input: input({ deliveredYear: null, deliveredMonth: null }),
			});
			expect(await row(speechId)).toMatchObject({
				deliveredYear: null,
				deliveredMonth: null,
			});
			await deletePastSpeech({ speechId, actorUserId: a.adminUserId });
			expect(await row(speechId)).toBeUndefined();
		});
		// fails_when=a deleted recording club leaves officers able to edit
		it("after the recording club is deleted only the person may edit", async () => {
			const { speechId } = await add(a.memberUserId);
			await testDb.delete(clubs).where(eq(clubs.id, a.clubId));
			expect((await row(speechId))?.recordedClubId).toBeNull();
			await expect(
				editPastSpeech({
					speechId,
					actorUserId: a.adminUserId,
					input: input(),
				}),
			).rejects.toThrow();
			await editPastSpeech({
				speechId,
				actorUserId: a.memberUserId,
				input: input({ speakerDetails: { speechTitle: "Renamed" } }),
			});
			expect((await row(speechId))?.title).toBe("Renamed");
			// restore a club row so cleanup's cascade has something to delete
			a = { ...a, clubId: b.clubId };
		});
		// fails_when=edit accepts a meeting's speech
		it("edit and delete refuse a speech that is not a past speech", async () => {
			const [sp] = await testDb
				.insert(speeches)
				.values({ personId: a.personId, title: "At a meeting" })
				.returning({ id: speeches.id });
			await expect(
				editPastSpeech({
					speechId: sp!.id,
					actorUserId: a.adminUserId,
					input: input(),
				}),
			).rejects.toThrow("Not a past speech.");
			await expect(
				deletePastSpeech({ speechId: sp!.id, actorUserId: a.adminUserId }),
			).rejects.toThrow("Not a past speech.");
		});
	});

	describe("archive toggle", () => {
		// protects=a past speech is not archivable from any club's surface (#1656)
		// fails_when=setSpeechArchived accepts an off-schedule speech, so a member
		//   of any club the person belongs to bypasses the recording-club gate
		// no_claim=archiving a meeting speech (speeches.integration.test.ts)
		it("refuses a past speech for the recording club's and another club's member", async () => {
			await joinB();
			const { speechId } = await add(a.adminUserId);
			for (const clubId of [a.clubId, b.clubId]) {
				await expect(
					setSpeechArchived(testDb, { speechId, clubId, archived: true }),
				).rejects.toThrow(PAST_SPEECH_NOT_ARCHIVABLE_MESSAGE);
			}
			expect((await row(speechId))?.archived).toBe(false);
		});
	});

	describe("activity log", () => {
		async function logFor(clubId: string, speechId: string) {
			const rows = await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, clubId));
			return rows.filter(
				(r) =>
					(r.detail as { speechId?: string } | null)?.speechId === speechId,
			);
		}
		// protects=one member_edit entry per write, same target type (spec: log one
		//   activity_log entry per write)
		// fails_when=a write skips its entry, or add and edit/delete disagree on target
		it("logs add, edit and delete as member_edit on the speaker's seat", async () => {
			const { speechId } = await add(a.adminUserId);
			await editPastSpeech({
				speechId,
				actorUserId: a.adminUserId,
				input: input(),
			});
			await deletePastSpeech({ speechId, actorUserId: a.adminUserId });
			const rows = await logFor(a.clubId, speechId);
			const byChange = new Map(
				rows.map((r) => [(r.detail as { change: string }).change, r]),
			);
			expect([...byChange.keys()].sort()).toEqual([
				"past_speech_add",
				"past_speech_delete",
				"past_speech_edit",
			]);
			for (const r of rows) {
				expect(r).toMatchObject({
					action: "member_edit",
					targetType: "member",
					targetId: a.memberId,
					actorMemberId: a.adminMemberId,
				});
			}
		});
		// no_claim=a club-less speech: activity_log.club_id is NOT NULL, so no entry exists
		it("targets the club when the speaker has left it, and writes nothing once the club is gone", async () => {
			const { speechId } = await add(a.adminUserId);
			await testDb.delete(members).where(eq(members.id, a.memberId));
			await editPastSpeech({
				speechId,
				actorUserId: a.adminUserId,
				input: input(),
			});
			const edit = (await logFor(a.clubId, speechId)).find(
				(r) => (r.detail as { change: string }).change === "past_speech_edit",
			);
			expect(edit).toMatchObject({
				targetType: "club",
				targetId: a.clubId,
			});
		});
	});

	describe("validation", () => {
		// fails_when=any of the three is accepted
		it("refuses a month without a year, a future year and a blank title", async () => {
			await expect(
				add(a.adminUserId, { deliveredYear: null, deliveredMonth: 4 }),
			).rejects.toThrow("year before a month");
			await expect(
				add(a.adminUserId, { deliveredYear: 2999, deliveredMonth: null }),
			).rejects.toThrow("future");
			await expect(
				add(a.adminUserId, { speakerDetails: { speechTitle: "  " } }),
			).rejects.toThrow("needs a title");
		});
		// fails_when=edit merges unsent fields instead of replacing
		it("edit is a full replace: an empty optional field clears the column", async () => {
			const { speechId } = await add(a.adminUserId, {
				speakerDetails: {
					speechTitle: "T",
					introduction: "hi",
					minMinutes: 4,
					maxMinutes: 6,
				},
			});
			await editPastSpeech({
				speechId,
				actorUserId: a.adminUserId,
				input: { speakerDetails: { speechTitle: "T" } },
			});
			expect(await row(speechId)).toMatchObject({
				introduction: null,
				minMinutes: null,
				deliveredYear: null,
			});
		});
	});

	describe("the speech log", () => {
		// protects=a club's profile shows only speeches recorded there; the dashboard shows all
		// fails_when=the recorded_club_id filter is dropped
		it("filters by recording club on the profile, not on the dashboard", async () => {
			// The same person is also a member of club B.
			const mbId = await joinB();
			const { speechId } = await add(a.adminUserId);
			const inA = await loadSpeechLog([a.memberId], a.clubId, 6);
			expect(inA.rows.map((r) => r.kind)).toEqual(["past"]);
			const inB = await loadSpeechLog([mbId], b.clubId, 6);
			expect(inB.rows).toEqual([]);
			const all = await loadSpeechLog([a.memberId, mbId], null, 6);
			expect(
				all.rows.map((r) => (r.kind === "past" ? r.speechId : "")),
			).toEqual([speechId]);
			// An archived recording club drops it from the dashboard too.
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, a.clubId));
			expect((await loadSpeechLog([a.memberId, mbId], null, 6)).rows).toEqual(
				[],
			);
			await testDb
				.update(clubs)
				.set({ archivedAt: null })
				.where(eq(clubs.id, a.clubId));
			// A deleted recording club keeps it on the dashboard.
			await testDb.delete(clubs).where(eq(clubs.id, a.clubId));
			const after = await loadSpeechLog([mbId], null, 6);
			expect(after.rows).toHaveLength(1);
			a = { ...a, clubId: b.clubId };
		});
		// protects=limit and truncated count the merged list
		// fails_when=limit applies per source
		it("limit 6 over 4 meeting + 4 past speeches gives the newest 6 and truncated", async () => {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: a.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			for (let i = 0; i < 4; i++) {
				const [m] = await testDb
					.insert(meetings)
					.values({
						clubId: a.clubId,
						scheduledAt: new Date(Date.UTC(2023, i * 3, 15)),
						status: "completed",
					})
					.returning({ id: meetings.id });
				await testDb.insert(roleSlots).values({
					meetingId: m!.id,
					roleDefinitionId: def!.id,
					status: "confirmed",
					assignedMemberId: a.memberId,
				});
			}
			for (const month of [2, 5, 8, 11]) {
				await add(a.adminUserId, { deliveredMonth: month });
			}
			const { rows, truncated } = await loadSpeechLog(
				[a.memberId],
				a.clubId,
				6,
			);
			expect(rows).toHaveLength(6);
			expect(truncated).toBe(true);
			const all = await loadSpeechLog([a.memberId], a.clubId, null);
			expect(all.rows).toHaveLength(8);
			expect(all.truncated).toBe(false);
			expect(rows).toEqual(all.rows.slice(0, 6));
		});
	});

	describe("merge order in the real log", () => {
		// protects=AC1/AC2: a month-dated past speech lands between the meeting
		//   speeches around it, a year-only one at Jan 1, an undated one last
		// fails_when=past rows are appended instead of merged by their loose date
		// no_claim=limit/truncated (see the limit test below)
		it("puts MAR 2023 between 2023-04 and 2023-02, year-only below the year's meetings, undated last", async () => {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: a.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const meetingOn = async (at: Date) => {
				const [m] = await testDb
					.insert(meetings)
					.values({ clubId: a.clubId, scheduledAt: at, status: "completed" })
					.returning({ id: meetings.id });
				await testDb.insert(roleSlots).values({
					meetingId: m!.id,
					roleDefinitionId: def!.id,
					status: "confirmed",
					assignedMemberId: a.memberId,
				});
			};
			await meetingOn(new Date(Date.UTC(2023, 3, 15)));
			await meetingOn(new Date(Date.UTC(2023, 1, 15)));
			await meetingOn(new Date(Date.UTC(2022, 5, 15)));
			const mar = await add(a.adminUserId);
			const yearOnly = await add(a.adminUserId, {
				deliveredYear: 2022,
				deliveredMonth: null,
			});
			const undated = await add(a.adminUserId, {
				deliveredYear: null,
				deliveredMonth: null,
			});
			const { rows } = await loadSpeechLog([a.memberId], a.clubId, null);
			const shape = rows.map((r) =>
				r.kind === "meeting"
					? `m:${r.scheduledAt.toISOString().slice(0, 7)}`
					: r.speechId === mar.speechId
						? "past:mar"
						: r.speechId === yearOnly.speechId
							? "past:year"
							: r.speechId === undated.speechId
								? "past:none"
								: "?",
			);
			expect(shape).toEqual([
				"m:2023-04",
				"past:mar",
				"m:2023-02",
				"m:2022-06",
				"past:year",
				"past:none",
			]);
		});
	});

	describe("never schedulable", () => {
		// fails_when=the off-schedule filter is dropped from the unscheduled list
		it("is absent from the unscheduled list and refused by the slot-attach writer", async () => {
			const { speechId } = await add(a.memberUserId);
			const list = await listUnscheduledSpeeches(testDb, {
				personId: a.personId,
				includeArchived: true,
			});
			expect(list.map((s) => s.id)).not.toContain(speechId);
			await expect(
				attachSpeechToOpenSlot(testDb as never, {
					speechId,
					slotId: a.slotId,
					actorMemberId: null,
				}),
			).rejects.toThrow("outside a meeting");
		});
	});

	describe("speech-request reuse path", () => {
		// protects=a request linked to an off-schedule (past) speech never reuses or
		//   rewrites it: Schedule makes a new speech and leaves the past one intact
		// fails_when=`deliveredOffSchedule = false` is dropped from the reuse select
		//   in scheduleSpeechRequest (the past speech is picked, rewritten, and the
		//   attach refuses, so Schedule throws instead of resolving)
		// no_claim=reuse of an ordinary unattached speech (speech-requests.integration.test.ts)
		it("schedules a NEW speech and leaves the past speech untouched", async () => {
			const { scheduleSpeechRequest } = await import("./speech-requests-logic");
			const { speechRequests } = await import("#/db/schema");
			const { speechId: pastId } = await add(a.memberUserId, {
				speakerDetails: { speechTitle: "Given at a conference" },
			});
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: a.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: a.clubId,
					scheduledAt: new Date(Date.now() + 14 * 86_400_000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			const [slot] = await testDb
				.insert(roleSlots)
				.values({ meetingId: m!.id, roleDefinitionId: def!.id })
				.returning({ id: roleSlots.id });
			const [req] = await testDb
				.insert(speechRequests)
				.values({
					clubId: a.clubId,
					membershipId: a.memberId,
					title: "Reworded",
					speechId: pastId,
				})
				.returning({ id: speechRequests.id });

			const result = await scheduleSpeechRequest({
				requestId: req!.id,
				slotId: slot!.id,
				clubId: a.clubId,
				actorMemberId: a.adminMemberId,
			});

			expect(result.speechId).not.toBe(pastId);
			const past = await row(pastId);
			expect(past).toMatchObject({
				title: "Given at a conference",
				deliveredOffSchedule: true,
				deliveredYear: 2023,
			});
			const [held] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, slot!.id));
			expect(held?.speechId).toBe(result.speechId);
		});
	});

	describe("database checks", () => {
		const bad = (values: Record<string, unknown>) =>
			testDb.execute(
				sql`insert into speeches (person_id, title, delivered_off_schedule, delivered_year, delivered_month, recorded_club_id)
				values (${a.personId}, 'x', ${values.off ?? true}, ${values.year ?? null}, ${values.month ?? null}, ${values.club ?? null})`,
			);
		/** The name of the constraint Postgres says the insert violated. */
		async function violated(p: Promise<unknown>): Promise<string | undefined> {
			try {
				await p;
			} catch (err) {
				for (let e: unknown = err, i = 0; e && i < 4; i++) {
					const c = (e as { constraint?: unknown }).constraint;
					if (typeof c === "string") return c;
					e = (e as { cause?: unknown }).cause;
				}
			}
			return undefined;
		}
		// protects=each speeches check constraint, by name
		// fails_when=a check is dropped from the migration, or another check
		//   rejects the row first (a bare toThrow could not tell)
		// no_claim=the app-level validation, which has its own tests
		it("rejects each invalid shape by the constraint that owns it", async () => {
			const delivered = "speeches_delivered_date_valid";
			const onlyOff = "speeches_delivered_date_only_off_schedule";
			expect(await violated(bad({ month: 3 }))).toBe(delivered);
			expect(await violated(bad({ year: 2020, month: 13 }))).toBe(delivered);
			expect(await violated(bad({ year: 1899 }))).toBe(delivered);
			expect(await violated(bad({ year: 2101 }))).toBe(delivered);
			expect(await violated(bad({ off: false, year: 2020 }))).toBe(onlyOff);
			expect(await violated(bad({ off: false, club: a.clubId }))).toBe(onlyOff);
			await expect(bad({ year: 2020, month: 5 })).resolves.toBeDefined();
		});
		// A guest-owned row satisfies speeches_single_owner, so only the
		// member-only check can reject it.
		it("rejects an off-schedule speech owned by a guest, by speeches_off_schedule_member_only", async () => {
			const [guest] = await testDb
				.insert(guests)
				.values({ clubId: a.clubId, name: "Guest G", personId: a.personId })
				.returning({ id: guests.id });
			expect(
				await violated(
					testDb.execute(
						sql`insert into speeches (guest_id, title, delivered_off_schedule) values (${guest?.id}, 'x', true)`,
					),
				),
			).toBe("speeches_off_schedule_member_only");
		});
		it("still rejects a speech with no owner, by speeches_single_owner", async () => {
			expect(
				await violated(
					testDb.execute(
						sql`insert into speeches (title, delivered_off_schedule) values ('x', false)`,
					),
				),
			).toBe("speeches_single_owner");
		});
	});
});
