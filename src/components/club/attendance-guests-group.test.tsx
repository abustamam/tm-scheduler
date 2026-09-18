// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// The group renders the shared `GuestEditDialog` (#727), which imports the
// `updateGuest` server fn — and a server-fn module reaches `#/db` → `pg` →
// `DATABASE_URL` at import time, which is unset under jsdom. Stubbing it is
// what lets this suite mount the group at all; it is also the seam the edit
// test asserts the payload at. `vi.mock` factories are hoisted above imports,
// so the fns come from `vi.hoisted` rather than a plain top-level const (see
// season-grid.test.tsx).
const { updateGuest, toastSuccess, toastError, onSavedSpy } = vi.hoisted(
	() => ({
		updateGuest: vi.fn(async () => ({ ok: true })),
		toastSuccess: vi.fn(),
		toastError: vi.fn(),
		onSavedSpy: vi.fn(async () => {}),
	}),
);
vi.mock("#/server/guest-pipeline", () => ({ updateGuest }));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

import { AttendanceGuestsGroup } from "#/components/club/attendance-guests-group";

// cmdk measures its list on mount and scrolls the active item into view;
// jsdom has neither API, so the popover's Command cannot render without
// these (see nudge-recruit-picker.test.tsx for the same stub).
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

const base = {
	guests: [{ guestId: "g1", name: "Nadia Farouk", fromRole: false }],
	clubGuests: [
		{ id: "g1", name: "Nadia Farouk" },
		{ id: "g2", name: "Tom Reyes" },
	],
	locked: false,
	onAddGuest: vi.fn(),
	onRemoveGuest: vi.fn(),
};

/** The capability an admin viewer arrives with (#727) — the permission AND the
 *  stored fields, because the dialog prefills from them and a blank field saves
 *  as `null`. `phoneRaw` is deliberately NOT a valid E.164 string: it is the
 *  column verbatim, and binding the form to a coalesced display value instead
 *  would still render a plausible number, so only a fixture where the two
 *  differ can tell the bindings apart. */
const GUEST_EDIT = {
	clubId: "c1",
	// The refresher the capability REQUIRES. Its own test below drives it; the
	// rest of the suite only needs it to exist, which is the compiler's point.
	onSaved: onSavedSpy,
	fields: {
		g1: {
			id: "g1",
			name: "Nadia Farouk",
			preferredName: "Nadi",
			email: "nadia@example.com",
			phoneRaw: "415-555-2671 x12",
			stage: "prospect",
			convertedMembershipId: null,
		},
	},
};

describe("AttendanceGuestsGroup", () => {
	// vitest here runs without `globals`, so testing-library's auto-cleanup never
	// registers and renders leak between tests. Every component suite in this repo
	// carries this line explicitly — see meeting-attendance-panel.test.tsx.
	afterEach(() => cleanup());

	it("lists the guests present and offers to add one", () => {
		const { getByText, getByRole } = render(
			<AttendanceGuestsGroup {...base} />,
		);
		getByText("Nadia Farouk");
		getByRole("button", { name: /Add guest/i });
	});

	it("adds an EXISTING club guest by id", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByRole } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		// Radix's PopoverTrigger opens on `pointerdown`, not a bare `click` —
		// `userEvent.click` replays the real pointer sequence. Capture the trigger
		// BEFORE opening: the new-guest form's submit button shares its accessible
		// name, so `getByRole("button", { name: /Add guest/i })` throws on ambiguity
		// once the popover is open.
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		// `CommandItem` (cmdk) renders `role="option"`. Selection goes through
		// cmdk's own handler, so a plain click is right here.
		fireEvent.click(await findByRole("option", { name: /Tom Reyes/ }));
		// `guestId` path, not `newGuest` — adding an existing guest again must not
		// create a duplicate person in the club's pipeline (ADR-0018).
		expect(onAddGuest).toHaveBeenCalledWith({ guestId: "g2" });
	});

	it("excludes a club guest already present at the meeting from the add-picker", async () => {
		const { getByRole, queryByRole } = render(
			<AttendanceGuestsGroup {...base} />,
		);
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		expect(queryByRole("option", { name: /Nadia Farouk/i })).toBeNull();
	});

	it("creates a NEW guest from a typed name, carrying email and phone", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByLabelText, getByLabelText } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		const trigger = getByRole("button", { name: /Add guest/i });
		await userEvent.click(trigger);
		fireEvent.change(await findByLabelText(/New guest name/i), {
			target: { value: "Wale Adeyemi" },
		});
		fireEvent.change(getByLabelText(/Guest email/i), {
			target: { value: "wale@example.com" },
		});
		fireEvent.change(getByLabelText(/Guest phone/i), {
			target: { value: "555-1234" },
		});
		// Submit through the FORM, not by name — the submit button and the trigger
		// are both "Add guest", and this asserts the form's own submit path.
		fireEvent.submit(
			getByLabelText(/New guest name/i).closest("form") as HTMLFormElement,
		);
		// email/phone must survive. Task 6 deletes the old AttendanceSection, so a
		// name-only payload here is a silent capability regression, not a
		// simplification.
		expect(onAddGuest).toHaveBeenCalledWith({
			newGuest: {
				name: "Wale Adeyemi",
				email: "wale@example.com",
				phone: "555-1234",
			},
		});
	});

	it("refuses to submit a whitespace-only name", async () => {
		const onAddGuest = vi.fn();
		const { getByRole, findByLabelText, getByLabelText } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		// Whitespace, NOT empty: `required` already blocks empty, so an empty-string
		// fixture would pass with the trim guard deleted.
		fireEvent.change(await findByLabelText(/New guest name/i), {
			target: { value: "   " },
		});
		fireEvent.submit(
			getByLabelText(/New guest name/i).closest("form") as HTMLFormElement,
		);
		expect(onAddGuest).not.toHaveBeenCalled();
	});

	it("disables the actions on a locked meeting rather than hiding them", () => {
		const { getByRole } = render(
			<AttendanceGuestsGroup {...base} locked={true} />,
		);
		expect(
			getByRole("button", { name: /Add guest/i }).hasAttribute("disabled"),
		).toBe(true);
		expect(
			getByRole("button", { name: /Remove Nadia Farouk/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("refuses the new-guest submit while locked, without relying on the disabled button", async () => {
		// Round 2, F2. The submit button is disabled when locked and browsers honour
		// that for implicit Enter submission, so this is hardening — but `locked` now
		// also carries the offline queue's refuse-while-busy signal (the panel passes
		// `writesLocked || busy`), so "the button is disabled" and "this write will be
		// accepted" have stopped being the same question, and the closure that
		// performs the write should state its own precondition.
		//
		// MECHANISM, same as the roll menu's items: a locked group cannot have its
		// popover OPENED (the trigger is disabled), so the form would never render and
		// any assertion would pass vacuously. Open it while unlocked, then `rerender`
		// with `locked` — Radix keeps `open` in the Popover root's own state. Then
		// submit the FORM directly, which is exactly what bypasses the disabled
		// button, and is the only way to observe the guard at all.
		const onAddGuest = vi.fn();
		const { getByRole, findByLabelText, getByLabelText, rerender } = render(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} />,
		);
		await userEvent.click(getByRole("button", { name: /Add guest/i }));
		const nameField = await findByLabelText(/New guest name/i);
		fireEvent.change(nameField, { target: { value: "Wale Adeyemi" } });

		rerender(
			<AttendanceGuestsGroup {...base} onAddGuest={onAddGuest} locked={true} />,
		);
		// Proof the popover really is still open and the form still mounted — without
		// this, a closed popover would make the submit below unobservable and the
		// assertion meaningless.
		const form = getByLabelText(/New guest name/i).closest(
			"form",
		) as HTMLFormElement;
		expect(form).not.toBeNull();
		fireEvent.submit(form);
		expect(onAddGuest).not.toHaveBeenCalled();
	});

	it("removes a guest by id when the remove control is tapped", async () => {
		// `onRemoveGuest` was a `vi.fn()` in the shared fixture that nothing ever
		// asserted had fired: two tests checked whether the control was DISABLED or
		// ABSENT, and none that tapping it does anything. So the handler could have
		// been unwired — or wired to the wrong guest — with this suite green.
		const onRemoveGuest = vi.fn();
		const { getByRole } = render(
			<AttendanceGuestsGroup
				{...base}
				guests={[
					{ guestId: "g1", name: "Nadia Farouk", fromRole: false },
					{ guestId: "g2", name: "Tom Reyes", fromRole: false },
				]}
				onRemoveGuest={onRemoveGuest}
			/>,
		);
		// The SECOND row deliberately: a handler that closed over the wrong guest
		// (the first, or the last) passes a one-row fixture.
		await userEvent.click(getByRole("button", { name: /Remove Tom Reyes/i }));
		expect(onRemoveGuest).toHaveBeenCalledWith("g2");
		expect(onRemoveGuest).toHaveBeenCalledTimes(1);
	});

	it("gives the remove control a hit area that clears the 24px minimum (F9)", () => {
		// WCAG 2.5.8. The box was `p-1` around a `size-3` glyph — 20px — on a control
		// tapped on a phone mid-meeting. jsdom performs no layout, so the RENDERED box
		// is not measurable here (see CLAUDE.md's jsdom-has-no-layout trap); what is
		// assertable is that the size is stated on the element rather than inherited
		// from whatever the icon happens to be, which is the property that made 20px
		// possible. `size-6` is 1.5rem = 24px.
		const { getByRole } = render(<AttendanceGuestsGroup {...base} />);
		const remove = getByRole("button", { name: /Remove Nadia Farouk/i });
		expect(remove.className).toContain("size-6");
		expect(remove.className).not.toContain("p-1");
	});

	// #727. The name is the only handle a VPM has on this page for a guest whose
	// details are wrong, and the gate on it is the CALLER's — a server-resolved
	// capability, since this group renders on a route that is not `_authed`.
	describe("editing a guest from the rail (#727)", () => {
		it("renders the name as PLAIN TEXT with no capability, and offers no dialog", () => {
			const { getByText, queryByRole } = render(
				<AttendanceGuestsGroup {...base} />,
			);
			// Present as text…
			getByText("Nadia Farouk");
			// …and not as a control. Asserted as an ABSENCE of any button naming
			// this guest other than Remove, because "no disabled control that hints
			// at what they cannot do" is the actual requirement.
			expect(queryByRole("button", { name: /Edit Nadia Farouk/i })).toBeNull();
		});

		it("renders the name as a control WITH the capability, and opens the dialog on it", async () => {
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup {...base} guestEdit={GUEST_EDIT} />,
			);
			// No dialog before the click — the rail must not carry a visitor's
			// contact details in the DOM for a list nobody has touched.
			expect(screen.queryByRole("dialog")).toBeNull();
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			expect(await screen.findByRole("dialog")).toBeTruthy();
			// Prefilled from the STORED fields, not from the one thing the rail
			// already had (the name). An unseeded field is blank and blank saves as
			// null, so this assertion is the difference between "fix a typo" and
			// "wipe this guest's contact details".
			expect((screen.getByLabelText("Goes by") as HTMLInputElement).value).toBe(
				"Nadi",
			);
			expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
				"nadia@example.com",
			);
			expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe(
				"415-555-2671 x12",
			);
		});

		it("gives the name control a hit area that clears the 24px minimum", async () => {
			// WCAG 2.5.8, and the same reasoning the remove control's `size-6` carries
			// — this is tapped on a phone, mid-meeting, beside a control that already
			// meets it. jsdom performs no layout, so the rendered box is not
			// measurable here; what is assertable is that the height is STATED, and
			// that the display type which makes `min-h-` mean anything is stated with
			// it. A `min-h-6` on a bare inline button is a no-op.
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup {...base} guestEdit={GUEST_EDIT} />,
			);
			const name = screen.getByRole("button", { name: /Edit Nadia Farouk/i });
			expect(name.className).toContain("min-h-6");
			expect(name.className).toContain("inline-flex");
		});

		it("offers NO delete from the rail", async () => {
			// Criterion 9. Fixing a typo mid-meeting is the use case; deleting a
			// person's record is not, and the rail's own "Remove Nadia Farouk" is a
			// different action (it removes them from THIS meeting) which stays.
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup {...base} guestEdit={GUEST_EDIT} />,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			await screen.findByRole("dialog");
			expect(screen.queryByRole("button", { name: /^Delete/i })).toBeNull();
		});

		it("saves through updateGuest, carrying the club and the guest it was opened for", async () => {
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guests={[
						{ guestId: "g0", name: "Someone Else", fromRole: false },
						{ guestId: "g1", name: "Nadia Farouk", fromRole: false },
					]}
					guestEdit={GUEST_EDIT}
				/>,
			);
			// The SECOND row deliberately, and the first row has no fields entry at
			// all: a handler closing over the wrong guest passes a one-row fixture,
			// and a group that ignored the map would offer a control for a guest it
			// cannot prefill.
			expect(screen.queryByRole("button", { name: /Edit Someone Else/i })).toBe(
				null,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			fireEvent.change(await screen.findByLabelText("Name"), {
				target: { value: "Nadia Farouq" },
			});
			fireEvent.submit(
				screen.getByLabelText("Name").closest("form") as HTMLFormElement,
			);
			await vi.waitFor(() => expect(updateGuest).toHaveBeenCalledTimes(1));
			expect(updateGuest).toHaveBeenCalledWith({
				data: {
					clubId: "c1",
					guestId: "g1",
					name: "Nadia Farouq",
					preferredName: "Nadi",
					email: "nadia@example.com",
					phone: "415-555-2671 x12",
				},
			});
		});

		it("refreshes the rows the prefill comes from, and only closes once it has", async () => {
			// The second-save-reverts-the-first bug, and the reason `onSaved` is
			// REQUIRED on the capability rather than optional.
			//
			// `GuestEditDialog` calls `router.invalidate()`, which re-runs route
			// LOADERS. The rail's `fields` do not come from a loader — they come
			// from a TanStack Query entry the route owns — so `invalidate()` cannot
			// reach them. Without `onSaved` the badge NAME refreshed (that is
			// loader-backed) while the dialog kept prefilling the PRE-EDIT email,
			// phone and goes-by; the next save then wrote those stale values back
			// over the edit that had just landed. Silent data loss, and the same
			// hazard a blank prefill causes, one step further on.
			// A GATED refresher, held open until this test releases it. An
			// immediately-resolving spy cannot see the ordering at all: every await
			// after it is a microtask, so by the time an assertion runs the dialog
			// has already closed either way, and the test passes on both orders.
			let release: (() => void) | undefined;
			const gatedOnSaved = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						release = resolve;
					}),
			);
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guestEdit={{ ...GUEST_EDIT, onSaved: gatedOnSaved }}
				/>,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			fireEvent.submit(
				(await screen.findByLabelText("Name")).closest(
					"form",
				) as HTMLFormElement,
			);
			await vi.waitFor(() => expect(gatedOnSaved).toHaveBeenCalledTimes(1));
			// ORDER, not merely "it was called": the refresh is AWAITED before the
			// close, so the modal keeps the surface behind it inert for the whole
			// write-and-refetch window. Closing first re-arms the call site's other
			// controls mid-flight — the VP Membership drift that reordering fixed.
			expect(
				screen.queryByRole("dialog"),
				"onSaved must be awaited while the dialog is still open — closing " +
					"first drops the modal's in-flight guard for the length of the refetch",
			).not.toBeNull();
			// …and it does eventually close, so the assertion above is not passing
			// on a dialog that simply never closes.
			release?.();
			await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		});

		it("re-reads the row on REOPEN, so a second save carries the first one's values", async () => {
			// The other half: the group must hold the guest's ID, not a captured row.
			// A captured object would keep rendering the pre-edit values however
			// faithfully `onSaved` refreshed the map behind it — and a form field
			// showing a stale value SAVES that stale value.
			const { rerender } = render(
				<AttendanceGuestsGroup {...base} guestEdit={GUEST_EDIT} />,
			);
			// OPEN once first, so the group has had the chance to capture a row.
			// Without this the test cannot tell "re-reads on every open" from
			// "reads the current props the first time", and a group that
			// snapshotted the row on open would pass it.
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			expect(
				((await screen.findByLabelText("Goes by")) as HTMLInputElement).value,
			).toBe("Nadi");
			await userEvent.keyboard("{Escape}");
			await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

			// The refreshed map, as the route would hand it back after `onSaved`.
			const refreshed = {
				...GUEST_EDIT,
				fields: {
					g1: {
						...GUEST_EDIT.fields.g1,
						preferredName: "Nads",
						email: "nadia.new@example.com",
					},
				},
			};
			rerender(<AttendanceGuestsGroup {...base} guestEdit={refreshed} />);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			expect(
				(await screen.findByLabelText("Goes by")) as HTMLInputElement,
			).toHaveProperty("value", "Nads");
			expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
				"nadia.new@example.com",
			);
		});

		it("tells the officer when the guest has already JOINED the roster", async () => {
			// The dropped-prop bug, and why `joined` is derived from the row rather
			// than passed. `applyConvertGuestToMember` re-points role slots and sets
			// `stage: "joined"` but never touches `meeting_attendance`, so a visitor
			// who joins at tonight's meeting is still on tonight's rail with an edit
			// control — and the officer fixing an email needs telling they are
			// editing the dead guest row, not the new member's roster record.
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guestEdit={{
						...GUEST_EDIT,
						fields: {
							g1: {
								...GUEST_EDIT.fields.g1,
								stage: "joined",
								convertedMembershipId: "mem-1",
							},
						},
					}}
				/>,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			expect(
				(await screen.findByRole("dialog")).textContent,
				"a joined guest's dialog must say their roster details are edited " +
					"on the roster — the rail's call site used to omit the `joined` " +
					"prop and silently got the visitor copy",
			).toMatch(/already a member/i);
		});

		it("does NOT claim a STRANDED conversion is a member (#618)", async () => {
			// `stage: "joined"` with a null pointer means the membership was removed
			// from the roster after the convert. Reading the stage alone would tell
			// the officer to go edit a roster record that no longer exists. Same
			// predicate VP Membership uses to decide whether to offer Delete.
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guestEdit={{
						...GUEST_EDIT,
						fields: {
							g1: {
								...GUEST_EDIT.fields.g1,
								stage: "joined",
								convertedMembershipId: null,
							},
						},
					}}
				/>,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			expect((await screen.findByRole("dialog")).textContent).not.toMatch(
				/already a member/i,
			);
		});

		it("surfaces a REFUSED write, keeps the dialog open, and claims no success", async () => {
			// The catch branch, untested until now — including the one refusal that
			// actually happens: `applyUpdateGuest` rejects a phone or email that
			// already belongs to another club guest, because `captureGuestVisit`
			// dedups on exactly those keys and allowing the clash would leave two
			// rows matching one submission.
			updateGuest.mockRejectedValueOnce(
				new Error("Another guest already uses that phone number."),
			);
			toastError.mockClear();
			toastSuccess.mockClear();
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup {...base} guestEdit={GUEST_EDIT} />,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			fireEvent.submit(
				(await screen.findByLabelText("Name")).closest(
					"form",
				) as HTMLFormElement,
			);
			await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
			// The SERVER's message, not a generic one — it names the clash, which is
			// the only thing that tells the officer which field to change.
			expect(toastError).toHaveBeenCalledWith(
				"Another guest already uses that phone number.",
			);
			// No success toast for a write that did not happen, and the dialog stays
			// up so the field they just typed is still there to fix.
			expect(toastSuccess).not.toHaveBeenCalled();
			expect(screen.queryByRole("dialog")).not.toBeNull();
		});

		it("does not double-toast when the REFRESH fails after a committed write", async () => {
			// The two phases fail in different worlds. One `try` around both fired
			// success-then-error for a single action, over a change that was already
			// in the database — and "something went wrong" about a committed write
			// is the more damaging of the two errors.
			toastError.mockClear();
			toastSuccess.mockClear();
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guestEdit={{
						...GUEST_EDIT,
						onSaved: vi.fn(async () => {
							throw new Error("network");
						}),
					}}
				/>,
			);
			await userEvent.click(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			);
			fireEvent.submit(
				(await screen.findByLabelText("Name")).closest(
					"form",
				) as HTMLFormElement,
			);
			await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			expect(toastSuccess).toHaveBeenCalledTimes(1);
			expect(
				toastError,
				"a refresh failure must not be reported as a failed save — the write " +
					"committed, the view is merely stale",
			).not.toHaveBeenCalled();
		});

		it("still edits a guest who is present because of a role", async () => {
			// `fromRole` omits the REMOVE control (they hold a slot; removing their
			// attendance desyncs two surfaces) and says nothing about their record
			// being wrong. A gate that reused `fromRole` here would leave exactly
			// the guest most visible on the agenda uneditable.
			await renderUnderMemoryRouter(
				<AttendanceGuestsGroup
					{...base}
					guests={[{ guestId: "g1", name: "Nadia Farouk", fromRole: true }]}
					guestEdit={GUEST_EDIT}
				/>,
			);
			expect(
				screen.queryByRole("button", { name: /Remove Nadia Farouk/i }),
			).toBe(null);
			expect(
				screen.getByRole("button", { name: /Edit Nadia Farouk/i }),
			).toBeTruthy();
		});
	});

	it("OMITS the remove control for a guest who is present because of a role", () => {
		// `fromRole` and `locked` are different things: locked disables, fromRole
		// omits. A role-holder removed from attendance desyncs the two surfaces.
		const { queryByRole, getByText } = render(
			<AttendanceGuestsGroup
				{...base}
				guests={[{ guestId: "g3", name: "Priya Nair", fromRole: true }]}
			/>,
		);
		getByText("Priya Nair");
		expect(queryByRole("button", { name: /Remove Priya Nair/i })).toBeNull();
	});
});
