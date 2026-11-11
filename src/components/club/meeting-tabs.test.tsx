// @vitest-environment jsdom
import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
	useLocation,
	useSearch,
} from "@tanstack/react-router";
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
		// protects=a tab click reports the chosen tab to the route (which writes it
		// to the URL); fails_when=onSelect is not called or gets another tab;
		// no_claim=says nothing about the URL write itself
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
		// protects=a URL naming a tab this viewer is not offered (`?tab=ballots` for
		// a plain member) shows Roles, on the first render and after the post-mount
		// reconcile; fails_when=the fallback is dropped from either; no_claim=says
		// nothing about which tabs a viewer is offered
		const { container } = render(
			<MeetingTabs
				tabs={["roles", "minutes"]}
				active="ballots"
				onSelect={() => {}}
				panels={panels()}
			/>,
		);
		expect(visibleTabs(container)).toEqual(["roles"]);
	});

	it("follows the URL when the active tab changes", () => {
		// protects=back/forward and links that change `?tab=` move the visible
		// panel; fails_when=`active` is read once and never again; no_claim=says
		// nothing about how the URL changes
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
		// the roving tabindex follows the live tab too
		expect(
			[...host.querySelectorAll<HTMLElement>('[role="tab"]')].map(
				(t) => t.tabIndex,
			),
		).toEqual([0, -1, -1, -1]);
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
		// protects=a hand-edited or back/forward fragment into a role slot reveals
		// Roles; fails_when=the hashchange listener is dropped; no_claim=an in-app
		// link (the router test below)
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
		// protects=a stray fragment does not switch tabs; fails_when=an unknown
		// fragment is treated as an owner; no_claim=says nothing about scrolling
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

	it("follows an in-app router navigation that sets a hash after mount", async () => {
		// protects=the toolbar's Minutes button (`<Link to="." hash="minutes">`, a
		// pushState that fires NO hashchange) activates Minutes and scrolls to it;
		// fails_when=the shell reads the fragment only on mount and on hashchange,
		// or the `hash` prop is no longer followed; no_claim=that the route passes
		// the hash (meeting-tabs-wiring.guard.test.ts pins that) or real scrolling
		function Page() {
			// The same read the meeting route makes.
			const hash = useLocation({ select: (l) => l.hash });
			return (
				<MeetingTabs
					tabs={ALL}
					active="roles"
					onSelect={() => {}}
					hash={hash}
					panels={panels()}
				/>
			);
		}
		const root = createRootRoute({ component: Page });
		const index = createRoute({ getParentRoute: () => root, path: "/" });
		const router = createRouter({
			routeTree: root.addChildren([index]),
			history: createMemoryHistory({ initialEntries: ["/"] }),
		});
		await router.load();
		const { container } = render(<RouterProvider router={router} />);
		await act(async () => {});
		expect(visibleTabs(container)).toEqual(["roles"]);
		(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
		let hashchanges = 0;
		const count = () => hashchanges++;
		window.addEventListener("hashchange", count);
		await act(async () => {
			await router.navigate({ to: "/", hash: "minutes" });
		});
		window.removeEventListener("hashchange", count);
		expect(hashchanges, "memory history fires no hashchange").toBe(0);
		expect(visibleTabs(container)).toEqual(["minutes"]);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});
	// A router whose page reads `?tab=` and the hash as the meeting route does.
	async function mountRouter(
		initial: string,
		onSelect: (tab: MeetingTab, router: AnyRouter) => void = () => {},
	) {
		const holder: { router?: AnyRouter } = {};
		function Page() {
			const search = useSearch({ strict: false }) as { tab?: string };
			const hash = useLocation({ select: (l) => l.hash });
			const active = (search.tab as MeetingTab | undefined) ?? "roles";
			return (
				<MeetingTabs
					tabs={ALL}
					active={active}
					onSelect={(tab) => holder.router && onSelect(tab, holder.router)}
					hash={hash}
					panels={panels()}
				/>
			);
		}
		const root = createRootRoute({ component: Page });
		const index = createRoute({
			getParentRoute: () => root,
			path: "/",
			validateSearch: (s: Record<string, unknown>) =>
				typeof s.tab === "string" ? { tab: s.tab } : {},
		});
		const router = createRouter({
			routeTree: root.addChildren([index]),
			history: createMemoryHistory({ initialEntries: [initial] }),
		});
		holder.router = router;
		await router.load();
		const { container } = render(<RouterProvider router={router} />);
		await act(async () => {});
		return { router, container };
	}

	it("a hash-only navigation that drops ?tab= from a non-Roles tab still shows Minutes", async () => {
		// protects=the toolbar's Minutes button clicked from Ballots (the link drops
		// `search`, so `active` goes ballots -> roles while `hash` goes "" ->
		// minutes) ends on Minutes, not Roles (#1597); fails_when=the [active] sync
		// overwrites the fragment's tab; no_claim=real browser or scrolling
		const { router, container } = await mountRouter("/?tab=ballots");
		expect(visibleTabs(container)).toEqual(["ballots"]);
		await act(async () => {
			await router.navigate({ to: "/", hash: "minutes", search: {} });
		});
		expect(visibleTabs(container)).toEqual(["minutes"]);
	});

	it("a tab click after landing a fragment shows the clicked tab even though the hash stays", async () => {
		// protects=the tab-click clears the fragment claim; fails_when=the claim
		// outlives a click and pins Minutes while the URL says Attendance
		const { router, container } = await mountRouter(
			"/?tab=ballots",
			(tab, r) => {
				void r.navigate({ to: "/", hash: "minutes", search: { tab } });
			},
		);
		await act(async () => {
			await router.navigate({ to: "/", hash: "minutes", search: {} });
		});
		expect(visibleTabs(container)).toEqual(["minutes"]);
		await act(async () => {
			fireEvent.mouseDown(
				container.querySelector('[data-tab="attendance"]') as HTMLElement,
			);
			fireEvent.click(
				container.querySelector('[data-tab="attendance"]') as HTMLElement,
			);
		});
		expect(visibleTabs(container)).toEqual(["attendance"]);
	});

	it("Back from a landed fragment to ?tab=ballots follows the URL, not the old claim", async () => {
		// protects=a claim whose hash moved on is ignored; fails_when=the claim is
		// matched without comparing it with the live hash
		const { router, container } = await mountRouter("/?tab=ballots");
		await act(async () => {
			await router.navigate({ to: "/", hash: "minutes", search: {} });
		});
		expect(visibleTabs(container)).toEqual(["minutes"]);
		await act(async () => {
			router.history.back();
		});
		expect(visibleTabs(container)).toEqual(["ballots"]);
	});

	it("a native hashchange claim does not hold its tab across a fragment-less ?tab= link", async () => {
		// protects=the claim is keyed on the fragment, so one recorded from the
		// window (address-bar edit, plain <a href="#...">) never matches the empty
		// hash of a later fragment-less URL; fails_when=the claim is stored as ""
		const { router, container } = await mountRouter("/?tab=attendance");
		await act(async () => {
			window.history.replaceState(null, "", "/#slot-abc");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(visibleTabs(container)).toEqual(["roles"]);
		await act(async () => {
			await router.navigate({ to: "/", search: { tab: "ballots" } });
		});
		expect(visibleTabs(container)).toEqual(["ballots"]);
	});
});
