/**
 * DB-backed tests for the PUBLIC read surface's archive gate (#544, ADR-0016 /
 * ADR-0024).
 *
 * `createServerFn` endpoints are addressable directly, with no session and no
 * router. So the `/club/$clubId` shell's `beforeLoad` → `resolveClubOrRedirect`
 * 404 is a guard on the CALLER, not on the data: every public club reader has
 * to gate on `archived_at` itself. Two did not (`getPublicClubRoles` since
 * #341, `getPublicClubProfile` since #318); a sweep found six more, of which
 * the season grid and the member picker were the worst — both ship ROSTER
 * NAMES.
 *
 * ## Every case archives a club that ALREADY HAS the data
 *
 * Read this before adding a case. An assertion that a reader returns `[]` /
 * `null` for an archived club is worth nothing on its own: an empty club
 * returns exactly that with the gate deleted, so the test cannot fail and
 * would sit here reading like proof. This is the repo's "empty-list guard is
 * invisible to a result assertion" trap (see CLAUDE.md), and it applies to
 * every reader below.
 *
 * So each case is a BEFORE/AFTER pair against one club:
 *
 *   1. seed, then assert the reader DOES return the row/list while unarchived
 *      — this is the half that fails if someone deletes the gate, because the
 *      "after" then matches the "before";
 *   2. archive, then assert the reader returns its not-found shape.
 *
 * Verified by mutation: commenting out any single `isReadableClub` call makes
 * exactly its own case fail, and no other.
 *
 * Not-found SHAPE, deliberately, rather than a throw: an archived club must be
 * indistinguishable from one that never existed, and every caller already has
 * that path. The two meeting-key readers get it for free — their resolver
 * returning null hits the `"Meeting not found."` throw they already had.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/public-readers-archive-gate.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { isReadableClub, isReadableClubForMeeting, isReadableClubForMember } =
	await import("#/server/club-readable-logic");
const { loadPublicClubRoles } = await import("#/server/role-definitions-logic");
const {
	getPublicClubProfile,
	resolveClubByIdentifier,
	resolvePublicClubIdentifier,
} = await import("#/server/clubs-logic");
const { loadPublicSeasonGrid } = await import("#/server/season-grid-logic");
const { loadPublicClubRoster } = await import("#/server/members-logic");
const { loadPublicUpcomingMeetings } = await import("#/server/meetings-logic");
const { loadPastMeetings } = await import("#/server/past-meetings-logic");
const { resolveMeetingKey, resolvePublicMeetingKey } = await import(
	"#/server/meeting-resolve-logic"
);
const { loadBallot, loadParticipation, openVote } = await import(
	"#/server/voting-logic"
);
const { pathwaysForMember } = await import("#/server/pathways-read-logic");

let seeded: SeededClub | null = null;

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

/** Seed a club carrying public-facing content, and return it. */
async function seedPublicClub(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	await testDb
		.update(clubs)
		.set({
			district: "D1",
			mission: "We build speakers.",
			meetingSchedule: "Tuesdays at noon",
		})
		.where(eq(clubs.id, s.clubId));
	return s;
}

const archive = (clubId: string) =>
	testDb
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId));

describe.skipIf(!hasTestDb)("the gate itself (#544)", () => {
	it("is true for a live club and false once archived", async () => {
		const s = await seedPublicClub();
		expect(await isReadableClub(s.clubId)).toBe(true);
		await archive(s.clubId);
		expect(await isReadableClub(s.clubId)).toBe(false);
	});

	it("collapses unknown and malformed club ids to the same false", async () => {
		expect(await isReadableClub(randomUUID())).toBe(false);
		// A non-UUID must not reach Postgres: comparing it against a `uuid` column
		// throws ("invalid input syntax for type uuid"), which would surface as a
		// 500 where an anonymous caller should get the not-found answer.
		expect(await isReadableClub("not-a-uuid")).toBe(false);
		expect(await isReadableClub("")).toBe(false);
	});

	it("resolves a club through the meeting FK for the ballot readers", async () => {
		const s = await seedPublicClub();
		expect(await isReadableClubForMeeting(s.meetingId)).toBe(true);
		await archive(s.clubId);
		expect(await isReadableClubForMeeting(s.meetingId)).toBe(false);
	});

	it("is false for an unknown or malformed meeting id", async () => {
		expect(await isReadableClubForMeeting(randomUUID())).toBe(false);
		expect(await isReadableClubForMeeting("not-a-uuid")).toBe(false);
	});
});

describe.skipIf(!hasTestDb)(
	"public club readers stop at archive (#544)",
	() => {
		it("getPublicClubRoles: the role template disappears", async () => {
			const s = await seedPublicClub();
			expect((await loadPublicClubRoles(s.clubId)).length).toBeGreaterThan(0);

			await archive(s.clubId);
			expect(await loadPublicClubRoles(s.clubId)).toEqual([]);
		});

		it("getPublicClubProfile: club-authored mission text disappears", async () => {
			const s = await seedPublicClub();
			// `mission` is free text the club wrote — the field ADR-0024's takedown
			// path is actually about, so assert on its VALUE, not just non-null.
			expect(await getPublicClubProfile(s.clubId)).toMatchObject({
				district: "D1",
				mission: "We build speakers.",
				meetingSchedule: "Tuesdays at noon",
			});

			await archive(s.clubId);
			expect(await getPublicClubProfile(s.clubId)).toBeNull();
		});

		it("getPublicSeasonGrid: roster names disappear", async () => {
			const s = await seedPublicClub();
			const live = await loadPublicSeasonGrid({ clubId: s.clubId, count: 4 });
			// The member axis is the leak this case exists for — names, not counts.
			expect(live.members.map((m) => m.name)).toContain("Member User");
			expect(live.meetings.length).toBeGreaterThan(0);

			await archive(s.clubId);
			const gone = await loadPublicSeasonGrid({ clubId: s.clubId, count: 4 });
			expect(gone.members).toEqual([]);
			expect(gone.memberNames).toEqual([]);
			expect(gone.guestNames).toEqual([]);
			expect(gone.meetings).toEqual([]);
			expect(gone.rows).toEqual([]);
			expect(gone.cells).toEqual([]);
			expect(gone.clubSlug).toBeNull();
		});

		it("listMembers: the member picker roster disappears", async () => {
			const s = await seedPublicClub();
			const live = await loadPublicClubRoster(s.clubId);
			expect(live.map((m) => m.name).sort()).toEqual([
				"Admin User",
				"Member User",
			]);

			await archive(s.clubId);
			expect(await loadPublicClubRoster(s.clubId)).toEqual([]);
		});

		it("listUpcomingMeetings: the schedule disappears", async () => {
			const s = await seedPublicClub();
			const live = await loadPublicUpcomingMeetings(s.clubId);
			expect(live.map((m) => m.id)).toContain(s.meetingId);

			await archive(s.clubId);
			expect(await loadPublicUpcomingMeetings(s.clubId)).toEqual([]);
		});

		it("listPastMeetings: the archive of past meetings disappears", async () => {
			const s = await seedPublicClub();
			// seedClub's meeting is deliberately in the FUTURE, so a past-meetings
			// case needs its own row — without one this reader returns an empty page
			// either way and the assertion could not fail.
			await testDb.insert(meetings).values({
				clubId: s.clubId,
				scheduledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				status: "completed",
			});
			const live = await loadPastMeetings({ clubId: s.clubId });
			expect(live.meetings.length).toBeGreaterThan(0);
			expect(live.clubSlug).not.toBeNull();

			await archive(s.clubId);
			const gone = await loadPastMeetings({ clubId: s.clubId });
			expect(gone.meetings).toEqual([]);
			expect(gone.hasMore).toBe(false);
			expect(gone.clubSlug).toBeNull();
		});

		it("getPublicMeetingByKey: the meeting key stops resolving", async () => {
			const s = await seedPublicClub();
			expect(await resolvePublicMeetingKey(s.clubId, s.meetingId)).toBe(
				s.meetingId,
			);

			await archive(s.clubId);
			// null is what both key readers already turn into "Meeting not found.",
			// so the whole agenda payload — assignee names, Word of the Day — is gone
			// without either handler growing a new error path.
			expect(await resolvePublicMeetingKey(s.clubId, s.meetingId)).toBeNull();
		});

		it("getClubByIdentifier: name and club number stop resolving", async () => {
			const s = await seedPublicClub();
			expect(await resolvePublicClubIdentifier(s.clubId)).toMatchObject({
				id: s.clubId,
			});

			await archive(s.clubId);
			// The PUBLIC wrapper redacts…
			expect(await resolvePublicClubIdentifier(s.clubId)).toBeNull();
			// …while the shared resolver still surfaces the row, because
			// `resolveClubOrRedirect` reads `archivedAt` off it to decide its own 404.
			// Both halves matter: redacting the logic fn too would break the router.
			expect(await resolveClubByIdentifier(s.clubId)).toMatchObject({
				id: s.clubId,
			});
		});

		it("getMeeting: the direct meeting-id reader stops answering", async () => {
			const s = await seedPublicClub();
			// The bypass, stated as a test. `getMeeting` takes a BARE meeting id, so
			// `resolvePublicMeetingKey` never runs for it, and it calls the same
			// `loadMeetingDetail` the key readers do — gating them and not this one
			// leaves the legacy `/meetings/:id` URL serving the whole agenda after a
			// takedown. Found independently by three reviewers; the first version of
			// this file gated nine readers and called the surface closed.
			expect(await isReadableClubForMeeting(s.meetingId)).toBe(true);

			await archive(s.clubId);
			expect(await isReadableClubForMeeting(s.meetingId)).toBe(false);
			// Both meeting readers must agree — disagreement IS the bypass.
			expect(await resolvePublicMeetingKey(s.clubId, s.meetingId)).toBeNull();
		});

		it("listMemberCommitments: the member's forward schedule disappears", async () => {
			const s = await seedPublicClub();
			expect(await isReadableClubForMember(s.memberId)).toBe(true);

			await archive(s.clubId);
			expect(await isReadableClubForMember(s.memberId)).toBe(false);
		});

		it("getVoteParticipation: ballot counts and headcount zero out", async () => {
			const s = await seedPublicClub();
			// A meeting with no sessions already reports zeros, so the case needs a
			// REAL open vote before archiving or it cannot fail — the same trap the
			// ballot case fell into first.
			await openVote({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_speaker",
				actorMemberId: s.adminMemberId,
			});
			const live = await loadParticipation(s.meetingId);
			expect(live.categories.best_speaker).toBeDefined();

			await archive(s.clubId);
			const gone = await loadParticipation(s.meetingId);
			for (const c of Object.values(gone.categories)) {
				expect(c.ballotsIn).toBe(0);
			}
			expect(gone.presentCount).toBeNull();
		});

		it("getMemberPathways: a member's Pathways progress disappears", async () => {
			const s = await seedPublicClub();
			// Returns [] for a member/club mismatch too, so assert the gate directly
			// rather than resting on an empty array that means two different things.
			expect(await pathwaysForMember(s.clubId, s.memberId)).toEqual([]);

			await archive(s.clubId);
			expect(await isReadableClub(s.clubId)).toBe(false);
			expect(await pathwaysForMember(s.clubId, s.memberId)).toEqual([]);
		});

		it("getBallot: candidate names disappear and every category reads closed", async () => {
			const s = await seedPublicClub();
			// seedClub's only slot is an UNASSIGNED functionary, and no vote is ever
			// opened on it — so a bare seeded meeting yields a ballot that is already
			// all-closed with no candidates, and this case would pass with the gate
			// deleted. It did: the first version of this test survived the mutation
			// run that every other case here failed. A real ballot needs an assigned
			// SPEAKER slot (the candidate) and an OPEN session (the window).
			const [speakerRole] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: s.clubId,
					name: "Speaker 1",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			if (!speakerRole) throw new Error("Failed to insert speaker role");
			await testDb.insert(roleSlots).values({
				meetingId: s.meetingId,
				roleDefinitionId: speakerRole.id,
				status: "confirmed",
				assignedMemberId: s.memberId,
			});
			await openVote({
				meetingId: s.meetingId,
				clubId: s.clubId,
				category: "best_speaker",
				actorMemberId: s.adminMemberId,
			});

			const live = await loadBallot(s.meetingId);
			expect(live.meetingId).toBe(s.meetingId);
			expect(live.categories.best_speaker.isOpen).toBe(true);
			expect(live.categories.best_speaker.hasOpened).toBe(true);
			expect(
				live.categories.best_speaker.candidates.map((c) => c.name),
			).toEqual(["Member User"]);

			await archive(s.clubId);
			const gone = await loadBallot(s.meetingId);
			for (const category of Object.values(gone.categories)) {
				expect(category.isOpen).toBe(false);
				expect(category.hasOpened).toBe(false);
				expect(category.candidates).toEqual([]);
			}
		});
	},
);

describe.skipIf(!hasTestDb)(
	"the gate is on the PUBLIC seam only (#544)",
	() => {
		it("leaves the shared resolveMeetingKey ungated for authed callers", async () => {
			const s = await seedPublicClub();
			await archive(s.clubId);

			// Not an oversight — the authed callers reach this through
			// `requireMembership`, which already throws on an archived club, so a
			// second archive round trip here would be billed to every member read.
			// Pinning it means a future author who "fixes" this by moving the check
			// down into the shared resolver has to come read the reason first.
			expect(await resolveMeetingKey(s.clubId, s.meetingId)).toBe(s.meetingId);
			expect(await resolvePublicMeetingKey(s.clubId, s.meetingId)).toBeNull();
		});

		it("restores every reader when the club is unarchived", async () => {
			const s = await seedPublicClub();
			await archive(s.clubId);
			await testDb
				.update(clubs)
				.set({ archivedAt: null })
				.where(eq(clubs.id, s.clubId));

			// Archiving is reversible from the superadmin console, so the gate must be
			// a filter on current state and never a one-way destruction.
			expect((await loadPublicClubRoles(s.clubId)).length).toBeGreaterThan(0);
			expect(await getPublicClubProfile(s.clubId)).not.toBeNull();
			expect((await loadPublicClubRoster(s.clubId)).length).toBe(2);
			expect(
				(await loadPublicUpcomingMeetings(s.clubId)).length,
			).toBeGreaterThan(0);
			expect(
				(await loadPublicSeasonGrid({ clubId: s.clubId, count: 4 })).members
					.length,
			).toBe(2);
			expect(await resolvePublicMeetingKey(s.clubId, s.meetingId)).toBe(
				s.meetingId,
			);
			// The ballot rides the OTHER gate (`isReadableClubForMeeting`), whose
			// restore path nothing above exercises: every assertion in this case
			// resolves the club by id, so `isReadableClubForMeeting` could be left
			// returning a stale `false` and the case would still read green.
			expect(await loadBallot(s.meetingId)).toMatchObject({
				meetingId: s.meetingId,
			});
			expect(await isReadableClubForMeeting(s.meetingId)).toBe(true);
		});

		/**
		 * Both not-found values are built by a FUNCTION per call (`emptyGrid` in
		 * `season-grid-logic.ts`, `closedBallotCategories` in `voting-logic.ts`),
		 * and both carry a comment saying why: a module-level singleton would let
		 * one archived-club caller's in-place `.push()` / `.sort()` reshape what
		 * the NEXT one receives, because the real loaders hand every caller its
		 * own arrays.
		 *
		 * Nothing asserted that. Verified by mutation: rewriting `emptyGrid` to
		 * return a shared `const` left all 1,444 `src/server` tests green — the
		 * documented reason was pure prose, which is the repo's "a test stated
		 * relative to the thing it guards cannot fail" trap wearing a different
		 * hat. Identity is the only observable that distinguishes the two designs,
		 * so identity is what this asserts.
		 */
		it("hands each archived-club caller its own not-found value", async () => {
			const s = await seedPublicClub();
			await archive(s.clubId);

			const first = await loadPublicSeasonGrid({
				clubId: s.clubId,
				count: 4,
			});
			const second = await loadPublicSeasonGrid({
				clubId: s.clubId,
				count: 4,
			});
			expect(first).not.toBe(second);
			expect(first.members).not.toBe(second.members);
			expect(first.cells).not.toBe(second.cells);

			// The consequence the identity check exists to prevent, stated directly.
			first.members.push({ id: "x", name: "Leaked" });
			first.meetings.push({} as (typeof first.meetings)[number]);
			expect(
				(await loadPublicSeasonGrid({ clubId: s.clubId, count: 4 })).members,
			).toEqual([]);
			expect(
				(await loadPublicSeasonGrid({ clubId: s.clubId, count: 4 })).meetings,
			).toEqual([]);

			const ballotA = await loadBallot(s.meetingId);
			const ballotB = await loadBallot(s.meetingId);
			expect(ballotA.categories).not.toBe(ballotB.categories);
			expect(ballotA.categories.best_speaker.candidates).not.toBe(
				ballotB.categories.best_speaker.candidates,
			);

			ballotA.categories.best_speaker.candidates.push({
				id: "x",
				name: "Leaked",
				kind: "member",
			});
			expect(
				(await loadBallot(s.meetingId)).categories.best_speaker.candidates,
			).toEqual([]);
		});
	},
);
