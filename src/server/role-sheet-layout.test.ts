/**
 * Render smoke tests for the shared role-sheet layout (#310, #311). Guarantees
 * every sheet renders to a valid PDF both blank (the static-template path) and
 * pre-filled (the meeting-aware path), and that the fill path tolerates more
 * speakers than the table has pre-drawn rows. This module has no #/db import, so
 * it renders directly without a database.
 */
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import { EVALUATION_MARKS, TABLE_TOPICS_MARKS } from "#/lib/agenda-runsheet";
import { formatTimingClock } from "#/lib/timing-window";
import {
	buildRoleSheetDoc,
	type RoleSheetFill,
	roleSheetByKey,
	standardTimingRows,
} from "./role-sheet-layout";

const fill: RoleSheetFill = {
	club: "Harborlight Toastmasters",
	date: "Jul 22",
	speakers: ['Alice — "My Icebreaker"', "Bob", "Cara"],
	wod: { word: "ebullient", note: "cheerful and full of energy" },
};

async function isPdf(doc: ReturnType<typeof buildRoleSheetDoc>) {
	const buf = await renderToBuffer(doc as Parameters<typeof renderToBuffer>[0]);
	return {
		ok: buf.subarray(0, 5).toString("latin1") === "%PDF-",
		size: buf.length,
	};
}

describe("role-sheet layout (#311)", () => {
	for (const { key } of ROLE_SHEETS) {
		it(`renders "${key}" blank as a valid PDF`, async () => {
			const { ok, size } = await isPdf(buildRoleSheetDoc(key));
			expect(ok).toBe(true);
			expect(size).toBeGreaterThan(500);
		});

		it(`renders "${key}" pre-filled as a valid PDF`, async () => {
			const { ok, size } = await isPdf(buildRoleSheetDoc(key, fill));
			expect(ok).toBe(true);
			expect(size).toBeGreaterThan(500);
		});
	}

	it("tolerates more speakers than the table has pre-drawn rows", async () => {
		const many: RoleSheetFill = {
			...fill,
			speakers: Array.from({ length: 30 }, (_, i) => `Speaker ${i + 1}`),
		};
		const { ok } = await isPdf(buildRoleSheetDoc("timer", many));
		expect(ok).toBe(true);
	});

	it("resolves known keys and rejects unknown ones", () => {
		expect(roleSheetByKey("timer")?.title).toBe("Timer's log");
		expect(roleSheetByKey("nope")).toBeUndefined();
	});
});

// #507 — the agenda now prints the same windows as coloured marks, so the two
// surfaces hold the same numbers in two places. Pin them together: whoever
// changes one gets a failure naming the other, instead of a Timer signalling at
// 2:30 while the agenda beside them prints something else.
describe("agenda marks agree with the Timer sheet's published windows (#507)", () => {
	const rows = standardTimingRows();
	const published = (assignment: string) =>
		rows.find((r) => r[0] === assignment);

	it("evaluation", () => {
		expect(published("Evaluation")?.slice(1, 4)).toEqual([
			formatTimingClock(EVALUATION_MARKS.green),
			formatTimingClock(EVALUATION_MARKS.yellow),
			formatTimingClock(EVALUATION_MARKS.red),
		]);
	});

	it("table topics", () => {
		expect(published("Table Topics")?.slice(1, 4)).toEqual([
			formatTimingClock(TABLE_TOPICS_MARKS.green),
			formatTimingClock(TABLE_TOPICS_MARKS.yellow),
			formatTimingClock(TABLE_TOPICS_MARKS.red),
		]);
	});
});

// #357 — the Timer needs the qualifying window, not just the signal times.
describe("Timer sheet standard timing windows (#357)", () => {
	const rows = standardTimingRows();

	it("keeps the published green/yellow/red times, deriving yellow as the midpoint", () => {
		expect(rows).toContainEqual([
			"Prepared speech",
			"5:00",
			"6:00",
			"7:00",
			"4:30–7:30",
		]);
		expect(rows).toContainEqual([
			"Evaluation",
			"2:00",
			"2:30",
			"3:00",
			"1:30–3:30",
		]);
	});

	it("never prints a negative lower bound on a short assignment", () => {
		expect(rows).toContainEqual([
			"Table Topics",
			"1:00",
			"1:30",
			"2:00",
			"0:30–2:30",
		]);
	});
});
