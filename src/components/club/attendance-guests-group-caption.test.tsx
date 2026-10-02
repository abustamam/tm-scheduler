// @vitest-environment jsdom
/**
 * The roll-mode Guests group shows a guest's kind caption (#1080) — "Guest
 * speaker, Downtown Toastmasters" — beside their name, the guest-book half of
 * what #1059 / #1081 shipped on the agenda.
 *
 * Beside `attendance-guests-group.test.tsx` rather than in it: the rows here
 * are built to carry (or deliberately lack) `MinutesGuestRow.caption`, and
 * the three "reads exactly as before" cases are the acceptance criteria, not
 * incidental fixtures. Where the string COMES from is `loadMinutes`'s business
 * (`minutes-guest-caption.integration.test.ts`); this suite only proves the
 * group renders what the row says and nothing when it says nothing.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinutesGuestRow } from "#/server/minutes-logic";

// The group renders the shared `GuestEditDialog` (#727), whose server-fn
// imports reach `#/db` → `pg` → `DATABASE_URL` at import time, unset under
// jsdom. Same stubs as attendance-guests-group.test.tsx, for the same reason.
vi.mock("#/server/guest-pipeline", () => ({ updateGuest: vi.fn() }));
vi.mock("#/server/guests", () => ({
	getGuestProfile: vi.fn().mockResolvedValue(null),
	updateGuestProfile: vi.fn(),
}));

import { AttendanceGuestsGroup } from "#/components/club/attendance-guests-group";

const CAPTION = "Guest speaker, Downtown Toastmasters";

/** The capability an officer arrives with (#727): the permission AND the
 *  stored fields the dialog would prefill from. Only its PRESENCE matters
 *  here — it is what turns the name into a control. */
const GUEST_EDIT = {
	clubId: "c1",
	onSaved: vi.fn(),
	fields: {
		g1: {
			id: "g1",
			name: "Nadia Farouk",
			preferredName: null,
			email: null,
			phoneRaw: null,
			stage: "prospect",
			convertedMembershipId: null,
		},
	},
};

function renderGuests(
	guests: MinutesGuestRow[],
	extra: { guestEdit?: typeof GUEST_EDIT } = {},
) {
	return render(
		<AttendanceGuestsGroup
			guests={guests}
			clubGuests={[]}
			locked={false}
			onAddGuest={vi.fn()}
			onRemoveGuest={vi.fn()}
			{...extra}
		/>,
	);
}

/** The badge a guest renders as, found from the name it carries. With no
 *  edit capability the name is a bare text node, so `getByText` returns the
 *  badge itself; with one it returns the `aria-hidden` span inside the
 *  control, and `closest` walks up to the badge either way. */
function badgeFor(name: string): HTMLElement {
	const badge = screen.getByText(name).closest('[data-slot="badge"]');
	if (!(badge instanceof HTMLElement)) throw new Error(`no badge for ${name}`);
	return badge;
}

describe("AttendanceGuestsGroup guest kind caption (#1080)", () => {
	// vitest here runs without `globals`, so testing-library's auto-cleanup
	// never registers; every component suite in this repo carries this line.
	afterEach(() => cleanup());

	it("reads 'Guest speaker, <home club>' beside a guest who holds a role (criterion 1)", () => {
		renderGuests([
			{ guestId: "g1", name: "Nadia Farouk", fromRole: true, caption: CAPTION },
		]);
		const caption = screen.getByText(CAPTION);
		expect(badgeFor("Nadia Farouk").contains(caption)).toBe(true);
		// The caption is capped to one line of the badge with an ellipsis, so
		// the FULL string has to survive somewhere a hover can reach it.
		expect(caption.getAttribute("title")).toBe(CAPTION);
	});

	it("captions an explicitly-added guest too, not only a role holder", () => {
		// The issue asks for "at least" the `fromRole` guest. A guest speaker an
		// officer added by hand is no less a guest speaker, and the caption is
		// the row's, so the group reads it wherever the row carries it.
		renderGuests([
			{
				guestId: "g1",
				name: "Nadia Farouk",
				fromRole: false,
				caption: CAPTION,
			},
		]);
		expect(badgeFor("Nadia Farouk").contains(screen.getByText(CAPTION))).toBe(
			true,
		);
	});

	it("reads EXACTLY as before for a row with no caption key — a Visitor, or an offline snapshot from before the field (criteria 2 and 3)", () => {
		// `fromRole: true` and no mode toggle, so the badge's only text IS the
		// name: any separator or caption rendered for an absent field shows up
		// as extra characters here.
		renderGuests([{ guestId: "g1", name: "Nadia Farouk", fromRole: true }]);
		expect(badgeFor("Nadia Farouk").textContent).toBe("Nadia Farouk");
		expect(screen.queryByText("·")).toBeNull();
	});

	it("reads EXACTLY as before for an explicit `caption: null`", () => {
		renderGuests([
			{ guestId: "g1", name: "Nadia Farouk", fromRole: true, caption: null },
		]);
		expect(badgeFor("Nadia Farouk").textContent).toBe("Nadia Farouk");
		expect(screen.queryByText("·")).toBeNull();
	});

	it("keeps the caption OUTSIDE the name control an officer taps to edit (#727)", () => {
		renderGuests(
			[
				{
					guestId: "g1",
					name: "Nadia Farouk",
					fromRole: true,
					caption: CAPTION,
				},
			],
			{ guestEdit: GUEST_EDIT },
		);
		// The control's accessible name is the PERSON; a club's name is not
		// part of who to tap, and must not land inside the button's content.
		const control = screen.getByRole("button", {
			name: "Edit Nadia Farouk's details",
		});
		expect(control.textContent).not.toContain(CAPTION);
		// ...while the caption still sits in the same badge, beside it.
		const caption = screen.getByText(CAPTION);
		expect(control.contains(caption)).toBe(false);
		expect(badgeFor("Nadia Farouk").contains(caption)).toBe(true);
	});

	it("captions each guest from their OWN row when several are listed", () => {
		renderGuests([
			{
				guestId: "g1",
				name: "Nadia Farouk",
				fromRole: true,
				caption: "Visiting Toastmaster, Laguna Speakers",
			},
			{ guestId: "g2", name: "Tom Reyes", fromRole: false },
			{ guestId: "g3", name: "Priya Nair", fromRole: true, caption: CAPTION },
		]);
		expect(
			badgeFor("Nadia Farouk").contains(
				screen.getByText("Visiting Toastmaster, Laguna Speakers"),
			),
		).toBe(true);
		expect(badgeFor("Tom Reyes").textContent).toBe("Tom Reyes");
		expect(badgeFor("Priya Nair").contains(screen.getByText(CAPTION))).toBe(
			true,
		);
	});
});
