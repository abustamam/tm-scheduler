/**
 * DB-backed tests for `save_agenda_as_template` (#1628). Assertions read the
 * FINAL template rows back from the database, not the plan object.
 *
 * Every test card reads: protects=<observable>; fails_when=<wrong result it
 * rejects>; no_claim=<what green does not prove>.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Runs once after the tool's plan reads the snapshot, to land a race. */
const hook = vi.hoisted(() => ({
	afterSnapshot: null as null | (() => Promise<void>),
}));
vi.mock("#/server/meeting-agenda-edit-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-agenda-edit-logic")>();
	return {
		...actual,
		readAgendaSnapshot: async (
			...args: Parameters<typeof actual.readAgendaSnapshot>
		) => {
			const out = await actual.readAgendaSnapshot(...args);
			const fn = hook.afterSnapshot;
			if (fn) {
				hook.afterSnapshot = null;
				await fn();
			}
			return out;
		},
	};
});

const { saveAgendaAsTemplateTool } = await import(
	"#/server/mcp/tools/save-agenda-as-template"
);
const { editAgendaTool } = await import("#/server/mcp/tools/edit-agenda");
const { getAgendaTool } = await import("#/server/mcp/tools/get-agenda");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { loadAgendaDraft } = await import("#/server/meeting-agenda-edit-logic");

type Row = {
	kind: string;
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
};
type Preview = {
	applied: false;
	planHash: string;
	plan: {
		source: { rows: Row[]; contentHash: string };
		target: { currentRows?: Row[]; templateId?: string; name?: string };
	};
};
type Applied = { applied: true; templateId: string };

describe.skipIf(!hasTestDb)("save_agenda_as_template (#1628)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let token: string;

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}
	const call = (input: Record<string, unknown>, tk = token) =>
		saveAgendaAsTemplateTool.handler(input, {
			rawToken: tk,
			audience: "officer",
		});
	const save = (
		target: Record<string, unknown>,
		extra: Record<string, unknown> = {},
	) => call({ meetingId: seed.meetingId, target, ...extra });
	const newTarget = { mode: "new", name: "Roleplay agenda" };

	async function agendaRows(meetingId = seed.meetingId) {
		const out = (await getAgendaTool.handler(
			{ meetingId },
			{ rawToken: token },
		)) as {
			runSheet: { rows: { label: string; minutes: number }[] };
		};
		return out.runSheet.rows.map((r) => `${r.label}|${r.minutes}`);
	}
	async function templateRows(templateId: string) {
		const rows = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		return rows.map(({ id: _i, templateId: _t, ...rest }) => rest);
	}
	async function clubTemplates() {
		return testDb
			.select()
			.from(meetingTemplates)
			.where(eq(meetingTemplates.clubId, seed.clubId));
	}
	async function storedDefs(meetingId = seed.meetingId) {
		const [m] = await testDb
			.select({ t: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		return m?.t ?? null;
	}

	beforeEach(async () => {
		hook.afterSnapshot = null;
		seed = await seedClub();
		other = await seedClub();
		token = await mint(seed.adminUserId);
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	// protects=a preview writes no template row and the plan shows the meeting's current rows;
	// fails_when=the preview materialises the agenda or stores a template;
	// no_claim=a global row count (parallel suites write globals) is not asserted.
	it("a preview writes nothing and shows the agenda's rows", async () => {
		const clubBefore = await clubTemplates();
		const out = (await save(newTarget)) as Preview;
		expect(out.applied).toBe(false);
		expect(await clubTemplates()).toEqual(clubBefore);
		expect(await storedDefs()).toBeNull();
		expect(out.plan.source.rows.map((r) => `${r.label}|${r.minutes}`)).toEqual(
			await agendaRows(),
		);
	});

	// protects=mode new stores one enabled club template whose rows equal the meeting's and the meeting's agenda reads the same;
	// fails_when=the template differs from the agenda, is disabled, or the agenda changes;
	// no_claim=never-opened meetings gain a stored copy (covered next), which is not an agenda change.
	it("new: creates one enabled club template equal to the agenda", async () => {
		await loadAgendaDraft(seed.meetingId);
		const agendaBefore = await agendaRows();
		const p = (await save(newTarget)) as Preview;
		const out = (await save(newTarget, { planHash: p.planHash })) as Applied;
		const mine = await clubTemplates();
		const created = mine.find((t) => t.id === out.templateId);
		expect(created).toMatchObject({
			name: "Roleplay agenda",
			enabled: true,
			meetingId: null,
		});
		const rows = await templateRows(out.templateId);
		expect(rows.map((r) => `${r.label}|${r.minutes}`)).toEqual(agendaBefore);
		expect(await agendaRows()).toEqual(agendaBefore);
	});

	// protects=a never-opened meeting is saved from its derived agenda and ends with a stored copy and an unchanged agenda;
	// fails_when=the derived agenda is not what is stored in the template;
	// no_claim=none.
	it("new: a never-opened meeting saves what it derives", async () => {
		expect(await storedDefs()).toBeNull();
		const agendaBefore = await agendaRows();
		const p = (await save(newTarget)) as Preview;
		const out = (await save(newTarget, { planHash: p.planHash })) as Applied;
		expect(
			(await templateRows(out.templateId)).map(
				(r) => `${r.label}|${r.minutes}`,
			),
		).toEqual(agendaBefore);
		expect(await storedDefs()).not.toBeNull();
		expect(await agendaRows()).toEqual(agendaBefore);
	});

	// protects=replace keeps id and name, swaps content, and the preview's currentRows equal the old rows;
	// fails_when=replace creates a new row, renames, or shows the wrong overwritten rows;
	// no_claim=activity-log content.
	it("replace: keeps id and name, swaps content, previews what it overwrites", async () => {
		const p1 = (await save(newTarget)) as Preview;
		const first = (await save(newTarget, { planHash: p1.planHash })) as Applied;
		const oldRows = await templateRows(first.templateId);
		await editAgendaTool
			.handler(
				{
					meetingId: seed.meetingId,
					operations: [
						{ op: "add", label: "Roleplay", minutes: 5, at: "start" },
					],
				},
				{ rawToken: token },
			)
			.then(async (pv) => {
				await editAgendaTool.handler(
					{
						meetingId: seed.meetingId,
						operations: [
							{ op: "add", label: "Roleplay", minutes: 5, at: "start" },
						],
						planHash: (pv as { planHash: string }).planHash,
					},
					{ rawToken: token },
				);
			});
		const target = { mode: "replace", templateId: first.templateId };
		const p2 = (await save(target)) as Preview;
		expect(p2.plan.target.currentRows?.map((r) => r.label)).toEqual(
			oldRows.map((r) => r.label),
		);
		const out = (await save(target, { planHash: p2.planHash })) as Applied;
		expect(out.templateId).toBe(first.templateId);
		const [t] = await testDb
			.select()
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, first.templateId));
		expect(t?.name).toBe("Roleplay agenda");
		const rows = await templateRows(first.templateId);
		expect(rows[0]?.label).toBe("Roleplay");
		expect(rows).toHaveLength(oldRows.length + 1);
	});

	// protects=end to end: an edit_agenda row lands in the saved template;
	// fails_when=the save reads a stale or derived agenda instead of the edited one;
	// no_claim=none.
	it("end to end with edit_agenda", async () => {
		const input = {
			meetingId: seed.meetingId,
			operations: [{ op: "add", label: "Roleplay", minutes: 5, at: "start" }],
		};
		const pv = (await editAgendaTool.handler(input, { rawToken: token })) as {
			planHash: string;
		};
		await editAgendaTool.handler(
			{ ...input, planHash: pv.planHash },
			{ rawToken: token },
		);
		const p = (await save(newTarget)) as Preview;
		const out = (await save(newTarget, { planHash: p.planHash })) as Applied;
		expect(
			(await templateRows(out.templateId)).map(
				(r) => `${r.label}|${r.minutes}`,
			),
		).toContain("Roleplay|5");
	});

	// protects=an agenda edit between preview and apply is PLAN_STALE and writes no template;
	// fails_when=a stale plan is applied;
	// no_claim=none.
	it("an agenda edit between preview and apply is PLAN_STALE", async () => {
		await loadAgendaDraft(seed.meetingId);
		const p = (await save(newTarget)) as Preview;
		const input = {
			meetingId: seed.meetingId,
			operations: [{ op: "add", label: "Late", minutes: 3 }],
		};
		const pv = (await editAgendaTool.handler(input, { rawToken: token })) as {
			planHash: string;
		};
		await editAgendaTool.handler(
			{ ...input, planHash: pv.planHash },
			{ rawToken: token },
		);
		const before = await clubTemplates();
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "PLAN_STALE",
			detail: { planHash: expect.any(String) },
		});
		expect(await clubTemplates()).toEqual(before);
	});

	// protects=a change to only a row's detail makes the plan stale;
	// fails_when=the hash covers only what the rows show (label, minutes);
	// no_claim=none.
	it("a detail-only edit is PLAN_STALE", async () => {
		const draft = await loadAgendaDraft(seed.meetingId);
		const p = (await save(newTarget)) as Preview;
		const row = draft?.rows[0];
		await testDb
			.update(meetingTemplateBeats)
			.set({ detail: `changed ${randomUUID()}` })
			.where(eq(meetingTemplateBeats.id, row?.id ?? ""));
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({ code: "PLAN_STALE" });
	});

	// protects=on a never-opened meeting a change to a club role's declaration (slotsUnordered) makes the plan stale;
	// fails_when=the source hash covers the snapshot's five-field role projection only;
	// no_claim=none.
	it("never-opened: a role's slotsUnordered change is PLAN_STALE", async () => {
		const { roleDefinitions } = await import("#/db/schema");
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				key: "timer",
				name: "Timer",
				category: "functionary",
			})
			.returning({ id: roleDefinitions.id });
		const p = (await save(newTarget)) as Preview;
		await testDb
			.update(roleDefinitions)
			.set({ slotsUnordered: true })
			.where(eq(roleDefinitions.id, def?.id ?? ""));
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({ code: "PLAN_STALE" });
	});

	// protects=a cancelled meeting is LOCKED on preview and on apply;
	// fails_when=a cancelled meeting is a source;
	// no_claim=none.
	it("a cancelled meeting is LOCKED on preview and apply", async () => {
		const p = (await save(newTarget)) as Preview;
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expect(save(newTarget)).rejects.toMatchObject({
			code: "LOCKED",
			detail: { reason: "meeting_cancelled", retryable: false },
		});
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({ code: "LOCKED" });
	});

	// protects=replace naming another club's template, a global one or a private copy is NOT_FOUND;
	// fails_when=the tenant boundary is dropped;
	// no_claim=none.
	it("replace on a foreign, global or private template is NOT_FOUND", async () => {
		const mk = async (clubId: string | null, meetingId: string | null) =>
			(
				await testDb
					.insert(meetingTemplates)
					.values({
						clubId,
						meetingId,
						key: `t-${randomUUID().slice(0, 8)}`,
						name: "X",
					})
					.returning({ id: meetingTemplates.id })
			)[0]?.id ?? "";
		const foreign = await mk(other.clubId, null);
		const global = await mk(null, null);
		await loadAgendaDraft(seed.meetingId);
		const priv = await storedDefs();
		try {
			for (const templateId of [foreign, global, priv ?? ""]) {
				await expect(
					save({ mode: "replace", templateId }),
				).rejects.toMatchObject({ code: "NOT_FOUND" });
			}
		} finally {
			await testDb
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, global));
		}
	});

	// protects=a field from the other mode, and an unknown field, are VALIDATION; a blank name too;
	// fails_when=the union is loose;
	// no_claim=the zod message text.
	it("rejects a wrong-mode field and a blank name", async () => {
		await expect(
			save({ mode: "new", name: "A", templateId: randomUUID() }),
		).rejects.toBeDefined();
		await expect(
			save({ mode: "replace", templateId: randomUUID(), name: "A" }),
		).rejects.toBeDefined();
		await expect(save({ mode: "new", name: "   " })).rejects.toMatchObject({
			code: "VALIDATION",
		});
	});

	// protects=a member and another club's officer get FORBIDDEN and nothing is written;
	// fails_when=the meeting id alone authorises a save;
	// no_claim=none.
	it("refuses a member and another club's officer", async () => {
		const before = await clubTemplates();
		await expect(
			call(
				{ meetingId: seed.meetingId, target: newTarget },
				await mint(seed.memberUserId),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				{ meetingId: seed.meetingId, target: newTarget },
				await mint(other.adminUserId),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await clubTemplates()).toEqual(before);
	});

	// protects=a club archived after the tool's authorization is ARCHIVED, not INTERNAL, and writes no template;
	// fails_when=the seam's archive sentence is unmapped;
	// no_claim=the lock timing, the hook archives after the plan read deterministically.
	it("an archive landing after the plan is ARCHIVED", async () => {
		const p = (await save(newTarget)) as Preview;
		hook.afterSnapshot = async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
		};
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({ code: "ARCHIVED" });
		expect(
			(await clubTemplates()).filter((t) => t.meetingId === null),
		).toHaveLength(0);
	});
});
