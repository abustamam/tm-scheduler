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
	it("pulls the numeric code from a course_id", () => {
		expect(extractCourseCode("course-v1:Toastmasters+8701+8_15_2023")).toBe(
			"8701",
		);
		expect(extractCourseCode("course-v1:pathways+8705+8_31_2023")).toBe("8705");
	});
	it("throws on a malformed course_id", () => {
		expect(() => extractCourseCode("garbage")).toThrow();
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
