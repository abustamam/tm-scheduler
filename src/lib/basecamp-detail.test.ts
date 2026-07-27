/**
 * Unit tests for the pure /detail parser. Synthetic fixture (no real PII), but
 * shaped after a real captured payload (Engaging Humor, 2026-07-27).
 *
 * The shape matters more than it looks. This fixture used to key `speeches` by
 * the short `block_id`, and asserted the join worked — against a shape Base Camp
 * never sends. Base Camp keys by the node's FULL usage key (`id`), so the join
 * had never worked in production and the test said it did (#425). So: `id` and
 * `block_id` are kept deliberately DIFFERENT here, and `speeches` is keyed by
 * `id`. If a future edit makes them the same, this stops testing anything.
 *
 * Run: bunx vitest run src/lib/basecamp-detail.test.ts
 */
import { describe, expect, it } from "vitest";
import { type BcmDetailPayload, parseDetailPayload } from "./basecamp-detail";
import { PATH_COMPLETION_LEVEL } from "./pathways-catalog";

/** Real Base Camp usage-key format: the short block_id is its tail. */
const usage = (blockId: string) =>
	`block-v1:Toastmasters+8700+8_15_2023+type@sequential+block@${blockId}`;

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
						// The level's own intro unit — a real block_id, not a project.
						// Base Camp lists it first, which is why its per-member table
						// shows 5 rows for a Level 1 that has 4 projects (#415).
						id: usage("b-l1-intro"),
						block_id: "b-l1-intro",
						type: "sequential",
						display_name: "Level 1: Mastering Fundamentals",
						complete: true,
					},
					{
						id: usage("b-ice"),
						block_id: "b-ice",
						type: "sequential",
						display_name: "Ice Breaker",
						complete: true,
						block_lib_type: "imported",
					},
					{
						id: usage("b-purpose"),
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
						id: usage("b-l3-intro"),
						block_id: "b-l3-intro",
						type: "sequential",
						display_name: "Level 3: Increasing Knowledge",
						complete: false,
					},
					{
						id: usage("b-social"),
						block_id: "b-social",
						type: "sequential",
						display_name: "Deliver Social Speeches",
						complete: true,
						block_lib_type: "elective",
					},
					{
						// Real project, but `complete` is omitted entirely — exercises
						// the missing→false coercion branch.
						id: usage("b-pending"),
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
		[usage("b-ice")]: {
			speech_title: "My Journey Here",
			speech_date: "2025-02-27T08:00:00Z",
		},
	},
};

/** Non-null assert, so each test reads about parsing rather than about null. */
function parsePath(p: BcmDetailPayload) {
	const parsed = parseDetailPayload(p);
	if (!parsed) throw new Error("expected a Pathways path payload");
	return parsed;
}

describe("parseDetailPayload", () => {
	it("flattens real projects with completion, joins speeches, excludes placeholders", () => {
		const parsed = parsePath(payload);
		expect(parsed.courseCode).toBe("8700");
		expect(parsed.basecampUserId).toBe("122747");

		// Excluded: the placeholder ("2nd Elective", empty block_id) AND both
		// level intro units, which have real block ids but are not projects.
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
		const parsed = parsePath(payload);
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

	// Legacy paths name the unit "Path Introduction" instead of "Level N: …".
	// Both spellings exist on prod; both are containers, not projects (#415).
	it("excludes the legacy 'Path Introduction' container too", () => {
		const legacy: BcmDetailPayload = {
			...payload,
			courseId: "course-v1:pathways+8702+8_31_2023",
			blocks: {
				type: "course",
				display_name: "Leadership Development",
				children: [
					{
						type: "chapter",
						display_name: "Level 1",
						min_req_electives: 0,
						children: [
							{
								id: usage("b-path-intro"),
								block_id: "b-path-intro",
								type: "sequential",
								display_name: "Path Introduction",
								complete: true,
							},
							{
								id: usage("b-ice-legacy"),
								block_id: "b-ice-legacy",
								type: "sequential",
								display_name: "Ice Breaker (Legacy)",
								complete: true,
								block_lib_type: "imported",
							},
						],
					},
				],
			},
		};
		const parsed = parsePath(legacy);
		expect(parsed.projects.map((p) => p.name)).toEqual([
			"Ice Breaker (Legacy)",
		]);
	});

	// #425. The main test above already fails if the lookup reverts to
	// `block_id` — the fixture's only speeches key is the full usage key. This
	// pins the two halves separately so the failure names the cause.
	it("joins speeches on the full usage key, not the short block_id", () => {
		const ice = parsePath(payload).projects.find((p) => p.blockId === "b-ice");
		expect(ice?.speechTitle).toBe("My Journey Here");
		// The short id is NOT a key in the map — proving the join used `id`.
		expect(Object.keys(payload.speeches)).not.toContain("b-ice");
	});

	it("still falls back to the short block_id if a payload keys speeches that way", () => {
		const shortKeyed: BcmDetailPayload = {
			...payload,
			speeches: {
				"b-purpose": {
					speech_title: "Short-keyed",
					speech_date: "2025-03-01T08:00:00Z",
				},
			},
		};
		const p = parsePath(shortKeyed).projects.find(
			(x) => x.blockId === "b-purpose",
		);
		expect(p?.speechTitle).toBe("Short-keyed");
	});

	// #424. Base Camp ships path completion as a SIBLING of the five levels, not
	// inside Level 5 where toastmasters.org draws it. The chapter used to be
	// discarded, so "Reflect on Your Path" was never corroborated on any path.
	it("ingests the Path Completion chapter as a sibling of the levels", () => {
		const withCompletion: BcmDetailPayload = {
			...payload,
			blocks: {
				type: "course",
				display_name: "Motivational Strategies",
				children: [
					{
						type: "chapter",
						display_name: "Path Completion",
						min_req_electives: 0,
						children: [
							{
								id: usage("b-reflect"),
								block_id: "b-reflect",
								type: "sequential",
								display_name: "Reflect on Your Path",
								block_lib_type: "imported",
							},
						],
					},
				],
			},
		};
		const parsed = parsePath(withCompletion);
		expect(parsed.projects).toEqual([
			expect.objectContaining({
				name: "Reflect on Your Path",
				level: PATH_COMPLETION_LEVEL,
				isRequired: true,
				complete: false,
			}),
		]);
		// Not a level: no pathways_path_levels row, so it can never reach
		// `currentLevel` or the progress ring.
		expect(parsed.levels).toEqual([]);
	});

	// Base Camp hosts Club Officer Training, the Mentor Program and friends in
	// the same LMS. Those used to throw here and sink the whole detail phase.
	it("returns null for a course that is not a Pathways path", () => {
		expect(
			parseDetailPayload({
				...payload,
				courseId: "course-v1:pathways+8731+8_31_2023",
			}),
		).toBeNull();
		expect(
			parseDetailPayload({
				...payload,
				courseId: "course-v1:pathways+COT-S+x",
			}),
		).toBeNull();
	});
});
