// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PathViewModel } from "#/server/pathways-read-logic";
import { PathwaysProgress } from "./pathways-progress";

const base: PathViewModel = {
	courseCode: "8701",
	pathName: "Presentation Mastery",
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
});
