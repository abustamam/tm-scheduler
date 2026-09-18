/**
 * The write side of agenda-row club governance (#683), and the migration's
 * one-time backfill.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/agenda-row-governance.integration.test.ts
 *
 * Three things live here that no pure test can reach:
 *
 * 1. The un-govern / re-govern round trip THROUGH the store, which is what makes
 *    the fix a fix: the pure predicate could be perfect and the officer still
 *    have no way to move it.
 * 2. `assertGovernable`, the floor that stops a patch handing an arbitrary row
 *    to `refreshTableTopicsMarks`. `clubGoverned` is a patchable boolean now, so
 *    this is the mirror of the bug rather than an afterthought.
 * 3. The BACKFILL, executed as the shipped SQL rather than as a re-typed copy of
 *    it. A backfill runs once, in production, against data nobody can inspect
 *    afterwards; a test of a paraphrase of it proves nothing about the statement
 *    that actually ran.
 */
import { readFileSync } from "node:fs";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

const { loadAgendaDraft, updateAgendaRow } = await import(
	"./meeting-agenda-edit-logic"
);

const RUN = Math.random().toString(36).slice(2, 8);
const TTM = "table_topics_master";
/** MCF's rule, 1:00–2:30 — 1 / 1.75 / 2.5 in stored minutes. Every component
 *  differs from the standard 1 / 1.5 / 2, so a frozen row is unmistakable. */
const CLUB_SECONDS = { min: 60, max: 150 };
const CLUB_MARKS = { green: 1, yellow: 1.75, red: 2.5 };

let club: SeededClub;
const madeTemplates: string[] = [];

beforeEach(async () => {
	club = await seedClub();
	// On CLUBS, not on the meeting: the window is a club setting, and
	// `loadAgendaDraft` joins it in.
	await testDb
		.update(clubs)
		.set({
			tableTopicsMinSeconds: CLUB_SECONDS.min,
			tableTopicsMaxSeconds: CLUB_SECONDS.max,
		})
		.where(eq(clubs.id, club.clubId));
});

afterEach(async () => {
	await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	for (const id of madeTemplates.splice(0)) {
		await testDb.delete(meetingTemplates).where(eq(meetingTemplates.id, id));
	}
});

/**
 * A private template for this meeting carrying the three Table Topics beats the
 * run of show emits — the segment (governed), the Best Table Topics vote, and
 * the GE hand-off — plus an evaluator row.
 *
 * All three share a role key AND a label, exactly as `beatSeed` writes them.
 * That sameness is the bug's premise, so a fixture that distinguished them would
 * be testing an agenda this app never materialises.
 */
async function givenAgenda() {
	const [t] = await testDb
		.insert(meetingTemplates)
		.values({
			clubId: club.clubId,
			meetingId: club.meetingId,
			key: `gov_${RUN}`,
			name: `Governance ${RUN}`,
		})
		.returning({ id: meetingTemplates.id });
	if (!t) throw new Error("template insert failed");
	madeTemplates.push(t.id);
	await testDb.insert(meetingTemplateRoles).values([
		{
			templateId: t.id,
			key: TTM,
			name: "Table Topics Master",
			category: "leadership",
			defaultCount: 1,
			sortOrder: 0,
			isSpeakerRole: false,
		},
		{
			templateId: t.id,
			key: "evaluator",
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 1,
			sortOrder: 1,
			isSpeakerRole: false,
		},
	]);
	const rows = await testDb
		.insert(meetingTemplateBeats)
		.values([
			{
				templateId: t.id,
				sortOrder: 0,
				kind: "role" as const,
				label: "Table Topics Master",
				roleKey: TTM,
				minutes: 10,
				flex: true,
				markGreen: CLUB_MARKS.green,
				markYellow: CLUB_MARKS.yellow,
				markRed: CLUB_MARKS.red,
				clubGoverned: true,
			},
			{
				templateId: t.id,
				sortOrder: 1,
				kind: "role" as const,
				label: "Table Topics Master",
				roleKey: TTM,
				minutes: 1,
			},
			{
				templateId: t.id,
				sortOrder: 2,
				kind: "role" as const,
				label: "Table Topics Master",
				roleKey: TTM,
				minutes: 0,
				handoff: true,
			},
			{
				templateId: t.id,
				sortOrder: 3,
				kind: "role" as const,
				label: "Evaluator",
				roleKey: "evaluator",
				minutes: 3,
				markGreen: 2,
				markYellow: 2.5,
				markRed: 3,
			},
		])
		.returning({
			id: meetingTemplateBeats.id,
			sortOrder: meetingTemplateBeats.sortOrder,
		});
	await testDb
		.update(meetings)
		.set({ templateId: t.id })
		.where(eq(meetings.id, club.meetingId));
	const byOrder = new Map(rows.map((r) => [r.sortOrder, r.id]));
	return {
		templateId: t.id,
		segmentId: byOrder.get(0) as string,
		voteId: byOrder.get(1) as string,
		handoffId: byOrder.get(2) as string,
		evaluatorId: byOrder.get(3) as string,
	};
}

/** The rows as the editor and every print surface see them: post-refresh. */
async function draftRows() {
	const draft = await loadAgendaDraft(club.meetingId);
	if (!draft) throw new Error("no draft");
	return draft.rows;
}

const marksOf = (
	r:
		| {
				markGreen: number | null;
				markYellow: number | null;
				markRed: number | null;
		  }
		| undefined,
) => ({
	green: r?.markGreen,
	yellow: r?.markYellow,
	red: r?.markRed,
});

describe.skipIf(!hasTestDb)("club governance is two-way (#683)", () => {
	it("an officer who times the VOTE row keeps those marks", async () => {
		// The bug, end to end. Under the inferred predicate this patch made the
		// vote row match, and the very next read overwrote it with the club's
		// speaking window — on a row the officer was not editing.
		const { voteId } = await givenAgenda();
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: voteId,
			patch: { markGreen: 0.5, markYellow: 0.75, markRed: 1 },
		});
		const rows = await draftRows();
		const vote = rows.find((r) => r.id === voteId);
		// ABSOLUTE, and deliberately not the club's 1 / 1.75 / 2.5.
		expect(marksOf(vote)).toEqual({ green: 0.5, yellow: 0.75, red: 1 });
		expect(vote?.clubGoverned).toBe(false);
		// The real segment is untouched and still tracking the club.
		expect(marksOf(rows.find((r) => r.clubGoverned))).toEqual({
			green: 1,
			yellow: 1.75,
			red: 2.5,
		});
	});

	it("un-governs the segment and then leaves its marks alone", async () => {
		// Criterion 2: no delete-and-re-add. The row keeps its id, its label and
		// its place, and the marks the officer sets afterwards survive a read —
		// which is the thing the governed row could not do.
		const { segmentId } = await givenAgenda();
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: segmentId,
			// What the editor's control sends: the flag plus the numbers currently
			// on screen, so un-governing does not silently swap the window.
			patch: {
				clubGoverned: false,
				markGreen: CLUB_MARKS.green,
				markYellow: CLUB_MARKS.yellow,
				markRed: CLUB_MARKS.red,
			},
		});
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: segmentId,
			patch: { markGreen: 2, markYellow: 2.5, markRed: 3 },
		});
		const after = (await draftRows()).find((r) => r.id === segmentId);
		expect(after?.clubGoverned).toBe(false);
		expect(marksOf(after)).toEqual({ green: 2, yellow: 2.5, red: 3 });
		// Same row, not a replacement: the fields an officer would have had to
		// retype are still there.
		expect({
			label: after?.label,
			minutes: after?.minutes,
			sortOrder: after?.sortOrder,
		}).toEqual({
			label: "Table Topics Master",
			minutes: 10,
			sortOrder: 0,
		});
	});

	it("re-governs it, and the club's window comes straight back", async () => {
		// The mirror door. Without it the un-govern above would be the same trap
		// one click further along.
		const { segmentId } = await givenAgenda();
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: segmentId,
			patch: { clubGoverned: false, markGreen: 2, markYellow: 2.5, markRed: 3 },
		});
		expect(
			marksOf((await draftRows()).find((r) => r.id === segmentId)),
		).toEqual({ green: 2, yellow: 2.5, red: 3 });
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: segmentId,
			patch: { clubGoverned: true },
		});
		const back = (await draftRows()).find((r) => r.id === segmentId);
		expect(back?.clubGoverned).toBe(true);
		// Refreshed on the way out, from the club's CURRENT columns — the stored
		// row still holds 2 / 2.5 / 3.
		expect(marksOf(back)).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
		const [stored] = await testDb
			.select({
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.id, segmentId));
		expect(marksOf(stored)).toEqual({ green: 2, yellow: 2.5, red: 3 });
	});

	it("refreshes a governed row whose marks were cleared", async () => {
		// Criterion 5, through the store. `assertMarks` permits clearing all three,
		// and under the old predicate the cleared row stopped matching — never
		// refreshed again, no window on any surface, while the Timer's role sheet
		// kept printing the club's.
		const { segmentId } = await givenAgenda();
		await updateAgendaRow({
			meetingId: club.meetingId,
			rowId: segmentId,
			patch: { markGreen: null, markYellow: null, markRed: null },
		});
		expect(
			marksOf((await draftRows()).find((r) => r.id === segmentId)),
		).toEqual({ green: 1, yellow: 1.75, red: 2.5 });
	});
});

describe.skipIf(!hasTestDb)(
	"only a Table Topics row may be governed (#683)",
	() => {
		it("refuses to govern another role's row", async () => {
			const { evaluatorId } = await givenAgenda();
			await expect(
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: evaluatorId,
					patch: { clubGoverned: true },
				}),
			).rejects.toThrow(/Only the Table Topics row/);
			const stayed = (await draftRows()).find((r) => r.id === evaluatorId);
			expect(stayed?.clubGoverned).toBe(false);
			// And its own marks are untouched — a refused patch writes nothing.
			expect(marksOf(stayed)).toEqual({ green: 2, yellow: 2.5, red: 3 });
		});

		it("refuses the TWO-PATCH route: govern, then re-point the role", async () => {
			// Each patch is unremarkable alone; the row they compose is the illegal
			// one. This is why the check runs against the MERGED row rather than
			// against the patch — the same lesson `assertMarks` and
			// `assertRepeatBinding` each learned separately.
			const { voteId } = await givenAgenda();
			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: voteId,
				patch: { clubGoverned: true },
			});
			await expect(
				updateAgendaRow({
					meetingId: club.meetingId,
					rowId: voteId,
					patch: { roleKey: "evaluator", repeatsRoleKey: null },
				}),
			).rejects.toThrow(/Only the Table Topics row/);
		});

		it("always allows turning governance OFF", async () => {
			// The recovery path must not depend on the row still being legal: a row
			// that should never have been governed is exactly the row that needs out.
			const { segmentId } = await givenAgenda();
			await updateAgendaRow({
				meetingId: club.meetingId,
				rowId: segmentId,
				patch: {
					clubGoverned: false,
					roleKey: "evaluator",
					repeatsRoleKey: null,
				},
			});
			const after = (await draftRows()).find((r) => r.id === segmentId);
			expect(after?.clubGoverned).toBe(false);
			expect(after?.roleKey).toBe("evaluator");
		});
	},
);

// ---------------------------------------------------------------------------
// The backfill.
//
// Executed as the SHIPPED statement, read out of the migration file, because a
// backfill runs once against production data and a paraphrase of it is not the
// thing that runs. The file is found by content rather than by name so renaming
// or renumbering the migration fails loudly here instead of silently testing
// nothing.
// ---------------------------------------------------------------------------
const BACKFILL_SQL = (() => {
	const path = "drizzle/0079_minor_peter_parker.sql";
	const text = readFileSync(path, "utf8");
	const at = text.indexOf(
		'UPDATE "meeting_template_beats" SET "club_governed" = true',
	);
	if (at === -1) {
		throw new Error(`no club_governed backfill statement in ${path}`);
	}
	return text.slice(at);
})();

describe.skipIf(!hasTestDb)("the #683 backfill", () => {
	/** A template as it existed BEFORE the column — every row ungoverned, the
	 *  segment recognisable only by the old inference. */
	async function givenLegacyTemplate(
		beats: {
			sortOrder: number;
			roleKey: string | null;
			marks?: [number, number, number];
			kind?: "role" | "section";
		}[],
	) {
		const [t] = await testDb
			.insert(meetingTemplates)
			.values({
				clubId: club.clubId,
				key: `legacy_${RUN}_${Math.random().toString(36).slice(2, 7)}`,
				name: "Legacy",
			})
			.returning({ id: meetingTemplates.id });
		if (!t) throw new Error("template insert failed");
		madeTemplates.push(t.id);
		await testDb.insert(meetingTemplateBeats).values(
			beats.map((b) => ({
				templateId: t.id,
				sortOrder: b.sortOrder,
				kind: b.kind ?? ("role" as const),
				label: "Table Topics Master",
				roleKey: b.roleKey,
				minutes: 1,
				markGreen: b.marks?.[0] ?? null,
				markYellow: b.marks?.[1] ?? null,
				markRed: b.marks?.[2] ?? null,
			})),
		);
		return t.id;
	}

	async function governedOrders(templateId: string) {
		const rows = await testDb
			.select({
				sortOrder: meetingTemplateBeats.sortOrder,
				clubGoverned: meetingTemplateBeats.clubGoverned,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, templateId))
			.orderBy(asc(meetingTemplateBeats.sortOrder));
		return rows.flatMap((r) => (r.clubGoverned ? [r.sortOrder] : []));
	}

	it("marks the speaking segment on an ordinary materialised meeting", async () => {
		const id = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: null, kind: "section" },
			// The segment: the only Table Topics row with marks.
			{ sortOrder: 1, roleKey: TTM, marks: [1, 1.75, 2.5] },
			// The vote and the hand-off: same key, no marks.
			{ sortOrder: 2, roleKey: TTM },
			{ sortOrder: 3, roleKey: TTM },
			// A marked row of a different role — the evaluation window.
			{ sortOrder: 4, roleKey: "evaluator", marks: [2, 2.5, 3] },
		]);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		expect(await governedOrders(id)).toEqual([1]);
	});

	it("marks ONE row when the vote row carries marks too, and it is the earlier one", async () => {
		// Criterion 4, and the case the tie-break exists for: this is exactly the
		// meeting #683 was filed about, sitting in the database on migration day.
		// Marking both would hand the refresh pass two rows to overwrite forever;
		// marking the later one would govern the vote and leave the segment frozen.
		const id = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: TTM, marks: [1, 1.75, 2.5] },
			{ sortOrder: 1, roleKey: TTM, marks: [0.5, 0.75, 1] },
			{ sortOrder: 2, roleKey: TTM },
		]);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		// ABSOLUTE [0]: one row, and the earlier one. `[0, 1]` is the "marked
		// both" failure and `[1]` is the "picked the vote row" failure, and the
		// two are different bugs.
		expect(await governedOrders(id)).toEqual([0]);
	});

	it("marks nothing on a template with no Table Topics window at all", async () => {
		// A contest. Its beats carry marks and a role key, and neither is this one.
		const id = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: "contestant_prepared", marks: [5, 6, 7] },
			{ sortOrder: 1, roleKey: TTM },
		]);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		expect(await governedOrders(id)).toEqual([]);
	});

	it("marks each template independently, one row apiece", async () => {
		// Per-TEMPLATE, not per-database: `DISTINCT ON` keyed on the wrong column
		// (or dropped entirely) is the failure this catches, and with one template
		// in the fixture both readings agree.
		const a = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: TTM, marks: [1, 1.5, 2] },
			{ sortOrder: 1, roleKey: TTM, marks: [1, 1.5, 2] },
		]);
		const b = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: TTM },
			{ sortOrder: 1, roleKey: TTM, marks: [1, 1.75, 2.5] },
		]);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		expect(await governedOrders(a)).toEqual([0]);
		expect(await governedOrders(b)).toEqual([1]);
	});

	it("is idempotent, and re-running it governs nothing new", async () => {
		// Drizzle records applied migrations, so this should never re-run — but a
		// restore, a replay, or a hand-run of the file all can, and a backfill that
		// is not safe to repeat is a landmine rather than a migration.
		const id = await givenLegacyTemplate([
			{ sortOrder: 0, roleKey: TTM, marks: [1, 1.75, 2.5] },
			{ sortOrder: 1, roleKey: TTM, marks: [0.5, 0.75, 1] },
		]);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		// An officer un-governs the segment between the two runs. The second run
		// must not put it back: the backfill is a one-time transcription of the old
		// inference, not a rule that keeps applying.
		await testDb
			.update(meetingTemplateBeats)
			.set({ clubGoverned: false })
			.where(
				inArray(
					meetingTemplateBeats.id,
					testDb
						.select({ id: meetingTemplateBeats.id })
						.from(meetingTemplateBeats)
						.where(eq(meetingTemplateBeats.templateId, id)),
				),
			);
		await testDb.execute(sql.raw(BACKFILL_SQL));
		// Honest about what "idempotent" means here: re-running DOES re-derive the
		// same answer from the same unchanged rows. What it must never do is pick a
		// DIFFERENT row or pick two.
		expect(await governedOrders(id)).toEqual([0]);
	});
});
