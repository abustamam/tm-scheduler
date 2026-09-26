// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PathViewModel } from "#/server/pathways-read-logic";
import { PathwaysProgress } from "./pathways-progress";

const base: PathViewModel = {
	courseCode: "8701",
	pathName: "Presentation Mastery",
	status: "current",
	ringPercent: 40,
	currentLevel: 3,
	complete: false,
	workingLevel: 3,
	projectsLeftAtWorkingLevel: 3,
	levels: [
		{ level: 1, completed: 5, total: 5, approved: true },
		{ level: 3, completed: 1, total: 4, approved: false },
	],
	levelsSource: "basecamp",
	hasBasecamp: true,
	wins: [],
	upNext: [],
	upNextElectives: null,
	upNextSeries: [],
};

describe("PathwaysProgress", () => {
	afterEach(() => cleanup());

	it("renders a 'Choose N more electives' group with the option names", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						upNext: [
							{
								projectId: "p1",
								level: 3,
								name: "Understanding Emotional Intelligence",
								isRequired: true,
							},
						],
						upNextElectives: {
							chooseCount: 1,
							options: [
								{ projectId: "p2", name: "Persuasive Speaking" },
								{ projectId: "p3", name: "Connect with Storytelling" },
							],
						},
					},
				]}
			/>,
		);
		expect(screen.getByText(/Choose 1 more elective/i)).toBeTruthy();
		expect(screen.getByText("Persuasive Speaking")).toBeTruthy();
		expect(
			screen.getByText("Understanding Emotional Intelligence"),
		).toBeTruthy();
	});

	it("pluralizes the heading when chooseCount is not 1", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						upNextElectives: {
							chooseCount: 2,
							options: [
								{ projectId: "p4", name: "A" },
								{ projectId: "p5", name: "B" },
							],
						},
					},
				]}
			/>,
		);
		expect(screen.getByText(/Choose 2 more electives/i)).toBeTruthy();
	});

	it("renders a non-speech win as a bare name (no crash on null date/empty title)", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						wins: [
							{
								projectId: "p6",
								level: 1,
								name: "Manage Projects Successfully",
								speechTitle: "",
								deliveredAt: null,
								markedHere: false,
								awaitingProcessing: false,
							},
						],
					},
				]}
			/>,
		);
		expect(screen.getByText("Manage Projects Successfully")).toBeTruthy();
	});

	it("shows no elective group when upNextElectives is null", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						upNext: [
							{
								projectId: "p7",
								level: 3,
								name: "Speaking to Inform",
								isRequired: true,
							},
						],
					},
				]}
			/>,
		);
		expect(screen.queryByText(/Choose .* elective/i)).toBeNull();
	});

	// #898: on a club without Base Camp nothing is ever approved, so the
	// lowest-unapproved `currentLevel` is Level 1 forever. The panel follows the
	// level being WORKED ON instead.
	it("shows Level 2 and its Up next after a fully marked Level 1", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						levelsSource: "catalog",
						hasBasecamp: false,
						currentLevel: 1,
						workingLevel: 2,
						projectsLeftAtWorkingLevel: 3,
						levels: [
							{ level: 1, completed: 4, total: 4, approved: false },
							{ level: 2, completed: 0, total: 3, approved: false },
						],
						upNext: [
							{
								projectId: "l2a",
								level: 2,
								name: "Understanding Your Communication Style",
								isRequired: true,
							},
						],
					},
				]}
			/>,
		);
		expect(screen.getByText("Level 2 · 0 of 3")).toBeTruthy();
		expect(screen.queryByText(/Level 1 · 4 of 4/)).toBeNull();
		expect(screen.getByText("Up next")).toBeTruthy();
		expect(
			screen.getByText("Understanding Your Communication Style"),
		).toBeTruthy();
	});

	it("labels Path Completion by name and renders its Up next even when complete", () => {
		const { container } = render(
			<PathwaysProgress
				paths={[
					{
						...base,
						levelsSource: "catalog",
						hasBasecamp: false,
						complete: true,
						currentLevel: null,
						workingLevel: 6,
						projectsLeftAtWorkingLevel: 1,
						levels: [
							{ level: 5, completed: 3, total: 3, approved: true },
							{ level: 6, completed: 0, total: 1, approved: false },
						],
						upNext: [
							{
								projectId: "pc",
								level: 6,
								name: "Reflect on Your Path",
								isRequired: true,
							},
						],
					},
				]}
			/>,
		);
		expect(screen.getByText("Up next")).toBeTruthy();
		expect(screen.getByText("Reflect on Your Path")).toBeTruthy();
		expect(screen.getByText("Path Completion")).toBeTruthy();
		expect(container.textContent).not.toMatch(/Level 6|L6/);
	});

	it("keeps the current level's bar when nothing is left and nothing is approved", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						levelsSource: "catalog",
						hasBasecamp: false,
						currentLevel: 1,
						workingLevel: null,
						projectsLeftAtWorkingLevel: 0,
						levels: [{ level: 1, completed: 4, total: 4, approved: false }],
					},
				]}
			/>,
		);
		expect(screen.getByText("Level 1 · 4 of 4")).toBeTruthy();
		expect(screen.queryByText("Up next")).toBeNull();
	});

	describe("Education Series (#922)", () => {
		const series: PathViewModel["upNextSeries"] = [
			{
				series: "successful_club",
				label: "Successful Club Series",
				level: 4,
				options: [
					{ projectId: "sc1", name: "Finding New Members" },
					{ projectId: "sc2", name: "Closing the Sale" },
				],
			},
			{
				series: "better_speaker",
				label: "Better Speaker Series",
				level: 4,
				options: [{ projectId: "bs1", name: "Controlling Your Fear" }],
			},
		];
		const atL4: PathViewModel = {
			...base,
			currentLevel: 4,
			workingLevel: 4,
			levels: [{ level: 4, completed: 1, total: 4, approved: false }],
			upNext: [
				{
					projectId: "r1",
					level: 4,
					name: "Manage Change",
					isRequired: true,
				},
			],
			upNextSeries: series,
		};
		const SERIES_LINE = /Base Camp doesn't track series presentations/;
		const BASECAMP_LINE = "Do it in Base Camp, then sync to see it here.";
		const TICK_LINE = "Tick one off when you've delivered it.";

		it("renders one 'Choose 1' block per series with its titles as tick buttons", () => {
			render(<PathwaysProgress paths={[atL4]} onMark={() => {}} />);
			expect(
				screen.getByText("Choose 1 Successful Club Series presentation:"),
			).toBeTruthy();
			expect(
				screen.getByText("Choose 1 Better Speaker Series presentation:"),
			).toBeTruthy();
			for (const name of [
				"Finding New Members",
				"Closing the Sale",
				"Controlling Your Fear",
			]) {
				expect(
					screen.getByRole("button", { name: `Mark ${name} complete` }),
				).toBeTruthy();
			}
		});

		it("says Base Camp doesn't track series only on a synced club", () => {
			render(<PathwaysProgress paths={[atL4]} onMark={() => {}} />);
			expect(screen.getByText(SERIES_LINE)).toBeTruthy();
			// The Base Camp footer still describes the required project above it.
			expect(screen.getByText(BASECAMP_LINE)).toBeTruthy();
			cleanup();

			render(
				<PathwaysProgress
					paths={[{ ...atL4, hasBasecamp: false }]}
					onMark={() => {}}
				/>,
			);
			expect(screen.queryByText(SERIES_LINE)).toBeNull();
			// One tick line for the required project, one for the series.
			expect(screen.getAllByText(TICK_LINE)).toHaveLength(2);
			cleanup();

			render(<PathwaysProgress paths={[{ ...atL4, hasBasecamp: false }]} />);
			expect(screen.queryByText(TICK_LINE)).toBeNull();
		});

		it("renders Up next with only series left, and only the series line", () => {
			render(
				<PathwaysProgress
					paths={[{ ...atL4, upNext: [], upNextElectives: null }]}
					onMark={() => {}}
				/>,
			);
			expect(screen.getByText("Up next")).toBeTruthy();
			expect(
				screen.getByText("Choose 1 Better Speaker Series presentation:"),
			).toBeTruthy();
			expect(screen.getByText(SERIES_LINE)).toBeTruthy();
			expect(screen.queryByText(BASECAMP_LINE)).toBeNull();
		});

		it("keeps series owed below the working level tickable, naming their level", () => {
			// Base Camp's counts moved the working level to 5, then off the end;
			// the Level 4 series are still owed and only tickable here.
			// With no working level the bar falls back to `currentLevel` (4), the
			// series' own level, so no suffix is needed there.
			for (const [workingLevel, heading] of [
				[5, "Choose 1 Better Speaker Series presentation for Level 4:"],
				[null, "Choose 1 Better Speaker Series presentation:"],
			] as const) {
				render(
					<PathwaysProgress
						paths={[
							{
								...atL4,
								workingLevel,
								upNext: [],
								upNextElectives: null,
							},
						]}
						onMark={() => {}}
					/>,
				);
				expect(screen.getByText("Up next")).toBeTruthy();
				expect(screen.getByText(heading)).toBeTruthy();
				expect(
					screen.getByRole("button", {
						name: "Mark Controlling Your Fear complete",
					}),
				).toBeTruthy();
				cleanup();
			}
		});
	});
});
