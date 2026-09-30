// @vitest-environment jsdom
//
// The Agendas page (#910, AC10): the list with its default badge, the adopt
// button only while the club has no default, the edit-through-a-meeting line,
// and the grouped result of setting a default. Server fns are mocked — they
// reach `#/db` → `pg`, which must not load under jsdom.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/club-agendas", () => ({
	adoptStandardAgendaFn: vi.fn(),
	deleteClubTemplateFn: vi.fn(),
	duplicateClubTemplateFn: vi.fn(),
	renameClubTemplate: vi.fn(),
	setClubDefaultTemplate: vi.fn(),
	setClubTemplateEnabled: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { ADOPT_NOTICE, EDIT_THROUGH_MEETING } from "#/lib/club-agendas-copy";
import {
	adoptStandardAgendaFn,
	type ClubAgendas,
	setClubDefaultTemplate,
	setClubTemplateEnabled,
} from "#/server/club-agendas";
import { ClubAgendasPanel, DefaultResultLists } from "./club-agendas-panel";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const CLUB = "11111111-1111-4111-8111-111111111111";

function agendas(overrides: Partial<ClubAgendas> = {}): ClubAgendas {
	return {
		adopted: true,
		timezone: "America/Chicago",
		templates: [
			{
				id: "t-1",
				name: "Our standard agenda",
				description: null,
				enabled: true,
				beatCount: 28,
				isDefault: true,
			},
			{
				id: "t-2",
				name: "Contest night",
				description: "Area contest",
				enabled: false,
				beatCount: 12,
				isDefault: false,
			},
		],
		...overrides,
	};
}

async function renderInRouter(node: () => ReactElement) {
	const rootRoute = createRootRoute({ component: node });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

async function renderPanel(data: ClubAgendas, onChanged = vi.fn()) {
	await renderInRouter(() => (
		<ClubAgendasPanel clubId={CLUB} agendas={data} onChanged={onChanged} />
	));
	return onChanged;
}

describe("ClubAgendasPanel", () => {
	it("lists the club's templates with the default badge and the edit-through-a-meeting line", async () => {
		await renderPanel(agendas());
		expect(screen.getByText("Our standard agenda")).toBeTruthy();
		expect(screen.getByText("Contest night")).toBeTruthy();
		expect(screen.getByText("Default")).toBeTruthy();
		expect(screen.getByText("Disabled")).toBeTruthy();
		expect(screen.getByText(EDIT_THROUGH_MEETING)).toBeTruthy();
		// Adopted: no adopt button, a Clear default on the default.
		expect(
			screen.queryByRole("button", {
				name: "Adopt the standard agenda as our own",
			}),
		).toBeNull();
		expect(screen.getByRole("button", { name: "Clear default" })).toBeTruthy();
		// A disabled template cannot be offered as the default.
		const setButton = screen.getByRole("button", {
			name: "Set as default",
		}) as HTMLButtonElement;
		expect(setButton.disabled).toBe(true);
	});

	it("offers adoption only when the club has no default, and shows R1's notice before adopting", async () => {
		vi.mocked(adoptStandardAgendaFn).mockResolvedValue({
			templateId: "t-new",
			applied: [],
			keptEdited: [],
			keptSignups: [],
			failed: [],
		});
		const onChanged = await renderPanel(
			agendas({ adopted: false, templates: [] }),
		);
		await userEvent.click(
			screen.getByRole("button", {
				name: "Adopt the standard agenda as our own",
			}),
		);
		expect(screen.getByText(ADOPT_NOTICE)).toBeTruthy();
		expect(adoptStandardAgendaFn).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Adopt it" }));
		expect(adoptStandardAgendaFn).toHaveBeenCalledWith({
			data: { clubId: CLUB },
		});
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("clears the default with null and toasts", async () => {
		vi.mocked(setClubDefaultTemplate).mockResolvedValue({
			templateId: null,
			applied: [],
			keptEdited: [],
			keptSignups: [],
			failed: [],
		});
		await renderPanel(agendas());
		await userEvent.click(
			screen.getByRole("button", { name: "Clear default" }),
		);
		expect(setClubDefaultTemplate).toHaveBeenCalledWith({
			data: { clubId: CLUB, templateId: null },
		});
		await waitFor(() => expect(toast.success).toHaveBeenCalled());
	});

	it("toasts a server refusal instead of swallowing it", async () => {
		vi.mocked(setClubTemplateEnabled).mockRejectedValue(
			new Error("Clear it as the default first."),
		);
		await renderPanel(agendas());
		const [defaultToggle] = screen.getAllByRole("checkbox");
		await userEvent.click(defaultToggle as HTMLElement);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Clear it as the default first.",
			),
		);
	});
});

describe("DefaultResultLists", () => {
	it("groups the meetings, words a re-run as already on a copy, names the roles, and links each meeting", async () => {
		const at = (d: string) => new Date(`${d}T23:00:00Z`);
		await renderInRouter(() => (
			<DefaultResultLists
				clubId={CLUB}
				timezone="America/Chicago"
				result={{
					templateId: "t-1",
					applied: [{ meetingId: "m-a", scheduledAt: at("2026-10-06") }],
					keptEdited: [
						{
							meetingId: "m-c",
							scheduledAt: at("2026-10-13"),
							onDefaultCopy: false,
						},
						{
							meetingId: "m-e",
							scheduledAt: at("2026-10-20"),
							onDefaultCopy: true,
						},
					],
					keptSignups: [
						{
							meetingId: "m-d",
							scheduledAt: at("2026-10-27"),
							roles: ["Ah-Counter"],
						},
					],
					failed: [{ meetingId: "m-f", scheduledAt: at("2026-11-03") }],
				}}
			/>
		));
		expect(screen.getByText("Now on your default agenda")).toBeTruthy();
		expect(screen.getByText("Already on a copy of it")).toBeTruthy();
		expect(screen.getByText("Kept its own edited agenda")).toBeTruthy();
		expect(
			screen.getByText(
				"Has sign-ups for roles the new default doesn't include; apply it from the meeting",
			),
		).toBeTruthy();
		expect(screen.getByText("(Ah-Counter)")).toBeTruthy();
		expect(
			screen.getByText(
				"Couldn't be changed. Try applying it from the meeting.",
			),
		).toBeTruthy();
		const link = screen.getByRole("link", { name: "Tue, Oct 6" });
		expect(link.getAttribute("href")).toBe(`/club/${CLUB}/meeting/m-a`);
	});

	it("says so when there are no upcoming meetings", async () => {
		await renderInRouter(() => (
			<DefaultResultLists
				clubId={CLUB}
				timezone="UTC"
				result={{
					templateId: "t-1",
					applied: [],
					keptEdited: [],
					keptSignups: [],
					failed: [],
				}}
			/>
		));
		expect(screen.getByText("You have no upcoming meetings yet.")).toBeTruthy();
	});
});
