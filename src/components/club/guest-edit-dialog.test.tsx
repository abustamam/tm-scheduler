// @vitest-environment jsdom
/**
 * The guest edit dialog's kind / home club / introducer half (#1050, #1060
 * review): the three load states, the "unchanged profile → no profile write"
 * rule, and the half-saved path where the contact write commits and the
 * profile write is refused.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	updateGuest,
	getGuestProfile,
	updateGuestProfile,
	invalidate,
	toastSuccess,
	toastError,
} = vi.hoisted(() => ({
	updateGuest: vi.fn(),
	getGuestProfile: vi.fn(),
	updateGuestProfile: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/guest-pipeline", () => ({ updateGuest }));
vi.mock("#/server/guests", () => ({ getGuestProfile, updateGuestProfile }));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

import {
	GuestEditDialog,
	PROFILE_NOT_SAVED_PREFIX,
} from "#/components/club/guest-edit-dialog";

const GUEST = {
	id: "g1",
	name: "Nadia Farouk",
	preferredName: null,
	email: "nadia@example.com",
	phoneRaw: null,
	stage: "prospect",
	convertedMembershipId: null,
};

const PROFILE = {
	kind: "guest_speaker" as const,
	homeClub: "Laguna Speakers",
	introducedByMemberId: "m1",
	roster: [
		{ id: "m1", name: "Sam Officer", status: "active" as const },
		{ id: "m2", name: "Lee Lapsed", status: "inactive" as const },
	],
};

function renderDialog(onOpenChange = vi.fn(), onSaved = vi.fn()) {
	render(
		<GuestEditDialog
			guest={GUEST}
			clubId="c1"
			open
			onOpenChange={onOpenChange}
			onSaved={onSaved}
		/>,
	);
	return { onOpenChange, onSaved };
}

const save = () =>
	fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

beforeEach(() => {
	updateGuest.mockResolvedValue({ ok: true });
	updateGuestProfile.mockResolvedValue({ ok: true });
	invalidate.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("GuestEditDialog — profile load states", () => {
	it("while loading: says so, and Save still works for name and contact", async () => {
		getGuestProfile.mockReturnValue(new Promise(() => {}));
		const { onOpenChange } = renderDialog();
		expect(
			document.querySelector('[data-slot="guest-profile-loading"]'),
		).not.toBeNull();
		const button = screen.getByRole("button", {
			name: /save changes/i,
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(false);
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateGuest).toHaveBeenCalledTimes(1);
		expect(updateGuestProfile).not.toHaveBeenCalled();
	});

	it("when the read fails: says so, and saving skips the profile write", async () => {
		getGuestProfile.mockRejectedValue(new Error("boom"));
		const { onOpenChange } = renderDialog();
		await screen.findByText(/couldn't load this guest's kind/i);
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateGuestProfile).not.toHaveBeenCalled();
	});

	it("when ready: prefills kind, home club and introducer; the roster marks inactive members", async () => {
		getGuestProfile.mockResolvedValue(PROFILE);
		renderDialog();
		const kind = (await screen.findByLabelText("Kind")) as HTMLSelectElement;
		expect(kind.value).toBe("guest_speaker");
		expect((screen.getByLabelText("Home club") as HTMLInputElement).value).toBe(
			"Laguna Speakers",
		);
		const introducer = screen.getByLabelText(
			"Introduced by",
		) as HTMLSelectElement;
		expect(introducer.value).toBe("m1");
		expect(
			screen.getByRole("option", { name: "Lee Lapsed (inactive)" }),
		).toBeTruthy();
	});

	it("hides the home club for a Visitor", async () => {
		getGuestProfile.mockResolvedValue(PROFILE);
		renderDialog();
		const kind = await screen.findByLabelText("Kind");
		fireEvent.change(kind, { target: { value: "visitor" } });
		expect(screen.queryByLabelText("Home club")).toBeNull();
	});
});

describe("GuestEditDialog — when the profile is written", () => {
	it("a name-only save makes NO profile call", async () => {
		getGuestProfile.mockResolvedValue(PROFILE);
		const { onOpenChange } = renderDialog();
		await screen.findByLabelText("Kind");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Nadia Farouq" },
		});
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateGuest).toHaveBeenCalledTimes(1);
		expect(updateGuestProfile).not.toHaveBeenCalled();
	});

	it("a changed field sends all three, a Visitor's home club as null", async () => {
		getGuestProfile.mockResolvedValue(PROFILE);
		const { onOpenChange } = renderDialog();
		const kind = await screen.findByLabelText("Kind");
		fireEvent.change(kind, { target: { value: "visitor" } });
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateGuestProfile).toHaveBeenCalledWith({
			data: {
				clubId: "c1",
				guestId: "g1",
				kind: "visitor",
				homeClub: null,
				introducedByMemberId: "m1",
			},
		});
		expect(toastSuccess).toHaveBeenCalledWith("Guest updated.");
	});
});

describe("GuestEditDialog — contact saved, profile refused", () => {
	it("refreshes anyway, says which half saved, and stays open", async () => {
		getGuestProfile.mockResolvedValue(PROFILE);
		updateGuestProfile.mockRejectedValue(
			new Error(
				"The member who introduced this guest must be on this club's roster.",
			),
		);
		const { onOpenChange, onSaved } = renderDialog();
		const introducer = await screen.findByLabelText("Introduced by");
		fireEvent.change(introducer, { target: { value: "m2" } });
		save();
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		// The committed contact edit is not left stale for the next open.
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith(
			`${PROFILE_NOT_SAVED_PREFIX} The member who introduced this guest must be on this club's roster.`,
		);
		expect(PROFILE_NOT_SAVED_PREFIX).toMatch(/Name and contact saved/);
		expect(toastSuccess).not.toHaveBeenCalled();
		// Open, on the profile fields.
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(screen.getByLabelText("Introduced by")).toBeTruthy();
	});
});
