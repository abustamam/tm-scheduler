/**
 * DB-backed tests for `set_default_agenda_template` (#1630). The shared
 * refusals (non-officer, ids that are not the club's, stale after a rename)
 * are in `agenda-template-tools.integration.test.ts`.
 *
 * Every test card reads: protects=<observable>; fails_when=<wrong result it
 * rejects>; no_claim=<what green does not prove>.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	meetings,
	meetingTemplates,
	roleSlots,
} from "#/db/schema";
import { localDateKey } from "#/lib/meeting-url";
import {
	clubAgendaSnapshot,
	editFirstBeat,
	fourBucketMeetings,
	leanTemplate,
	newMeeting,
	standardClub,
} from "#/test/club-agenda-fixtures";
import { cleanup, hasTestDb, type SeededClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const hooks = vi.hoisted(() => ({ failMeeting: null as string | null }));
vi.mock("#/server/meeting-templates-logic", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("#/server/meeting-templates-logic")>();
	return {
		...real,
		applyTemplateConversion: async (
			...a: Parameters<typeof real.applyTemplateConversion>
		) => {
			if (a[0].meetingId === hooks.failMeeting) {
				throw new Error("forced failure for this meeting");
			}
			return real.applyTemplateConversion(...a);
		},
	};
});

const { hashApiToken } = await import("#/server/api-tokens-logic");
const { setDefaultAgendaTemplateTool } = await import(
	"#/server/mcp/tools/set-default-agenda-template"
);

type Ref = { meetingId: string; date?: string; roles?: string[] };
type Out = {
	applied: boolean;
	noop?: boolean;
	plan: {
		wouldApply: Ref[];
		keptEdited: Ref[];
		keptSignups: Ref[];
		keptRoles: Ref[];
		currentDefaultTemplateId: string | null;
	} & Record<string, unknown>;
	planHash?: string;
	result?: {
		applied: Ref[];
		keptEdited: Ref[];
		keptSignups: Ref[];
		keptRoles: Ref[];
		failed: Ref[];
		partial: boolean;
	};
};

describe.skipIf(!hasTestDb)("set_default_agenda_template (#1630)", () => {
	let club: SeededClub;
	let adminToken: string;

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}
	const run = (input: Record<string, unknown>) =>
		setDefaultAgendaTemplateTool.handler(input, {
			rawToken: adminToken,
			audience: "officer",
		}) as Promise<Out>;
	const defaultOf = async () =>
		(
			await testDb
				.select({ d: clubs.defaultTemplateId })
				.from(clubs)
				.where(eq(clubs.id, club.clubId))
		)[0]?.d ?? null;
	const ids = (rows: Ref[]) => rows.map((r) => r.meetingId);

	beforeEach(async () => {
		club = await standardClub();
		adminToken = await mint(club.adminUserId);
	});
	afterEach(async () => {
		hooks.failMeeting = null;
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	// protects=the preview sorts four seeded upcoming meetings into the four lists and writes nothing, and the apply's result holds the same four meetings;
	// fails_when=a meeting is in a different list in the plan than in the result, or the preview changes any row;
	// no_claim=a change landing between the two calls (a later test).
	it("previews the four buckets without writing, and the apply puts the same meetings in the same lists", async () => {
		const m = await fourBucketMeetings(club);
		const target = await leanTemplate(club.clubId);
		const snap = await clubAgendaSnapshot(club.clubId);
		const input = { clubId: club.clubId, templateId: target };
		const preview = await run(input);
		expect(ids(preview.plan.wouldApply)).toEqual([m.standard]);
		expect(ids(preview.plan.keptEdited)).toEqual([m.edited]);
		expect(preview.plan.keptSignups).toEqual([
			expect.objectContaining({ meetingId: m.signups, roles: ["Joke Master"] }),
		]);
		expect(preview.plan.keptRoles).toEqual([
			expect.objectContaining({ meetingId: m.roles, roles: ["Quiz Master"] }),
		]);
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
		expect(await defaultOf()).toBeNull();

		const applied = await run({ ...input, planHash: preview.planHash });
		expect(applied.applied).toBe(true);
		const result = applied.result as NonNullable<Out["result"]>;
		expect(ids(result.applied)).toEqual(ids(preview.plan.wouldApply));
		expect(ids(result.keptEdited)).toEqual(ids(preview.plan.keptEdited));
		expect(ids(result.keptSignups)).toEqual(ids(preview.plan.keptSignups));
		expect(ids(result.keptRoles)).toEqual(ids(preview.plan.keptRoles));
		expect(result.failed).toEqual([]);
		expect(result.partial).toBe(false);
		expect(await defaultOf()).toBe(target);
	});

	// protects=no role slot that existed before is gone and no assignment is cleared by setting a default;
	// fails_when=a slot count drops, or the claimed member is released;
	// no_claim=slots added by the conversion (the fixture's default has every stock role).
	it("removes no role slot and clears no assignment", async () => {
		await fourBucketMeetings(club);
		const target = await leanTemplate(club.clubId);
		const slotsBefore = await testDb
			.select({
				id: roleSlots.id,
				member: roleSlots.assignedMemberId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(meetings.clubId, club.clubId));
		const input = { clubId: club.clubId, templateId: target };
		const preview = await run(input);
		await run({ ...input, planHash: preview.planHash });
		const slotsAfter = await testDb
			.select({
				id: roleSlots.id,
				member: roleSlots.assignedMemberId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(meetings.clubId, club.clubId));
		const byId = new Map(slotsAfter.map((s) => [s.id, s]));
		for (const before of slotsBefore) {
			expect(byId.get(before.id), `slot ${before.id}`).toEqual(before);
		}
	});

	// protects=plan entries carry the club-local date, sorted roles and nothing else of the meeting;
	// fails_when=an instant, urlKey or onDefaultCopy leaks into the hashed plan, or the date is UTC rather than club-local;
	// no_claim=the DST edge of the club's zone.
	it("plan entries are {meetingId, date, roles?} with the club-local date", async () => {
		const m = await fourBucketMeetings(club);
		const target = await leanTemplate(club.clubId);
		const preview = await run({ clubId: club.clubId, templateId: target });
		const [row] = await testDb
			.select({ at: meetings.scheduledAt, tz: clubs.timezone })
			.from(meetings)
			.innerJoin(clubs, eq(clubs.id, meetings.clubId))
			.where(eq(meetings.id, m.standard));
		expect(preview.plan.wouldApply).toEqual([
			{
				meetingId: m.standard,
				date: localDateKey(row?.at as Date, row?.tz as string),
			},
		]);
		expect(Object.keys(preview.plan.keptEdited[0] ?? {}).sort()).toEqual([
			"date",
			"meetingId",
		]);
		expect(Object.keys(preview.plan.keptSignups[0] ?? {}).sort()).toEqual([
			"date",
			"meetingId",
			"roles",
		]);
	});

	// protects=repeated previews of unchanged data hash to the same plan;
	// fails_when=any unstable field makes every apply look stale;
	// no_claim=a tie on scheduledAt (the unique index makes one unrepresentable).
	it("repeated previews give the same planHash", async () => {
		await fourBucketMeetings(club);
		const target = await leanTemplate(club.clubId);
		const input = { clubId: club.clubId, templateId: target };
		expect((await run(input)).planHash).toBe((await run(input)).planHash);
	});

	// protects=a meeting edited between the preview and the apply makes the plan PLAN_STALE and sets nothing;
	// fails_when=the apply runs on an out-of-date classification, or the default is set;
	// no_claim=the loop's own locked re-check (club-agendas-race covers it).
	it("a meeting changing bucket after the preview is PLAN_STALE", async () => {
		const standard = await newMeeting(club.clubId, 7);
		const target = await leanTemplate(club.clubId);
		const input = { clubId: club.clubId, templateId: target };
		const preview = await run(input);
		await editFirstBeat(standard);
		await expect(
			run({ ...input, planHash: preview.planHash }),
		).rejects.toMatchObject({ code: "PLAN_STALE" });
		expect(await defaultOf()).toBeNull();
	});

	// protects=templateId null clears the default, touches no meeting, and a club with no default gets a noop;
	// fails_when=a meeting changes, the default stays, or the no-default call reports applied;
	// no_claim=what new meetings get afterwards.
	it("null clears the default without touching a meeting, and is a noop with none", async () => {
		const m = await newMeeting(club.clubId, 7);
		const target = await leanTemplate(club.clubId);
		await testDb
			.update(clubs)
			.set({ defaultTemplateId: target })
			.where(eq(clubs.id, club.clubId));
		const meetingsBefore = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.id, m));
		const input = { clubId: club.clubId, templateId: null };
		const preview = await run(input);
		expect(preview.plan).toEqual({
			clubId: club.clubId,
			templateId: null,
			currentDefaultTemplateId: target,
		});
		const applied = await run({ ...input, planHash: preview.planHash });
		expect(applied.applied).toBe(true);
		expect(await defaultOf()).toBeNull();
		expect(
			await testDb.select().from(meetings).where(eq(meetings.id, m)),
		).toEqual(meetingsBefore);

		const again = await run(input);
		expect(again.plan.noop).toBe(true);
		const noop = await run({ ...input, planHash: again.planHash });
		expect(noop).toMatchObject({ applied: false, noop: true });
	});

	// protects=a clear is not made stale by a template rename;
	// fails_when=the clear hashes a template name;
	// no_claim=a change of which template is the default (that is a different plan, correctly).
	it("a rename does not make a clear stale", async () => {
		const target = await leanTemplate(club.clubId, { name: "Before" });
		await testDb
			.update(clubs)
			.set({ defaultTemplateId: target })
			.where(eq(clubs.id, club.clubId));
		const input = { clubId: club.clubId, templateId: null };
		const preview = await run(input);
		await testDb
			.update(meetingTemplates)
			.set({ name: "After" })
			.where(eq(meetingTemplates.id, target));
		const applied = await run({ ...input, planHash: preview.planHash });
		expect(applied.applied).toBe(true);
		expect(await defaultOf()).toBeNull();
	});

	// protects=a disabled template as the default is VALIDATION in the preview, naming edit_agenda_template, and writes nothing;
	// fails_when=the preview offers it, or the default is set;
	// no_claim=the logic's own disabled refusal under the lock.
	it("a disabled template is VALIDATION", async () => {
		const target = await leanTemplate(club.clubId, { enabled: false });
		await expect(
			run({ clubId: club.clubId, templateId: target }),
		).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("edit_agenda_template"),
		});
		expect(await defaultOf()).toBeNull();
	});

	// protects=result.partial is true when one meeting lands in failed, and the others still convert;
	// fails_when=partial is false with a failed meeting, or the failure stops the loop;
	// no_claim=why a conversion fails (forced here at the seam).
	it("partial is true when a meeting fails", async () => {
		const bad = await newMeeting(club.clubId, 7);
		const good = await newMeeting(club.clubId, 14);
		const target = await leanTemplate(club.clubId);
		const input = { clubId: club.clubId, templateId: target };
		const preview = await run(input);
		hooks.failMeeting = bad;
		const applied = await run({ ...input, planHash: preview.planHash });
		const result = applied.result as NonNullable<Out["result"]>;
		expect(result.partial).toBe(true);
		expect(ids(result.failed)).toEqual([bad]);
		expect(ids(result.applied)).toEqual([good]);
		expect(await defaultOf()).toBe(target);
	});

	// protects=the apply is the real SetDefaultResult as plain JSON (instants as ISO strings);
	// fails_when=a Date object reaches the tool result;
	// no_claim=the urlKey values.
	it("the result is plain JSON", async () => {
		await newMeeting(club.clubId, 7);
		const target = await leanTemplate(club.clubId);
		const input = { clubId: club.clubId, templateId: target };
		const preview = await run(input);
		const applied = await run({ ...input, planHash: preview.planHash });
		const first = (applied.result as NonNullable<Out["result"]>).applied[0];
		expect(
			typeof (first as unknown as { scheduledAt: unknown }).scheduledAt,
		).toBe("string");
		expect(JSON.parse(JSON.stringify(applied))).toEqual(applied);
	});
});
