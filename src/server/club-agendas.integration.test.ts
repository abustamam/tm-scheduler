/**
 * DB-backed tests for the club default agenda (#910): setting and clearing
 * the default, adopting the standard agenda, managing club templates, the
 * tenant boundary on every template-keyed write, new meetings inheriting the
 * default, and the General Evaluator lock.
 *
 * Fixture: `seedClub()` gives one club with a key-less "Timer" and one
 * meeting. `standardClub()` swaps both for the nine stock roles
 * (`ROLE_TEMPLATE`, as a club creation seeds them) and no meetings, because
 * "the standard agenda" is only meaningful against a club that has the roles
 * its beats name. GLOBAL templates are club-less and survive `cleanup`, so
 * this file tracks and deletes its own.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubMeetingRecurrence,
	clubs,
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import { GE_LOCKED_MESSAGE } from "#/lib/club-agendas-copy";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { ROLE_TEMPLATE } from "#/lib/role-template";
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

/** The gate reads the SESSION off the request; mocked at the library
 *  boundary so `requireClubRole` and `assertClubNotArchived` stay real. */
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

const logic = await import("./club-agendas-logic");
const {
	adoptStandardAgenda,
	adoptionRoles,
	assertGeChangeAllowed,
	CLUB_TEMPLATE_DISABLED_MESSAGE,
	CLUB_TEMPLATE_GONE_MESSAGE,
	deleteClubTemplate,
	DISABLE_DEFAULT_MESSAGE,
	duplicateClubTemplate,
	duplicateName,
	listClubAgendas,
	renameClubTemplate,
	setClubDefaultTemplate,
	setClubTemplateEnabled,
} = logic;
const {
	applyTemplateConversion,
	requireClubTemplateEditor,
	saveMeetingAgendaAsClubTemplate,
	WouldReleaseError,
} = await import("./meeting-templates-logic");
const { loadAgendaDraft } = await import("./meeting-agenda-edit-logic");
const { insertMeetingWithSlots } = await import("./meeting-create-logic");
const { applyCreateMeeting } = await import("./meetings-logic");
const { applyBatchCreateMeetings } = await import("./batch-meetings-logic");
const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("club default agenda (#910)", () => {
	let club: SeededClub;
	const otherClubs: SeededClub[] = [];
	const globalTemplates: string[] = [];

	beforeEach(async () => {
		club = await standardClub();
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

	// -------------------------------------------------------------------------
	// Fixture helpers
	// -------------------------------------------------------------------------

	/** `seedClub()` with the stock roles and no meetings. */
	async function standardClub(): Promise<SeededClub> {
		const seeded = await seedClub();
		await testDb.delete(meetings).where(eq(meetings.clubId, seeded.clubId));
		await testDb
			.delete(roleDefinitions)
			.where(eq(roleDefinitions.id, seeded.roleDefinitionId));
		await testDb
			.insert(roleDefinitions)
			.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: seeded.clubId })));
		return seeded;
	}

	async function bank(clubId = club.clubId) {
		return testDb
			.select()
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, clubId))
			.orderBy(asc(roleDefinitions.sortOrder));
	}

	/** A meeting created exactly as the batch path creates one. */
	async function newMeeting(daysAhead: number, clubId = club.clubId) {
		const id = await testDb.transaction(async (tx) =>
			insertMeetingWithSlots(
				tx,
				{
					clubId,
					scheduledAt: new Date(Date.now() + daysAhead * DAY),
					lengthMinutes: 90,
					location: null,
				},
				await bank(clubId),
			),
		);
		if (!id) throw new Error("meeting not created");
		return id;
	}

	async function meetingRow(meetingId: string) {
		const [m] = await testDb
			.select()
			.from(meetings)
			.where(eq(meetings.id, meetingId));
		if (!m) throw new Error("no meeting");
		return m;
	}

	async function templateRow(id: string) {
		const [row] = await testDb
			.select()
			.from(meetingTemplates)
			.where(eq(meetingTemplates.id, id));
		return row;
	}

	async function defaultOf(clubId = club.clubId) {
		const [row] = await testDb
			.select({ id: clubs.defaultTemplateId })
			.from(clubs)
			.where(eq(clubs.id, clubId));
		return row?.id ?? null;
	}

	async function beatsOf(templateId: string) {
		const rows = await testDb
			.select()
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		return rows.map(({ id: _id, templateId: _t, ...rest }) => rest);
	}

	async function rolesOf(templateId: string) {
		return testDb
			.select({
				key: meetingTemplateRoles.key,
				defaultCount: meetingTemplateRoles.defaultCount,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, templateId))
			.orderBy(asc(meetingTemplateRoles.key));
	}

	/** Role key → slot count on a meeting. */
	async function slotCounts(meetingId: string) {
		const rows = await testDb
			.select({ key: roleDefinitions.key })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(eq(roleSlots.meetingId, meetingId));
		const out: Record<string, number> = {};
		for (const r of rows) out[r.key ?? "?"] = (out[r.key ?? "?"] ?? 0) + 1;
		return out;
	}

	/** The stock roles minus `drop`, at their stock counts. */
	function stockCounts(drop: string[] = []) {
		return Object.fromEntries(
			ROLE_TEMPLATE.filter((r) => !drop.includes(r.key)).map((r) => [
				r.key,
				r.defaultCount,
			]),
		);
	}

	/**
	 * A club template that runs WITHOUT the Ah-Counter: the standard beats minus
	 * the Ah-Counter's, and every stock role but that one. What a club that
	 * dropped the role would have saved (#909).
	 */
	async function leanTemplate(
		clubId = club.clubId,
		opts: { enabled?: boolean; key?: string } = {},
	) {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId,
				meetingId: null,
				key: opts.key ?? `lean-${randomUUID().slice(0, 8)}`,
				name: "Lean meeting",
				enabled: opts.enabled ?? true,
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("no template");
		const seeds = materialiseRunOfShow(false, null)
			.filter((s) => s.roleKey !== "ah_counter")
			.map((s, i) => ({ ...s, sortOrder: i, templateId: tpl.id }));
		await testDb.insert(meetingTemplateBeats).values(seeds);
		await testDb.insert(meetingTemplateRoles).values(
			ROLE_TEMPLATE.filter((r) => r.key !== "ah_counter").map((r, i) => ({
				templateId: tpl.id,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				isSpeakerRole: r.isSpeakerRole,
				sortOrder: i,
			})),
		);
		return tpl.id;
	}

	async function globalTemplate() {
		const [tpl] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: null,
				meetingId: null,
				key: `global-910-${randomUUID()}`,
				name: "Global",
			})
			.returning({ id: meetingTemplates.id });
		if (!tpl) throw new Error("no global template");
		globalTemplates.push(tpl.id);
		return tpl.id;
	}

	async function claim(meetingId: string, roleKey: string) {
		const [slot] = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(
				and(
					eq(roleSlots.meetingId, meetingId),
					eq(roleDefinitions.key, roleKey),
				),
			)
			.limit(1);
		if (!slot) throw new Error(`no ${roleKey} slot`);
		await testDb
			.update(roleSlots)
			.set({
				assignedMemberId: club.memberId,
				status: "claimed",
				claimedAt: new Date(),
			})
			.where(eq(roleSlots.id, slot.id));
		return slot.id;
	}

	async function claimedCount(clubId = club.clubId) {
		const rows = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(and(eq(meetings.clubId, clubId), eq(roleSlots.status, "claimed")));
		return rows.length;
	}

	function setDefault(templateId: string | null, clubId = club.clubId) {
		return setClubDefaultTemplate({ clubId, templateId, actorMemberId: null });
	}

	/** Asserts the meeting reads a PRIVATE copy of `sourceId`. */
	async function expectOnCopyOf(meetingId: string, sourceId: string) {
		const m = await meetingRow(meetingId);
		expect(m.templateId).not.toBeNull();
		expect(m.templateId).not.toBe(sourceId);
		const copy = await templateRow(m.templateId as string);
		const source = await templateRow(sourceId);
		expect(copy?.meetingId).toBe(meetingId);
		expect(copy?.clubId).toBe(m.clubId);
		expect(copy?.key).toBe(source?.key);
		expect(await beatsOf(m.templateId as string)).toEqual(
			await beatsOf(sourceId),
		);
	}

	// -------------------------------------------------------------------------
	// Set default (R7 / AC2)
	// -------------------------------------------------------------------------

	describe("setting a default", () => {
		it("applies to unopened and opened-unedited meetings, keeps edited ones and sign-ups, and names each (AC2)", async () => {
			const a = await newMeeting(7); // never opened
			const b = await newMeeting(14); // opened, not edited
			const c = await newMeeting(21); // opened and edited
			const d = await newMeeting(28); // standard, Ah-Counter claimed
			await loadAgendaDraft(b);
			await loadAgendaDraft(c);
			const cCopy = (await meetingRow(c)).templateId as string;
			const bCopy = (await meetingRow(b)).templateId as string;
			const [firstBeat] = await testDb
				.select({ id: meetingTemplateBeats.id })
				.from(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, cCopy))
				.orderBy(asc(meetingTemplateBeats.sortOrder))
				.limit(1);
			await testDb
				.update(meetingTemplateBeats)
				.set({ label: "Our own opening" })
				.where(eq(meetingTemplateBeats.id, firstBeat?.id as string));
			const dSlot = await claim(d, "ah_counter");
			const claimedBefore = await claimedCount();

			const lean = await leanTemplate();
			const result = await setDefault(lean);

			expect(await defaultOf()).toBe(lean);
			await expectOnCopyOf(a, lean);
			await expectOnCopyOf(b, lean);
			// B's materialised copy was retired, not left orphaned.
			expect(await templateRow(bCopy)).toBeUndefined();
			expect((await meetingRow(c)).templateId).toBe(cCopy);
			expect((await meetingRow(d)).templateId).toBeNull();

			expect(result.applied.map((m) => m.meetingId)).toEqual([a, b]);
			expect(result.keptEdited).toEqual([
				expect.objectContaining({ meetingId: c, onDefaultCopy: false }),
			]);
			expect(result.keptSignups).toEqual([
				expect.objectContaining({ meetingId: d, roles: ["Ah-Counter"] }),
			]);
			expect(result.failed).toEqual([]);

			// Nothing released anywhere.
			expect(await claimedCount()).toBe(claimedBefore);
			const [held] = await testDb
				.select({ member: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, dSlot));
			expect(held?.member).toBe(club.memberId);
			// A and B now have the lean shape's slots: no Ah-Counter.
			expect(await slotCounts(a)).toEqual(stockCounts(["ah_counter"]));
		});

		it("reads a copy opened before the club changed a role as edited, and keeps it", async () => {
			const b = await newMeeting(7);
			await loadAgendaDraft(b);
			const copy = (await meetingRow(b)).templateId as string;
			// The club runs one more speaker now than the copy declares.
			const speakers =
				ROLE_TEMPLATE.find((r) => r.key === "speaker")?.defaultCount ?? 0;
			await testDb
				.update(roleDefinitions)
				.set({ defaultCount: speakers + 1 })
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.key, "speaker"),
					),
				);
			const result = await setDefault(await leanTemplate());
			expect(result.keptEdited.map((m) => m.meetingId)).toEqual([b]);
			expect((await meetingRow(b)).templateId).toBe(copy);
		});

		it("keeps a meeting on a copy of another template even when its content matches the standard", async () => {
			// A club template saved from an opened, unedited meeting has exactly
			// the standard's content; a meeting that APPLIED it is on that
			// template, not on the standard agenda, and is kept.
			const source = await newMeeting(5);
			await loadAgendaDraft(source);
			const { templateId: saved } = await saveMeetingAgendaAsClubTemplate({
				mode: "new",
				meetingId: source,
				clubId: club.clubId,
				actorMemberId: null,
				name: "Saved standard",
				description: null,
			});
			const x = await newMeeting(12);
			await applyTemplateConversion({
				meetingId: x,
				clubId: club.clubId,
				templateId: saved,
				actorMemberId: null,
			});
			const onSaved = (await meetingRow(x)).templateId;
			const result = await setDefault(await leanTemplate());
			expect(result.keptEdited.map((m) => m.meetingId)).toContain(x);
			expect((await meetingRow(x)).templateId).toBe(onSaved);
		});

		it("skips completed, cancelled and past meetings", async () => {
			const done = await newMeeting(7);
			const off = await newMeeting(14);
			const past = await newMeeting(-3);
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, done));
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, off));
			const result = await setDefault(await leanTemplate());
			expect(result.applied).toEqual([]);
			for (const id of [done, off, past]) {
				expect((await meetingRow(id)).templateId).toBeNull();
			}
		});

		it("is safe to re-run: converted meetings read as already on a copy", async () => {
			const a = await newMeeting(7);
			const lean = await leanTemplate();
			await setDefault(lean);
			const copy = (await meetingRow(a)).templateId;
			const again = await setDefault(lean);
			expect(again.applied).toEqual([]);
			expect(again.keptEdited).toEqual([
				expect.objectContaining({ meetingId: a, onDefaultCopy: true }),
			]);
			expect((await meetingRow(a)).templateId).toBe(copy);
		});

		it("refuses a disabled template with its own sentence, and writes nothing", async () => {
			const off = await leanTemplate(club.clubId, { enabled: false });
			await expect(setDefault(off)).rejects.toThrow(
				CLUB_TEMPLATE_DISABLED_MESSAGE,
			);
			expect(await defaultOf()).toBeNull();
		});

		it("logs one club_default_template_set row with the counts", async () => {
			await newMeeting(7);
			const lean = await leanTemplate();
			await setDefault(lean);
			const rows = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, club.clubId),
						eq(activityLog.action, "club_default_template_set"),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.detail).toEqual({
				templateId: lean,
				applied: 1,
				keptEdited: 0,
				keptSignups: 0,
				failed: 0,
			});
		});

		it("refuses an archived club", async () => {
			const lean = await leanTemplate();
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
			await expect(setDefault(lean)).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
			await expect(
				adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null }),
			).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
			expect(await defaultOf()).toBeNull();
		});
	});

	describe("clearing the default (AC3)", () => {
		it("changes no meeting, and the next new meeting starts on the standard agenda", async () => {
			const a = await newMeeting(7);
			const lean = await leanTemplate();
			await setDefault(lean);
			const before = (await meetingRow(a)).templateId;

			const result = await setDefault(null);

			expect(result.applied).toEqual([]);
			expect(await defaultOf()).toBeNull();
			expect((await meetingRow(a)).templateId).toBe(before);
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: club.clubId,
				mode: "interval",
				weekday: new Date(Date.now() + 2 * DAY).getUTCDay(),
				intervalWeeks: 1,
				anchorDate: new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10),
				timeOfDay: "18:45",
				keepAhead: 2,
				enabled: true,
			});
			const { created } = await ensureScheduleToppedUp(club.clubId, new Date());
			expect(created).toBeGreaterThan(0);
			const fresh = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(
					and(eq(meetings.clubId, club.clubId), isNull(meetings.templateId)),
				);
			expect(fresh.length).toBe(created);
		});
	});

	// -------------------------------------------------------------------------
	// Adopt (AC5)
	// -------------------------------------------------------------------------

	describe("adopting the standard agenda", () => {
		for (const [ge, rows, handoffs] of [
			[false, 28, 5],
			[true, 29, 6],
		] as const) {
			it(`creates the standard agenda as a club template and makes it the default (geIntro=${ge})`, async () => {
				await testDb
					.update(clubs)
					.set({ geIntroducesFunctionaries: ge })
					.where(eq(clubs.id, club.clubId));
				const result = await adoptStandardAgenda({
					clubId: club.clubId,
					actorMemberId: null,
				});
				const id = result.templateId as string;
				expect(await defaultOf()).toBe(id);
				const tpl = await templateRow(id);
				expect(tpl).toMatchObject({
					clubId: club.clubId,
					meetingId: null,
					key: "standard",
					name: "Our standard agenda",
					enabled: true,
				});
				const beats = await beatsOf(id);
				// Literals (R6): 22 or 23 template beats, one of which seeds a
				// preamble row (#719), plus five bands. The GE variant carries the
				// extra hand-off, `geOpeningHandoff`.
				expect(beats).toHaveLength(rows);
				expect(beats.filter((b) => b.handoff)).toHaveLength(handoffs);
				expect(
					beats.filter((b) => b.kind === "section").map((b) => b.label),
				).toEqual([
					"OPENING",
					"SPEECHES",
					"TABLE TOPICS",
					"EVALUATIONS",
					"CLOSING",
				]);
				expect(beats).toEqual(
					materialiseRunOfShow(ge, { minSeconds: null, maxSeconds: null }),
				);
				expect(await rolesOf(id)).toEqual(
					ROLE_TEMPLATE.map((r) => ({
						key: r.key,
						defaultCount: r.defaultCount,
					})).sort((x, y) => (x.key < y.key ? -1 : 1)),
				);
			});
		}

		it("refuses a second adoption, and adopting over a chosen default", async () => {
			await adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null });
			await expect(
				adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null }),
			).rejects.toThrow("Your club already has a default agenda.");
			const owned = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(
					and(
						eq(meetingTemplates.clubId, club.clubId),
						isNull(meetingTemplates.meetingId),
					),
				);
			expect(owned).toHaveLength(1);
		});

		it("serialises two concurrent adoptions into one template", async () => {
			const results = await Promise.allSettled([
				adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null }),
				adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null }),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const owned = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(
					and(
						eq(meetingTemplates.clubId, club.clubId),
						isNull(meetingTemplates.meetingId),
					),
				);
			expect(owned).toHaveLength(1);
		});

		it("moves upcoming standard meetings onto it, with the same slots", async () => {
			const a = await newMeeting(7);
			const before = await slotCounts(a);
			const result = await adoptStandardAgenda({
				clubId: club.clubId,
				actorMemberId: null,
			});
			expect(result.applied.map((m) => m.meetingId)).toEqual([a]);
			await expectOnCopyOf(a, result.templateId as string);
			expect(await slotCounts(a)).toEqual(before);
		});

		it("keeps a disabled role off new meetings, and a club-invented role on them", async () => {
			await testDb
				.update(roleDefinitions)
				.set({ enabled: false })
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.key, "ah_counter"),
					),
				);
			await testDb.insert(roleDefinitions).values({
				clubId: club.clubId,
				key: "joke_master",
				name: "Joke Master",
				category: "functionary",
				sortOrder: 100,
			});
			const standardSlots = await slotCounts(await newMeeting(5));
			expect(standardSlots.joke_master).toBe(1);
			expect(standardSlots.ah_counter).toBeUndefined();

			await adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null });
			const fresh = await newMeeting(12);
			expect(await slotCounts(fresh)).toEqual(standardSlots);
		});
	});

	describe("a standard role minted back into the club (#933 guide text)", () => {
		it("carries the stock name, description and guide, generates no slot, and stays off ordinary meetings", async () => {
			await testDb
				.delete(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.key, "table_topics_master"),
					),
				);
			await adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null });
			const fresh = await newMeeting(8);
			const stock = ROLE_TEMPLATE.find((r) => r.key === "table_topics_master");
			const [minted] = await testDb
				.select()
				.from(roleDefinitions)
				.where(
					and(
						eq(roleDefinitions.clubId, club.clubId),
						eq(roleDefinitions.key, "table_topics_master"),
					),
				);
			expect(minted).toMatchObject({
				name: stock?.name,
				description: stock?.description,
				beforeNotes: stock?.beforeNotes,
				duringNotes: stock?.duringNotes,
				standing: false,
			});
			// The club had no Table Topics Master before (a beat names the key, so
			// the adopted template declares it), and adopting does not give its new
			// meetings one.
			expect((await slotCounts(fresh)).table_topics_master).toBeUndefined();
		});
	});

	describe("adoptionRoles", () => {
		const declared = [
			{
				key: "timer",
				name: "Timer",
				category: "functionary" as const,
				defaultCount: 1,
				isSpeakerRole: false,
				slotsUnordered: false,
				sortOrder: 0,
			},
		];
		const bankRow = {
			name: "x",
			category: "functionary" as const,
			defaultCount: 2,
			isSpeakerRole: false,
			slotsUnordered: false,
			standing: true,
			enabled: true,
		};

		it("keeps a role the club runs as declared", () => {
			expect(adoptionRoles(declared, [{ ...bankRow, key: "timer" }])).toEqual(
				declared,
			);
		});

		it("declares a role the club does not run with no places", () => {
			for (const row of [
				{ ...bankRow, key: "timer", enabled: false },
				{ ...bankRow, key: "timer", standing: false },
			]) {
				expect(adoptionRoles(declared, [row])[0]?.defaultCount).toBe(0);
			}
			expect(adoptionRoles(declared, [])[0]?.defaultCount).toBe(0);
		});

		it("appends a keyed role the club runs that no beat names, and skips a key-less one", () => {
			const out = adoptionRoles(declared, [
				{ ...bankRow, key: "timer" },
				{ ...bankRow, key: "joke_master", name: "Joke Master" },
				{ ...bankRow, key: null, name: "Legacy" },
			]);
			expect(out.map((r) => [r.key, r.defaultCount])).toEqual([
				["timer", 1],
				["joke_master", 2],
			]);
		});
	});

	// -------------------------------------------------------------------------
	// Creation inherits the default (AC4)
	// -------------------------------------------------------------------------

	describe("new meetings start on a copy of the default", () => {
		let lean: string;
		beforeEach(async () => {
			lean = await leanTemplate();
			await setDefault(lean);
		});

		async function newestMeeting() {
			const [m] = await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.clubId, club.clubId))
				.orderBy(asc(meetings.createdAt));
			if (!m) throw new Error("no meeting created");
			return m.id;
		}

		it("manual create", async () => {
			const { meetingId } = await applyCreateMeeting({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 16),
			});
			await expectOnCopyOf(meetingId, lean);
			expect(await slotCounts(meetingId)).toEqual(stockCounts(["ah_counter"]));
		});

		it("batch create", async () => {
			const res = await applyBatchCreateMeetings({
				clubId: club.clubId,
				wallTimes: [new Date(Date.now() + 10 * DAY).toISOString().slice(0, 16)],
			});
			expect(res.createdCount).toBe(1);
			const id = await newestMeeting();
			await expectOnCopyOf(id, lean);
			expect(await slotCounts(id)).toEqual(stockCounts(["ah_counter"]));
		});

		it("recurrence top-up", async () => {
			const first = new Date(Date.now() + 3 * DAY);
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: club.clubId,
				mode: "interval",
				weekday: first.getUTCDay(),
				intervalWeeks: 1,
				anchorDate: first.toISOString().slice(0, 10),
				timeOfDay: "18:45",
				keepAhead: 1,
				enabled: true,
			});
			const { created } = await ensureScheduleToppedUp(club.clubId, new Date());
			expect(created).toBe(1);
			const id = await newestMeeting();
			await expectOnCopyOf(id, lean);
			expect(await slotCounts(id)).toEqual(stockCounts(["ah_counter"]));
		});

		it("falls back to the standard agenda when the default is deleted mid-create, and throws nothing", async () => {
			const blocker = await openBlockingTx(async (tx) => {
				await tx.delete(meetingTemplates).where(eq(meetingTemplates.id, lean));
			});
			const creating = applyCreateMeeting({
				clubId: club.clubId,
				scheduledAt: new Date(Date.now() + 10 * DAY).toISOString().slice(0, 16),
			});
			await waitForLockWait("for share", blocker.pid);
			await blocker.commit();
			const { meetingId } = await creating;
			expect((await meetingRow(meetingId)).templateId).toBeNull();
			expect(await slotCounts(meetingId)).toEqual(stockCounts());
		});

		it("never copies a pointer the FK allowed but the rule does not: another club's template, a global one", async () => {
			const other = await standardClub();
			otherClubs.push(other);
			for (const foreign of [
				await leanTemplate(other.clubId),
				await globalTemplate(),
			]) {
				await testDb
					.update(clubs)
					.set({ defaultTemplateId: foreign })
					.where(eq(clubs.id, club.clubId));
				const id = await newMeeting(9 + otherClubs.length);
				expect((await meetingRow(id)).templateId).toBeNull();
				await testDb.delete(meetings).where(eq(meetings.id, id));
			}
		});

		it("falls back when the default was disabled behind the pointer", async () => {
			await testDb
				.update(meetingTemplates)
				.set({ enabled: false })
				.where(eq(meetingTemplates.id, lean));
			const id = await newMeeting(9);
			expect((await meetingRow(id)).templateId).toBeNull();
		});
	});

	// -------------------------------------------------------------------------
	// Template management
	// -------------------------------------------------------------------------

	describe("managing club templates", () => {
		it("lists the club's own templates with the default flagged", async () => {
			const lean = await leanTemplate();
			const other = await leanTemplate();
			await globalTemplate();
			await setDefault(lean);
			const list = await listClubAgendas(club.clubId);
			expect(list.adopted).toBe(true);
			expect(list.templates.map((t) => [t.id, t.isDefault]).sort()).toEqual(
				[
					[lean, true],
					[other, false],
				].sort(),
			);
			expect(list.templates[0]?.beatCount).toBeGreaterThan(20);
		});

		it("renames without touching the key, and validates the name", async () => {
			const lean = await leanTemplate();
			const key = (await templateRow(lean))?.key;
			await renameClubTemplate({
				clubId: club.clubId,
				templateId: lean,
				name: "  Monday night  ",
				description: "",
			});
			expect(await templateRow(lean)).toMatchObject({
				name: "Monday night",
				description: null,
				key,
			});
			await expect(
				renameClubTemplate({
					clubId: club.clubId,
					templateId: lean,
					name: " ",
					description: null,
				}),
			).rejects.toThrow("Give the template a name.");
		});

		it("duplicates beats and roles under a Copy of name and a fresh key", async () => {
			const lean = await leanTemplate();
			const { templateId } = await duplicateClubTemplate({
				clubId: club.clubId,
				templateId: lean,
			});
			const copy = await templateRow(templateId);
			expect(copy?.name).toBe("Copy of Lean meeting");
			expect(copy?.key).not.toBe((await templateRow(lean))?.key);
			expect(copy?.meetingId).toBeNull();
			expect(await beatsOf(templateId)).toEqual(await beatsOf(lean));
			expect(await rolesOf(templateId)).toEqual(await rolesOf(lean));
			expect([...duplicateName("x".repeat(100))]).toHaveLength(80);
		});

		it("refuses disabling the default, and allows it once cleared", async () => {
			const lean = await leanTemplate();
			await setDefault(lean);
			await expect(
				setClubTemplateEnabled({
					clubId: club.clubId,
					templateId: lean,
					enabled: false,
				}),
			).rejects.toThrow(DISABLE_DEFAULT_MESSAGE);
			await setDefault(null);
			await setClubTemplateEnabled({
				clubId: club.clubId,
				templateId: lean,
				enabled: false,
			});
			expect((await templateRow(lean))?.enabled).toBe(false);
		});

		it("deleting the default nulls it (AC7)", async () => {
			const lean = await leanTemplate();
			await setDefault(lean);
			const r = await deleteClubTemplate({
				clubId: club.clubId,
				templateId: lean,
			});
			expect(r.wasDefault).toBe(true);
			expect(await defaultOf()).toBeNull();
			expect(await templateRow(lean)).toBeUndefined();
		});

		it("deleting a template an old meeting points at keeps that meeting's agenda on its own copy (AC7)", async () => {
			const lean = await leanTemplate();
			const legacy = await newMeeting(7);
			await testDb
				.update(meetings)
				.set({ templateId: lean })
				.where(eq(meetings.id, legacy));
			const beforeBeats = await beatsOf(lean);
			const r = await deleteClubTemplate({
				clubId: club.clubId,
				templateId: lean,
			});
			expect(r.wasDefault).toBe(false);
			const now = (await meetingRow(legacy)).templateId as string;
			expect(now).not.toBe(lean);
			expect((await templateRow(now))?.meetingId).toBe(legacy);
			expect(await beatsOf(now)).toEqual(beforeBeats);
			expect(await templateRow(lean)).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Tenant boundary (AC6)
	// -------------------------------------------------------------------------

	describe("tenant boundary", () => {
		it("every template-keyed fn refuses another club's, a global and a private-copy id, and writes nothing", async () => {
			const other = await standardClub();
			otherClubs.push(other);
			const theirs = await leanTemplate(other.clubId);
			const global = await globalTemplate();
			const mine = await newMeeting(7);
			await loadAgendaDraft(mine);
			const privateCopy = (await meetingRow(mine)).templateId as string;

			const calls: [string, (id: string) => Promise<unknown>][] = [
				[
					"rename",
					(id) =>
						renameClubTemplate({
							clubId: club.clubId,
							templateId: id,
							name: "Hijacked",
							description: null,
						}),
				],
				[
					"duplicate",
					(id) =>
						duplicateClubTemplate({ clubId: club.clubId, templateId: id }),
				],
				[
					"disable",
					(id) =>
						setClubTemplateEnabled({
							clubId: club.clubId,
							templateId: id,
							enabled: false,
						}),
				],
				[
					"delete",
					(id) => deleteClubTemplate({ clubId: club.clubId, templateId: id }),
				],
				["set default", (id) => setDefault(id)],
			];
			const snapshot = async () =>
				Promise.all(
					[theirs, global, privateCopy].map(async (id) => templateRow(id)),
				);
			const before = await snapshot();
			const ownedBefore = await listClubAgendas(club.clubId);

			for (const [name, call] of calls) {
				for (const id of [theirs, global, privateCopy]) {
					await expect(call(id), `${name} ${id}`).rejects.toThrow(
						CLUB_TEMPLATE_GONE_MESSAGE,
					);
				}
			}
			expect(await snapshot()).toEqual(before);
			expect(await listClubAgendas(club.clubId)).toEqual(ownedBefore);
			expect(await defaultOf()).toBeNull();
			expect((await meetingRow(mine)).templateId).toBe(privateCopy);
		});
	});

	// -------------------------------------------------------------------------
	// refuseIfReleasing
	// -------------------------------------------------------------------------

	describe("applyTemplateConversion refuseIfReleasing", () => {
		it("throws WouldReleaseError before any write when the locked plan releases someone", async () => {
			const d = await newMeeting(7);
			await claim(d, "ah_counter");
			const lean = await leanTemplate();
			const templatesBefore = await testDb
				.select({ id: meetingTemplates.id })
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, club.clubId));

			const attempt = applyTemplateConversion({
				meetingId: d,
				clubId: club.clubId,
				templateId: lean,
				actorMemberId: null,
				refuseIfReleasing: true,
			});
			await expect(attempt).rejects.toBeInstanceOf(WouldReleaseError);
			await expect(attempt).rejects.toMatchObject({
				plan: { claimedSlotsReleased: 1 },
			});
			expect((await meetingRow(d)).templateId).toBeNull();
			expect(
				await testDb
					.select({ id: meetingTemplates.id })
					.from(meetingTemplates)
					.where(eq(meetingTemplates.clubId, club.clubId)),
			).toHaveLength(templatesBefore.length);
			expect(await claimedCount()).toBe(1);
		});

		it("applies normally when nothing is released", async () => {
			const a = await newMeeting(7);
			const lean = await leanTemplate();
			await applyTemplateConversion({
				meetingId: a,
				clubId: club.clubId,
				templateId: lean,
				actorMemberId: null,
				refuseIfReleasing: true,
			});
			await expectOnCopyOf(a, lean);
		});
	});

	// -------------------------------------------------------------------------
	// The gate (AC9) and the GE lock (AC8)
	// -------------------------------------------------------------------------

	describe("requireClubTemplateEditor", () => {
		it("admits an officer of an open club", async () => {
			sessionUserId = club.adminUserId;
			await expect(
				requireClubTemplateEditor(club.clubId),
			).resolves.toMatchObject({ user: { id: club.adminUserId } });
		});

		it("refuses no session, a plain member and an archived club", async () => {
			sessionUserId = null;
			await expect(requireClubTemplateEditor(club.clubId)).rejects.toThrow();
			sessionUserId = club.memberUserId;
			await expect(requireClubTemplateEditor(club.clubId)).rejects.toThrow();
			sessionUserId = club.adminUserId;
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
			await expect(requireClubTemplateEditor(club.clubId)).rejects.toThrow(
				CLUB_ARCHIVED_MESSAGE,
			);
		});
	});

	describe("the General Evaluator lock (AC8)", () => {
		it("allows a change before adopting, refuses one while adopted, and allows it after clearing", async () => {
			await expect(
				assertGeChangeAllowed(club.clubId, true),
			).resolves.toBeUndefined();
			await adoptStandardAgenda({ clubId: club.clubId, actorMemberId: null });
			await expect(assertGeChangeAllowed(club.clubId, true)).rejects.toThrow(
				GE_LOCKED_MESSAGE,
			);
			// Saving the form without touching the checkbox still works.
			await expect(
				assertGeChangeAllowed(club.clubId, false),
			).resolves.toBeUndefined();
			await setDefault(null);
			await expect(
				assertGeChangeAllowed(club.clubId, true),
			).resolves.toBeUndefined();
		});
	});
});
