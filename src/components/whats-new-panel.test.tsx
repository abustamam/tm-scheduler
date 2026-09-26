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

const { entry, FIXTURES } = vi.hoisted(() => {
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
		entry({
			id: "admin-promote",
			audience: "admins",
			public: false,
			featureKey: "promote",
		}),
		entry({ id: "members-only", audience: "members" }),
		entry({ id: "for-everyone", audience: "everyone", link: "/account" }),
	];
	return { entry, FIXTURES };
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

beforeEach(() => {
	server.getWhatsNewState.mockReset();
	server.markWhatsNewSeen.mockReset().mockResolvedValue({ seenAt: "x" });
	server.markFeatureSeen.mockReset().mockResolvedValue({ ok: true });
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("WhatsNewButton (header dot + panel)", () => {
	it("shows the dot for unseen entries and clears it on open", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await screen.findByTestId("whats-new-dot");

		await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
		expect(server.markWhatsNewSeen).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(screen.queryByTestId("whats-new-dot")).toBeNull(),
		);
	});

	it("no dot once everything eligible was seen", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: new Date(Date.now() + 60_000).toISOString(),
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByTestId("whats-new-dot")).toBeNull();
		// Opening with nothing unseen writes nothing.
		await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
		expect(server.markWhatsNewSeen).not.toHaveBeenCalled();
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

	it("a member's panel lists members + everyone, never admin entries", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
		await screen.findByText("Title for-everyone");
		expect(screen.getByText("Title members-only")).toBeTruthy();
		expect(screen.queryByText("Title admin-promote")).toBeNull();
	});

	it("an admin's panel lists admins + everyone, never members-only", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<WhatsNewButton />
			</WhatsNewProvider>,
		);
		await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
		await screen.findByText("Title admin-promote");
		expect(screen.getByText("Title for-everyone")).toBeTruthy();
		expect(screen.queryByText("Title members-only")).toBeNull();
		// The "Try it" goes to the entry's in-app link.
		expect(
			screen.getByRole("link", { name: /try it/i }).getAttribute("href"),
		).toBe("/account");
	});

	it("renders nothing outside a provider (signed-out chrome)", () => {
		withQuery(<WhatsNewButton />);
		expect(screen.queryByRole("button", { name: /what's new/i })).toBeNull();
	});
});

describe("WhatsNewPublicList (/whats-new)", () => {
	it("renders only public entries; the admin-only entry never appears", () => {
		render(<WhatsNewPublicList entries={FIXTURES} />);
		expect(screen.getByText("Title for-everyone")).toBeTruthy();
		expect(screen.getByText("Title members-only")).toBeTruthy();
		expect(screen.queryByText("Title admin-promote")).toBeNull();
	});

	it("the real shipped entries: the promote entry is not on the page", async () => {
		const actual =
			await vi.importActual<typeof import("#/lib/whats-new")>(
				"#/lib/whats-new",
			);
		const promote = actual.WHATS_NEW_ENTRIES.find(
			(e) => e.featureKey === "promote",
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
		expect(banner.textContent).not.toContain("admin-promote");
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

function PromoteButton({ clubId }: { clubId?: string }) {
	const { isNew, markSeen } = useIsNew("promote", { clubId });
	return (
		<div>
			<button type="button" onClick={markSeen}>
				Promote
			</button>
			<NewBadge isNew={isNew} onDismiss={markSeen} />
		</div>
	);
}

describe("useIsNew + NewBadge", () => {
	it("signed in: badged until used, and the use is written to the account", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<PromoteButton />
			</WhatsNewProvider>,
		);
		await screen.findByText("New");
		await userEvent.click(screen.getByRole("button", { name: "Promote" }));
		expect(server.markFeatureSeen).toHaveBeenCalledWith({
			data: { featureKey: "promote" },
		});
		await waitFor(() => expect(screen.queryByText("New")).toBeNull());
	});

	it("signed in: already seen on the account means no badge", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: ["promote"],
		});
		withQuery(
			<WhatsNewProvider isAdmin={true}>
				<PromoteButton />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});

	it("signed in as a member: an admin-only feature never badges", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
		withQuery(
			<WhatsNewProvider isAdmin={false}>
				<PromoteButton />
			</WhatsNewProvider>,
		);
		await waitFor(() => expect(server.getWhatsNewState).toHaveBeenCalled());
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});

	it("an unknown key is never new", async () => {
		server.getWhatsNewState.mockResolvedValue({
			seenAt: null,
			featuresSeen: [],
		});
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
	it("an everyone-audience feature badges, and dismissal persists per club", async () => {
		// Swap the fixture's promote entry to an everyone-audience one for this
		// case by using the account entry's shape under the promote key.
		FIXTURES.push(
			entry({
				id: "public-feature",
				audience: "everyone",
				featureKey: "account",
			}),
		);
		try {
			function AccountLink({ clubId }: { clubId: string }) {
				const { isNew, markSeen } = useIsNew("account", { clubId });
				return <NewBadge isNew={isNew} onDismiss={markSeen} />;
			}
			const { unmount } = render(<AccountLink clubId="club-1" />);
			await screen.findByText("New");
			await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
			await waitFor(() => expect(screen.queryByText("New")).toBeNull());
			unmount();
			render(<AccountLink clubId="club-1" />);
			await act(async () => {});
			expect(screen.queryByText("New")).toBeNull();
			cleanup();
			render(<AccountLink clubId="club-2" />);
			await screen.findByText("New");
		} finally {
			FIXTURES.pop();
		}
	});

	it("no club id and no session: never new", async () => {
		render(<PromoteButton />);
		await act(async () => {});
		expect(screen.queryByText("New")).toBeNull();
	});
});
