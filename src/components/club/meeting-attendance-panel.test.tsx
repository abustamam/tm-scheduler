// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAttendancePanel } from "./meeting-attendance-panel";

const roster = [
	{
		id: "m1",
		name: "Ayesha Khan",
		preferredName: null,
		phone: "+15551234567",
		email: null,
	},
	{ id: "m2", name: "Bo Lin", preferredName: null, phone: null, email: null },
];

function renderPanel(
	over: Partial<Parameters<typeof MeetingAttendancePanel>[0]> = {},
) {
	const props = {
		roster,
		plan: [],
		rungOverride: {},
		roleByMemberId: {},
		meetingDate: "Tue 19 Aug",
		shareUrl: "https://club.example/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		...over,
	};
	return { props, ...render(<MeetingAttendancePanel {...props} />) };
}

describe("MeetingAttendancePanel (plan mode)", () => {
	afterEach(() => cleanup());

	it("lists the whole roster with its counts line", () => {
		const { getByText } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		expect(getByText("Ayesha Khan")).toBeTruthy();
		expect(getByText("Bo Lin")).toBeTruthy();
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("sets a rung through the row's dropdown", async () => {
		const { props, getByRole, findByRole } = renderPanel();
		// Radix's DropdownMenuTrigger opens on `pointerdown`/`onKeyDown`, not
		// `click` (verified against @radix-ui/react-dropdown-menu's source) — a
		// bare `fireEvent.click` dispatches only a "click" MouseEvent and never
		// opens it. `userEvent.click` replays the real pointer sequence, matching
		// how every other Radix-trigger test in this repo opens one (e.g.
		// meeting-export-menu.test.tsx, meeting-toolbar.test.tsx). The menu ITEM
		// click below stays `fireEvent.click`: Radix's MenuItem selects on a
		// plain `onClick`, so the simpler event suffices there.
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "Coming" }));
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", "coming");
	});

	it("clears back to no answer through the same menu", async () => {
		const { props, getByRole, findByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "No answer" }));
		// Clearing is a DELETE, not a fourth status — the row's absence is the
		// only encoding of "no answer". `null` is how the single writer says so.
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", null);
	});

	it("disables the chips on a locked meeting rather than hiding them", () => {
		// Spec, Error handling: a control that vanishes reads as a bug; a disabled
		// one reads as "not now".
		const { getByRole } = renderPanel({ locked: true });
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("offers a WhatsApp draft when a phone is on file, and says so when not", () => {
		const { getByText, getAllByRole } = renderPanel();
		expect(getAllByRole("link").length).toBeGreaterThan(0);
		expect(getByText(/No contact on file/i)).toBeTruthy();
	});

	it("shows the role a member holds", () => {
		const { getByText } = renderPanel({ roleByMemberId: { m2: "Timer" } });
		expect(getByText("Timer")).toBeTruthy();
	});

	it("renders the optimistic override, not the server value", () => {
		// The whole point of the optimistic path: the chip changes on tap, before
		// any server round trip. Rendering `plan` here would show the stale rung
		// and the officer would tap twice.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "not_coming" as const }],
			rungOverride: { m1: "coming" as const },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("Coming");
	});

	it("treats an override of null as cleared, not as absent", () => {
		// `null` and "no key" are different states and `??` cannot tell them
		// apart — an optimistic CLEAR would fall through to the server's old rung
		// and the chip would appear not to have changed.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
			rungOverride: { m1: null },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("—");
	});

	it("counts and sorts on the optimistic state too", () => {
		// Otherwise the counts line disagrees with the chips for a beat, and the
		// row jumps to its new bucket only after the refetch.
		const { getByText } = renderPanel({
			plan: [],
			rungOverride: { m1: "coming" as const },
		});
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("collapses to the counts line below lg, and expands on tap", () => {
		// Spec D4: in plan mode on mobile the panel renders collapsed, so a
		// 15-person roster does not push the agenda off screen. The rows are
		// absent from the DOM when collapsed rather than merely hidden — a
		// `hidden` class is invisible to this assertion and to a screen reader.
		//
		// jsdom's default `window.innerWidth` (1024) IS the `lg` breakpoint, so
		// without setting it below that, this environment reads as desktop —
		// which is also why every other test in this file (none of which touch
		// `innerWidth`) can assert row content with no expand click: the panel is
		// correctly always-expanded at that width. This is the one test that is
		// actually about the mobile case, so it is the one that has to say so.
		const originalWidth = window.innerWidth;
		window.innerWidth = 500;
		try {
			const { getByRole, queryByText, getByText } = renderPanel();
			expect(getByText("2 no answer")).toBeTruthy();
			expect(queryByText("Ayesha Khan")).toBeNull();
			fireEvent.click(getByRole("button", { name: /show|expand/i }));
			expect(getByText("Ayesha Khan")).toBeTruthy();
		} finally {
			window.innerWidth = originalWidth;
		}
	});
});
