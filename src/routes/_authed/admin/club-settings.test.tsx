// @vitest-environment jsdom
//
// Component tests for the "Club logo" section of club-settings.tsx (#495 Lane
// C). The rest of the route (profile / reminders / agenda cards) is
// unchanged; these tests cover only what the new section adds: the
// attestation checkbox gating the submit button, the "Remove logo" button's
// existence gate, the client-side pre-checks (type, bytes and — since #504 —
// pixels), the copy derived from the shared limits, and the
// preview-vs-empty-state branch. Non-exhaustive on purpose: an enumeration that
// has to be edited for every added block is one more thing to go stale.
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
	loadClubTimezoneSettings: vi.fn(),
	updateClubAgendaSettings: vi.fn(),
	updateClubProfile: vi.fn(),
	updateClubTimezone: vi.fn(),
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
// NOT mocked, deliberately (#504). These are the SAME symbols the server
// imports; a fixture sized against a local copy of the number would prove
// nothing about whether the client and the server agree.
import {
	ALLOWED_LOGO_MIME_TYPES,
	MAX_LOGO_BYTES,
	MAX_LOGO_DIMENSION,
	MAX_LOGO_KB,
} from "#/lib/club-logo-limits";
import { removeClubLogoFn, uploadClubLogo } from "#/server/club-logo";
import { updateClubTimezone } from "#/server/clubs";
import { CLUB_LOGO_COPY, Route, zoneLabel } from "./club-settings";

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

/**
 * The zones the fake loader offers. A THREE-entry list, not the real ~420: the
 * point of every assertion below is that the component renders the list the
 * SERVER sent and preselects the club's own value, and a short list makes an
 * off-by-one or a dropped option visible in the failure message.
 */
const ZONES = ["America/Chicago", "Asia/Tokyo", "UTC"] as const;

/** The loader payload shape the component reads, with only what it touches. */
function loaderData(
	overrides: {
		logoMeta?: { updatedAt: string } | null;
		timezone?: string;
	} = {},
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
		timezone: {
			timezone: overrides.timezone ?? "America/Chicago",
			zones: ZONES as readonly string[],
		},
	};
}

/** `loaderData` with the zone LIST overridden too — for the deploy-drift case
 *  where the stored zone is not in the runtime's own list. */
function loaderDataWith(timezone: { timezone: string; zones: string[] }) {
	return { ...loaderData(), timezone };
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
	return router;
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
	it("rejects a file over the byte cap and does not accept it as the pending upload", async () => {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const oversized = pngFile("big.png", MAX_LOGO_BYTES + 1);
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
		await user.upload(fileInput, pngFile("good.png", MAX_LOGO_BYTES));

		expect(toast.error).not.toHaveBeenCalled();
		expect(
			screen.getByText(`${CLUB_LOGO_COPY.selectedFilePrefix}good.png`),
		).toBeTruthy();
	});
});

// The pixel cap the client did not know about between #496 and #504 — the
// history is in `#/lib/club-logo-limits`, not restated here.
//
// These drive REAL PNG BYTES through the real `#/lib/image-dimensions` parser —
// the same function the server runs. That is only possible because #504 replaced
// a `createImageBitmap` decode with a header read: jsdom has no image decoder, so
// the first cut of this block could only stub a global and assert against the
// stub, which proves the component calls the browser but nothing about whether
// its answer matches the server's. Here the two cannot disagree.
describe("Club settings — client-side dimension pre-check", () => {
	/**
	 * A structurally valid PNG of the given size: signature + IHDR + IEND.
	 *
	 * CRCs are zero, which is deliberate and safe — the parser validates chunk
	 * STRUCTURE, not checksums (see `#/lib/image-dimensions`), so a real CRC
	 * would add nothing an assertion here could observe. `padTo` appends filler
	 * AFTER IEND, where the walk has already returned, so a fixture can be given
	 * any file size without disturbing the header it is testing.
	 */
	function pngBytes(
		width: number,
		height: number,
		padTo = 0,
		// `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the bare form widens to
		// `ArrayBufferLike`, which `new File([...])` rejects because a SharedArrayBuffer
		// is not a valid BlobPart.
	): Uint8Array<ArrayBuffer> {
		const chunk = (type: string, data: Uint8Array) => {
			const out = new Uint8Array(12 + data.length);
			new DataView(out.buffer).setUint32(0, data.length);
			for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
			out.set(data, 8);
			return out;
		};
		const ihdr = new Uint8Array(13);
		const view = new DataView(ihdr.buffer);
		view.setUint32(0, width);
		view.setUint32(4, height);
		ihdr[8] = 8; // bit depth
		ihdr[9] = 6; // colour type: RGBA
		const parts = [
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IEND", new Uint8Array(0)),
		];
		const size = parts.reduce((n, p) => n + p.length, 0);
		const out = new Uint8Array(Math.max(size, padTo));
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}

	function pngFileOf(name: string, bytes: Uint8Array<ArrayBuffer>) {
		return new File([bytes], name, { type: "image/png" });
	}

	async function choose(name: string, bytes: Uint8Array<ArrayBuffer>) {
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFileOf(name, bytes));
		return user;
	}

	const staged = (name: string) =>
		screen.queryByText(`${CLUB_LOGO_COPY.selectedFilePrefix}${name}`);

	it("reads the real header — a fixture the parser agrees is over-wide is rejected", async () => {
		const bytes = pngBytes(MAX_LOGO_DIMENSION + 1, 10);
		const user = await choose("wide.png", bytes);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				CLUB_LOGO_COPY.dimensionError({
					width: MAX_LOGO_DIMENSION + 1,
					height: 10,
				}),
			),
		);
		expect(staged("wide.png")).toBeNull();
		await user.click(attestationCheckbox());
		expect(saveButton().disabled).toBe(true);
	});

	it("rejects an image taller than the cap", async () => {
		// Height is a separate comparison from width — one `||` arm can be
		// dropped without the other test noticing.
		await choose("tall.png", pngBytes(10, MAX_LOGO_DIMENSION + 1));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				CLUB_LOGO_COPY.dimensionError({
					width: 10,
					height: MAX_LOGO_DIMENSION + 1,
				}),
			),
		);
		expect(staged("tall.png")).toBeNull();
	});

	it("names the measured size, as the server's message does", async () => {
		await choose("big.png", pngBytes(4000, 3000));
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
		expect(vi.mocked(toast.error).mock.calls[0][0]).toContain("4000 x 3000");
	});

	it("accepts an image exactly at the cap on both axes", async () => {
		// The boundary the SERVER also accepts (`club-logo-logic.integration
		// .test.ts`: "accepts an image at the limit on both axes"). A `>=` here
		// would reject a file the server takes — the two must agree on the edge,
		// not just on the direction. Same parser now, so this pins the comparison.
		await choose("exact.png", pngBytes(MAX_LOGO_DIMENSION, MAX_LOGO_DIMENSION));

		expect(await screen.findByText(/exact\.png/)).toBeTruthy();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("falls through to the server when the bytes are not a readable header", async () => {
		// Fail OPEN. The parser returns null for anything it cannot read the way
		// the decoder would, and this check is a shortcut to the error message,
		// never the gate — the server re-runs it and its messages distinguish
		// "not a valid PNG or JPEG" from a size problem.
		await choose("garbage.png", new Uint8Array(64).fill(1));

		expect(await screen.findByText(/garbage\.png/)).toBeTruthy();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("checks bytes BEFORE reading the header, so the size message wins", async () => {
		// Ordering is the observable: this fixture violates both caps, and only
		// the cheap check's message may appear. Moving the header read above the
		// byte check would pass every other test in this block.
		await choose(
			"huge.png",
			pngBytes(
				MAX_LOGO_DIMENSION + 1,
				MAX_LOGO_DIMENSION + 1,
				MAX_LOGO_BYTES + 1,
			),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(CLUB_LOGO_COPY.sizeError),
		);
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("clears a previously staged file when the new pick is rejected", async () => {
		// The native input was cleared the moment the new file arrived, so a
		// surviving "Selected: good.png" would be the only thing on screen saying
		// what Save sends — and it would send a file the admin thinks they
		// replaced, still carrying its earlier attestation.
		const user = userEvent.setup();
		await renderRoute(loaderData());
		const fileInput = document.getElementById("logoFile") as HTMLInputElement;

		await user.upload(fileInput, pngFileOf("good.png", pngBytes(400, 300)));
		expect(await screen.findByText(/good\.png/)).toBeTruthy();
		await user.click(attestationCheckbox());
		expect(saveButton().disabled).toBe(false);

		await user.upload(
			fileInput,
			pngFileOf("wide.png", pngBytes(MAX_LOGO_DIMENSION + 1, 10)),
		);
		await waitFor(() => expect(staged("good.png")).toBeNull());
		expect(staged("wide.png")).toBeNull();
		expect(attestationCheckbox().checked).toBe(false);
		expect(saveButton().disabled).toBe(true);
	});
});

// #504's actual subject: these assert the CLIENT resolves the same symbols the
// server does, that the user-visible copy is derived from them rather than
// retyped, and that it REACHES THE DOM — a string in an object nobody renders is
// the same papercut in a new place. `club-logo-limits.test.ts` pins the absolute
// values, so nothing here is circular: this file proves agreement, that one
// proves the numbers.
describe("Club settings — logo copy is derived from the shared limits", () => {
	it("states the byte cap the client actually enforces", () => {
		expect(CLUB_LOGO_COPY.sizeError).toContain(`${MAX_LOGO_KB} KB`);
		expect(CLUB_LOGO_COPY.helpText).toContain(`${MAX_LOGO_KB} KB`);
	});

	it("states the pixel cap the client actually enforces", () => {
		expect(CLUB_LOGO_COPY.dimensionError(null)).toContain(
			`${MAX_LOGO_DIMENSION} x ${MAX_LOGO_DIMENSION}`,
		);
		expect(CLUB_LOGO_COPY.helpText).toContain(
			`${MAX_LOGO_DIMENSION} x ${MAX_LOGO_DIMENSION}`,
		);
	});

	it("filters the file picker with the shared allow-list", async () => {
		// `accept` is user-visible — it is what the OS picker offers — and it was
		// a fifth hardcoded copy of the MIME list until #504's review. Neither
		// guard could see it: the limits guard sweeps identifiers and numbers, and
		// the trademark guard explicitly waives `accept="…"` as structural. So the
		// assertion lives here, where the rendered attribute is observable.
		await renderRoute(loaderData());
		const input = document.getElementById("logoFile") as HTMLInputElement;
		expect(input.accept).toBe(ALLOWED_LOGO_MIME_TYPES.join());
		expect(input.accept).toBe("image/png,image/jpeg");
	});

	it("renders the help text, pixel cap included, where the admin can see it", async () => {
		// The papercut #504's triage found was that the page promised only
		// "up to 256KB" while the server enforced a pixel cap too. Asserting the
		// CONSTANT would not have caught that: the object can hold the right
		// string while the page renders nothing. This is the assertion that makes
		// the two above about a user.
		await renderRoute(loaderData());
		expect(await screen.findByText(CLUB_LOGO_COPY.helpText)).toBeTruthy();
	});
});
describe("Club settings — upload write path (onUploadLogo)", () => {
	it("submits the exact payload shape on Save (clubId, base64, mime, attested), shows a success toast, and invalidates the router", async () => {
		const user = userEvent.setup();
		vi.mocked(uploadClubLogo).mockResolvedValue(undefined);
		const router = await renderRoute(loaderData());
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile("logo.png", 4));
		await user.click(attestationCheckbox());
		await user.click(saveButton());

		await waitFor(() => expect(uploadClubLogo).toHaveBeenCalledTimes(1));
		// biome-ignore lint/suspicious/noExplicitAny: server-fn call signature
		const { data } = vi.mocked(uploadClubLogo).mock.calls[0][0] as any;
		expect(data.clubId).toBe(ADMIN_CLUB.clubId);
		expect(data.mime).toBe("image/png");
		expect(data.attested).toBe(true);
		// The base64-encoded bytes, not the File object itself — this is the
		// transport `fileToBase64` produces and the zod validator on the server
		// fn expects.
		expect(typeof data.base64).toBe("string");
		expect(data.base64.length).toBeGreaterThan(0);

		expect(toast.success).toHaveBeenCalledWith(CLUB_LOGO_COPY.uploadSuccess);
		expect(invalidateSpy).toHaveBeenCalled();
	});

	it("shows an error toast with the thrown message when the upload rejects, and does not invalidate the router", async () => {
		const user = userEvent.setup();
		vi.mocked(uploadClubLogo).mockRejectedValue(
			new Error("That file doesn't look like a valid PNG or JPEG image."),
		);
		const router = await renderRoute(loaderData());
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile());
		await user.click(attestationCheckbox());
		await user.click(saveButton());

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"That file doesn't look like a valid PNG or JPEG image.",
			),
		);
		expect(invalidateSpy).not.toHaveBeenCalled();
	});

	// The `err instanceof Error ? err.message : CLUB_LOGO_COPY.genericError`
	// fallback branch — a rejection that ISN'T an Error instance must still
	// surface a readable toast, not "[object Object]" or an unhandled crash.
	it("falls back to the generic error message when the rejection isn't an Error instance", async () => {
		const user = userEvent.setup();
		vi.mocked(uploadClubLogo).mockRejectedValue("not an Error object");
		await renderRoute(loaderData());

		const fileInput = document.getElementById("logoFile") as HTMLInputElement;
		await user.upload(fileInput, pngFile());
		await user.click(attestationCheckbox());
		await user.click(saveButton());

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(CLUB_LOGO_COPY.genericError),
		);
	});
});

describe("Club settings — remove write path (onRemoveLogo)", () => {
	it("calls removeClubLogoFn with only the clubId, shows a success toast, and invalidates the router", async () => {
		const user = userEvent.setup();
		vi.mocked(removeClubLogoFn).mockResolvedValue(undefined);
		const router = await renderRoute(
			loaderData({ logoMeta: { updatedAt: "2026-07-31T00:00:00Z" } }),
		);
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		await user.click(
			screen.getByRole("button", { name: CLUB_LOGO_COPY.removeCta }),
		);

		await waitFor(() =>
			expect(removeClubLogoFn).toHaveBeenCalledWith({
				data: { clubId: ADMIN_CLUB.clubId },
			}),
		);
		expect(toast.success).toHaveBeenCalledWith(CLUB_LOGO_COPY.removeSuccess);
		expect(invalidateSpy).toHaveBeenCalled();
	});

	it("shows an error toast with the thrown message when remove rejects, and does not invalidate the router", async () => {
		const user = userEvent.setup();
		vi.mocked(removeClubLogoFn).mockRejectedValue(new Error("permission"));
		const router = await renderRoute(
			loaderData({ logoMeta: { updatedAt: "2026-07-31T00:00:00Z" } }),
		);
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		await user.click(
			screen.getByRole("button", { name: CLUB_LOGO_COPY.removeCta }),
		);

		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("permission"));
		expect(invalidateSpy).not.toHaveBeenCalled();
	});
});

/**
 * The "Time zone" section (#547).
 *
 * These cover the half of the feature the DB-backed suite structurally cannot
 * see: what the admin is shown and what the form actually sends. The seam tests
 * in `club-timezone.integration.test.ts` prove the write is correct once it
 * arrives; nothing there can catch a select that renders the wrong list, or a
 * submit handler that posts the club's OLD zone.
 */
describe("club settings — time zone (#547)", () => {
	/** The select is labelled, so this is also the a11y assertion. */
	const picker = () => screen.getByLabelText("Time zone") as HTMLSelectElement;

	it("preselects the club's stored zone rather than the first option", async () => {
		// The specific failure this pins: a select whose `value` does not match
		// any option silently falls back to option one, so the club would read as
		// America/Chicago no matter what it had saved. Tokyo is deliberately not
		// first in ZONES.
		await renderRoute(loaderData({ timezone: "Asia/Tokyo" }));
		expect(picker().value).toBe("Asia/Tokyo");
	});

	it("renders exactly the zones the loader supplied", async () => {
		await renderRoute(loaderData());
		expect([...picker().options].map((o) => o.value)).toEqual([...ZONES]);
	});

	it("labels each option with its zone and current offset", async () => {
		await renderRoute(loaderData());
		// The offset is computed live from Intl, so assert its SHAPE rather than a
		// value: "GMT-5" and "GMT-6" are both correct depending on whether the
		// suite runs inside US summer time, and pinning one would make this test a
		// calendar bomb.
		const chicago = [...picker().options].find(
			(o) => o.value === "America/Chicago",
		);
		expect(chicago?.text).toMatch(/^America\/Chicago \(GMT[+-]\d+\)$/);
	});

	it("saves the newly picked zone, not the one the club started on", async () => {
		const user = userEvent.setup();
		vi.mocked(updateClubTimezone).mockResolvedValue({ ok: true });
		const router = await renderRoute(
			loaderData({ timezone: "America/Chicago" }),
		);
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		await user.selectOptions(picker(), "Asia/Tokyo");
		await user.click(screen.getByRole("button", { name: "Save time zone" }));

		await waitFor(() =>
			expect(updateClubTimezone).toHaveBeenCalledWith({
				data: { clubId: ADMIN_CLUB.clubId, timezone: "Asia/Tokyo" },
			}),
		);
		expect(toast.success).toHaveBeenCalledWith("Time zone saved.");
		expect(invalidateSpy).toHaveBeenCalled();
	});

	it("shows the server's message and does not invalidate when the save rejects", async () => {
		const user = userEvent.setup();
		vi.mocked(updateClubTimezone).mockRejectedValue(
			new Error("This club has been archived."),
		);
		const router = await renderRoute(loaderData());
		const invalidateSpy = vi
			.spyOn(router, "invalidate")
			.mockResolvedValue(undefined);

		await user.click(screen.getByRole("button", { name: "Save time zone" }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("This club has been archived."),
		);
		expect(invalidateSpy).not.toHaveBeenCalled();
	});

	it("warns that changing the zone re-labels meetings, and says what to do", async () => {
		await renderRoute(loaderData());
		// The behaviour pinned by `club-timezone.integration.test.ts` is one an
		// admin has to be told about BEFORE they change it — a dated link can 404
		// or, on a double-header, resolve to the other meeting. If that copy is
		// dropped, the behaviour becomes a surprise. The remedy is asserted too:
		// a warning with no action leaves the officer stuck.
		expect(screen.getByText(/old link may stop working/i)).toBeTruthy();
		expect(screen.getByText(/re-share it after saving/i)).toBeTruthy();
	});

	it("still displays a stored zone the current ICU list has dropped", async () => {
		// The deploy-drift case: `getClubTimezoneSettings` unions the stored value
		// into `zones` when its own list no longer carries that spelling. Here the
		// loader supplies exactly that shape. Without the union the select finds no
		// matching <option> and silently falls back to the first — which is not an
		// error, just a club quietly reading as the wrong zone.
		await renderRoute(
			loaderDataWith({
				timezone: "Asia/Calcutta",
				zones: ["Asia/Calcutta", ...ZONES].sort(),
			}),
		);
		expect(picker().value).toBe("Asia/Calcutta");
	});

	it("disables the save button while the write is in flight", async () => {
		const user = userEvent.setup();
		// Hold the write open so the pending state is observable. Without this
		// gate the promise resolves inside the click and the disabled window is
		// gone before any assertion can see it.
		let release: (v: { ok: true }) => void = () => {};
		vi.mocked(updateClubTimezone).mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const router = await renderRoute(loaderData());
		vi.spyOn(router, "invalidate").mockResolvedValue(undefined);

		const button = () =>
			screen.getByTestId("save-timezone") as HTMLButtonElement;
		expect(button().disabled).toBe(false);

		await user.click(button());
		await waitFor(() => expect(button().disabled).toBe(true));

		release({ ok: true });
		// Settles cleanly — the finally block must clear the flag, or the admin is
		// locked out of a second save after the first succeeds.
		await waitFor(() => expect(button().disabled).toBe(false));
	});

	it("falls back to the generic message when the rejection is not an Error", async () => {
		const user = userEvent.setup();
		// Server fns can reject with a non-Error (a serialized RPC payload). The
		// `err instanceof Error` arm is the only thing standing between that and
		// `undefined` rendered as the toast body.
		vi.mocked(updateClubTimezone).mockRejectedValue("not an Error object");
		await renderRoute(loaderData());

		await user.click(screen.getByRole("button", { name: "Save time zone" }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Something went wrong."),
		);
	});
});

/**
 * `zoneLabel`'s two degraded paths (#547).
 *
 * Both depend on how the BROWSER's `Intl` answers for a given zone, and the
 * server's zone list is the one rendered — so a zone this browser's ICU spells
 * differently reaches the label function for real. Neither path is reachable by
 * driving the select, which is why the function is exported.
 */
describe("zoneLabel — offset degradation (#547)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders zone and offset when Intl resolves the zone", () => {
		expect(zoneLabel("America/Chicago")).toMatch(
			/^America\/Chicago \(GMT[+-]\d+\)$/,
		);
	});

	it("replaces underscores so the option reads as words", () => {
		expect(zoneLabel("America/New_York")).toContain("America/New York");
		expect(zoneLabel("America/New_York")).not.toContain("_");
	});

	it("falls back to the bare zone name when Intl throws on the zone", () => {
		// The cross-ICU case named in CLUB_TIMEZONES: the server lists a spelling
		// this browser refuses. The option must stay selectable and readable.
		//
		// A CLASS, not `function () {}` — `bun run fix` rewrites a function
		// expression into an arrow (biome's useArrowFunction), and an arrow is
		// not a constructor, so `new Intl.DateTimeFormat()` throws
		// "not a constructor" instead of the RangeError being simulated. Both
		// stubs here passed that way for the wrong reason, and the sibling test
		// below could not fail at all. Do not "simplify" these back.
		vi.stubGlobal("Intl", {
			...Intl,
			DateTimeFormat: class {
				constructor() {
					throw new RangeError("Invalid time zone specified");
				}
			},
		});
		expect(zoneLabel("Asia/Calcutta")).toBe("Asia/Calcutta");
	});

	it("falls back to the bare zone name when Intl yields no offset part", () => {
		// Defensive arm: `formatToParts` returning nothing named `timeZoneName`
		// would otherwise render "Zone (undefined)". Reaching it requires a stub
		// that CONSTRUCTS successfully — see the note above.
		vi.stubGlobal("Intl", {
			...Intl,
			DateTimeFormat: class {
				formatToParts() {
					return [{ type: "literal", value: "x" }];
				}
			},
		});
		expect(zoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo");
	});
});
