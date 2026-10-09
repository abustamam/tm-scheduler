/**
 * The agenda and template writers refuse a frozen meeting BY WRITE CLASS
 * (#1136, part of #1129): one `plan` policy, so a cancelled or completed
 * meeting's agenda takes no edit and a status added to the policy later is one
 * edit there.
 *
 * What each test pins, because the older suites only assert `/cancelled/i` or a
 * bare `.toThrow()`:
 *   - the EXACT sentence each status says, so the user sees the same words the
 *     per-status helpers used to give;
 *   - that a refusal writes NOTHING (no beat, no role, no fork of a shared
 *     template), which is what "refused before the first write" means;
 *   - that a scheduled meeting is unaffected.
 *
 * Run with:
 *   bunx vitest run src/server/meeting-write-policy-agenda.integration.test.ts
 */
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	assertMeetingAccepts,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	AGENDA_CANCELLED_MESSAGE,
	AGENDA_PLAN_WRITE_OPTIONS,
	addAgendaRole,
	addAgendaRow,
	agendaEditable,
	ensureAgendaDraft,
	loadAgendaDraft,
	moveAgendaRow,
	removeAgendaRole,
	removeAgendaRow,
	updateAgendaRow,
} = await import("./meeting-agenda-edit-logic");
const { applyTemplateConversion, saveMeetingAgendaAsClubTemplate } =
	await import("./meeting-templates-logic");

const RUN = Math.random().toString(36).slice(2, 8);

type Frozen = "cancelled" | "completed";

/** Every writer the family exercises, by the key `writers()` below uses. */
const WRITER_NAMES = [
	"addAgendaRow",
	"updateAgendaRow",
	"removeAgendaRow",
	"moveAgendaRow",
	"addAgendaRole",
	"removeAgendaRole",
] as const;

/** Each frozen status and the sentence an agenda write says for it. */
const FROZEN: readonly (readonly [Frozen, string])[] = [
	["cancelled", AGENDA_CANCELLED_MESSAGE],
	["completed", MEETING_LOCKED_MESSAGE],
];

describe("the agenda's own sentences are the ones the users already read", () => {
	it("says the cancelled-agenda sentence for cancelled and the shared lock sentence for completed", () => {
		expect(AGENDA_CANCELLED_MESSAGE).toBe(
			"A cancelled meeting's agenda cannot be edited.",
		);
		expect(MEETING_LOCKED_MESSAGE).toBe("This meeting is locked.");
	});
});

describe("agendaEditable follows the plan write class", () => {
	it("accepts scheduled and refuses cancelled and completed", () => {
		expect(agendaEditable("scheduled")).toBe(true);
		expect(agendaEditable("cancelled")).toBe(false);
		expect(agendaEditable("completed")).toBe(false);
	});

	it("agrees with the write side for every status, because both read the same options", () => {
		// `agendaEditable` answers a boolean and the writers throw a sentence, so
		// they are two code paths over one class and one options object. This is
		// what notices if one of them stops reading it.
		for (const status of ["scheduled", "cancelled", "completed"]) {
			let writeAccepts = true;
			try {
				assertMeetingAccepts(status, "plan", AGENDA_PLAN_WRITE_OPTIONS);
			} catch {
				writeAccepts = false;
			}
			expect(agendaEditable(status), status).toBe(writeAccepts);
		}
	});

	it("the shared options are frozen, so one surface cannot change another's answer", () => {
		expect(Object.isFrozen(AGENDA_PLAN_WRITE_OPTIONS)).toBe(true);
		expect(Object.isFrozen(AGENDA_PLAN_WRITE_OPTIONS.messages)).toBe(true);
	});

	it("fails closed on a status the policy has never heard of", () => {
		// It used to say `true` for anything that was not exactly the two names
		// it knew, which is how a new freezing status would have read as open.
		expect(() => agendaEditable("paused")).toThrow(/Unknown meeting status/);
	});
});

describe.skipIf(!hasTestDb)("agenda writers refuse a frozen meeting", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});

	afterEach(async () => {
		// Every template here is club-owned, so the club's cascade removes them.
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/**
	 * The meeting's agenda: a private copy (`shared: false`, the normal state) or
	 * a pointer at a SHARED club template (`shared: true`, the legacy state whose
	 * first write forks a copy). The shared case is the one that would write a
	 * fork before refusing if a writer reached its fork ahead of the policy.
	 */
	async function giveAgenda(shared: boolean) {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				meetingId: shared ? null : club.meetingId,
				key: `agenda_${RUN}`,
				name: `Agenda ${RUN}`,
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		await testDb.insert(meetingTemplateRoles).values({
			templateId: t.id,
			key: "chair",
			name: "Chair",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 10,
			isSpeakerRole: false,
		});
		await testDb.insert(meetingTemplateBeats).values([
			{
				templateId: t.id,
				sortOrder: 0,
				kind: "section",
				label: "OPENING",
				minutes: 0,
			},
			{
				templateId: t.id,
				sortOrder: 1,
				kind: "role",
				label: "Welcome",
				roleKey: "chair",
				minutes: 5,
			},
		]);
		await testDb
			.update(meetings)
			.set({ templateId: t.id })
			.where(eq(meetings.id, club.meetingId));
		return t.id;
	}

	async function freeze(status: Frozen) {
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, club.meetingId));
	}

	/**
	 * Everything an agenda write could touch, for this club: the meeting's
	 * pointer, every template row, every beat and role declaration under them,
	 * the meeting's role slots and the club's role bank. A refused write must
	 * leave it deep-equal.
	 */
	async function stateOf() {
		const [meeting] = await testDb
			.select({ templateId: meetings.templateId })
			.from(meetings)
			.where(eq(meetings.id, club.meetingId));
		const templates = await testDb
			.select({
				id: meetingTemplates.id,
				meetingId: meetingTemplates.meetingId,
			})
			.from(meetingTemplates)
			.where(eq(meetingTemplates.clubId, club.clubId))
			.orderBy(meetingTemplates.id);
		const ids = templates.map((t) => t.id);
		const beats =
			ids.length === 0
				? []
				: await testDb
						.select({
							id: meetingTemplateBeats.id,
							templateId: meetingTemplateBeats.templateId,
							sortOrder: meetingTemplateBeats.sortOrder,
							label: meetingTemplateBeats.label,
							minutes: meetingTemplateBeats.minutes,
						})
						.from(meetingTemplateBeats)
						.where(inArray(meetingTemplateBeats.templateId, ids))
						.orderBy(
							meetingTemplateBeats.templateId,
							meetingTemplateBeats.sortOrder,
						);
		const declared =
			ids.length === 0
				? []
				: await testDb
						.select({
							templateId: meetingTemplateRoles.templateId,
							key: meetingTemplateRoles.key,
						})
						.from(meetingTemplateRoles)
						.where(inArray(meetingTemplateRoles.templateId, ids))
						.orderBy(meetingTemplateRoles.templateId, meetingTemplateRoles.key);
		const slots = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, club.meetingId))
			.orderBy(roleSlots.id);
		// `addAgendaRole` mints a bank row when the club has none for the key.
		const bank = await testDb
			.select({ id: roleDefinitions.id, key: roleDefinitions.key })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, club.clubId))
			.orderBy(roleDefinitions.id);
		return {
			pointer: meeting?.templateId,
			templates,
			beats,
			declared,
			slots,
			bank,
		};
	}

	/**
	 * One call per writer in the family. Each reaches `ensureAgendaDraft` before
	 * its first write, which is where the policy lives. `moveAgendaRow` is here
	 * for `bulkSetSortOrder`, which only `renumberRows` reaches, from the three
	 * row writers that reorder (add, remove, move).
	 */
	function writers(): Record<
		(typeof WRITER_NAMES)[number],
		(rowIds: string[]) => Promise<unknown>
	> {
		const meetingId = club.meetingId;
		return {
			addAgendaRow: ([first]) =>
				addAgendaRow({ meetingId, afterRowId: first ?? null, kind: "event" }),
			updateAgendaRow: ([first]) =>
				updateAgendaRow({
					meetingId,
					rowId: first ?? "",
					patch: { minutes: 3 },
				}),
			removeAgendaRow: ([first]) =>
				removeAgendaRow({ meetingId, rowId: first ?? "" }),
			moveAgendaRow: ([first]) =>
				moveAgendaRow({ meetingId, rowId: first ?? "", direction: "down" }),
			addAgendaRole: () =>
				addAgendaRole({
					meetingId,
					name: "Zoom Master",
					category: "functionary",
					defaultCount: 1,
					isSpeakerRole: false,
				}),
			removeAgendaRole: () =>
				removeAgendaRole({ meetingId, roleKey: "chair", actorMemberId: null }),
		};
	}

	async function rowIds() {
		const draft = await loadAgendaDraft(club.meetingId);
		return (draft?.rows ?? []).map((r) => r.id);
	}

	for (const shared of [false, true]) {
		const where = shared ? "a shared legacy template" : "a private copy";
		for (const [status, message] of FROZEN) {
			for (const writer of WRITER_NAMES) {
				it(`${writer} on ${where} refuses a ${status} meeting with ${JSON.stringify(message)} and writes nothing`, async () => {
					await giveAgenda(shared);
					const ids = await rowIds();
					await freeze(status);
					const before = await stateOf();

					await expect(writers()[writer](ids)).rejects.toThrow(
						new Error(message),
					);

					expect(await stateOf()).toEqual(before);
				});
			}
		}
	}

	it("ensureAgendaDraft, the one place the agenda writers refuse, says each status's sentence", async () => {
		await giveAgenda(false);
		for (const [status, message] of FROZEN) {
			await freeze(status);
			await expect(
				testDb.transaction((tx) => ensureAgendaDraft(tx, club.meetingId)),
			).rejects.toThrow(new Error(message));
		}
	});

	for (const writer of WRITER_NAMES) {
		it(`${writer} on a scheduled meeting still writes`, async () => {
			await giveAgenda(false);
			const ids = await rowIds();
			const before = await stateOf();

			// A rejection fails the test here; what is asserted is the write itself.
			await writers()[writer](ids);

			expect(await stateOf()).not.toEqual(before);
		});
	}

	it("ensureAgendaDraft on a scheduled meeting resolves to its own copy", async () => {
		const templateId = await giveAgenda(false);
		const handle = await testDb.transaction((tx) =>
			ensureAgendaDraft(tx, club.meetingId),
		);
		expect(handle).toEqual({ templateId, forked: false });
	});

	describe("materialising the standard agenda is a plan write with an override", () => {
		// `loadAgendaDraft` materialises a never-opened meeting's copy ON READ, and
		// the editor has to open a cancelled or completed meeting read-only. A
		// completed meeting is also a legitimate save-as-template source. So the
		// writer accepts both frozen statuses on purpose (#1136's decision).
		for (const status of ["scheduled", "cancelled", "completed"] as const) {
			it(`still gives a never-opened ${status} meeting its copy, on read`, async () => {
				if (status !== "scheduled") await freeze(status);
				const [before] = await testDb
					.select({ templateId: meetings.templateId })
					.from(meetings)
					.where(eq(meetings.id, club.meetingId));
				expect(before?.templateId).toBeNull();

				const draft = await loadAgendaDraft(club.meetingId);

				expect(draft?.rows.length).toBeGreaterThan(0);
				expect(draft?.editable).toBe(status === "scheduled");
				expect(draft?.cancelled).toBe(status === "cancelled");
				const [after] = await testDb
					.select({ templateId: meetings.templateId })
					.from(meetings)
					.where(eq(meetings.id, club.meetingId));
				expect(after?.templateId).toBe(draft?.templateId);
			});
		}
	});

	describe("materialiseForMeeting meets a meeting that vanished under it", () => {
		/**
		 * Wait until another connection is blocked BY the holder's transaction
		 * (`pg_blocking_pids`, so a lock wait elsewhere in a parallel run does not
		 * count), which is how this test knows the reader has reached
		 * `materialiseForMeeting`'s `FOR UPDATE` and is queued behind it.
		 */
		async function waitForBlockedBy(holderPid: number) {
			for (let i = 0; i < 200; i++) {
				const { rows } = await testDb.execute<{ n: number }>(
					sql`select count(*)::int as n from pg_stat_activity
						where ${holderPid} = any(pg_blocking_pids(pid))`,
				);
				if ((rows[0]?.n ?? 0) > 0) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error("the reader never blocked on the meeting row");
		}

		it("says so, and does not fall through to the foreign key", async () => {
			// `loadAgendaDraft` reads the meeting, finds no copy, and goes to
			// materialise one. A cancel-and-delete that wins the row lock in between
			// leaves the locked re-read with no row; without its own check the code
			// went on to INSERT a template for a meeting that is gone and surfaced
			// the driver's `Failed query: insert into "meeting_templates"` (23503).
			let outcome: Promise<unknown> | undefined;
			await testDb.transaction(async (tx) => {
				await tx
					.select({ id: meetings.id })
					.from(meetings)
					.where(eq(meetings.id, club.meetingId))
					.for("update");
				const { rows } = await tx.execute<{ pid: number }>(
					sql`select pg_backend_pid() as pid`,
				);
				const holderPid = rows[0]?.pid;
				if (holderPid === undefined) throw new Error("no backend pid");
				outcome = loadAgendaDraft(club.meetingId).then(
					() => "resolved",
					(err: unknown) => err,
				);
				await waitForBlockedBy(holderPid);
				await tx.delete(meetings).where(eq(meetings.id, club.meetingId));
			});
			const err = await outcome;
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe("Meeting not found.");
		});
	});

	describe("applyTemplateConversion", () => {
		function convert() {
			return applyTemplateConversion({
				meetingId: club.meetingId,
				clubId: club.clubId,
				templateId: null,
				actorMemberId: null,
			});
		}

		it("refuses a cancelled meeting with its own sentence, before any write", async () => {
			await giveAgenda(false);
			await freeze("cancelled");
			const before = await stateOf();
			await expect(convert()).rejects.toThrow(
				new Error("A cancelled meeting cannot change its template."),
			);
			expect(await stateOf()).toEqual(before);
		});

		it("refuses a completed meeting with the shared lock sentence, before any write", async () => {
			await giveAgenda(false);
			await freeze("completed");
			const before = await stateOf();
			await expect(convert()).rejects.toThrow(
				new Error(MEETING_LOCKED_MESSAGE),
			);
			expect(await stateOf()).toEqual(before);
		});

		it("still converts a scheduled meeting", async () => {
			await giveAgenda(false);
			const before = await stateOf();
			await convert();
			expect(await stateOf()).not.toEqual(before);
		});
	});

	describe("saveMeetingAgendaAsClubTemplate (exempt: it writes club-level rows)", () => {
		function save() {
			return saveMeetingAgendaAsClubTemplate({
				meetingId: club.meetingId,
				clubId: club.clubId,
				actorMemberId: null,
				mode: "new",
				name: `Saved ${RUN}`,
				description: null,
			});
		}

		async function clubTemplateCount() {
			const rows = await testDb
				.select({
					id: meetingTemplates.id,
					meetingId: meetingTemplates.meetingId,
				})
				.from(meetingTemplates)
				.where(eq(meetingTemplates.clubId, club.clubId));
			return rows.filter((r) => r.meetingId === null).length;
		}

		it("refuses a cancelled source with its own sentence and saves nothing", async () => {
			await giveAgenda(false);
			await freeze("cancelled");
			const before = await clubTemplateCount();
			await expect(save()).rejects.toThrow(
				new Error(
					"A cancelled meeting's agenda cannot be saved as a template.",
				),
			);
			expect(await clubTemplateCount()).toBe(before);
		});

		it("accepts a completed source: the record class does not refuse it", async () => {
			await giveAgenda(false);
			await freeze("completed");
			const before = await clubTemplateCount();
			await expect(save()).resolves.toMatchObject({
				templateId: expect.any(String),
			});
			expect(await clubTemplateCount()).toBe(before + 1);
		});

		it("saves from a scheduled meeting", async () => {
			await giveAgenda(false);
			const before = await clubTemplateCount();
			await expect(save()).resolves.toMatchObject({
				templateId: expect.any(String),
			});
			expect(await clubTemplateCount()).toBe(before + 1);
		});
	});
});
