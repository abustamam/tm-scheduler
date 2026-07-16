// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_REQUEST_MAILTO } from "#/lib/brand";
import { NoClubScreen } from "./no-club-screen";

describe("NoClubScreen", () => {
	afterEach(() => {
		cleanup();
	});

	it("explains the state and shows the signed-in email", () => {
		render(<NoClubScreen email="jane@club.org" onSignOut={() => {}} />);
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(screen.getByText("jane@club.org")).toBeTruthy();
	});

	it("offers the Request access mailto as an actionable next step", () => {
		render(<NoClubScreen email="jane@club.org" onSignOut={() => {}} />);
		const cta = screen.getByRole("link", { name: "Request access" });
		expect(cta.getAttribute("href")).toBe(ACCESS_REQUEST_MAILTO);
	});

	it("wires the header sign out to the handler", () => {
		const onSignOut = vi.fn();
		render(<NoClubScreen email="jane@club.org" onSignOut={onSignOut} />);
		// Two affordances trigger sign-out (header button + inline hint); the
		// header one is first in the DOM.
		const [headerSignOut] = screen.getAllByRole("button", {
			name: /sign out/i,
		});
		fireEvent.click(headerSignOut);
		expect(onSignOut).toHaveBeenCalledTimes(1);
	});

	it("hides the Superadmin escape hatch unless the user is a superadmin", () => {
		const { rerender } = render(
			<NoClubScreen email="jane@club.org" onSignOut={() => {}} />,
		);
		expect(screen.queryByRole("link", { name: /superadmin/i })).toBeNull();

		rerender(
			<NoClubScreen email="jane@club.org" onSignOut={() => {}} isSuperadmin />,
		);
		const link = screen.getByRole("link", { name: /superadmin/i });
		expect(link.getAttribute("href")).toBe("/superadmin");
	});
});
