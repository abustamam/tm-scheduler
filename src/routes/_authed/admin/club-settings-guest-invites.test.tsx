// @vitest-environment jsdom
//
// The Guest invites and Promote editors on Club settings (#1547): a club switch
// remounts them (the active club is a cookie-backed context, not the URL, so the
// route component re-renders in place), and "View as this club" gets no editor.
// Same harness as `club-settings-ge-lock.test.tsx`.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("#/server/guest-invite-template", () => ({
	getGuestInviteTemplates: vi.fn(),
	updateGuestInviteTemplates: vi.fn(async () => ({ ok: true })),
	resetGuestInviteTemplate: vi.fn(async () => ({ ok: true })),
}));
vi.mock("#/server/promo", () => ({
	getPromoTemplate: vi.fn(),
	updatePromoTemplate: vi.fn(async () => ({ ok: true })),
	resetPromoTemplate: vi.fn(async () => ({ ok: true })),
	getPromoContext: vi.fn(async () => {
		throw new Error("no context");
	}),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DEFAULT_PROMO_TEMPLATE } from "#/lib/promo-template";
import { updateGuestInviteTemplates } from "#/server/guest-invite-template";
import { updatePromoTemplate } from "#/server/promo";
import { Route } from "./club-settings";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.mocked(updateGuestInviteTemplates).mockClear();
	vi.mocked(updatePromoTemplate).mockClear();
});

const CLUB_A = "11111111-1111-4111-8111-111111111111";
const CLUB_B = "22222222-2222-4222-8222-222222222222";

const loaderFor = (label: string) => ({
	profile: {
		name: label,
		district: "",
		mission: "",
		meetingSchedule: "",
		defaultCountryCode: "",
	},
	agenda: {
		geIntroducesFunctionaries: true,
		tableTopicsMinSeconds: null,
		tableTopicsMaxSeconds: null,
		digitalVotingEnabled: true,
		adopted: false,
	},
	logoMeta: null,
	timezone: { timezone: "UTC", zones: ["UTC"] },
	promoTemplate: {
		template: { ...DEFAULT_PROMO_TEMPLATE, headline: `${label} headline` },
		storedInvalid: false,
	},
	guestInviteTemplates: { never: { body: `${label} never body` } },
});

type Impersonating = {
	mode: "read_only" | "read_write";
	clubId: string;
} | null;

async function renderSettings(initial: {
	clubId: string;
	impersonating?: Impersonating;
}) {
	const state = {
		clubId: initial.clubId,
		impersonating: initial.impersonating ?? null,
	};
	const apply = () => {
		vi.spyOn(Route, "useRouteContext").mockReturnValue({
			adminClub: {
				clubId: state.clubId,
				name: state.clubId === CLUB_A ? "Club A" : "Club B",
				clubNumber: "1",
				clubRole: "admin",
			},
			impersonating: state.impersonating,
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
		} as any);
		vi.spyOn(Route, "useLoaderData").mockReturnValue(
			// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
			loaderFor(state.clubId === CLUB_A ? "Club A" : "Club B") as any,
		);
	};
	apply();
	const Component = Route.options.component as () => React.ReactElement;
	let bump: () => void = () => {};
	function Host() {
		const [, set] = useState(0);
		bump = () => set((n) => n + 1);
		return <Component />;
	}
	const router = createRouter({
		routeTree: createRootRoute({ component: Host }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
	return {
		switchTo: async (clubId: string) => {
			state.clubId = clubId;
			apply();
			await act(async () => bump());
		},
	};
}

const neverBody = () =>
	screen.findByLabelText("Message") as Promise<HTMLTextAreaElement>;

describe("a club switch on Club settings", () => {
	// protects=the guest invite editor shows the NEW club's text and saves under
	// it; fails_when=the editor keeps club A's text (state is initialised once) and
	// a save writes it to club B; no_claim=the loader refetch (mocked here).
	it("remounts the guest invite editor: B's text, saved under B", async () => {
		const user = userEvent.setup();
		const { switchTo } = await renderSettings({ clubId: CLUB_A });
		expect((await neverBody()).value).toBe("Club A never body");
		await switchTo(CLUB_B);
		await waitFor(async () =>
			expect((await neverBody()).value).toBe("Club B never body"),
		);
		const body = await neverBody();
		await user.type(body, "!");
		await user.click(
			screen.getByRole("button", { name: "Save guest invites" }),
		);
		await waitFor(() =>
			expect(updateGuestInviteTemplates).toHaveBeenCalledTimes(1),
		);
		const sent = vi.mocked(updateGuestInviteTemplates).mock.calls[0]?.[0] as {
			data: { clubId: string; templates: { never: { body: string } } };
		};
		expect(sent.data.clubId).toBe(CLUB_B);
		expect(sent.data.templates.never.body).toBe("Club B never body!");
	});

	// protects=the Promote editor does the same; fails_when=it keeps club A's
	// headline and saves it under club B; no_claim=the other promo fields.
	it("remounts the Promote editor: B's headline, saved under B", async () => {
		const user = userEvent.setup();
		const { switchTo } = await renderSettings({ clubId: CLUB_A });
		const headline = async () =>
			(await screen.findByLabelText("Headline")) as HTMLTextAreaElement;
		expect((await headline()).value).toBe("Club A headline");
		await switchTo(CLUB_B);
		await waitFor(async () =>
			expect((await headline()).value).toBe("Club B headline"),
		);
		await user.type(await headline(), "!");
		await user.click(
			screen.getByRole("button", { name: "Save promo template" }),
		);
		await waitFor(() => expect(updatePromoTemplate).toHaveBeenCalledTimes(1));
		const sent = vi.mocked(updatePromoTemplate).mock.calls[0]?.[0] as {
			data: { clubId: string };
		};
		expect(sent.data.clubId).toBe(CLUB_B);
	});
});

describe("View as this club (read-only impersonation)", () => {
	// protects=a read-only viewer gets no Save or Reset for guest invites (the
	// server would refuse it); fails_when=the editor renders for them;
	// no_claim=the Promote editor, which this change leaves as it was.
	it("hides the guest invite editor and says why", async () => {
		await renderSettings({
			clubId: CLUB_A,
			impersonating: { mode: "read_only", clubId: CLUB_A },
		});
		await screen.findByRole("heading", { name: "Guest invites" });
		expect(
			screen.queryByRole("button", { name: "Save guest invites" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Reset to default" }),
		).toBeNull();
		expect(
			screen.getByText(/Not available while viewing as this club\. Editing/),
		).toBeTruthy();
	});

	// protects=a read-write ("Act as admin") session still edits;
	// fails_when=the read-only gate also hides the editor from it;
	// no_claim=none beyond protects.
	it("keeps the editor for a read-write session", async () => {
		await renderSettings({
			clubId: CLUB_A,
			impersonating: { mode: "read_write", clubId: CLUB_A },
		});
		expect(
			await screen.findByRole("button", { name: "Save guest invites" }),
		).toBeTruthy();
	});
});
