/**
 * DB-backed tests for `edit_agenda_template`, `duplicate_agenda_template`,
 * `delete_agenda_template` and `adopt_standard_agenda` (#1630), plus the
 * refusals all five tools share. `set_default_agenda_template` has its own
 * file (`default-agenda-template.integration.test.ts`).
 *
 * Every test card reads: protects=<observable>; fails_when=<wrong result it
 * rejects>; no_claim=<what green does not prove>.
 *
 * Races are pinned with hooks the mocked logic module runs at a known point
 * (after a write commits, or before a lock is taken), never with a sleep.
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
	clubAgendaSnapshot,
	editFirstBeat,
	leanTemplate,
	newMeeting,
	standardClub,
} from "#/test/club-agenda-fixtures";
import { cleanup, hasTestDb, type SeededClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const hooks = vi.hoisted(() => ({
	afterEnable: null as null | (() => Promise<void>),
	beforeDuplicate: null as null | (() => Promise<void>),
	beforeDelete: null as null | (() => Promise<void>),
}));
vi.mock("#/server/club-agendas-logic", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("#/server/club-agendas-logic")>();
	return {
		...real,
		setClubTemplateEnabled: async (
			...a: Parameters<typeof real.setClubTemplateEnabled>
		) => {
			const out = await real.setClubTemplateEnabled(...a);
			await hooks.afterEnable?.();
			return out;
		},
		duplicateClubTemplate: async (
			...a: Parameters<typeof real.duplicateClubTemplate>
		) => {
			await hooks.beforeDuplicate?.();
			return real.duplicateClubTemplate(...a);
		},
		deleteClubTemplate: async (
			...a: Parameters<typeof real.deleteClubTemplate>
		) => {
			await hooks.beforeDelete?.();
			return real.deleteClubTemplate(...a);
		},
	};
});

const { hashApiToken } = await import("#/server/api-tokens-logic");
const { editAgendaTemplateTool } = await import(
	"#/server/mcp/tools/edit-agenda-template"
);
const { duplicateAgendaTemplateTool } = await import(
	"#/server/mcp/tools/duplicate-agenda-template"
);
const { deleteAgendaTemplateTool } = await import(
	"#/server/mcp/tools/delete-agenda-template"
);
const { adoptStandardAgendaTool } = await import(
	"#/server/mcp/tools/adopt-standard-agenda"
);
const { setDefaultAgendaTemplateTool } = await import(
	"#/server/mcp/tools/set-default-agenda-template"
);
const { applyTemplateConversion, saveMeetingAgendaAsClubTemplate } =
	await import("#/server/meeting-templates-logic");

type Out = {
	applied: boolean;
	noop?: boolean;
	plan: Record<string, unknown>;
	planHash?: string;
	result?: Record<string, unknown>;
	upcomingMeetingCount?: number;
};

const TOOLS = {
	edit_agenda_template: editAgendaTemplateTool,
	duplicate_agenda_template: duplicateAgendaTemplateTool,
	delete_agenda_template: deleteAgendaTemplateTool,
	set_default_agenda_template: setDefaultAgendaTemplateTool,
	adopt_standard_agenda: adoptStandardAgendaTool,
} as const;
type ToolName = keyof typeof TOOLS;

describe.skipIf(!hasTestDb)("agenda template management tools (#1630)", () => {
	let club: SeededClub;
	let other: SeededClub;
	let adminToken: string;
	const globals: string[] = [];

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}
	const run = (
		name: ToolName,
		input: Record<string, unknown>,
		token = adminToken,
	) =>
		TOOLS[name].handler(input, {
			rawToken: token,
			audience: "officer",
		}) as Promise<Out>;
	/** Preview, then apply with the returned hash. */
	async function previewAndApply(
		name: ToolName,
		input: Record<string, unknown>,
	) {
		const preview = await run(name, input);
		expect(preview.applied).toBe(false);
		const applied = await run(name, { ...input, planHash: preview.planHash });
		return { preview, applied };
	}
	const templateRow = async (id: string) =>
		(
			await testDb
				.select()
				.from(meetingTemplates)
				.where(eq(meetingTemplates.id, id))
		)[0];
	const defaultOf = async (clubId = club.clubId) =>
		(
			await testDb
				.select({ d: clubs.defaultTemplateId })
				.from(clubs)
				.where(eq(clubs.id, clubId))
		)[0]?.d ?? null;
	const setDefaultDirect = (id: string | null) =>
		testDb
			.update(clubs)
			.set({ defaultTemplateId: id })
			.where(eq(clubs.id, club.clubId));
	async function content(templateId: string) {
		const beats = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		const roles = await testDb
			.select()
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId))
			.orderBy(asc(meetingTemplateRoles.key));
		return {
			beats: beats.map(({ id: _i, templateId: _t, ...r }) => r),
			roles: roles.map(({ id: _i, templateId: _t, ...r }) => r),
		};
	}

	beforeEach(async () => {
		club = await standardClub();
		other = await standardClub();
		adminToken = await mint(club.adminUserId);
	});
	afterEach(async () => {
		hooks.afterEnable = hooks.beforeDuplicate = hooks.beforeDelete = null;
		for (const id of globals.splice(0)) {
			await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	// ----------------------------------------------------------------- edit

	// protects=a preview writes no row and the apply leaves the rows the app's rename and enable leave (trimmed name, description, enabled), key kept;
	// fails_when=the preview writes, the name is not trimmed, or the key changes;
	// no_claim=the logic functions' own validation (their suites cover it).
	it("edit: previews without writing, then applies name, description and enabled", async () => {
		const id = await leanTemplate(club.clubId, { name: "Old" });
		const [before] = [await templateRow(id)];
		const snap = await clubAgendaSnapshot(club.clubId);
		const input = {
			clubId: club.clubId,
			templateId: id,
			name: "  New name  ",
			description: " About ",
			enabled: false,
		};
		const preview = await run("edit_agenda_template", input);
		expect(preview.plan).toMatchObject({
			from: { name: "Old", description: null, enabled: true },
			to: { name: "New name", description: "About", enabled: false },
		});
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
		const applied = await run("edit_agenda_template", {
			...input,
			planHash: preview.planHash,
		});
		expect(applied.applied).toBe(true);
		const row = await templateRow(id);
		expect(row).toMatchObject({
			name: "New name",
			description: "About",
			enabled: false,
			key: before?.key,
		});
	});

	// protects=omitted name and description keep the stored values, null clears the description, and enabled alone changes only enabled;
	// fails_when=an omitted field is overwritten or cleared, or enabled alone touches the name;
	// no_claim=the order of the two writes (the partial test covers it).
	it("edit: omitted fields keep, null clears, enabled alone changes only enabled", async () => {
		const id = await leanTemplate(club.clubId, { name: "Keep me" });
		await testDb
			.update(meetingTemplates)
			.set({ description: "Stored" })
			.where(eq(meetingTemplates.id, id));
		const base = { clubId: club.clubId, templateId: id };

		await previewAndApply("edit_agenda_template", { ...base, enabled: false });
		expect(await templateRow(id)).toMatchObject({
			name: "Keep me",
			description: "Stored",
			enabled: false,
		});
		await previewAndApply("edit_agenda_template", { ...base, name: "Renamed" });
		expect(await templateRow(id)).toMatchObject({
			name: "Renamed",
			description: "Stored",
			enabled: false,
		});
		await previewAndApply("edit_agenda_template", {
			...base,
			description: null,
		});
		expect(await templateRow(id)).toMatchObject({
			name: "Renamed",
			description: null,
			enabled: false,
		});
	});

	// protects=a call with no field is VALIDATION, and a bad field is named;
	// fails_when=an empty edit previews as a change, or the refusal does not name the field;
	// no_claim=every length bound (parseClubTemplateFields owns them).
	it("edit: no field and a blank name are VALIDATION", async () => {
		const id = await leanTemplate(club.clubId);
		const base = { clubId: club.clubId, templateId: id };
		await expect(run("edit_agenda_template", base)).rejects.toMatchObject({
			code: "VALIDATION",
		});
		await expect(
			run("edit_agenda_template", { ...base, name: "   " }),
		).rejects.toMatchObject({ code: "VALIDATION", message: /^name: / });
	});

	// protects=disabling the club's default is VALIDATION in the preview and writes nothing;
	// fails_when=the preview offers it, or the template ends up disabled;
	// no_claim=the logic's own refusal under the lock (its suite covers it).
	it("edit: disabling the default is refused in the preview", async () => {
		const id = await leanTemplate(club.clubId);
		await setDefaultDirect(id);
		await expect(
			run("edit_agenda_template", {
				clubId: club.clubId,
				templateId: id,
				enabled: false,
			}),
		).rejects.toMatchObject({ code: "VALIDATION" });
		expect((await templateRow(id))?.enabled).toBe(true);
	});

	// protects=when the enable commits and the club is archived before the rename, the answer is ARCHIVED naming what changed, and the name is unchanged;
	// fails_when=the error hides the committed enable, or the name changed;
	// no_claim=a rollback of the first write (there is none: it is its own transaction).
	it("edit: an archive between the two writes is ARCHIVED with partiallyApplied", async () => {
		const id = await leanTemplate(club.clubId, {
			name: "Stays",
			enabled: false,
		});
		const input = {
			clubId: club.clubId,
			templateId: id,
			name: "Never lands",
			enabled: true,
		};
		const preview = await run("edit_agenda_template", input);
		hooks.afterEnable = async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
		};
		await expect(
			run("edit_agenda_template", { ...input, planHash: preview.planHash }),
		).rejects.toMatchObject({
			code: "ARCHIVED",
			detail: { partiallyApplied: ["enabled"] },
		});
		expect(await templateRow(id)).toMatchObject({
			name: "Stays",
			enabled: true,
		});
	});

	// protects=an edit that changes nothing is a noop and writes nothing on apply;
	// fails_when=the apply reports applied:true, or rewrites the row;
	// no_claim=that the preview of a changing edit differs (the first edit test).
	it("edit: a no-change edit is a noop", async () => {
		const id = await leanTemplate(club.clubId, { name: "Same" });
		const input = { clubId: club.clubId, templateId: id, name: "Same" };
		const preview = await run("edit_agenda_template", input);
		expect(preview.plan.noop).toBe(true);
		const applied = await run("edit_agenda_template", {
			...input,
			planHash: preview.planHash,
		});
		expect(applied).toMatchObject({ applied: false, noop: true });
	});

	// ------------------------------------------------------------ duplicate

	// protects=a preview writes no row, and the apply makes an ENABLED copy named "Copy of ..." whose beats and roles equal the source's;
	// fails_when=the preview writes, the copy is disabled, or any row differs;
	// no_claim=the copy's key (deduplicated by the logic).
	it("duplicate: previews without writing, then copies the rows into an enabled template", async () => {
		const source = await leanTemplate(club.clubId, {
			name: "Contest",
			enabled: false,
		});
		const snap = await clubAgendaSnapshot(club.clubId);
		const input = { clubId: club.clubId, templateId: source };
		const preview = await run("duplicate_agenda_template", input);
		expect(preview.plan).toMatchObject({
			sourceName: "Contest",
			newName: "Copy of Contest",
		});
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
		const applied = await run("duplicate_agenda_template", {
			...input,
			planHash: preview.planHash,
		});
		const copyId = (applied.result as { templateId: string }).templateId;
		expect(await templateRow(copyId)).toMatchObject({
			name: "Copy of Contest",
			enabled: true,
			clubId: club.clubId,
			meetingId: null,
		});
		expect(await content(copyId)).toEqual(await content(source));
	});

	// protects=each apply makes one more copy (the tool is not idempotent);
	// fails_when=a second apply reuses the first copy or fails on the name;
	// no_claim=the key scheme.
	it("duplicate: applying twice makes two copies", async () => {
		const source = await leanTemplate(club.clubId, { name: "Twice" });
		const input = { clubId: club.clubId, templateId: source };
		const a = await previewAndApply("duplicate_agenda_template", input);
		const b = await previewAndApply("duplicate_agenda_template", input);
		expect(a.applied.result?.templateId).not.toBe(b.applied.result?.templateId);
	});

	// ------------------------------------------------------------- delete

	// protects=the preview's rows equal the stored rows and it deletes nothing;
	// fails_when=the rows are missing, reordered or not the stored ones, or the template is gone after a preview;
	// no_claim=the columns the plan hides (the content hash covers them).
	it("delete: the preview lists the stored rows and writes nothing", async () => {
		const id = await leanTemplate(club.clubId, { name: "Doomed" });
		const stored = await content(id);
		const preview = await run("delete_agenda_template", {
			clubId: club.clubId,
			templateId: id,
		});
		expect(preview.plan.rows).toEqual(
			stored.beats.map((b) => ({
				kind: b.kind,
				label: b.label,
				detail: b.detail,
				minutes: b.minutes,
				roleKey: b.roleKey,
			})),
		);
		expect(preview.plan).toMatchObject({ name: "Doomed", isDefault: false });
		expect(await templateRow(id)).toBeDefined();
	});

	// protects=after apply the template is gone and a meeting that had applied it still has its own agenda;
	// fails_when=the meeting loses its copy or points at the deleted row;
	// no_claim=a meeting still pointing at the row itself (forkLegacyPointers' suite).
	it("delete: removes the template and leaves a meeting that applied it on its own copy", async () => {
		const id = await leanTemplate(club.clubId);
		const meetingId = await newMeeting(club.clubId, 7);
		await applyTemplateConversion({
			meetingId,
			clubId: club.clubId,
			templateId: id,
			actorMemberId: null,
		});
		const [m] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		const copy = m?.templateId as string;
		expect(copy).not.toBe(id);
		const copyBefore = await content(copy);
		const { applied } = await previewAndApply("delete_agenda_template", {
			clubId: club.clubId,
			templateId: id,
		});
		expect(applied.result).toEqual({ wasDefault: false });
		expect(await templateRow(id)).toBeUndefined();
		const [after] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		expect(after?.templateId).toBe(copy);
		expect(await content(copy)).toEqual(copyBefore);
	});

	// protects=deleting the default says so in the plan and the result, and the club has no default after;
	// fails_when=wasDefault is false, or the pointer is left dangling;
	// no_claim=what new meetings get afterwards (the logic's suite).
	it("delete: the default is flagged in the plan and cleared", async () => {
		const id = await leanTemplate(club.clubId);
		await setDefaultDirect(id);
		const { preview, applied } = await previewAndApply(
			"delete_agenda_template",
			{ clubId: club.clubId, templateId: id },
		);
		expect(preview.plan.isDefault).toBe(true);
		expect(applied.result).toEqual({ wasDefault: true });
		expect(await defaultOf()).toBeNull();
	});

	// protects=a #909 replace landing after the tool's re-plan and before the delete's lock makes the delete PLAN_STALE and deletes nothing;
	// fails_when=the template is gone, or the answer is not PLAN_STALE with a fresh plan and hash;
	// no_claim=a replace landing before the re-plan (the ordinary stale hash, covered below).
	it("delete: a replace between the re-plan and the lock is PLAN_STALE and deletes nothing", async () => {
		const id = await leanTemplate(club.clubId, { name: "Target" });
		const source = await newMeeting(club.clubId, 7);
		await editFirstBeat(source);
		const input = { clubId: club.clubId, templateId: id };
		const preview = await run("delete_agenda_template", input);
		hooks.beforeDelete = async () => {
			hooks.beforeDelete = null;
			await saveMeetingAgendaAsClubTemplate({
				meetingId: source,
				clubId: club.clubId,
				actorMemberId: null,
				mode: "replace",
				templateId: id,
			});
		};
		const err = await run("delete_agenda_template", {
			...input,
			planHash: preview.planHash,
		}).catch((e) => e);
		expect(err).toMatchObject({ code: "PLAN_STALE" });
		expect(err.detail.planHash).not.toBe(preview.planHash);
		expect(
			(err.detail.plan.rows as { label: string }[]).map((r) => r.label),
		).toContain("Our own opening");
		expect(await templateRow(id)).toBeDefined();
	});

	// -------------------------------------------------------------- adopt

	// protects=the preview creates no template and sets no default, and reports the upcoming count beside the plan;
	// fails_when=a template exists after the preview, or the count is inside the hashed plan;
	// no_claim=the template's content (the logic's suite).
	it("adopt: previews with a count outside the plan and writes nothing", async () => {
		await newMeeting(club.clubId, 7);
		await newMeeting(club.clubId, 14);
		const snap = await clubAgendaSnapshot(club.clubId);
		const preview = await run("adopt_standard_agenda", { clubId: club.clubId });
		expect(preview.upcomingMeetingCount).toBe(2);
		expect(preview.plan).toEqual({
			clubId: club.clubId,
			templateName: "Our standard agenda",
		});
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
	});

	// protects=a meeting created between the preview and the apply does not make the plan stale, and the apply adopts and converts both;
	// fails_when=the apply is PLAN_STALE, or the new meeting is left off the default;
	// no_claim=the converted agenda's content (the logic's suite).
	it("adopt: succeeds when a meeting is created between preview and apply", async () => {
		const first = await newMeeting(club.clubId, 7);
		const preview = await run("adopt_standard_agenda", { clubId: club.clubId });
		const second = await newMeeting(club.clubId, 14);
		const applied = await run("adopt_standard_agenda", {
			clubId: club.clubId,
			planHash: preview.planHash,
		});
		expect(applied.applied).toBe(true);
		const result = applied.result as {
			applied: { meetingId: string }[];
			partial: boolean;
			templateId: string;
		};
		expect(result.applied.map((m) => m.meetingId).sort()).toEqual(
			[first, second].sort(),
		);
		expect(result.partial).toBe(false);
		expect(await defaultOf()).toBe(result.templateId);
		expect(await templateRow(result.templateId)).toMatchObject({
			name: "Our standard agenda",
		});
	});

	// protects=adopting with a default already set is VALIDATION in the preview and the apply, naming the next call;
	// fails_when=a second template is made, or the refusal does not name set_default_agenda_template;
	// no_claim=two simultaneous adoptions (the logic's lock test covers it).
	it("adopt: a club with a default is VALIDATION", async () => {
		const id = await leanTemplate(club.clubId);
		await setDefaultDirect(id);
		const snap = await clubAgendaSnapshot(club.clubId);
		await expect(
			run("adopt_standard_agenda", { clubId: club.clubId }),
		).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("set_default_agenda_template"),
		});
		await expect(
			run("adopt_standard_agenda", {
				clubId: club.clubId,
				planHash: "anything",
			}),
		).rejects.toMatchObject({ code: "VALIDATION" });
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
	});

	// ------------------------------------------------------------- shared

	const NEEDS_TEMPLATE: ToolName[] = [
		"edit_agenda_template",
		"duplicate_agenda_template",
		"delete_agenda_template",
		"set_default_agenda_template",
	];
	/** The smallest valid input for each tool against `templateId`. */
	const inputFor = (name: ToolName, templateId: string | null) => ({
		clubId: club.clubId,
		...(name === "adopt_standard_agenda" ? {} : { templateId }),
		...(name === "edit_agenda_template" ? { name: "Anything" } : {}),
	});

	// protects=a member and another club's officer are refused on all five tools;
	// fails_when=the club id alone opens a tool;
	// no_claim=the wording (the audience suite pins it).
	it.each(
		Object.keys(TOOLS) as ToolName[],
	)("%s refuses a non-officer and another club's officer", async (name) => {
		const id = await leanTemplate(club.clubId);
		const input = inputFor(name, id);
		await expect(
			run(name, input, await mint(club.memberUserId)),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			run(name, input, await mint(other.adminUserId)),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	// protects=a global template, another club's and a meeting's private copy are NOT_FOUND on the four template tools;
	// fails_when=any of them is read, previewed or applied;
	// no_claim=an id that exists nowhere (same code, same path).
	describe.each(
		NEEDS_TEMPLATE,
	)("%s ids that are not the club's own", (name) => {
		const kinds: [string, () => Promise<string>][] = [
			[
				"a global template",
				async () => {
					const [g] = await testDb
						.insert(meetingTemplates)
						.values({
							clubId: null,
							key: `global-1630-${randomUUID()}`,
							name: "Global",
						})
						.returning({ id: meetingTemplates.id });
					globals.push(g?.id as string);
					return g?.id as string;
				},
			],
			["another club's template", () => leanTemplate(other.clubId)],
			[
				"a meeting's private copy",
				async () => {
					const meetingId = await newMeeting(club.clubId, 7);
					await editFirstBeat(meetingId);
					const [m] = await testDb
						.select({ t: meetings.templateId })
						.from(meetings)
						.where(eq(meetings.id, meetingId));
					return m?.t as string;
				},
			],
		];
		it.each(kinds)("%s is NOT_FOUND", async (_label, make) => {
			const id = await make();
			const snap = await clubAgendaSnapshot(club.clubId);
			await expect(run(name, inputFor(name, id))).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: expect.stringContaining("list_agenda_templates"),
			});
			expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
		});
	});

	// protects=a template renamed between preview and apply is PLAN_STALE with a fresh plan on the four template tools;
	// fails_when=the stale apply writes, or the error carries no fresh hash;
	// no_claim=clearing a default (it hashes no template name; its suite covers that).
	it.each(
		NEEDS_TEMPLATE,
	)("%s: a rename after the preview is PLAN_STALE", async (name) => {
		const id = await leanTemplate(club.clubId, { name: "Before" });
		const input = inputFor(name, id);
		const preview = await run(name, input);
		await testDb
			.update(meetingTemplates)
			.set({ name: "After" })
			.where(eq(meetingTemplates.id, id));
		const snap = await clubAgendaSnapshot(club.clubId);
		const err = await run(name, { ...input, planHash: preview.planHash }).catch(
			(e) => e,
		);
		expect(err).toMatchObject({ code: "PLAN_STALE" });
		expect(err.detail.planHash).toEqual(expect.any(String));
		expect(err.detail.planHash).not.toBe(preview.planHash);
		expect(await clubAgendaSnapshot(club.clubId)).toEqual(snap);
	});

	// protects=a club archived between authorization and the logic's lock is ARCHIVED, and nothing is written;
	// fails_when=the plain Error becomes INTERNAL, or the write lands;
	// no_claim=the archived check authorizeToken makes before any of this.
	it.each([
		["duplicate_agenda_template", "beforeDuplicate"],
		["delete_agenda_template", "beforeDelete"],
	] as const)("%s: an archive before the lock is ARCHIVED", async (name, hook) => {
		const id = await leanTemplate(club.clubId);
		const input = inputFor(name, id);
		const preview = await run(name, input);
		hooks[hook] = async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
		};
		await expect(
			run(name, { ...input, planHash: preview.planHash }),
		).rejects.toMatchObject({ code: "ARCHIVED" });
		const templates = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(eq(meetingTemplates.clubId, club.clubId));
		expect(templates).toHaveLength(1);
	});

	// protects=input is validated before the hash is compared, so a bad field is VALIDATION and never reported as stale;
	// fails_when=a bad name with an old hash answers PLAN_STALE;
	// no_claim=every field (the edit test names the name field).
	it("validation comes before the hash comparison", async () => {
		const id = await leanTemplate(club.clubId);
		await expect(
			run("edit_agenda_template", {
				clubId: club.clubId,
				templateId: id,
				name: " ",
				planHash: "not-a-real-hash",
			}),
		).rejects.toMatchObject({ code: "VALIDATION" });
	});
});
