// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchWorkspace } from "#/components/club/global-search";
import {
	destinationFor,
	NAV_DESTINATIONS,
	navGroup,
} from "#/lib/nav-destinations";
import {
	COMMON_TASKS,
	OFFICER_TASKS,
	officerTaskTitle,
} from "#/lib/officer-tasks";
import { OFFICER_POSITIONS } from "#/lib/officers";
import { crumbFor, navGroupStorageKey, SidebarNav } from "./app-shell";

// `app-shell.tsx` transitively imports server fns that pull in `#/db`, which
// throws at import without DATABASE_URL.
vi.mock("#/db", () => ({ db: {} }));

// A plain anchor stands in for the router's Link: these tests are about which
// entries render and which one is marked current, not about navigation.
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		children,
		className,
		"aria-current": ariaCurrent,
	}: {
		to: string;
		children: ReactNode;
		className?: string;
		"aria-current"?: "page";
	}) => (
		<a href={to} className={className} aria-current={ariaCurrent}>
			{children}
		</a>
	),
	useRouterState: () => "/",
	useNavigate: () => vi.fn(),
}));

const MEMBER = { hasOffice: false, isOfficer: false, isSuperadmin: false };
const ADMIN_NO_OFFICE = {
	hasOffice: false,
	isOfficer: true,
	isSuperadmin: false,
};
const OFFICE_HOLDER = { hasOffice: true, isOfficer: true, isSuperadmin: false };
const EVERYTHING = { hasOffice: true, isOfficer: true, isSuperadmin: true };
const SETUP_KEY = navGroupStorageKey("setup");

function renderNav(grants = OFFICE_HOLDER, pathname = "/roster") {
	return render(<SidebarNav grants={grants} pathname={pathname} />);
}

/** Links the reader can actually see: a collapsed group's are `hidden`. */
function visibleLinkLabels(): string[] {
	return screen.queryAllByRole("link").map((a) => a.textContent ?? "");
}

function setupToggle() {
	return screen.getByRole("button", { name: /setup/i });
}

beforeEach(() => {
	window.localStorage.clear();
});
afterEach(() => {
	cleanup();
});

describe("sidebar per role", () => {
	it("shows an office holder Meetings then Officers, 11 items, Setup collapsed", () => {
		renderNav(OFFICE_HOLDER);
		expect(visibleLinkLabels()).toEqual([
			"Sign-up sheet",
			"Next meeting",
			"Past meetings",
			"Roster",
			"Activity",
			"Officer home",
			"VP Education",
			"VP Membership",
			"DCP scoreboard",
			"Dues",
			"Action items",
			"My dashboard",
			"My roles",
			"Resources",
		]);
		expect(setupToggle().getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("Platform")).toBeNull();
	});

	it("shows an admin with no office 10 items: no Officer home", () => {
		renderNav(ADMIN_NO_OFFICE);
		const labels = visibleLinkLabels();
		expect(labels).not.toContain("Officer home");
		expect(labels.slice(0, 10)).toContain("Action items");
		expect(labels).toHaveLength(13);
	});

	it("shows a plain member Meetings and Me, with no empty group headers", () => {
		renderNav(MEMBER);
		expect(screen.getByText("Meetings")).toBeTruthy();
		expect(screen.getByText("Me")).toBeTruthy();
		expect(screen.queryByText("Officers")).toBeNull();
		expect(screen.queryByRole("button", { name: /setup/i })).toBeNull();
		expect(screen.queryByText("Platform")).toBeNull();
		expect(visibleLinkLabels()).toHaveLength(8);
	});

	it("adds Platform for a superadmin", () => {
		renderNav(EVERYTHING);
		expect(screen.getByText("Platform")).toBeTruthy();
		expect(visibleLinkLabels()).toContain("Duplicate people");
	});
});

describe("collapsible Setup", () => {
	it("is collapsed on first load, and its panel is what aria-controls names", () => {
		renderNav();
		const toggle = setupToggle();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		const panel = document.getElementById(
			toggle.getAttribute("aria-controls") ?? "",
		);
		expect(panel).not.toBeNull();
		expect(panel?.hidden).toBe(true);
		expect(visibleLinkLabels()).not.toContain("Meeting roles");
	});

	it("remembers the open/closed choice across a reload", async () => {
		const first = renderNav();
		await userEvent.click(setupToggle());
		expect(setupToggle().getAttribute("aria-expanded")).toBe("true");
		expect(window.localStorage.getItem(SETUP_KEY)).toBe("1");
		expect(visibleLinkLabels()).toContain("Meeting roles");
		first.unmount();

		// A fresh mount reads storage after hydration.
		renderNav();
		expect(setupToggle().getAttribute("aria-expanded")).toBe("true");

		await userEvent.click(setupToggle());
		expect(window.localStorage.getItem(SETUP_KEY)).toBe("0");
		expect(setupToggle().getAttribute("aria-expanded")).toBe("false");
	});

	it("is forced open on one of its pages, whatever is stored, and writes nothing", async () => {
		window.localStorage.setItem(SETUP_KEY, "0");
		const setItem = vi.spyOn(Storage.prototype, "setItem");
		try {
			renderNav(OFFICE_HOLDER, "/admin/roles");
			const toggle = setupToggle();
			expect(toggle.getAttribute("aria-expanded")).toBe("true");
			expect(visibleLinkLabels()).toContain("Meeting roles");
			await userEvent.click(toggle);
			expect(toggle.getAttribute("aria-expanded")).toBe("true");
			expect(setItem).not.toHaveBeenCalled();
			expect(window.localStorage.getItem(SETUP_KEY)).toBe("0");
		} finally {
			setItem.mockRestore();
		}
	});

	it("still renders when storage throws", () => {
		const getItem = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("blocked");
			});
		try {
			renderNav();
			expect(setupToggle().getAttribute("aria-expanded")).toBe("false");
		} finally {
			getItem.mockRestore();
		}
	});
});

describe("merged entries", () => {
	it("highlights New meetings on the batch page, titled Setup · New meetings", () => {
		renderNav(OFFICE_HOLDER, "/admin/meetings/batch");
		const current = screen
			.getAllByRole("link")
			.filter((a) => a.getAttribute("aria-current") === "page");
		expect(current.map((a) => a.textContent)).toEqual(["New meetings"]);
		expect(crumbFor("/admin/meetings/batch")).toBe("Setup · New meetings");
	});

	it("highlights Pathways sync on the manual paste page", () => {
		renderNav(OFFICE_HOLDER, "/admin/pathways-sync");
		const current = screen
			.getAllByRole("link")
			.filter((a) => a.getAttribute("aria-current") === "page");
		expect(current.map((a) => a.textContent)).toEqual(["Pathways sync"]);
		expect(crumbFor("/admin/pathways-sync")).toBe("Setup · Pathways sync");
	});
});

describe("crumbFor on pages that are not nav destinations", () => {
	it("keeps its own arms", () => {
		expect(crumbFor("/members/abc")).toBe("Roster · Member profile");
		expect(crumbFor("/meetings/abc")).toBe("Meetings · Meeting");
		expect(crumbFor("/club/c1/meeting/m1")).toBe("Meetings · Meeting");
		expect(crumbFor("/meetings")).toBe("Meetings · Past meetings");
		expect(crumbFor("/superadmin/club-1")).toBe("Platform · Superadmin");
		expect(crumbFor("/admin")).toBe("Setup · Admin");
		expect(crumbFor("/somewhere")).toBe("Workspace");
	});
});

describe("one label everywhere (#911)", () => {
	const officerCards = [
		...COMMON_TASKS,
		...OFFICER_POSITIONS.flatMap((p) => OFFICER_TASKS[p]),
	];

	for (const d of NAV_DESTINATIONS) {
		it(`${d.key}: sidebar, crumb, search and Officer home agree on "${d.label}"`, async () => {
			// Sidebar. On its own page a Setup entry is forced open, so it is
			// visible without touching storage.
			renderNav(EVERYTHING, d.to);
			const link = screen
				.getAllByRole("link")
				.find((a) => a.getAttribute("href") === d.to);
			expect(link?.textContent).toBe(d.label);
			expect(link?.getAttribute("aria-current")).toBe("page");

			// Page title suffix.
			expect(crumbFor(d.to)).toBe(`${navGroup(d.group).label} · ${d.label}`);

			// Global search.
			const hits = searchWorkspace(d.label, [], EVERYTHING).pages;
			expect(hits.find((p) => p.to === d.to)?.label).toBe(d.label);

			// Officer home: every card pointing at this entry is titled with it.
			for (const card of officerCards) {
				if (destinationFor(card.to)?.key === d.key) {
					expect(officerTaskTitle(card)).toBe(d.label);
				}
			}
		});
	}

	it("covers every destination: a superadmin with Setup open sees them all", () => {
		window.localStorage.setItem(SETUP_KEY, "1");
		renderNav(EVERYTHING, "/");
		expect(visibleLinkLabels()).toHaveLength(NAV_DESTINATIONS.length);
	});
});
