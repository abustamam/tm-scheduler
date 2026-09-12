/**
 * DB-backed tests for recording the Timer's measured times (#730).
 *
 * The write is a session-less path that mints a row and decides who may
 * overwrite another person's record, so most of what is here is the LADDER and
 * the FLOOR rather than the happy path. Three things are only observable
 * against a real Postgres and are asserted for that reason: the upsert actually
 * updating rather than erroring on the unique index, the non-negative check
 * constraint, and both cascades.
 *
 * `recordMeetingTiming` is a plain seam rather than the `createServerFn`,
 * which is what makes any of this reachable at all — a handler cannot be
 * invoked from vitest (CODING_STANDARDS, "WRITES are closed too"). What the
 * handler contributes on top is pinned by `timings-authz.guard.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/timings.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetings,
	meetingTimings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { timingVerdict } from "#/lib/timing-verdict";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * The officer arm reads the SESSION off the current request, which vitest has
 * none of — `getSessionUser` catches the missing context and returns null, so
 * without these two mocks every case here would silently be an anonymous one
 * and the officer tests would prove nothing. Mocked at the LIBRARY boundary, so
 * `requireClubRole` / `requireMembership` stay real and run against real rows;
 * what is faked is only the cookie → session lookup a test process cannot have.
 */
let sessionUserId: string | null = null;
/** One stable object, because the impersonation marker is keyed on identity. */
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { collapseMemberships } = await import("./membership-collapse-logic");
const {
	MEETING_CANCELLED_MESSAGE,
	recordMeetingTiming,
	TIMING_NOT_PERMITTED_MESSAGE,
	TIMING_OVERWRITE_MESSAGE,
} = await import("./timings-logic");

const MARKS = { green: 5, yellow: 6, red: 7 };

/** Add a role definition + one slot to the seeded meeting, and return the slot
 *  id. Every argument has a case behind it: the KEY separates a renamed
 *  standard role from a club-invented look-alike, and the two columns are what
 *  `isTimeableRole` reads. */
async function addSlot(
	club: SeededClub,
	spec: {
		name: string;
		key?: string | null;
		category: "leadership" | "speaker" | "evaluator" | "functionary";
		isSpeakerRole?: boolean;
		assignedMemberId?: string | null;
		sortOrder?: number;
	},
): Promise<string> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: spec.name,
			key: spec.key ?? null,
			category: spec.category,
			isSpeakerRole: spec.isSpeakerRole ?? false,
			sortOrder: spec.sortOrder ?? 100,
		})
		.returning({ id: roleDefinitions.id });
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: club.meetingId,
			roleDefinitionId: def.id,
			status: spec.assignedMemberId ? "claimed" : "open",
			assignedMemberId: spec.assignedMemberId ?? null,
		})
		.returning({ id: roleSlots.id });
	return slot.id;
}

/** An extra active roster member. Every membership needs a Person (ADR-0008). */
async function addMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

const rowFor = async (slotId: string) =>
	(
		await testDb
			.select()
			.from(meetingTimings)
			.where(eq(meetingTimings.slotId, slotId))
	)[0];

describe.skipIf(!hasTestDb)("recording a measured time", () => {
	let club: SeededClub;
	/** The member holding this meeting's Timer slot. */
	let timerMemberId: string;
	let tmodMemberId: string;
	let strangerMemberId: string;
	let speakerSlotId: string;
	const extraUsers: string[] = [];

	beforeEach(async () => {
		sessionUserId = null;
		club = await seedClub();
		timerMemberId = await addMember(club.clubId, "Tarek the Timer");
		tmodMemberId = await addMember(club.clubId, "Tomas the Toastmaster");
		strangerMemberId = await addMember(club.clubId, "Sam Somebody");
		// `seedClub` already made a "Timer" role definition and one OPEN slot for
		// it; give the Timer their own KEYED slot so the resolver's key pass is
		// what admits them rather than the seed's name-only row.
		await addSlot(club, {
			name: "Timer",
			key: "timer",
			category: "functionary",
			assignedMemberId: timerMemberId,
			sortOrder: 60,
		});
		await addSlot(club, {
			name: "Toastmaster of the Day",
			key: "toastmaster_of_the_day",
			category: "leadership",
			assignedMemberId: tmodMemberId,
			sortOrder: 10,
		});
		speakerSlotId = await addSlot(club, {
			name: "Speaker",
			key: "speaker",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 30,
		});
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		for (const id of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, id));
		}
	});

	// -----------------------------------------------------------------------
	// The write itself
	// -----------------------------------------------------------------------

	it("records whole seconds and a COPY of the marks in force", async () => {
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
			claimedActorMemberId: timerMemberId,
		});
		const row = await rowFor(speakerSlotId);
		expect(row.elapsedSeconds).toBe(371);
		expect(row.markGreen).toBe(5);
		expect(row.markYellow).toBe(6);
		expect(row.markRed).toBe(7);
		expect(row.meetingId).toBe(club.meetingId);
		expect(row.recordedByMemberId).toBe(timerMemberId);
	});

	it("a second recording UPDATES the row rather than inserting a second", async () => {
		// The unique index alone only proves the second insert FAILS. What makes
		// the Timer able to correct their own mis-stop is the upsert naming
		// `slot_id` as its conflict target — stated explicitly in the write.
		for (const seconds of [371, 400]) {
			await recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: seconds,
				marks: MARKS,
				claimedActorMemberId: timerMemberId,
			});
		}
		const rows = await testDb
			.select()
			.from(meetingTimings)
			.where(eq(meetingTimings.slotId, speakerSlotId));
		expect(rows).toHaveLength(1);
		expect(rows[0].elapsedSeconds).toBe(400);
	});

	it("a correction with no marks leaves the stored window untouched", async () => {
		// The officer's minutes-screen correction fixes the NUMBER. Rewriting the
		// window here would let a typo fix silently re-decide whether the speech
		// qualified.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
			claimedActorMemberId: timerMemberId,
		});
		sessionUserId = club.adminUserId;
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 400,
		});
		const row = await rowFor(speakerSlotId);
		expect(row.elapsedSeconds).toBe(400);
		expect(row.markGreen).toBe(5);
		expect(row.markRed).toBe(7);
	});

	it("rejects a negative duration at the database", async () => {
		// The validator bounds it at the edge; this is the floor underneath, and
		// it matters because the write takes a number off a public request.
		//
		// The CONSTRAINT NAME is asserted, not merely "it threw": drizzle's
		// wrapper message names the failed query and nothing else, so a plain
		// `rejects.toThrow()` here would also pass for a not-null violation, a
		// bad FK, or a typo'd column — every reason except the one this test is
		// about. The pg error hangs off `cause`.
		const err = await testDb
			.insert(meetingTimings)
			.values({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: -1,
				grantedVia: "self",
			})
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(err, "a negative duration must not insert").not.toBeNull();
		const cause = (err as { cause?: { constraint?: string } }).cause;
		expect(cause?.constraint).toBe("meeting_timings_elapsed_nonneg");
	});

	it("granted_via only ever holds one of the three arms", async () => {
		await expect(
			testDb.execute(
				`insert into meeting_timings (meeting_id, slot_id, elapsed_seconds, granted_via)
				 values ('${club.meetingId}', '${speakerSlotId}', 10, 'chairman')`,
			),
		).rejects.toThrow();
	});

	// -----------------------------------------------------------------------
	// WHAT may be recorded against
	// -----------------------------------------------------------------------

	it("refuses the Table Topics segment with a NAMED error, not an authz failure", async () => {
		// The trap. That row IS slot-backed — the Table Topics MASTER's — so a
		// naive write type-checks, inserts cleanly, and stores one number for a
		// segment with four to eight speakers, attributed to whoever asked the
		// questions. The refusal has to name the role, because "you're not
		// allowed" would send the Timer looking for a permissions problem.
		const ttm = await addSlot(club, {
			name: "Table Topics Master",
			key: "table_topics_master",
			category: "leadership",
			sortOrder: 20,
		});
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: ttm,
				elapsedSeconds: 120,
				marks: MARKS,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(/Table Topics Master/);
		expect(await rowFor(ttm)).toBeUndefined();
	});

	it("accepts a CONTEST speech, which a hand-written key list would have refused", async () => {
		// `contestant_prepared` is the contest template's only `isSpeakerRole`
		// def, its beat carries hardcoded marks AND a stated qualifying window,
		// and it fans out one row per slot — so it reaches this write with a real
		// `slotId`, on the one meeting shape where the window is the
		// disqualification rule rather than a courtesy.
		const contestant = await addSlot(club, {
			name: "Contestant",
			key: "contestant_prepared",
			category: "speaker",
			isSpeakerRole: true,
			sortOrder: 70,
		});
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: contestant,
			elapsedSeconds: 400,
			marks: { green: 5, yellow: 6, red: 7 },
			claimedActorMemberId: timerMemberId,
		});
		expect((await rowFor(contestant)).elapsedSeconds).toBe(400);
	});

	it("accepts an EVALUATOR, whose role is not isSpeakerRole", async () => {
		// The second arm of `isTimeableRole`, and not decoration: the standard
		// Evaluator is `isSpeakerRole: false`, so the flag alone would refuse
		// every evaluation in the club.
		const evaluator = await addSlot(club, {
			name: "Evaluator",
			key: "evaluator",
			category: "evaluator",
			sortOrder: 40,
		});
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: evaluator,
			elapsedSeconds: 150,
			marks: { green: 2, yellow: 2.5, red: 3 },
			claimedActorMemberId: timerMemberId,
		});
		expect((await rowFor(evaluator)).elapsedSeconds).toBe(150);
	});

	it("refuses a slot belonging to a DIFFERENT meeting", async () => {
		// A hand-made request naming another meeting's slot would otherwise write
		// a row whose `meeting_id` and `slot_id` disagree, which nothing
		// downstream could interpret.
		const [other] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		// The club's EXISTING speaker definition — `role_definitions` is unique on
		// (club_id, key), so a second one would fail before the assertion ran.
		const [speakerDef] = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "speaker"),
				),
			);
		const [otherSlot] = await testDb
			.insert(roleSlots)
			.values({ meetingId: other.id, roleDefinitionId: speakerDef.id })
			.returning({ id: roleSlots.id });
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: otherSlot.id,
				elapsedSeconds: 100,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(/isn't part of this meeting/);
	});

	// -----------------------------------------------------------------------
	// WHO may record — the ladder
	// -----------------------------------------------------------------------

	it("the meeting's Timer may record, with no session at all", async () => {
		const written = await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
			claimedActorMemberId: timerMemberId,
		});
		expect(written.grantedVia).toBe("self");
	});

	it("the meeting's TMOD may record, with no session at all", async () => {
		const written = await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
			claimedActorMemberId: tmodMemberId,
		});
		expect(written.grantedVia).toBe("tmod");
	});

	it("a club admin may record, and is credited as the officer they are", async () => {
		sessionUserId = club.adminUserId;
		const written = await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
		});
		expect(written.grantedVia).toBe("officer");
		expect((await rowFor(speakerSlotId)).recordedByMemberId).toBe(
			club.adminMemberId,
		);
	});

	it("the officer arm wins when one person is BOTH admin and Timer", async () => {
		// Arm order is load-bearing: only the manager arms may overwrite, so an
		// admin who also holds the Timer slot must be credited as the officer.
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: club.adminMemberId })
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleSlots.assignedMemberId, timerMemberId),
				),
			);
		sessionUserId = club.adminUserId;
		const written = await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: club.adminMemberId,
		});
		expect(written.grantedVia).toBe("officer");
	});

	it("a club member holding no relevant role is refused", async () => {
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: strangerMemberId,
			}),
		).rejects.toThrow(TIMING_NOT_PERMITTED_MESSAGE);
	});

	it("a caller asserting nobody is refused", async () => {
		// Unlike the attendance ladder, whose self arm defaults the caller to the
		// SUBJECT, a timing has no subject to fall back to — so an anonymous
		// caller who names nobody gains nothing.
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
			}),
		).rejects.toThrow(TIMING_NOT_PERMITTED_MESSAGE);
	});

	it("a member of a DIFFERENT club is refused", async () => {
		const other = await seedClub();
		try {
			await expect(
				recordMeetingTiming({
					meetingId: club.meetingId,
					slotId: speakerSlotId,
					elapsedSeconds: 371,
					claimedActorMemberId: other.memberId,
				}),
			).rejects.toThrow();
			expect(await rowFor(speakerSlotId)).toBeUndefined();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("resolves the capability by KEY, so a look-alike display name gains nothing", async () => {
		// #464 in the shape that caused it: every club-invented role carries a
		// NULL key, so a role merely NAMED like the Timer must not be admitted.
		const impostorId = await addMember(club.clubId, "Ivy Impostor");
		await addSlot(club, {
			name: "Timekeeper",
			key: null,
			category: "functionary",
			assignedMemberId: impostorId,
			sortOrder: 61,
		});
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: impostorId,
			}),
		).rejects.toThrow(TIMING_NOT_PERMITTED_MESSAGE);
	});

	it("a RENAMED Timer keeps the capability through its key", async () => {
		// The other direction of the same rule, and the reason the name fallback
		// is not simply deleted: renaming the role must not take the Timer's
		// surface away. `applyRoleDefinitionUpdate` never touches `key`, so this
		// is what a real rename looks like.
		//
		// It also pins the resolver's ORDER rather than array order: the seeded
		// club already has a key-less definition literally NAMED "Timer" with an
		// open slot, so after this rename the only row the name pass could match
		// is the wrong one.
		await testDb
			.update(roleDefinitions)
			.set({ name: "Chief Timekeeper" })
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.key, "timer"),
				),
			);
		const written = await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		expect(written.grantedVia).toBe("self");
	});

	// -----------------------------------------------------------------------
	// The overwrite floor
	// -----------------------------------------------------------------------

	it("the Timer may correct their OWN recording", async () => {
		for (const seconds of [371, 380]) {
			await recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: seconds,
				claimedActorMemberId: timerMemberId,
			});
		}
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(380);
	});

	it("the Timer may NOT overwrite a recording another actor made", async () => {
		sessionUserId = club.adminUserId;
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			marks: MARKS,
		});
		sessionUserId = null;
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 999,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(TIMING_OVERWRITE_MESSAGE);
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(371);
	});

	it("the Timer may NOT overwrite a row whose recorder is unknown", async () => {
		// `recorded_by_member_id` is `set null` on member delete, so after a
		// member is deleted a row cannot prove whose it was. NULL fails CLOSED:
		// the worst outcome is that the Timer has to ask an officer, rather than
		// that anyone may quietly overwrite an orphaned record.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await testDb
			.update(meetingTimings)
			.set({ recordedByMemberId: null })
			.where(eq(meetingTimings.slotId, speakerSlotId));
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 999,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(TIMING_OVERWRITE_MESSAGE);
	});

	it("holds the floor against a RACE, not just against a serial retry", async () => {
		// A serial test cannot tell a correct floor from a missing one: the read
		// always sees the row, so check-then-write looks right when nothing else
		// is running. This drives the interleaving the read alone cannot survive
		// — the Timer reads an EMPTY slot, the TMOD's row lands underneath them,
		// and the Timer's insert then hits the unique index. Only the `setWhere`
		// predicate, which Postgres evaluates against the live row, refuses it.
		const writer = await openBlockingTx(async (tx) => {
			await tx.insert(meetingTimings).values({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				recordedByMemberId: tmodMemberId,
				grantedVia: "tmod",
			});
		});
		const subject = recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 999,
			claimedActorMemberId: timerMemberId,
		}).then(
			() => null,
			(e: unknown) => e,
		);
		// Wait until the subject is provably parked behind THIS writer, not
		// merely until "something is waiting" — ~50 DB-backed suites run in
		// parallel against one Postgres. Get this wrong and the writer commits
		// before the subject blocks, the test exercises the uncontended path, and
		// it passes with the floor deleted.
		await waitForLockWait('insert into "meeting_timings"', writer.pid);
		await writer.commit();

		expect(await subject).toBeInstanceOf(Error);
		expect(String(await subject)).toContain(TIMING_OVERWRITE_MESSAGE);
		// And the TMOD's number is the one that survived.
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(371);
	});

	it("an officer and the TMOD may both correct somebody else's recording", async () => {
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 380,
			claimedActorMemberId: tmodMemberId,
		});
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(380);
		sessionUserId = club.adminUserId;
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 390,
		});
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(390);
	});

	// -----------------------------------------------------------------------
	// The meeting window and the archive gate
	// -----------------------------------------------------------------------

	it("a COMPLETED meeting still accepts a timing", async () => {
		// Minutes are written after the meeting by definition, so borrowing the
		// agenda lock here would make this record unwritable at exactly the moment
		// it is meant to be written.
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		expect((await rowFor(speakerSlotId)).elapsedSeconds).toBe(371);
	});

	it("a CANCELLED meeting refuses one", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
	});

	it("an ARCHIVED club THROWS rather than collapsing to not-found (#555)", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("the archive gate outranks the meeting window", async () => {
		// Takedown outranks every other reason to refuse. With the window checked
		// first, an archived club's cancelled meeting answers differently from its
		// scheduled one, which is itself a disclosure.
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, club.meetingId));
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, club.clubId));
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("a missing meeting is not found", async () => {
		await expect(
			recordMeetingTiming({
				meetingId: randomUUID(),
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: timerMemberId,
			}),
		).rejects.toThrow("Meeting not found.");
	});

	// -----------------------------------------------------------------------
	// The audit trail
	// -----------------------------------------------------------------------

	it("persists the arm on the row AND in the activity log, for every arm", async () => {
		// A grant defended as "auditable afterwards" is not auditable while an
		// honour-system claim and a session-authenticated officer's write look
		// identical in the feed. Each arm is checked, because a single arm proves
		// only that the column is written at all.
		const cases: { actor?: string; session: string | null; via: string }[] = [
			{ actor: timerMemberId, session: null, via: "self" },
			{ actor: tmodMemberId, session: null, via: "tmod" },
			{ session: club.adminUserId, via: "officer" },
		];
		for (const c of cases) {
			sessionUserId = c.session;
			await recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: c.actor,
			});
			expect((await rowFor(speakerSlotId)).grantedVia, c.via).toBe(c.via);
		}
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "timing_record"),
				),
			);
		expect(log).toHaveLength(3);
		expect(
			log.map((r) => (r.detail as { grantedVia: string }).grantedVia).sort(),
		).toEqual(["officer", "self", "tmod"]);
		// The subject is the SLOT, so a reader of the feed can see which segment
		// was re-timed rather than only that something was.
		expect(new Set(log.map((r) => r.targetType))).toEqual(new Set(["slot"]));
		expect(new Set(log.map((r) => r.targetId))).toEqual(
			new Set([speakerSlotId]),
		);
	});

	it("logs nothing when the write is refused", async () => {
		await expect(
			recordMeetingTiming({
				meetingId: club.meetingId,
				slotId: speakerSlotId,
				elapsedSeconds: 371,
				claimedActorMemberId: strangerMemberId,
			}),
		).rejects.toThrow();
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "timing_record"),
				),
			);
		expect(log).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// What survives an agenda edit, and what does not survive a delete
	// -----------------------------------------------------------------------

	it("an agenda edit AFTER recording leaves the stored marks and the verdict alone", async () => {
		// The whole reason the marks are copied onto the row. An officer widening
		// the min/max next month must not silently re-decide whether a past speech
		// qualified.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 460, // 7:40 — over a 4:30–7:30 window
			marks: MARKS,
			claimedActorMemberId: timerMemberId,
		});
		const before = await rowFor(speakerSlotId);
		expect(timingVerdict(before.elapsedSeconds, before, "speech")).toBe("over");

		// A slot's min/max live on its SPEECH (`speeches.min_minutes` /
		// `max_minutes`), which is what the run sheet derives the marks from —
		// so widening the assignment means widening that row.
		const [speech] = await testDb
			.insert(speeches)
			.values({
				personId: club.personId,
				title: "A Widening Window",
				minMinutes: 5,
				maxMinutes: 7,
			})
			.returning({ id: speeches.id });
		await testDb
			.update(roleSlots)
			.set({ speechId: speech.id })
			.where(eq(roleSlots.id, speakerSlotId));
		await testDb
			.update(speeches)
			.set({ minMinutes: 5, maxMinutes: 9 })
			.where(eq(speeches.id, speech.id));

		const after = await rowFor(speakerSlotId);
		expect(after.markGreen).toBe(5);
		expect(after.markRed).toBe(7);
		expect(timingVerdict(after.elapsedSeconds, after, "speech")).toBe("over");
	});

	it("cascades from the meeting", async () => {
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await testDb.delete(meetings).where(eq(meetings.id, club.meetingId));
		expect(await rowFor(speakerSlotId)).toBeUndefined();
	});

	it("cascades from the role slot", async () => {
		// A timing outliving its slot would name a subject nothing can resolve.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await testDb.delete(roleSlots).where(eq(roleSlots.id, speakerSlotId));
		expect(await rowFor(speakerSlotId)).toBeUndefined();
	});

	it("follows the recorder through a membership MERGE", async () => {
		// `membership-collapse-logic.ts`'s FK drift-guard is what forces this
		// column to be handled at all; this is the behavioural half, which is the
		// pair that file's own comments prescribe. It matters beyond tidiness:
		// the overwrite floor treats an unknown recorder as NOT the caller's own,
		// so a merge that dropped this would leave the merged member unable to
		// correct their own measurement.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await testDb.transaction((tx) =>
			collapseMemberships(tx, club.clubId, strangerMemberId, timerMemberId),
		);
		const row = await rowFor(speakerSlotId);
		expect(row.elapsedSeconds).toBe(371);
		expect(row.recordedByMemberId).toBe(strangerMemberId);
	});

	it("keeps the row when the RECORDER is deleted, with the recorder nulled", async () => {
		// The record is the club's, not the recorder's: deleting a member must not
		// erase what the meeting measured. What is lost is only whose write it
		// was, which is what the overwrite floor's NULL arm exists to handle.
		await recordMeetingTiming({
			meetingId: club.meetingId,
			slotId: speakerSlotId,
			elapsedSeconds: 371,
			claimedActorMemberId: timerMemberId,
		});
		await testDb.delete(members).where(eq(members.id, timerMemberId));
		const row = await rowFor(speakerSlotId);
		expect(row.elapsedSeconds).toBe(371);
		expect(row.recordedByMemberId).toBeNull();
	});
});
