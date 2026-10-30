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
// app-shell.tsx pulls in server fns that import `#/db`, which throws without DATABASE_URL.
vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", () => ({
	// A plain anchor that keeps `title`, the one attribute the sidebar test reads.
	Link: ({
		to,
		children,
		title,
	}: {
		to: string;
		children: ReactNode;
		title?: string;
	}) => (
		<a href={to} title={title}>
			{children}
		</a>
	),
	useNavigate: () => navigate,
	useRouterState: () => "/",
}));

import type { ReactNode } from "react";
import { SidebarNav } from "#/components/app-shell";
import { type NavGrants, visibleDestinations } from "#/lib/nav-destinations";
import { activeShortcuts, SHORTCUTS } from "#/lib/shortcuts";
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

	// protects=`?` opens the sheet, Escape closes it, and the rendered rows are exactly the active shortcuts' labels plus the two Search rows, for an officer and a member; fails_when=an inactive shortcut is listed, an active one is missing, or Escape does not close; no_claim=the visual layout
	it.each([
		["an officer", OFFICER],
		["a member", MEMBER],
	])("? opens the sheet listing exactly the active shortcuts for %s; Escape closes", (_who, grants) => {
		mount(grants);
		press("?", document.body, { shiftKey: true });
		const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
		const labels = Array.from(dialog.querySelectorAll("li"))
			.map((li) => li.querySelector("span")?.textContent)
			.sort();
		const expected = [
			...activeShortcuts(grants).map((s) => s.label),
			"Search",
			"Search",
		].sort();
		expect(labels).toEqual(expected);
		fireEvent.keyDown(dialog, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// protects=the sheet shows `/` and the platform's own modifier for Search; fails_when=the hint is hardcoded to the other platform or `/` is dropped; no_claim=the keys open search (app-shell-search-shortcut.test)
	it("shows `/` and the platform modifier for Search", () => {
		const nav = vi.spyOn(window.navigator, "platform", "get");
		nav.mockReturnValue("Linux x86_64");
		mount();
		press("?", document.body, { shiftKey: true });
		const text = screen.getByRole("dialog").textContent ?? "";
		expect(text).toContain("Ctrl");
		expect(text).not.toContain("⌘");
		expect(text).toContain("/");
		nav.mockRestore();
	});

	// protects=a dialog opening and closing by mouse between `g` and `r` still cancels the sequence; fails_when=only keys pressed while a dialog is open cancel it; no_claim=Radix itself
	it("a dialog opened and closed after g cancels the sequence", async () => {
		mount();
		press("g");
		const d = document.createElement("div");
		d.setAttribute("role", "dialog");
		d.setAttribute("data-state", "open");
		document.body.appendChild(d);
		await act(async () => {});
		d.remove();
		await act(async () => {});
		press("r");
		expect(navigate).not.toHaveBeenCalled();
	});

	// protects=the early return for an already-handled, composing or auto-repeating key; fails_when=any of the three checks is deleted; no_claim=Shift or modifier handling
	it("ignores a defaultPrevented, composing or repeating key", () => {
		mount(OFFICER);
		const prevented = new KeyboardEvent("keydown", {
			key: "n",
			bubbles: true,
			cancelable: true,
		});
		prevented.preventDefault();
		document.body.dispatchEvent(prevented);
		press("n", document.body, { isComposing: true });
		press("n", document.body, { repeat: true });
		expect(navigate).not.toHaveBeenCalled();
		press("n");
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	// protects=a bare Shift press neither completes nor cancels a pending `g`; fails_when=the Shift early return is deleted; no_claim=Shift+/ producing `?`
	it("a bare Shift press does not cancel a pending sequence", () => {
		mount();
		press("g");
		press("Shift", document.body, { shiftKey: true });
		press("r");
		expect(navigate).toHaveBeenCalledWith({ to: "/roster" });
	});

	// protects=every shortcut's keys appear in its sidebar entry's title ("Roster (g r)") and an entry with none shows the bare label, rendered by the real SidebarNav; fails_when=NavItem stops using sidebarTitle or the registry and sidebar disagree; no_claim=tooltip appearance
	it("sidebar entries carry their shortcut in the title", () => {
		const { container } = render(
			<SidebarNav grants={OFFICER} pathname="/schedule" />,
		);
		const titles = new Map(
			Array.from(container.querySelectorAll("a")).map((a) => [
				a.textContent?.trim(),
				a.getAttribute("title"),
			]),
		);
		const withShortcut = new Set<string>();
		for (const sc of activeShortcuts(OFFICER)) {
			if (!sc.to) continue;
			withShortcut.add(sc.label);
			expect(titles.get(sc.label)).toBe(`${sc.label} (${sc.keys})`);
		}
		expect(titles.get("Roster")).toBe("Roster (g r)");
		const bare = visibleDestinations(OFFICER).filter(
			(d) => !SHORTCUTS.some((sc) => sc.to === d.key),
		);
		expect(bare.length).toBeGreaterThan(0);
		for (const d of bare) expect(titles.get(d.label)).toBe(d.label);
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
