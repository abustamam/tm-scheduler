// @vitest-environment jsdom
//
// Component tests for the member-profile header's CONTACT ROW (the WhatsApp
// phone-links change). Everything else on this route is unchanged; these cover
// only what the new link adds.
//
// This file exists because `no-tel-links.guard.test.ts` was the ONLY thing
// looking at this call site, and a source grep is both position-blind and
// prop-set-blind: it pins the substrings `phone={member.phone}` /
// `name={member.name}` and cannot see the `{member.phone ? … : null}` gate
// around them, the `className` passed alongside them, the `mailto:` anchor
// beside them, or the outer row that holds both. Deleting BOTH the `className`
// prop and the phone gate in one edit left all 42 tests under `src/routes/
// _authed` green before this file existed.
//
// The `className` assertion is the load-bearing one. `WhatsAppPhoneLink` owns
// its own layout and `hover:underline`; every call site passes COLOUR and only
// colour, and this route's is the hover colour that matches the email anchor
// above it. Drop it and the number stops matching its neighbour on hover —
// a difference no href/title assertion can see.
//
// Pattern follows vp-membership.test.tsx / roster.test.tsx: mock the server-fn
// modules (they reach `#/db` → `pg`, which must not load under jsdom), stub
// `Route.useLoaderData` / `useRouteContext`, and render `Route.options.component`
// directly rather than running the real loader.
//
// KNOWN ASYMMETRY, deliberately not pinned here. The outer row gates on the RAW
// `member.email || member.phone`, not on the trimmed values — so a member with a
// whitespace-only phone and no email would render an empty row, the defect
// `vp-membership.tsx` avoids with a trimmed `hasPhone`. It is unreachable today
// because every write path runs `toStoredPhone`, which nulls whitespace-only
// input, and closing it would be a production change. Asserting the current
// behaviour would PIN the asymmetry rather than record it, so this comment is
// the record.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/club", () => ({
	getMemberProfile: vi.fn(),
}));
vi.mock("#/server/members", () => ({
	editMember: vi.fn(),
	removeMember: vi.fn(),
	setMemberRole: vi.fn(),
	setMemberStatus: vi.fn(),
}));
vi.mock("#/server/path-enrollment", () => ({
	addMemberPath: vi.fn(),
	getMemberEnrollments: vi.fn(),
	listPathwayOptions: vi.fn(),
	removeMemberPath: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({
	getMemberPathways: vi.fn(),
}));
vi.mock("#/server/progress-marks", () => ({
	markMemberProject: vi.fn(),
	unmarkMemberProject: vi.fn(),
}));
vi.mock("#/server/speeches", () => ({
	archiveSpeech: vi.fn(),
	rescheduleSpeech: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { Route } from "./members.$id";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

/** The `member` half of `getMemberProfile`'s payload, with what the view reads. */
function profileMember(over: Record<string, unknown> = {}) {
	return {
		id: MEMBER_ID,
		name: "Ada Member",
		preferredName: null,
		// Server-coalesced to E.164 before it ever reaches the view (#295) — the
		// DISPLAY value, which is what the WhatsApp link reads.
		phone: "+14155552671",
		// The stored column verbatim — what the edit dialog prefills. Deliberately
		// a DIFFERENT string from `phone` in the default fixture: bound to `phone`
		// by mistake, every prefill assertion below would still see a plausible
		// number, so identical fixtures would make the binding untestable.
		phoneRaw: "415-555-2671 x12",
		email: "ada@example.com",
		officerPositions: [] as string[],
		userId: null,
		status: "active" as const,
		clubRole: "member" as const,
		createdAt: new Date("2024-01-15T00:00:00Z"),
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		originalJoinDate: null,
		...over,
	};
}

async function renderRoute(over: Record<string, unknown> = {}) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: "member",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		member: profileMember(over),
		speechLog: [],
		rolesServed: [],
		speeches: 0,
		pathways: [],
		unscheduledSpeeches: [],
		openSpeakerSlots: [],
		pathOptions: [],
		enrollments: [],
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);

	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

/**
 * The header's text column — the name heading, the tenure line and the contact
 * row. Scoping every assertion to it is what keeps a test from passing on some
 * link elsewhere on the page (the back link, "Assign a role", the action
 * buttons), all of which live outside this element.
 */
function headerColumn(name: string): HTMLElement {
	const heading = screen.getByRole("heading", { level: 1, name });
	const column = heading.parentElement;
	expect(column, `no header column around "${name}"`).toBeTruthy();
	return column as HTMLElement;
}

describe("member profile — contact row", () => {
	it("links the phone to WhatsApp, addressed to that member", async () => {
		await renderRoute();
		const column = within(headerColumn("Ada Member"));

		const phone = column.getByRole("link", { name: /\+14155552671/ });
		expect(phone.getAttribute("href")).toContain("whatsapp");
		expect(phone.getAttribute("href")).toContain("14155552671");
		expect(phone.getAttribute("title")).toBe("Message Ada Member on WhatsApp");
		expect(phone.getAttribute("target")).toBe("_blank");
	});

	// This route used to pass `hover:text-[var(--sea-ink)]` here, and it never
	// took effect: `styles.css`'s unlayered `a:not(…):hover` rule beats anything
	// Tailwind puts in `@layer utilities`, so the class was dead the day it was
	// written. Colour now lives in the component, together with the
	// `data-slot="wa-phone"` that lets it survive that rule at all — the two
	// cannot be split across files, which is why the call site passes no styling.
	//
	// Asserted from the RENDERED anchor rather than by grepping the call site, so
	// re-adding a colour prop here fails loudly instead of quietly reintroducing
	// a class that does nothing. `whatsapp-phone-link-color.guard.test.ts` holds
	// the cascade half, which jsdom cannot see.
	it("passes no styling — the component owns colour and the opt-out", async () => {
		await renderRoute();
		const column = within(headerColumn("Ada Member"));
		const phone = column.getByRole("link", { name: /\+14155552671/ });

		expect(phone.getAttribute("data-slot")).toBe("wa-phone");
		expect(phone.className).toContain("text-primary");
		expect(phone.className).toContain("hover:underline");
		expect(
			phone.className,
			"The member profile must not pass a colour to WhatsAppPhoneLink. An " +
				"unlayered `a { color }` rule in styles.css overrides any colour " +
				"utility on this anchor, so the class would be inert; the component " +
				"owns colour because it also owns the `data-slot` that escapes that " +
				"rule.",
		).not.toContain("hover:text-[var(--sea-ink)]");
	});

	it("keeps the email on mailto: beside it — only the phone changed scheme", async () => {
		await renderRoute();
		const column = within(headerColumn("Ada Member"));

		expect(
			column
				.getByRole("link", { name: "ada@example.com" })
				.getAttribute("href"),
		).toBe("mailto:ada@example.com");
	});

	it("renders no phone link for a member with no number, keeping the email", async () => {
		await renderRoute({ phone: null });
		const column = within(headerColumn("Ada Member"));

		expect(column.queryByRole("link", { name: /WhatsApp/i })).toBeNull();
		expect(column.queryByTitle(/on WhatsApp$/)).toBeNull();
		expect(
			column
				.getByRole("link", { name: "ada@example.com" })
				.getAttribute("href"),
		).toBe("mailto:ada@example.com");
	});

	it("renders the phone alone when the member has no email", async () => {
		await renderRoute({ email: null });
		const column = within(headerColumn("Ada Member"));

		expect(column.getByRole("link", { name: /\+14155552671/ })).toBeTruthy();
		expect(column.queryByRole("link", { name: /@/ })).toBeNull();
	});

	it("renders no contact row at all when the member has neither", async () => {
		await renderRoute({ email: null, phone: null });
		const column = headerColumn("Ada Member");

		// Structural, not textual: the heading and the tenure line, and nothing
		// after them. An empty contact <div> would still pass a "no links" check
		// while shipping a stray `mt-1.5` row of blank space under the name.
		expect(column.children.length).toBe(2);
		expect(within(column).queryByRole("link")).toBeNull();
	});
});

/**
 * The edit dialog prefills the STORED phone, not the coalesced one.
 *
 * `getMemberProfile` carries the number twice — `phone` coalesced to E.164 for
 * the WhatsApp link, `phoneRaw` byte-for-byte for this form. Coalescing is a
 * country-code GUESS, so a member stored as "415-555-2671 x12" displays as
 * "+1415555267112"; putting THAT in the input shows an officer a number nobody
 * typed, on the only screen that shows what is actually on file — and they
 * opened it to fix a name.
 *
 * This is also the #319 trap in miniature: `phone` and `phoneRaw` are both
 * plausible strings on the same object, so nothing except an assertion on the
 * VALUE tells the two bindings apart. The fixture makes them differ for exactly
 * that reason — with one number in both fields these tests could not fail.
 */
describe("member profile — edit dialog phone prefill", () => {
	async function openEditDialog(): Promise<HTMLInputElement> {
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		return (await screen.findByLabelText("Phone")) as HTMLInputElement;
	}

	it("prefills the stored value, not the E.164 the header links to", async () => {
		await renderRoute();

		// Read the header FIRST: the dialog is modal, so opening it `aria-hidden`s
		// the rest of the page and every role query below would miss the link.
		// Asserting both in one test is the point — it pins the SPLIT (display
		// coalesced, form raw) rather than a wholesale swap back to raw everywhere,
		// which a prefill-only assertion would happily accept.
		expect(
			within(headerColumn("Ada Member"))
				.getByRole("link", { name: /\+14155552671/ })
				.getAttribute("href"),
		).toContain("14155552671");

		expect(
			(await openEditDialog()).value,
			"The edit dialog must prefill `member.phoneRaw` (the stored column), " +
				"not `member.phone` (coalesced for display) — see loadMemberProfile.",
		).toBe("415-555-2671 x12");
	});

	it("prefills a digit-less stored value verbatim", async () => {
		// `toStoredPhone` preserves input it cannot normalize and the member
		// editor's phone field has no digit requirement, so this is reachable in
		// normal use. Coalescing passes it through unchanged — which is why it is
		// paired with the case above rather than standing alone, where it would
		// pass on either binding.
		await renderRoute({
			phone: "call the office",
			phoneRaw: "call the office",
		});
		expect((await openEditDialog()).value).toBe("call the office");
	});

	it("prefills empty for a member with no number on file", async () => {
		await renderRoute({ phone: null, phoneRaw: null });
		expect((await openEditDialog()).value).toBe("");
	});
});
