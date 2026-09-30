// @vitest-environment jsdom
//
// The Before/During guide fields on /admin/roles (#933): shown on every role's
// card — a standard role and a custom one alike — prefilled from the row, and
// sent on save through `updateClubRole`, the same admin-gated server fn that
// saves `description`. Harness as in `roles-non-standing.test.tsx`.
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
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/role-definitions", () => ({
	createClubRole: vi.fn(),
	deleteClubRole: vi.fn(),
	listClubRoles: vi.fn(),
	reorderClubRoles: vi.fn().mockResolvedValue(undefined),
	setClubRoleEnabled: vi.fn(),
	syncTemplateToUpcomingMeetings: vi.fn(),
	updateClubRole: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { updateClubRole } from "#/server/role-definitions";
import type { RoleDefinitionRow } from "#/server/role-definitions-logic";
import { Route } from "./roles";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

function role(
	over: Partial<RoleDefinitionRow> & { id: string; name: string },
): RoleDefinitionRow {
	return {
		category: "functionary",
		defaultCount: 1,
		sortOrder: 0,
		isSpeakerRole: false,
		description: null,
		key: null,
		beforeNotes: null,
		duringNotes: null,
		enabled: true,
		standing: true,
		slotCount: 0,
		agendaCount: 0,
		...over,
	};
}

async function renderRoles(roles: RoleDefinitionRow[]) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		adminClub: {
			clubId: CLUB_ID,
			name: "Downtown Club",
			clubNumber: "123456",
			clubRole: "admin",
		},
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	vi.spyOn(Route, "useLoaderData").mockReturnValue({ roles } as any);
	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function card(roleId: string): HTMLElement {
	const form = document.getElementById(`name-${roleId}`)?.closest("form");
	if (!form) throw new Error(`no card for ${roleId}`);
	return form as HTMLElement;
}

const TIMER = role({
	id: "r-timer",
	name: "Timer",
	key: "timer",
	beforeNotes: "Bring the lights.",
	duringNotes: "Time everyone.",
});
const CUSTOM = role({
	id: "r-custom",
	name: "Sergeant-at-Arms",
	key: "sergeant_at_arms",
	category: "leadership",
	sortOrder: 1,
});

describe("/admin/roles guide fields (#933)", () => {
	it("prefills both halves from the row", async () => {
		await renderRoles([TIMER, CUSTOM]);
		const c = within(card(TIMER.id));
		expect(
			(c.getByLabelText("Before the meeting") as HTMLTextAreaElement).value,
		).toBe("Bring the lights.");
		expect(
			(c.getByLabelText("During the meeting") as HTMLTextAreaElement).value,
		).toBe("Time everyone.");
	});

	it("saves a custom role's guide through updateClubRole", async () => {
		await renderRoles([TIMER, CUSTOM]);
		const c = within(card(CUSTOM.id));
		const before = c.getByLabelText("Before the meeting");
		const during = c.getByLabelText("During the meeting");
		expect((before as HTMLTextAreaElement).value).toBe("");
		await userEvent.type(before, "Set up the room.");
		await userEvent.type(during, "Call the meeting to order.");
		await userEvent.click(c.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(updateClubRole).toHaveBeenCalledTimes(1));
		expect(updateClubRole).toHaveBeenCalledWith({
			data: expect.objectContaining({
				clubId: CLUB_ID,
				roleId: CUSTOM.id,
				beforeNotes: "Set up the room.",
				duringNotes: "Call the meeting to order.",
			}),
		});
	});

	it("sends a cleared box as blank, so the server clears it", async () => {
		await renderRoles([TIMER]);
		const c = within(card(TIMER.id));
		await userEvent.clear(c.getByLabelText("Before the meeting"));
		await userEvent.click(c.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(updateClubRole).toHaveBeenCalledTimes(1));
		expect(updateClubRole).toHaveBeenCalledWith({
			data: expect.objectContaining({
				beforeNotes: "",
				duringNotes: "Time everyone.",
			}),
		});
		expect(screen.getAllByLabelText("During the meeting")).toHaveLength(1);
	});
});
