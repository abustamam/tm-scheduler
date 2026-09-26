// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsNewEntry } from "#/lib/whats-new";

/**
 * The "What's new" surfaces (#947), rendered: the header dot and panel, the
 * `/whats-new` list, the public-page banner and the `useIsNew` badge. The rules
 * themselves are pinned in `#/lib/whats-new.guard.test.ts`; this file proves
 * the components actually read them.
 */

const { FIXTURES } = vi.hoisted(() => {
	const today = new Date().toISOString().slice(0, 10);
	const entry = (
		over: Partial<WhatsNewEntry> & { id: string },
	): WhatsNewEntry => ({
		title: `Title ${over.id}`,
		date: today,
		audience: "everyone",
		public: true,
		body: `Body ${over.id}`,
		...over,
	});
	const FIXTURES: WhatsNewEntry[] = [
		entry({ id: "admin-only", audience: "admins", public: false }),
		entry({ id: "members-only", audience: "members" }),
		entry({
			id: "for-everyone",
			audience: "everyone",
			link: "/account",
			featureKey: "account",
		}),
		entry({ id: "tomorrow", date: "2999-01-01" }),
	];
	return { FIXTURES };
});

vi.mock("#/lib/whats-new", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/whats-new")>();
	return { ...actual, WHATS_NEW_ENTRIES: FIXTURES };
});

const server = vi.hoisted(() => ({
	getWhatsNewState: vi.fn(),
	markWhatsNewSeen: vi.fn(),
	markFeatureSeen: vi.fn(),
}));
vi.mock("#/server/whats-new", () => server);

import { WhatsNewBanner } from "./whats-new-banner";
import {
	NewBadge,
	useIsNew,
	WhatsNewButton,
	WhatsNewProvider,
	WhatsNewPublicList,
} from "./whats-new-panel";

function withQuery(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function state(seenIds: string[] = [], featuresSeen: string[] = []) {
	return { seenIds, featuresSeen };
}

const openPanel = () =>
	userEvent.click(screen.getByRole("button", { name: /what's new/i }));

beforeEach(() => {
	server.getWhatsNewState.mockReset();
	server.markWhatsNewSeen.mockReset().mockResolvedValue({ seenIds: [] });
	server.markFeatureSeen.mockReset().mockResolvedValue({ ok: true });
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("WhatsNewButton (header dot + panel)", () => {
	it("shows the dot for unseen entries; opening records exactly what it showed", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await screen.findByTestId("whats-new-dot");

		await openPanel();
		expect(server.markWhatsNewSeen).toHaveBeenCalledTimes(1);
		const sent = server.markWhatsNewSeen.mock.calls[0][0].data.entryIds;
		// A member's eligible, published entries — never the admin one, never
		// the future-dated one.
		expect([...sent].sort()).toEqual(["for-everyone", "members-only"]);
		await waitFor(() =>
			expect(screen.queryByTestId("whats-new-dot")).toBeNull(),
		);
	});

	it("no dot once every eligible id was seen, and opening writes nothing", async () => {
		server.getWhatsNewState.mockResolvedValue(
			state(["for-everyone", "members-only"]),
		);
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByTestId("whats-new-dot")).toBeNull();
		await openPanel();
		expect(server.markWhatsNewSeen).not.toHaveBeenCalled();
	});

	it("an entry not among the seen ids lights the dot, whatever its date", async () => {
		// Seen everything but one entry dated TODAY — the same-day case a
		// timestamp comparison missed.
		server.getWhatsNewState.mockResolvedValue(state(["members-only"]));
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await screen.findByTestId("whats-new-dot");
	});

	it("a failed state read shows no dot and no error", async () => {
		server.getWhatsNewState.mockRejectedValue(new Error("offline"));
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByTestId("whats-new-dot")).toBeNull();
		expect(screen.getByRole("button", { name: /what's new/i })).toBeTruthy();
	});

	it("a member's panel lists members + everyone; no admin or future entry", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await openPanel();
		await screen.findByText("Title for-everyone");
		expect(screen.getByText("Title members-only")).toBeTruthy();
		expect(screen.queryByText("Title admin-only")).toBeNull();
		expect(screen.queryByText("Title tomorrow")).toBeNull();
	});

	it("an admin's panel lists admins + everyone, never members-only", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await openPanel();
		await screen.findByText("Title admin-only");
		expect(screen.getByText("Title for-everyone")).toBeTruthy();
		expect(screen.queryByText("Title members-only")).toBeNull();
	});

	it("following Try it clears that feature's badge and closes the panel", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await openPanel();
		const tryIt = await screen.findByRole("link", { name: /try it/i });
		expect(tryIt.getAttribute("href")).toBe("/account");
		// jsdom does not navigate; stop it trying.
		tryIt.addEventListener("click", (e) => e.preventDefault());
		await userEvent.click(tryIt);
		expect(server.markFeatureSeen).toHaveBeenCalledWith({
			data: { featureKey: "account" },
		});
		await waitFor(() =>
			expect(screen.queryByText("Title for-everyone")).toBeNull(),
		);
	});

	it("the panel body scrolls, not the sheet, so the header stays pinned", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await openPanel();
		const body = await screen.findByTestId("whats-new-body");
		expect(body.className).toMatch(/\bmin-h-0\b/);
		expect(body.className).toMatch(/\boverflow-y-auto\b/);
		expect(body.className).toMatch(/\bflex-1\b/);
		const sheet = screen.getByRole("dialog");
		expect(sheet.className).not.toMatch(/overflow-y-auto/);
	});

	it("renders nothing outside a provider (signed-out chrome)", () => {
		withQuery(<WhatsNewButton />);
		expect(screen.queryByRole("button", { name: /what's new/i })).toBeNull();
	});
});

describe("WhatsNewPublicList (/whats-new)", () => {
	it("renders only public, published entries; the admin-only entry never appears", () => {
		render(<WhatsNewPublicList entries={FIXTURES} />);
		expect(screen.getByText("Title for-everyone")).toBeTruthy();
		expect(screen.getByText("Title members-only")).toBeTruthy();
		expect(screen.queryByText("Title admin-only")).toBeNull();
		expect(screen.queryByText("Title tomorrow")).toBeNull();
	});

	it("the real shipped entries: the promote entry is not on the page", async () => {
		const actual =
			await vi.importActual<typeof import("#/lib/whats-new")>(
				"#/lib/whats-new",
			);
		const promote = actual.WHATS_NEW_ENTRIES.find(
			(e) => e.id === "2026-09-26-promote",
		);
		expect(promote).toBeDefined();
		render(<WhatsNewPublicList entries={actual.WHATS_NEW_ENTRIES} />);
		expect(screen.queryByText(promote?.title ?? "")).toBeNull();
		expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
	});
});

describe("WhatsNewBanner (public club and meeting pages)", () => {
	it("shows one entry for a picked member, and a dismissal sticks", async () => {
		const { unmount } = render(<WhatsNewBanner clubId="club-1" show />);
		const banner = await screen.findByRole("complementary", {
			name: /what's new/i,
		});
		// At most one: exactly one of the two eligible public entries.
		const shown = ["Title for-everyone", "Title members-only"].filter((t) =>
			banner.textContent?.includes(t),
		);
		expect(shown.length).toBe(1);
		expect(banner.textContent).not.toContain("admin-only");
		expect(
			screen
				.getByRole("link", { name: /see what's new/i })
				.getAttribute("href"),
		).toBe("/whats-new");

		await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		// The next one takes its place — still only one.
		const next = await screen.findByRole("complementary");
		expect(next.textContent).not.toContain(shown[0]);

		await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
		await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());

		// Remembered for this club across a remount...
		unmount();
		render(<WhatsNewBanner clubId="club-1" show />);
		await act(async () => {});
		expect(screen.queryByRole("complementary")).toBeNull();
		cleanup();
		// ...and per club: another club's page still shows it.
		render(<WhatsNewBanner clubId="club-2" show />);
		await screen.findByRole("complementary");
	});

	it("shows nothing when the visitor has not picked a name (show=false)", async () => {
		render(<WhatsNewBanner clubId="club-1" show={false} />);
		await act(async () => {});
		expect(screen.queryByRole("complementary")).toBeNull();
	});

	it("fails silent when localStorage throws", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		render(<WhatsNewBanner clubId="club-1" show />);
		await act(async () => {});
		expect(screen.queryByRole("complementary")).toBeNull();
	});
});

function AccountLink({ clubId }: { clubId?: string }) {
	const { isNew, markSeen } = useIsNew("account", { clubId });
	return (
		<div>
			<button type="button" onClick={markSeen}>
				Account
			</button>
			<NewBadge isNew={isNew} />
		</div>
	);
}

describe("useIsNew + NewBadge (signed in)", () => {
	it("badged until used, and the use is written to the account", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<AccountLink />
			</WhatsNewProvider>,
		);
		await screen.findByText("New");
		await userEvent.click(screen.getByRole("button", { name: "Account" }));
		expect(server.markFeatureSeen).toHaveBeenCalledWith({
			data: { featureKey: "account" },
		});
		await waitFor(() => expect(screen.queryByText("New")).toBeNull());
	});

	it("already used on the account means no badge", async () => {
		server.getWhatsNewState.mockResolvedValue(state([], ["account"]));
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<AccountLink />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});

	it("an unknown key is never new", async () => {
		server.getWhatsNewState.mockResolvedValue(state());
		function Other() {
			const { isNew } = useIsNew("roster");
			return <NewBadge isNew={isNew} />;
		}
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<Other />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});
});

describe("useIsNew on a public page (localStorage, per club)", () => {
	it("badges, and clearing persists per club", async () => {
		const { unmount } = render(<AccountLink clubId="club-1" />);
		await screen.findByText("New");
		await userEvent.click(screen.getByRole("button", { name: "Account" }));
		await waitFor(() => expect(screen.queryByText("New")).toBeNull());
		unmount();
		render(<AccountLink clubId="club-1" />);
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
		cleanup();
		render(<AccountLink clubId="club-2" />);
		await screen.findByText("New");
	});

	it("no club id and no session: never new", async () => {
		render(<AccountLink />);
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});
});
