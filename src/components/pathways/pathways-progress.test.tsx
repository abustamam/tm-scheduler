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
	levels: [
		{ level: 1, completed: 5, total: 5, approved: true },
		{ level: 3, completed: 1, total: 4, approved: false },
	],
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
								level: 3,
								name: "Understanding Emotional Intelligence",
								isRequired: true,
							},
						],
						upNextElectives: {
							chooseCount: 1,
							options: ["Persuasive Speaking", "Connect with Storytelling"],
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

	it("renders a non-speech win as a bare name (no crash on null date/empty title)", () => {
		render(
			<PathwaysProgress
				paths={[
					{
						...base,
						wins: [
							{
								level: 1,
								name: "Manage Projects Successfully",
								speechTitle: "",
								deliveredAt: null,
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
							{ level: 3, name: "Speaking to Inform", isRequired: true },
						],
					},
				]}
			/>,
		);
		expect(screen.queryByText(/Choose .* elective/i)).toBeNull();
	});
});
