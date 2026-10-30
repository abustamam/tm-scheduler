// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

import type { NavGrants } from "#/lib/nav-destinations";
import { KeyboardShortcuts } from "./keyboard-shortcuts";

const MEMBER: NavGrants = {
	hasOffice: false,
	isOfficer: false,
	isSuperadmin: false,
};
const OFFICER: NavGrants = { ...MEMBER, hasOffice: true, isOfficer: true };

function mount(grants = MEMBER, pathname = "/schedule") {
	return render(<KeyboardShortcuts grants={grants} pathname={pathname} />);
}
function press(key: string, target: Element = document.body, init = {}) {
	fireEvent.keyDown(target, { key, ...init });
}

beforeEach(() => {
	vi.useFakeTimers();
	window.matchMedia = ((q: string) => ({
		matches: false,
		media: q,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(() => {
	cleanup();
	navigate.mockReset();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("KeyboardShortcuts", () => {
	// protects=`g` then `r` within the window goes to /roster, and after 1.2s it does not; fails_when=the sequence has no window, or the window never closes; no_claim=the destination page renders
	it("g r navigates within 1s and not after 1.2s", () => {
		mount();
		press("g");
		act(() => {
			vi.advanceTimersByTime(500);
		});
		press("r");
		expect(navigate).toHaveBeenCalledWith({ to: "/roster" });

		navigate.mockReset();
		press("g");
		act(() => {
			vi.advanceTimersByTime(1200);
		});
		press("r");
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=a key that completes no sequence cancels it, so `g x r` does not navigate; fails_when=the pending `g` survives a non-matching key; no_claim=what x does
	it("a non-completing key cancels the sequence", () => {
		mount();
		press("g");
		press("x");
		press("r");
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=typing `g r` into a field stays typing; fails_when=isTypingTarget is not consulted; no_claim=contenteditable regions (covered by keyboard.test)
	it("ignores keys typed into an input", () => {
		mount();
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		press("g", input);
		press("r", input);
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=focus entering a field mid-sequence cancels it; fails_when=the pending `g` survives focusin on an input; no_claim=blur handling
	it("focus entering a typing target cancels a pending sequence", () => {
		mount();
		const input = document.createElement("input");
		document.body.appendChild(input);
		press("g");
		input.focus();
		input.blur();
		press("r");
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=a member holding no office cannot reach officer shortcuts and the sheet does not list them; fails_when=grants are not consulted by the listener or the list; no_claim=server-side authorization
	it("a member's g v does nothing and ? does not list it", () => {
		mount(MEMBER);
		press("g");
		press("v");
		press("n");
		expect(navigate).not.toHaveBeenCalled();
		press("?", document.body, { shiftKey: true });
		const dialog = screen.getByRole("dialog");
		expect(dialog.textContent).not.toContain("VP Education");
		expect(dialog.textContent).not.toContain("New meetings");
		expect(dialog.textContent).toContain("Roster");
	});

	// protects=an officer's `g v` and `n` go to their registry paths; fails_when=a path is retyped wrong or the grant is not honoured; no_claim=the route is reachable
	it("an officer's g v and n navigate", () => {
		mount(OFFICER);
		press("g");
		press("v");
		expect(navigate).toHaveBeenLastCalledWith({
			to: "/admin/vpe-dashboard",
		});
		press("n");
		expect(navigate).toHaveBeenLastCalledWith({ to: "/admin/meetings/new" });
	});

	// protects=`?` opens the sheet, Escape closes it, and the sheet lists exactly the active shortcuts plus Search; fails_when=an inactive shortcut is listed, an active one is missing, or Escape does not close; no_claim=the visual layout
	it("? opens the sheet listing exactly the active shortcuts; Escape closes", () => {
		mount(OFFICER);
		press("?", document.body, { shiftKey: true });
		const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
		const rows = Array.from(dialog.querySelectorAll("li")).map(
			(li) => li.textContent,
		);
		// 7 goto + new meetings + the sheet itself + Search
		expect(rows).toHaveLength(10);
		expect(rows.some((r) => r?.includes("VP Membership"))).toBe(true);
		expect(rows.some((r) => r?.includes("Search"))).toBe(true);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// protects=nothing fires while a dialog is open, and a sequence started before it is cancelled; fails_when=the open-dialog guard is missing; no_claim=Radix focus trapping
	it("does nothing while a dialog is open", () => {
		mount();
		press("g");
		const d = document.createElement("div");
		d.setAttribute("role", "dialog");
		d.setAttribute("data-state", "open");
		document.body.appendChild(d);
		press("r");
		d.remove();
		press("r");
		expect(navigate).not.toHaveBeenCalled();
		press("n");
		press("?", document.body, { shiftKey: true });
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	// protects=present mode keeps its own keys; fails_when=the listener runs on a /club/*/meeting/*/present route; no_claim=present-mode's own handlers
	it("is silent on the present route", () => {
		mount(OFFICER, "/club/c1/meeting/m1/present");
		press("g");
		press("r");
		press("n");
		press("?", document.body, { shiftKey: true });
		expect(navigate).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// protects=modifier combinations are left to the browser and search; fails_when=Ctrl+N or Cmd+G triggers a shortcut; no_claim=Shift behaviour
	it("ignores keys with Ctrl, Meta or Alt held", () => {
		mount(OFFICER);
		press("n", document.body, { ctrlKey: true });
		press("n", document.body, { metaKey: true });
		press("n", document.body, { altKey: true });
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=touch devices get no listener; fails_when=the coarse-pointer check is dropped; no_claim=hybrid devices
	it("is inert on a coarse pointer", () => {
		window.matchMedia = ((q: string) => ({
			matches: q.includes("coarse"),
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		mount(OFFICER);
		press("n");
		expect(navigate).not.toHaveBeenCalled();
	});
});
