// @vitest-environment jsdom
//
// Component tests for the roster table's PHONE column (the WhatsApp
// phone-links change). Everything else on the route is unchanged; these cover
// only what the new column adds.
//
// What jsdom can and cannot see here is the whole point of this file. It CAN
// see that the column exists, that the number links to WhatsApp, that a member
// with no number gets the fallback dash, and that the two independent grids
// (header row and body rows) still have the same number of cells. It CANNOT
// see the thing that actually breaks: the roster row is an OVERLAY-LINK row —
// an absolutely-positioned `<Link>` at `z-0` fills the row and every content
// cell is `pointer-events-none` so clicks fall through to it. A phone cell that
// copied the Pathway cell's classes would render correctly, carry the right
// href, and pass every assertion below while being completely unclickable,
// because jsdom performs no layout and dispatches no hit test. The class
// assertion in the last test is not proof of clickability — it pins the INTENT
// so a refactor that re-adds `pointer-events-none` fails loudly. Real proof is
// a click in a browser, done by hand.
//
// Pattern follows vpe-dashboard.test.tsx / club-settings.test.tsx: mock the
// server-fn modules (they reach `#/db` → `pg`, which must not load under
// jsdom), stub `Route.useLoaderData` / `useRouteContext`, and render
// `Route.options.component` directly rather than running the real loader.
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

vi.mock("#/server/account-invite", () => ({
	inviteAllMembers: vi.fn(),
	inviteMember: vi.fn(),
}));
vi.mock("#/server/club", () => ({
	listClubMembers: vi.fn(),
}));
vi.mock("#/server/meetings", () => ({
	listUpcomingMeetings: vi.fn(),
}));
vi.mock("#/server/members", () => ({
	bulkImportMembers: vi.fn(),
	mergeMembers: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({
	listClubMemberPathways: vi.fn(),
}));
vi.mock("#/server/upload-members", () => ({
	commitMemberUpload: vi.fn(),
	previewMemberUpload: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

import { Route } from "./roster";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

/** One row of `listClubMembers`' payload, with only what the view reads. */
function memberRow(over: Record<string, unknown> = {}) {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		name: "Ada Member",
		email: "ada@example.com",
		// Server-normalized to E.164 before it ever reaches the view (#295).
		phone: "+14155552671",
		officerPositions: [] as string[],
		userId: null,
		invitedAt: null,
		status: "active" as const,
		createdAt: new Date("2024-01-15T00:00:00Z"),
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		originalJoinDate: null,
		speeches: 3,
		...over,
	};
}

async function renderRoute(
	members: ReturnType<typeof memberRow>[],
	opts: { canManage?: boolean } = {},
) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [
			{
				clubId: CLUB_ID,
				name: "Downtown Club",
				clubNumber: "123456",
				clubRole: opts.canManage ? "admin" : "member",
			},
		],
		activeClubId: CLUB_ID,
		officerPositions: [],
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		members,
		openRoles: 0,
		pathways: {},
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
 * One member's row element — the ancestor of that member's full-row overlay
 * `<Link>`. Scoping to it is what keeps an assertion from passing on some other
 * member's phone number.
 */
function rowFor(name: string): HTMLElement {
	const overlay = screen.getByRole("link", { name: `Open ${name}'s profile` });
	const row = overlay.parentElement;
	expect(row, `no row element around "${name}"`).toBeTruthy();
	return row as HTMLElement;
}

/** The header grid — the one that carries the "Member" column label. */
function headerRow(): HTMLElement {
	return screen.getByText("Member").parentElement as HTMLElement;
}

/**
 * A row's grid cells, in column order. The overlay `<Link>` is positioned out
 * of flow and occupies no cell, so it is excluded.
 */
function cellsOf(row: HTMLElement): HTMLElement[] {
	return [...row.children].filter((c) => c.tagName !== "A") as HTMLElement[];
}

/**
 * Every `grid-cols-[…]` track list declared on an element, in source order —
 * i.e. narrowest breakpoint tier first, widest last.
 */
function gridTemplatesOf(el: HTMLElement): string[] {
	return [...el.className.matchAll(/grid-cols-\[([^\]]+)\]/g)].map((m) => m[1]);
}

/**
 * The responsive tier prefix on an element's WIDEST `grid-cols-[…]` — "xl" for a
 * trailing `xl:grid-cols-[…]`, null when the widest one is unprefixed.
 */
function widestGridTierOf(el: HTMLElement): string | null {
	const declared = [
		...el.className.matchAll(/(?:^|\s)(?:([a-z0-9]+):)?grid-cols-\[/g),
	];
	return declared.at(-1)?.[1] ?? null;
}

/** The responsive tier prefix on an element's `…:block`, e.g. "xl". */
function blockTierOf(el: HTMLElement): string | null {
	return el.className.match(/(?:^|\s)([a-z0-9]+):block(?=\s|$)/)?.[1] ?? null;
}

/** Which grid column the "Phone" header label sits in. */
function phoneColumn(): number {
	const column = [...headerRow().children].findIndex(
		(c) => c.textContent === "Phone",
	);
	expect(column, "no `Phone` column header").toBeGreaterThanOrEqual(0);
	return column;
}

/** The "Phone" header cell. */
function phoneHeaderCell(): HTMLElement {
	return headerRow().children[phoneColumn()] as HTMLElement;
}

/**
 * One row's PHONE cell, located by the position of the "Phone" header label.
 *
 * Positional rather than by-content on purpose. The first draft asserted the
 * dash by text within the whole ROW and could not fail: the Pathway cell to its
 * left renders the SAME "—" for a member with no synced path, so deleting the
 * `fallback` prop entirely left the test green. An assertion about the phone
 * cell has to actually be about the phone cell.
 */
function phoneCellOf(row: HTMLElement): HTMLElement {
	const cell = cellsOf(row)[phoneColumn()];
	expect(cell, "no body cell under the `Phone` header").toBeTruthy();
	return cell as HTMLElement;
}

describe("roster table — phone column", () => {
	it("renders a Phone header alongside the other column headers", async () => {
		await renderRoute([memberRow()]);
		expect(within(headerRow()).getByText("Phone")).toBeTruthy();
	});

	it("links a member's number to WhatsApp, addressed to that member", async () => {
		await renderRoute([memberRow()]);
		const cell = within(phoneCellOf(rowFor("Ada Member")));

		const phone = cell.getByRole("link", { name: /\+14155552671/ });
		expect(phone.getAttribute("href")).toContain("whatsapp");
		expect(phone.getAttribute("href")).toContain("14155552671");
		expect(phone.getAttribute("title")).toBe("Message Ada Member on WhatsApp");
		expect(phone.getAttribute("target")).toBe("_blank");
	});

	it("shows the fallback dash for a member with no number on file", async () => {
		await renderRoute([
			memberRow(),
			memberRow({
				id: "33333333-3333-4333-8333-333333333333",
				name: "No Phone",
				phone: null,
			}),
		]);

		// The row still has a phone CELL — it just holds the dash, so the column
		// keeps its width and the grid stays aligned. Asserted on the CELL's own
		// text: an empty cell renders "" here, and without the `fallback` prop
		// that is exactly what ships.
		const cell = phoneCellOf(rowFor("No Phone"));
		expect(cell.textContent).toBe("—");
		expect(within(cell).queryByRole("link")).toBeNull();

		// …and the member who does have one is unaffected.
		expect(
			within(phoneCellOf(rowFor("Ada Member"))).getByRole("link", {
				name: /\+14155552671/,
			}),
		).toBeTruthy();
	});

	// THE TRAP. Not proof of clickability — jsdom does no hit testing — but a
	// loud failure if a future refactor re-adds the class that makes the row's
	// overlay `<Link>` swallow the tap and open the profile instead of WhatsApp.
	it("keeps pointer events on the phone cell, unlike every other content cell", async () => {
		await renderRoute([memberRow()]);
		const row = rowFor("Ada Member");
		const cell = phoneCellOf(row);
		const phone = within(cell).getByRole("link", { name: /\+14155552671/ });

		for (let el: HTMLElement | null = phone; el && el !== row; ) {
			expect(
				el.className,
				"The phone cell (or something between it and the row) is " +
					"pointer-events-none, so the row's overlay Link swallows the click " +
					"and the WhatsApp link is unreachable. See the comment on that cell " +
					"in roster.tsx.",
			).not.toContain("pointer-events-none");
			el = el.parentElement;
		}

		// Stacked above the overlay Link (`z-0`), like the invite control.
		expect(cell.className).toContain("z-[2]");
	});

	// The header and the body rows are INDEPENDENT grids that must carry the SAME
	// `grid-cols-*` string. Adding a body cell without its header cell shifts
	// every column label by one and nothing else notices — and BOTH templates
	// (member and canManage) had to grow a column.
	it.each([
		false,
		true,
	])("keeps the header and body grids aligned (canManage=%s)", async (canManage) => {
		await renderRoute([memberRow()], { canManage });
		const header = headerRow();
		const row = rowFor("Ada Member");
		const cells = cellsOf(row);

		expect(cells.length).toBe(header.children.length);
		expect(gridTemplatesOf(header)).toEqual(gridTemplatesOf(row));

		// The WIDEST tier declares one track per cell. Only the widest: the
		// narrower tiers deliberately declare FEWER, because the cells they drop
		// are `display: none` there (Speeches/Pathway below `sm`, Phone below
		// `xl`) and a `display: none` grid item occupies no track.
		const widest = gridTemplatesOf(header).at(-1);
		expect(widest?.split("_").length).toBe(cells.length);
	});

	// …and the tier that REVEALS those cells has to be the tier that grew the
	// track for them. jsdom applies no CSS, so `hidden xl:block` is invisible to
	// every other assertion in this file: dropping BOTH phone cells to `lg:block`
	// while the templates stay at `xl:grid-cols-…` leaves all six tests green,
	// and renders five cells into a four-track grid between 1024px and 1279px —
	// wrapping the Account cell onto a second row. The tier is read off the
	// template rather than hard-coded, so moving the gate stays a one-place edit.
	it.each([
		false,
		true,
	])("reveals the Phone cells at the tier that grows the grid (canManage=%s)", async (canManage) => {
		await renderRoute([memberRow()], { canManage });
		const tier = widestGridTierOf(headerRow());
		expect(tier, "widest `grid-cols-[…]` declares no tier").toBeTruthy();

		// ABSOLUTE, and it earns its place NEXT TO the relative assertion below
		// rather than instead of it. The relative one catches the two sides
		// drifting apart; it cannot catch them moving TOGETHER, and moving them
		// together is the regression that hurts. Dropping both to `sm:` keeps this
		// test green while shipping the exact layout the measurements rejected —
		// CLAUDE.md's "a test stated RELATIVE to the constant it guards cannot
		// fail". So the measured value is pinned here as a number, not a comment.
		expect(
			tier,
			"The Phone column's breakpoint moved off `xl`. The measurements in the " +
				"comment above `TABLE_GRID` in roster.tsx are why it is `xl`, and a " +
				"fifth fixed column can only take width from the `1fr` Member track " +
				"that carries the member's NAME: at `sm` the four fixed columns want " +
				"570px inside a 542px content box, so at 640px the Member track " +
				"collapses to 0px — the name is gone entirely, the avatar overlaps " +
				"Speeches, and the card's `overflow-hidden` clips the trailing " +
				"chevron. `lg` is no better: the 248px app sidebar returns at exactly " +
				"that tier and eats the viewport gain (108px of Member at 1024px). " +
				"`xl` is the first tier where the column is free. Re-measure in a " +
				"real browser before moving this — jsdom applies no CSS and cannot " +
				"tell you.",
		).toBe("xl");

		const cells: [string, HTMLElement][] = [
			["header", phoneHeaderCell()],
			["body", phoneCellOf(rowFor("Ada Member"))],
		];
		for (const [which, cell] of cells) {
			expect(
				blockTierOf(cell),
				`The ${which} Phone cell appears at a different breakpoint than the ` +
					`one that adds its grid track (grid grows at \`${tier}\`). Between ` +
					"the two tiers the row renders more cells than the template has " +
					"tracks and the last column wraps onto a second row.",
			).toBe(tier);
		}
	});
});
