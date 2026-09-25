/**
 * DB-backed tests for saving a meeting's agenda as a club template (#909).
 *
 * Fixture facts (`src/test/db.ts`): `seedClub()` makes one club with one
 * meeting whose `template_id` is null — never opened in the editor. Club-owned
 * templates and private copies cascade from the club, so `cleanup` removes
 * everything this file writes except GLOBAL templates, which it tracks and
 * deletes itself.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@127.0.0.1:5433/tm_test \
 *     bunx vitest run src/server/save-club-template.integration.test.ts
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import { resolveAgendaRows } from "#/lib/agenda-runsheet";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { MAX_TEMPLATE_BEATS } from "#/lib/meeting-template-limits";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** The gate reads the SESSION off the request, which vitest has none of —
 *  mocked at the library boundary so `requireClubRole` and
 *  `assertClubNotArchived` stay real against real rows. */
let sessionUserId: string | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const {
	applyTemplateConversion,
	CLUB_TEMPLATE_GONE_MESSAGE,
	listAvailableTemplates,
	loadTemplateContent,
	requireMeetingTemplateEditor,
	saveMeetingAgendaAsClubTemplate,
} = await import("./meeting-templates-logic");
const { loadAgendaDraft } = await import("./meeting-agenda-edit-logic");

/** Every beat column but `id` and `template_id`, in agenda order. Read with a
 *  bare `select()` and stripped, so a column added to the table later is
 *  compared too — the explicit copy list is exactly what could forget it. */
async function beatsOf(templateId: string) {
	const rows = await testDb
		.select()
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, templateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder));
	return rows.map(({ id: _id, templateId: _t, ...rest }) => rest);
}

async function rolesOf(templateId: string) {
	const rows = await testDb
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(
			asc(meetingTemplateRoles.sortOrder),
			asc(meetingTemplateRoles.key),
		);
	return rows.map(({ id: _id, templateId: _t, ...rest }) => rest);
}

async function templateOf(meetingId: string): Promise<string> {
	const [m] = await testDb
		.select({ templateId: meetings.templateId })
		.from(meetings)
		.where(eq(meetings.id, meetingId));
	if (!m?.templateId) throw new Error("meeting has no template");
	return m.templateId;
}

async function templateRow(id: string) {
	const [row] = await testDb
		.select()
		.from(meetingTemplates)
		.where(eq(meetingTemplates.id, id));
	return row;
}

/** What the print route renders for a meeting, minus its slots (two
 *  meetings' slots differ by id, and that is not what is being compared). */
async function printedRows(meetingId: string) {
	const content = await loadTemplateContent(await templateOf(meetingId));
	return resolveAgendaRows({
		geIntroducesFunctionaries: false,
		tableTopicsLimits: null,
		template: content,
		slots: [],
	});
}

describe.skipIf(!hasTestDb)("saveMeetingAgendaAsClubTemplate", () => {
	let club: SeededClub;
	const otherClubs: SeededClub[] = [];
	const globalTemplates: string[] = [];

	beforeEach(async () => {
		club = await seedClub();
		sessionUserId = null;
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		for (const other of otherClubs.splice(0)) {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
		if (globalTemplates.length > 0) {
			await testDb
				.delete(meetingTemplates)
				.where(inArray(meetingTemplates.id, globalTemplates.splice(0)));
		}
	});

	async function addMeeting(
		clubId: string,
		status: "scheduled" | "completed" | "cancelled" = "scheduled",
	): Promise<string> {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status,
			})
			.returning({ id: meetings.id });
		if (!m) throw new Error("Failed to insert meeting");
		return m.id;
	}

	/** Open the meeting in the editor (materialises its private copy), then
	 *  make its content distinctive. `handoff` is switched on because a
	 *  hand-written copy list has forgotten it before; `club_governed` is
	 *  already set on the materialised Table Topics row (one per template, by
	 *  index), which the first test asserts survived. */
	async function editedSource(meetingId: string, label: string) {
		await loadAgendaDraft(meetingId);
		const copyId = await templateOf(meetingId);
		const [first] = await testDb
			.select({ id: meetingTemplateBeats.id })
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, copyId))
			.orderBy(asc(meetingTemplateBeats.sortOrder))
			.limit(1);
		await testDb
			.update(meetingTemplateBeats)
			.set({ label, handoff: true, minutes: 7 })
			.where(eq(meetingTemplateBeats.id, first?.id as string));
		await testDb
			.update(meetingTemplates)
			.set({ defaultLengthMinutes: 95 })
			.where(eq(meetingTemplates.id, copyId));
		return copyId;
	}

	function saveNew(meetingId: string, name: string, clubId = club.clubId) {
		return saveMeetingAgendaAsClubTemplate({
			mode: "new",
			meetingId,
			clubId,
			actorMemberId: null,
			name,
			description: null,
		});
	}

	function replace(meetingId: string, templateId: string) {
		return saveMeetingAgendaAsClubTemplate({
			mode: "replace",
			meetingId,
			clubId: club.clubId,
			actorMemberId: null,
			templateId,
		});
	}

	it("saves a club-owned copy equal to the source, visible to this club only", async () => {
		const sourceId = await editedSource(club.meetingId, "Guest introductions");
		const { templateId } = await saveNew(club.meetingId, "  Contest night  ");

		const row = await templateRow(templateId);
		expect(row).toMatchObject({
			clubId: club.clubId,
			meetingId: null,
			key: "contest-night",
			name: "Contest night",
			description: null,
			enabled: true,
			defaultLengthMinutes: 95,
		});
		expect(await beatsOf(templateId)).toEqual(await beatsOf(sourceId));
		expect(await rolesOf(templateId)).toEqual(await rolesOf(sourceId));
		const saved = await beatsOf(templateId);
		expect(saved[0]).toMatchObject({
			label: "Guest introductions",
			handoff: true,
		});
		expect(saved.filter((b) => b.clubGoverned)).toHaveLength(1);
		// The source meeting still reads its own copy.
		expect(await templateOf(club.meetingId)).toBe(sourceId);

		expect(
			(await listAvailableTemplates(club.clubId)).map((t) => t.id),
		).toContain(templateId);
		const other = await seedClub();
		otherClubs.push(other);
		expect(
			(await listAvailableTemplates(other.clubId)).map((t) => t.id),
		).not.toContain(templateId);
	});

	it("applied to another meeting, gives it the source's agenda and print output", async () => {
		await editedSource(club.meetingId, "Guest introductions");
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const second = await addMeeting(club.clubId);
		await applyTemplateConversion({
			meetingId: second,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});

		const secondCopy = await templateOf(second);
		expect(secondCopy).not.toBe(templateId);
		expect(await beatsOf(secondCopy)).toEqual(
			await beatsOf(await templateOf(club.meetingId)),
		);
		const printed = await printedRows(second);
		expect(printed.length).toBeGreaterThan(0);
		expect(printed).toEqual(await printedRows(club.meetingId));
	});

	async function savedRows() {
		return testDb
			.select({
				actorMemberId: activityLog.actorMemberId,
				targetType: activityLog.targetType,
				targetId: activityLog.targetId,
				detail: activityLog.detail,
			})
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, club.clubId),
					eq(activityLog.action, "club_template_saved"),
				),
			)
			.orderBy(asc(activityLog.createdAt));
	}

	it("writes one club_template_saved row per save, in both modes", async () => {
		const created = await saveMeetingAgendaAsClubTemplate({
			mode: "new",
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
			name: "Contest night",
			description: null,
		});
		expect(await savedRows()).toEqual([
			{
				actorMemberId: club.adminMemberId,
				targetType: "meeting",
				targetId: club.meetingId,
				detail: {
					templateId: created.templateId,
					mode: "new",
					sourceMeetingId: club.meetingId,
				},
			},
		]);

		const second = await addMeeting(club.clubId);
		await saveMeetingAgendaAsClubTemplate({
			mode: "replace",
			meetingId: second,
			clubId: club.clubId,
			actorMemberId: club.adminMemberId,
			templateId: created.templateId,
		});
		const rows = await savedRows();
		expect(rows).toHaveLength(2);
		expect(rows[1]).toEqual({
			actorMemberId: club.adminMemberId,
			targetType: "meeting",
			targetId: second,
			detail: {
				templateId: created.templateId,
				mode: "replace",
				sourceMeetingId: second,
			},
		});
	});

	it("a refused save writes no activity row", async () => {
		const other = await seedClub();
		otherClubs.push(other);
		const theirs = await saveNew(other.meetingId, "Theirs", other.clubId);
		await expect(replace(club.meetingId, theirs.templateId)).rejects.toThrow(
			CLUB_TEMPLATE_GONE_MESSAGE,
		);
		expect(await savedRows()).toEqual([]);
	});

	it("dedupes the key: two saves named the same get -2", async () => {
		const a = await saveNew(club.meetingId, "Contest night");
		const b = await saveNew(club.meetingId, "Contest night");
		expect((await templateRow(a.templateId))?.key).toBe("contest-night");
		expect((await templateRow(b.templateId))?.key).toBe("contest-night-2");
	});

	it("refuses an empty name and writes nothing", async () => {
		await expect(saveNew(club.meetingId, "   ")).rejects.toThrow(
			"Give the template a name.",
		);
		const owned = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(
					eq(meetingTemplates.clubId, club.clubId),
					isNull(meetingTemplates.meetingId),
				),
			);
		expect(owned).toEqual([]);
	});

	it("replace swaps content, keeps id/key/name, and leaves earlier meetings alone", async () => {
		await editedSource(club.meetingId, "Version one");
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const before = await templateRow(templateId);

		// A meeting that took the template BEFORE the replace.
		const earlier = await addMeeting(club.clubId);
		await applyTemplateConversion({
			meetingId: earlier,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		const earlierBeats = await beatsOf(await templateOf(earlier));

		// Edit the source again, then replace.
		await editedSource(club.meetingId, "Version two");
		const result = await replace(club.meetingId, templateId);
		expect(result.templateId).toBe(templateId);

		const after = await templateRow(templateId);
		expect(after).toMatchObject({
			id: before?.id,
			key: before?.key,
			name: before?.name,
			description: before?.description,
			enabled: before?.enabled,
			sortOrder: before?.sortOrder,
		});
		expect((await beatsOf(templateId))[0]?.label).toBe("Version two");
		expect(await beatsOf(templateId)).toEqual(
			await beatsOf(await templateOf(club.meetingId)),
		);
		expect(await beatsOf(await templateOf(earlier))).toEqual(earlierBeats);
		expect(earlierBeats[0]?.label).toBe("Version one");
	});

	describe("tenant boundary on replace", () => {
		async function expectRefusedUnchanged(targetId: string) {
			const beforeBeats = await beatsOf(targetId);
			const beforeOwned = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, club.clubId));
			await expect(replace(club.meetingId, targetId)).rejects.toThrow(
				CLUB_TEMPLATE_GONE_MESSAGE,
			);
			expect(await beatsOf(targetId)).toEqual(beforeBeats);
			const afterOwned = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, club.clubId));
			expect(afterOwned.map((r) => r.id).sort()).toEqual(
				beforeOwned.map((r) => r.id).sort(),
			);
		}

		it("refuses another club's template", async () => {
			const other = await seedClub();
			otherClubs.push(other);
			const { templateId } = await saveNew(
				other.meetingId,
				"Theirs",
				other.clubId,
			);
			await expectRefusedUnchanged(templateId);
		});

		it("refuses a global template", async () => {
			const [g] = await testDb
				.insert(meetingTemplates)
				.values({
					clubId: null,
					key: `global_${crypto.randomUUID().slice(0, 8)}`,
					name: "Global",
				})
				.returning({ id: meetingTemplates.id });
			globalTemplates.push(g?.id as string);
			await testDb.insert(meetingTemplateBeats).values({
				templateId: g?.id as string,
				sortOrder: 0,
				kind: "event",
				label: "Global row",
				minutes: 1,
			});
			await expectRefusedUnchanged(g?.id as string);
		});

		it("refuses a private per-meeting copy, even this club's own", async () => {
			const second = await addMeeting(club.clubId);
			await loadAgendaDraft(second);
			await expectRefusedUnchanged(await templateOf(second));
		});
	});

	it("forks a meeting pointing straight at the target onto its own copy", async () => {
		await editedSource(club.meetingId, "Version one");
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const legacy = await addMeeting(club.clubId);
		// Old data: a meeting reading the shared row itself.
		await testDb
			.update(meetings)
			.set({ templateId })
			.where(eq(meetings.id, legacy));
		const legacyBefore = await printedRows(legacy);

		await editedSource(club.meetingId, "Version two");
		await replace(club.meetingId, templateId);

		const legacyTemplate = await templateOf(legacy);
		expect(legacyTemplate).not.toBe(templateId);
		expect((await templateRow(legacyTemplate))?.meetingId).toBe(legacy);
		expect(await printedRows(legacy)).toEqual(legacyBefore);
		expect((await beatsOf(legacyTemplate))[0]?.label).toBe("Version one");
	});

	it("a source that IS the target keeps its content and is forked", async () => {
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const legacy = await addMeeting(club.clubId);
		await testDb
			.update(meetings)
			.set({ templateId })
			.where(eq(meetings.id, legacy));
		const contentBefore = await beatsOf(templateId);
		expect(contentBefore.length).toBeGreaterThan(0);

		await replace(legacy, templateId);

		expect(await beatsOf(templateId)).toEqual(contentBefore);
		const forked = await templateOf(legacy);
		expect(forked).not.toBe(templateId);
		expect(await beatsOf(forked)).toEqual(contentBefore);
	});

	it("saves the standard agenda from a never-opened meeting, GE variant respected", async () => {
		// Counted against the materialiser itself rather than a literal: the
		// issue's 22/23 predate later run-of-show changes, and the claim is
		// "the same agenda the editor would have built", not a number.
		const plain = await saveNew(club.meetingId, "Plain");
		const plainSeed = materialiseRunOfShow(false, null);
		expect(await beatsOf(plain.templateId)).toHaveLength(plainSeed.length);

		await testDb
			.update(clubs)
			.set({ geIntroducesFunctionaries: true })
			.where(eq(clubs.id, club.clubId));
		const unopened = await addMeeting(club.clubId);
		const ge = await saveNew(unopened, "With GE");
		const geSeed = materialiseRunOfShow(true, null);
		expect(geSeed.length).toBe(plainSeed.length + 1);
		expect(await beatsOf(ge.templateId)).toHaveLength(geSeed.length);
		// It materialised the meeting's own copy on the way, as the editor would.
		expect((await templateRow(await templateOf(unopened)))?.meetingId).toBe(
			unopened,
		);
	});

	it("refuses a cancelled source and allows a completed one", async () => {
		const cancelled = await addMeeting(club.clubId, "cancelled");
		await expect(saveNew(cancelled, "Nope")).rejects.toThrow(/cancelled/);
		// What the editor reads to hide the control, from the same load.
		expect((await loadAgendaDraft(cancelled))?.cancelled).toBe(true);
		const completed = await addMeeting(club.clubId, "completed");
		expect((await loadAgendaDraft(completed))?.cancelled).toBe(false);
		const { templateId } = await saveNew(completed, "Last week");
		expect((await beatsOf(templateId)).length).toBeGreaterThan(0);
	});

	it("refuses a meeting from another club than the gate resolved", async () => {
		const other = await seedClub();
		otherClubs.push(other);
		await expect(saveNew(other.meetingId, "Stolen")).rejects.toThrow(
			"Meeting not found.",
		);
	});

	it("a replace that throws midway leaves the target's content unchanged", async () => {
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const before = await beatsOf(templateId);
		// Push the source over the cap: the copy refuses AFTER the target's
		// content has been deleted inside the transaction.
		const sourceId = await templateOf(club.meetingId);
		await testDb.insert(meetingTemplateBeats).values(
			Array.from({ length: MAX_TEMPLATE_BEATS }, (_, i) => ({
				templateId: sourceId,
				sortOrder: 1000 + i,
				kind: "event" as const,
				label: `Filler ${i}`,
				minutes: 1,
			})),
		);
		await expect(replace(club.meetingId, templateId)).rejects.toThrow(
			/too large/,
		);
		expect(await beatsOf(templateId)).toEqual(before);
	});

	it("re-applying a template to a meeting running a club template's copy works", async () => {
		// The detach step in `applyTemplateConversion` clears the outgoing copy's
		// `meeting_id`; with the copy's key equal to the club template's, that
		// used to trip `meeting_templates_club_key_unique`.
		const { templateId } = await saveNew(club.meetingId, "Contest night");
		const second = await addMeeting(club.clubId);
		await applyTemplateConversion({
			meetingId: second,
			clubId: club.clubId,
			templateId,
			actorMemberId: null,
		});
		await expect(
			applyTemplateConversion({
				meetingId: second,
				clubId: club.clubId,
				templateId,
				actorMemberId: null,
			}),
		).resolves.toBeDefined();
		await expect(
			applyTemplateConversion({
				meetingId: second,
				clubId: club.clubId,
				templateId: null,
				actorMemberId: null,
			}),
		).resolves.toBeDefined();
	});

	describe("the club lock", () => {
		it("refuses an archived club inside the save, and writes nothing", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
			await expect(saveNew(club.meetingId, "Contest night")).rejects.toThrow(
				CLUB_ARCHIVED_MESSAGE,
			);
			const owned = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, club.clubId));
			// Not even the never-opened meeting's materialised copy: the gate runs
			// before it.
			expect(owned).toEqual([]);
			expect(await savedRows()).toEqual([]);
		});

		it("does not wait behind another writer's foreign-key lock on the club", async () => {
			// Any insert referencing the club (a slot, an activity row, another
			// meeting's materialised copy) holds KEY SHARE on the club row until
			// it commits. A save taking FOR UPDATE on that row queued behind every
			// such writer, and two saves each holding KEY SHARE from their own
			// materialise deadlocked. NO KEY UPDATE does not conflict with it.
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from clubs where id = ${club.clubId} for key share`,
				);
			});
			try {
				const outcome = await Promise.race([
					saveNew(club.meetingId, "Contest night").then(() => "saved"),
					new Promise((r) => setTimeout(() => r("blocked"), 4000)),
				]);
				expect(outcome).toBe("saved");
			} finally {
				await blocker.commit();
			}
		});

		it("two concurrent saves from never-opened meetings both land", async () => {
			const second = await addMeeting(club.clubId);
			const results = await Promise.all([
				saveNew(club.meetingId, "Contest night"),
				saveNew(second, "Contest night"),
			]);
			const keys = await Promise.all(
				results.map(async (r) => (await templateRow(r.templateId))?.key),
			);
			expect(keys.sort()).toEqual(["contest-night", "contest-night-2"]);
		});
	});

	describe("copy vs replace", () => {
		it("a copy waits for an in-flight replace and sees its content whole", async () => {
			const { templateId } = await saveNew(club.meetingId, "Contest night");
			const second = await addMeeting(club.clubId);
			// Stand-in for a replace mid-swap: the target locked FOR UPDATE, its
			// roles and beats already swapped, not yet committed.
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meeting_templates where id = ${templateId} for update`,
				);
				await tx
					.delete(meetingTemplateBeats)
					.where(eq(meetingTemplateBeats.templateId, templateId));
				await tx
					.delete(meetingTemplateRoles)
					.where(eq(meetingTemplateRoles.templateId, templateId));
				await tx.insert(meetingTemplateRoles).values({
					templateId,
					key: "new_role",
					name: "New role",
					category: "functionary",
					defaultCount: 1,
					sortOrder: 0,
				});
				await tx.insert(meetingTemplateBeats).values({
					templateId,
					sortOrder: 0,
					kind: "role",
					label: "New beat",
					minutes: 3,
					roleKey: "new_role",
				});
			});
			const applying = applyTemplateConversion({
				meetingId: second,
				clubId: club.clubId,
				templateId,
				actorMemberId: null,
			});
			applying.catch(() => {});
			try {
				await waitForLockWait("for share", blocker.pid);
			} finally {
				await blocker.commit();
			}
			await applying;
			const copy = await templateOf(second);
			expect(await rolesOf(copy)).toEqual(await rolesOf(templateId));
			expect(await beatsOf(copy)).toEqual(await beatsOf(templateId));
			expect((await beatsOf(copy)).map((b) => b.label)).toEqual(["New beat"]);
		});

		it("a replace waits for an in-flight copy before swapping content", async () => {
			const { templateId } = await saveNew(club.meetingId, "Contest night");
			// Stand-in for a copier between its roles read and its beats read.
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meeting_templates where id = ${templateId} for share`,
				);
			});
			const replacing = replace(club.meetingId, templateId);
			replacing.catch(() => {});
			try {
				await waitForLockWait("for update", blocker.pid);
			} finally {
				await blocker.commit();
			}
			await expect(replacing).resolves.toEqual({ templateId });
		});
	});

	describe("the server fn's gate", () => {
		it("admits a club admin and returns the gate's club", async () => {
			sessionUserId = club.adminUserId;
			const gate = await requireMeetingTemplateEditor(club.meetingId);
			expect(gate.clubId).toBe(club.clubId);
			expect(gate.membership.id).toBe(club.adminMemberId);
		});

		it("refuses a plain member", async () => {
			sessionUserId = club.memberUserId;
			await expect(
				requireMeetingTemplateEditor(club.meetingId),
			).rejects.toThrow();
		});

		it("refuses an archived club", async () => {
			sessionUserId = club.adminUserId;
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
			await expect(
				requireMeetingTemplateEditor(club.meetingId),
			).rejects.toThrow();
		});
	});
});
