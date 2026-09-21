/**
 * DB-backed tests for the agenda editor's club-bank picker (#802): what
 * `loadAgendaDraft` offers as `attachableRoles`, and what picking one does.
 *
 * `attachable-bank-roles.test.ts` beside this file pins the SET ARITHMETIC
 * without a database. This suite pins the two halves that arithmetic cannot
 * see: that the rows it subtracts from are the club's whole bank (one scope
 * since #801, no template axis), and that going through with the attach leaves
 * the club's `role_definitions` row exactly as it found it — same id, same
 * `standing`, same `enabled` — which is what makes the picker a way of saying
 * "this agenda uses that role" rather than a second way of editing the bank.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/agenda-attachable-roles.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { addAgendaRole, loadAgendaDraft } = await import(
	"./meeting-agenda-edit-logic"
);

// Per-run suffix on every key and name this file seeds. Vitest runs test FILES
// in parallel against one shared `tm_test`, so a fixed key collides with
// whatever else is mid-run; every assertion below is scoped to this club's own
// ids besides.
const RUN = Math.random().toString(36).slice(2, 8);

let club: SeededClub;
const madeTemplates: string[] = [];

beforeEach(async () => {
	club = await seedClub();
});

afterEach(async () => {
	// Club first: `meetings.template_id` is ON DELETE RESTRICT against
	// `meeting_templates`, so the template cannot go while the meeting points at
	// it. Deleting the club cascades the meeting and, for a club-scoped
	// template, the template row too; the loop mops up anything club-less and is
	// a no-op for what the cascade already took.
	await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	for (const id of madeTemplates.splice(0)) {
		await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
	}
});

/** The meeting's own private agenda, declaring the club's seeded role. */
async function givePrivateTemplate(declare: { key: string; name: string }[]) {
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: club.clubId,
			meetingId: club.meetingId,
			key: `draft_${RUN}`,
			name: `Draft ${RUN}`,
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	if (declare.length > 0) {
		await testDb.insert(meetingTemplateRoles).values(
			declare.map((r, i) => ({
				templateId: t.id,
				key: r.key,
				name: r.name,
				category: "functionary" as const,
				defaultCount: 1,
				sortOrder: i * 10,
				isSpeakerRole: false,
			})),
		);
	}
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, club.meetingId));
	return t.id;
}

/** Add one role to the club's bank and return its id. */
async function giveBankRole(over: {
	key: string;
	name: string;
	standing?: boolean;
	enabled?: boolean;
	defaultCount?: number;
	sortOrder?: number;
	isSpeakerRole?: boolean;
	category?: "leadership" | "speaker" | "evaluator" | "functionary";
}): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			key: over.key,
			name: over.name,
			category: over.category ?? "functionary",
			defaultCount: over.defaultCount ?? 1,
			sortOrder: over.sortOrder ?? 50,
			isSpeakerRole: over.isSpeakerRole ?? false,
			standing: over.standing ?? true,
			enabled: over.enabled ?? true,
		})
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("role insert failed");
	return row.id;
}

/** The seeded club's one role, given the key and name this file needs. */
async function nameSeededRole(key: string, name: string) {
	await testDb
		.update(roleDefinitions)
		.set({ key, name })
		.where(eq(roleDefinitions.id, club.roleDefinitionId));
}

describe.skipIf(!hasTestDb)("loadAgendaDraft attachable roles", () => {
	it("offers the club's bank minus what this agenda already declares", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await giveBankRole({ key: `grammarian_${RUN}`, name: `Grammarian ${RUN}` });
		await givePrivateTemplate([{ key: `timer_${RUN}`, name: `Timer ${RUN}` }]);

		const draft = await loadAgendaDraft(club.meetingId);

		expect(draft?.roles.map((r) => r.key)).toEqual([`timer_${RUN}`]);
		expect(draft?.attachableRoles.map((r) => r.key)).toEqual([
			`grammarian_${RUN}`,
		]);
	});

	// The gap #802 exists to close. `roleDefScopeOnly`'s either/or is gone, so
	// there is ONE scope — the club — and a role that reached the bank from a
	// contest, or that someone typed into another night's agenda, is offered
	// here exactly like any other. MARKED, not hidden: `standing` rides along so
	// the picker can group it.
	it("INCLUDES a non-standing bank role, with the flag the picker marks it by", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await giveBankRole({
			key: `chief_judge_${RUN}`,
			name: `Chief Judge ${RUN}`,
			standing: false,
		});
		await givePrivateTemplate([{ key: `timer_${RUN}`, name: `Timer ${RUN}` }]);

		const draft = await loadAgendaDraft(club.meetingId);

		expect(draft?.attachableRoles).toEqual([
			expect.objectContaining({
				key: `chief_judge_${RUN}`,
				name: `Chief Judge ${RUN}`,
				standing: false,
			}),
		]);
	});

	it("does NOT offer a role the club has turned off, which attaching would refuse", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await giveBankRole({
			key: `ah_counter_${RUN}`,
			name: `Ah-Counter ${RUN}`,
			enabled: false,
		});
		await givePrivateTemplate([{ key: `timer_${RUN}`, name: `Timer ${RUN}` }]);

		const draft = await loadAgendaDraft(club.meetingId);

		expect(draft?.attachableRoles).toEqual([]);
	});

	it("does not leak another club's roles into the picker", async () => {
		const other = await seedClub();
		try {
			await testDb
				.update(roleDefinitions)
				.set({ key: `foreign_${RUN}`, name: `Foreign ${RUN}` })
				.where(eq(roleDefinitions.id, other.roleDefinitionId));
			await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
			await givePrivateTemplate([]);

			const draft = await loadAgendaDraft(club.meetingId);

			expect(draft?.attachableRoles.map((r) => r.key)).toEqual([
				`timer_${RUN}`,
			]);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	// A standard meeting materialises its agenda on READ, declaring the five
	// keys its beats name as a `roleKey`. `timer`, `ah_counter`, `grammarian`
	// and `vote_counter` are named all over the run of show in beat copy and in
	// the `requiresAnyOf` / `fallbacks` gates, but never as a beat's own key —
	// so before the picker they were absent from this panel with nothing
	// looking broken.
	it("reaches a role the materialised standard agenda never declares", async () => {
		await nameSeededRole("toastmaster_of_the_day", `Toastmaster ${RUN}`);
		await giveBankRole({ key: "grammarian", name: `Grammarian ${RUN}` });

		const draft = await loadAgendaDraft(club.meetingId);
		madeTemplates.push(draft?.templateId ?? "");

		expect(draft?.roles.map((r) => r.key)).not.toContain("grammarian");
		expect(draft?.attachableRoles.map((r) => r.key)).toContain("grammarian");
	});
});

describe.skipIf(!hasTestDb)("attaching a picked bank role", () => {
	it("creates its slots against the club's OWN role_definitions row", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await givePrivateTemplate([]);

		const draft = await loadAgendaDraft(club.meetingId);
		const picked = draft?.attachableRoles.find((r) => r.key === `timer_${RUN}`);
		if (!picked) throw new Error("the seeded role was not offered");

		// Exactly what the panel's "Add to agenda" button sends: the picked
		// role's own four fields, through the same `addAgendaRole` the create
		// form uses.
		await addAgendaRole({
			meetingId: club.meetingId,
			name: picked.name,
			category: picked.category,
			defaultCount: picked.defaultCount,
			isSpeakerRole: picked.isSpeakerRole,
		});

		// No second row for the same conceptual role — the fork #801 ended.
		const bank = await testDb
			.select({ id: roleDefinitions.id })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId));
		expect(bank).toHaveLength(1);

		// And the generated slot joins on the club's id, which is what makes the
		// assign picker's "last served" carry the club's whole history for the
		// role rather than starting a fresh one.
		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleSlots.roleDefinitionId, club.roleDefinitionId),
				),
			);
		// The seeded open slot, plus the one the attach generated.
		expect(slots).toHaveLength(2);
	});

	it("leaves the bank row's standing and enabled flags exactly as they were", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		const judgeId = await giveBankRole({
			key: `chief_judge_${RUN}`,
			name: `Chief Judge ${RUN}`,
			standing: false,
		});
		await givePrivateTemplate([]);

		await addAgendaRole({
			meetingId: club.meetingId,
			name: `Chief Judge ${RUN}`,
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});

		const [after] = await testDb
			.select({
				standing: roleDefinitions.standing,
				enabled: roleDefinitions.enabled,
			})
			.from(roleDefinitions)
			.where(eq(roleDefinitions.id, judgeId));
		// Attaching decides that THIS agenda uses the role. Whether the club runs
		// it every week (`standing`) and whether the club runs it at all
		// (`enabled`) are answers this call has no business rewriting — and
		// flipping `standing` here would put the role on every upcoming meeting
		// through `backfillMissingRoleSlots`.
		expect(after).toEqual({ standing: false, enabled: true });

		// It DID get its places on this one meeting, though: the declaration
		// outranks the bank's standing flag, exactly as it does for a contest.
		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleSlots.roleDefinitionId, judgeId),
				),
			);
		expect(slots).toHaveLength(1);
	});

	it("drops the attached role out of the picker on the next load", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await givePrivateTemplate([]);

		await addAgendaRole({
			meetingId: club.meetingId,
			name: `Timer ${RUN}`,
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		});

		const draft = await loadAgendaDraft(club.meetingId);
		expect(draft?.roles.map((r) => r.key)).toEqual([`timer_${RUN}`]);
		expect(draft?.attachableRoles).toEqual([]);
	});

	it("puts a role CREATED from the panel into the picker's reach on other agendas", async () => {
		await nameSeededRole(`timer_${RUN}`, `Timer ${RUN}`);
		await givePrivateTemplate([]);

		// No club role by this name, so `addAgendaRole` takes its create arm and
		// mints a bank row at `standing = false`.
		await addAgendaRole({
			meetingId: club.meetingId,
			name: `Zoom Host ${RUN}`,
			category: "leadership",
			defaultCount: 1,
			isSpeakerRole: false,
		});

		const minted = await testDb
			.select({
				id: roleDefinitions.id,
				standing: roleDefinitions.standing,
			})
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, club.clubId),
					eq(roleDefinitions.name, `Zoom Host ${RUN}`),
				),
			);
		expect(minted).toHaveLength(1);
		expect(minted[0]?.standing).toBe(false);

		// A SECOND meeting's agenda now offers it, which is the point of minting
		// into the bank rather than into this one template: the role exists for
		// the club from the moment it is created.
		const [second] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: new Date("2026-11-04T00:00:00.000Z"),
				lengthMinutes: 90,
			})
			.returning({ id: meetings.id });
		if (!second) throw new Error("meeting insert failed");

		const draft = await loadAgendaDraft(second.id);
		madeTemplates.push(draft?.templateId ?? "");
		expect(draft?.attachableRoles).toContainEqual(
			expect.objectContaining({ name: `Zoom Host ${RUN}`, standing: false }),
		);
	});
});
