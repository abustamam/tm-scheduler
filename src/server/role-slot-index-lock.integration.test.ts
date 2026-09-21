/**
 * DB-backed gate for #803: `applyAddRoleSlot` must take the meeting lock FIRST
 * and decide everything the insert depends on from behind it
 * (`lockMeetingForSlotEdit`, ADR-0005). The three other slot mutations in
 * `slots-logic.ts` now do the same — the review round that added the status and
 * shape pairs below moved `applyAddSpeakerSlot`, `applyRemoveSpeakerSlot` and
 * `applyMoveSlot` onto the locked row too, since each resolved its role ids from
 * an unlocked `templateId`. THREE races, one lock, one row:
 *
 * - NUMBERING. "Which slot is the next index" is not a property of one row, so
 *   a per-row guard cannot answer it, and there is deliberately NO unique index
 *   on `(meeting_id, role_definition_id, slot_index)` — see #803's Out of Scope,
 *   it is the maintainer's step after an audit, because a create that fails on
 *   pre-existing data would block the whole deploy at container startup. So
 *   nothing in the database catches a duplicate: the serialization IS the
 *   constraint here, which is why every assertion below is on the rows that
 *   actually land rather than on a grep for the lock call.
 * - STATUS. `assertMeetingNotLocked` reads `status` off the EXACT row the lock
 *   takes. Gated on a copy read before the transaction, READ COMMITTED lets a
 *   concurrent "complete meeting" commit inside the window and the slot lands on
 *   a completed meeting — the gate having passed on a value that is no longer
 *   true.
 * - SHAPE. `templateId` is the other meeting-row column the add gates on: it
 *   picks the declared shape, and the shape is what says whether a role belongs
 *   to the paired speaker/evaluator lineup the "+ Add role" path must refuse. A
 *   conversion committing in the window admits a slot the speaker controls own.
 *   It gets its own pair rather than riding on STATUS, because "same row, same
 *   lock" is an argument about the fix and not a demonstration of it — and the
 *   round that first made that argument left the speaker paths reading this same
 *   column unlocked.
 *
 * Three races, FOUR pairs: the SHAPE race is gated twice, once on
 * `applyAddRoleSlot` (where it arrives as a wrong refusal) and once on
 * `applyAddSpeakerSlot` (where it arrives as a slot on the wrong lineup).
 * Each pair is a pre-fix CONTROL — the shape that path actually had — driven
 * through the same harness as the assertion beside it and asserted to still
 * reproduce the bug. Without one, "the fixed code did the right thing" is
 * equally satisfied by two calls that merely never overlapped, and the suite
 * would pass against the bug it exists to catch.
 *
 * KNOWN GAP, so the paragraph above does not read as more than it is. The review
 * round moved THREE functions onto the locked row and only `applyAddSpeakerSlot`
 * has a race test here. `applyRemoveSpeakerSlot` and `applyMoveSlot` took the
 * same change for the same reason, and their behaviour is covered by
 * `meeting-manage.integration.test.ts`, but the RACE property is unproven for
 * both: nothing in this repo would go red if either regressed to resolving its
 * role ids from an unlocked `templateId`.
 *
 * The `Promise.all` test near the bottom is the one with NO control, and it is
 * labelled SMOKE for that reason rather than presented as the acceptance check:
 * whether two overlapping adds collide depends on how their two await profiles
 * happen to line up, so it CAN pass against the broken shape. It does still
 * assert the indices — see its own docblock for what a red there means. The four
 * deterministic pairs are what this suite actually proves.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/role-slot-index-lock.integration.test.ts
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	pairedRoleIds,
	pickSpeakerAndEvaluatorRoles,
} from "#/lib/meeting-roles";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	type TestTx,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyAddRoleSlot, applyAddSpeakerSlot } = await import("./slots-logic");
// The REAL gates, so the two controls below cannot drift from the things they
// mirror — the only difference in each is where the meeting row came from.
const { assertMeetingNotLocked } = await import("./meeting-authz-logic");
const { loadMeetingShapeDefs } = await import("./meeting-templates-logic");

/** Add a non-paired role def to the seeded club; return its id.
 *
 *  `key` exists for the template join and nothing else: `loadDeclaredRoleDefs`
 *  matches a template's declared role to the club's bank on (club, key), so
 *  `templateMakingTheRoleASpeaker` needs one to point at. NOT a collision guard
 *  — `role_definitions_club_key_unique` is scoped to `club_id` and `seedClub()`
 *  mints a fresh club per run, so no two parallel files can meet here. It is
 *  suffixed per run only to keep the key and the template's key derived from one
 *  value, so the join cannot silently miss. */
async function addRole(
	clubId: string,
	name: string,
	key?: string,
): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name,
			key: key ?? null,
			category: "functionary",
			defaultCount: 1,
			sortOrder: 50,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	return row.id;
}

/** Speaker + paired evaluator role defs, so `applyAddSpeakerSlot` resolves. */
async function addSpeakerAndEvaluatorRoles(clubId: string) {
	const [spk] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 3,
			sortOrder: 10,
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleDefinitions).values({
		clubId,
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 11,
		isSpeakerRole: false,
	});
	return { speakerRoleId: spk.id };
}

/** Every slot index for one (meeting, role), ascending. */
async function indicesFor(meetingId: string, roleId: string) {
	const rows = await testDb
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleId),
			),
		)
		.orderBy(roleSlots.slotIndex);
	return rows.map((r) => r.slotIndex);
}

/** What `lockMeetingForSlotEdit` takes, so a test can hold it from outside. */
async function lockMeetingRow(
	tx: Parameters<Parameters<(typeof testDb)["transaction"]>[0]>[0],
	meetingId: string,
) {
	await tx
		.select({ id: meetings.id })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update")
		.limit(1);
}

/**
 * The shape `applyAddRoleSlot` had before this fix: the next index is computed
 * from a read taken OUTSIDE the transaction, and only the insert is
 * transactional. Kept here as the control — it is what proves the harness below
 * can actually see the difference the lock makes.
 */
async function unlockedAddRoleSlot(
	meetingId: string,
	roleDefinitionId: string,
) {
	const existing = await testDb
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, meetingId),
				eq(roleSlots.roleDefinitionId, roleDefinitionId),
			),
		);
	const slotIndex =
		existing.length === 0
			? 0
			: Math.max(...existing.map((s) => s.slotIndex)) + 1;
	await testDb.transaction(async (tx) => {
		await tx
			.insert(roleSlots)
			.values({ meetingId, roleDefinitionId, slotIndex });
	});
}

/**
 * The OTHER shape `applyAddRoleSlot` had before this fix: the meeting row —
 * `status` included — read with no lock, the lock gate applied to that copy, and
 * only the insert taken under the lock. Calls the real `assertMeetingNotLocked`
 * on purpose; the one thing that differs from the shipped function is WHERE the
 * row it judges came from, which is the whole of the finding.
 */
async function statusGatedOutsideTheLock(
	meetingId: string,
	roleDefinitionId: string,
) {
	const meeting = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	assertMeetingNotLocked(meeting.status);
	await testDb.transaction(async (tx) => {
		await lockMeetingRow(tx, meetingId);
		await tx
			.insert(roleSlots)
			.values({ meetingId, roleDefinitionId, slotIndex: 0 });
	});
}

/**
 * The same shape for the OTHER meeting-row column: `templateId` read with no
 * lock, the paired-role gate applied to the shape it names, and only the insert
 * taken under the lock. The real `loadMeetingShapeDefs` and `pairedRoleIds`,
 * again so the control cannot drift from the gate it mirrors.
 */
async function shapeGatedOutsideTheLock(
	meetingId: string,
	roleDefinitionId: string,
) {
	const meeting = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const shape = await loadMeetingShapeDefs(
		testDb,
		meeting.clubId,
		meeting.templateId,
	);
	if (pairedRoleIds(shape).has(roleDefinitionId)) {
		throw new Error("Add speakers with the speaker controls.");
	}
	await testDb.transaction(async (tx) => {
		await lockMeetingRow(tx, meetingId);
		await tx
			.insert(roleSlots)
			.values({ meetingId, roleDefinitionId, slotIndex: 0 });
	});
}

/**
 * The shape `applyAddSpeakerSlot` had before the review round: WHICH role "+ Add
 * speaker" means resolved from an unlocked `templateId`, and only the insert
 * behind the lock.
 *
 * This one is worth stating plainly, because it is not a refusal that goes wrong
 * — it is the slot landing on the WRONG ROLE. `templateId` selects the meeting's
 * shape and the shape names the speaker lineup, so an add resolved against the
 * old shape inserts into the lineup the meeting no longer runs, on a meeting
 * that by then declares a different one.
 */
async function speakerRoleResolvedOutsideTheLock(meetingId: string) {
	const meeting = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const shape = await loadMeetingShapeDefs(
		testDb,
		meeting.clubId,
		meeting.templateId,
	);
	const { speakerRoleId } = pickSpeakerAndEvaluatorRoles(shape);
	await testDb.transaction(async (tx) => {
		await lockMeetingRow(tx, meetingId);
		await tx.insert(roleSlots).values({
			meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: 0,
		});
	});
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasTestDb)(
	"applyAddRoleSlot numbers under the meeting lock (#803)",
	() => {
		let club: SeededClub;
		let roleId: string;
		let roleKey: string;
		const createdTemplateIds: string[] = [];

		beforeEach(async () => {
			club = await seedClub();
			// A role the meeting has no slots of yet, so the first index is 0. The
			// key is what `templateMakingTheRoleASpeaker` joins its declared role to
			// — see `addRole` for why it is suffixed, which is not collision.
			roleKey = `vote_counter-${crypto.randomUUID().slice(0, 8)}`;
			roleId = await addRole(club.clubId, "Vote Counter", roleKey);
		});
		afterEach(async () => {
			// `cleanup` FIRST, then the templates — `meetings.template_id` is ON
			// DELETE RESTRICT, so a template still referenced by a live meeting
			// cannot go. Cascading the club takes the meeting out of the way, and
			// then these are deletable. Same order and same reason as
			// `meeting-template-convert.integration.test.ts`, whose header documents
			// that a template outliving `cleanup` is the leak being avoided.
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			if (createdTemplateIds.length > 0) {
				await testDb
					.delete(meetingTemplates)
					.where(inArray(meetingTemplates.id, createdTemplateIds));
				createdTemplateIds.length = 0;
			}
		});

		/**
		 * A template whose declared shape calls THIS run's role the speaker role.
		 * The point of it is the contrast: under `template_id = NULL` the seeded
		 * club has no speaker role at all, so `pairedRoleIds` is empty and `roleId`
		 * is addable; under this template it is the paired lineup and
		 * `applyAddRoleSlot` must refuse it. Nothing about the role row changes —
		 * the only thing that moves is one column on the meeting.
		 *
		 * GLOBAL (`clubId: null`), which is not incidental. A club-owned template
		 * and its meeting both cascade from `DELETE FROM clubs`, and the RESTRICT on
		 * `meetings.template_id` can fire if the template goes first, aborting the
		 * whole teardown. The convert suite's fixture is global for the same reason;
		 * a per-run key keeps two parallel files from colliding on
		 * `meeting_templates_global_key_unique`.
		 */
		async function templateMakingTheRoleASpeaker(): Promise<string> {
			const [tpl] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: null,
					key: `slot-index-lock-${crypto.randomUUID().slice(0, 8)}`,
					name: "Slot index lock fixture",
				})
				.returning({ id: meetingTemplates.id });
			if (!tpl) throw new Error("Failed to insert template");
			createdTemplateIds.push(tpl.id);
			await testDb.insert(meetingTemplateRoles).values({
				templateId: tpl.id,
				key: roleKey,
				name: "Contestant",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 10,
				isSpeakerRole: true,
			});
			return tpl.id;
		}

		/**
		 * Run `add` against a meeting another writer already holds: the writer
		 * takes the meeting row, inserts index 0, lets `add` run for a beat, and
		 * only then commits. The resulting indices say WHEN `add` read.
		 *
		 * The wait is not what discriminates, which is why nothing here asserts on
		 * it: inserting a `role_slots` row takes `FOR KEY SHARE` on the meeting it
		 * references, so even a lock-less add parks behind the writer's
		 * `FOR UPDATE` at its INSERT. It is the numbering READ that either passed
		 * the held row (landing 1) or ran ahead of it on a snapshot that could not
		 * see it (landing a second 0).
		 */
		async function raceAgainstAHeldMeeting(add: () => Promise<unknown>) {
			let started: Promise<unknown> | undefined;
			await testDb.transaction(async (tx) => {
				await lockMeetingRow(tx, club.meetingId);
				await tx.insert(roleSlots).values({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					slotIndex: 0,
				});
				started = add();
				// Long enough for an unlocked read to have happened — the control
				// below is what proves it is.
				await sleep(400);
			});
			await started;
			return indicesFor(club.meetingId, roleId);
		}

		/**
		 * CONTROL, through the same harness as the lock assertion below. The
		 * pre-fix shape numbers from a snapshot taken before the writer committed,
		 * so it lands a second 0.
		 *
		 * Deterministic on purpose. A `Promise.all` of two unlocked adds is NOT the
		 * control: whether it duplicates depends on how the two await profiles
		 * happen to line up, and the minimal mirror here serializes and passes on
		 * its own. A control that only sometimes reproduces the bug proves nothing
		 * on the run where it does not.
		 */
		it("CONTROL: numbering read outside the lock duplicates the index", async () => {
			// Two rows, both at 0 — `buildShortCodes` keys on (role, index), so this
			// is two members holding one badge with the second write winning.
			expect(
				await raceAgainstAHeldMeeting(() =>
					unlockedAddRoleSlot(club.meetingId, roleId),
				),
			).toEqual([0, 0]);
		});

		/**
		 * The lock is only worth taking if the numbering read is BEHIND it. Same
		 * harness as the control, and the only thing that differs is which function
		 * runs: 1 rather than a second 0 is the read having waited for the writer.
		 */
		it("reads the next index after taking the meeting lock, not before", async () => {
			expect(
				await raceAgainstAHeldMeeting(() =>
					applyAddRoleSlot({
						meetingId: club.meetingId,
						roleDefinitionId: roleId,
						actorMemberId: club.adminMemberId,
					}),
				),
			).toEqual([0, 1]);
		});

		/**
		 * Run `add` against a meeting whose ROW is being changed under it: a writer
		 * takes the meeting row, applies `change`, and commits only once `add` is
		 * PROVABLY parked behind that lock. What `add` does next says which copy of
		 * the row its gates judged.
		 *
		 * One harness for both meeting-row columns, because the race is one race —
		 * `status` and `templateId` sit on the same row behind the same lock, and
		 * only the writer's UPDATE differs.
		 *
		 * `waitForLockWait` rather than the sleep above: it reads
		 * `pg_blocking_pids`, so the writer does not commit until the subject is
		 * provably parked behind it, on a shared `tm_test` running ~50 suites at
		 * once.
		 *
		 * Deleting it was measured, and the measurement is recorded here WITHOUT an
		 * explanation because none was established. On one run each, the STATUS
		 * control went red and the SHAPE and SPEAKER controls stayed green — even
		 * though all three issue the same unlocked `meetings.findFirst` as their
		 * first statement, at the same point relative to `commit()`, so whatever
		 * separates them is not the position of that read. It may be nothing more
		 * than run-to-run variance in an unsynchronised race; it was not run enough
		 * times to say. Do not reason from the asymmetry, and do not remove the wait
		 * on the strength of two of the three surviving it.
		 *
		 * What the measurement does settle is the division of labour, and that is
		 * the part to rely on: the wait is what makes the interleaving RELIABLE, and
		 * each control is what makes a failed interleaving VISIBLE. Every control
		 * here reads the pre-commit value, so a writer that ever did land first
		 * turns the CONTROL red rather than letting the pair pass having proved
		 * nothing.
		 */
		async function raceAgainstAMeetingRowChange(
			change: (tx: TestTx) => Promise<unknown>,
			add: () => Promise<unknown>,
		) {
			const writer = await openBlockingTx(async (tx) => {
				await change(tx);
			});
			// Attached to immediately: the fixed arm REJECTS, and a rejection with no
			// handler yet is an unhandled one before the assertion can read it.
			const settled = add().then(
				() => "resolved",
				(e: unknown) => `rejected: ${(e as Error).message}`,
			);
			await waitForLockWait('from "meetings"', writer.pid);
			await writer.commit();
			return {
				outcome: await settled,
				indices: await indicesFor(club.meetingId, roleId),
			};
		}

		/** The writer's UPDATE for the status half: the meeting completes. */
		const completeIt = (tx: TestTx) =>
			tx
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, club.meetingId));

		/** The writer's UPDATE for the shape half: the meeting is converted to a
		 *  template under which this role is the paired speaker lineup. */
		const convertItTo = (templateId: string) => (tx: TestTx) =>
			tx
				.update(meetings)
				.set({ templateId })
				.where(eq(meetings.id, club.meetingId));

		/**
		 * CONTROL for the status half, through that harness. Gated on a row read
		 * before the transaction, the add sails past a meeting that is completed by
		 * the time it writes — a slot on a locked agenda, which is the bug.
		 */
		it("CONTROL: status gated outside the lock adds to a completed meeting", async () => {
			expect(
				await raceAgainstAMeetingRowChange(completeIt, () =>
					statusGatedOutsideTheLock(club.meetingId, roleId),
				),
			).toEqual({ outcome: "resolved", indices: [0] });
		});

		/**
		 * The assertion that control makes meaningful: same interleaving, and the
		 * only thing that differs is which function runs. Refusing — and leaving no
		 * row behind — is `status` having been read from the row the lock holds
		 * rather than from a copy taken before it.
		 */
		it("re-reads status under the lock, so a completing meeting wins the race", async () => {
			expect(
				await raceAgainstAMeetingRowChange(completeIt, () =>
					applyAddRoleSlot({
						meetingId: club.meetingId,
						roleDefinitionId: roleId,
						actorMemberId: club.adminMemberId,
					}),
				),
			).toEqual({
				outcome: `rejected: ${MEETING_LOCKED_MESSAGE}`,
				indices: [],
			});
		});

		/**
		 * CONTROL for the shape half. `templateId` is the quieter of the two
		 * meeting-row reads and the easier one to argue is harmless, which is why it
		 * gets its own pair rather than riding on the status one: gated on a row
		 * read before the transaction, the add sees the OLD shape — where this club
		 * has no speaker role at all — and lands a slot that the meeting's new shape
		 * says belongs to the "+ Add speaker" controls.
		 */
		it("CONTROL: shape gated outside the lock adds a role the new template pairs", async () => {
			const templateId = await templateMakingTheRoleASpeaker();
			expect(
				await raceAgainstAMeetingRowChange(convertItTo(templateId), () =>
					shapeGatedOutsideTheLock(club.meetingId, roleId),
				),
			).toEqual({ outcome: "resolved", indices: [0] });
		});

		/**
		 * The assertion that control makes meaningful. Same interleaving, same
		 * template, and the only thing that differs is which function runs: refusing
		 * with the speaker-controls message is `templateId` having been read from
		 * the locked row, and the shape judged from THAT.
		 */
		it("re-reads templateId under the lock, so a converting meeting wins the race", async () => {
			const templateId = await templateMakingTheRoleASpeaker();
			expect(
				await raceAgainstAMeetingRowChange(convertItTo(templateId), () =>
					applyAddRoleSlot({
						meetingId: club.meetingId,
						roleDefinitionId: roleId,
						actorMemberId: club.adminMemberId,
					}),
				),
			).toEqual({
				outcome: "rejected: Add speakers with the speaker controls.",
				indices: [],
			});
		});

		/**
		 * CONTROL for the speaker path, which is the same race arriving as a
		 * WRONG-ROLE write rather than a wrong refusal. The club has its own Speaker
		 * role, the meeting is being converted to a template whose speaker lineup is
		 * this run's role instead, and an add resolved from the pre-transaction copy
		 * puts its slot on the club's Speaker — so nothing lands on `roleId`.
		 */
		it("CONTROL: speaker role resolved outside the lock adds to the old lineup", async () => {
			await addSpeakerAndEvaluatorRoles(club.clubId);
			const templateId = await templateMakingTheRoleASpeaker();
			expect(
				await raceAgainstAMeetingRowChange(convertItTo(templateId), () =>
					speakerRoleResolvedOutsideTheLock(club.meetingId),
				),
			).toEqual({ outcome: "resolved", indices: [] });
		});

		/**
		 * The assertion that control makes meaningful, and the gate on the review
		 * round that moved `applyAddSpeakerSlot` onto the locked row. Same
		 * interleaving, same template: the slot landing on `roleId` is `clubRoles`
		 * having been resolved from the `templateId` the lock holds.
		 */
		it("resolves the speaker role under the lock, so the new shape's lineup gets the slot", async () => {
			await addSpeakerAndEvaluatorRoles(club.clubId);
			const templateId = await templateMakingTheRoleASpeaker();
			expect(
				await raceAgainstAMeetingRowChange(convertItTo(templateId), () =>
					applyAddSpeakerSlot({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					}),
				),
			).toEqual({ outcome: "resolved", indices: [0] });
		});

		/**
		 * SMOKE, NOT THE GATE — it has no control and cannot have one of the same
		 * kind. Whether two `Promise.all`ed adds overlap where it matters is up to
		 * how their two await profiles happen to line up.
		 *
		 * BE CLEAR ABOUT WHAT IT ASSERTS, because a reader who thinks this only
		 * checks that nothing threw will misdiagnose a red here. It asserts the
		 * indices, `[0, 1]` — the same duplicate check as the deterministic pairs
		 * above, and the reason it is demoted rather than deleted. That assertion
		 * reports ASYMMETRICALLY: against correct code the lock serializes the two
		 * calls and `[0, 1]` is deterministic, so this will not flake red on its
		 * own and a failure here is a REAL duplicate worth chasing; against a broken
		 * shape it may or may not catch it (it did catch the hoisted-read mutation
		 * on one run, and would not have on another). So its passing proves nothing
		 * and it is never the acceptance check. The FOUR deterministic pairs above
		 * — numbering, status, shape, speaker — are what prove the property.
		 */
		it("SMOKE (no control): two overlapping adds land at 0 and 1", async () => {
			await Promise.all([
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
			]);
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0, 1]);
		});

		/**
		 * Both paths now take the SAME single meeting row, which is the property
		 * `lockMeetingForSlotEdit`'s docblock says makes it deadlock-free. Worth
		 * asserting rather than assuming: this fix is what puts a second entry
		 * point on that lock.
		 */
		it("an add-role racing an add-speaker on one meeting does not deadlock", async () => {
			const { speakerRoleId } = await addSpeakerAndEvaluatorRoles(club.clubId);
			const results = await Promise.allSettled([
				applyAddRoleSlot({
					meetingId: club.meetingId,
					roleDefinitionId: roleId,
					actorMemberId: club.adminMemberId,
				}),
				applyAddSpeakerSlot({
					meetingId: club.meetingId,
					actorMemberId: club.adminMemberId,
				}),
			]);
			expect(
				results.map((r) =>
					r.status === "fulfilled"
						? "fulfilled"
						: `rejected: ${(r.reason as Error)?.message}`,
				),
			).toEqual(["fulfilled", "fulfilled"]);
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0]);
			expect(await indicesFor(club.meetingId, speakerRoleId)).toEqual([0]);
		});

		/** Unchanged contract: the append point and the activity-log entry. */
		it("appends after the highest existing index and logs role_added once", async () => {
			await testDb.insert(roleSlots).values([
				{ meetingId: club.meetingId, roleDefinitionId: roleId, slotIndex: 0 },
				{ meetingId: club.meetingId, roleDefinitionId: roleId, slotIndex: 4 },
			]);
			await applyAddRoleSlot({
				meetingId: club.meetingId,
				roleDefinitionId: roleId,
				actorMemberId: club.adminMemberId,
			});
			expect(await indicesFor(club.meetingId, roleId)).toEqual([0, 4, 5]);

			// Scoped to THIS run's club: vitest runs files in parallel against one
			// shared `tm_test` and several suites write `meeting_edit`.
			const entries = await testDb
				.select({
					action: activityLog.action,
					targetType: activityLog.targetType,
					targetId: activityLog.targetId,
					actorMemberId: activityLog.actorMemberId,
					detail: activityLog.detail,
				})
				.from(activityLog)
				.where(eq(activityLog.clubId, club.clubId));
			expect(entries).toEqual([
				{
					action: "meeting_edit",
					targetType: "meeting",
					targetId: club.meetingId,
					actorMemberId: club.adminMemberId,
					detail: { change: "role_added", roleDefinitionId: roleId },
				},
			]);
		});
	},
);
