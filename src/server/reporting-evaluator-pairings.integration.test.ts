/**
 * DB-backed integration tests for `loadEvaluatorPairings` (#709) — the
 * evaluator→speaker self-join through `role_slots.evaluates_slot_id`, read
 * ACROSS meetings. No new tables (ADR-0005).
 *
 * These cover only what the SQL decides and the pure fold cannot see: which
 * slots become pairings at all (held / past / non-cancelled / this club), that
 * the two LEFT JOINs keep BOTH a member and a guest evaluator, and the
 * speaker-axis filter #681 will reuse. The folding itself — the window, repeat
 * detection, ordering — is unit-tested in `src/lib/evaluator-pairing.test.ts`
 * without a database.
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
	 * — the shape `applyCreateMeeting` writes. Returns the evaluator slot id so a
	 * test can mutate it.
	 */
	async function addPairing(opts: {
		meetingId: string;
		speakerMemberId?: string;
		speakerGuestId?: string;
		evaluatorMemberId?: string;
		evaluatorGuestId?: string;
		evaluatorStatus?: "open" | "claimed" | "confirmed";
		roleDefinitionId?: string;
	}): Promise<string> {
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

		const [evaluatorSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: opts.meetingId,
				roleDefinitionId: opts.roleDefinitionId ?? evaluatorRoleId,
				assignedMemberId: opts.evaluatorMemberId ?? null,
				assignedGuestId: opts.evaluatorGuestId ?? null,
				status: opts.evaluatorStatus ?? "confirmed",
				evaluatesSlotId: speakerSlot.id,
			})
			.returning({ id: roleSlots.id });
		if (!evaluatorSlot) throw new Error("evaluator slot insert failed");
		return evaluatorSlot.id;
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
		// looks like "nobody has ever evaluated you".
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
		const slotId = await addPairing({
			meetingId: await addMeeting(10),
			speakerMemberId: alex,
			evaluatorMemberId: sam,
		});
		expect(await loadEvaluatorPairings(seeded.clubId)).toHaveLength(1);

		await testDb
			.update(roleSlots)
			.set({ evaluatesSlotId: null })
			.where(eq(roleSlots.id, slotId));

		expect(await loadEvaluatorPairings(seeded.clubId)).toEqual([]);
	});
});
