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
