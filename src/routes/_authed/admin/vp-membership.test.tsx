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
	fireEvent,
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
		// The DISPLAY value (server-coalesced to E.164) — what the card links to.
		phone: "+14155552671",
		// The stored column verbatim — what the edit dialog prefills. Deliberately
		// a DIFFERENT string: both fields hold plausible numbers, so a dialog bound
		// to `phone` by mistake would still show one, and identical fixtures would
		// make the binding untestable.
		phoneRaw: "415-555-2671 x12",
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

	it("keeps the separator bound to the email so they wrap together", async () => {
		// The contact line became wrappable when phone and email stopped being one
		// truncated string. As its own flex item the "·" could be pushed to the end
		// of line 1 with the address starting line 2 — a dangling separator that
		// reads as punctuation on the phone number instead of a divider.
		//
		// Structural, because jsdom performs no layout and cannot be asked where
		// the line breaks. The property that MAKES it wrap correctly is that the
		// two are one flex child, and that IS observable: same parent, and that
		// parent is not the wrapping row itself.
		await renderRoute([guestRow()]);
		const card = within(cardTextColumn("Ada Guest"));
		const sep = card.getByText("·");
		const emailLink = card.getByRole("link", { name: "ada@example.com" });
		const phone = card.getByRole("link", { name: /\+14155552671/ });

		expect(
			sep.parentElement,
			"The separator must share a parent with the email anchor, or the flex " +
				"container can wrap between them and strand the '·' at the end of " +
				"the previous line.",
		).toBe(emailLink.parentElement);
		// …and that shared parent is a child of the wrapping row, not the row
		// itself — otherwise "same parent" is trivially true and pins nothing.
		expect(sep.parentElement).not.toBe(phone.parentElement);
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

	it("escapes a stored email so it cannot inject mailto headers", async () => {
		// Everything after the first `?` in a mailto URL is HEADERS the reader's
		// mail client honours, so a stored "a@b.com?bcc=…" interpolated raw makes
		// the VPM's own client blind-copy a third party on a message they believe
		// is private. `newGuestSchema` and `assignGuestSchema` now validate this
		// column as an email, but rows written before that persist — the write fix
		// stops new values, this stops the stored ones.
		const hostile = "ada@example.com?bcc=attacker@evil.com&subject=hi";
		await renderRoute([guestRow({ email: hostile })]);
		const card = within(cardTextColumn("Ada Guest"));
		const href =
			card.getByRole("link", { name: hostile }).getAttribute("href") ?? "";

		// Structural, not an exact-string match: the assertion is "no live
		// delimiter survives", which stays true under any correct escaping.
		expect(href.startsWith("mailto:")).toBe(true);
		expect(href.slice("mailto:".length)).not.toMatch(/[?&]/);
		// And it still parses as one recipient with an empty header section —
		// the property a partial escape would break.
		expect(new URL(href).search).toBe("");
		// The visible text is unchanged: escaping the href must not mangle what
		// the officer reads, which is how they notice the address is wrong.
		expect(card.getByRole("link", { name: hostile })).toBeTruthy();
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

/**
 * The guest edit dialog prefills the STORED phone, not the coalesced one.
 *
 * `loadGuestPipeline` carries the number twice — `phone` coalesced to E.164 for
 * the card's WhatsApp link, `phoneRaw` byte-for-byte for this form. Coalescing
 * is a country-code GUESS, so a guest stored as "415-555-2671 x12" displays as
 * "+1415555267112"; prefilling THAT shows the VPM a number nobody typed, in the
 * dialog they opened to fix a name.
 *
 * Both fields are plausible numbers on the same object, so only an assertion on
 * the VALUE separates the two bindings — hence a fixture where they differ.
 */
describe("VP Membership guest card — edit dialog phone prefill", () => {
	async function openEditDialog(): Promise<HTMLInputElement> {
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		return (await screen.findByLabelText("Phone")) as HTMLInputElement;
	}

	it("prefills the stored value, not the E.164 the card links to", async () => {
		await renderRoute([guestRow()]);

		// The card is read FIRST: the dialog is modal, so opening it `aria-hidden`s
		// the rest of the page. Asserting both in one test pins the SPLIT — display
		// coalesced, form raw — which a prefill-only assertion would not, since
		// reverting BOTH to the raw column would satisfy it.
		expect(
			within(cardTextColumn("Ada Guest"))
				.getByRole("link", { name: /\+14155552671/ })
				.getAttribute("href"),
		).toContain("14155552671");

		expect(
			(await openEditDialog()).value,
			"The guest edit dialog must prefill `guest.phoneRaw` (the stored " +
				"column), not `guest.phone` (coalesced for display) — see " +
				"PipelineGuestRow.phoneRaw.",
		).toBe("415-555-2671 x12");
	});

	it("prefills a digit-less stored value verbatim", async () => {
		// `toStoredPhone` preserves input it cannot normalize, and the guest
		// editor's phone field has no digit requirement — reachable in normal use.
		// Coalescing passes it through unchanged, so this case alone would pass on
		// either binding; it is here for the branch, paired with the one above.
		await renderRoute([
			guestRow({ phone: "call the office", phoneRaw: "call the office" }),
		]);
		expect((await openEditDialog()).value).toBe("call the office");
	});

	it("prefills empty for a guest with no number on file", async () => {
		await renderRoute([guestRow({ phone: null, phoneRaw: null })]);
		expect((await openEditDialog()).value).toBe("");
	});
});
