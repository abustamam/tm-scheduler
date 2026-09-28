/**
 * DB-backed tests for anonymous role feedback, part 1 (#984): the public
 * targets read, the anonymous capped write, and the recipient's read.
 *
 * Every refusal case first proves the SAME write succeeds against a fixture
 * that differs only in the property under test, where that is cheap — a throw
 * alone proves nothing, because a broken fixture throws too.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetings,
	members,
	roleDefinitions,
	roleFeedbackNotes,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	leaveFeedbackLogic,
	loadFeedbackTargetsPublic,
	loadFeedbackForUser,
	FEEDBACK_CANCELLED_MESSAGE,
	FEEDBACK_CLOSED_MESSAGE,
	FEEDBACK_EMPTY_MESSAGE,
	FEEDBACK_MEETING_CAP_MESSAGE,
	FEEDBACK_NOT_OPEN_MESSAGE,
	FEEDBACK_RECIPIENT_CAP_MESSAGE,
	FEEDBACK_TARGET_MESSAGE,
	FEEDBACK_TOO_LONG_MESSAGE,
	FEEDBACK_BAD_TEXT_MESSAGE,
	FEEDBACK_GENERIC_ERROR_MESSAGE,
	FEEDBACK_RATE_LIMIT_MESSAGE,
	publicFeedbackError,
} = await import("#/server/role-feedback-logic");
const { lockClubForWrite } = await import("#/server/club-write-lock");
const { FEEDBACK_IP_LIMIT } = await import("#/server/feedback-rate-limit");
const { FEEDBACK_PER_MEETING_CAP, FEEDBACK_PER_RECIPIENT_CAP } = await import(
	"#/lib/feedback-window"
);
const { loadMeetingSlots } = await import("#/server/meeting-slots-logic");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const seededClubs: SeededClub[] = [];
afterEach(async () => {
	// Reverse order: a later club's member may belong to an earlier club's
	// person, and `cleanup` deletes the people its members belong to.
	for (const s of seededClubs.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

/** A seeded club whose meeting started 10 minutes ago (90 min long), with the
 *  Timer slot held by the seeded member. */
async function liveMeeting(): Promise<SeededClub> {
	const s = await seedClub();
	seededClubs.push(s);
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - 10 * MIN), lengthMinutes: 90 })
		.where(eq(meetings.id, s.meetingId));
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: s.memberId, status: "claimed" })
		.where(eq(roleSlots.id, s.slotId));
	return s;
}

const timerNote = (s: SeededClub, text = "Clear signals") => ({
	meetingId: s.meetingId,
	target: { kind: "slot" as const, id: s.slotId },
	wentWell: text,
});

const notesFor = (meetingId: string) =>
	testDb
		.select()
		.from(roleFeedbackNotes)
		.where(eq(roleFeedbackNotes.meetingId, meetingId));

async function addMember(
	clubId: string,
	name: string,
	personId?: string,
): Promise<string> {
	const pid = personId ?? (await seedPerson({ name }));
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: pid,
			name,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("leaveFeedbackLogic (#984)", () => {
	it("stores a note whose recipient and label come from the server, with no writer column", async () => {
		const s = await liveMeeting();
		const res = await leaveFeedbackLogic({
			...timerNote(s),
			tryNext: "  Hold the red card higher  ",
		});
		// Nothing but ok — not even the row id.
		expect(res).toEqual({ ok: true });

		const [note] = await notesFor(s.meetingId);
		expect(note).toMatchObject({
			clubId: s.clubId,
			recipientMemberId: s.memberId,
			roleSlotId: s.slotId,
			tableTopicsSpeakerId: null,
			roleLabel: "Timer",
			wentWell: "Clear signals",
			tryNext: "Hold the red card higher",
			seenAt: null,
		});

		// Anonymity is structural: the table has exactly these columns, and
		// none of them names a writer.
		const cols = await testDb.execute<{ column_name: string }>(
			sql`select column_name from information_schema.columns where table_name = 'role_feedback_notes' order by column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			"club_id",
			"created_at",
			"id",
			"meeting_id",
			"recipient_member_id",
			"role_label",
			"role_slot_id",
			"seen_at",
			"table_topics_speaker_id",
			"try_next",
			"went_well",
		]);
	});

	it("a Table Topics speaker's note is labelled and linked server-side", async () => {
		const s = await liveMeeting();
		const [tt] = await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: s.meetingId, memberId: s.adminMemberId })
			.returning({ id: tableTopicsSpeakers.id });
		await leaveFeedbackLogic({
			meetingId: s.meetingId,
			target: { kind: "tableTopics", id: tt?.id as string },
			tryNext: "Pause before the close",
		});
		const [note] = await notesFor(s.meetingId);
		expect(note).toMatchObject({
			recipientMemberId: s.adminMemberId,
			roleSlotId: null,
			tableTopicsSpeakerId: tt?.id,
			roleLabel: "Table Topics speaker",
		});
	});

	it("refuses a cancelled meeting", async () => {
		const s = await liveMeeting();
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		await expect(leaveFeedbackLogic(timerNote(s))).rejects.toThrow(
			FEEDBACK_CANCELLED_MESSAGE,
		);
		expect(await notesFor(s.meetingId)).toHaveLength(0);
	});

	it("refuses an archived club, and writes nothing", async () => {
		const s = await liveMeeting();
		await leaveFeedbackLogic(timerNote(s));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		await expect(leaveFeedbackLogic(timerNote(s))).rejects.toThrow(
			CLUB_ARCHIVED_MESSAGE,
		);
		expect(await notesFor(s.meetingId)).toHaveLength(1);
	});

	it("refuses before the start and at the close, on the server's clock", async () => {
		const s = await liveMeeting();
		const [m] = await testDb
			.select({ at: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, s.meetingId));
		const start = (m?.at as Date).getTime();
		const close = start + 90 * MIN + 3 * DAY;

		await expect(
			leaveFeedbackLogic(timerNote(s), () => new Date(start - 1)),
		).rejects.toThrow(FEEDBACK_NOT_OPEN_MESSAGE);
		await expect(
			leaveFeedbackLogic(timerNote(s), () => new Date(close)),
		).rejects.toThrow(FEEDBACK_CLOSED_MESSAGE);
		expect(await notesFor(s.meetingId)).toHaveLength(0);

		// The two edges just inside the window both succeed.
		await leaveFeedbackLogic(timerNote(s), () => new Date(start));
		await leaveFeedbackLogic(timerNote(s), () => new Date(close - 1));
		expect(await notesFor(s.meetingId)).toHaveLength(2);
	});

	it("refuses a guest-held slot", async () => {
		const s = await liveMeeting();
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: s.clubId, name: "Visiting Val" })
			.returning({ id: guests.id });
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, assignedGuestId: g?.id })
			.where(eq(roleSlots.id, s.slotId));
		await expect(leaveFeedbackLogic(timerNote(s))).rejects.toThrow(
			FEEDBACK_TARGET_MESSAGE,
		);
	});

	it("refuses an open slot and a guest Table Topics speaker", async () => {
		const s = await liveMeeting();
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: null, status: "open" })
			.where(eq(roleSlots.id, s.slotId));
		await expect(leaveFeedbackLogic(timerNote(s))).rejects.toThrow(
			FEEDBACK_TARGET_MESSAGE,
		);
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: s.clubId, name: "Visiting Val" })
			.returning({ id: guests.id });
		const [tt] = await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: s.meetingId, guestId: g?.id })
			.returning({ id: tableTopicsSpeakers.id });
		await expect(
			leaveFeedbackLogic({
				meetingId: s.meetingId,
				target: { kind: "tableTopics", id: tt?.id as string },
				wentWell: "Nice",
			}),
		).rejects.toThrow(FEEDBACK_TARGET_MESSAGE);
	});

	it("refuses a slot from another meeting, even the same club's", async () => {
		const s = await liveMeeting();
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: s.clubId,
				scheduledAt: new Date(Date.now() - 20 * MIN),
			})
			.returning({ id: meetings.id });
		await expect(
			leaveFeedbackLogic({ ...timerNote(s), meetingId: other?.id as string }),
		).rejects.toThrow(FEEDBACK_TARGET_MESSAGE);
		// And the kind must match: a slot id is not a Table Topics speaker.
		await expect(
			leaveFeedbackLogic({
				...timerNote(s),
				target: { kind: "tableTopics", id: s.slotId },
			}),
		).rejects.toThrow(FEEDBACK_TARGET_MESSAGE);
		expect(await notesFor(s.meetingId)).toHaveLength(0);
	});

	it("refuses both boxes empty (whitespace counts as empty) and either box over 500", async () => {
		const s = await liveMeeting();
		await expect(
			leaveFeedbackLogic({ ...timerNote(s), wentWell: "   ", tryNext: "" }),
		).rejects.toThrow(FEEDBACK_EMPTY_MESSAGE);
		await expect(
			leaveFeedbackLogic({ ...timerNote(s), wentWell: "x".repeat(501) }),
		).rejects.toThrow(FEEDBACK_TOO_LONG_MESSAGE);
		await expect(
			leaveFeedbackLogic({ ...timerNote(s), tryNext: "y".repeat(501) }),
		).rejects.toThrow(FEEDBACK_TOO_LONG_MESSAGE);
		expect(await notesFor(s.meetingId)).toHaveLength(0);
		// Exactly 500 after trimming is fine.
		await leaveFeedbackLogic({
			...timerNote(s),
			wentWell: ` ${"x".repeat(500)} `,
		});
		expect(await notesFor(s.meetingId)).toHaveLength(1);
	});

	it("caps one recipient at 20 notes per meeting, under concurrency", async () => {
		const s = await liveMeeting();
		const results = await Promise.allSettled(
			Array.from({ length: 25 }, (_, i) =>
				leaveFeedbackLogic(timerNote(s, `note ${i}`)),
			),
		);
		const ok = results.filter((r) => r.status === "fulfilled");
		const refused = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		expect(ok).toHaveLength(20);
		expect(refused).toHaveLength(5);
		for (const r of refused) {
			expect(String(r.reason)).toContain(FEEDBACK_RECIPIENT_CAP_MESSAGE);
		}
		expect(await notesFor(s.meetingId)).toHaveLength(20);
	});

	it("caps a meeting at 300 notes, under concurrency", async () => {
		const s = await liveMeeting();
		// 295 already there, all for the admin — seeded directly, below the
		// recipient cap's reach, so only the meeting cap can refuse.
		await testDb.insert(roleFeedbackNotes).values(
			Array.from({ length: 295 }, () => ({
				clubId: s.clubId,
				meetingId: s.meetingId,
				recipientMemberId: s.adminMemberId,
				roleLabel: "Toastmaster",
				wentWell: "seed",
			})),
		);
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) =>
				leaveFeedbackLogic(timerNote(s, `note ${i}`)),
			),
		);
		const refused = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		expect(results.length - refused.length).toBe(5);
		for (const r of refused) {
			expect(String(r.reason)).toContain(FEEDBACK_MEETING_CAP_MESSAGE);
		}
		expect(await notesFor(s.meetingId)).toHaveLength(300);
	});
});

describe.skipIf(!hasTestDb)("loadFeedbackTargetsPublic (#984)", () => {
	it("lists member-held slots with slotLabel numbering over ALL slots, plus member Table Topics speakers", async () => {
		const s = await liveMeeting();
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: s.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				sortOrder: 5,
			})
			.returning({ id: roleDefinitions.id });
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: s.clubId, name: "Visiting Val" })
			.returning({ id: guests.id });
		const sam = await addMember(s.clubId, "Sam Speaker");
		// Speaker 1 is a guest, Speaker 2 a member, Speaker 3 open.
		await testDb.insert(roleSlots).values([
			{
				meetingId: s.meetingId,
				roleDefinitionId: speaker?.id as string,
				slotIndex: 0,
				assignedGuestId: g?.id,
				status: "claimed",
			},
			{
				meetingId: s.meetingId,
				roleDefinitionId: speaker?.id as string,
				slotIndex: 1,
				assignedMemberId: sam,
				status: "claimed",
			},
			{
				meetingId: s.meetingId,
				roleDefinitionId: speaker?.id as string,
				slotIndex: 2,
			},
		]);
		await testDb.insert(tableTopicsSpeakers).values([
			{ meetingId: s.meetingId, memberId: s.adminMemberId, sortOrder: 0 },
			{ meetingId: s.meetingId, guestId: g?.id, sortOrder: 1 },
		]);

		const res = await loadFeedbackTargetsPublic(s.clubId, s.meetingId);
		expect(res?.window.canWrite).toBe(true);
		expect(
			res?.targets.map((t) => [t.kind, t.memberName, t.roleLabel]),
		).toEqual([
			["slot", "Member User", "Timer"],
			["slot", "Sam Speaker", "Speaker 2"],
			["tableTopics", "Admin User", "Table Topics speaker"],
		]);
		// Nothing but display name and role label (and the target's own id).
		for (const t of res?.targets ?? []) {
			expect(Object.keys(t).sort()).toEqual([
				"id",
				"kind",
				"memberName",
				"roleLabel",
			]);
		}

		// Parity with the meeting page's own loader: the label a writer taps is
		// the label the agenda shows for that slot.
		const slots = await loadMeetingSlots(s.meetingId);
		const counts = buildRoleCounts(slots);
		for (const t of res?.targets.filter((x) => x.kind === "slot") ?? []) {
			const slot = slots.find((x) => x.id === t.id);
			expect(slot && slotLabel(slot, counts)).toBe(t.roleLabel);
		}
	});

	it("returns null for an archived club, a cancelled meeting and an unknown key", async () => {
		const s = await liveMeeting();
		expect(
			await loadFeedbackTargetsPublic(s.clubId, s.meetingId),
		).not.toBeNull();
		expect(await loadFeedbackTargetsPublic(s.clubId, randomUUID())).toBeNull();

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, s.meetingId));
		expect(await loadFeedbackTargetsPublic(s.clubId, s.meetingId)).toBeNull();

		await testDb
			.update(meetings)
			.set({ status: "scheduled" })
			.where(eq(meetings.id, s.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		expect(await loadFeedbackTargetsPublic(s.clubId, s.meetingId)).toBeNull();
	});

	it("reports the window's state, closed and not yet open", async () => {
		const s = await liveMeeting();
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() + DAY) })
			.where(eq(meetings.id, s.meetingId));
		const early = await loadFeedbackTargetsPublic(s.clubId, s.meetingId);
		expect(early?.window.canWrite).toBe(false);
		const late = await loadFeedbackTargetsPublic(
			s.clubId,
			s.meetingId,
			new Date(Date.now() + 10 * DAY),
		);
		expect(late?.window.canWrite).toBe(false);
		expect(late?.window.recipientsCanRead).toBe(true);
	});
});

describe.skipIf(!hasTestDb)("loadFeedbackForUser (#984)", () => {
	const later = () => new Date(Date.now() + 2 * 60 * MIN);

	it("returns only the caller's notes, once the meeting has ended", async () => {
		const s = await liveMeeting();
		// The admin holds a second role, so two members have notes here.
		const [tt] = await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: s.meetingId, memberId: s.adminMemberId })
			.returning({ id: tableTopicsSpeakers.id });
		await leaveFeedbackLogic(timerNote(s, "for the member"));
		await leaveFeedbackLogic({
			meetingId: s.meetingId,
			target: { kind: "tableTopics", id: tt?.id as string },
			wentWell: "for the admin",
		});

		// Mid-meeting: the recipient cannot read yet.
		expect(await loadFeedbackForUser(s.memberUserId)).toEqual({
			meetings: [],
			unseenCount: 0,
		});

		const mine = await loadFeedbackForUser(s.memberUserId, {}, later());
		expect(mine.unseenCount).toBe(1);
		expect(mine.meetings).toHaveLength(1);
		expect(mine.meetings[0]).toMatchObject({
			meetingId: s.meetingId,
			clubName: "Test Club",
			roles: [
				{
					roleLabel: "Timer",
					notes: [{ wentWell: "for the member", tryNext: null, seen: false }],
				},
			],
		});
		const theirs = await loadFeedbackForUser(s.adminUserId, {}, later());
		expect(
			theirs.meetings.flatMap((m) =>
				m.roles.flatMap((r) => r.notes.map((n) => n.wentWell)),
			),
		).toEqual(["for the admin"]);
	});

	it("spans every membership of one person, archived clubs included", async () => {
		const a = await liveMeeting();
		const b = await liveMeeting();
		// The member of club A is also a member of club B (the same person),
		// holding club B's Timer slot.
		const alsoInB = await addMember(b.clubId, "Member User", a.personId);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: alsoInB })
			.where(eq(roleSlots.id, b.slotId));
		await leaveFeedbackLogic(timerNote(a, "from A"));
		await leaveFeedbackLogic(timerNote(b, "from B"));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date(), name: "Archived Club" })
			.where(eq(clubs.id, b.clubId));

		const res = await loadFeedbackForUser(a.memberUserId, {}, later());
		expect(res.unseenCount).toBe(2);
		expect(res.meetings.map((m) => m.clubName).sort()).toEqual([
			"Archived Club",
			"Test Club",
		]);

		// And the meeting filter narrows to one.
		const one = await loadFeedbackForUser(
			a.memberUserId,
			{ meetingId: a.meetingId },
			later(),
		);
		expect(one.meetings.map((m) => m.meetingId)).toEqual([a.meetingId]);
	});

	it("orders newest meeting first and counts only unseen notes", async () => {
		const s = await liveMeeting();
		const [older] = await testDb
			.insert(meetings)
			.values({
				clubId: s.clubId,
				scheduledAt: new Date(Date.now() - 3 * DAY),
			})
			.returning({ id: meetings.id });
		await testDb.insert(roleFeedbackNotes).values({
			clubId: s.clubId,
			meetingId: older?.id as string,
			recipientMemberId: s.memberId,
			roleLabel: "Grammarian",
			wentWell: "old one",
			seenAt: new Date(),
		});
		await leaveFeedbackLogic(timerNote(s, "new one"));
		const res = await loadFeedbackForUser(s.memberUserId, {}, later());
		expect(res.meetings.map((m) => m.meetingId)).toEqual([
			s.meetingId,
			older?.id,
		]);
		expect(res.unseenCount).toBe(1);
		const seen = await testDb
			.select({ n: sql<number>`count(*)::int` })
			.from(roleFeedbackNotes)
			.where(
				and(
					eq(roleFeedbackNotes.recipientMemberId, s.memberId),
					sql`${roleFeedbackNotes.seenAt} is not null`,
				),
			);
		expect(seen[0]?.n).toBe(1);
	});
});

const UUID_ANYWHERE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("publicFeedbackError (#984 review)", () => {
	it("passes the app's own refusals through unchanged", () => {
		const err = new Error(FEEDBACK_RECIPIENT_CAP_MESSAGE);
		expect(publicFeedbackError(err)).toBe(err);
	});

	it("turns anything else, e.g. a driver error naming the insert, into the generic message", () => {
		const raw = new Error(
			'Failed query: insert into "role_feedback_notes" … params: 11111111-2222-4333-8444-555555555555,…',
		);
		const out = publicFeedbackError(raw);
		expect(out.message).toBe(FEEDBACK_GENERIC_ERROR_MESSAGE);
		expect(out.message).not.toMatch(UUID_ANYWHERE);
		expect(publicFeedbackError("a string").message).toBe(
			FEEDBACK_GENERIC_ERROR_MESSAGE,
		);
	});
});

describe.skipIf(!hasTestDb)(
	"leaveFeedbackLogic — review hardening (#984)",
	() => {
		it("refuses a NUL with its own message, and the error names no id", async () => {
			const s = await liveMeeting();
			const err = await leaveFeedbackLogic({
				...timerNote(s),
				wentWell: "good\u0000job",
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe(FEEDBACK_BAD_TEXT_MESSAGE);
			expect(String(err)).not.toMatch(UUID_ANYWHERE);
			expect(await notesFor(s.meetingId)).toHaveLength(0);
		});

		/**
		 * Hold the club write lock in another transaction, then send. A refusal the
		 * pre-check can make must come back at once with its OWN message; without
		 * the pre-check it would queue behind the lock for its 5s timeout and come
		 * back as "busy".
		 */
		async function whileLockHeld(clubId: string, send: () => Promise<unknown>) {
			const holder = await openBlockingTx(async (tx) => {
				await lockClubForWrite(tx, clubId);
			});
			try {
				const started = Date.now();
				const err = await send().catch((e: unknown) => e);
				return { err, ms: Date.now() - started };
			} finally {
				await holder.commit();
			}
		}

		it("refuses a closed window without waiting on the club lock", async () => {
			const s = await liveMeeting();
			const { err, ms } = await whileLockHeld(s.clubId, () =>
				leaveFeedbackLogic(timerNote(s), () => new Date(Date.now() + 10 * DAY)),
			);
			expect((err as Error).message).toBe(FEEDBACK_CLOSED_MESSAGE);
			expect(ms).toBeLessThan(2000);
		});

		it("refuses a full recipient cap without waiting on the club lock", async () => {
			const s = await liveMeeting();
			await testDb.insert(roleFeedbackNotes).values(
				Array.from({ length: 20 }, () => ({
					clubId: s.clubId,
					meetingId: s.meetingId,
					recipientMemberId: s.memberId,
					roleLabel: "Timer",
					wentWell: "seed",
				})),
			);
			const { err, ms } = await whileLockHeld(s.clubId, () =>
				leaveFeedbackLogic(timerNote(s)),
			);
			expect((err as Error).message).toBe(FEEDBACK_RECIPIENT_CAP_MESSAGE);
			expect(ms).toBeLessThan(2000);
		});

		it("limits one address to FEEDBACK_IP_LIMIT notes a minute; the next is refused, another address is not", async () => {
			const s = await liveMeeting();
			// Enough recipients that the per-recipient cap never fires first, and
			// a limit the per-meeting cap cannot mask — both derived, no counts.
			const sends = FEEDBACK_IP_LIMIT + 2;
			expect(sends).toBeLessThanOrEqual(FEEDBACK_PER_MEETING_CAP);
			const recipients = Math.ceil(sends / FEEDBACK_PER_RECIPIENT_CAP);
			const speakers: string[] = [];
			for (let r = 0; r < recipients; r++) {
				const memberId = await addMember(s.clubId, `Speaker ${r}`);
				const [tt] = await testDb
					.insert(tableTopicsSpeakers)
					.values({ meetingId: s.meetingId, memberId, sortOrder: r })
					.returning({ id: tableTopicsSpeakers.id });
				speakers.push(tt?.id as string);
			}
			const note = (i: number) => ({
				meetingId: s.meetingId,
				target: {
					kind: "tableTopics" as const,
					id: speakers[i % speakers.length] as string,
				},
				wentWell: `n${i}`,
			});

			const ip = `198.51.100.1-${randomUUID()}`;
			for (let i = 0; i < FEEDBACK_IP_LIMIT; i++) {
				await leaveFeedbackLogic(note(i), undefined, ip);
			}
			await expect(
				leaveFeedbackLogic(note(FEEDBACK_IP_LIMIT), undefined, ip),
			).rejects.toThrow(FEEDBACK_RATE_LIMIT_MESSAGE);
			await leaveFeedbackLogic(
				note(FEEDBACK_IP_LIMIT + 1),
				undefined,
				`other-${randomUUID()}`,
			);
			expect(await notesFor(s.meetingId)).toHaveLength(FEEDBACK_IP_LIMIT + 1);
		});

		it("does not count an attempt the pre-check refused against the address", async () => {
			const s = await liveMeeting();
			const ip = `refused-${randomUUID()}`;
			for (let i = 0; i < FEEDBACK_IP_LIMIT + 3; i++) {
				await leaveFeedbackLogic(
					timerNote(s),
					() => new Date(Date.now() + 10 * DAY),
					ip,
				).catch(() => {});
			}
			await leaveFeedbackLogic(timerNote(s), undefined, ip);
			expect(await notesFor(s.meetingId)).toHaveLength(1);
		});

		it("stores created_at at DAY granularity, so a note's time cannot place its writer", async () => {
			const s = await liveMeeting();
			await leaveFeedbackLogic(timerNote(s));
			const [note] = await notesFor(s.meetingId);
			const at = note?.createdAt as Date;
			expect(at.getUTCHours()).toBe(0);
			expect(at.getUTCMinutes()).toBe(0);
			expect(at.getUTCSeconds()).toBe(0);
			expect(at.getUTCMilliseconds()).toBe(0);
			expect(at.toISOString().slice(0, 10)).toBe(
				new Date().toISOString().slice(0, 10),
			);
		});
	},
);
