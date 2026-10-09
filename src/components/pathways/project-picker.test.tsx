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
import type { PickerPath, PickerProject } from "#/server/project-picker";

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
			given: [],
			booked: [],
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
								given: [],
								booked: [],
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
		) => ({
			id,
			level: 4,
			name,
			isRequired,
			series,
			complete,
			given: [],
			booked: [],
		});
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

	describe("given and booked history (#1160)", () => {
		const LA = "America/Los_Angeles";
		const CHI = "America/Chicago";
		// Dates sit in the CURRENT year so the year-less form stays year-less.
		const YEAR = new Date().getUTCFullYear();

		/** Open the dialog on a single project row and return that row's text. */
		async function rowText(
			history: Pick<PickerProject, "given" | "booked">,
		): Promise<string> {
			const user = userEvent.setup();
			render(
				<ProjectPicker
					paths={[
						{
							...PATH,
							projects: [{ ...PATH.projects[0], ...history }],
						},
					]}
					value={null}
					onChange={() => {}}
					fallback={{
						pathwayPath: null,
						projectName: null,
						projectLevel: null,
					}}
				/>,
			);
			await user.click(
				document.getElementById("project-picker-trigger") as Element,
			);
			const dialog = await screen.findByRole("dialog");
			return dialog.textContent ?? "";
		}

		it("reads 'Given Aug 29' for one past speech", async () => {
			const text = await rowText({
				given: [{ at: `${YEAR}-08-29T18:00:00Z`, timeZone: CHI }],
				booked: [],
			});
			expect(text).toContain("Given Aug 29");
			expect(text).not.toContain("Booked");
		});

		it("reads 'Given 2×, last <newest>' for repeats", async () => {
			const text = await rowText({
				given: [
					{ at: `${YEAR}-08-29T18:00:00Z`, timeZone: CHI },
					{ at: `${YEAR}-06-13T18:00:00Z`, timeZone: CHI },
				],
				booked: [],
			});
			expect(text).toContain("Given 2×, last Aug 29");
			expect(text).not.toContain("Jun 13");
		});

		it("reads 'Booked Oct 17' for the SOONEST booking, not a later one", async () => {
			const text = await rowText({
				given: [],
				booked: [
					{ at: `${YEAR}-10-17T18:00:00Z`, timeZone: CHI },
					{ at: `${YEAR}-10-24T18:00:00Z`, timeZone: CHI },
				],
			});
			expect(text).toContain("Booked Oct 17");
			expect(text).not.toContain("Oct 24");
			expect(text).not.toContain("Given");
		});

		it("joins given and booked with ' · '", async () => {
			const text = await rowText({
				given: [{ at: `${YEAR}-08-29T18:00:00Z`, timeZone: CHI }],
				booked: [{ at: `${YEAR}-10-17T18:00:00Z`, timeZone: CHI }],
			});
			expect(text).toContain("Given Aug 29 · Booked Oct 17");
		});

		it("adds the year to a date from an earlier year", async () => {
			const text = await rowText({
				given: [{ at: `${YEAR - 3}-08-29T18:00:00Z`, timeZone: CHI }],
				booked: [],
			});
			expect(text).toContain(`Given Aug 29, ${YEAR - 3}`);
		});

		it("leaves this year's date without a year, even beside an older one", async () => {
			const text = await rowText({
				given: [
					{ at: `${YEAR}-08-29T18:00:00Z`, timeZone: CHI },
					{ at: `${YEAR - 3}-08-29T18:00:00Z`, timeZone: CHI },
				],
				booked: [],
			});
			expect(text).toContain("Given 2×, last Aug 29");
			expect(text).not.toContain(`Aug 29, ${YEAR}`);
		});

		it("renders no history text when there is none", async () => {
			const text = await rowText({ given: [], booked: [] });
			expect(text).not.toContain("Given");
			expect(text).not.toContain("Booked");
		});

		it("renders each date in its club's zone: 03:00Z on Aug 30 is Aug 29 in Los Angeles", async () => {
			const text = await rowText({
				given: [{ at: `${YEAR}-08-30T03:00:00Z`, timeZone: LA }],
				booked: [],
			});
			expect(text).toContain("Given Aug 29");
			expect(text).not.toContain("Aug 30");
		});

		it("exposes the history to a screen reader (no aria-hidden)", async () => {
			await rowText({
				given: [{ at: `${YEAR}-08-29T18:00:00Z`, timeZone: CHI }],
				booked: [],
			});
			const row = screen.getByRole("button", { name: /Given Aug 29/ });
			expect(
				row.querySelector("[aria-hidden='true']")?.textContent ?? "",
			).not.toContain("Given");
		});
	});
});
