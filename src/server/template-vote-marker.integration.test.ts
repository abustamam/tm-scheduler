/**
 * The vote marker (#1635) in the database: the backfill migration, and every
 * path that copies a beat carrying `award_category` with it.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, meetingTemplateBeats, meetingTemplates } from "#/db/schema";
import { materialiseRunOfShow } from "#/lib/agenda-materialise";
import { CONTEST_TEMPLATE_KEY } from "#/lib/contest-template";
import {
	leanTemplate,
	newMeeting,
	standardClub,
} from "#/test/club-agenda-fixtures";
import { cleanup, hasTestDb, type SeededClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { adoptStandardAgenda, duplicateClubTemplate } = await import(
	"./club-agendas-logic"
);
const { addAgendaRow, loadAgendaDraft, updateAgendaRow } = await import(
	"./meeting-agenda-edit-logic"
);
const {
	copyTemplateForMeeting,
	loadTemplateContent,
	saveMeetingAgendaAsClubTemplate,
} = await import("./meeting-templates-logic");

const VOTES = [
	["toastmaster_of_the_day", "best_speaker"],
	["table_topics_master", "best_table_topics"],
	["general_evaluator", "best_evaluator"],
] as const;

async function marked(conn: typeof testDb, templateId: string) {
	const rows = await conn
		.select({
			roleKey: meetingTemplateBeats.roleKey,
			cat: meetingTemplateBeats.awardCategory,
		})
		.from(meetingTemplateBeats)
		.where(
			and(
				eq(meetingTemplateBeats.templateId, templateId),
				isNotNull(meetingTemplateBeats.awardCategory),
			),
		)
		.orderBy(asc(meetingTemplateBeats.sortOrder));
	return rows.map((r) => [r.roleKey, r.cat]);
}

function backfillStatement(): string {
	const file = readdirSync("drizzle").find((f) =>
		readFileSync(`drizzle/${f}`, "utf8").includes(
			'ADD COLUMN "award_category"',
		),
	);
	if (!file) throw new Error("migration adding award_category not found");
	const found = readFileSync(`drizzle/${file}`, "utf8")
		.split("--> statement-breakpoint")
		.map((part) => part.trim())
		.find((part) => /^(--.*\n)*UPDATE "meeting_template_beats"/.test(part));
	if (!found) throw new Error("backfill UPDATE not found in the migration");
	return found;
}

class Rollback extends Error {}

describe.skipIf(!hasTestDb)("award_category backfill (#1635)", () => {
	// ONE transaction, rolled back: the verbatim UPDATE is unscoped.
	it("marks old-state vote beats, never a contest's, never an edited one", async () => {
		await expect(
			testDb.transaction(async (tx) => {
				// Rows exactly as TODAY's code leaves them: the same seeds, no marker.
				const oldSeeds = materialiseRunOfShow(false, null).map((s) => ({
					...s,
					awardCategory: null,
				}));
				const mk = async (key: string) => {
					const [t] = await tx
						.insert(meetingTemplates)
						.values({ clubId: null, key, name: "bf" })
						.returning({ id: meetingTemplates.id });
					if (!t) throw new Error("insert failed");
					await tx
						.insert(meetingTemplateBeats)
						.values(oldSeeds.map((s) => ({ ...s, templateId: t.id })));
					return t.id;
				};
				const club = await mk(`club-${randomUUID().slice(0, 8)}`);
				const contest = await mk(CONTEST_TEMPLATE_KEY);
				// Rows as saved BEFORE #1503 reworded the beat ("opens voting for"),
				// typed by hand: the six strings the old materialiser wrote.
				const OLD_WORDING: [string, string][] = [
					[
						"toastmaster_of_the_day",
						"Calls for the {role:timer}'s report · opens voting for Best Speaker",
					],
					["toastmaster_of_the_day", "Opens voting for Best Speaker"],
					[
						"table_topics_master",
						"Calls for the {role:timer}'s report · opens voting for Best Table Topics",
					],
					["table_topics_master", "Opens voting for Best Table Topics"],
					[
						"general_evaluator",
						"Calls for the {role:timer}'s report · opens voting for Best Evaluator",
					],
					["general_evaluator", "Opens voting for Best Evaluator"],
				];
				const [oldT] = await tx
					.insert(meetingTemplates)
					.values({
						clubId: null,
						key: `club-${randomUUID().slice(0, 8)}`,
						name: "old",
					})
					.returning({ id: meetingTemplates.id });
				if (!oldT) throw new Error("insert failed");
				const skeleton = oldSeeds.find((s) => s.kind === "role");
				if (!skeleton) throw new Error("no role seed");
				await tx.insert(meetingTemplateBeats).values(
					OLD_WORDING.map(([roleKey, detail], i) => ({
						...skeleton,
						templateId: oldT.id,
						roleKey,
						detail,
						sortOrder: i,
					})),
				);
				const edited = await mk(`club-${randomUUID().slice(0, 8)}`);
				await tx
					.update(meetingTemplateBeats)
					.set({ detail: "Calls for votes for Best Speaker!" })
					.where(
						and(
							eq(meetingTemplateBeats.templateId, edited),
							eq(meetingTemplateBeats.roleKey, "toastmaster_of_the_day"),
							sql`${meetingTemplateBeats.detail} like '%Best Speaker'`,
						),
					);

				await tx.execute(sql.raw(backfillStatement()));

				const read = (id: string) => marked(tx as unknown as typeof testDb, id);
				expect(await read(club)).toEqual(VOTES.map((v) => [...v]));
				expect(await read(contest)).toEqual([]);
				expect(await read(oldT.id)).toEqual([
					["toastmaster_of_the_day", "best_speaker"],
					["toastmaster_of_the_day", "best_speaker"],
					["table_topics_master", "best_table_topics"],
					["table_topics_master", "best_table_topics"],
					["general_evaluator", "best_evaluator"],
					["general_evaluator", "best_evaluator"],
				]);
				expect(await read(edited)).toEqual([
					["table_topics_master", "best_table_topics"],
					["general_evaluator", "best_evaluator"],
				]);
				throw new Rollback();
			}),
		).rejects.toBeInstanceOf(Rollback);
	});
});

describe.skipIf(!hasTestDb)(
	"award_category survives every copy (#1635)",
	() => {
		let club: SeededClub;
		beforeEach(async () => {
			club = await standardClub();
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const expected = VOTES.map((v) => [...v]);

		it("a template written from materialiseRunOfShow carries it, and the render read returns it", async () => {
			const id = await leanTemplate(club.clubId);
			expect(await marked(testDb, id)).toEqual(expected);
			const content = await loadTemplateContent(id);
			expect(
				content?.beats
					.filter((b) => b.awardCategory)
					.map((b) => b.awardCategory),
			).toEqual(["best_speaker", "best_table_topics", "best_evaluator"]);
		});

		it("duplicate keeps it", async () => {
			const id = await leanTemplate(club.clubId);
			const { templateId } = await duplicateClubTemplate({
				clubId: club.clubId,
				templateId: id,
			});
			expect(await marked(testDb, templateId)).toEqual(expected);
		});

		it("a private copy for a meeting (apply) keeps it", async () => {
			const id = await leanTemplate(club.clubId);
			const meetingId = await newMeeting(club.clubId, 7);
			const copyId = await testDb.transaction((tx) =>
				copyTemplateForMeeting(tx, {
					sourceTemplateId: id,
					clubId: club.clubId,
					meetingId,
				}),
			);
			expect(await marked(testDb, copyId)).toEqual(expected);
		});

		it("save as a new club template, and replace, keep it", async () => {
			const meetingId = await newMeeting(club.clubId, 7);
			await loadAgendaDraft(meetingId); // stores the meeting's private copy
			const [m] = await testDb
				.select({ templateId: meetings.templateId })
				.from(meetings)
				.where(eq(meetings.id, meetingId));
			expect(await marked(testDb, m?.templateId as string)).toEqual(expected);

			const created = await saveMeetingAgendaAsClubTemplate({
				meetingId,
				clubId: club.clubId,
				actorMemberId: null,
				mode: "new",
				name: "Saved",
				description: null,
			});
			expect(await marked(testDb, created.templateId)).toEqual(expected);

			const target = await leanTemplate(club.clubId, { name: "Target" });
			await testDb
				.update(meetingTemplateBeats)
				.set({ awardCategory: null })
				.where(eq(meetingTemplateBeats.templateId, target));
			expect(await marked(testDb, target)).toEqual([]);
			await saveMeetingAgendaAsClubTemplate({
				meetingId,
				clubId: club.clubId,
				actorMemberId: null,
				mode: "replace",
				templateId: target,
			});
			expect(await marked(testDb, target)).toEqual(expected);
		});

		it("a row's marker can be patched back on after a delete (the Undo path)", async () => {
			const meetingId = await newMeeting(club.clubId, 7);
			const draft = await loadAgendaDraft(meetingId);
			const vote = draft?.rows.find((r) => r.awardCategory === "best_speaker");
			if (!vote) throw new Error("no marked row");
			const created = await addAgendaRow({
				meetingId,
				afterRowId: null,
				kind: vote.kind,
			});
			expect(created.awardCategory).toBeNull();
			await updateAgendaRow({
				meetingId,
				rowId: created.id,
				patch: { label: vote.label, awardCategory: vote.awardCategory },
			});
			const after = await loadAgendaDraft(meetingId);
			expect(after?.rows.find((r) => r.id === created.id)?.awardCategory).toBe(
				"best_speaker",
			);
		});

		it("adopting the standard agenda keeps it", async () => {
			const { templateId } = (await adoptStandardAgenda({
				clubId: club.clubId,
				actorMemberId: null,
			})) as { templateId: string };
			expect(await marked(testDb, templateId)).toEqual(expected);
		});
	},
);
