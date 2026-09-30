// @vitest-environment jsdom
//
// Render tests for the role guide (#933): which halves render, which start
// open, the description fallback, the PDF link, and the roles guide's anchor.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { roleSeed } from "#/lib/role-template";
import {
	guideOpenState,
	RoleGuideItem,
	RoleGuideSections,
} from "./role-guide-sections";

afterEach(cleanup);

const FULL = {
	description: "Keeps time.",
	before: "Check the agenda.\nBring the lights.",
	during: "Time everyone.",
};

function details(label: string): HTMLDetailsElement {
	const summary = screen.getByText(label, { selector: "summary" });
	return summary.closest("details") as HTMLDetailsElement;
}

describe("guideOpenState (#933 decision 4)", () => {
	it("opens Before ahead of the day, During on the day, neither after", () => {
		expect(guideOpenState("upcoming")).toEqual({ before: true, during: false });
		expect(guideOpenState("today")).toEqual({ before: false, during: true });
		expect(guideOpenState("completed")).toEqual({
			before: false,
			during: false,
		});
	});

	it("collapses both for a cancelled meeting", () => {
		expect(guideOpenState("upcoming", true)).toEqual({
			before: false,
			during: false,
		});
	});
});

describe("RoleGuideSections, collapsible", () => {
	it("starts each half in the state it is given", () => {
		render(
			<RoleGuideSections
				guide={FULL}
				open={{ before: false, during: true }}
				showDescriptionFallback
			/>,
		);
		expect(details("Before the meeting").open).toBe(false);
		expect(details("During the meeting").open).toBe(true);
	});

	it("lets the member open a collapsed half", async () => {
		render(
			<RoleGuideSections
				guide={FULL}
				open={{ before: false, during: false }}
				showDescriptionFallback
			/>,
		);
		await userEvent.click(
			screen.getByText("Before the meeting", { selector: "summary" }),
		);
		expect(details("Before the meeting").open).toBe(true);
	});

	it("renders one step per line", () => {
		render(
			<RoleGuideSections
				guide={FULL}
				open={{ before: true, during: true }}
				showDescriptionFallback
			/>,
		);
		const before = details("Before the meeting");
		expect(
			within(before)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["Check the agenda.", "Bring the lights."]);
	});
});

describe("RoleGuideSections, empty halves", () => {
	it("renders no header for a blank half", () => {
		render(
			<RoleGuideSections
				guide={{ ...FULL, before: null }}
				open={{ before: true, during: true }}
				showDescriptionFallback
			/>,
		);
		expect(screen.queryByText("Before the meeting")).toBeNull();
		expect(screen.getByText("During the meeting")).toBeTruthy();
	});

	it("falls back to the description with no headers at all", () => {
		render(
			<RoleGuideSections
				guide={{
					description: "Hosts the meeting.",
					before: null,
					during: null,
				}}
				open={{ before: true, during: false }}
				showDescriptionFallback
			/>,
		);
		expect(screen.getByText("Hosts the meeting.")).toBeTruthy();
		expect(screen.queryByText("Before the meeting")).toBeNull();
		expect(screen.queryByText("During the meeting")).toBeNull();
	});

	it("renders nothing when there is nothing to show", () => {
		const { container } = render(
			<RoleGuideSections
				guide={{ description: null, before: null, during: null }}
				showDescriptionFallback
				className="ruled"
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("does not repeat the description where the surface already shows it", () => {
		const { container } = render(
			<RoleGuideSections
				guide={{ description: "Hosts.", before: null, during: null }}
				showDescriptionFallback={false}
			/>,
		);
		expect(container.innerHTML).toBe("");
	});
});

describe("RoleGuideSections, the PDF script link", () => {
	const sheet = { href: "/role-sheets/timer.pdf", title: "Timer's log" };

	it("ends the During half", () => {
		render(
			<RoleGuideSections
				guide={FULL}
				sheet={sheet}
				open={{ before: true, during: true }}
				showDescriptionFallback
			/>,
		);
		const link = within(details("During the meeting")).getByRole("link", {
			name: "Full script (PDF): Timer's log",
		});
		expect(link.getAttribute("href")).toBe("/role-sheets/timer.pdf");
	});

	it("still appears when the role has no During text", () => {
		render(
			<RoleGuideSections
				guide={{ description: "D", before: null, during: null }}
				sheet={sheet}
				showDescriptionFallback
			/>,
		);
		expect(
			screen.getByRole("link", { name: /Full script \(PDF\)/ }),
		).toBeTruthy();
	});

	it("is absent without a sheet", () => {
		render(
			<RoleGuideSections
				guide={FULL}
				open={{ before: true, during: true }}
				showDescriptionFallback
			/>,
		);
		expect(screen.queryByRole("link", { name: /Full script/ })).toBeNull();
	});
});

describe("RoleGuideItem (the public roles guide)", () => {
	it("anchors the card on the role key, with both halves as open headings", () => {
		const tmod = roleSeed("Toastmaster of the Day");
		const { container } = render(
			<ul>
				<RoleGuideItem role={{ ...tmod, id: "r1" }} />
			</ul>,
		);
		const li = container.querySelector("li");
		expect(li?.id).toBe("toastmaster-of-the-day");
		expect(
			screen.getByRole("heading", { level: 4, name: "Before the meeting" }),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { level: 4, name: "During the meeting" }),
		).toBeTruthy();
		// No collapsing on the reference page.
		expect(container.querySelector("details")).toBeNull();
		expect(
			screen
				.getByRole("link", { name: /Full script \(PDF\)/ })
				.getAttribute("href"),
		).toBe("/role-sheets/toastmaster.pdf");
	});

	it("shows a custom role's description once, and no guide headers or link", () => {
		const { container } = render(
			<ul>
				<RoleGuideItem
					role={{
						id: "r2",
						name: "Zoom Host",
						key: "zoom_host",
						description: "Runs the call.",
						beforeNotes: null,
						duringNotes: null,
					}}
				/>
			</ul>,
		);
		expect(container.querySelector("li")?.id).toBe("zoom-host");
		expect(screen.getAllByText("Runs the call.")).toHaveLength(1);
		expect(screen.queryByText("Before the meeting")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("gives a key-less role no anchor", () => {
		const { container } = render(
			<ul>
				<RoleGuideItem
					role={{ id: "r3", name: "Old role", key: null, description: null }}
				/>
			</ul>,
		);
		expect(container.querySelector("li")?.hasAttribute("id")).toBe(false);
	});
});
