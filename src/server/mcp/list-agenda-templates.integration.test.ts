/**
 * DB-backed tests for `list_agenda_templates` (#1628).
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
	meetingTemplateBeats,
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
import { readsOf, statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { listAgendaTemplatesTool } = await import(
	"#/server/mcp/tools/list-agenda-templates"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { loadAgendaDraft } = await import("#/server/meeting-agenda-edit-logic");

type Listed = {
	clubId: string;
	adopted: boolean;
	defaultTemplateId: string | null;
	templates: {
		id: string;
		name: string;
		scope: "club" | "global";
		enabled: boolean;
		isDefault: boolean;
		rowCount: number | null;
	}[];
	template?: { id: string; name: string; rows: { label: string }[] };
};

const RUN = randomUUID().slice(0, 8);

describe.skipIf(!hasTestDb)("list_agenda_templates (#1628)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let adminToken: string;
	let memberToken: string;
	let globalId: string;
	const extraGlobals: string[] = [];

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}
	async function addTemplate(
		clubId: string | null,
		name: string,
		opts: {
			enabled?: boolean;
			meetingId?: string | null;
			labels?: string[];
		} = {},
	) {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId: opts.meetingId ?? null,
				key: `${RUN}-${randomUUID().slice(0, 6)}`,
				name,
				enabled: opts.enabled ?? true,
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("insert failed");
		const labels = opts.labels ?? ["One", "Two"];
		await testDb.insert(meetingTemplateBeats).values(
			labels.map((label, i) => ({
				templateId: t.id,
				sortOrder: i,
				kind: "event" as const,
				label,
				minutes: 5,
			})),
		);
		return t.id;
	}
	const list = (token: string, input: Record<string, unknown>) =>
		listAgendaTemplatesTool.handler(input, {
			rawToken: token,
			audience: "officer",
		}) as Promise<Listed>;

	beforeEach(async () => {
		seed = await seedClub();
		other = await seedClub();
		adminToken = await mint(seed.adminUserId);
		memberToken = await mint(seed.memberUserId);
		globalId = await addTemplate(null, `Global ${RUN}`);
	});
	afterEach(async () => {
		for (const id of [globalId, ...extraGlobals.splice(0)]) {
			await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
		}
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	// protects=a club's templates (enabled, disabled, default) and the global ones are listed with the right flags;
	// fails_when=a disabled template vanishes, the default is not flagged, or a global is missing;
	// no_claim=the order of globals beyond the source's own order.
	it("lists club templates with enabled and default flags, then globals", async () => {
		const on = await addTemplate(seed.clubId, "On");
		const off = await addTemplate(seed.clubId, "Off", { enabled: false });
		const def = await addTemplate(seed.clubId, "Default");
		await testDb
			.update(clubs)
			.set({ defaultTemplateId: def })
			.where(eq(clubs.id, seed.clubId));
		const out = await list(adminToken, { clubId: seed.clubId });
		const byId = new Map(out.templates.map((t) => [t.id, t]));
		expect(byId.get(on)).toMatchObject({
			scope: "club",
			enabled: true,
			isDefault: false,
			rowCount: 2,
		});
		expect(byId.get(off)).toMatchObject({ scope: "club", enabled: false });
		expect(byId.get(def)).toMatchObject({ scope: "club", isDefault: true });
		expect(byId.get(globalId)).toMatchObject({
			scope: "global",
			enabled: true,
			isDefault: false,
			rowCount: null,
		});
		expect(out.defaultTemplateId).toBe(def);
		expect(out.adopted).toBe(true);
		const firstGlobal = out.templates.findIndex((t) => t.scope === "global");
		expect(
			out.templates.slice(firstGlobal).every((t) => t.scope === "global"),
		).toBe(true);
	});

	// protects=another club's template never appears;
	// fails_when=the listing is not scoped to the club;
	// no_claim=global templates are the same for every club.
	it("never lists another club's template", async () => {
		const theirs = await addTemplate(other.clubId, "Theirs");
		const out = await list(adminToken, { clubId: seed.clubId });
		expect(out.templates.map((t) => t.id)).not.toContain(theirs);
	});

	// protects=a non-officer and an officer of another club are refused;
	// fails_when=the club id alone opens the listing;
	// no_claim=the wording of the refusal.
	it("refuses a member and another club's officer", async () => {
		await expect(
			list(memberToken, { clubId: seed.clubId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const otherToken = await mint(other.adminUserId);
		await expect(
			list(otherToken, { clubId: seed.clubId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	// protects=templateId returns that template's stored rows in order;
	// fails_when=rows are reordered, missing or from another template;
	// no_claim=rows of a global template are the same shape (covered below).
	it("returns the rows of a listed template in order", async () => {
		const id = await addTemplate(seed.clubId, "Mine", {
			labels: ["A", "B", "C"],
		});
		const out = await list(adminToken, { clubId: seed.clubId, templateId: id });
		expect(out.template?.rows.map((r) => r.label)).toEqual(["A", "B", "C"]);
		const g = await list(adminToken, {
			clubId: seed.clubId,
			templateId: globalId,
		});
		expect(g.template?.rows).toHaveLength(2);
	});

	// protects=a templateId the listing did not return (another club's, a meeting's private copy, a disabled global, an unknown id) is NOT_FOUND and NO template content is read for it;
	// fails_when=content is read before the id is checked against the listing (the beats and roles tables are queried);
	// no_claim=which sentence is said beyond the code; the control below proves the spy sees a listed id's reads.
	const notListed: [string, () => Promise<string>][] = [
		["another club's template", () => addTemplate(other.clubId, "Theirs")],
		[
			"a meeting's private copy",
			async () => {
				await loadAgendaDraft(seed.meetingId); // stores the private copy
				const [priv] = await testDb
					.select({ id: meetingTemplates.id })
					.from(meetingTemplates)
					.where(eq(meetingTemplates.meetingId, seed.meetingId));
				return priv?.id ?? "";
			},
		],
		[
			"a disabled global template",
			async () => {
				const id = await addTemplate(null, `Off global ${RUN}`, {
					enabled: false,
				});
				extraGlobals.push(id);
				return id;
			},
		],
		["an unknown id", async () => randomUUID()],
	];
	it.each(
		notListed,
	)("NOT_FOUND, and no content read, for %s", async (_n, make) => {
		const templateId = await make();
		const input = { clubId: seed.clubId, templateId };
		const statements = await statementsDuring(() =>
			list(adminToken, input).catch(() => null),
		);
		await expect(list(adminToken, input)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(statements.length).toBeGreaterThan(0);
		expect(readsOf(statements, "meeting_template_beats")).toEqual([]);
		expect(readsOf(statements, "meeting_template_roles")).toEqual([]);
	});

	// protects=the spy used above sees the content reads of a LISTED template;
	// fails_when=the NOT_FOUND test's "no reads" holds vacuously because nothing is observed;
	// no_claim=none.
	it("control: a listed template's content reads are visible to the spy", async () => {
		const id = await addTemplate(seed.clubId, "Mine");
		const statements = await statementsDuring(() =>
			list(adminToken, { clubId: seed.clubId, templateId: id }),
		);
		expect(readsOf(statements, "meeting_template_beats")).not.toEqual([]);
	});

	// protects=a disabled global template is not listed;
	// fails_when=listAvailableTemplates' enabled filter is lost and a disabled global is offered;
	// no_claim=none.
	it("does not list a disabled global template", async () => {
		const id = await addTemplate(null, `Off global ${RUN}`, { enabled: false });
		extraGlobals.push(id);
		const out = await list(adminToken, { clubId: seed.clubId });
		expect(out.templates.map((t) => t.id)).not.toContain(id);
		expect(out.templates.map((t) => t.id)).toContain(globalId);
	});

	// protects=a listed template over the row cap is VALIDATION, not a truncated list or INTERNAL;
	// fails_when=TemplateTooLargeError is unmapped;
	// no_claim=none.
	it("a listed template over the beat cap is VALIDATION", async () => {
		const id = await addTemplate(seed.clubId, "Huge", {
			labels: Array.from({ length: MAX_TEMPLATE_BEATS + 1 }, (_, i) => `R${i}`),
		});
		await expect(
			list(adminToken, { clubId: seed.clubId, templateId: id }),
		).rejects.toMatchObject({ code: "VALIDATION" });
	});
});
