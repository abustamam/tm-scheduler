// @vitest-environment jsdom
//
// Component tests for the "Club logo" section of club-settings.tsx (#495 Lane
// C). The rest of the route (profile / reminders / agenda cards) is
// unchanged; these tests cover only what the new section adds: the
// attestation checkbox gating the submit button, the "Remove logo" button's
// existence gate, the client-side size/type pre-checks, and the
// preview-vs-empty-state branch.
//
// Pattern follows club.$clubId_.meeting.$meetingId.word.test.tsx: mock every
// server-fn (and `#/lib/club-logo-url`) import — they reach `#/db` → `pg`,
// which must not load under jsdom — then stub `Route.useRouteContext` /
// `useLoaderData` and render the component directly rather than running the
// real loader.
//
// `#/server/club-logo` and `#/lib/club-logo-url` are Lane A's contract
// (pinned in the issue #495 parallelization plan); this file is written
// against the pinned signatures and does not implement them.
//
// No `@testing-library/jest-dom` in this repo (no precedent uses it), so
// "disabled" is asserted via the native `HTMLButtonElement.disabled`
// property rather than a `toBeDisabled()` matcher.
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	getClubProfileSettings: vi.fn(),
	loadClubAgendaSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
}));
vi.mock("#/server/notification-prefs", () => ({
	loadClubReminderSettings: vi.fn(),
	updateClubReminderSettings: vi.fn(),
}));
vi.mock("#/server/club-logo", () => ({
	getClubLogoMeta: vi.fn(),
	uploadClubLogo: vi.fn(),
	removeClubLogoFn: vi.fn(),
}));
vi.mock("#/lib/club-logo-url", () => ({
	clubLogoUrl: vi.fn(
		(clubId: string, updatedAt: string) =>
			`/api/club/${clubId}/logo?v=${new Date(updatedAt).getTime()}`,
	),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { CLUB_LOGO_COPY, Route } from "./club-settings";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// restoreAllMocks does not clear the `vi.fn()`s created by the module
	// factories above, so call history would leak between tests.
	vi.clearAllMocks();
});

const ADMIN_CLUB = {
	clubId: "11111111-1111-4111-8111-111111111111",
	name: "Downtown Club",
	clubNumber: "123456",
	clubRole: "admin" as const,
};

/** The loader payload shape the component reads, with only what it touches. */
function loaderData(
	overrides: { logoMeta?: { updatedAt: string } | null } = {},
) {
	return {
		profile: {
			name: "Downtown Club",
			district: "",
			mission: "",
			meetingSchedule: "",
			defaultCountryCode: "",
		},
		reminders: { enabled: true, leadTimeDays: 3 },
		agenda: { geIntroducesFunctionaries: false },
		logoMeta: overrides.logoMeta === undefined ? null : overrides.logoMeta,
	};
}

/** Render the route's component with `useRouteContext`/`useLoaderData` stubbed. */
async function renderRoute(data: ReturnType<typeof loaderData>) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		adminClub: ADMIN_CLUB,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	vi.spyOn(Route, "useLoaderData").mockReturnValue(data as any);

	const Component = Route.options.component as () => React.ReactElement;
	const rootRoute = createRootRoute({ component: () => <Component /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

function pngFile(name = "logo.png", size = 4) {
	return new File([new Uint8Array(size).fill(1)], name, {
		type: "image/png",
	});
}

function saveButton() {
	return screen.getByRole("button", {
		name: CLUB_LOGO_COPY.saveCta,
	}) as HTMLButtonElement;
}

function attestationCheckbox() {
	return screen.getByRole("checkbox", {
		name: CLUB_LOGO_COPY.attestationLabel,
	}) as HTMLInputElement;
}

describe("Club settings — Club logo preview", () => {
	it("shows the empty state when no logo is set", async () => {
		await renderRoute(loaderData({ logoMeta: null }));
		expect(screen.getByText(CLUB_LOGO_COPY.emptyState)).toBeTruthy();
		expect(screen.queryByTestId("club-logo-preview")).toBeNull();
	});

	it("shows a preview image when a logo is set", async () => {
		await renderRoute(
			loaderData({ logoMeta: { updatedAt: "2026-07-31T00:00:00Z" } }),
		);
		const img = screen.getByTestId("club-logo-preview") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(
			`/api/club/${ADMIN_CLUB.clubId}/logo?v=${new Date("2026-07-31T00:00:00Z").getTime()}`,
		);
		expect(screen.queryByText(CLUB_LOGO_COPY.emptyState)).toBeNull();
	});
});

describe("Club settings — Remove logo button gate", () => {
	it("is absent when no logo is set", async () => {
		await renderRoute(loaderData({ logoMeta: null }));
		expect(
			screen.queryByRole("button", { name: CLUB_LOGO_COPY.removeCta }),
		).toBeNull();
	});

	it("is present when a logo is set", async () => {
		await renderRoute(
			loaderData({ logoMeta: { updatedAt: "2026-07-31T00:00:00Z" } }),
		);
		expect(
			screen.getByRole("button", { name: CLUB_LOGO_COPY.removeCta }),
		).toBeTruthy();
	});
});

describe("Club settings — attestation gates the submit button", () => {
	it("keeps Save club logo disabled with no file and no attestation", async () => {
		await renderRoute(loaderData());
		expect(saveButton().disabled).toBe(true);
	});

	it("keeps Save club logo disabled once a file is chosen but not attested", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile());

		expect(saveButton().disabled).toBe(true);
	});

	it("enables Save club logo once a file is chosen AND the attestation is checked", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile());
		await user.click(attestationCheckbox());

		expect(saveButton().disabled).toBe(false);
	});

	it("re-requires the attestation after a new file is chosen", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile("first.png"));
		const checkbox = attestationCheckbox();
		await user.click(checkbox);
		expect(checkbox.checked).toBe(true);

		// Choosing a replacement file must clear the previous attestation.
		await user.upload(fileInput, pngFile("second.png"));
		expect(checkbox.checked).toBe(false);
		expect(saveButton().disabled).toBe(true);
	});
});

describe("Club settings — client-side pre-checks", () => {
	it("rejects a file over 256KB and does not accept it as the pending upload", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const oversized = pngFile("big.png", 256 * 1024 + 1);
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, oversized);

		expect(toast.error).toHaveBeenCalledWith(CLUB_LOGO_COPY.sizeError);
		// The file must not become the pending upload: no filename echoed...
		expect(
			screen.queryByText(`${CLUB_LOGO_COPY.selectedFilePrefix}big.png`),
		).toBeNull();
		// ...and checking attestation still can't enable submit.
		await user.click(attestationCheckbox());
		expect(saveButton().disabled).toBe(true);
	});

	it("rejects a non-PNG/JPEG file by type", async () => {
		// The real accept="image/png,image/jpeg" attribute would stop a browser's
		// OS file picker from offering an .svg at all; `applyAccept: false`
		// bypasses that so this test exercises the component's OWN type guard
		// (defense in depth against drag-and-drop or a spoofed extension), which
		// is the thing under test here.
		const user = userEvent.setup({ applyAccept: false });
		await renderRoute(loaderData());
		const svg = new File([new Uint8Array([1, 2, 3])], "logo.svg", {
			type: "image/svg+xml",
		});
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, svg);

		expect(toast.error).toHaveBeenCalledWith(CLUB_LOGO_COPY.typeError);
		expect(
			screen.queryByText(`${CLUB_LOGO_COPY.selectedFilePrefix}logo.svg`),
		).toBeNull();
		await user.click(attestationCheckbox());
		expect(saveButton().disabled).toBe(true);
	});

	it("accepts a valid PNG within the size cap as the pending upload", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile("good.png", 256 * 1024));

		expect(toast.error).not.toHaveBeenCalled();
		expect(
			screen.getByText(`${CLUB_LOGO_COPY.selectedFilePrefix}good.png`),
		).toBeTruthy();
	});
});
