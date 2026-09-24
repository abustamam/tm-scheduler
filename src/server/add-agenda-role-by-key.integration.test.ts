/**
 * #836 — attaching a bank role from the Roles panel's PICKER resolves by the
 * bank row's key, not by the name the page loaded with.
 *
 * The bug's two outcomes, each reproduced from the state a rename between
 * page load and click leaves behind:
 *
 * 1. FORK. The club renamed the role, so the stale name matches nothing and
 *    the create arm minted a second `role_definitions` row.
 * 2. WRONG ROLE, SILENTLY. The club renamed role A and gave A's old name to
 *    role B, so the click attached B.
 *
 * The typed box sends no key, and its name path is pinned here unchanged.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5433/tm_test \
 *     bunx vitest run src/server/add-agenda-role-by-key.integration.test.ts
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

const { addAgendaRole } = await import("./meeting-agenda-edit-logic");

const RUN = Math.random().toString(36).slice(2, 8);

let club: SeededClub;

beforeEach(async () => {
	club = await seedClub();
	// A meeting-owned template, so `ensureAgendaDraft` resolves straight to it
	// without forking. Club-scoped, so `cleanup`'s cascade removes it.
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
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, club.meetingId));
});

afterEach(async () => {
	await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
});

async function bankRole(key: string, name: string) {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			key,
			name,
			category: "functionary",
			defaultCount: 1,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("bank insert failed");
	return row.id;
}

async function rename(id: string, name: string) {
	await testDb
		.update(roleDefinitions)
		.set({ name })
		.where(eq(roleDefinitions.id, id));
}

async function bankIds() {
	const rows = await testDb
		.select({ id: roleDefinitions.id })
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, club.clubId));
	return rows.map((r) => r.id).sort();
}

async function slotRoleIds() {
	const rows = await testDb
		.select({ roleDefinitionId: roleSlots.roleDefinitionId })
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, club.meetingId));
	return rows.map((r) => r.roleDefinitionId);
}

const PICKED = {
	category: "functionary" as const,
	defaultCount: 1,
	isSpeakerRole: false,
};

describe.skipIf(!hasTestDb)("addAgendaRole — picked by key (#836)", () => {
	it("attaches the PICKED role when its old name has gone to a different role", async () => {
		const oldName = `Clock ${RUN}`;
		const a = await bankRole(`a_${RUN}`, oldName);
		const b = await bankRole(`b_${RUN}`, `Other ${RUN}`);
		// Page loaded; the picker holds { key: a, name: oldName }. Then the club
		// renames A and gives its old name to B.
		await rename(a, `Chrono ${RUN}`);
		await rename(b, oldName);
		const before = await bankIds();

		const added = await addAgendaRole({
			meetingId: club.meetingId,
			key: `a_${RUN}`,
			name: oldName,
			...PICKED,
		});

		expect(added.key).toBe(`a_${RUN}`);
		expect(added.name).toBe(`Chrono ${RUN}`);
		// A's id carries the slots — B's history is untouched.
		const slots = await slotRoleIds();
		expect(slots).toContain(a);
		expect(slots).not.toContain(b);
		expect(await bankIds()).toEqual(before);
	});

	it("attaches the same row rather than forking when the role was renamed", async () => {
		const a = await bankRole(`a_${RUN}`, `Clock ${RUN}`);
		await rename(a, `Chrono ${RUN}`);
		const before = await bankIds();

		const added = await addAgendaRole({
			meetingId: club.meetingId,
			key: `a_${RUN}`,
			name: `Clock ${RUN}`,
			...PICKED,
		});

		expect(added.key).toBe(`a_${RUN}`);
		expect(await bankIds()).toEqual(before);
		expect(await slotRoleIds()).toContain(a);
	});

	it("refuses a key that no longer resolves, and mints nothing", async () => {
		// A different role holds the name the stale picker carries: falling back
		// to the name would attach it, which is the bug.
		const b = await bankRole(`b_${RUN}`, `Clock ${RUN}`);
		const before = await bankIds();

		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				key: `gone_${RUN}`,
				name: `Clock ${RUN}`,
				...PICKED,
			}),
		).rejects.toThrow(/no longer one of this club's roles/);

		expect(await bankIds()).toEqual(before);
		expect(await slotRoleIds()).not.toContain(b);
		const declared = await testDb
			.select({ key: meetingTemplateRoles.key })
			.from(meetingTemplateRoles)
			.innerJoin(
				meetings,
				eq(meetings.templateId, meetingTemplateRoles.templateId),
			)
			.where(eq(meetings.id, club.meetingId));
		expect(declared).toHaveLength(0);
	});

	it("refuses a picked role whose CURRENT name is already on the agenda", async () => {
		await bankRole(`c_${RUN}`, `Taken ${RUN}`);
		await addAgendaRole({
			meetingId: club.meetingId,
			key: `c_${RUN}`,
			name: `Taken ${RUN}`,
			...PICKED,
		});
		const a = await bankRole(`a_${RUN}`, `Clock ${RUN}`);
		await rename(a, `Taken ${RUN}`);

		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				key: `a_${RUN}`,
				name: `Clock ${RUN}`,
				...PICKED,
			}),
		).rejects.toThrow(`"Taken ${RUN}" is already on this agenda.`);
		expect(await slotRoleIds()).not.toContain(a);
	});

	it("does not refuse a picked role because its STALE name is on the agenda", async () => {
		// The page-load name now belongs to a declared role; the picked role's
		// current name is free. That is not a duplicate.
		await bankRole(`c_${RUN}`, `Taken ${RUN}`);
		await addAgendaRole({
			meetingId: club.meetingId,
			key: `c_${RUN}`,
			name: `Taken ${RUN}`,
			...PICKED,
		});
		const a = await bankRole(`a_${RUN}`, `Other ${RUN}`);

		await expect(
			addAgendaRole({
				meetingId: club.meetingId,
				key: `a_${RUN}`,
				name: `Taken ${RUN}`,
				...PICKED,
			}),
		).resolves.toMatchObject({ key: `a_${RUN}`, name: `Other ${RUN}` });
		expect(await slotRoleIds()).toContain(a);
	});

	it("keeps the typed path by NAME when no key is sent", async () => {
		const a = await bankRole(`a_${RUN}`, `Clock ${RUN}`);
		const before = await bankIds();

		const added = await addAgendaRole({
			meetingId: club.meetingId,
			name: `clock ${RUN}`,
			...PICKED,
		});

		expect(added.key).toBe(`a_${RUN}`);
		expect(await bankIds()).toEqual(before);
		const [slot] = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(
				and(
					eq(roleSlots.meetingId, club.meetingId),
					eq(roleSlots.roleDefinitionId, a),
				),
			);
		expect(slot).toBeDefined();
	});
});
