/**
 * Regression (#437): the signed-in user's own cross-club views resolved the
 * user by taking whatever single roster member a `where(eq(people.userId, …))`
 * join returned first.
 *
 * `people.user_id` is not unique (ADR-0008 / #329 — duplicates predate
 * dedupe-on-write and the merge is a manual superadmin step), so that pick was
 * arbitrary AND single-club, while both callers documented themselves as
 * covering every club the user belongs to.
 *
 * The fixture below is the real shape: ONE account, TWO Persons, one roster
 * membership each in two different clubs. Before the fix both surfaces returned
 * exactly one club's rows, and which club was down to Postgres row order.
 *
 * Club A is seeded NEARER in both directions (its speech is more recent, its
 * upcoming meeting sooner) so ordering is observable rather than incidental,
 * and each club's rows carry per-club-unique strings so an assertion cannot
 * pass by matching the wrong row.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/my-activity.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	clubs,
	meetings,
	members,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
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

const { loadMyCommitments, loadMySpeechLog, loadSpeechLog } = await import(
	"./my-activity-logic"
);

const DAY = 24 * 60 * 60 * 1000;

interface Attached {
	personId: string;
	memberId: string;
	/** Title of the past speech seeded for this club. */
	speechTitle: string;
	/** Name of the upcoming role seeded for this club. */
	roleName: string;
	/** Slot id of the past speaker slot. */
	speechSlotId: string;
	/** Slot id of the upcoming claimed role. */
	upcomingSlotId: string;
	/** When the past speech happened. */
	speechAt: Date;
	/** When the upcoming meeting is. */
	upcomingAt: Date;
	/** Meeting id of the upcoming (non-cancelled) meeting. */
	upcomingMeetingId: string;
}

/**
 * Link `userId` to `club` via a NEW Person + roster member, then give that
 * member one past speech and one upcoming role. Called twice with the same
 * userId to build the duplicate-Person, two-club shape.
 *
 * `dayOffset` staggers both dates so the two clubs are strictly orderable:
 * club A (offset 0) is the more recent speech AND the sooner meeting.
 */
async function attachToClub(
	club: SeededClub,
	userId: string,
	label: string,
	dayOffset: number,
): Promise<Attached> {
	// `seedClub()` hardcodes the club name "Test Club" and the member name
	// "Member User" for EVERY club, and both clubs take the same `clubs.timezone`
	// default. A golden-row literal like `clubName: "Test Club"` would therefore
	// still match if the join had resolved the OTHER club's row — which is
	// exactly the cross-club defect this file exists to catch. Give each club
	// discriminating values first.
	await testDb
		.update(clubs)
		.set({
			name: `Club ${label}`,
			timezone: label === "A" ? "America/Chicago" : "Europe/London",
		})
		.where(eq(clubs.id, club.clubId));
	await testDb
		.update(members)
		.set({ name: `Evaluator Human ${label}` })
		.where(eq(members.id, club.memberId));

	const [personRow] = await testDb
		.insert(people)
		.values({
			name: `Dup Human (${label})`,
			email: `${randomUUID()}@test.example`,
			userId,
		})
		.returning({ id: people.id });

	const [memberRow] = await testDb
		.insert(members)
		.values({
			clubId: club.clubId,
			personId: personRow.id,
			name: `Dup Human (${label})`,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });

	// Speaker role — loadSpeechLog filters on isSpeakerRole.
	const [speakerRole] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: `Speaker ${label}`,
			category: "speaker",
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });

	// --- past: one delivered speech ---
	const speechAt = new Date(Date.now() - (7 + dayOffset) * DAY);
	const [pastMeeting] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: speechAt,
			status: "completed",
		})
		.returning({ id: meetings.id });

	const speechTitle = `Speech in ${label}`;
	const [speech] = await testDb
		.insert(speeches)
		.values({
			personId: personRow.id,
			title: speechTitle,
			pathwayPath: `Path ${label}`,
			projectName: `Project ${label}`,
			projectLevel: `Level ${label}`,
		})
		.returning({ id: speeches.id });

	const [speechSlot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: pastMeeting.id,
			roleDefinitionId: speakerRole.id,
			assignedMemberId: memberRow.id,
			speechId: speech.id,
			status: "confirmed",
		})
		.returning({ id: roleSlots.id });

	// An evaluator for that speech, so `evaluatorName` (rendered on both the
	// dashboard log and the member profile) has a value to assert.
	const [evaluatorRole] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: `Evaluator ${label}`,
			category: "evaluator",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });

	await testDb.insert(roleSlots).values({
		meetingId: pastMeeting.id,
		roleDefinitionId: evaluatorRole.id,
		// The club's own seeded member evaluates — a DIFFERENT human, so the
		// name cannot be confused with the speaker's.
		assignedMemberId: club.memberId,
		evaluatesSlotId: speechSlot.id,
		// Deliberately NOT "confirmed": the speaker slot is, so a select that
		// read `status` off the evaluator alias instead of the speaker would
		// otherwise return an identical value and pass.
		status: "claimed",
	});

	// --- upcoming: one claimed role ---
	const roleName = `Timer ${label}`;
	const [upcomingRole] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name: roleName,
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });

	const upcomingAt = new Date(Date.now() + (3 + dayOffset) * DAY);
	// theme / location / lengthMinutes are set to DISTINCT non-default values so
	// the golden-row assertion pins real columns. Left at their defaults they
	// were three interchangeable nulls plus a default 90, and a select that
	// swapped one for another still matched.
	const [upcomingMeeting] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: upcomingAt,
			status: "scheduled",
			theme: `Theme ${label}`,
			location: `Location ${label}`,
			lengthMinutes: 75 + dayOffset,
		})
		.returning({ id: meetings.id });

	const [upcomingSlot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: upcomingMeeting.id,
			roleDefinitionId: upcomingRole.id,
			assignedMemberId: memberRow.id,
			status: "confirmed",
		})
		.returning({ id: roleSlots.id });

	// A CANCELLED upcoming meeting holding a claimed role. It must never show
	// up as a commitment — a cancelled meeting is not something you owe.
	const [cancelledMeeting] = await testDb
		.insert(meetings)
		.values({
			clubId: club.clubId,
			scheduledAt: new Date(Date.now() + 1 * DAY),
			status: "cancelled",
		})
		.returning({ id: meetings.id });

	await testDb.insert(roleSlots).values({
		meetingId: cancelledMeeting.id,
		roleDefinitionId: upcomingRole.id,
		assignedMemberId: memberRow.id,
		status: "confirmed",
	});

	return {
		personId: personRow.id,
		memberId: memberRow.id,
		speechTitle,
		roleName,
		speechSlotId: speechSlot.id,
		upcomingSlotId: upcomingSlot.id,
		speechAt,
		upcomingAt,
		upcomingMeetingId: upcomingMeeting.id,
	};
}

describe.skipIf(!hasTestDb)("my cross-club activity (#437)", () => {
	let clubA: SeededClub;
	let clubB: SeededClub;
	let userId: string;
	let inA: Attached;
	let inB: Attached;

	beforeEach(async () => {
		clubA = await seedClub();
		clubB = await seedClub();
		userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Dup Human",
			email: `${userId}@test.example`,
		});
		// A is the nearer club in both directions (offset 0 vs 7), but B is
		// seeded FIRST on purpose: insert order must be the OPPOSITE of the
		// expected output order. Seeded A-first, Postgres's natural scan order
		// already equalled the wanted order, so DELETING either `ORDER BY`
		// outright still passed — only a direction FLIP was caught.
		inB = await attachToClub(clubB, userId, "B", 7);
		inA = await attachToClub(clubA, userId, "A", 0);
	});

	afterEach(async () => {
		await cleanup(clubA.clubId, [clubA.adminUserId, clubA.memberUserId]);
		// userId last: its Person in club A is gone by now, and its Person in
		// club B goes with this cascade, so the user row is unreferenced.
		await cleanup(clubB.clubId, [
			clubB.adminUserId,
			clubB.memberUserId,
			userId,
		]);
		vi.restoreAllMocks();
	});

	// The fixture is only meaningful if the two Persons really are distinct rows
	// on one account — otherwise every assertion below passes trivially.
	it("seeds two distinct Persons on one account, one per club", () => {
		expect(inA.personId).not.toBe(inB.personId);
		expect(inA.memberId).not.toBe(inB.memberId);
	});

	it("speech log covers every club, not one arbitrary membership", async () => {
		const log = await loadMySpeechLog(userId, 6);
		const titles = log.map((r) => r.speechTitle);
		expect(titles).toContain(inA.speechTitle);
		expect(titles).toContain(inB.speechTitle);
		expect(log).toHaveLength(2);
	});

	// Ordering is a documented promise of this query ("most recent first") and
	// the dashboard renders it in the returned order.
	it("speech log returns most-recent first, across clubs", async () => {
		const log = await loadMySpeechLog(userId, 6);
		expect(log.map((r) => r.speechTitle)).toEqual([
			inA.speechTitle, // now - 7d
			inB.speechTitle, // now - 14d
		]);
	});

	it("speech log honours the limit, keeping the newest", async () => {
		const log = await loadMySpeechLog(userId, 1);
		expect(log).toHaveLength(1);
		expect(log[0].speechTitle).toBe(inA.speechTitle);
	});

	// Golden output for the whole row shape. Every field the dashboard and the
	// member profile render is pinned here — a broken join or a dropped column
	// shows up as a diff instead of passing unnoticed (CLAUDE.md coverage trap #2).
	it("speech log row carries every rendered field", async () => {
		const log = await loadMySpeechLog(userId, 6);
		expect(log[0]).toEqual({
			slotId: inA.speechSlotId,
			scheduledAt: inA.speechAt,
			roleName: "Speaker A",
			speechTitle: "Speech in A",
			projectName: "Project A",
			pathwayPath: "Path A",
			projectLevel: "Level A",
			// Resolved through the evaluator self-join, not the speaker's row.
			evaluatorName: "Evaluator Human A",
			status: "confirmed",
		});
	});

	it("commitments cover every club, not one arbitrary membership", async () => {
		const commitments = await loadMyCommitments(userId);
		const roles = commitments.map((r) => r.roleName);
		expect(roles).toContain(inA.roleName);
		expect(roles).toContain(inB.roleName);
		expect(commitments).toHaveLength(2);
	});

	it("commitments are soonest-first, across clubs", async () => {
		const commitments = await loadMyCommitments(userId);
		expect(commitments.map((r) => r.roleName)).toEqual([
			inA.roleName, // now + 3d
			inB.roleName, // now + 10d
		]);
	});

	// A cancelled meeting is seeded SOONER than either real one, so if the
	// status filter were dropped it would sort to the front and break both the
	// length and the ordering assertions.
	it("commitments exclude cancelled meetings", async () => {
		const commitments = await loadMyCommitments(userId);
		expect(commitments).toHaveLength(2);
		// `meetingId` is a NOT NULL primary key reached through an innerJoin, so
		// a null-check there could never fail; the identity + length assertions
		// below are what actually pin the cancelled row out of the result.
		const meetingIds = commitments.map((c) => c.meetingId);
		expect(meetingIds).toEqual([inA.upcomingMeetingId, inB.upcomingMeetingId]);
	});

	// Archive takedown (#560). `loadMyCommitments` carries `clubName` plus the
	// meeting's date, theme, location and speech title — the same payload the PUBLIC
	// sibling `listMemberCommitments` was gated for in #544, while this authed twin
	// kept serving it on `/dashboard` and `/me`.
	//
	// The two-club fixture is what makes this fail-able: archiving A must remove
	// exactly A's row and leave B's, so a filter that scoped to the USER rather than
	// the row (emptying the list) fails just as loudly as no filter at all.
	it("commitments exclude an archived club, and keep the live one", async () => {
		// Control: both clubs present, and A's name is on the payload.
		const before = await loadMyCommitments(userId);
		expect(before.map((r) => r.clubName)).toEqual(["Club A", "Club B"]);

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, clubA.clubId));

		const after = await loadMyCommitments(userId);
		expect(after.map((r) => r.clubName)).toEqual(["Club B"]);
		expect(after.map((r) => r.meetingId)).toEqual([inB.upcomingMeetingId]);

		// Unarchive restores it — archiving is soft and reversible (ADR-0016).
		await testDb
			.update(clubs)
			.set({ archivedAt: null })
			.where(eq(clubs.id, clubA.clubId));
		expect((await loadMyCommitments(userId)).map((r) => r.clubName)).toEqual([
			"Club A",
			"Club B",
		]);
	});

	// Every field pinned to a LITERAL. `expect.any(Number)`/`expect.any(String)`
	// let a select swap one column for another of the same type and still pass.
	it("commitment row carries every rendered field", async () => {
		const commitments = await loadMyCommitments(userId);
		expect(commitments[0]).toEqual({
			slotId: inA.upcomingSlotId,
			status: "confirmed",
			meetingId: inA.upcomingMeetingId,
			scheduledAt: inA.upcomingAt,
			lengthMinutes: 75,
			theme: "Theme A",
			location: "Location A",
			clubName: "Club A",
			timezone: "America/Chicago",
			roleName: inA.roleName,
			isSpeakerRole: false,
			// The two columns the commitment cards gate the evaluation-resource
			// link on. This row is a Timer — a functionary with no evaluation
			// target — so it fails every arm of that gate and renders no link.
			evaluatesSlotId: null,
			roleCategory: "functionary",
			// Null here is meaningful (a functionary role has no speech) and is
			// now distinguishable from theme/location, which carry real values.
			speechTitle: null,
			// Neither an evaluator target nor a speech of its own — a plain
			// functionary (Timer) role. See the evaluator-resolution suite below
			// for the self-join that fills these in.
			evaluatedProjectName: null,
			ownProjectName: null,
		});
	});

	// The defect was not only "too few rows" — it was that WHICH rows you got
	// was down to Postgres row order, so two calls in one request could disagree.
	it("returns the same answer on repeated calls", async () => {
		const runs = await Promise.all([
			loadMySpeechLog(userId, 6),
			loadMySpeechLog(userId, 6),
			loadMySpeechLog(userId, 6),
		]);
		// Agreement alone proves nothing: three sequential scans of a two-row
		// result never diverge in one Postgres process, so this passed even with
		// the ORDER BY deleted outright. Pin the EXPECTED sequence on every run
		// instead — then agreement and correctness are the same assertion.
		const expected = [inA.speechSlotId, inB.speechSlotId];
		for (const run of runs) {
			expect(run.map((r) => r.slotId)).toEqual(expected);
		}
	});

	it("an account with no linked membership gets empty results", async () => {
		const strangerId = randomUUID();
		await testDb.insert(user).values({
			id: strangerId,
			name: "No Roster",
			email: `${strangerId}@test.example`,
		});
		try {
			expect(await loadMySpeechLog(strangerId, 6)).toEqual([]);
			expect(await loadMyCommitments(strangerId)).toEqual([]);
		} finally {
			await testDb.delete(user).where(eq(user.id, strangerId));
		}
	});

	// The club-scoped caller (getMemberProfile) must keep its old behavior: one
	// member, one club. Widening the resolver must not widen that surface, or a
	// member's club profile would start showing another club's speeches.
	it("club-scoped speech log still shows only that club's speeches", async () => {
		const scoped = await loadSpeechLog([inA.memberId], clubA.clubId, 6);
		expect(scoped.map((r) => r.speechTitle)).toEqual([inA.speechTitle]);

		// ...and passing the other club's id yields nothing for that member.
		expect(await loadSpeechLog([inA.memberId], clubB.clubId, 6)).toEqual([]);
	});

	// The empty-list guards are an optimization, not a correctness fix: drizzle
	// compiles an empty `inArray` to `false`, so removing them still returns [].
	// Asserting the RESULT therefore cannot fail. Assert the round-trip is
	// skipped instead — that is the only observable the guard actually controls.
	it("empty member list short-circuits without querying the db", async () => {
		const selectSpy = vi.spyOn(testDb, "select");
		expect(await loadSpeechLog([], null, 6)).toEqual([]);
		expect(selectSpy).not.toHaveBeenCalled();
	});

	it("a membership-less account short-circuits the commitments query", async () => {
		const strangerId = randomUUID();
		await testDb.insert(user).values({
			id: strangerId,
			name: "No Roster",
			email: `${strangerId}@test.example`,
		});
		try {
			// One select resolves the (empty) member ids; the commitments query
			// itself must never run.
			const selectSpy = vi.spyOn(testDb, "select");
			expect(await loadMyCommitments(strangerId)).toEqual([]);
			expect(selectSpy).toHaveBeenCalledTimes(1);
		} finally {
			await testDb.delete(user).where(eq(user.id, strangerId));
		}
	});
});

/**
 * The member holding a slot is often the EVALUATOR, not the speaker — the
 * resource they need is the project of the speech they are evaluating, which
 * `loadMyCommitments` used to leave null (it only ever joined `speeches` on
 * the row's OWN `speechId`, which an evaluator slot never has). This suite
 * pins the self-join that resolves it via `evaluatesSlotId` → speaker slot →
 * speech → catalog project.
 *
 * Fixture note: the brief for this task named `seedMeetingWithSpeaker` /
 * `addSlot` helpers that do not exist anywhere in this file or repo. These are
 * new, file-local helpers written to fit that shape, following the pattern of
 * `attachToClub` above and `addSlot` in `reporting.integration.test.ts`.
 */
describe.skipIf(!hasTestDb)(
	"evaluator sees the evaluated speech's project",
	() => {
		// Each test seeds its own fresh club (rather than sharing one via
		// beforeEach) because the shape varies per test: whether the speaker is
		// a separate member from the viewer, whether a speech exists at all, and
		// whether a catalog project backs it. Teardown is collected as thunks
		// rather than tracked ids, since only some tests create pathway rows.
		let teardown: Array<() => Promise<unknown>> = [];

		beforeEach(() => {
			teardown = [];
		});

		afterEach(async () => {
			// Reverse order: a pathways_paths delete (added after the club it
			// belongs to, conceptually) should not depend on running before or
			// after the club cascade — both tables are independent — but running
			// teardown LIFO matches how the resources were acquired.
			for (const fn of teardown.slice().reverse()) {
				await fn();
			}
		});

		interface SeededSpeakerMeeting {
			userId: string;
			memberId: string;
			meetingId: string;
			speakerSlotId: string;
		}

		/**
		 * A club with one upcoming (non-cancelled) meeting holding a speaker
		 * slot. The returned `userId`/`memberId` are the VIEWER's own roster
		 * membership — by default a DIFFERENT member holds the speaker slot, so
		 * a test can assign the viewer to evaluate them; `assignToUser` collapses
		 * the two for the "speaker sees their own project" case.
		 */
		async function seedMeetingWithSpeaker(
			opts: {
				projectName?: string | null;
				catalogProjectName?: string;
				speech?: null;
				assignToUser?: boolean;
			} = {},
		): Promise<SeededSpeakerMeeting> {
			const club: SeededClub = await seedClub();
			teardown.push(() =>
				cleanup(club.clubId, [club.adminUserId, club.memberUserId]),
			);

			const [speakerRole] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: club.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			if (!speakerRole) throw new Error("speaker role insert failed");

			const [meeting] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date(Date.now() + 5 * DAY),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			if (!meeting) throw new Error("meeting insert failed");

			let speakerMemberId = club.memberId;
			let speakerPersonId = club.personId;
			if (!opts.assignToUser) {
				speakerPersonId = await seedPerson({ name: "Other Speaker" });
				const [speakerMember] = await testDb
					.insert(members)
					.values({
						clubId: club.clubId,
						personId: speakerPersonId,
						name: "Other Speaker",
						clubRole: "member",
						status: "active",
					})
					.returning({ id: members.id });
				if (!speakerMember) throw new Error("speaker member insert failed");
				speakerMemberId = speakerMember.id;
			}

			let speechId: string | null = null;
			if (opts.speech !== null) {
				let projectId: string | null = null;
				if (opts.catalogProjectName) {
					const [path] = await testDb
						.insert(pathwaysPaths)
						.values({
							courseCode: `eval-test-${randomUUID()}`,
							name: "Test Path",
						})
						.returning({ id: pathwaysPaths.id });
					if (!path) throw new Error("path insert failed");
					// Deletes cascade onto the pathways_projects row inserted below —
					// pathways_paths/pathways_projects are global catalog tables, not
					// club-scoped, so `cleanup()`'s club cascade never reaches them.
					teardown.push(() =>
						testDb.delete(pathwaysPaths).where(eq(pathwaysPaths.id, path.id)),
					);
					const [project] = await testDb
						.insert(pathwaysProjects)
						.values({
							pathId: path.id,
							level: 1,
							name: opts.catalogProjectName,
						})
						.returning({ id: pathwaysProjects.id });
					if (!project) throw new Error("project insert failed");
					projectId = project.id;
				}
				const [speech] = await testDb
					.insert(speeches)
					.values({
						personId: speakerPersonId,
						title: "A speech",
						projectName: opts.projectName ?? null,
						projectId,
					})
					.returning({ id: speeches.id });
				if (!speech) throw new Error("speech insert failed");
				speechId = speech.id;
			}

			const [speakerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: meeting.id,
					roleDefinitionId: speakerRole.id,
					assignedMemberId: speakerMemberId,
					speechId,
					status: "confirmed",
				})
				.returning({ id: roleSlots.id });
			if (!speakerSlot) throw new Error("speaker slot insert failed");

			return {
				userId: club.memberUserId,
				memberId: club.memberId,
				meetingId: meeting.id,
				speakerSlotId: speakerSlot.id,
			};
		}

		/**
		 * An additional slot on `meetingId` — the evaluator or functionary side of
		 * the fixture.
		 *
		 * `category` is passed EXPLICITLY rather than sniffed out of `roleName`
		 * (this helper used to derive it as
		 * `roleName.includes("evaluat") ? "evaluator" : "functionary"`).
		 * `loadMyCommitments` now SELECTS that column and the commitment cards gate
		 * on it, so a fixture whose category comes from a string match on a name a
		 * club is free to choose would be deciding what the card renders by
		 * accident.
		 */
		async function addSlot(opts: {
			meetingId: string;
			roleName: string;
			category: "leadership" | "speaker" | "evaluator" | "functionary";
			assignedMemberId: string;
			evaluatesSlotId?: string;
		}): Promise<string> {
			const [meetingRow] = await testDb
				.select({ clubId: meetings.clubId })
				.from(meetings)
				.where(eq(meetings.id, opts.meetingId));
			if (!meetingRow) throw new Error("meeting not found");

			const [roleDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: meetingRow.clubId,
					name: opts.roleName,
					category: opts.category,
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!roleDef) throw new Error("role definition insert failed");

			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: opts.meetingId,
					roleDefinitionId: roleDef.id,
					assignedMemberId: opts.assignedMemberId,
					evaluatesSlotId: opts.evaluatesSlotId ?? null,
					status: "confirmed",
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("slot insert failed");
			return slot.id;
		}

		it("gives an evaluator the project of the speech they evaluate", async () => {
			// Full fixture: speaker slot carrying a speech with a catalog project,
			// plus an evaluator slot pointing at it via evaluates_slot_id.
			const { userId, memberId, meetingId, speakerSlotId } =
				await seedMeetingWithSpeaker({ projectName: "Active Listening" });
			const evaluatorSlotId = await addSlot({
				meetingId,
				roleName: "Evaluator",
				category: "evaluator",
				assignedMemberId: memberId,
				evaluatesSlotId: speakerSlotId,
			});

			const rows = await loadMyCommitments(userId);
			const row = rows.find((r) => r.slotId === evaluatorSlotId);
			expect(row?.evaluatedProjectName).toBe("Active Listening");
			// The evaluator has no speech of their own.
			expect(row?.ownProjectName).toBeNull();
		});

		it("prefers the catalog project name over stale free text", async () => {
			const { userId, memberId, meetingId, speakerSlotId } =
				await seedMeetingWithSpeaker({
					projectName: "typed by hand years ago",
					catalogProjectName: "Persuasive Speaking",
				});
			const evaluatorSlotId = await addSlot({
				meetingId,
				roleName: "Evaluator",
				category: "evaluator",
				assignedMemberId: memberId,
				evaluatesSlotId: speakerSlotId,
			});

			const rows = await loadMyCommitments(userId);
			expect(
				rows.find((r) => r.slotId === evaluatorSlotId)?.evaluatedProjectName,
			).toBe("Persuasive Speaking");
		});

		it("leaves the evaluated project null for a TBA speech", async () => {
			// An evaluator can be assigned before the speaker attaches a speech.
			// The card falls back to the generic resource; the loader must not
			// invent a name.
			const { userId, memberId, meetingId, speakerSlotId } =
				await seedMeetingWithSpeaker({ speech: null });
			const evaluatorSlotId = await addSlot({
				meetingId,
				roleName: "Evaluator",
				category: "evaluator",
				assignedMemberId: memberId,
				evaluatesSlotId: speakerSlotId,
			});

			const rows = await loadMyCommitments(userId);
			expect(
				rows.find((r) => r.slotId === evaluatorSlotId)?.evaluatedProjectName,
			).toBeNull();
		});

		it("still gives a speaker their own project", async () => {
			const { userId, speakerSlotId } = await seedMeetingWithSpeaker({
				projectName: "Ice Breaker",
				assignToUser: true,
			});
			const rows = await loadMyCommitments(userId);
			const row = rows.find((r) => r.slotId === speakerSlotId);
			expect(row?.ownProjectName).toBe("Ice Breaker");
			expect(row?.evaluatedProjectName).toBeNull();
		});

		/**
		 * `evaluatesSlotId` and `roleCategory` are what the commitment cards gate
		 * the evaluation-resource link on: without them the link rendered on every
		 * FUNCTIONARY row (Timer, Ah-Counter, Grammarian…), which is most of a
		 * typical agenda, each advertising "Generic evaluation resource". Both are
		 * plain columns off tables the statement already joins — see
		 * `my-commitments-query.integration.test.ts`, which pins that adding them
		 * did not add a round trip.
		 */
		it("carries the gate columns for an evaluator", async () => {
			const { userId, memberId, meetingId, speakerSlotId } =
				await seedMeetingWithSpeaker({ projectName: "Active Listening" });
			const evaluatorSlotId = await addSlot({
				meetingId,
				roleName: "Evaluator",
				category: "evaluator",
				assignedMemberId: memberId,
				evaluatesSlotId: speakerSlotId,
			});

			const rows = await loadMyCommitments(userId);
			const row = rows.find((r) => r.slotId === evaluatorSlotId);
			expect(row?.evaluatesSlotId).toBe(speakerSlotId);
			expect(row?.roleCategory).toBe("evaluator");
			expect(row?.isSpeakerRole).toBe(false);
		});

		it("carries the gate columns for an evaluator with no target yet", async () => {
			// A club can name the role anything and an officer can create the slot
			// before pointing it at a speaker, so `evaluatesSlotId` alone is not
			// enough — `roleCategory` is the second arm of the gate for exactly this
			// row, which would otherwise render nothing for a real evaluator.
			const { userId, memberId, meetingId } = await seedMeetingWithSpeaker({
				projectName: "Active Listening",
			});
			const slotId = await addSlot({
				meetingId,
				roleName: "Speech Reviewer",
				category: "evaluator",
				assignedMemberId: memberId,
			});

			const row = (await loadMyCommitments(userId)).find(
				(r) => r.slotId === slotId,
			);
			expect(row?.evaluatesSlotId).toBeNull();
			expect(row?.roleCategory).toBe("evaluator");
		});

		it("carries the gate columns for a functionary", async () => {
			// Fails all three arms of the gate, so the card renders no link at all.
			const { userId, memberId, meetingId } = await seedMeetingWithSpeaker({
				projectName: "Active Listening",
			});
			const timerSlotId = await addSlot({
				meetingId,
				roleName: "Timer",
				category: "functionary",
				assignedMemberId: memberId,
			});

			const row = (await loadMyCommitments(userId)).find(
				(r) => r.slotId === timerSlotId,
			);
			expect(row?.roleCategory).toBe("functionary");
			expect(row?.evaluatesSlotId).toBeNull();
			expect(row?.isSpeakerRole).toBe(false);
			// And nothing for the link to point at either way.
			expect(row?.ownProjectName).toBeNull();
			expect(row?.evaluatedProjectName).toBeNull();
		});

		it("carries the gate columns for a speaker", async () => {
			const { userId, speakerSlotId } = await seedMeetingWithSpeaker({
				projectName: "Ice Breaker",
				assignToUser: true,
			});
			const row = (await loadMyCommitments(userId)).find(
				(r) => r.slotId === speakerSlotId,
			);
			expect(row?.isSpeakerRole).toBe(true);
			expect(row?.roleCategory).toBe("speaker");
			expect(row?.evaluatesSlotId).toBeNull();
		});
	},
);
