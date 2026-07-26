// @vitest-environment jsdom
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// club-switcher.tsx imports the auth-context server-fn module at import time
// (it defines createServerFns, which reach for #/db → DATABASE_URL outside a
// real server context). `vi.mock` factories are hoisted above the imports, so
// the spies must come from `vi.hoisted`. `calls` records the call ORDER — the
// point of #378 is that the switch persists, THEN leaves the old club's page.
const { calls, setActiveClub, navigate, invalidate, toastError } = vi.hoisted(
	() => {
		const calls: string[] = [];
		return {
			calls,
			setActiveClub: vi.fn(async () => {
				calls.push("setActiveClub");
				return { ok: true as const };
			}),
			navigate: vi.fn(async () => {
				calls.push("navigate");
			}),
			invalidate: vi.fn(async () => {
				calls.push("invalidate");
			}),
			toastError: vi.fn(),
		};
	},
);
vi.mock("#/server/auth-context", () => ({ setActiveClub }));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ navigate, invalidate }),
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { ClubSwitcher, type SwitcherClub } from "./club-switcher";

// Radix positions the popover with floating-ui, which needs ResizeObserver.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

const MORNING: SwitcherClub = {
	clubId: "aaa",
	name: "Morning Club",
	clubNumber: "123",
	clubRole: "admin",
};
const EVENING: SwitcherClub = {
	clubId: "bbb",
	name: "Evening Club",
	clubNumber: "456",
	clubRole: "member",
};
const CLUBS: SwitcherClub[] = [MORNING, EVENING];

afterEach(() => {
	cleanup();
	calls.length = 0;
	vi.clearAllMocks();
});

async function pick(name: RegExp) {
	const user = userEvent.setup();
	render(<ClubSwitcher clubs={CLUBS} activeClubId="aaa" />);
	await user.click(screen.getByRole("button", { name: /morning club/i }));
	const option = await screen.findByRole("button", { name });
	await user.click(option);
	return user;
}

describe("ClubSwitcher", () => {
	it("renders nothing when the user has a single club", () => {
		const { container } = render(
			<ClubSwitcher clubs={[MORNING]} activeClubId="aaa" />,
		);
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing while impersonating, even with several clubs (#246)", () => {
		// getAuthContext resolves the active club as
		// `impersonating?.clubId ?? <cookie>`, so the cookie this control writes
		// is ignored for the session. Before #378 picking a club was a silent
		// no-op; now that it also navigates, leaving the control rendered would
		// throw a superadmin off their page AND still not switch anything.
		const { container } = render(
			<ClubSwitcher
				clubs={[MORNING, EVENING]}
				activeClubId="aaa"
				impersonating
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("persists the choice before it moves the user (#378)", async () => {
		await pick(/evening club/i);
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		expect(setActiveClub).toHaveBeenCalledWith({ data: { clubId: "bbb" } });
		expect(calls[0]).toBe("setActiveClub");
	});

	it("leaves the old club's page for the club home, replacing history (#378)", async () => {
		await pick(/evening club/i);
		await waitFor(() => expect(navigate).toHaveBeenCalled());
		// `/` owns the role-aware redirect (#255) — the switcher must not
		// duplicate it. `replace` keeps Back off the previous club's page.
		expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
	});

	it("invalidates only after the navigation, never before (#378)", async () => {
		await pick(/evening club/i);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		// Invalidating first would re-run the OLD url's loaders under the NEW
		// active club — the bug this fixes.
		expect(calls).toEqual(["setActiveClub", "navigate", "invalidate"]);
	});

	// The test #378 wrote and then had to drop: a rejecting `setActiveClub`
	// became an unhandled promise rejection (nothing `catch`es it, and the
	// onClick discarded the promise), which fails the whole vitest run — the bug
	// #392 reports, and its own best evidence.
	it("surfaces the error and leaves the user where they were when the switch fails (#392)", async () => {
		setActiveClub.mockRejectedValueOnce(new Error("Your session has expired."));

		await pick(/evening club/i);

		// The server's own message, not a generic one — same as the other write
		// paths in this app.
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Your session has expired."),
		);
		// Stayed put: no navigation, no invalidation, nothing rewritten.
		expect(navigate).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		// The popover is still open with the choice in front of them, rather than
		// closing as if the switch had taken.
		expect(screen.getByRole("dialog")).toBeTruthy();
		// The control is usable again — `finally` still clears `busy`. (Exact
		// name: the open popover also holds a "Morning Club Club 123" option.)
		const trigger = screen.getByRole("button", { name: "Morning Club" });
		expect((trigger as HTMLButtonElement).disabled).toBe(false);
	});

	it("falls back to a plain message when the failure is not an Error (#392)", async () => {
		setActiveClub.mockRejectedValueOnce("nope");
		await pick(/evening club/i);
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Couldn't switch clubs."),
		);
	});

	it("says nothing when the switch succeeds", async () => {
		await pick(/evening club/i);
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		expect(toastError).not.toHaveBeenCalled();
	});

	it("does nothing when the active club is re-picked", async () => {
		const user = userEvent.setup();
		render(<ClubSwitcher clubs={CLUBS} activeClubId="aaa" />);
		await user.click(screen.getByRole("button", { name: /morning club/i }));
		const panel = await screen.findByRole("dialog");
		await user.click(within(panel).getByRole("button", { name: /morning/i }));
		expect(setActiveClub).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
