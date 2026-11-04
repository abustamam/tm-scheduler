/**
 * DB-backed tests for the #190 recurrence-rule CRUD + edit reconciliation:
 * saving a rule tops up; editing the PATTERN deletes only pristine-empty future
 * meetings on the OLD pattern and regenerates on the new one; customized and
 * off-old-pattern meetings survive; disabling stops generation.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_190 \
 *     bunx vitest run src/server/recurrence-rule.integration.test.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guestInvites,
	guests,
	meetingAttendancePlan,
	meetingGuestRsvps,
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// Pass-through; one test makes the top-up throw to prove the save is atomic.
vi.mock("./schedule-topup-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./schedule-topup-logic")>();
	return {
		...actual,
		ensureScheduleToppedUp: vi.fn(actual.ensureScheduleToppedUp),
	};
});

const { saveRecurrenceRule, getRecurrenceRule, findPristineEmptyMeetingIds } =
	await import("./recurrence-rule-logic");
const { applyTemplateConversion } = await import("./meeting-templates-logic");
const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");
const { lockRecurrenceRule, saveRecurrenceRuleIn, classifyMeetings } =
	await import("./recurrence-rule-logic");
const { claimSlotCore } = await import("./slots-logic");

const TZ = "America/Chicago";
const NOW = new Date("2026-06-01T12:00:00Z");

function localDate(instant: Date): string {
	return utcToZonedWallTime(instant, TZ).slice(0, 10);
}
function weekdayOf(ymd: string): number {
	return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

const weeklyThursday = {
	mode: "interval" as const,
	weekday: 4,
	intervalWeeks: 1,
	anchorDate: "2026-01-01",
	ordinals: null,
	timeOfDay: "18:45",
	location: "Main Hall",
	keepAhead: 4,
	enabled: true,
};

async function futureScheduled(clubId: string) {
	const rows = await testDb
		.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(and(eq(meetings.clubId, clubId), eq(meetings.status, "scheduled")));
	return rows
		.filter((r) => r.scheduledAt.getTime() > NOW.getTime())
		.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

describe.skipIf(!hasTestDb)(
	"recurrence-rule CRUD + reconciliation (#190)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
			await testDb.delete(meetings).where(eq(meetings.clubId, club.clubId));
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		it("creating a rule persists it and tops up the schedule", async () => {
			const res = await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			expect(res.created).toBe(4);

			const rule = await getRecurrenceRule(club.clubId);
			expect(rule?.mode).toBe("interval");
			expect(rule?.weekday).toBe(4);

			const rows = await futureScheduled(club.clubId);
			expect(rows.length).toBe(4);
			expect(
				rows
					.map((r) => localDate(r.scheduledAt))
					.every((d) => weekdayOf(d) === 4),
			).toBe(true);
		});

		it("editing the weekday moves pristine future meetings to the new pattern", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			// Edit Thursday → Wednesday.
			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			const dates = (await futureScheduled(club.clubId)).map((r) =>
				localDate(r.scheduledAt),
			);
			expect(dates.length).toBe(4);
			expect(dates.every((d) => weekdayOf(d) === 3)).toBe(true); // all Wednesdays now
			expect(dates.some((d) => weekdayOf(d) === 4)).toBe(false); // no Thursdays left
		});

		it("editing preserves a future meeting that has a claimed role slot", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			const before = await futureScheduled(club.clubId);
			// Claim a slot on the 2nd Thursday → it's now customized, not pristine.
			const kept = before[1];
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: club.memberId, status: "claimed" })
				.where(eq(roleSlots.meetingId, kept.id));

			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			// The claimed Thursday meeting survives; the other pristine Thursdays are gone.
			const rows = await futureScheduled(club.clubId);
			const ids = rows.map((r) => r.id);
			expect(ids).toContain(kept.id);
			const thursdays = rows.filter(
				(r) => weekdayOf(localDate(r.scheduledAt)) === 4,
			);
			expect(thursdays.map((r) => r.id)).toEqual([kept.id]);
		});

		it("editing does not delete a manual off-old-pattern meeting", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			// A manual pristine meeting on a Tuesday (not on the old Thursday pattern).
			const [tue] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: zonedWallTimeToUtc("2026-06-16T12:00", TZ), // a Tuesday
					status: "scheduled",
				})
				.returning({ id: meetings.id });

			await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, weekday: 3 },
				NOW,
			);

			const ids = (await futureScheduled(club.clubId)).map((r) => r.id);
			expect(ids).toContain(tue.id); // off-pattern manual meeting untouched
		});

		it("disabling stops generation and leaves existing meetings in place", async () => {
			await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
			const beforeIds = (await futureScheduled(club.clubId))
				.map((r) => r.id)
				.sort();

			const res = await saveRecurrenceRule(
				club.clubId,
				{ ...weeklyThursday, enabled: false },
				NOW,
			);
			expect(res.created).toBe(0);

			const afterIds = (await futureScheduled(club.clubId))
				.map((r) => r.id)
				.sort();
			expect(afterIds).toEqual(beforeIds); // unchanged
			expect((await getRecurrenceRule(club.clubId))?.enabled).toBe(false);
		});

		// "Touched" means someone put work into this meeting that a regenerate
		// would destroy. Declining is that; answering "yes, I'll be there" or
		// merely BEING ASKED is not — nobody has edited an agenda by answering a
		// question, and a `coming` row that pinned a meeting in place would let
		// one keen member freeze the whole schedule against a pattern edit.
		describe("findPristineEmptyMeetingIds vs planned attendance", () => {
			// `daysOut` is not decoration: `meetings` carries a unique
			// (club_id, scheduled_at), so two fixtures on the same instant abort.
			async function emptyMeeting(daysOut: number): Promise<string> {
				const [m] = await testDb
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: new Date(
							NOW.getTime() + daysOut * 24 * 60 * 60 * 1000,
						),
						status: "scheduled",
					})
					.returning({ id: meetings.id });
				if (!m) throw new Error("Failed to insert meeting");
				return m.id;
			}

			it("a not_coming answer makes the meeting non-pristine", async () => {
				const meetingId = await emptyMeeting(30);
				expect(await findPristineEmptyMeetingIds([meetingId])).toEqual([
					meetingId,
				]);

				await testDb.insert(meetingAttendancePlan).values({
					memberId: club.memberId,
					meetingId,
					status: "not_coming",
				});

				expect(await findPristineEmptyMeetingIds([meetingId])).toEqual([]);
			});

			it("a coming or reached_out answer leaves the meeting pristine", async () => {
				const comingId = await emptyMeeting(31);
				const reachedOutId = await emptyMeeting(32);

				await testDb.insert(meetingAttendancePlan).values([
					{
						memberId: club.memberId,
						meetingId: comingId,
						status: "coming",
					},
					{
						memberId: club.memberId,
						meetingId: reachedOutId,
						status: "reached_out",
					},
				]);

				const pristine = await findPristineEmptyMeetingIds([
					comingId,
					reachedOutId,
				]);
				expect(pristine.sort()).toEqual([comingId, reachedOutId].sort());
			});

			// #880. Table Topics notes are content an officer typed; a pattern edit
			// that deleted the meeting would take them with it.
			it("Table Topics notes make the meeting non-pristine (#880)", async () => {
				const meetingId = await emptyMeeting(33);
				expect(await findPristineEmptyMeetingIds([meetingId])).toEqual([
					meetingId,
				]);
				await testDb
					.update(meetings)
					.set({ tableTopicsNotes: "1. THE COMEBACK" })
					.where(eq(meetings.id, meetingId));
				expect(await findPristineEmptyMeetingIds([meetingId])).toEqual([]);
			});
		});

		// Task 3b, part A. Task 3 made converting a meeting deep-copy its template
		// into a PRIVATE `meeting_templates` row. `reconcileEmptyShells` (the
		// recurrence pruner) deletes whatever `findPristineEmptyMeetingIds`
		// returns, and a converted contest meeting with every slot unclaimed and
		// every content field blank satisfied every existing check — so it used to
		// be pruned, and an officer editing their club's recurrence pattern got a
		// 500. A converted meeting is NOT an empty shell whatever its fields say:
		// someone chose that shape for it.
		//
		// The delete itself no longer throws (#801): the `role_definitions
		// .template_id` RESTRICT that used to block it holds nothing now that role
		// identity lives in the club's bank. So the exclusion below is the whole
		// of the guard rather than a belt beside a database brace, and the second
		// test measures the change of footing rather than asserting the old
		// hazard still exists.
		describe("findPristineEmptyMeetingIds vs a converted meeting", () => {
			const createdTemplateIds: string[] = [];

			afterEach(async () => {
				if (createdTemplateIds.length > 0) {
					await testDb
						.delete(meetingTemplates)
						.where(inArray(meetingTemplates.id, createdTemplateIds));
					createdTemplateIds.length = 0;
				}
			});

			async function emptyMeeting(daysOut: number): Promise<string> {
				const [m] = await testDb
					.insert(meetings)
					.values({
						clubId: club.clubId,
						scheduledAt: new Date(
							NOW.getTime() + daysOut * 24 * 60 * 60 * 1000,
						),
						status: "scheduled",
					})
					.returning({ id: meetings.id });
				if (!m) throw new Error("Failed to insert meeting");
				return m.id;
			}

			async function makeTemplate(): Promise<string> {
				const [tpl] = await testDb
					.insert(meetingTemplates)
					.values({
						clubId: null,
						key: `contest-${crypto.randomUUID().slice(0, 8)}`,
						name: "Speech Contest",
					})
					.returning({ id: meetingTemplates.id });
				if (!tpl) throw new Error("Failed to insert template");
				createdTemplateIds.push(tpl.id);
				await testDb.insert(meetingTemplateRoles).values({
					templateId: tpl.id,
					key: "contest_chair",
					name: "Contest Chair",
					category: "leadership",
					defaultCount: 1,
					sortOrder: 10,
				});
				return tpl.id;
			}

			it("excludes a converted meeting even though every content field is blank and no slot is claimed", async () => {
				const source = await makeTemplate();
				const meetingId = await emptyMeeting(40);
				await applyTemplateConversion({
					meetingId,
					clubId: club.clubId,
					templateId: source,
					actorMemberId: null,
				});

				expect(await findPristineEmptyMeetingIds([meetingId])).toEqual([]);
			});

			it("deleting a converted meeting now succeeds, so the exclusion above is the ONLY guard (#801)", async () => {
				// This asserted the opposite until #801 — the delete threw on
				// `role_definitions_template_id_meeting_templates_id_fk`, because a
				// conversion materialized definitions against the private copy.
				// Nothing points at a template any more, so the cascade runs clean:
				// the meeting goes, its private copy goes with it, and the club KEEPS
				// the role the conversion resolved. Inverting the assertion rather
				// than deleting it is the point — a reader has to be able to see that
				// `findPristineEmptyMeetingIds` is now load-bearing on its own.
				const source = await makeTemplate();
				const meetingId = await emptyMeeting(41);
				await applyTemplateConversion({
					meetingId,
					clubId: club.clubId,
					templateId: source,
					actorMemberId: null,
				});
				const banked = await testDb
					.select({ id: roleDefinitions.id })
					.from(roleDefinitions)
					.where(
						and(
							eq(roleDefinitions.clubId, club.clubId),
							eq(roleDefinitions.key, "contest_chair"),
						),
					);
				expect(banked).toHaveLength(1);

				await testDb.delete(meetings).where(eq(meetings.id, meetingId));

				expect(
					await testDb
						.select({ id: meetings.id })
						.from(meetings)
						.where(eq(meetings.id, meetingId)),
				).toEqual([]);
				// The club's role survived the meeting that introduced it.
				expect(
					await testDb
						.select({ id: roleDefinitions.id })
						.from(roleDefinitions)
						.where(eq(roleDefinitions.id, banked[0]?.id ?? "")),
				).toHaveLength(1);
			});
		});

		// #1514 risk review: what a time change must never delete, through the web
		// save (the same predicate guards `update_meeting_schedule`).
		describe("a time change keeps what the top-up did not create", () => {
			const retimed = { ...weeklyThursday, timeOfDay: "19:30" };

			async function seedWeek() {
				await saveRecurrenceRule(club.clubId, weeklyThursday, NOW);
				const before = await futureScheduled(club.clubId);
				const target = before[1];
				if (!target) throw new Error("no meeting seeded");
				return { before, target };
			}
			async function ids() {
				return (await futureScheduled(club.clubId)).map((r) => r.id);
			}
			async function guest() {
				const [g] = await testDb
					.insert(guests)
					.values(
						await withGuestPerson({ clubId: club.clubId, name: "Visiting Vi" }),
					)
					.returning({ id: guests.id });
				if (!g) throw new Error("no guest");
				return g.id;
			}

			it("control: an untouched top-up meeting IS recreated at the new time", async () => {
				const { before } = await seedWeek();
				await saveRecurrenceRule(club.clubId, retimed, NOW);
				const after = await ids();
				expect(after.some((id) => before.some((b) => b.id === id))).toBe(false);
				expect(after).toHaveLength(4);
			});

			it("a guest RSVP keeps the meeting and its RSVP", async () => {
				const { target } = await seedWeek();
				const guestId = await guest();
				await testDb.insert(meetingGuestRsvps).values({
					clubId: club.clubId,
					meetingId: target.id,
					guestId,
					clientKey: crypto.randomUUID(),
				});
				await saveRecurrenceRule(club.clubId, retimed, NOW);
				expect(await ids()).toContain(target.id);
				expect(
					await testDb
						.select({ id: meetingGuestRsvps.id })
						.from(meetingGuestRsvps)
						.where(eq(meetingGuestRsvps.meetingId, target.id)),
				).toHaveLength(1);
			});

			it("a guest invite keeps the meeting and its invite", async () => {
				const { target } = await seedWeek();
				const guestId = await guest();
				await testDb.insert(guestInvites).values({
					clubId: club.clubId,
					meetingId: target.id,
					guestId,
				});
				await saveRecurrenceRule(club.clubId, retimed, NOW);
				expect(await ids()).toContain(target.id);
				expect(
					await testDb
						.select({ id: guestInvites.id })
						.from(guestInvites)
						.where(eq(guestInvites.meetingId, target.id)),
				).toHaveLength(1);
			});

			it.each([
				["location", { location: "Zoom room" }],
				["length", { lengthMinutes: 45 }],
				["join link", { joinUrl: "https://example.com/join" }],
				["meeting number", { meetingNumber: 77 }],
			])("a per-meeting %s override keeps the meeting", async (_l, patch) => {
				const { target } = await seedWeek();
				await testDb
					.update(meetings)
					.set(patch)
					.where(eq(meetings.id, target.id));
				await saveRecurrenceRule(club.clubId, retimed, NOW);
				const after = await futureScheduled(club.clubId);
				const kept = after.find((r) => r.id === target.id);
				expect(kept).toBeDefined();
				expect(
					utcToZonedWallTime(kept?.scheduledAt as Date, TZ).slice(11, 16),
				).toBe("18:45");
			});

			it("a failure in the top-up rolls back the delete and the rule save (one transaction)", async () => {
				const { before } = await seedWeek();
				vi.mocked(ensureScheduleToppedUp).mockRejectedValueOnce(
					new Error("boom in the top-up"),
				);
				await expect(
					saveRecurrenceRule(club.clubId, retimed, NOW),
				).rejects.toThrow("boom in the top-up");
				expect(await ids()).toEqual(before.map((b) => b.id));
				expect((await getRecurrenceRule(club.clubId))?.timeOfDay).toBe("18:45");
			});

			// #1516 round 3: the save locks the candidates (meetings, role slots,
			// attendance-plan rows) BEFORE its untouched check. Each test holds a
			// write on a second connection, uncommitted, starts the save, proves it
			// waits, commits the write, and asserts the meeting was KEPT with the
			// write intact. Without the matching lock the save reads the old state,
			// then its DELETE cascades the write away.
			async function saveWaitsForWrite(
				write: (
					tx: Parameters<Parameters<typeof testDb.transaction>[0]>[0],
				) => Promise<void>,
			) {
				let release: () => void = () => {};
				const held = new Promise<void>((r) => {
					release = r;
				});
				let written: () => void = () => {};
				const gotWrite = new Promise<void>((r) => {
					written = r;
				});
				const holder = testDb.transaction(async (tx) => {
					await write(tx);
					written();
					await held;
				});
				await gotWrite;
				let settled = false;
				const save = saveRecurrenceRule(club.clubId, retimed, NOW).then(() => {
					settled = true;
				});
				await new Promise((r) => setTimeout(r, 400));
				expect(settled).toBe(false);
				release();
				await holder;
				await save;
			}

			it("a role claim in flight when the save starts keeps the meeting and its claim", async () => {
				const { target } = await seedWeek();
				await saveWaitsForWrite(async (tx) => {
					await tx
						.update(roleSlots)
						.set({ assignedMemberId: club.memberId, status: "claimed" })
						.where(eq(roleSlots.meetingId, target.id));
				});
				expect(await ids()).toContain(target.id);
				const slots = await testDb
					.select({ status: roleSlots.status })
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, target.id));
				expect(slots.length).toBeGreaterThan(0);
				expect(slots.every((x) => x.status === "claimed")).toBe(true);
			});

			it("a guest RSVP in flight when the save starts keeps the meeting and its RSVP", async () => {
				const { target } = await seedWeek();
				const guestId = await guest();
				await saveWaitsForWrite(async (tx) => {
					await tx.insert(meetingGuestRsvps).values({
						clubId: club.clubId,
						meetingId: target.id,
						guestId,
						clientKey: crypto.randomUUID(),
					});
				});
				expect(await ids()).toContain(target.id);
				expect(
					await testDb
						.select({ id: meetingGuestRsvps.id })
						.from(meetingGuestRsvps)
						.where(eq(meetingGuestRsvps.meetingId, target.id)),
				).toHaveLength(1);
			});

			it("a decline flipped in flight when the save starts keeps the meeting and its decline", async () => {
				const { target } = await seedWeek();
				await testDb.insert(meetingAttendancePlan).values({
					memberId: club.memberId,
					meetingId: target.id,
					status: "coming",
				});
				await saveWaitsForWrite(async (tx) => {
					await tx
						.update(meetingAttendancePlan)
						.set({ status: "not_coming" })
						.where(eq(meetingAttendancePlan.meetingId, target.id));
				});
				expect(await ids()).toContain(target.id);
				const rows = await testDb
					.select({ status: meetingAttendancePlan.status })
					.from(meetingAttendancePlan)
					.where(eq(meetingAttendancePlan.meetingId, target.id));
				expect(rows).toEqual([{ status: "not_coming" }]);
			});

			it("while a save holds the locks, a claim and a guest RSVP wait, then fail cleanly after the delete", async () => {
				const { target } = await seedWeek();
				const [slot] = await testDb
					.select({ id: roleSlots.id })
					.from(roleSlots)
					.where(eq(roleSlots.meetingId, target.id))
					.limit(1);
				if (!slot) throw new Error("no slot");
				const guestId = await guest();

				let release: () => void = () => {};
				const held = new Promise<void>((r) => {
					release = r;
				});
				let locked: () => void = () => {};
				const gotLock = new Promise<void>((r) => {
					locked = r;
				});
				// Connection 1: the save, paused after the locks and the delete,
				// before commit.
				const saver = testDb.transaction(async (tx) => {
					await saveRecurrenceRuleIn(
						tx,
						club.clubId,
						retimed,
						NOW,
						async () => {
							locked();
							await held;
						},
					);
				});
				await gotLock;

				let claimSettled = false;
				let rsvpSettled = false;
				// Connection 2: a claim. Connection 3: a guest RSVP insert.
				const claim = testDb
					.transaction((tx) =>
						claimSlotCore(tx, {
							slotId: slot.id,
							memberId: club.memberId,
							actorMemberId: club.memberId,
						}),
					)
					.then(
						() => ({ ok: true as const }),
						(e: Error) => ({ ok: false as const, message: e.message }),
					)
					.finally(() => {
						claimSettled = true;
					});
				const rsvp = testDb
					.insert(meetingGuestRsvps)
					.values({
						clubId: club.clubId,
						meetingId: target.id,
						guestId,
						clientKey: crypto.randomUUID(),
					})
					.then(
						() => ({ ok: true as const }),
						() => ({ ok: false as const }),
					)
					.finally(() => {
						rsvpSettled = true;
					});
				await new Promise((r) => setTimeout(r, 400));
				expect(claimSettled).toBe(false);
				expect(rsvpSettled).toBe(false);
				release();
				await saver;

				// Either the meeting is kept or the write fails; never a silent loss.
				const claimResult = await claim;
				const rsvpResult = await rsvp;
				expect(claimResult.ok).toBe(false);
				expect(rsvpResult.ok).toBe(false);
				expect((claimResult as { message: string }).message).toBe(
					"Sorry \u2014 this role was just claimed by someone else.",
				);
				// Meeting gone with no orphans.
				expect(await ids()).not.toContain(target.id);
				for (const [table, col] of [
					[roleSlots, roleSlots.meetingId],
					[meetingGuestRsvps, meetingGuestRsvps.meetingId],
				] as const) {
					expect(
						await testDb.select().from(table).where(eq(col, target.id)),
					).toHaveLength(0);
				}
			});

			it("the preview path takes no lock: classifyMeetings without lock does not wait on a held slot", async () => {
				const { target } = await seedWeek();
				let release: () => void = () => {};
				const held = new Promise<void>((r) => {
					release = r;
				});
				let written: () => void = () => {};
				const got = new Promise<void>((r) => {
					written = r;
				});
				const holder = testDb.transaction(async (tx) => {
					await tx
						.update(roleSlots)
						.set({ status: "claimed", assignedMemberId: club.memberId })
						.where(eq(roleSlots.meetingId, target.id));
					written();
					await held;
				});
				await got;
				const verdicts = await classifyMeetings([target.id]);
				expect(verdicts.get(target.id)).toBeNull();
				release();
				await holder;
			});

			it("a meeting kept only because the club default length changed is kept with its own reason", async () => {
				const { target } = await seedWeek();
				await testDb
					.update(clubs)
					.set({ defaultMeetingMinutes: 45 })
					.where(eq(clubs.id, club.clubId));
				const verdicts = await classifyMeetings([target.id]);
				expect(verdicts.get(target.id)).toBe("defaults_differ");
				await saveRecurrenceRule(club.clubId, retimed, NOW);
				const kept = (await futureScheduled(club.clubId)).find(
					(r) => r.id === target.id,
				);
				expect(kept).toBeDefined();
				expect(
					utcToZonedWallTime(kept?.scheduledAt as Date, TZ).slice(11, 16),
				).toBe("18:45");
			});

			it("a touched meeting that also differs from the defaults reads as touched", async () => {
				const { target } = await seedWeek();
				await testDb
					.update(meetings)
					.set({ theme: "Space", lengthMinutes: 12 })
					.where(eq(meetings.id, target.id));
				expect((await classifyMeetings([target.id])).get(target.id)).toBe(
					"touched",
				);
			});

			it("a save waits for a transaction that holds the rule's row lock", async () => {
				await seedWeek();
				let release: () => void = () => {};
				const held = new Promise<void>((r) => {
					release = r;
				});
				let locked: () => void = () => {};
				const gotLock = new Promise<void>((r) => {
					locked = r;
				});
				const holder = testDb.transaction(async (tx) => {
					await lockRecurrenceRule(tx, club.clubId);
					locked();
					await held;
				});
				await gotLock;
				let settled = false;
				const save = saveRecurrenceRule(club.clubId, retimed, NOW).then(() => {
					settled = true;
				});
				await new Promise((r) => setTimeout(r, 400));
				expect(settled).toBe(false);
				release();
				await holder;
				await save;
				expect(settled).toBe(true);
				expect((await getRecurrenceRule(club.clubId))?.timeOfDay).toBe("19:30");
			});
		});
	},
);
