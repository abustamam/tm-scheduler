// @vitest-environment jsdom
/**
 * The guest edit dialog's kind / home club / introducer half (#1050, #1060
 * review): the three load states, the "unchanged profile → no profile write"
 * rule, and the half-saved path where the contact write commits and the
 * profile write is refused. And, since #1125, its contact half: the email and
 * phone show read-only with the matching sentence when the club may not change
 * them (a guest's contact is their Person's).
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
	type GuestEditFields,
	PROFILE_NOT_SAVED_PREFIX,
} from "#/components/club/guest-edit-dialog";
import {
	GUEST_CONTACT_REFUSAL_MESSAGES,
	GUEST_CONTACT_REFUSAL_ORDER,
} from "#/lib/guest-contact";

const GUEST: GuestEditFields = {
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
	contactRefusal: null,
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

describe("GuestEditDialog — contact read-only (#1125)", () => {
	const email = () => screen.getByLabelText("Email") as HTMLInputElement;
	const phone = () => screen.getByLabelText("Phone") as HTMLInputElement;
	const locked = () =>
		document.querySelector('[data-slot="guest-contact-locked"]');

	function renderWith(guest: GuestEditFields) {
		const onOpenChange = vi.fn();
		render(
			<GuestEditDialog
				guest={guest}
				clubId="c1"
				open
				onOpenChange={onOpenChange}
			/>,
		);
		return { onOpenChange };
	}

	for (const reason of GUEST_CONTACT_REFUSAL_ORDER) {
		it(`${reason}: the email and phone are read-only and say why, and the name stays editable`, async () => {
			getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: reason });
			renderWith({ ...GUEST, phoneRaw: "+15550001111" });
			await screen.findByLabelText("Kind");
			expect(email().readOnly).toBe(true);
			expect(phone().readOnly).toBe(true);
			expect(locked()?.textContent).toBe(
				GUEST_CONTACT_REFUSAL_MESSAGES[reason],
			);
			expect(email().getAttribute("aria-describedby")).toBe(locked()?.id);
			expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(
				false,
			);
		});
	}

	it("when the club may change the contact: both fields are editable and nothing is said", async () => {
		getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: null });
		renderWith(GUEST);
		await screen.findByLabelText("Kind");
		expect(email().readOnly).toBe(false);
		expect(phone().readOnly).toBe(false);
		expect(locked()).toBeNull();
	});

	const sentData = () =>
		(updateGuest.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;

	it("a name fix on a locked card sends NEITHER email nor phone, so the server leaves the stored contact alone", async () => {
		getGuestProfile.mockResolvedValue({
			...PROFILE,
			contactRefusal: "member_here",
		});
		const { onOpenChange } = renderWith({ ...GUEST, phoneRaw: "+15550001111" });
		await screen.findByLabelText("Kind");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Nadia Farouk-Hassan" },
		});
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(sentData()).toMatchObject({ name: "Nadia Farouk-Hassan" });
		expect(sentData()).not.toHaveProperty("email");
		expect(sentData()).not.toHaveProperty("phone");
	});

	it("a locked card never sends a contact field even if its value is changed (the server would refuse it)", async () => {
		getGuestProfile.mockResolvedValue({
			...PROFILE,
			contactRefusal: "former_member",
		});
		const { onOpenChange } = renderWith({ ...GUEST, phoneRaw: "+15550001111" });
		await screen.findByLabelText("Kind");
		fireEvent.change(email(), { target: { value: "tampered@example.com" } });
		fireEvent.change(phone(), { target: { value: "+15559998888" } });
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(sentData()).not.toHaveProperty("email");
		expect(sentData()).not.toHaveProperty("phone");
	});

	it("a name fix on a locked card with a MALFORMED stored email still saves (a read-only field is not validated)", async () => {
		getGuestProfile.mockResolvedValue({
			...PROFILE,
			contactRefusal: "signed_in",
		});
		const { onOpenChange } = renderWith({
			...GUEST,
			email: "not an address",
		});
		await screen.findByLabelText("Kind");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Nadia F." },
		});
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateGuest).toHaveBeenCalledTimes(1);
		expect(sentData()).not.toHaveProperty("email");
	});

	it("on an editable card a name-only save sends no contact either, so a stale copy cannot overwrite a newer value", async () => {
		getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: null });
		const { onOpenChange } = renderWith({ ...GUEST, phoneRaw: "+15550001111" });
		await screen.findByLabelText("Kind");
		fireEvent.change(screen.getByLabelText("Name"), {
			target: { value: "Nadia Renamed" },
		});
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(sentData()).not.toHaveProperty("email");
		expect(sentData()).not.toHaveProperty("phone");
	});

	it("sends only the field the officer changed, and null when they clear it", async () => {
		getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: null });
		const { onOpenChange } = renderWith({ ...GUEST, phoneRaw: "+15550001111" });
		await screen.findByLabelText("Kind");
		fireEvent.change(email(), { target: { value: "new@example.com" } });
		save();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(sentData()).toMatchObject({ email: "new@example.com" });
		expect(sentData()).not.toHaveProperty("phone");
		cleanup();
		vi.clearAllMocks();
		updateGuest.mockResolvedValue({ ok: true });
		invalidate.mockResolvedValue(undefined);

		getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: null });
		const second = renderWith({ ...GUEST, phoneRaw: "+15550001111" });
		await screen.findByLabelText("Kind");
		fireEvent.change(phone(), { target: { value: "" } });
		save();
		await waitFor(() =>
			expect(second.onOpenChange).toHaveBeenCalledWith(false),
		);
		expect(sentData()).toMatchObject({ phone: null });
		expect(sentData()).not.toHaveProperty("email");
	});

	it("before the read arrives, a reason the caller already holds keeps the fields shut", () => {
		getGuestProfile.mockReturnValue(new Promise(() => {}));
		renderWith({ ...GUEST, contactRefusal: "signed_in" });
		expect(email().readOnly).toBe(true);
		expect(locked()?.textContent).toBe(
			GUEST_CONTACT_REFUSAL_MESSAGES.signed_in,
		);
	});

	it("the fresh read wins over the caller's copy, in both directions", async () => {
		getGuestProfile.mockResolvedValue({ ...PROFILE, contactRefusal: null });
		renderWith({ ...GUEST, contactRefusal: "member_elsewhere" });
		await screen.findByLabelText("Kind");
		await waitFor(() => expect(email().readOnly).toBe(false));
		expect(locked()).toBeNull();
		cleanup();

		getGuestProfile.mockResolvedValue({
			...PROFILE,
			contactRefusal: "member_here",
		});
		renderWith({ ...GUEST, contactRefusal: null });
		await screen.findByLabelText("Kind");
		await waitFor(() => expect(email().readOnly).toBe(true));
		expect(locked()?.textContent).toBe(
			GUEST_CONTACT_REFUSAL_MESSAGES.member_here,
		);
	});

	it("with no read and no reason from the caller the fields stay editable (the server still refuses)", async () => {
		getGuestProfile.mockRejectedValue(new Error("boom"));
		renderWith(GUEST);
		await screen.findByText(/couldn't load this guest's kind/i);
		expect(email().readOnly).toBe(false);
		expect(locked()).toBeNull();
	});
});
