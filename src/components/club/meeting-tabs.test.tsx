// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingTab } from "#/lib/meeting-hub";
import { MeetingTabs } from "./meeting-tabs";

const ALL: MeetingTab[] = ["roles", "attendance", "ballots", "minutes"];

function panels() {
	return {
		roles: (
			<div>
				<p id="slot-abc">a role slot</p>
				<p>roles body</p>
			</div>
		),
		attendance: <p>attendance body</p>,
		ballots: <p>ballots body</p>,
		minutes: (
			<div id="minutes">
				<textarea aria-label="notes" />
			</div>
		),
	};
}

function panel(container: HTMLElement, tab: string) {
	return container.querySelector<HTMLElement>(
		`[data-meeting-tab-panel="${tab}"]`,
	);
}

function visibleTabs(container: HTMLElement) {
	return ALL.filter((t) => {
		const el = panel(container, t);
		return el?.dataset.state === "active";
	});
}

beforeEach(() => {
	window.history.replaceState(null, "", "/");
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("MeetingTabs (#1582)", () => {
	it("renders no tab bar when Roles is the only tab", () => {
		// protects=a plain member's page reads as it did; fails_when=a lone Roles
		// tab still draws a bar; no_claim=says nothing about which viewers get one tab
		const { queryByRole, getByText } = render(
			<MeetingTabs
				tabs={["roles"]}
				active="roles"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(queryByRole("tablist")).toBeNull();
		expect(getByText("roles body")).toBeTruthy();
	});

	it("labels the offered tabs Roles, Attendance, Ballots, Minutes in order", () => {
		// protects=the exact labels and fixed order; fails_when=a label is renamed
		// or the order changes; no_claim=does not measure whether they fit at 375px
		const { getAllByRole } = render(
			<MeetingTabs
				tabs={ALL}
				active="roles"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(getAllByRole("tab").map((t) => t.textContent)).toEqual([
			"Roles",
			"Attendance",
			"Ballots",
			"Minutes",
		]);
	});

	it("shows only the active tab's panel on the first render and keeps the others mounted", () => {
		// protects=the named tab is the visible one from the first render;
		// fails_when=another panel is visible or an inactive one is unmounted;
		// no_claim=says nothing about the URL
		const { container, getByText } = render(
			<MeetingTabs
				tabs={ALL}
				active="ballots"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["ballots"]);
		// still in the DOM:
		expect(getByText("roles body")).toBeTruthy();
		expect(getByText("attendance body")).toBeTruthy();
	});

	it("calls onSelect with the chosen tab", () => {
		const onSelect = vi.fn();
		const { getByRole } = render(
			<MeetingTabs
				tabs={ALL}
				active="roles"
				onSelect={onSelect}
				panels={panels()}
			/>,
		);
		fireEvent.mouseDown(getByRole("tab", { name: "Attendance" }));
		fireEvent.click(getByRole("tab", { name: "Attendance" }));
		expect(onSelect).toHaveBeenCalledWith("attendance");
	});

	it("keeps text typed in the minutes editor across a switch away and back", () => {
		// protects=unsaved minutes text survives a tab switch; fails_when=inactive
		// panels unmount; no_claim=says nothing about the real minutes editor
		const { getByRole, getByLabelText } = render(
			<MeetingTabs
				tabs={ALL}
				active="minutes"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		const notes = getByLabelText("notes") as HTMLTextAreaElement;
		fireEvent.change(notes, { target: { value: "draft minutes" } });
		for (const name of ["Roles", "Minutes"]) {
			fireEvent.mouseDown(getByRole("tab", { name }));
			fireEvent.click(getByRole("tab", { name }));
		}
		expect((getByLabelText("notes") as HTMLTextAreaElement).value).toBe(
			"draft minutes",
		);
	});

	it("falls back to Roles when the tab is not offered", () => {
		const { container } = render(
			<MeetingTabs
				tabs={["roles", "minutes"]}
				active="roles"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["roles"]);
	});

	it("follows the URL when the active tab changes", () => {
		function Harness() {
			const [active, setActive] = useState<MeetingTab>("roles");
			return (
				<>
					<button type="button" onClick={() => setActive("attendance")}>
						go
					</button>
					<MeetingTabs
						tabs={ALL}
						active={active}
						onSelect={() => {}}
						panels={panels()}
					/>
				</>
			);
		}
		const { container, getByText } = render(<Harness />);
		fireEvent.click(getByText("go"));
		expect(visibleTabs(container)).toEqual(["attendance"]);
	});

	it("hydrating HTML rendered for another tab ends on the live tab", async () => {
		// protects=cached HTML rendered for ?tab=attendance, hydrated at a URL that
		// names Roles, ends showing Roles; fails_when=the post-mount reconcile is
		// dropped (React does not patch attributes on hydration, so the stale
		// panel would stay); no_claim=a real browser or service worker
		const html = renderToString(
			<MeetingTabs
				tabs={ALL}
				active="attendance"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		const host = document.createElement("div");
		host.innerHTML = html;
		document.body.appendChild(host);
		expect(visibleTabs(host)).toEqual(["attendance"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let root: ReturnType<typeof hydrateRoot> | undefined;
		await act(async () => {
			root = hydrateRoot(
				host,
				<MeetingTabs
					tabs={ALL}
					active="roles"
					onSelect={() => {}}
					panels={panels()}
				/>,
			);
		});
		errors.mockRestore();
		expect(visibleTabs(host)).toEqual(["roles"]);
		await act(async () => root?.unmount());
		host.remove();
	});

	it("a #minutes fragment activates Minutes and scrolls to it", () => {
		// protects=the toolbar's #minutes link works now Minutes is a tab; the
		// fragment's tab beats `active`; fails_when=the hash is ignored;
		// no_claim=real browser scrolling
		window.history.replaceState(null, "", "/#minutes");
		const { container } = render(
			<MeetingTabs
				tabs={ALL}
				active="attendance"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["minutes"]);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});

	it("a hashchange to #slot-<id> from another tab shows Roles", async () => {
		const { container } = render(
			<MeetingTabs
				tabs={ALL}
				active="attendance"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["attendance"]);
		await act(async () => {
			window.history.replaceState(null, "", "/#slot-abc");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(visibleTabs(container)).toEqual(["roles"]);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});

	it("ignores a fragment that names nothing inside a panel", () => {
		window.history.replaceState(null, "", "/#nowhere");
		const { container } = render(
			<MeetingTabs
				tabs={ALL}
				active="ballots"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["ballots"]);
	});
});
