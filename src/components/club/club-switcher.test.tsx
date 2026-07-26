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
const { calls, setActiveClub, navigate, invalidate } = vi.hoisted(() => {
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
	};
});
vi.mock("#/server/auth-context", () => ({ setActiveClub }));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ navigate, invalidate }),
}));

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
