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

// #507 — the Timer's sheet is the surface that shipped saying "Amber" while the
// live layout said "Yellow", because every test asserted `standardTimingRows()`
// DATA and none asserted the printed words. Walk the doc tree for them.
describe("Timer sheet prints yellow, never amber (#507)", () => {
	/** Every string in a react-pdf element tree. */
	function textOf(node: unknown): string[] {
		if (node == null || node === false) return [];
		if (typeof node === "string") return [node];
		if (Array.isArray(node)) return node.flatMap(textOf);
		const el = node as { props?: { children?: unknown } };
		return el.props ? textOf(el.props.children) : [];
	}

	const words = textOf(buildRoleSheetDoc("timer")).join(" | ");

	it("uses yellow in the column header and the instruction", () => {
		expect(words).toContain("Yellow");
		expect(words).toContain("green / yellow / red");
	});

	it("says amber nowhere", () => {
		expect(words.toLowerCase()).not.toContain("amber");
	});
});

// The club logo shipped on this sheet with NO coverage: deleting the whole
// `fill?.logoDataUri ? Image : null` branch from header() left all 22 tests in
// this file green, because every one of them asserts either DATA or "is it a
// PDF" — the same blind spot #507 above was written for. These assert the
// rendered element tree.
describe("club logo on the role sheet (#496)", () => {
	/** Every element in a react-pdf tree, flattened. */
	function nodesOf(node: unknown): { props?: Record<string, unknown> }[] {
		if (node == null || node === false || typeof node === "string") return [];
		if (Array.isArray(node)) return node.flatMap(nodesOf);
		const el = node as { props?: Record<string, unknown> };
		if (!el.props) return [];
		return [el, ...nodesOf(el.props.children)];
	}

	const LOGO = "data:image/png;base64,AAAA";

	function nodes(withFill?: RoleSheetFill) {
		return nodesOf(buildRoleSheetDoc("timer", withFill));
	}

	function imageSources(withFill?: RoleSheetFill) {
		return nodes(withFill)
			.map((n) => n.props?.src)
			.filter((src): src is string => typeof src === "string");
	}

	function plates(withFill?: RoleSheetFill) {
		return nodes(withFill).filter((n) => {
			const style = n.props?.style as { backgroundColor?: string } | undefined;
			return style?.backgroundColor === "#fff";
		});
	}

	it("renders the club's logo when the fill carries one", () => {
		expect(imageSources({ ...fill, logoDataUri: LOGO })).toContain(LOGO);
	});

	it("renders no image at all when the fill has no logo", () => {
		expect(imageSources(fill)).toHaveLength(0);
		expect(imageSources()).toHaveLength(0);
	});

	it("backs the logo with a light plate, and only when there is a logo", () => {
		expect(plates({ ...fill, logoDataUri: LOGO })).toHaveLength(1);
		expect(plates(fill)).toHaveLength(0);
	});

	it("still renders a valid PDF with a logo present", async () => {
		const { ok } = await isPdf(
			buildRoleSheetDoc("timer", { ...fill, logoDataUri: LOGO }),
		);
		expect(ok).toBe(true);
	});

	// #496 AC5: "Page counts unchanged on the WOD poster and role sheets, with
	// and without a logo — counted from rendered PDF output, not eyeballed."
	// `isPdf` above only checks the %PDF- magic bytes, so a logo that pushed the
	// header tall enough to spill onto page 2 would still read as "a valid PDF".
	// This repo has shipped exactly that failure before: a missing print reset
	// added a blank second page and got past 6 test files, typecheck, lint and
	// two reviews, because print CSS has no gate here. Count the pages.
	async function pageCount(doc: ReturnType<typeof buildRoleSheetDoc>) {
		const buf = await renderToBuffer(
			doc as Parameters<typeof renderToBuffer>[0],
		);
		// Page objects are `/Type /Page`; the tree root is `/Type /Pages`, so the
		// negative lookahead is what keeps this from counting the container.
		return (buf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g) ?? [])
			.length;
	}

	for (const { key } of ROLE_SHEETS) {
		it(`"${key}" stays one page whether or not the club has a logo`, async () => {
			const without = await pageCount(buildRoleSheetDoc(key, fill));
			const withLogo = await pageCount(
				buildRoleSheetDoc(key, { ...fill, logoDataUri: LOGO }),
			);
			expect(without).toBe(1);
			expect(withLogo).toBe(without);
		});
	}
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
