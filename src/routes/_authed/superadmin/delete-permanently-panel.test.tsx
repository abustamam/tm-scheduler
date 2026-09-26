// @vitest-environment jsdom
//
// The superadmin club page's "Delete permanently" form (#914). It renders the
// real route component with its server fns mocked, and checks the rules the
// form states:
//   - it appears only for an ARCHIVED club;
//   - the button stays disabled until the club's exact name is typed (surrounding
//     spaces are forgiven, a different case is not, the same as the server);
//   - a refusal is shown inline and the form stays;
//   - a success replaces the form with the counts and a Done button, with no
//     auto-redirect.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

const { deleteConsoleClub } = vi.hoisted(() => ({
	deleteConsoleClub: vi.fn(),
}));

vi.mock("#/server/onboarding", () => ({
	archiveConsoleClub: vi.fn(),
	unarchiveConsoleClub: vi.fn(),
	getConsoleClubDetail: vi.fn(),
	updateConsoleAdminEmail: vi.fn(),
	deleteConsoleClub,
}));
vi.mock("#/server/impersonation", () => ({ startImpersonation: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./$clubId";

const CLUB_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";
const NAME = "Downtown Speakers";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

async function renderClub(archived: boolean) {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		name: NAME,
		clubNumber: "123",
		slug: "downtown",
		memberCount: 2,
		createdAt: new Date("2026-01-01"),
		archivedAt: archived ? new Date("2026-09-01") : null,
		firstAdmin: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useParams").mockReturnValue({
		clubId: CLUB_ID,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Page = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Page />);
}

function input() {
	return screen.getByLabelText("Type the club's name to confirm");
}
function button() {
	return screen.getByRole("button", {
		name: /delete permanently/i,
	}) as HTMLButtonElement;
}

describe("Delete permanently (#914)", () => {
	it("is not offered for a club that is not archived", async () => {
		await renderClub(false);
		expect(
			screen.queryByLabelText("Type the club's name to confirm"),
		).toBeNull();
	});

	it("stays disabled until the exact name is typed", async () => {
		await renderClub(true);
		expect(button().disabled).toBe(true);
		fireEvent.change(input(), { target: { value: NAME.toUpperCase() } });
		expect(button().disabled).toBe(true);
		fireEvent.change(input(), { target: { value: "Downtown" } });
		expect(button().disabled).toBe(true);
		fireEvent.change(input(), { target: { value: `  ${NAME} ` } });
		expect(button().disabled).toBe(false);
	});

	it("shows a refusal inline and keeps the form", async () => {
		deleteConsoleClub.mockRejectedValueOnce(
			new Error("Archive the club first."),
		);
		await renderClub(true);
		fireEvent.change(input(), { target: { value: NAME } });
		fireEvent.click(button());
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Archive the club first.",
		);
		expect((input() as HTMLInputElement).value).toBe(NAME);
		expect(deleteConsoleClub).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, confirmName: NAME },
		});
	});

	it("shows the counts and a Done button on success", async () => {
		deleteConsoleClub.mockResolvedValueOnce({
			clubName: NAME,
			peopleDeleted: 3,
			peopleKept: 1,
			usersDeleted: 2,
			usersKept: 1,
		});
		await renderClub(true);
		fireEvent.change(input(), { target: { value: NAME } });
		fireEvent.click(button());
		expect(
			await screen.findByText(`${NAME} was permanently deleted.`),
		).toBeTruthy();
		expect(screen.getByText(/3 people deleted, 1 person kept/)).toBeTruthy();
		expect(screen.getByText(/2 accounts deleted, 1 account kept/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
		// No auto-redirect: the summary is still there after the router settles.
		await waitFor(() =>
			expect(screen.getByText(`${NAME} was permanently deleted.`)).toBeTruthy(),
		);
		expect(
			screen.queryByLabelText("Type the club's name to confirm"),
		).toBeNull();
	});
});
