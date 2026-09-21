/**
 * DB-backed integration tests for `loadEvaluatorPairings` (#709) — the
 * evaluator→speaker self-join through `role_slots.evaluates_slot_id`, read
 * ACROSS meetings. No new tables (ADR-0005).
 *
 * These cover only what the SQL decides and the pure fold cannot see: which
 * slots become pairings at all (held / past / non-cancelled / this club), that
 * the two LEFT JOINs keep BOTH a member and a guest evaluator, the
 * `ROW_NUMBER()` bound that stops the query fetching a club's whole history,
 * and the speaker-axis filter #681's history half will reuse. The folding
 * itself — repeat detection, ordering, the window as a SEMANTIC — is
 * unit-tested in `src/lib/evaluator-pairing.test.ts` without a database.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; the suite is
 * skipped when it's unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/reporting-evaluator-pairings.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
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

/**
 * The fold, wrapped but NOT replaced — every call runs the real implementation.
 *
 * This exists for one assertion nothing else in the suite can make. The query's
 * `ROW_NUMBER()` bound and the fold's own `slice(0, recentPerSpeaker)` cap the
 * same number, so DELETING the SQL bound changes no returned value at all: the
 * loader would fetch a club's entire pairing history and the fold would quietly
 * truncate it, with every result-level assertion in this file still green. What
 * the bound actually controls is how many rows cross the wire, so the only
 * honest place to observe it is the fold's ARGUMENT.
 */
vi.mock("#/lib/evaluator-pairing", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/lib/evaluator-pairing")>();
	return {
		...actual,
		groupEvaluatorPairings: vi.fn(actual.groupEvaluatorPairings),
	};
});

/** The rows the LOADER handed the fold on its most recent call. */
async function rowsFetched() {
	const { groupEvaluatorPairings } = await import("#/lib/evaluator-pairing");
	const calls = vi.mocked(groupEvaluatorPairings).mock.calls;
	return calls[calls.length - 1]?.[0] ?? [];
}

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("loadEvaluatorPairings (#709)", () => {
	let seeded: SeededClub;
	let speakerRoleId: string;
	let evaluatorRoleId: string;
	// Every seeded name carries a per-run suffix: vitest runs test FILES in
	// parallel against one shared `tm_test`, so a fixed name collides across
	// suites. Every assertion below is also scoped to `seeded.clubId`.
	let run: string;

	beforeEach(async () => {
		run = randomUUID().slice(0, 8);
		const { groupEvaluatorPairings } = await import("#/lib/evaluator-pairing");
		vi.mocked(groupEvaluatorPairings).mockClear();
		seeded = await seedClub();
		const inserted = await testDb
			.insert(roleDefinitions)
			.values([
				{
					clubId: seeded.clubId,
					name: `Speaker ${run}`,
					category: "speaker",
					isSpeakerRole: true,
				},
				{
					clubId: seeded.clubId,
					name: `Evaluator ${run}`,
					category: "evaluator",
				},
			])
			.returning({ id: roleDefinitions.id });
		const [speakerRole, evaluatorRole] = inserted;
		if (!speakerRole || !evaluatorRole) {
			throw new Error("role definition insert failed");
		}
		speakerRoleId = speakerRole.id;
		evaluatorRoleId = evaluatorRole.id;
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	/** The `joined_at` every seeded member carries — see the type assertion below. */
	const JOINED_AT = new Date("2024-01-15T00:00:00Z");

	async function addMember(
		name: string,
		status: "active" | "inactive" = "active",
		clubId: string = seeded.clubId,
	): Promise<string> {
		const personId = await seedPerson({ name: `${name} ${run}` });
		const [row] = await testDb
			.insert(members)
			.values({
				clubId,
				personId,
				name: `${name} ${run}`,
				clubRole: "member",
				status,
				joinedAt: JOINED_AT,
			})
			.returning({ id: members.id });
		if (!row) throw new Error("member insert failed");
		return row.id;
	}

	async function addGuest(name: string): Promise<string> {
		const [row] = await testDb
			.insert(guests)
			.values({ clubId: seeded.clubId, name: `${name} ${run}` })
			.returning({ id: guests.id });
		if (!row) throw new Error("guest insert failed");
		return row.id;
	}

	async function addMeeting(
		daysAgo: number,
		status: "scheduled" | "cancelled" = "scheduled",
		clubId: string = seeded.clubId,
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId,
				scheduledAt: new Date(Date.now() - daysAgo * DAY),
				status,
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("meeting insert failed");
		return row.id;
	}

	/**
	 * A speaker slot for `speakerMemberId`, plus an evaluator slot pointed at it
	 * — the shape `applyCreateMeeting` writes. Returns both slot ids so a test
	 * can mutate the evaluator slot, or hand `speakerSlotId` back to add a SECOND
	 * evaluator to the same speech (a two-evaluator club).
	 */
	async function addPairing(opts: {
		meetingId: string;
		speakerMemberId?: string;
		speakerGuestId?: string;
		speakerSlotId?: string;
		evaluatorMemberId?: string;
		evaluatorGuestId?: string;
		evaluatorStatus?: "open" | "claimed" | "confirmed";
		roleDefinitionId?: string;
	}): Promise<{
		speakerSlotId: string;
		evaluatorSlotId: string;
		evaluatorMemberId: string | null;
	}> {
		let speakerSlotId = opts.speakerSlotId;
		if (!speakerSlotId) {
			const [speakerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: opts.meetingId,
					roleDefinitionId: speakerRoleId,
					assignedMemberId: opts.speakerMemberId ?? null,
					assignedGuestId: opts.speakerGuestId ?? null,
					status: "confirmed",
				})
				.returning({ id: roleSlots.id });
			if (!speakerSlot) throw new Error("speaker slot insert failed");
			speakerSlotId = speakerSlot.id;
		}

		const [evaluatorSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: opts.meetingId,
				roleDefinitionId: opts.roleDefinitionId ?? evaluatorRoleId,
				assignedMemberId: opts.evaluatorMemberId ?? null,
				assignedGuestId: opts.evaluatorGuestId ?? null,
				status: opts.evaluatorStatus ?? "confirmed",
				evaluatesSlotId: speakerSlotId,
			})
			.returning({ id: roleSlots.id });
		if (!evaluatorSlot) throw new Error("evaluator slot insert failed");
		return {
			speakerSlotId,
			evaluatorSlotId: evaluatorSlot.id,
			evaluatorMemberId: opts.evaluatorMemberId ?? null,
		};
	}

	it("reads a pairing off the slot pointer, across meetings", async () => {
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		const dana = await addMember("Dana Lee");

		await addPairing({
			meetingId: await addMeeting(30),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		await addPairing({
			meetingId: await addMeeting(7),
			speakerMemberId: alex,
			evaluatorMemberId: dana,
		});

		const rows = await loadEvaluatorPairings(seeded.clubId);
		const alexRow = rows.find((r) => r.memberId === alex);
		// Newest first — Dana evaluated 7 days ago, Sam 30.
		expect(alexRow?.recent.map((p) => p.evaluatorName)).toEqual([
			`Dana Lee ${run}`,
			`Sam Chen ${run}`,
		]);
		// One row per SPEAKER: Sam and Dana evaluated but never spoke, so they are
		// absent rather than present with an empty history.
		expect(rows.map((r) => r.memberId)).toEqual([alex]);
	});

	it("returns real Dates, not the strings a subquery can hand back", async () => {
		// The `ROW_NUMBER()` bound moved every column into a subquery, and each
		// one is selected through a `sql<T>` wrapper to carry an explicit output
		// name — which means the TYPE is an assertion the compiler cannot check
		// against the driver. `scheduledAt` is self-guarding (the fold sorts on
		// `.getTime()`), `joinedAt` is not: it only reaches `formatTenure` in the
		// browser, so a string would render wrong with every gate green.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		await addPairing({
			meetingId: await addMeeting(10),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});

		const row = (await loadEvaluatorPairings(seeded.clubId)).find(
			(r) => r.memberId === alex,
		);
		expect(row?.joinedAt).toBeInstanceOf(Date);
		expect(row?.joinedAt?.toISOString()).toBe(JOINED_AT.toISOString());
		expect(row?.recent[0]?.scheduledAt).toBeInstanceOf(Date);
	});

	it("FETCHES at most five per speaker, not the club's whole history", async () => {
		// The finding this test exists for: `recentPerSpeaker` capped the render
		// and nothing else, so the loader pulled every held, past, non-cancelled
		// pairing in the club for all time and threw most of them away in JS. The
		// neighbouring `loadAttendanceLapse` bounds itself at the query; this now
		// does too, with `ROW_NUMBER() OVER (PARTITION BY speaker ...) <= 5`.
		//
		// Asserted on what the LOADER HANDED THE FOLD, because the returned rows
		// cannot tell the two apart — the fold truncates to five either way.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const evaluators = await Promise.all([
			addMember("Eval Zero"),
			addMember("Eval One"),
			addMember("Eval Two"),
			addMember("Eval Three"),
			addMember("Eval Four"),
			addMember("Eval Five"),
			addMember("Eval Six"),
		]);
		// Seeded oldest-first so "the first five" and "the newest five" are
		// different sets: a bound that kept the wrong end still returns five.
		const daysAgo = [70, 60, 50, 40, 30, 20, 10];
		for (const [i, evaluatorMemberId] of evaluators.entries()) {
			await addPairing({
				meetingId: await addMeeting(daysAgo[i] as number),
				speakerMemberId: alex,
				evaluatorMemberId,
			});
		}

		const rows = await loadEvaluatorPairings(seeded.clubId);
		expect(await rowsFetched()).toHaveLength(5);
		// And they are the NEWEST five — `order by scheduled_at desc` inside the
		// window. Flipped to `asc`, the count above still reads 5.
		const row = rows.find((r) => r.memberId === alex);
		expect(row?.recent.map((p) => p.evaluatorName)).toEqual([
			`Eval Six ${run}`, // 10d
			`Eval Five ${run}`, // 20d
			`Eval Four ${run}`, // 30d
			`Eval Three ${run}`, // 40d
			`Eval Two ${run}`, // 50d
		]);
	});

	it("bounds each speaker separately, so one prolific speaker starves nobody", async () => {
		// Why a window function rather than a plain `.limit()`. A flat limit cuts
		// the RESULT SET, so the member who speaks every week would consume the
		// whole budget and the member who speaks twice a year — the one whose last
		// evaluator the assigner genuinely cannot remember — would silently lose
		// their history entirely.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const frequent = await addMember("Frequent Speaker");
		const rare = await addMember("Rare Speaker");
		const sam = await addMember("Sam Chen");
		for (const days of [4, 8, 12, 16, 20, 24, 28]) {
			await addPairing({
				meetingId: await addMeeting(days),
				speakerMemberId: frequent,
				evaluatorMemberId: sam,
			});
		}
		await addPairing({
			meetingId: await addMeeting(300),
			speakerMemberId: rare,
			evaluatorMemberId: sam,
		});

		const rows = await loadEvaluatorPairings(seeded.clubId);
		expect(rows.find((r) => r.memberId === frequent)?.recent).toHaveLength(5);
		expect(rows.find((r) => r.memberId === rare)?.recent).toHaveLength(1);
		// 5 for the frequent speaker + 1 for the rare one, and nothing else.
		expect(await rowsFetched()).toHaveLength(6);
	});

	it("breaks a tie at the window's EDGE the way the fold would", async () => {
		// The risk the SQL bound introduces. The fold cannot see what SQL
		// discarded, so the window's ORDER BY has to mirror the fold's comparator
		// term for term or the two layers disagree about which pairing is the
		// fifth — silently, since both answers are five rows of real history.
		//
		// The reachable tie is a TWO-EVALUATOR meeting: both evaluator slots point
		// at one speaker slot, so the pair ties on `scheduled_at` AND on
		// `meeting_id`, and only `coalesce(assigned_member_id, assigned_guest_id)`
		// separates them. (Two MEETINGS sharing a `scheduled_at` cannot happen in
		// one club — `meetings_club_scheduled_unique` — which is why the case is
		// built this way rather than the obvious way.) Four newer evaluations put
		// that pair astride the edge: exactly one of them survives.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		for (const days of [4, 8, 12, 16]) {
			await addPairing({
				meetingId: await addMeeting(days),
				speakerMemberId: alex,
				evaluatorMemberId: sam,
			});
		}
		const shared = await addMeeting(40);
		const first = await addPairing({
			meetingId: shared,
			speakerMemberId: alex,
			evaluatorMemberId: await addMember("Tied Evaluator A"),
		});
		const second = await addPairing({
			meetingId: shared,
			speakerSlotId: first.speakerSlotId,
			evaluatorMemberId: await addMember("Tied Evaluator B"),
		});
		expect(second.speakerSlotId).toBe(first.speakerSlotId);

		const rows = await loadEvaluatorPairings(seeded.clubId);
		const recent = rows.find((r) => r.memberId === alex)?.recent ?? [];
		expect(recent).toHaveLength(5);
		// The lower evaluator id wins, in SQL and in the fold alike.
		const tiedKeys = [first.evaluatorMemberId, second.evaluatorMemberId];
		expect(recent[4]?.evaluatorKey).toBe([...tiedKeys].sort()[0]);
		// And the loser never left Postgres.
		expect(await rowsFetched()).toHaveLength(5);
	});

	it("keeps a GUEST evaluator alongside a member one", async () => {
		// The join that decides this: the evaluator is a member OR a guest, never
		// both (`role_slots_single_assignee`), so an inner join on either table
		// drops exactly the other kind — silently, with nothing on the page to
		// hint a pairing is missing.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		const robin = await addGuest("Robin Visitor");

		await addPairing({
			meetingId: await addMeeting(20),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		await addPairing({
			meetingId: await addMeeting(5),
			speakerMemberId: alex,
			evaluatorGuestId: robin,
		});

		const row = (await loadEvaluatorPairings(seeded.clubId)).find(
			(r) => r.memberId === alex,
		);
		expect(row?.recent).toHaveLength(2);
		expect(row?.recent[0]).toMatchObject({
			evaluatorName: `Robin Visitor ${run}`,
			isGuest: true,
			evaluatorKey: robin,
		});
		expect(row?.recent[1]).toMatchObject({
			evaluatorName: `Sam Chen ${run}`,
			isGuest: false,
		});
	});

	/**
	 * The three exclusions get a test each rather than one combined case. They
	 * are three separate predicates, and a single assertion over all of them
	 * fails identically whichever one was dropped — which is the diagnosis the
	 * next person needs and the only way to prove each can fail on its own.
	 */
	async function keptAndExcluded(excluded: {
		days: number;
		status?: "scheduled" | "cancelled";
		evaluatorStatus?: "open" | "claimed" | "confirmed";
	}): Promise<string[]> {
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		const dana = await addMember("Dana Lee");
		await addPairing({
			meetingId: await addMeeting(10),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		await addPairing({
			meetingId: await addMeeting(excluded.days, excluded.status),
			speakerMemberId: alex,
			evaluatorMemberId: dana,
			evaluatorStatus: excluded.evaluatorStatus,
		});
		const row = (await loadPairings()).find((r) => r.memberId === alex);
		return (row?.recent ?? []).map((p) => p.evaluatorName);
	}

	async function loadPairings() {
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		return loadEvaluatorPairings(seeded.clubId);
	}

	it("excludes an evaluation at a CANCELLED meeting", async () => {
		// The club never met, so nobody evaluated anybody.
		expect(await keptAndExcluded({ days: 12, status: "cancelled" })).toEqual([
			`Sam Chen ${run}`,
		]);
	});

	it("excludes an evaluation still in the FUTURE", async () => {
		// An assignment, not history. `lt(now)` is the exact complement of
		// `loadUpcomingRoleClaims`' `gte(now)`, so a meeting is on one side or the
		// other and neither query can lose it.
		expect(await keptAndExcluded({ days: -6 })).toEqual([`Sam Chen ${run}`]);
	});

	it("excludes an OPEN evaluator slot nobody has taken", async () => {
		// `HELD_SLOT_STATUSES`, shared with every query beside it.
		expect(
			await keptAndExcluded({ days: 15, evaluatorStatus: "open" }),
		).toEqual([`Sam Chen ${run}`]);
	});

	it("does not leak another club's pairings", async () => {
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const other = await seedClub();
		try {
			const alex = await addMember("Alex Rivera");
			const sam = await addMember("Sam Chen");
			await addPairing({
				meetingId: await addMeeting(10),
				speakerMemberId: alex,
				evaluatorMemberId: sam,
			});

			const rows = await loadEvaluatorPairings(other.clubId);
			expect(rows).toEqual([]);
			expect(
				(await loadEvaluatorPairings(seeded.clubId)).map((r) => r.memberId),
			).toEqual([alex]);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("omits an inactive speaker, unless the caller names them (#681's seam)", async () => {
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const gone = await addMember("Gone Away", "inactive");
		const sam = await addMember("Sam Chen");
		await addPairing({
			meetingId: await addMeeting(10),
			speakerMemberId: gone,
			evaluatorMemberId: sam,
		});

		// The dashboard's roster-wide read: an officer assigns to the active
		// roster, so a departed member is noise there.
		expect(await loadEvaluatorPairings(seeded.clubId)).toEqual([]);

		// A caller naming ids has already decided whose history it wants, so the
		// roster filter steps aside rather than returning an empty history that
		// looks like "nobody has ever evaluated you". #681 is that caller for its
		// HISTORY half only — this query is past-only, so #681's "who evaluates
		// me next" needs a forward query of its own — and it must reach this
		// function directly, never through `getEvaluatorPairings`, whose gate is
		// club-wide admin.
		const scoped = await loadEvaluatorPairings(seeded.clubId, {
			speakerMemberIds: [gone],
		});
		expect(scoped.map((r) => r.memberId)).toEqual([gone]);
		expect(scoped[0]?.recent[0]?.evaluatorName).toBe(`Sam Chen ${run}`);
	});

	it("narrows to the named speakers and nobody else", async () => {
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const casey = await addMember("Casey Kim");
		const sam = await addMember("Sam Chen");
		const m = await addMeeting(10);
		await addPairing({
			meetingId: m,
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		await addPairing({
			meetingId: m,
			speakerMemberId: casey,
			evaluatorMemberId: sam,
		});

		expect(
			(await loadEvaluatorPairings(seeded.clubId))
				.map((r) => r.memberId)
				.sort(),
		).toEqual([alex, casey].sort());
		expect(
			(
				await loadEvaluatorPairings(seeded.clubId, {
					speakerMemberIds: [casey],
				})
			).map((r) => r.memberId),
		).toEqual([casey]);
	});

	it("produces no row for a GUEST speaker", async () => {
		// Deliberate, and the mirror of the guest-evaluator case above. The row's
		// axis is a roster member the assigner will schedule again; a visitor who
		// spoke once is not on that list, and `members` is what the row links to.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const visitor = await addGuest("Visiting Speaker");
		const sam = await addMember("Sam Chen");
		await addPairing({
			meetingId: await addMeeting(10),
			speakerGuestId: visitor,
			evaluatorMemberId: sam,
		});

		expect(await loadEvaluatorPairings(seeded.clubId)).toEqual([]);
	});

	it("ignores a slot whose pointer was cleared", async () => {
		// `evaluates_slot_id` is ON DELETE SET NULL and `slots-logic` clears it on
		// reorder. A null pointer is not a pairing — the inner join is what says
		// so, and without it every evaluator slot in the club would pair with
		// whatever the join fell through to.
		const { loadEvaluatorPairings } = await import("#/server/reporting-logic");
		const alex = await addMember("Alex Rivera");
		const sam = await addMember("Sam Chen");
		const { evaluatorSlotId } = await addPairing({
			meetingId: await addMeeting(10),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		expect(await loadEvaluatorPairings(seeded.clubId)).toHaveLength(1);

		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: null })
			.where(eq(roleSlots.id, evaluatorSlotId));

		expect(await loadEvaluatorPairings(seeded.clubId)).toEqual([]);
	});
});
