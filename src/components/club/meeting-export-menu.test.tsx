// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The export menu renders the packet dialog (#589), which calls a server fn —
// vitest follows that import into `#/db` where the real build strips it. Same
// hoisted-mock convention as `ballot.test.tsx`.
vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));

import { ROLE_SHEETS } from "#/data/role-sheets";
import type { Slide } from "#/lib/agenda-slides";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingExportMenu } from "./meeting-export-menu";

// downloadDeckPptx (#541) is mocked file-wide — this file only cares that the
// export menu calls it with the right args and reports through a toast, not
// about the real ~1MB library or its own logo-fetch/file-naming behavior,
// which pptx-download-button.test.tsx already covers.
const { downloadDeckPptx, toastLoading, toastDismiss } = vi.hoisted(() => ({
	downloadDeckPptx: vi.fn(async () => {}),
	toastLoading: vi.fn(() => 42),
	toastDismiss: vi.fn(),
}));
vi.mock("#/components/club/pptx-download-button", () => ({ downloadDeckPptx }));
vi.mock("sonner", () => ({
	toast: { loading: toastLoading, dismiss: toastDismiss },
}));

afterEach(cleanup);

const BASE = {
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: "11111111-2222-4333-8444-555555555555",
	wordOfTheDay: null as string | null,
	deck: undefined as Slide[] | undefined,
	clubName: undefined as string | undefined,
	presentIsPrimary: false,
};

/**
 * MeetingExportMenu renders <Link>s, so mount it under a minimal router —
 * shared with meeting-toolbar.test.tsx via src/test/router-harness.tsx.
 */
async function openMenu(overrides: Partial<typeof BASE> = {}) {
	const props = { ...BASE, ...overrides };
	await renderUnderMemoryRouter(<MeetingExportMenu {...props} />);
	await userEvent.click(
		screen.getByRole("button", { name: /print & export/i }),
	);
}

describe("MeetingExportMenu (#541 D2)", () => {
	it("always offers Print agenda and All role sheets, pinned to their targets", async () => {
		await openMenu();
		const print = screen.getByRole("menuitem", { name: /print agenda/i });
		expect(print.closest("a")?.getAttribute("href")).toBe(
			"/club/downtown/meeting/2026-08-10/print?layout=grid",
		);
		const roles = screen.getByRole("menuitem", { name: /all role sheets/i });
		expect(roles.closest("a")?.getAttribute("href")).toBe(
			"/club/downtown/roles",
		);
	});

	it("lists Present in the menu only when it is not the toolbar primary", async () => {
		await openMenu({ presentIsPrimary: false });
		const present = screen.getByRole("menuitem", { name: /present/i });
		expect(present.closest("a")?.getAttribute("href")).toContain(
			"/club/downtown/meeting/2026-08-10/present",
		);
	});

	it("omits Present from the menu when the toolbar already leads with it", async () => {
		await openMenu({ presentIsPrimary: true });
		expect(screen.queryByRole("menuitem", { name: /^present$/i })).toBeNull();
	});

	it("shows Word poster, pinned to its target, when the meeting has a word", async () => {
		await openMenu({ wordOfTheDay: "Buoyant" });
		expect(
			screen
				.getByRole("menuitem", { name: /word poster/i })
				.closest("a")
				?.getAttribute("href"),
		).toContain("/club/downtown/meeting/2026-08-10/word");
	});

	// The whitespace row is the one that earns its keep: it is the only case
	// that fails if someone swaps `hasWordOfTheDay` for a bare `Boolean(...)`,
	// which would show a menu item leading to a poster with nothing on it.
	it.each<[string, string | null]>([
		["null", null],
		["an empty string", ""],
		["whitespace only", "   "],
	])("hides the Word poster item for %s", async (_label, word) => {
		await openMenu({ wordOfTheDay: word });
		expect(screen.queryByRole("menuitem", { name: /word poster/i })).toBeNull();
	});

	it("opens the per-meeting role-sheet PDFs in a dialog, one downloadable link per sheet", async () => {
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		for (const sheet of ROLE_SHEETS) {
			const link = screen.getByText(sheet.title).closest("a");
			expect(link?.getAttribute("href")).toBe(
				`/api/meetings/${BASE.dbMeetingId}/role-sheets/${sheet.key}/pdf`,
			);
			expect(link?.hasAttribute("download")).toBe(true);
		}
	});

	it("opens every external link (Print, Present, All role sheets, Word poster) in a new tab with noopener", async () => {
		await openMenu({ presentIsPrimary: false, wordOfTheDay: "Buoyant" });
		for (const name of [
			/print agenda/i,
			/^present$/i,
			/all role sheets/i,
			/word poster/i,
		]) {
			const link = screen.getByRole("menuitem", { name }).closest("a");
			expect(link?.getAttribute("target")).toBe("_blank");
			expect(link?.getAttribute("rel")).toContain("noopener");
		}
	});

	it("orders the menu items: Print agenda, Present, packet, per-meeting sheets, All role sheets", async () => {
		await openMenu();
		const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
		// The packet (#589) sits ABOVE the per-sheet list: it is the action most
		// people want for a meeting, and the individual sheets are the fallback
		// for wanting exactly one.
		expect(items).toEqual([
			"Print agenda",
			"Present",
			"Print meeting packet…",
			"This meeting's role sheets…",
			"All role sheets",
		]);
	});

	it("keeps the gated items in spec order too: Word poster then Download .pptx last", async () => {
		// Spec D2 names all six; the ungated test above can't see a swap of the
		// two gated items (e.g. Word poster drifting above All role sheets).
		await openMenu({
			wordOfTheDay: "Buoyant",
			deck: [{ kind: "title" }] as unknown as Slide[],
			clubName: "HCS",
		});
		const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
		expect(items).toEqual([
			"Print agenda",
			"Present",
			"Print meeting packet…",
			"This meeting's role sheets…",
			"All role sheets",
			"Word poster",
			"Download .pptx",
		]);
	});

	it("shows Download .pptx only when a deck and club name exist", async () => {
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /download \.pptx/i }),
		).toBeNull();
	});

	// Both props are optional and the gate is `deck && clubName`, so each half
	// alone must not offer the item: `deckToPptx` would be handed an empty deck
	// or the file named `undefined Agenda.pptx`. The neither-case above cannot
	// distinguish a two-sided gate from a one-sided one.
	it.each<[string, Partial<typeof BASE>]>([
		[
			"a deck but no club name",
			{ deck: [{ kind: "title" }] as unknown as Slide[] },
		],
		["a club name but no deck", { clubName: "HCS" }],
	])("hides Download .pptx with %s", async (_label, props) => {
		await openMenu(props);
		expect(
			screen.queryByRole("menuitem", { name: /download \.pptx/i }),
		).toBeNull();
	});

	// The `.catch(() => {})` in the onSelect handler is insurance against a
	// future contract breach in `downloadDeckPptx` (which today toasts its own
	// failures and never rejects). Every other test in this file mocks the
	// helper as resolving, so this is the ONLY one that makes it reject — and
	// therefore the only one that can observe the `.catch` at all.
	//
	// Honest about the mechanism: the explicit assertion below pins the toast
	// dismissal (which `.finally` does either way). Deleting the `.catch` is
	// caught one step over — the rejection escapes and Vitest fails the RUN on
	// the unhandled rejection. Verified by mutation: removing the `.catch` turns
	// this file red, and removing this test makes that mutation invisible.
	it("a REJECTING exporter still dismisses the loading toast and never propagates", async () => {
		toastDismiss.mockClear();
		downloadDeckPptx.mockRejectedValueOnce(new Error("contract breach"));
		const deck = [{ kind: "title" }] as unknown as Slide[];
		await openMenu({ deck, clubName: "HCS" });
		await userEvent.click(
			screen.getByRole("menuitem", { name: /download \.pptx/i }),
		);
		await waitFor(() => expect(toastDismiss).toHaveBeenCalledWith(42));
	});

	// State-controlled dialog: it has no DialogTrigger, so Radix's default
	// focus-return is a silent no-op that drops focus on <body>. The component
	// preventDefaults `onCloseAutoFocus` and refocuses the menu trigger itself —
	// remove that and a keyboard user is teleported to the top of the document
	// after downloading a role sheet, with every other test still green.
	it("closing the role-sheets dialog returns focus to the Print & export trigger", async () => {
		await openMenu();
		await userEvent.click(
			screen.getByRole("menuitem", { name: /this meeting's role sheets/i }),
		);
		expect(screen.getByRole("dialog")).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: /print & export/i }),
			),
		);
	});

	it("closes the menu, toasts progress, and forwards deck/clubName to the pptx exporter", async () => {
		const deck = [{ kind: "title" }] as unknown as Slide[];
		await openMenu({ deck, clubName: "HCS" });
		const item = screen.getByRole("menuitem", { name: /download \.pptx/i });
		await userEvent.click(item);

		expect(downloadDeckPptx).toHaveBeenCalledWith({ deck, clubName: "HCS" });
		expect(toastLoading).toHaveBeenCalled();
		// The menu closes on select (Radix default) — a modal menu would hold
		// the page pointer-inert for the whole export.
		expect(
			screen.queryByRole("menuitem", { name: /download \.pptx/i }),
		).toBeNull();

		await waitFor(() => expect(toastDismiss).toHaveBeenCalledWith(42));
	});
});
