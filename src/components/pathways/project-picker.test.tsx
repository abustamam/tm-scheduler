// @vitest-environment jsdom
//
// Covers the evaluation-resource link wired into ProjectPicker (#606-adjacent;
// spec 2026-08-20 task 3): the selected-project summary AND each project row
// in the level list should each offer a link to the official TI evaluation
// resource, and each gets its own assertion.
//
// The level-list link lives inside the picker's Radix Dialog, which the
// returned `container` cannot see: the dialog starts closed (Radix
// `Presence` renders nothing until `open`), and once open it mounts through
// a `Portal` outside `container` entirely. So that assertion opens the
// dialog with a real click and queries `document.body` (via `screen`)
// instead. No `@testing-library/jest-dom` in this repo, so assertions use
// native DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPicker } from "#/components/pathways/project-picker";
import type { PickerPath } from "#/server/project-picker";

afterEach(cleanup);

// The exact TI resource for "Active Listening", per
// src/lib/evaluation-resources.ts. Asserted as a literal rather than derived
// from `resourcesForProject("Active Listening")` — deriving the expectation
// from the same table the test is meant to guard would pass for any value
// that table returns, including a wrong one.
const ACTIVE_LISTENING_URL =
	"https://www.toastmasters.org/resources/-/media/d97ff6e633ad44dbaca0ddac5a6c0fb8.ashx";

const PATH: PickerPath = {
	pathId: "path-1",
	courseCode: "8701",
	name: "Presentation Mastery",
	status: "current",
	defaultLevel: 3,
	projects: [
		{
			id: "proj-1",
			level: 3,
			name: "Active Listening",
			isRequired: false,
			series: null,
			complete: false,
		},
	],
};

describe("ProjectPicker", () => {
	it("offers the evaluation resource next to the selected-project summary", () => {
		const { container } = render(
			<ProjectPicker
				paths={[PATH]}
				value="proj-1"
				onChange={() => {}}
				fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
			/>,
		);
		const link = container.querySelector("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("href")).toBe(ACTIVE_LISTENING_URL);
	});

	it("renders NO link for a project with no resource of its own", () => {
		// Spec §2, and the call site is what enforces it: the picker passes no
		// `fallback`, so the generic 8053 form never stands in for a project TI
		// publishes its own form for. Cross-Cultural Understanding is the live
		// case — `reconcileCatalog` derives it from Base Camp, `pathways-catalog.ts`
		// does not list it (#606), and TI publishes 8202E for it.
		const { container } = render(
			<ProjectPicker
				paths={[
					{
						...PATH,
						projects: [
							{
								id: "proj-1",
								level: 3,
								name: "Cross-Cultural Understanding",
								isRequired: false,
								series: null,
								complete: false,
							},
						],
					},
				]}
				value="proj-1"
				onChange={() => {}}
				fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
			/>,
		);
		expect(container.querySelectorAll("a")).toHaveLength(0);
	});

	it("offers the evaluation resource on the project row inside the picker dialog", async () => {
		const user = userEvent.setup();
		// No selection, so the only link on the page once the dialog opens is
		// the level-list row's — nothing to confuse it with.
		render(
			<ProjectPicker
				paths={[PATH]}
				value={null}
				onChange={() => {}}
				fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
			/>,
		);

		// The trigger's accessible name comes from its associated <label> ("Pathways
		// project"), not its visible "Choose a project" text — `id="project-picker-trigger"`
		// is what actually identifies it.
		const trigger = document.getElementById("project-picker-trigger");
		expect(trigger).toBeTruthy();
		await user.click(trigger as Element);

		const link = await screen.findByRole("link");
		expect(link.getAttribute("href")).toBe(ACTIVE_LISTENING_URL);
	});

	it("lists a level's projects, then each Education Series under its own heading (#922)", async () => {
		const user = userEvent.setup();
		const row = (
			id: string,
			name: string,
			isRequired: boolean,
			series: PickerPath["projects"][number]["series"] = null,
			complete = false,
		) => ({ id, level: 4, name, isRequired, series, complete });
		const picked: string[] = [];
		render(
			<ProjectPicker
				paths={[
					{
						...PATH,
						defaultLevel: 4,
						projects: [
							row("r", "Manage Change", true),
							row("sc", "Closing the Sale", false, "successful_club", true),
							row("e", "Write a Compelling Blog", false),
							row("bs", "Controlling Your Fear", false, "better_speaker"),
						],
					},
				]}
				value={null}
				onChange={(id) => {
					if (id) picked.push(id);
				}}
				fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
			/>,
		);
		await user.click(
			document.getElementById("project-picker-trigger") as Element,
		);

		const dialog = await screen.findByRole("dialog");
		const text = dialog.textContent ?? "";
		const at = (s: string) => {
			const i = text.indexOf(s);
			expect(i, s).toBeGreaterThanOrEqual(0);
			return i;
		};
		// Path projects first (catalog order), then one sub-group per series.
		expect(at("Manage Change")).toBeLessThan(at("Write a Compelling Blog"));
		expect(at("Write a Compelling Blog")).toBeLessThan(
			at("Successful Club Series"),
		);
		expect(at("Closing the Sale")).toBeLessThan(at("Better Speaker Series"));
		expect(at("Better Speaker Series")).toBeLessThan(
			at("Controlling Your Fear"),
		);

		const seriesRow = screen.getByRole("button", {
			name: /Controlling Your Fear/,
		});
		// Badged with its series, never "Required".
		expect(seriesRow.textContent).toContain("Better Speaker Series");
		expect(seriesRow.textContent).not.toContain("Required");
		// A marked series title shows as completed.
		expect(
			screen.getByRole("button", { name: /Closing the Sale/ }).textContent,
		).toContain("(completed)");

		await user.click(seriesRow);
		expect(picked).toEqual(["bs"]);
	});
});
