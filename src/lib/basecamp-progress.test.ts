import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type BcmProgressPage,
	extractCourseCode,
	normalizePages,
	parseProgressPages,
} from "./basecamp-progress";

function loadPage(n: 1 | 2): BcmProgressPage {
	const raw = readFileSync(
		resolve(process.cwd(), `samples/_api_bcm_progress_${n}`),
		"utf8",
	);
	return JSON.parse(raw) as BcmProgressPage;
}

describe("extractCourseCode", () => {
	it("pulls the numeric code from a course_id, whichever org segment", () => {
		expect(extractCourseCode("course-v1:Toastmasters+8701+8_15_2023")).toBe(
			"8701",
		);
		expect(extractCourseCode("course-v1:pathways+8705+8_31_2023")).toBe("8705");
	});

	// TI puts the language in the RUN slot for current paths and in the CODE slot
	// for the five legacy ones. The second form used to throw, so every localized
	// edition of a legacy path 400'd its club's whole sync (#414).
	it("resolves a localized legacy path to its base code", () => {
		expect(extractCourseCode("course-v1:pathways+SP8702+8_31_2023")).toBe(
			"8702",
		);
		expect(extractCourseCode("course-v1:pathways+AR8709+8_31_2023")).toBe(
			"8709",
		);
		// Language in the run slot instead — already worked, must keep working.
		expect(extractCourseCode("course-v1:pathways+8700+AR8700")).toBe("8700");
	});

	// Base Camp hosts these alongside the paths. They are numeric, so they used
	// to pass and get inserted into the GLOBAL pathways_paths table.
	it("rejects numeric courses that are not Pathways paths", () => {
		for (const code of ["8604", "8605", "8669", "8712", "8731", "8710"]) {
			expect(
				extractCourseCode(`course-v1:pathways+${code}+8_31_2023`),
			).toBeNull();
		}
	});

	it("returns null rather than throwing on anything unrecognized", () => {
		for (const id of [
			"garbage",
			"course-v1:pathways+COT-S+01_21_2026",
			"course-v1:pathways+en-us-DTM+01_21_2026",
			"course-v1:pathways+TI_MA_L1+01_21_2026",
			"course-v1:pathways+8650_002+09_02_2025",
			"course-v1:pathways+08012025+08_01_2025",
		]) {
			expect(extractCourseCode(id)).toBeNull();
		}
	});
});

describe("parseProgressPages", () => {
	const rows = parseProgressPages([loadPage(1), loadPage(2)]);

	it("concatenates both pages (15 member-path rows)", () => {
		expect(rows).toHaveLength(15);
	});

	it("parses a member-path with per-level counts, preserving completed > total", () => {
		const sr = rows.find(
			(r) => r.basecampUserId === "122747" && r.courseCode === "8705",
		);
		expect(sr).toBeDefined();
		expect(sr?.pathName).toBe("Strategic Relationships");
		expect(sr?.email).toBe("rasheed.bustamam@gmail.com");
		const l3 = sr?.levels.find((l) => l.level === 3);
		expect(l3).toEqual({ level: 3, completed: 7, total: 3, approved: true });
	});

	it("keeps multiple paths for the same user as separate rows", () => {
		const mine = rows.filter((r) => r.basecampUserId === "122747");
		expect(mine.map((r) => r.courseCode).sort()).toEqual(["8705", "8711"]);
	});

	it("ignores the non-Level 'Path Completion' key", () => {
		const anyRow = rows[0];
		expect(anyRow.levels.every((l) => Number.isInteger(l.level))).toBe(true);
		expect(anyRow.levels).toHaveLength(5);
	});

	it("lowercases email", () => {
		expect(
			rows.every((r) => r.email === null || r.email === r.email?.toLowerCase()),
		).toBe(true);
	});
});

describe("parseProgressPages — synthetic edge cases", () => {
	function pageWith(row: BcmProgressPage["results"][number]): BcmProgressPage {
		return { results: [row] };
	}

	it("lowercases a mixed-case email", () => {
		const [row] = parseProgressPages([
			pageWith({
				user: { id: 1, name: "Foo Bar", email: "Foo@Bar.com" },
				path_name: "Presentation Mastery",
				course_id: "course-v1:Toastmasters+8701+8_15_2023",
				progression: { "Level 1": { completed: 1, total: 5, approved: true } },
			}),
		]);
		expect(row.email).toBe("foo@bar.com");
	});

	it("passes a null email through as null (no crash)", () => {
		const [row] = parseProgressPages([
			pageWith({
				user: { id: 2, name: "No Email", email: null },
				path_name: "Presentation Mastery",
				course_id: "course-v1:Toastmasters+8701+8_15_2023",
				progression: { "Level 1": { completed: 0, total: 5, approved: false } },
			}),
		]);
		expect(row.email).toBeNull();
	});

	it("defaults approved to false when the field is absent", () => {
		const [row] = parseProgressPages([
			pageWith({
				user: { id: 3, name: "No Approved", email: null },
				path_name: "Presentation Mastery",
				course_id: "course-v1:Toastmasters+8701+8_15_2023",
				progression: { "Level 1": { completed: 5, total: 5 } },
			}),
		]);
		expect(row.levels).toHaveLength(1);
		expect(row.levels[0]).toEqual({
			level: 1,
			completed: 5,
			total: 5,
			approved: false,
		});
	});
});

describe("normalizePages", () => {
	const page: BcmProgressPage = { results: [] };

	it("wraps a single page object in an array", () => {
		expect(normalizePages(page)).toEqual([page]);
	});

	it("returns an array of pages unchanged", () => {
		const pages = [page, { results: [] }];
		expect(normalizePages(pages)).toBe(pages);
		expect(normalizePages(pages)).toHaveLength(2);
	});
});
