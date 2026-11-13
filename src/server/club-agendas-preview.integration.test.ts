/**
 * DB-backed tests for the two logic changes #1630 makes in
 * `club-agendas-logic.ts`: `previewDefaultForUpcoming` and
 * `deleteClubTemplate`'s `expectContentHash`.
 *
 * Every test card reads: protects=<observable>; fails_when=<wrong result it
 * rejects>; no_claim=<what green does not prove>.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingTemplates } from "#/db/schema";
import { digest } from "#/lib/mcp-plan";
import {
	clubAgendaSnapshot,
	fourBucketMeetings,
	leanTemplate,
	newMeeting,
	standardClub,
} from "#/test/club-agenda-fixtures";
import { cleanup, hasTestDb, type SeededClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	deleteClubTemplate,
	previewDefaultForUpcoming,
	setClubDefaultTemplate,
	TemplateChangedError,
} = await import("./club-agendas-logic");
const { templateContentForHash } = await import("./meeting-templates-logic");

describe.skipIf(!hasTestDb)(
	"club default preview and guarded delete (#1630)",
	() => {
		let club: SeededClub;
		beforeEach(async () => {
			club = await standardClub();
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const ids = (rows: { meetingId: string }[]) => rows.map((r) => r.meetingId);

		// protects=the preview sorts four upcoming meetings into the four buckets and writes no row;
		// fails_when=a bucket is wrong, `failed` is non-empty, or any template, beat, role, meeting, slot or club row changed;
		// no_claim=the apply path (the next test compares it).
		it("sorts the four-bucket fixture and writes nothing", async () => {
			const m = await fourBucketMeetings(club);
			const target = await leanTemplate(club.clubId);
			const before = await clubAgendaSnapshot(club.clubId);
			const preview = await previewDefaultForUpcoming(club.clubId, target);
			expect(ids(preview.applied)).toEqual([m.standard]);
			expect(ids(preview.keptEdited)).toEqual([m.edited]);
			expect(preview.keptSignups).toEqual([
				expect.objectContaining({
					meetingId: m.signups,
					roles: ["Joke Master"],
				}),
			]);
			expect(preview.keptRoles).toEqual([
				expect.objectContaining({ meetingId: m.roles, roles: ["Quiz Master"] }),
			]);
			expect(preview.failed).toEqual([]);
			expect(await clubAgendaSnapshot(club.clubId)).toEqual(before);
		});

		// protects=the preview and the loop classify identically;
		// fails_when=the two drift: a meeting is in a different bucket after the real set-default than the preview named;
		// no_claim=a change landing between the two calls.
		it("agrees with the loop on the same fixture", async () => {
			const m = await fourBucketMeetings(club);
			const target = await leanTemplate(club.clubId);
			const preview = await previewDefaultForUpcoming(club.clubId, target);
			const real = await setClubDefaultTemplate({
				clubId: club.clubId,
				templateId: target,
				actorMemberId: null,
			});
			expect(ids(real.applied)).toEqual(ids(preview.applied));
			expect(ids(real.keptEdited)).toEqual(ids(preview.keptEdited));
			expect(ids(real.keptSignups)).toEqual(ids(preview.keptSignups));
			expect(ids(real.keptRoles)).toEqual(ids(preview.keptRoles));
			expect(ids(real.applied)).toEqual([m.standard]);
		});

		// protects=meetings come back soonest first however they were inserted, identically on every preview (so a plan hash is stable);
		// fails_when=the order follows insertion or the database's arbitrary order;
		// no_claim=a tie on scheduledAt: `meetings_club_scheduled_unique` makes two meetings of one club at one instant unrepresentable, so the `id` tiebreak cannot be exercised through the database.
		it("orders meetings soonest first, identically on every preview", async () => {
			const late = await newMeeting(club.clubId, 28);
			const soon = await newMeeting(club.clubId, 7);
			const mid = await newMeeting(club.clubId, 14);
			const target = await leanTemplate(club.clubId);
			const first = await previewDefaultForUpcoming(club.clubId, target);
			const second = await previewDefaultForUpcoming(club.clubId, target);
			expect(ids(first.applied)).toEqual([soon, mid, late]);
			expect(ids(second.applied)).toEqual(ids(first.applied));
		});

		async function hashOf(templateId: string) {
			return digest(await templateContentForHash(testDb, templateId));
		}
		const exists = async (id: string) =>
			(
				await testDb
					.select({ id: meetingTemplates.id })
					.from(meetingTemplates)
					.where(eq(meetingTemplates.id, id))
			).length === 1;

		// protects=a delete whose expected content hash no longer matches deletes nothing;
		// fails_when=the template is gone, or the error is not TemplateChangedError;
		// no_claim=how the content changed (any stored field counts).
		it("refuses a delete when the content hash does not match", async () => {
			const id = await leanTemplate(club.clubId);
			const stale = await hashOf(id);
			await testDb
				.update(meetingTemplates)
				.set({ name: "Renamed after the preview" })
				.where(eq(meetingTemplates.id, id));
			await expect(
				deleteClubTemplate({
					clubId: club.clubId,
					templateId: id,
					expectContentHash: stale,
				}),
			).rejects.toBeInstanceOf(TemplateChangedError);
			expect(await exists(id)).toBe(true);
		});

		// protects=a delete whose hash matches goes through, and a caller passing no hash behaves as before;
		// fails_when=a matching hash is refused, or omitting it starts refusing;
		// no_claim=the lock ordering (the tool suite holds a lock to test the race).
		it("deletes on a matching hash and when none is passed", async () => {
			const withHash = await leanTemplate(club.clubId);
			await expect(
				deleteClubTemplate({
					clubId: club.clubId,
					templateId: withHash,
					expectContentHash: await hashOf(withHash),
				}),
			).resolves.toEqual({ wasDefault: false });
			expect(await exists(withHash)).toBe(false);
			const without = await leanTemplate(club.clubId);
			await expect(
				deleteClubTemplate({ clubId: club.clubId, templateId: without }),
			).resolves.toEqual({ wasDefault: false });
			expect(await exists(without)).toBe(false);
		});
	},
);
