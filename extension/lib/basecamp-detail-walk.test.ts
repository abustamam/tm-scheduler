/**
 * Unit tests for the pure /detail fan-out. Injectable fetch, no browser.
 * Run: cd extension && bunx vitest run lib/basecamp-detail-walk.test.ts
 */
import { describe, expect, it } from "vitest";
import {
	extractDetailTargets,
	fetchDetails,
} from "./basecamp-detail-walk";

const pages = [
	{
		results: [
			{ user: { id: 122747, username: "guid-a" }, course_id: "course-v1:Toastmasters+8700+x" },
			{ user: { id: 55, username: "guid-b" }, course_id: "course-v1:Toastmasters+8701+x" },
		],
		next: null,
	},
];

describe("extractDetailTargets", () => {
	it("pulls (numeric id, guid, courseId) per member-path row", () => {
		expect(extractDetailTargets(pages)).toEqual([
			{ basecampUserId: "122747", guid: "guid-a", courseId: "course-v1:Toastmasters+8700+x" },
			{ basecampUserId: "55", guid: "guid-b", courseId: "course-v1:Toastmasters+8701+x" },
		]);
	});

	it("skips malformed rows (missing id, username, or course_id)", () => {
		const malformed = [
			{
				results: [
					{ user: { username: "no-id" }, course_id: "course-v1:Toastmasters+9000+x" }, // missing user.id
					{ user: { id: 77 }, course_id: "course-v1:Toastmasters+9001+x" }, // missing user.username
					{ user: { id: 88, username: "no-course" } }, // missing course_id
					{ user: { id: 99, username: "guid-ok" }, course_id: "course-v1:Toastmasters+9002+x" }, // valid
				],
				next: null,
			},
		];
		expect(extractDetailTargets(malformed)).toEqual([
			{ basecampUserId: "99", guid: "guid-ok", courseId: "course-v1:Toastmasters+9002+x" },
		]);
	});
});

describe("fetchDetails", () => {
	it("fetches each target and tags the payload with the numeric id + courseId", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }),
		});
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 2 });
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ basecampUserId: "122747", courseId: "course-v1:Toastmasters+8700+x" });
		expect(out[0].blocks).toBeDefined();
	});

	it("omits a target whose call fails, keeps the rest (graceful per-call)", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => {
			if (url.includes("guid-a")) throw new Error("boom");
			return { ok: true, status: 200, json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }) };
		};
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 2 });
		expect(out).toHaveLength(1);
		expect(out[0].basecampUserId).toBe("55");
	});

	it("omits a target that returns a non-ok status", async () => {
		const targets = extractDetailTargets(pages);
		const fetchImpl = async (url: string) => ({
			ok: url.includes("guid-b"),
			status: url.includes("guid-b") ? 200 : 500,
			json: async () => ({ blocks: { type: "course", display_name: "P", children: [] }, speeches: {} }),
		});
		const out = await fetchDetails({ fetchImpl, targets, csrftoken: "t", concurrency: 1 });
		expect(out.map((d) => d.basecampUserId)).toEqual(["55"]);
	});
});
