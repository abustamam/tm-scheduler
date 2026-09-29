/**
 * DB-backed tests for `edit_agenda` and `get_agenda`'s run sheet (#966).
 *
 * The motivating case is THR's: the meeting stays at noon, the agenda opens
 * with a 15-minute Introductions block, and Table Topics (the flex row)
 * shrinks so the agenda still ends when the slot does. Every write case
 * asserts both halves — what the caller is told, and what is stored.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	meetings,
	meetingTemplateBeats,
	meetingTemplates,
} from "#/db/schema";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Fail the Nth `updateAgendaRow` the TOOL makes. 0 = never. The only way to
 *  reach the rollback: every operation is validated before the first write. */
const spy = vi.hoisted(() => ({ failOnUpdate: 0, updates: 0 }));
vi.mock("#/server/meeting-agenda-edit-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-agenda-edit-logic")>();
	return {
		...actual,
		updateAgendaRow: async (
			...args: Parameters<typeof actual.updateAgendaRow>
		) => {
			spy.updates += 1;
			if (spy.failOnUpdate !== 0 && spy.updates === spy.failOnUpdate) {
				throw new Error("injected failure mid-batch");
			}
			return actual.updateAgendaRow(...args);
		},
	};
});

const { editAgendaTool, CANCELLED_AGENDA_MESSAGE } = await import(
	"#/server/mcp/tools/edit-agenda"
);
const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { addAgendaRow, loadAgendaDraft, moveAgendaRow, updateAgendaRow } =
	await import("#/server/meeting-agenda-edit-logic");

type RunSheetRow = {
	rowId: string;
	kind: string;
	label: string;
	minutes: number;
	start: string | null;
	scheduledMinutes: number;
	flex: { minMinutes: number; maxMinutes: number } | null;
};
type RunSheet = {
	startsAt: string;
	endsAt: string;
	slotMinutes: number;
	slotEndsAt: string;
	totalMinutes: number;
	overByMinutes: number;
	rows: RunSheetRow[];
};
type PlanRow = {
	rowId: string | null;
	label: string;
	changes: string[];
	before: { position: number; start: string | null; minutes: number } | null;
	after: { position: number; start: string | null; minutes: number } | null;
};
type Plan = {
	rows: PlanRow[];
	before: Omit<RunSheet, "rows">;
	after: Omit<RunSheet, "rows">;
	warnings: string[];
};
type Preview = {
	applied: false;
	plan: Plan;
	planHash: string;
	summary: string;
};
type Applied = { applied: true; plan: Plan; runSheet: RunSheet };

/** "12:15" → minutes on a 12-hour dial. */
function dial(clock: string): number {
	const [h, m] = clock.split(":").map(Number);
	return ((h ?? 0) % 12) * 60 + (m ?? 0);
}

/** Minutes from one printed clock to a later one. The seeded meeting starts
 *  at whatever minute the suite runs, so this has to survive crossing 12. */
function since(from: string, to: string): number {
	return (dial(to) - dial(from) + 720) % 720;
}

describe.skipIf(!hasTestDb)("edit_agenda (#966)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let token: string;

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	const edit = (args: Record<string, unknown>) =>
		editAgendaTool.handler(args, { rawToken: token });

	async function runSheet(meetingId = seed.meetingId): Promise<RunSheet> {
		const out = (await getAgendaTool.handler(
			{ meetingId },
			{ rawToken: token },
		)) as { runSheet: RunSheet };
		return out.runSheet;
	}

	/** What is stored, in order — the thing "writes nothing" is about. */
	async function stored(meetingId = seed.meetingId) {
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		if (!m?.templateId) return [];
		return testDb
			.select({
				id: meetingTemplateBeats.id,
				label: meetingTemplateBeats.label,
				minutes: meetingTemplateBeats.minutes,
				kind: meetingTemplateBeats.kind,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, m.templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
	}

	/** Book the slot so Table Topics sits at its 25-min cap — THR's shape. */
	async function bookToCap(): Promise<RunSheet> {
		const sheet = await runSheet();
		const tt = sheet.rows.find((r) => r.flex !== null);
		if (!tt) throw new Error("the standard agenda has no flex row");
		const fixed = sheet.totalMinutes - tt.scheduledMinutes;
		await testDb
			.update(meetings)
			.set({ lengthMinutes: fixed + 25 })
			.where(eq(meetings.id, seed.meetingId));
		return runSheet();
	}

	const opening = {
		op: "add",
		label: "Introductions",
		minutes: 15,
		at: "start",
	} as const;

	beforeEach(async () => {
		spy.failOnUpdate = 0;
		spy.updates = 0;
		seed = await seedClub();
		other = await seedClub();
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	it("get_agenda returns the run sheet with row ids and start times", async () => {
		const sheet = await runSheet();
		expect(sheet.rows.length).toBeGreaterThan(5);
		const ids = (await stored()).map((r) => r.id);
		expect(sheet.rows.map((r) => r.rowId)).toEqual(ids);
		const first = sheet.rows.find((r) => r.start !== null);
		expect(first?.start).toBe(sheet.startsAt);
		expect(sheet.slotMinutes).toBe(90);
		expect(since(sheet.startsAt, sheet.slotEndsAt)).toBe(90);
		expect(sheet.rows.filter((r) => r.flex !== null)).toHaveLength(1);
		expect(sheet.overByMinutes).toBe(sheet.totalMinutes - 90);
	});

	it("THR: a preview writes nothing and shows Table Topics absorbing the block", async () => {
		const before = await bookToCap();
		const rowsBefore = await stored();

		const preview = (await edit({
			meetingId: seed.meetingId,
			operations: [opening],
		})) as Preview;

		expect(preview.applied).toBe(false);
		expect(preview.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(await stored()).toEqual(rowsBefore);

		const added = preview.plan.rows.find((r) => r.changes.includes("added"));
		expect(added).toMatchObject({
			rowId: null,
			label: "Introductions",
			after: { position: 0, start: before.startsAt, minutes: 15 },
		});
		const tt = before.rows.find((r) => r.flex !== null);
		const ttPlan = preview.plan.rows.find((r) => r.rowId === tt?.rowId);
		expect(ttPlan?.before?.minutes).toBe(25);
		expect(ttPlan?.after?.minutes).toBe(10);
		expect(ttPlan?.changes).toContain("resized");
		// The program starts 15 minutes later, and the end does not move.
		const firstOld = preview.plan.rows.find(
			(r) => r.rowId !== null && r.after?.start != null,
		);
		expect(since(before.startsAt, firstOld?.after?.start ?? "")).toBe(15);
		expect(preview.plan.after.endsAt).toBe(before.endsAt);
		expect(preview.plan.after.overByMinutes).toBe(0);
		expect(preview.plan.warnings).toEqual([]);
	});

	it("THR: applying writes the block; get_agenda reads it back; the end holds", async () => {
		const before = await bookToCap();
		const args = { meetingId: seed.meetingId, operations: [opening] };
		const preview = (await edit(args)) as Preview;
		const applied = (await edit({
			...args,
			planHash: preview.planHash,
		})) as Applied;

		expect(applied.applied).toBe(true);
		expect(applied.plan).toEqual(preview.plan);

		const after = await runSheet();
		expect(applied.runSheet).toEqual(after);
		expect(after.rows[0]).toMatchObject({
			label: "Introductions",
			minutes: 15,
			kind: "event",
			start: before.startsAt,
		});
		expect(after.endsAt).toBe(before.endsAt);
		expect(after.rows.slice(1).map((r) => r.rowId)).toEqual(
			before.rows.map((r) => r.rowId),
		);
		// Every row lands where the plan said, at the time it said.
		for (const planned of preview.plan.rows) {
			const pos = planned.after?.position;
			if (pos === undefined) continue;
			expect(after.rows[pos]?.label).toBe(planned.label);
			expect(after.rows[pos]?.start).toBe(planned.after?.start);
		}
		// The scheduled meeting itself is untouched.
		expect(after.startsAt).toBe(before.startsAt);
	});

	it("produces the same rows the agenda editor does", async () => {
		const [second] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		if (!second) throw new Error("insert failed");

		// The editor's way: add a row, name it, press "up" until it is first.
		const draft = await loadAgendaDraft(second.id);
		if (!draft) throw new Error("no draft");
		const created = await addAgendaRow({
			meetingId: second.id,
			afterRowId: null,
			kind: "event",
		});
		await updateAgendaRow({
			meetingId: second.id,
			rowId: created.id,
			patch: { label: "Introductions", minutes: 15 },
		});
		for (let i = 0; i < draft.rows.length; i++) {
			await moveAgendaRow({
				meetingId: second.id,
				rowId: created.id,
				direction: "up",
			});
		}

		const args = { meetingId: seed.meetingId, operations: [opening] };
		const preview = (await edit(args)) as Preview;
		await edit({ ...args, planHash: preview.planHash });

		const strip = (rows: { label: string; minutes: number; kind: string }[]) =>
			rows.map(({ label, minutes, kind }) => ({ label, minutes, kind }));
		expect(strip(await stored())).toEqual(strip(await stored(second.id)));
	});

	it("warns, and does not block, when the edit runs past the slot", async () => {
		await bookToCap();
		const args = {
			meetingId: seed.meetingId,
			operations: [{ op: "add", label: "Long guest talk", minutes: 60 }],
		};
		const preview = (await edit(args)) as Preview;
		// Table Topics floors at 5, so 60 minutes costs 20 of it and 40 over.
		expect(preview.plan.after.overByMinutes).toBe(40);
		expect(preview.plan.warnings).toHaveLength(1);
		expect(preview.plan.warnings[0]).toMatch(/40 min past its/);
		const applied = (await edit({
			...args,
			planHash: preview.planHash,
		})) as Applied;
		expect(applied.runSheet.overByMinutes).toBe(40);
	});

	it("moves, relabels, retimes and removes in one batch", async () => {
		const sheet = await runSheet();
		const [a, b, c] = sheet.rows.filter((r) => r.kind === "event");
		if (!a || !b || !c) throw new Error("need three event rows");
		const args = {
			meetingId: seed.meetingId,
			operations: [
				{ op: "move", rowId: c.rowId, before: a.rowId },
				{ op: "set", rowId: a.rowId, label: "Welcome", minutes: a.minutes + 1 },
				{ op: "remove", rowId: b.rowId },
			],
		};
		const preview = (await edit(args)) as Preview;
		expect(preview.plan.rows.find((r) => r.rowId === b.rowId)?.changes).toEqual(
			["removed"],
		);
		expect(
			preview.plan.rows.find((r) => r.rowId === c.rowId)?.changes,
		).toContain("moved");
		expect(
			preview.plan.rows.find((r) => r.rowId === a.rowId)?.changes,
		).toContain("relabelled");
		await edit({ ...args, planHash: preview.planHash });

		const after = await runSheet();
		const ids = after.rows.map((r) => r.rowId);
		expect(ids).not.toContain(b.rowId);
		expect(ids.indexOf(c.rowId)).toBe(ids.indexOf(a.rowId) - 1);
		expect(after.rows.find((r) => r.rowId === a.rowId)).toMatchObject({
			label: "Welcome",
			minutes: a.minutes + 1,
		});
	});

	it("refuses an illegal operation mid-list, naming it, and writes nothing", async () => {
		const sheet = await runSheet();
		const rowsBefore = await stored();
		const firstId = sheet.rows[0]?.rowId;
		const ops = [
			opening,
			{ op: "remove", rowId: firstId },
			{ op: "set", rowId: firstId, minutes: 3 },
		];
		await expect(
			edit({ meetingId: seed.meetingId, operations: ops }),
		).rejects.toMatchObject({ code: "VALIDATION", detail: { opIndex: 2 } });
		// Not even with a hash: the apply re-plans and refuses the same way.
		await expect(
			edit({ meetingId: seed.meetingId, operations: ops, planHash: "x" }),
		).rejects.toMatchObject({ code: "VALIDATION" });
		expect(await stored()).toEqual(rowsBefore);
	});

	it("rolls the whole batch back when a write fails part-way", async () => {
		const sheet = await runSheet();
		const target = sheet.rows.find((r) => r.kind === "event");
		const args = {
			meetingId: seed.meetingId,
			operations: [
				opening,
				{ op: "set", rowId: target?.rowId, label: "Renamed" },
			],
		};
		const preview = (await edit(args)) as Preview;
		const rowsBefore = await stored();
		// The add's own label write is update #1; the set is #2.
		spy.failOnUpdate = 2;
		await expect(edit({ ...args, planHash: preview.planHash })).rejects.toThrow(
			/injected failure/,
		);
		expect(spy.updates).toBe(2);
		expect(await stored()).toEqual(rowsBefore);
	});

	it("refuses a stale plan with the fresh one, and writes nothing", async () => {
		const sheet = await runSheet();
		const args = { meetingId: seed.meetingId, operations: [opening] };
		const preview = (await edit(args)) as Preview;
		const target = sheet.rows.find((r) => r.kind === "event");
		if (!target) throw new Error("no event row");
		// Someone in the browser editor retimes a row in between.
		await updateAgendaRow({
			meetingId: seed.meetingId,
			rowId: target.rowId,
			patch: { minutes: target.minutes + 2 },
		});
		const rowsBefore = await stored();
		const err = await edit({ ...args, planHash: preview.planHash }).catch(
			(e: unknown) => e,
		);
		expect(err).toMatchObject({ code: "PLAN_STALE" });
		const fresh = (err as { detail: { plan: Plan; planHash: string } }).detail;
		expect(fresh.planHash).not.toBe(preview.planHash);
		expect(await stored()).toEqual(rowsBefore);
		// The fresh hash is the one that applies.
		const applied = (await edit({
			...args,
			planHash: fresh.planHash,
		})) as Applied;
		expect(applied.runSheet.rows[0]?.label).toBe("Introductions");
	});

	it("refuses a locked meeting and a cancelled one, preview and apply", async () => {
		await runSheet();
		const args = { meetingId: seed.meetingId, operations: [opening] };
		const preview = (await edit(args)) as Preview;
		const rowsBefore = await stored();

		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, seed.meetingId));
		await expect(edit(args)).rejects.toMatchObject({
			code: "LOCKED",
			message: MEETING_LOCKED_MESSAGE,
		});
		await expect(
			edit({ ...args, planHash: preview.planHash }),
		).rejects.toMatchObject({ code: "LOCKED" });

		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expect(
			edit({ ...args, planHash: preview.planHash }),
		).rejects.toMatchObject({
			code: "LOCKED",
			message: CANCELLED_AGENDA_MESSAGE,
		});
		expect(await stored()).toEqual(rowsBefore);
	});

	it("refuses another club's meeting, and touches nothing there", async () => {
		const theirs = await loadAgendaDraft(other.meetingId);
		const rowsBefore = await stored(other.meetingId);
		await expect(
			edit({ meetingId: other.meetingId, operations: [opening] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			edit({
				meetingId: other.meetingId,
				operations: [opening],
				planHash: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// Naming THEIR row on OUR meeting is an unknown row, not a write there.
		const theirRow = theirs?.rows[0]?.id;
		await expect(
			edit({
				meetingId: seed.meetingId,
				operations: [{ op: "remove", rowId: theirRow }],
			}),
		).rejects.toMatchObject({ code: "VALIDATION" });
		expect(await stored(other.meetingId)).toEqual(rowsBefore);
	});

	it("forks a meeting still on a SHARED template, and leaves the shared one alone", async () => {
		const [shared] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: seed.clubId,
				key: `shared_${randomUUID().slice(0, 8)}`,
				name: "Shared",
			})
			.returning({ id: meetingTemplates.id });
		if (!shared) throw new Error("insert failed");
		await testDb.insert(meetingTemplateBeats).values(
			["Open", "Middle", "Close"].map((label, i) => ({
				templateId: shared.id,
				sortOrder: i,
				kind: "event" as const,
				label,
				minutes: 10,
			})),
		);
		await testDb
			.update(meetings)
			.set({ templateId: shared.id })
			.where(eq(meetings.id, seed.meetingId));

		const sheet = await runSheet();
		expect(sheet.rows.map((r) => r.label)).toEqual(["Open", "Middle", "Close"]);
		const [open, , close] = sheet.rows;
		const args = {
			meetingId: seed.meetingId,
			operations: [
				opening,
				// Named by the SHARED template's ids, after the add has renumbered.
				{ op: "set", rowId: close?.rowId, minutes: 20 },
				{ op: "move", rowId: open?.rowId, at: "end" },
			],
		};
		const preview = (await edit(args)) as Preview;
		const applied = (await edit({
			...args,
			planHash: preview.planHash,
		})) as Applied;

		expect(applied.runSheet.rows.map((r) => [r.label, r.minutes])).toEqual([
			["Introductions", 15],
			["Middle", 10],
			["Close", 20],
			["Open", 10],
		]);
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		expect(m?.templateId).not.toBe(shared.id);
		const sharedRows = await testDb
			.select({
				label: meetingTemplateBeats.label,
				minutes: meetingTemplateBeats.minutes,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, shared.id))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		expect(sharedRows).toEqual([
			{ label: "Open", minutes: 10 },
			{ label: "Middle", minutes: 10 },
			{ label: "Close", minutes: 10 },
		]);
		// The meeting no longer points at it, so the club cascade can remove it.
	});
});
