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
import { MAX_TEMPLATE_BEATS } from "#/lib/meeting-template-limits";
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
	/** Runs once just before the seam, after the tool's own checks and hash comparison. */
	beforeSeam: null as null | (() => Promise<void>),
	/** Thrown once by the seam wrapper instead of calling the seam. */
	seamThrows: null as null | Error,
}));
vi.mock("#/server/meeting-templates-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-templates-logic")>();
	return {
		...actual,
		saveMeetingAgendaAsClubTemplate: async (
			...args: Parameters<typeof actual.saveMeetingAgendaAsClubTemplate>
		) => {
			const before = hook.beforeSeam;
			if (before) {
				hook.beforeSeam = null;
				await before();
			}
			const thrown = hook.seamThrows;
			if (thrown) {
				hook.seamThrows = null;
				throw thrown;
			}
			return actual.saveMeetingAgendaAsClubTemplate(...args);
		},
	};
});
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
const { loadAgendaDraft, AGENDA_DEADLOCK_MESSAGE } = await import(
	"#/server/meeting-agenda-edit-logic"
);
const { TemplateTooLargeError } = await import(
	"#/server/meeting-templates-logic"
);
const { REPLACE_TARGET_NOT_LISTED_MESSAGE } = await import(
	"#/server/mcp/tools/list-agenda-templates"
);

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
	async function templateRoles(templateId: string) {
		const rows = await testDb
			.select()
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId))
			.orderBy(asc(meetingTemplateRoles.key));
		return rows.map(({ id: _i, templateId: _t, ...rest }) => rest);
	}
	const shown = (r: Row) => ({
		kind: r.kind,
		label: r.label,
		detail: r.detail,
		minutes: r.minutes,
		roleKey: r.roleKey,
	});
	const projected = (rows: Awaited<ReturnType<typeof templateRows>>): Row[] =>
		rows.map(shown);
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
		hook.beforeSeam = null;
		hook.seamThrows = null;
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
		// Every stored column, not only what a person reads, and the roles too.
		const copy = (await storedDefs()) ?? "";
		expect(rows).toEqual(await templateRows(copy));
		expect(await templateRoles(out.templateId)).toEqual(
			await templateRoles(copy),
		);
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
		const rows = await templateRows(out.templateId);
		expect(rows.map((r) => `${r.label}|${r.minutes}`)).toEqual(agendaBefore);
		const copy = await storedDefs();
		expect(copy).not.toBeNull();
		expect(rows).toEqual(await templateRows(copy ?? ""));
		expect(await templateRoles(out.templateId)).toEqual(
			await templateRoles(copy ?? ""),
		);
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
		expect(p2.plan.target.currentRows).toEqual(projected(oldRows));
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
		// Every stored column equals the meeting's own copy, which now carries it.
		const copy = (await storedDefs()) ?? "";
		expect(rows).toEqual(await templateRows(copy));
		expect(await templateRoles(first.templateId)).toEqual(
			await templateRoles(copy),
		);
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

	// protects=a field from the other mode, an unknown field, and a blank name are each VALIDATION, and the refusal is not INTERNAL;
	// fails_when=the union is loose, or a schema failure escapes as a thrown zod error;
	// no_claim=the zod message text.
	it.each([
		[
			"a templateId on mode new",
			{ mode: "new", name: "A", templateId: randomUUID() },
		],
		[
			"a name on mode replace",
			{ mode: "replace", templateId: randomUUID(), name: "A" },
		],
		["an unknown field", { mode: "new", name: "A", bogus: 1 }],
		["a blank name", { mode: "new", name: "   " }],
	])("VALIDATION for %s", async (_n, target) => {
		await expect(save(target)).rejects.toMatchObject({ code: "VALIDATION" });
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

	// protects=materialising a never-opened meeting between preview and apply (no content change) does NOT make the plan stale;
	// fails_when=the never-opened hash input differs in shape or value from the stored copy's (a false PLAN_STALE);
	// no_claim=a real content change after materialisation, covered by the stale tests.
	it("never-opened: materialisation alone is not PLAN_STALE", async () => {
		expect(await storedDefs()).toBeNull();
		const p = (await save(newTarget)) as Preview;
		await loadAgendaDraft(seed.meetingId); // what the editor's page load does
		expect(await storedDefs()).not.toBeNull();
		const out = (await save(newTarget, { planHash: p.planHash })) as Applied;
		expect(out.applied).toBe(true);
	});

	// protects=a change to a replace TARGET column the rows do not show (handoff) between preview and apply is PLAN_STALE and the target keeps the changed content;
	// fails_when=the target is represented only by its shown rows (no content hash), so an overwrite lands on content the officer never saw;
	// no_claim=none.
	it("replace: a target-side change between preview and apply is PLAN_STALE", async () => {
		const p1 = (await save(newTarget)) as Preview;
		const first = (await save(newTarget, { planHash: p1.planHash })) as Applied;
		const target = { mode: "replace", templateId: first.templateId };
		const p2 = (await save(target)) as Preview;
		await testDb
			.update(meetingTemplateBeats)
			.set({ handoff: true })
			.where(eq(meetingTemplateBeats.templateId, first.templateId));
		await expect(save(target, { planHash: p2.planHash })).rejects.toMatchObject(
			{ code: "PLAN_STALE" },
		);
		expect(
			(await templateRows(first.templateId)).every((r) => r.handoff === true),
		).toBe(true);
	});

	// protects=a cancel landing AFTER the tool's own check, caught by the seam's own sentence, is LOCKED meeting_cancelled and writes no template;
	// fails_when=SAVE_CANCELLED_MESSAGE from the seam is unmapped (INTERNAL);
	// no_claim=the tool's own pre-check, covered by the cancelled test above.
	it("a cancel landing after the tool's check is LOCKED from the seam", async () => {
		await loadAgendaDraft(seed.meetingId);
		const p = (await save(newTarget)) as Preview;
		const before = await clubTemplates();
		hook.beforeSeam = async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
		};
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "LOCKED",
			detail: { reason: "meeting_cancelled", retryable: false },
		});
		expect(await clubTemplates()).toEqual(before);
	});

	// protects=a replace target deleted after the tool's check, caught by the seam, is NOT_FOUND with the list pointer;
	// fails_when=CLUB_TEMPLATE_GONE_MESSAGE from the seam is unmapped (INTERNAL);
	// no_claim=the tool's own target check, covered by the foreign/global/private test.
	it("a replace target deleted after the tool's check is NOT_FOUND from the seam", async () => {
		const p1 = (await save(newTarget)) as Preview;
		const first = (await save(newTarget, { planHash: p1.planHash })) as Applied;
		const target = { mode: "replace", templateId: first.templateId };
		const p2 = (await save(target)) as Preview;
		hook.beforeSeam = async () => {
			await testDb
				.delete(meetingTemplates)
				.where(eq(meetingTemplates.id, first.templateId));
		};
		await expect(save(target, { planHash: p2.planHash })).rejects.toMatchObject(
			{
				code: "NOT_FOUND",
				message: REPLACE_TARGET_NOT_LISTED_MESSAGE,
			},
		);
	});

	// protects=the seam's deadlock sentence is LOCKED with a retryable deadlock detail;
	// fails_when=AGENDA_DEADLOCK_MESSAGE is unmapped (INTERNAL) or marked not retryable;
	// no_claim=that Postgres really deadlocks here; the seam is made to throw its own constant.
	it("the seam's deadlock sentence is LOCKED and retryable", async () => {
		const p = (await save(newTarget)) as Preview;
		hook.seamThrows = new Error(AGENDA_DEADLOCK_MESSAGE);
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "LOCKED",
			detail: { reason: "deadlock", retryable: true },
		});
	});

	// protects=TemplateTooLargeError thrown by the seam is VALIDATION;
	// fails_when=the class is unmapped (INTERNAL);
	// no_claim=that the real seam can throw it; it is made to.
	it("TemplateTooLargeError from the seam is VALIDATION", async () => {
		const p = (await save(newTarget)) as Preview;
		hook.seamThrows = new TemplateTooLargeError();
		await expect(
			save(newTarget, { planHash: p.planHash }),
		).rejects.toMatchObject({ code: "VALIDATION" });
	});

	// protects=a replace target over the beat cap is VALIDATION on preview, not a truncated plan or INTERNAL;
	// fails_when=TemplateTooLargeError from the target read is unmapped;
	// no_claim=none.
	it("a replace target over the beat cap is VALIDATION", async () => {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: seed.clubId,
				key: `big-${randomUUID().slice(0, 8)}`,
				name: "Huge",
			})
			.returning({ id: meetingTemplates.id });
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS + 1 }, (_, i) => ({
				templateId: t?.id ?? "",
				sortOrder: i,
				kind: "event" as const,
				label: `R${i}`,
				minutes: 1,
			})),
		);
		await expect(
			save({ mode: "replace", templateId: t?.id }),
		).rejects.toMatchObject({ code: "VALIDATION" });
	});

	// protects=a meeting with no agenda rows is VALIDATION "no rows", and one over the cap is VALIDATION "too large to copy";
	// fails_when=an empty template is saved, or an oversized snapshot is hashed/saved;
	// no_claim=the exact wording beyond the distinguishing phrase.
	it("a meeting with zero rows or over the row cap is VALIDATION", async () => {
		await loadAgendaDraft(seed.meetingId);
		const copy = (await storedDefs()) ?? "";
		const beats = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, copy));
		await testDb
			.delete(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, copy));
		await expect(save(newTarget)).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("no rows"),
		});
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS + 1 }, (_, i) => ({
				templateId: copy,
				sortOrder: i,
				kind: "event" as const,
				label: `R${i}`,
				minutes: 1,
			})),
		);
		await expect(save(newTarget)).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("too large to copy"),
		});
		expect(beats.length).toBeGreaterThan(0);
		expect(
			(await clubTemplates()).filter((t) => t.meetingId === null),
		).toHaveLength(0);
	});
});
