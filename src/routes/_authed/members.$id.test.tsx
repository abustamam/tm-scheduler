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
		// Server-coalesced to E.164 before it ever reaches the view (#295).
		phone: "+14155552671",
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
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
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

	// The one prop no href/title assertion can reach, and the one this route
	// contributes: `WhatsAppPhoneLink` supplies layout and `hover:underline`, so
	// the call site passes COLOUR only — the same hover colour the `mailto:`
	// anchor above it carries. Without it the two links in one row behave
	// differently on hover.
	it("passes its hover colour through to the anchor", async () => {
		await renderRoute();
		const column = within(headerColumn("Ada Member"));
		const phone = column.getByRole("link", { name: /\+14155552671/ });

		expect(
			phone.className,
			"The member profile's WhatsAppPhoneLink lost its `className`. The " +
				"component owns layout and `hover:underline`; this call site owns the " +
				"hover colour that matches the email anchor beside it.",
		).toContain("hover:text-[var(--sea-ink)]");
		// …merged onto the component's own base rather than replacing it.
		expect(phone.className).toContain("hover:underline");
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
