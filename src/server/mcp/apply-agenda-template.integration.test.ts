/**
 * DB-backed tests for `apply_agenda_template` (#1629). Assertions read the
 * FINAL `role_slots` / `meetings` rows back from the database, not the plan
 * object.
 *
 * Fixture: `seedClub()` has ONE unkeyed "Timer" slot. The target template
 * declares one role ("Contest Chair"), so applying it removes the Timer slot.
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
	roleDefinitions,
	roleSlots,
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

const hook = vi.hoisted(() => ({
	/** Runs once just before the seam, after the tool's own checks. */
	beforeSeam: null as null | (() => Promise<void>),
}));
vi.mock("#/server/meeting-templates-logic", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("#/server/meeting-templates-logic")>();
	return {
		...actual,
		applyTemplateConversion: async (
			...args: Parameters<typeof actual.applyTemplateConversion>
		) => {
			const before = hook.beforeSeam;
			if (before) {
				hook.beforeSeam = null;
				await before();
			}
			return actual.applyTemplateConversion(...args);
		},
	};
});

const { applyAgendaTemplateTool, buildApplyPlan, sortHolders } = await import(
	"#/server/mcp/tools/apply-agenda-template"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { REPLACE_TARGET_NOT_LISTED_MESSAGE } = await import(
	"#/server/mcp/tools/list-agenda-templates"
);
const { digest } = await import("#/lib/mcp-plan");

type Holder = {
	memberId: string | null;
	guestId: string | null;
	name: string;
	roleName: string;
};
type Plan = {
	templateId: string | null;
	templateName: string | null;
	templateRows: { label: string }[] | null;
	templateContentHash: string | null;
	outgoingAgendaHash: string;
	claimedSlotsReleased: number;
	slotsAdded: number;
	releasedHolders: Holder[];
	releasedRoleNames: string[];
	removedRoleNames: string[];
};
type Preview = { applied: false; planHash: string; plan: Plan };
type Applied = { applied: true; plan: Plan };

const h = (roleName: string, name: string, memberId: string): Holder => ({
	memberId,
	guestId: null,
	name,
	roleName,
});

describe("apply_agenda_template plan sorting (#1629)", () => {
	// protects=holders sort by role, then name, then id whatever order they arrive in;
	// fails_when=the sort is dropped or keys on one field, so reordered input changes the plan hash;
	// no_claim=the slot query's real order is exercised in the integration cases.
	it("is stable under reordered holders", () => {
		const a = [
			h("Timer", "Zed", "1"),
			h("Ah", "Amy", "2"),
			h("Timer", "Amy", "3"),
		];
		const b = [...a].reverse();
		expect(digest(sortHolders(a))).toBe(digest(sortHolders(b)));
		expect(sortHolders(a).map((x) => x.memberId)).toEqual(["2", "3", "1"]);
	});

	// protects=two holders with the same role and name still have one order, by member or guest id;
	// fails_when=ties keep input order;
	// no_claim=none.
	it("breaks name ties by member id", () => {
		const a = [h("Timer", "Sam", "2"), h("Timer", "Sam", "1")];
		expect(sortHolders(a).map((x) => x.memberId)).toEqual(["1", "2"]);
	});

	// protects=adding a holder changes the hashed plan;
	// fails_when=holders are dropped before hashing, so an apply would not notice a new claim;
	// no_claim=none.
	it("differs when a holder is added", () => {
		const a = [h("Timer", "Sam", "1")];
		const b = [...a, h("Timer", "Tia", "2")];
		expect(digest(sortHolders(a))).not.toBe(digest(sortHolders(b)));
	});
});

describe.skipIf(!hasTestDb)("apply_agenda_template (#1629)", () => {
	let seed: SeededClub;
	let other: SeededClub;
	let token: string;
	let templateId: string;

	async function mint(userId: string) {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}
	const call = (input: Record<string, unknown>, tk = token) =>
		applyAgendaTemplateTool.handler(input, {
			rawToken: tk,
			audience: "officer",
		});
	const run = (tid: string | null, extra: Record<string, unknown> = {}) =>
		call({ meetingId: seed.meetingId, templateId: tid, ...extra });

	async function makeTemplate(
		clubId: string,
		opts: { roleKey?: string; roleName?: string; meetingId?: string } = {},
	) {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId: opts.meetingId ?? null,
				key: `contest-${randomUUID().slice(0, 8)}`,
				name: "Contest",
			})
			.returning({ id: meetingTemplates.id });
		const id = tpl?.id ?? "";
		await testDb.insert(meetingTemplateRoles).values({
			templateId: id,
			key: opts.roleKey ?? "contest_chair",
			name: opts.roleName ?? "Contest Chair",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 10,
		});
		await testDb.insert(meetingTemplateBeats).values({
			templateId: id,
			sortOrder: 0,
			kind: "event",
			label: "Call to order",
			minutes: 2,
		});
		return id;
	}
	const claim = () =>
		testDb
			.update(roleSlots)
			.set({ assignedMemberId: seed.memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
	async function slotState() {
		const rows = await testDb
			.select({
				id: roleSlots.id,
				member: roleSlots.assignedMemberId,
				name: roleDefinitions.name,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(eq(roleSlots.meetingId, seed.meetingId))
			.orderBy(asc(roleSlots.id));
		return rows;
	}
	async function meetingState() {
		const [m] = await testDb
			.select({ t: meetings.templateId, status: meetings.status })
			.from(meetings)
			.where(eq(meetings.id, seed.meetingId));
		return m;
	}
	async function ownTemplates() {
		return (
			await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, seed.clubId))
		)
			.map((r) => r.id)
			.sort();
	}
	async function roleDefCount() {
		return (
			await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.clubId, seed.clubId))
		).length;
	}

	beforeEach(async () => {
		hook.beforeSeam = null;
		seed = await seedClub();
		other = await seedClub();
		token = await mint(seed.adminUserId);
		templateId = await makeTemplate(seed.clubId);
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	// protects=a preview changes no slot, role definition, template or meeting pointer;
	// fails_when=the preview materialises the template or touches slots;
	// no_claim=activity-log rows are not asserted.
	it("a preview writes nothing", async () => {
		await claim();
		const slots = await slotState();
		const templates = await ownTemplates();
		const defs = await roleDefCount();
		const meeting = await meetingState();
		const out = (await run(templateId)) as Preview;
		expect(out.applied).toBe(false);
		expect(await slotState()).toEqual(slots);
		expect(await ownTemplates()).toEqual(templates);
		expect(await roleDefCount()).toBe(defs);
		expect(await meetingState()).toEqual(meeting);
	});

	// protects=a preview names the member holding a role the template lacks, that role, and the template's stored rows;
	// fails_when=the holder or role is missing, or templateRows differ from the stored beats;
	// no_claim=the app dialog's own rendering of the same plan.
	it("a preview lists the released holder, the role and the template rows", async () => {
		await claim();
		const out = (await run(templateId)) as Preview;
		expect(out.plan.releasedHolders).toEqual([
			{
				memberId: seed.memberId,
				guestId: null,
				name: "Member User",
				roleName: "Timer",
			},
		]);
		expect(out.plan.releasedRoleNames).toEqual(["Timer"]);
		expect(out.plan.removedRoleNames).toEqual(["Timer"]);
		expect(out.plan.templateName).toBe("Contest");
		expect(out.plan.templateRows).toEqual([
			{
				kind: "event",
				label: "Call to order",
				detail: null,
				minutes: 2,
				roleKey: null,
			},
		]);
	});

	// protects=apply with the preview's hash leaves the slots matching the template's roles and returns the previewed plan;
	// fails_when=the slots are not converted, the claim survives on a removed role, or the returned plan differs;
	// no_claim=the returned plan equalling the preview is not evidence for a stale-prone derivation, see the legacy case.
	it("apply with the preview's hash converts the slots", async () => {
		await claim();
		const p = (await run(templateId)) as Preview;
		const out = (await run(templateId, { planHash: p.planHash })) as Applied;
		expect(out.applied).toBe(true);
		expect(out.plan).toEqual(p.plan);
		expect((await slotState()).map((s) => [s.name, s.member])).toEqual([
			["Contest Chair", null],
		]);
		expect((await meetingState())?.t).not.toBeNull();
	});

	// protects=a member claiming a to-be-removed role between preview and apply makes the apply PLAN_STALE naming them, with nothing written;
	// fails_when=the apply releases a holder the officer never saw;
	// no_claim=the claim lands before the tool's entry, so the tool's own re-check is not what is exercised (next test).
	it("a claim between preview and apply is PLAN_STALE and writes nothing", async () => {
		const p = (await run(templateId)) as Preview;
		expect(p.plan.releasedHolders).toEqual([]);
		await claim();
		const slots = await slotState();
		await expect(
			run(templateId, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "PLAN_STALE",
			detail: {
				plan: { releasedHolders: [{ memberId: seed.memberId }] },
			},
		});
		expect(await slotState()).toEqual(slots);
		expect((await meetingState())?.t).toBeNull();
	});

	// protects=a claim injected after the tool's entry and before the seam's meeting lock is caught by the check under the lock (PLAN_STALE, nothing written);
	// fails_when=expectPlan is not called, or only the tool's unlocked plan is compared;
	// no_claim=a claim after expectPlan has passed is the seam's slot-lock test.
	it("a claim before the seam's lock is caught under the lock", async () => {
		const p = (await run(templateId)) as Preview;
		hook.beforeSeam = async () => {
			await claim();
		};
		await expect(
			run(templateId, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "PLAN_STALE",
			detail: { plan: { releasedHolders: [{ memberId: seed.memberId }] } },
		});
		expect((await slotState()).map((s) => s.member)).toEqual([seed.memberId]);
		expect((await meetingState())?.t).toBeNull();
	});

	// protects=an agenda edit between preview and apply is PLAN_STALE and the edit survives;
	// fails_when=the outgoing agenda is not part of the plan, so the apply retires an edited copy the officer never saw;
	// no_claim=the edit is a direct write to the private copy's beat, not through edit_agenda.
	it("an agenda edit between preview and apply is PLAN_STALE and survives", async () => {
		// Put the meeting on a template first, so it owns a private copy to edit.
		const first = (await run(templateId)) as Preview;
		await run(templateId, { planHash: first.planHash });
		const copy = (await meetingState())?.t ?? "";
		expect(copy).not.toBe("");
		const second = await makeTemplate(seed.clubId, { roleName: "Other Chair" });
		const p = (await run(second)) as Preview;
		await testDb
			.update(meetingTemplateBeats)
			.set({ minutes: 99 })
			.where(eq(meetingTemplateBeats.templateId, copy));
		await expect(run(second, { planHash: p.planHash })).rejects.toMatchObject({
			code: "PLAN_STALE",
		});
		expect((await meetingState())?.t).toBe(copy);
		const beats = await testDb
			.select({ m: meetingTemplateBeats.minutes })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, copy));
		expect(beats.every((b) => b.m === 99)).toBe(true);
	});

	// protects=the target template replaced (#909) with the same roles but different content between preview and apply is PLAN_STALE;
	// fails_when=the plan hashes only roles, so changed content is applied unseen;
	// no_claim=the replace is simulated by a direct beat update.
	it("a changed template with the same roles is PLAN_STALE", async () => {
		const p = (await run(templateId)) as Preview;
		await testDb
			.update(meetingTemplateBeats)
			.set({ label: "Opening remarks" })
			.where(eq(meetingTemplateBeats.templateId, templateId));
		await expect(
			run(templateId, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "PLAN_STALE",
			detail: { plan: { templateRows: [{ label: "Opening remarks" }] } },
		});
		expect((await meetingState())?.t).toBeNull();
		expect((await slotState()).map((s) => s.name)).toEqual(["Timer"]);
	});

	// protects=an unkeyed legacy role whose bank role was renamed: the preview and the final plan differ, so the first apply is PLAN_STALE with the LOCKED plan and applying with that plan's hash succeeds;
	// fails_when=the tool returns a fresh unlocked preview (never converges) or applies the unseen release;
	// no_claim=other legacy shapes (a role renamed in the template, not the bank).
	it("a legacy unkeyed role converges through the locked plan", async () => {
		await testDb.insert(roleDefinitions).values({
			clubId: seed.clubId,
			key: "timer",
			name: "Time Keeper",
			category: "functionary",
			isSpeakerRole: false,
		});
		const tpl = await makeTemplate(seed.clubId, {
			roleKey: "timer",
			roleName: "Timer",
		});
		await claim();
		const p = (await run(tpl)) as Preview;
		expect(p.plan.claimedSlotsReleased).toBe(0);
		let stale: { detail: { plan: Plan; planHash: string } } | undefined;
		try {
			await run(tpl, { planHash: p.planHash });
		} catch (err) {
			stale = err as typeof stale;
		}
		expect(stale).toMatchObject({ code: "PLAN_STALE" });
		expect(stale?.detail.plan.claimedSlotsReleased).toBe(1);
		expect(await slotState()).toHaveLength(1);
		const out = (await run(tpl, {
			planHash: stale?.detail.planHash,
		})) as Applied;
		expect(out.applied).toBe(true);
		expect((await slotState()).map((s) => s.name)).toEqual(["Time Keeper"]);
	});

	// protects=a meeting with no private agenda copy, applying a template that declares a named standard role (Table Topics Master) the club's bank lacks (the seam mints it), applies on the FIRST call with the preview's hash: the outgoing agenda is hashed before the seam's writes;
	// fails_when=the outgoing hash is read after the seam minted the bank row or detached/copied templates (the apply's hash then differs from the preview's and the first apply is PLAN_STALE);
	// no_claim=a meeting that already has a private copy (the copy is re-keyed, but its content hash is unchanged).
	it("a template declaring a role the bank lacks applies on the first call", async () => {
		const tpl = await makeTemplate(seed.clubId, {
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
		});
		expect((await meetingState())?.t).toBeNull();
		const p = (await run(tpl)) as Preview;
		const out = (await run(tpl, { planHash: p.planHash })) as Applied;
		expect(out.applied).toBe(true);
		expect(out.plan).toEqual(p.plan);
		expect((await slotState()).map((s) => s.name)).toEqual([
			"Table Topics Master",
		]);
	});

	// protects=templateId null restores the club's standard shape: the standard Timer slot is back and the template's role is gone;
	// fails_when=null is treated as a no-op or leaves the template's slots;
	// no_claim=a standard shape with more than one role.
	it("templateId null restores the standard agenda", async () => {
		const first = (await run(templateId)) as Preview;
		await run(templateId, { planHash: first.planHash });
		expect((await slotState()).map((s) => s.name)).toEqual(["Contest Chair"]);
		const p = (await run(null)) as Preview;
		expect(p.plan.templateId).toBeNull();
		expect(p.plan.templateRows).toBeNull();
		const out = (await run(null, { planHash: p.planHash })) as Applied;
		expect(out.applied).toBe(true);
		expect((await slotState()).map((s) => s.name)).toEqual(["Timer"]);
		expect((await meetingState())?.t).toBeNull();
	});

	// protects=a member and another club's officer get FORBIDDEN, another club's template and a meeting's private copy get NOT_FOUND with the list pointer, nothing written;
	// fails_when=the meeting id or a foreign template id alone authorises an apply;
	// no_claim=a gone template id, the same seam sentence.
	it("refuses a member, a foreign officer and templates the club cannot see", async () => {
		const slots = await slotState();
		await expect(
			call(
				{ meetingId: seed.meetingId, templateId },
				await mint(seed.memberUserId),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(
				{ meetingId: seed.meetingId, templateId },
				await mint(other.adminUserId),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const foreign = await makeTemplate(other.clubId);
		const privateCopy = await makeTemplate(other.clubId, {
			meetingId: other.meetingId,
		});
		for (const id of [foreign, privateCopy, randomUUID()]) {
			await expect(run(id)).rejects.toMatchObject({
				code: "NOT_FOUND",
				message: REPLACE_TARGET_NOT_LISTED_MESSAGE,
			});
			await expect(run(id, { planHash: "anything" })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		}
		expect(await slotState()).toEqual(slots);
	});

	// protects=a completed and a cancelled meeting are each LOCKED on the preview and the apply, with the reason and no retry, and nothing is written;
	// fails_when=planTemplateConversion's missing status check lets a preview through, or a status maps to INTERNAL;
	// no_claim=a status change landing after the tool's check is the seam's sentences, below.
	it("a completed and a cancelled meeting are LOCKED on preview and apply", async () => {
		const p = (await run(templateId)) as Preview;
		const slots = await slotState();
		for (const [status, reason] of [
			["completed", "meeting_completed"],
			["cancelled", "meeting_cancelled"],
		] as const) {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, seed.meetingId));
			const refused = { code: "LOCKED", detail: { reason, retryable: false } };
			await expect(run(templateId)).rejects.toMatchObject(refused);
			await expect(
				run(templateId, { planHash: p.planHash }),
			).rejects.toMatchObject(refused);
		}
		expect(await slotState()).toEqual(slots);
	});

	// protects=a completion or cancel landing after the tool's check is LOCKED from the seam's own sentence, not INTERNAL;
	// fails_when=MEETING_LOCKED_MESSAGE or the cancelled constant from the seam is unmapped;
	// no_claim=none.
	it("a status change after the tool's check is LOCKED from the seam", async () => {
		const p = (await run(templateId)) as Preview;
		for (const [status, reason] of [
			["completed", "meeting_completed"],
			["cancelled", "meeting_cancelled"],
		] as const) {
			hook.beforeSeam = async () => {
				await testDb
					.update(meetings)
					.set({ status })
					.where(eq(meetings.id, seed.meetingId));
			};
			await expect(
				run(templateId, { planHash: p.planHash }),
			).rejects.toMatchObject({
				code: "LOCKED",
				detail: { reason, retryable: false },
			});
			await testDb
				.update(meetings)
				.set({ status: "scheduled" })
				.where(eq(meetings.id, seed.meetingId));
		}
	});

	// protects=an archived club is ARCHIVED, from authorization;
	// fails_when=an archived club's meeting can be re-templated;
	// no_claim=none.
	it("an archived club is ARCHIVED", async () => {
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await expect(run(templateId)).rejects.toMatchObject({ code: "ARCHIVED" });
	});

	// protects=plans built from one state hash the same whatever order the holders and role names arrive in;
	// fails_when=the builder passes the detail's order through, so an unordered slot query makes an apply PLAN_STALE;
	// no_claim=the real slot query order, only a fabricated reordering.
	it("two plans from the same state hash the same in any order", async () => {
		const a = h("Timer", "Zed", seed.memberId);
		const b = h("Ah-Counter", "Amy", seed.adminMemberId);
		const detail = (holders: Holder[], names: string[]) => ({
			openSlotsRemoved: 0,
			claimedSlotsReleased: 2,
			slotsWithSpeeches: 0,
			slotsAdded: 0,
			releasedHolders: holders,
			releasedRoleNames: names,
			removedRoleNames: names,
		});
		const one = await buildApplyPlan(
			testDb,
			seed.meetingId,
			templateId,
			detail([a, b], ["Timer", "Ah-Counter"]),
			"outgoing",
		);
		const two = await buildApplyPlan(
			testDb,
			seed.meetingId,
			templateId,
			detail([b, a], ["Ah-Counter", "Timer"]),
			"outgoing",
		);
		expect(digest(one)).toBe(digest(two));
	});

	// protects=a Postgres deadlock from the seam is LOCKED with reason deadlock and retryable true, not INTERNAL;
	// fails_when=isDeadlock is dropped from mapError or the detail is wrong;
	// no_claim=a real deadlock victim; the error is injected at the seam's entry with SQLSTATE 40P01.
	it("a deadlock from the seam is LOCKED and retryable", async () => {
		const p = (await run(templateId)) as Preview;
		hook.beforeSeam = async () => {
			throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
		};
		await expect(
			run(templateId, { planHash: p.planHash }),
		).rejects.toMatchObject({
			code: "LOCKED",
			detail: { reason: "deadlock", retryable: true },
		});
		expect((await meetingState())?.t).toBeNull();
	});

	// protects=a template over the row cap is VALIDATION on the preview, not INTERNAL;
	// fails_when=TemplateTooLargeError is unmapped;
	// no_claim=the cap on roles (same class, same arm).
	it("a template over the row cap is VALIDATION", async () => {
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS }, (_, i) => ({
				templateId,
				sortOrder: 1000 + i,
				kind: "event" as const,
				label: `Filler ${i}`,
				minutes: 1,
			})),
		);
		await expect(run(templateId)).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("too large"),
		});
	});

	// protects=a meetingId that is not a uuid and a templateId that is neither a uuid nor null are VALIDATION naming the field, before any lookup;
	// fails_when=the schema parse is skipped or its issues are not surfaced;
	// no_claim=none.
	it("malformed ids are VALIDATION", async () => {
		await expect(call({ meetingId: "nope", templateId })).rejects.toMatchObject(
			{
				code: "VALIDATION",
				message: expect.stringContaining("meetingId"),
			},
		);
		await expect(run("not-a-uuid")).rejects.toMatchObject({
			code: "VALIDATION",
			message: expect.stringContaining("templateId"),
		});
	});
});
