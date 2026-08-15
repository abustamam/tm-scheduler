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

	it("tells a member whose club was TAKEN DOWN what actually happened (#560)", () => {
		render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				hasArchivedClub
			/>,
		);
		expect(screen.getByText("Your club isn't available")).toBeTruthy();
		// The default copy is an account problem this member cannot fix — their club
		// was removed, so no email address will help. It must not be shown to them.
		expect(screen.queryByText("You're not in a club yet")).toBeNull();
		expect(
			screen.queryByText(/isn't linked to a Toastmasters club on GavelUp yet/),
		).toBeNull();
		expect(
			screen.getByText(/the club has been removed from GavelUp/),
		).toBeTruthy();
		expect(
			screen.getByText(/Signing in with a different email won't change this/),
		).toBeTruthy();
	});

	it("does not name the archived club — that is the brand asset archiving removes", () => {
		// The prop is a boolean on purpose (ADR-0024): naming the club here would put
		// back the identity the takedown exists to remove.
		const { container } = render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				hasArchivedClub
			/>,
		);
		expect(container.textContent).not.toMatch(/club number/i);
		expect(screen.getByText("jane@club.org")).toBeTruthy();
	});

	it("keeps the default copy when the account is simply on no roster", () => {
		render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				hasArchivedClub={false}
			/>,
		);
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(screen.queryByText("Your club isn't available")).toBeNull();
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
