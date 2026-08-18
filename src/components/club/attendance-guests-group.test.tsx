// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
