// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBadge } from "./offline-badge";

// The real hooks read `navigator.onLine` / `serviceWorker.controller`, neither
// of which jsdom lets us drive; the states themselves are covered by the hook.
const state = { online: true, offlineReady: true };
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => state.online,
	useOfflineReady: () => state.offlineReady,
}));

describe("OfflineBadge", () => {
	beforeEach(() => {
		state.online = true;
		state.offlineReady = true;
		localStorage.clear();
	});
	afterEach(() => cleanup());

	// #361 — the online pill used to float `position: fixed` top-center, on top
	// of the agenda. It now flows wherever the host puts it (the print toolbar,
	// the present chrome cluster) so it never covers content.
	it("renders the online pill in normal flow, not pinned over the content", () => {
		render(
			<div data-testid="toolbar">
				<OfflineBadge id="m1" />
			</div>,
		);

		const pill = screen.getByText("Available offline");
		expect(pill.style.position).toBe("");
		expect(pill.className).toContain("no-print");
		expect(screen.getByTestId("toolbar").contains(pill)).toBe(true);
	});

	it("renders nothing while online without a service worker", () => {
		state.offlineReady = false;
		const { container } = render(<OfflineBadge id="m1" />);

		expect(container.textContent).toBe("");
	});

	// The genuinely-offline banner is information the reader needs mid-meeting,
	// so it stays pinned and prominent regardless of where it is mounted.
	it("keeps the offline banner pinned over the page", () => {
		localStorage.setItem(
			"gavelup-offline-visit:m1",
			String(Date.now() - 5 * 60_000),
		);
		state.online = false;
		render(
			<div data-testid="toolbar">
				<OfflineBadge id="m1" />
			</div>,
		);

		const banner = screen.getByText(/^Offline · showing the agenda as of/);
		expect(banner.textContent).toContain("5 minutes ago");
		expect(banner.parentElement?.style.position).toBe("fixed");
	});
});
