// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GlobalSearch,
	type GlobalSearchHandle,
	searchWorkspace,
} from "./global-search";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
}));

vi.mock("#/server/members", () => ({
	listMembers: vi.fn().mockResolvedValue([
		{ id: "m1", name: "Faisal", officerPositions: [] },
		{ id: "m2", name: "Mahbuba", officerPositions: ["vp_education"] },
	]),
}));

const NOBODY = { hasOffice: false, isOfficer: false, isSuperadmin: false };
const OFFICER = { hasOffice: true, isOfficer: true, isSuperadmin: false };

describe("searchWorkspace", () => {
	const members = [
		{ id: "m1", name: "Faisal", officerPositions: [] },
		{ id: "m2", name: "Mahbuba", officerPositions: ["vp_education" as const] },
	];

	it("returns nothing for a blank query", () => {
		expect(searchWorkspace("   ", members, OFFICER)).toEqual({
			members: [],
			pages: [],
		});
	});

	it("matches members by name, case-insensitively", () => {
		const r = searchWorkspace("fai", members, NOBODY);
		expect(r.members.map((m) => m.name)).toEqual(["Faisal"]);
	});

	it("matches members by their current office label ('roles…')", () => {
		const r = searchWorkspace("education", members, NOBODY);
		expect(r.members.map((m) => m.name)).toEqual(["Mahbuba"]);
	});

	it("caps member results at 8", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			id: `x${i}`,
			name: `Member ${i}`,
			officerPositions: [],
		}));
		expect(searchWorkspace("member", many, NOBODY).members).toHaveLength(8);
	});

	it("hides officer-only pages from plain members", () => {
		const plain = searchWorkspace("roles", [], NOBODY);
		expect(plain.pages.map((p) => p.label)).toEqual(["My roles"]);
		const officer = searchWorkspace("roles", [], OFFICER);
		expect(officer.pages.map((p) => p.label)).toEqual([
			"Meeting roles",
			"My roles",
		]);
	});

	it("hides Superadmin unless the user is a superadmin", () => {
		expect(searchWorkspace("super", [], OFFICER).pages).toEqual([]);
		expect(
			searchWorkspace("super", [], {
				...OFFICER,
				isSuperadmin: true,
			}).pages.map((p) => p.label),
		).toEqual(["Superadmin"]);
	});
});

function renderSearch(props: Partial<Parameters<typeof GlobalSearch>[0]> = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<GlobalSearch clubId="club-1" grants={OFFICER} {...props} />
		</QueryClientProvider>,
	);
}

describe("GlobalSearch", () => {
	afterEach(() => {
		cleanup();
		navigateMock.mockClear();
	});

	it("surfaces member and page results while typing (inline variant)", async () => {
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "e");
		expect(await screen.findByText("Mahbuba")).toBeTruthy();
		expect(screen.getByText("Next meeting")).toBeTruthy();
	});

	it("selecting a member navigates to their profile, closes the drawer, and clears the query", async () => {
		const onNavigate = vi.fn();
		renderSearch({ variant: "inline", onNavigate });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "mahbuba");
		await userEvent.click(await screen.findByText("Mahbuba"));
		expect(navigateMock).toHaveBeenCalledWith({
			to: "/members/$id",
			params: { id: "m2" },
		});
		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(input.value).toBe("");
	});

	it("selecting a page navigates to it and closes the drawer", async () => {
		const onNavigate = vi.fn();
		renderSearch({ variant: "inline", onNavigate });
		await userEvent.type(screen.getByRole("combobox"), "sign-up");
		await userEvent.click(await screen.findByText("Sign-up sheet"));
		expect(navigateMock).toHaveBeenCalledWith({ to: "/schedule" });
		expect(onNavigate).toHaveBeenCalledTimes(1);
	});

	it("popover variant shows results anchored under the input while typing", async () => {
		renderSearch(); // default variant: popover (desktop top bar)
		await userEvent.type(screen.getByRole("combobox"), "faisal");
		expect(await screen.findByText("Faisal")).toBeTruthy();
	});

	it("Escape clears open results but keeps focus in the input", async () => {
		renderSearch({ variant: "inline" });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "faisal");
		expect(await screen.findByText("Faisal")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		expect(input.value).toBe("");
		expect(screen.queryByText("Faisal")).toBeNull();
	});

	it("clearResults() clears once then reports nothing left (drawer Escape ordering)", async () => {
		const ref = createRef<GlobalSearchHandle>();
		renderSearch({ variant: "inline", ref });
		const input = screen.getByRole<HTMLInputElement>("combobox");
		await userEvent.type(input, "faisal");
		let cleared = false;
		act(() => {
			cleared = ref.current?.clearResults() ?? false;
		});
		expect(cleared).toBe(true);
		expect(input.value).toBe("");
		act(() => {
			cleared = ref.current?.clearResults() ?? false;
		});
		expect(cleared).toBe(false);
	});

	it("still searches pages when there is no active club", async () => {
		renderSearch({ variant: "inline", clubId: null });
		await userEvent.type(screen.getByRole("combobox"), "roster");
		expect(await screen.findByText("Roster")).toBeTruthy();
	});

	it("shows an empty state when nothing matches", async () => {
		renderSearch({ variant: "inline" });
		await userEvent.type(screen.getByRole("combobox"), "zzz");
		expect(await screen.findByText(/No matches for/)).toBeTruthy();
	});
});
