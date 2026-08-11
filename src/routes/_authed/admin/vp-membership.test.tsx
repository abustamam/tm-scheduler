// @vitest-environment jsdom
//
// Component tests for the guest pipeline card's CONTACT LINE (the WhatsApp
// phone-links change). The card used to join phone and email into one string;
// they are separate elements now, which means the "·" between them is an
// element with a gate of its own — and that gate is the only piece of real
// conditional logic the change introduced.
//
// It exists because nothing else can see that gate. The `no-tel-links` source
// guard pins the substrings `phone={guest.phone}` / `name={guest.name}` and is
// structurally blind to the separator, the `hasPhone || hasEmail` outer gate,
// the `mailto:` anchor, and where `truncate` sits. The server suite stops at
// the payload. So the four states below — both present, phone blank, email
// absent, neither — are covered here or nowhere.
//
// The gate deliberately tests the TRIMMED value, because `WhatsAppPhoneLink`
// trims before deciding to render nothing. A gate on the raw column would leave
// a "·" dangling in front of the email for a whitespace-only phone; the second
// test is what holds that.
//
// Pattern follows vpe-dashboard.test.tsx / club-settings.test.tsx: mock the
// server-fn modules (they reach `#/db` → `pg`, which must not load under
// jsdom), stub `Route.useLoaderData`, and render `Route.options.component`
// directly rather than running the real loader.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineGuestRow } from "#/server/guest-pipeline";

vi.mock("#/server/guest-pipeline", () => ({
	convertGuestToMember: vi.fn(),
	deleteGuest: vi.fn(),
	getGuestPipeline: vi.fn(),
	setGuestStage: vi.fn(),
	updateGuest: vi.fn(),
}));
vi.mock("#/server/clubs", () => ({
	getClubByIdentifier: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { Route } from "./vp-membership";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** `firstVisitAt: null` on purpose — a first-visit date puts its OWN " · " in
 *  the line below the contact line, and these tests query for "·" by text. */
function guestRow(over: Partial<PipelineGuestRow> = {}): PipelineGuestRow {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		name: "Ada Guest",
		preferredName: null,
		email: "ada@example.com",
		phone: "+14155552671",
		stage: "prospect",
		convertedMembershipId: null,
		firstVisitAt: null,
		visitCount: 0,
		heldSlotCount: 0,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		...over,
	};
}

async function renderRoute(guests: PipelineGuestRow[]) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		guests,
		clubId: "22222222-2222-4222-8222-222222222222",
		clubName: "Downtown Club",
		clubSlug: "downtown",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

/**
 * The text column of one guest's card — the name line, the contact line and the
 * visits line. Scoping every assertion to this element is what keeps a test
 * from passing on some other guest's contact details.
 */
function cardTextColumn(name: string): HTMLElement {
	const nameLine = screen.getByText(name);
	const column = nameLine.parentElement;
	expect(column, `no text column around "${name}"`).toBeTruthy();
	return column as HTMLElement;
}

describe("VP Membership guest card — contact line", () => {
	it("links the phone to WhatsApp and separates it from the email", async () => {
		await renderRoute([guestRow()]);
		const card = within(cardTextColumn("Ada Guest"));

		const phone = card.getByRole("link", { name: /\+14155552671/ });
		expect(phone.getAttribute("href")).toContain("whatsapp");
		expect(phone.getAttribute("title")).toBe("Message Ada Guest on WhatsApp");
		// The email keeps its mailto: — only the phone changed scheme.
		expect(
			card.getByRole("link", { name: "ada@example.com" }).getAttribute("href"),
		).toBe("mailto:ada@example.com");
		expect(card.getByText("·")).toBeTruthy();
	});

	it("renders no separator and no phone for a whitespace-only number", async () => {
		// `WhatsAppPhoneLink` trims and renders NOTHING for this value, so a gate
		// on the raw column would leave a "·" hanging in front of the email with
		// nothing to its left.
		await renderRoute([guestRow({ phone: "   " })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(card.queryByText("·")).toBeNull();
		expect(card.queryByRole("link", { name: /WhatsApp/i })).toBeNull();
		expect(card.getByRole("link", { name: "ada@example.com" })).toBeTruthy();
	});

	it("builds the mailto: from the trimmed email, not the raw column", async () => {
		// The gate tests the trimmed value, so the href has to be built from the
		// same string — otherwise a padded row ships `mailto: ada@example.com `.
		await renderRoute([guestRow({ email: "  ada@example.com  " })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(
			card.getByRole("link", { name: "ada@example.com" }).getAttribute("href"),
		).toBe("mailto:ada@example.com");
	});

	it("renders no separator when the guest has a phone but no email", async () => {
		await renderRoute([guestRow({ email: null })]);
		const card = within(cardTextColumn("Ada Guest"));

		expect(card.queryByText("·")).toBeNull();
		expect(card.getByRole("link", { name: /\+14155552671/ })).toBeTruthy();
		expect(card.queryByRole("link", { name: /@/ })).toBeNull();
	});

	it("renders no contact line at all when the guest has neither", async () => {
		await renderRoute([guestRow({ email: null, phone: null })]);
		const column = cardTextColumn("Ada Guest");

		// Structural, not textual: the name line and the visits line, and nothing
		// between them. An empty contact <div> would still pass a "no · and no
		// link" assertion while shipping a stray empty row.
		expect(column.children.length).toBe(2);
		expect(within(column).queryByRole("link")).toBeNull();
		expect(within(column).queryByText("·")).toBeNull();
	});
});
