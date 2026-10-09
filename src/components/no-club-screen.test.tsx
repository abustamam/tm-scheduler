// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClublessFrame, NoClubScreen } from "./no-club-screen";

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

	it("offers the Request access form as an actionable next step (#866)", () => {
		render(<NoClubScreen email="jane@club.org" onSignOut={() => {}} />);
		const cta = screen.getByRole("link", { name: "Request access" });
		expect(cta.getAttribute("href")).toBe("/request-access");
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

	it("renders account controls a club-less person still needs (#851)", () => {
		render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				accountControls={<p>Connected apps stand-in</p>}
			/>,
		);
		expect(screen.getByText("Connected apps stand-in")).toBeTruthy();
	});
});

describe("NoClubScreen for an Area Director (#1119)", () => {
	afterEach(cleanup);

	const AREA_C3 = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
	const AREA_B2 = "4a1c6d2f-7b4e-4e2c-8a6f-3d8b9c0e1f2a";

	it("offers one Go to Area button per current term, linking to its page", () => {
		render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				areas={[
					{ id: AREA_C3, label: "C3" },
					{ id: AREA_B2, label: "B2" },
				]}
			/>,
		);
		const c3 = screen.getByRole("link", { name: "Go to Area C3" });
		expect(c3.getAttribute("href")).toBe(`/area/${AREA_C3}`);
		const b2 = screen.getByRole("link", { name: "Go to Area B2" });
		expect(b2.getAttribute("href")).toBe(`/area/${AREA_B2}`);
		// The explanation and the way to ask for a club are still there.
		expect(screen.getByText("You're not in a club yet")).toBeTruthy();
		expect(screen.getByRole("link", { name: "Request access" })).toBeTruthy();
	});

	it("shows no area button to someone with no term", () => {
		render(
			<NoClubScreen email="jane@club.org" onSignOut={() => {}} areas={[]} />,
		);
		expect(screen.queryByRole("link", { name: /go to area/i })).toBeNull();
		// And none when the prop is left off, as it is for every other caller.
		cleanup();
		render(<NoClubScreen email="jane@club.org" onSignOut={() => {}} />);
		expect(screen.queryByRole("link", { name: /go to area/i })).toBeNull();
	});

	it("shows the area button beside the Superadmin one for a person who is both", () => {
		render(
			<NoClubScreen
				email="jane@club.org"
				onSignOut={() => {}}
				isSuperadmin
				areas={[{ id: AREA_C3, label: "C3" }]}
			/>,
		);
		expect(screen.getByRole("link", { name: "Go to Area C3" })).toBeTruthy();
		expect(
			screen
				.getByRole("link", { name: /go to superadmin/i })
				.getAttribute("href"),
		).toBe("/superadmin");
	});
});

describe("ClublessFrame (#1119)", () => {
	afterEach(cleanup);

	it("frames the page with the brand and sign out, and none of the no-club copy", () => {
		const onSignOut = vi.fn();
		render(
			<ClublessFrame onSignOut={onSignOut}>
				<p>The area page</p>
			</ClublessFrame>,
		);
		expect(screen.getByText("The area page")).toBeTruthy();
		expect(screen.queryByText("You're not in a club yet")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
		expect(onSignOut).toHaveBeenCalledTimes(1);
	});
});
