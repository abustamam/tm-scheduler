/**
 * `upsert_agendas` end to end: preview → confirm page → apply (#808).
 *
 * The tool writes NOTHING; the page does. So these cases drive the real MCP
 * handler to get a pending row, then the real page functions to read and apply
 * it — the same three entry points production uses, in the same order.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/agenda-plan-confirm.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubMeetingRecurrence,
	clubs,
	mcpPendingPlans,
	meetings,
	members,
	roleSlots,
} from "#/db/schema";
import { AGENDA_ALREADY_APPLIED_MESSAGE } from "#/lib/agenda-upsert";
import { zonedWallTimeToUtc } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { upsertAgendasTool } = await import("#/server/mcp/tools/upsert-agendas");
const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/agenda-plan-pending-logic"
);

const TUESDAY = "2027-03-02";
const NEXT_TUESDAY = "2027-03-09";
const THIRD_TUESDAY = "2027-03-16";
const TUESDAY_INDEX = 2;

interface Preview {
	pendingId: string;
	confirmUrl: string;
	blocking: { code: string; entryIndex?: number }[];
}

describe.skipIf(!hasTestDb)("the agenda confirm flow", () => {
	let seed: SeededClub;
	let club: { clubId: string; timezone: string };
	let token: string;

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	async function seedMeeting(
		date: string,
		time = "19:00",
		overrides: Partial<typeof meetings.$inferInsert> = {},
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: zonedWallTimeToUtc(`${date}T${time}`, club.timezone),
				...overrides,
			})
			.returning({ id: meetings.id });
		if (!row) throw new Error("failed to seed a meeting");
		return row.id;
	}

	async function seedRule() {
		await testDb.insert(clubMeetingRecurrence).values({
			clubId: seed.clubId,
			mode: "interval",
			weekday: TUESDAY_INDEX,
			intervalWeeks: 1,
			anchorDate: TUESDAY,
			timeOfDay: "19:00",
			location: "The usual hall",
			// Paused, so `ensureScheduleToppedUp` materialises nothing and these
			// cases see only the meetings they seed. The rule is still the source
			// of the default time and the weekday check — see the planner.
			enabled: false,
		});
	}

	async function preview(
		entries: Record<string, unknown>[],
		rawToken = token,
	): Promise<Preview> {
		return (await upsertAgendasTool.handler(
			{ clubId: seed.clubId, meetings: entries },
			{ rawToken },
		)) as unknown as Preview;
	}

	/** The plan hash the confirm page would render for `pendingId`. */
	async function hashFor(pendingId: string, userId = seed.adminUserId) {
		const view = await loadPendingPlan({ pendingId, userId });
		if (view.status !== "editable") {
			throw new Error(`expected an editable plan, got ${view.status}`);
		}
		return view.planHash;
	}

	async function clubMeetings() {
		return testDb
			.select({
				id: meetings.id,
				scheduledAt: meetings.scheduledAt,
				theme: meetings.theme,
				wordOfTheDay: meetings.wordOfTheDay,
				location: meetings.location,
				lengthMinutes: meetings.lengthMinutes,
			})
			.from(meetings)
			.where(eq(meetings.clubId, seed.clubId));
	}

	async function activity(action: "meeting_create" | "meeting_edit") {
		return testDb
			.select({ id: activityLog.id, targetId: activityLog.targetId })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, action),
				),
			);
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [row] = await testDb
			.select({ timezone: clubs.timezone })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		club = {
			clubId: seed.clubId,
			timezone: row?.timezone ?? "America/Chicago",
		};
		token = await mintToken(seed.adminUserId);
		await seedRule();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("the preview writes nothing but a pending row (AC1)", () => {
		it("stores one row for this tool and creates no meeting", async () => {
			const before = (await clubMeetings()).length;
			const result = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, theme: "Autumn" },
			]);

			expect(result.pendingId).toBeTruthy();
			expect(result.confirmUrl).toContain(`/agenda-plan/${result.pendingId}`);
			expect(await clubMeetings()).toHaveLength(before);

			const rows = await testDb
				.select({
					tool: mcpPendingPlans.tool,
					payload: mcpPendingPlans.payload,
				})
				.from(mcpPendingPlans)
				.where(eq(mcpPendingPlans.clubId, seed.clubId));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.tool).toBe("upsert_agendas");
			// What was ASKED, not what was planned.
			expect(rows[0]?.payload).toStrictEqual({
				meetings: [
					{ date: TUESDAY, theme: "Harvest" },
					{ date: NEXT_TUESDAY, theme: "Autumn" },
				],
			});
		});

		it("stores a row even when a date blocks, so the page can explain it", async () => {
			await seedMeeting(TUESDAY, "07:30");
			await seedMeeting(TUESDAY, "19:00");
			const result = await preview([{ date: TUESDAY, theme: "Harvest" }]);
			expect(result.blocking[0]?.code).toBe("AMBIGUOUS_DATE");
			const view = await loadPendingPlan({
				pendingId: result.pendingId,
				userId: seed.adminUserId,
			});
			expect(view.status).toBe("editable");
		});
	});

	describe("who may open the page (AC6)", () => {
		it("renders the diff for its creator", async () => {
			await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			expect(view.lines).toHaveLength(1);
			expect(view.summary).toMatchObject({ updated: 1, created: 0 });
		});

		it("is not-found for another ADMIN of the same club", async () => {
			// Not "an admin of the club": the confirm page belongs to the person
			// who proposed the write, and even a second admin is a not-found.
			await testDb
				.update(members)
				.set({ clubRole: "admin" })
				.where(eq(members.id, seed.memberId));
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.memberUserId,
			});
			expect(view.status).toBe("not_found");
		});

		it("is not-found when a guest-book id is opened at the agenda page", async () => {
			// One table serves both tools since #812, so this is a missing WHERE
			// rather than an impossible state — and the failure would be SILENT: a
			// renderer built for a different shape drawing an empty plan.
			const pastMeetingId = await seedMeeting("2020-03-03", "19:00");
			expect(pastMeetingId).toBeTruthy();
			const { pendingId } = (await recordGuestBookTool.handler(
				{
					clubId: seed.clubId,
					meetingDate: "2020-03-03",
					entries: [{ name: "Wanda Visitor" }],
				},
				{ rawToken: token },
			)) as { pendingId: string };
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			expect(view.status).toBe("not_found");
		});
	});

	describe("applying (AC7)", () => {
		it("creates in ONE insert carrying the meta, with role slots", async () => {
			const { pendingId } = await preview([
				{
					date: TUESDAY,
					theme: "Harvest",
					wordOfTheDay: "ebullient",
					wodDefinition: "cheerful",
				},
			]);
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			expect(result.ok).toBe(true);
			expect(result.applied).toMatchObject({ created: 1, updated: 0 });

			const created = (await clubMeetings()).find((m) => m.theme === "Harvest");
			expect(created).toBeTruthy();
			expect(created?.wordOfTheDay).toBe("ebullient");
			// From the club's recurrence rule, like the top-up's own creates.
			expect(created?.location).toBe("The usual hall");
			// Copy-at-insert from the club default, never from the caller.
			expect(created?.lengthMinutes).toBe(90);

			const slots = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, created?.id ?? ""));
			expect(slots.length).toBeGreaterThan(0);
		});

		it("logs exactly one meeting_create and no meeting_edit for a create", async () => {
			// `meeting_create` had an enum member, a formatter case and NO writer
			// before #808. An insert-then-patch would log both for one user action
			// — which is why the meta rides the insert.
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			expect(await activity("meeting_create")).toHaveLength(1);
			expect(await activity("meeting_edit")).toHaveLength(0);
		});

		it("updates through the patch and leaves every sibling field intact (AC8)", async () => {
			const meetingId = await seedMeeting(TUESDAY, "19:00", {
				theme: "Old",
				wordOfTheDay: "ebullient",
				wodDefinition: "cheerful",
				wodExample: "an ebullient Toastmaster",
				location: "Room 2",
				notes: "internal",
				reminders: "read this out",
			});
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			expect(result.ok).toBe(true);

			const [after] = await testDb
				.select()
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(after?.theme).toBe("Harvest");
			expect(after?.wordOfTheDay).toBe("ebullient");
			expect(after?.wodDefinition).toBe("cheerful");
			expect(after?.wodExample).toBe("an ebullient Toastmaster");
			expect(after?.location).toBe("Room 2");
			// The two the tool refuses to carry at all.
			expect(after?.notes).toBe("internal");
			expect(after?.reminders).toBe("read this out");
			expect(await activity("meeting_edit")).toHaveLength(1);
		});

		it("writes nothing for a line whose fields already match", async () => {
			await seedMeeting(TUESDAY, "19:00", { theme: "Harvest" });
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			expect(result.applied).toMatchObject({
				created: 0,
				updated: 0,
				unchanged: 1,
			});
			expect(await activity("meeting_edit")).toHaveLength(0);
		});

		it("creates and updates in one call", async () => {
			await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, theme: "Autumn" },
				{ date: THIRD_TUESDAY, theme: "Winter" },
			]);
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			expect(result.applied).toMatchObject({ created: 2, updated: 1 });
			expect(result.view.status).toBe("applied");
		});

		it("clears a field when the caller sends null", async () => {
			const meetingId = await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const { pendingId } = await preview([{ date: TUESDAY, theme: null }]);
			await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			const [after] = await testDb
				.select({ theme: meetings.theme })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(after?.theme).toBeNull();
		});
	});

	describe("refusals", () => {
		it("refuses while any date blocks, and writes nothing (AC3)", async () => {
			await seedMeeting(TUESDAY, "19:00", { status: "completed" });
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
				{ date: NEXT_TUESDAY, theme: "Autumn" },
			]);
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(view.status);
			expect(view.blocking.map((b) => b.code)).toStrictEqual([
				"MEETING_LOCKED",
			]);

			const before = (await clubMeetings()).length;
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			expect(result.ok).toBe(false);
			// A half-applied batch is worse than a refused one: the half that
			// landed is invisible beside the half that did not.
			expect(await clubMeetings()).toHaveLength(before);
		});

		it("refuses a stale plan with a FRESH plan rendered, and writes nothing (AC9)", async () => {
			const meetingId = await seedMeeting(TUESDAY, "19:00", { theme: "Old" });
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const stale = await hashFor(pendingId);

			// Someone else edits the very field this plan's diff rests on.
			await testDb
				.update(meetings)
				.set({ theme: "Someone else's" })
				.where(eq(meetings.id, meetingId));

			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: stale,
			});
			expect(result.ok).toBe(false);
			expect(result.message).toContain("changed");
			expect(result.view.status).toBe("editable");
			if (result.view.status !== "editable") throw new Error("unreachable");
			// The refreshed plan, showing what the apply would do NOW.
			const line = result.view.lines[0];
			if (line?.action !== "update") throw new Error("expected an update");
			expect(line.changes[0]?.from).toBe("Someone else's");

			const [after] = await testDb
				.select({ theme: meetings.theme })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(after?.theme).toBe("Someone else's");
		});

		it("refuses a second apply, with the pre-check's own sentence", async () => {
			// The SERIAL double-apply. The race that reaches the locked guard
			// inside the transaction is driven by
			// `agenda-plan-confirm-race.integration.test.ts` — this one proves the
			// cheap check answers first, which is what makes that one necessary.
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			const hash = await hashFor(pendingId);
			expect(
				(
					await applyPendingPlan({
						pendingId,
						userId: seed.adminUserId,
						planHash: hash,
					})
				).ok,
			).toBe(true);

			const second = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: hash,
			});
			expect(second.ok).toBe(false);
			expect(second.message).toBe(AGENDA_ALREADY_APPLIED_MESSAGE);
			expect(second.view.status).toBe("applied");
			// One meeting, not two.
			expect(
				(await clubMeetings()).filter((m) => m.theme === "Harvest"),
			).toHaveLength(1);
		});

		it("tombstones the payload and keeps what it did", async () => {
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: await hashFor(pendingId),
			});
			const [row] = await testDb
				.select({ payload: mcpPendingPlans.payload })
				.from(mcpPendingPlans)
				.where(eq(mcpPendingPlans.id, pendingId));
			expect(row?.payload).toStrictEqual({
				meetings: null,
				applied: { created: 1, updated: 0, dates: [TUESDAY] },
			});

			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "applied") throw new Error(view.status);
			expect(view.applied).toMatchObject({ created: 1, updated: 0 });
		});

		it("renders a payload it cannot read rather than applying half of it", async () => {
			// A row written by a release this one has never seen. The apply writes
			// straight into `meetings` with nothing validating in between.
			const { pendingId } = await preview([
				{ date: TUESDAY, theme: "Harvest" },
			]);
			await testDb
				.update(mcpPendingPlans)
				.set({ payload: { meetings: [{ when: TUESDAY }] } })
				.where(eq(mcpPendingPlans.id, pendingId));

			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			expect(view.status).toBe("unreadable");

			const before = (await clubMeetings()).length;
			const result = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: "anything",
			});
			expect(result.ok).toBe(false);
			expect(await clubMeetings()).toHaveLength(before);
		});
	});
});
