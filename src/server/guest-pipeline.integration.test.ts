/**
 * DB-backed integration tests for the VP-Membership guest pipeline (#208 /
 * ADR-0018): guest-book capture (create-or-find + attendance), derived visits
 * (including participation — #374), edit/delete (#364), manual stage
 * transitions, and convert-to-member (Person dedup, membership create, slot
 * re-point, stage=joined, picker exclusion, activity log).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the whole suite skips when
 * that env is unset.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleSlots,
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
	applyConvertGuestToMember,
	applyDeleteGuest,
	applySetGuestStage,
	applyUpdateGuest,
	captureGuestVisit,
	loadGuestPipeline,
} = await import("#/server/guest-pipeline-logic");
const { applyAssignGuestToSlot, listClubGuests } = await import(
	"#/server/guests-logic"
);

/** Insert a second, sooner meeting so the next capture resolves against IT. */
async function seedSoonerMeeting(clubId: string, daysOut = 1): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/** Insert a meeting that has already HAPPENED (the seeded one is 7 days out). */
async function seedPastMeeting(
	clubId: string,
	daysAgo: number,
	status: "scheduled" | "cancelled" = "scheduled",
): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
			status,
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/**
 * A meeting LATER TODAY in the club's own timezone (23:59 local). The visit
 * derivation compares club-local DATES, so this counts as having happened even
 * though the wall clock hasn't reached it — the "VPM opens the minutes at 18:45
 * for a 19:00 meeting" case from #374.
 */
async function seedMeetingLaterToday(clubId: string): Promise<string> {
	const [club] = await testDb
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	const tz = club?.timezone ?? "America/Chicago";
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: sql`((date_trunc('day', now() at time zone ${tz}::text) + interval '23 hours 59 minutes') at time zone ${tz}::text)`,
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/** A drizzle transaction handle for the test client. */
type Tx = Parameters<Parameters<(typeof testDb)["transaction"]>[0]>[0];

/**
 * Run `work` in a transaction that STAYS OPEN — holding its row locks — until
 * the returned `commit()` is called. Lets a test drive a real interleaving: the
 * concurrent writer takes the lock, the code under test reads stale state and
 * then blocks on the write, and only then does the writer commit.
 */
async function openBlockingTx(
	work: (tx: Tx) => Promise<void>,
): Promise<{ commit: () => Promise<void> }> {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let ready!: () => void;
	let failed!: (e: unknown) => void;
	const started = new Promise<void>((res, rej) => {
		ready = res;
		failed = rej;
	});
	const done = testDb.transaction(async (tx) => {
		try {
			await work(tx);
		} catch (e) {
			failed(e);
			throw e;
		}
		ready();
		await gate;
	});
	// Claim the rejection now so a failure inside `work` never surfaces as an
	// unhandled rejection; `commit()` still re-throws it.
	done.catch(() => {});
	await started;
	return {
		commit: async () => {
			release();
			await done;
		},
	};
}

/** Wait until a backend on THIS database is blocked waiting for a row lock. */
async function waitForLockWait(timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await testDb.execute(sql`
			select count(*)::int as n from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'`);
		if (Number((res.rows[0] as { n: number }).n) > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting for a statement to block on a row lock");
}

/** A bare club guest — no attendance, no participation anywhere. */
async function seedGuest(clubId: string, name: string): Promise<string> {
	const [g] = await testDb
		.insert(guests)
		.values({ clubId, name })
		.returning({ id: guests.id });
	if (!g) throw new Error("Failed to seed guest");
	return g.id;
}

/** A claimed role slot on `meetingId` held by `guestId`. */
async function seedGuestRoleSlot(
	meetingId: string,
	roleDefinitionId: string,
	guestId: string,
): Promise<string> {
	const [s] = await testDb
		.insert(roleSlots)
		.values({
			meetingId,
			roleDefinitionId,
			assignedGuestId: guestId,
			status: "claimed",
		})
		.returning({ id: roleSlots.id });
	if (!s) throw new Error("Failed to seed role slot");
	return s.id;
}

async function attendanceForGuest(guestId: string) {
	return testDb
		.select({ meetingId: meetingAttendance.meetingId })
		.from(meetingAttendance)
		.where(eq(meetingAttendance.guestId, guestId));
}

async function pipelineRow(clubId: string, guestId: string) {
	const row = (await loadGuestPipeline(clubId)).find((g) => g.id === guestId);
	expect(row).toBeDefined();
	return row!;
}

describe.skipIf(!hasTestDb)("guest pipeline (#208)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("capture (guest book)", () => {
		it("creates a prospect + an attendance row against the current meeting", async () => {
			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "  Jamie Rivera  ",
				phone: "(555) 123-4567",
			});
			expect(res.created).toBe(true);
			expect(res.attendanceRecorded).toBe(true);
			expect(res.meetingId).toBe(seed.meetingId);

			const [g] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, res.guestId))
				.limit(1);
			expect(g).toMatchObject({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				stage: "prospect",
				phone: "(555) 123-4567",
			});

			const att = await attendanceForGuest(res.guestId);
			expect(att).toHaveLength(1);
			expect(att[0]!.meetingId).toBe(seed.meetingId);
		});

		it("dedups by PHONE across formats — reuses the guest, adds a new visit", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "555-123-4567",
			});
			// A sooner meeting becomes the nearest for the next visit.
			const m2 = await seedSoonerMeeting(seed.clubId);
			const second = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie R.",
				phone: "(555) 123.4567",
			});

			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);
			expect(second.meetingId).toBe(m2);

			const clubGuests = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(clubGuests).toHaveLength(1);

			const att = await attendanceForGuest(first.guestId);
			expect(att.map((a) => a.meetingId).sort()).toEqual(
				[seed.meetingId, m2].sort(),
			);
		});

		it("dedups by EMAIL when phone differs; a total mismatch creates a new guest", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "Pat@Example.com",
				phone: "555-000-1111",
			});
			const sameEmail = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "pat@example.com", // case-insensitive match
				phone: "555-999-8888", // different phone
			});
			expect(sameEmail.created).toBe(false);
			expect(sameEmail.guestId).toBe(first.guestId);

			const fresh = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Someone Else",
				email: "else@example.com",
				phone: "555-222-3333",
			});
			expect(fresh.created).toBe(true);
			expect(fresh.guestId).not.toBe(first.guestId);
		});

		it("still creates the guest when the club has no resolvable meeting", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));

			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "No Meeting Guest",
				phone: "555-444-5555",
			});
			expect(res.created).toBe(true);
			expect(res.meetingId).toBeNull();
			expect(res.attendanceRecorded).toBe(false);
			expect(await attendanceForGuest(res.guestId)).toHaveLength(0);
		});
	});

	describe("derived visits", () => {
		it("computes visitCount + firstVisitAt from attendance (no stored counter)", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});
			const m2 = await seedSoonerMeeting(seed.clubId);
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});

			// Both meetings are still ahead of us. `resolveCurrentMeetingId` falls
			// back to the UPCOMING meeting when none is scheduled today, so these
			// attendance rows are dated in the future — a plan, not a visit. They
			// must not render as "1 visit · first Aug 1" a week early (#374).
			const early = await pipelineRow(seed.clubId, first.guestId);
			expect(early.visitCount).toBe(0);
			expect(early.firstVisitAt).toBeNull();

			// Once those meeting DATES have passed, the very same attendance rows
			// count — nothing was rewritten, the derivation just re-reads the dates.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) })
				.where(eq(meetings.id, seed.meetingId));
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
				.where(eq(meetings.id, m2));

			const pipeline = await loadGuestPipeline(seed.clubId);
			const row = pipeline.find((g) => g.id === first.guestId);
			expect(row).toBeDefined();
			expect(row!.visitCount).toBe(2);
			expect(row!.firstVisitAt).toBeInstanceOf(Date);

			// A guest with no attendance derives zero visits / null first-visit.
			const [orphan] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Never Attended" })
				.returning({ id: guests.id });
			const pipeline2 = await loadGuestPipeline(seed.clubId);
			const orphanRow = pipeline2.find((g) => g.id === orphan!.id);
			expect(orphanRow!.visitCount).toBe(0);
			expect(orphanRow!.firstVisitAt).toBeNull();
		});
	});

	// #374: taking part IS visiting. The derivation reads role_slots and
	// table_topics_speakers alongside attendance — and still writes nothing (the
	// "holding a slot never sets attendance" rule of #218 is untouched).
	describe("participation counts as a visit (#374)", () => {
		it("counts a guest who only HELD A ROLE at a meeting that has happened", async () => {
			const past = await seedPastMeeting(seed.clubId, 7);
			const guestId = await seedGuest(seed.clubId, "Role Only");
			await seedGuestRoleSlot(past, seed.roleDefinitionId, guestId);

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
			expect(row.firstVisitAt).toBeInstanceOf(Date);
			// Derived, never stored: no attendance row was written for them (#218).
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
		});

		it("counts a guest who only SPOKE AT TABLE TOPICS at a meeting that has happened", async () => {
			const past = await seedPastMeeting(seed.clubId, 5);
			const guestId = await seedGuest(seed.clubId, "Topics Only");
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
			expect(row.firstVisitAt).toBeInstanceOf(Date);
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
		});

		it("does NOT count a FUTURE meeting (penciled in ≠ visited), nor a cancelled one", async () => {
			const guestId = await seedGuest(seed.clubId, "Penciled In");
			// The seeded meeting is 7 days out — a future role and a future Table
			// Topics slot are plans, not visits.
			await seedGuestRoleSlot(seed.meetingId, seed.roleDefinitionId, guestId);
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: seed.meetingId, guestId });
			// A cancelled past meeting never happened either.
			const cancelled = await seedPastMeeting(seed.clubId, 14, "cancelled");
			await seedGuestRoleSlot(cancelled, seed.roleDefinitionId, guestId);

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(0);
			expect(row.firstVisitAt).toBeNull();
		});

		it("does NOT count an ATTENDANCE row on a future meeting, nor on a cancelled one", async () => {
			const guestId = await seedGuest(seed.clubId, "Booked Ahead");
			// The guest book resolves the UPCOMING meeting when none is today, so a
			// walk-up today writes attendance against next week's meeting. Same rule
			// as a penciled-in role: it's a visit on the day, not before it.
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: seed.meetingId, guestId, status: "present" });
			const cancelled = await seedPastMeeting(seed.clubId, 10, "cancelled");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: cancelled, guestId, status: "present" });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(0);
			expect(row.firstVisitAt).toBeNull();
		});

		it("counts a meeting scheduled LATER TODAY in the club's timezone", async () => {
			// #374 verbatim: the VPM opens VP Membership at 18:45 to set up the
			// minutes for a 19:00 meeting. The guest holding Timer is a visitor —
			// the compare is on the club-local DATE, not the wall clock.
			const tonight = await seedMeetingLaterToday(seed.clubId);

			const timerId = await seedGuest(seed.clubId, "Tonight Timer");
			await seedGuestRoleSlot(tonight, seed.roleDefinitionId, timerId);
			const timer = await pipelineRow(seed.clubId, timerId);
			expect(timer.visitCount).toBe(1);
			expect(timer.firstVisitAt).toBeInstanceOf(Date);

			const topicsId = await seedGuest(seed.clubId, "Tonight Topics");
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: tonight, guestId: topicsId });
			expect((await pipelineRow(seed.clubId, topicsId)).visitCount).toBe(1);

			// The guest-book scan at the door still counts the moment it lands.
			const bookId = await seedGuest(seed.clubId, "Tonight Walk-Up");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: tonight, guestId: bookId, status: "present" });
			expect((await pipelineRow(seed.clubId, bookId)).visitCount).toBe(1);
		});

		it("counts a meeting ONCE when the guest has attendance AND a role slot on it", async () => {
			const past = await seedPastMeeting(seed.clubId, 3);
			const guestId = await seedGuest(seed.clubId, "Both Sources");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: past, guestId, status: "present" });
			await seedGuestRoleSlot(past, seed.roleDefinitionId, guestId);
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
		});

		it("derives firstVisitAt as the EARLIEST qualifying meeting across sources", async () => {
			const older = await seedPastMeeting(seed.clubId, 30);
			const newer = await seedPastMeeting(seed.clubId, 2);
			const guestId = await seedGuest(seed.clubId, "Two Visits");
			await seedGuestRoleSlot(older, seed.roleDefinitionId, guestId);
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: newer, guestId, status: "present" });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(2);
			const [oldMeeting] = await testDb
				.select({ scheduledAt: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.id, older));
			expect(row.firstVisitAt?.getTime()).toBe(
				oldMeeting!.scheduledAt.getTime(),
			);
		});
	});

	// #364: a typo'd guest was permanent — there was no update or delete path.
	describe("edit + delete (#364)", () => {
		it("updates a guest's name/email/phone, normalizing the phone to E.164 (#295)", async () => {
			const guestId = await seedGuest(seed.clubId, "Tpyo Nmae");

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "  Typo Fixed  ",
				email: "  fixed@example.com  ",
				phone: "+1 (555) 010-2030",
			});

			const [g] = await testDb
				.select({ name: guests.name, email: guests.email, phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toMatchObject({
				name: "Typo Fixed",
				email: "fixed@example.com",
				phone: "+15550102030",
			});
		});

		it("clears contact when the edit sends empty values", async () => {
			const guestId = await seedGuest(seed.clubId, "Has Contact");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Has Contact",
				email: "drop@example.com",
				phone: "+15550001111",
			});
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Has Contact",
				email: null,
				phone: null,
			});
			const [g] = await testDb
				.select({ email: guests.email, phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toMatchObject({ email: null, phone: null });
		});

		it("rejects an empty name, and a guest outside the caller's club", async () => {
			const guestId = await seedGuest(seed.clubId, "Real Guest");
			await expect(
				applyUpdateGuest({ clubId: seed.clubId, guestId, name: "   " }),
			).rejects.toThrow(/name is required/i);
			await expect(
				applyUpdateGuest({ clubId: randomUUID(), guestId, name: "Nope" }),
			).rejects.toThrow(/not found/i);
		});

		it("deletes a guest, resets the slots they held to Open, and drops their minutes rows", async () => {
			const guestId = await seedGuest(seed.clubId, "Delete Me");
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: null,
			});
			const past = await seedPastMeeting(seed.clubId, 4);
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: past, guestId, status: "present" });
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			// The pipeline surfaces the held-slot count so the UI can warn first.
			expect((await pipelineRow(seed.clubId, guestId)).heldSlotCount).toBe(1);

			const res = await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.slotsReopened).toBe(1);

			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);

			// The slot is genuinely Open again — never "claimed" by nobody.
			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedGuestId: roleSlots.assignedGuestId,
					assignedMemberId: roleSlots.assignedMemberId,
					claimedAt: roleSlots.claimedAt,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot).toMatchObject({
				status: "open",
				assignedGuestId: null,
				assignedMemberId: null,
				claimedAt: null,
			});

			// Minutes rows cascade with the guest — nothing dangles.
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
			expect(
				await testDb
					.select()
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.guestId, guestId)),
			).toHaveLength(0);

			// Each reopened slot is logged as a release (mirrors applyMemberRemove).
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				);
			expect(log).toHaveLength(1);
		});

		it("BLOCKS deleting a guest who has been converted to a member", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Now A Member",
				phone: "555-606-7070",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});

			await expect(
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/member/i);
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(1);
		});

		it("rejects deleting a guest outside the caller's club", async () => {
			const guestId = await seedGuest(seed.clubId, "Other Club Guest");
			await expect(
				applyDeleteGuest({
					clubId: randomUUID(),
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/not found/i);
		});

		it("rejects an edit that would collide with another guest's phone or email", async () => {
			// `captureGuestVisit` dedups on phone→email, so two club guests sharing
			// either one make the next guest-book submission ambiguous — it would
			// split the returning visitor's history across both rows.
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie",
				phone: "+15551234567",
				email: "jamie@example.com",
			});
			const otherId = await seedGuest(seed.clubId, "Jamie Rivera");

			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					phone: "+1 (555) 123-4567", // same digits, different formatting
				}),
			).rejects.toThrow(/already/i);
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					email: "JAMIE@example.com", // case-insensitive collision
				}),
			).rejects.toThrow(/already/i);

			// The row is untouched, and editing a guest's OWN contact still works.
			const [g] = await testDb
				.select({ phone: guests.phone, email: guests.email })
				.from(guests)
				.where(eq(guests.id, otherId));
			expect(g).toMatchObject({ phone: null, email: null });
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					phone: "+15559998888",
				}),
			).resolves.toMatchObject({ ok: true });
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie R.",
					phone: "555-999-8888", // its own number — not a collision
				}),
			).resolves.toMatchObject({ ok: true });
		});

		// The delete is a read-then-write over role_slots, and `reassignSlot` /
		// `claimSlot` are PUBLIC, no-session server fns — so a visitor can land on
		// the same slot mid-delete. The conditional UPDATE is the race guard
		// (same standard as `removeOpenRoleSlots` / `reassignSlotCore`).
		it("leaves a slot alone when it is reassigned to a member mid-delete", async () => {
			const guestId = await seedGuest(seed.clubId, "Racy Guest");
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: null,
			});

			// A public reassign takes the slot for a member, uncommitted.
			const writer = await openBlockingTx(async (tx) => {
				await tx
					.update(roleSlots)
					.set({
						assignedMemberId: seed.memberId,
						assignedGuestId: null,
						status: "claimed",
						claimedAt: new Date(),
					})
					.where(eq(roleSlots.id, seed.slotId));
			});

			// The delete reads the slot as still guest-held, then blocks on the
			// writer's row lock; the writer commits into that gap.
			const pending = applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			pending.catch(() => {});
			try {
				await waitForLockWait();
			} finally {
				await writer.commit();
			}
			const res = await pending;

			// Nothing was reopened — the slot no longer matched "held by this guest".
			expect(res.slotsReopened).toBe(0);
			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedGuestId: roleSlots.assignedGuestId,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			// Never "open" while still showing the member's name — that state lets
			// anyone silently claim the slot out from under them.
			expect(slot).toMatchObject({
				status: "claimed",
				assignedGuestId: null,
				assignedMemberId: seed.memberId,
			});

			// And no `release` entry blaming the deleted guest for a slot they lost.
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				);
			expect(log).toHaveLength(0);

			// The guest itself is still deleted — that part was never in doubt.
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);
		});

		it("loses to a convert-to-member that commits mid-delete", async () => {
			const guestId = await seedGuest(seed.clubId, "Converting Now");

			// Tab B converts the guest while tab A's delete is in flight.
			const writer = await openBlockingTx(async (tx) => {
				await tx
					.update(guests)
					.set({ stage: "joined" })
					.where(eq(guests.id, guestId));
			});

			const pending = applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			pending.catch(() => {});
			try {
				await waitForLockWait();
			} finally {
				await writer.commit();
			}

			// "A converted guest is NEVER deleted" must hold across the interleaving.
			await expect(pending).rejects.toThrow(/member/i);
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(1);
		});
	});

	describe("manual stage transitions", () => {
		it("moves a guest between prospect/following_up/lost", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Stage Mover",
				phone: "555-321-0000",
			});
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const [g] = await testDb
				.select({ stage: guests.stage })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("following_up");
		});

		it("rejects a stage change on a converted (joined) guest", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Joined Already",
				phone: "555-111-0000",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applySetGuestStage({ clubId: seed.clubId, guestId, stage: "lost" }),
			).rejects.toThrow(/already joined/i);
		});
	});

	describe("convert to member", () => {
		it("creates a membership, re-points slots, joins the guest, and logs it", async () => {
			// A guest holding a role slot.
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Convert Me",
				email: "convert@example.com",
				phone: "555-246-8100",
			});
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Membership created for this club, member role, joinedAt stamped.
			const [m] = await testDb
				.select()
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m).toMatchObject({
				clubId: seed.clubId,
				name: "Convert Me",
				clubRole: "member",
				status: "active",
			});
			expect(m!.joinedAt).toBeInstanceOf(Date);
			expect(m!.personId).toBe(res.personId);

			// Slot re-pointed guest → member (XOR holds).
			const [slot] = await testDb
				.select({
					assignedMemberId: roleSlots.assignedMemberId,
					assignedGuestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot!.assignedMemberId).toBe(res.membershipId);
			expect(slot!.assignedGuestId).toBeNull();

			// Guest persists at joined with the membership pointer.
			const [g] = await testDb
				.select({
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("joined");
			expect(g!.convertedMembershipId).toBe(res.membershipId);

			// Excluded from the assign picker, still visible in the pipeline.
			const picker = await listClubGuests(seed.clubId);
			expect(picker.map((p) => p.id)).not.toContain(guestId);
			const pipeline = await loadGuestPipeline(seed.clubId);
			expect(pipeline.find((p) => p.id === guestId)?.stage).toBe("joined");

			// Activity log entry.
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, res.membershipId),
					),
				);
			expect(log).toHaveLength(1);
			expect(log[0]!.action).toBe("member_add");
			expect((log[0]!.detail as { fromGuestId?: string }).fromGuestId).toBe(
				guestId,
			);
		});

		it("links an existing Person by phone rather than creating a duplicate", async () => {
			const [existingPerson] = await testDb
				.insert(people)
				.values({ name: "Existing Human", phone: "5559990000" })
				.returning({ id: people.id });

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Existing Human",
				phone: "(555) 999-0000", // same digits, different format
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			expect(res.personId).toBe(existingPerson!.id);
		});

		it("is idempotent-safe: converting an already-joined guest throws", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Once Only",
				phone: "555-808-8080",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			await expect(
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/already been converted/i);
		});
	});
});
