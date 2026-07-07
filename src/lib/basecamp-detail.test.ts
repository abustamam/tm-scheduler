/**
 * Unit tests for the pure /detail parser. Synthetic fixture (no real PII).
 * Run: bunx vitest run src/lib/basecamp-detail.test.ts
 */
import { describe, expect, it } from "vitest";
import { type BcmDetailPayload, parseDetailPayload } from "./basecamp-detail";

const payload: BcmDetailPayload = {
	basecampUserId: "122747",
	courseId: "course-v1:Toastmasters+8700+8_15_2023",
	blocks: {
		type: "course",
		display_name: "Motivational Strategies",
		children: [
			{
				type: "chapter",
				display_name: "Level 1",
				complete: true,
				min_req_electives: 0,
				children: [
					{
						block_id: "b-ice",
						type: "sequential",
						display_name: "Ice Breaker",
						complete: true,
						block_lib_type: "imported",
					},
					{
						block_id: "b-purpose",
						type: "sequential",
						display_name: "Writing a Speech with Purpose",
						complete: true,
						block_lib_type: "imported",
					},
				],
			},
			{
				type: "chapter",
				display_name: "Level 3",
				complete: false,
				min_req_electives: 2,
				children: [
					{
						block_id: "b-social",
						type: "sequential",
						display_name: "Deliver Social Speeches",
						complete: true,
						block_lib_type: "elective",
					},
					{
						// Real project, but `complete` is omitted entirely — exercises
						// the missing→false coercion branch.
						block_id: "b-pending",
						type: "sequential",
						display_name: "Manage Projects Successfully",
						block_lib_type: "imported",
					},
					{
						block_id: "",
						type: "sequential",
						display_name: "2nd Elective",
						block_lib_type: "elective",
					},
				],
			},
		],
	},
	speeches: {
		"b-ice": {
			speech_title: "My Journey Here",
			speech_date: "2025-02-27T08:00:00Z",
		},
	},
};

describe("parseDetailPayload", () => {
	it("flattens real projects with completion, joins speeches, excludes placeholders", () => {
		const parsed = parseDetailPayload(payload);
		expect(parsed.courseCode).toBe("8700");
		expect(parsed.basecampUserId).toBe("122747");

		// Placeholder ("2nd Elective", empty block_id) is excluded.
		expect(parsed.projects.map((p) => p.blockId)).toEqual([
			"b-ice",
			"b-purpose",
			"b-social",
			"b-pending",
		]);

		const ice = parsed.projects.find((p) => p.blockId === "b-ice");
		expect(ice).toMatchObject({
			name: "Ice Breaker",
			level: 1,
			isRequired: true,
			complete: true,
			speechTitle: "My Journey Here",
		});
		expect(ice?.speechDate?.toISOString()).toBe("2025-02-27T08:00:00.000Z");

		const social = parsed.projects.find((p) => p.blockId === "b-social");
		expect(social).toMatchObject({ isRequired: false, complete: true });
		expect(social?.speechTitle).toBeNull();

		// min_req_electives captured per level.
		expect(parsed.levels).toEqual([
			{ level: 1, minReqElectives: 0 },
			{ level: 3, minReqElectives: 2 },
		]);
	});

	it("treats a missing `complete` as false", () => {
		const parsed = parseDetailPayload(payload);
		// "b-pending" is a real project whose `complete` field is omitted.
		const pending = parsed.projects.find((p) => p.blockId === "b-pending");
		expect(pending).toMatchObject({
			name: "Manage Projects Successfully",
			level: 3,
			isRequired: true,
			complete: false,
			speechTitle: null,
		});
		for (const p of parsed.projects) expect(typeof p.complete).toBe("boolean");
	});
});
