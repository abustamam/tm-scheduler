/**
 * The speech log's past rows (#1656): the `includePast` switch a stale tab
 * relies on, and the two short-circuits that keep the past query and the
 * evaluator query from running for nothing.
 *
 * The short-circuits are optimizations (an empty `inArray` compiles to
 * `false`), so asserting the RESULT cannot fail without them. They are pinned
 * by counting `select` round-trips, as `my-activity.integration.test.ts` does
 * for its own guards.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadSpeechLog, loadMySpeechLog } = await import("./my-activity-logic");

describe.skipIf(!hasTestDb)("speech log past rows (#1656)", () => {
	let a: SeededClub;
	beforeEach(async () => {
		a = await seedClub();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
	});

	async function pastSpeech(year: number | null, title = "Past one") {
		await testDb.insert(speeches).values({
			personId: a.personId,
			title,
			deliveredOffSchedule: true,
			deliveredYear: year,
			recordedClubId: a.clubId,
		});
	}
	async function meetingSpeech(title: string) {
		const [sp] = await testDb
			.insert(speeches)
			.values({ personId: a.personId, title })
			.returning({ id: speeches.id });
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: a.clubId,
				scheduledAt: new Date(`2020-0${1 + Math.floor(Math.random() * 8)}-10`),
				status: "completed",
			})
			.returning({ id: meetings.id });
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: a.clubId,
				name: `Speaker ${randomUUID().slice(0, 6)}`,
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: m?.id as string,
			roleDefinitionId: def?.id as string,
			assignedMemberId: a.memberId,
			speechId: sp?.id,
			status: "confirmed",
		});
	}

	// protects=a client that cannot render a past row gets meeting rows only, with
	//   limit and truncated counting meeting rows alone (the stale-tab contract)
	// fails_when=includePast: false still runs the past query, or counts past rows
	// no_claim=the wire flag itself (past-rows-capability.guard.test.ts)
	it("includePast: false returns meeting rows only, and limit/truncated ignore past rows", async () => {
		await meetingSpeech("At a meeting");
		await pastSpeech(2023);
		await pastSpeech(2022);
		const withPast = await loadSpeechLog([a.memberId], null, 1);
		expect(withPast.truncated).toBe(true);
		const without = await loadSpeechLog([a.memberId], null, 1, {
			includePast: false,
		});
		expect(without.rows.map((r) => r.kind)).toEqual(["meeting"]);
		expect(without.truncated).toBe(false);
		const mine = await loadMySpeechLog(a.memberUserId, null, {
			includePast: false,
		});
		expect(mine.rows.map((r) => r.kind)).toEqual(["meeting"]);
		const all = await loadMySpeechLog(a.memberUserId, null);
		expect(all.rows.map((r) => r.kind).sort()).toEqual([
			"meeting",
			"past",
			"past",
		]);
	});

	// protects=the past query is never run when includePast is false
	// fails_when=the `includePast === false` branch is removed: one more select
	it("includePast: false does not run the owners or the past query", async () => {
		const spy = vi.spyOn(testDb, "select");
		await loadSpeechLog([a.memberId], null, 6, { includePast: false });
		// The meeting query alone (no window, so no evaluator query either).
		expect(spy).toHaveBeenCalledTimes(1);
	});

	// protects=a window of past rows alone runs no evaluator query
	// fails_when=the `speechRows.length === 0` guard is removed
	it("past rows alone skip the evaluator query", async () => {
		await pastSpeech(2023);
		const spy = vi.spyOn(testDb, "select");
		const { rows } = await loadSpeechLog([a.memberId], null, 6);
		expect(rows.map((r) => r.kind)).toEqual(["past"]);
		// meeting query + owners + past query; no evaluator query.
		expect(spy).toHaveBeenCalledTimes(3);
	});

	// protects=ids that name no member run no past-speech query
	// fails_when=the `personIds.length === 0` guard is removed
	it("member ids with no Person skip the past-speech query", async () => {
		const spy = vi.spyOn(testDb, "select");
		const { rows } = await loadSpeechLog([randomUUID()], null, 6);
		expect(rows).toEqual([]);
		// meeting query + owners lookup; no past query.
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
