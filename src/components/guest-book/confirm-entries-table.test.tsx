// @vitest-environment jsdom
//
// The confirm table renders the REAL values (#806, AC4).
//
// `record_guest_book` masks everything it returns, because a tool result is
// transcribed into an LLM provider's conversation history. This surface is the
// opposite case and the masking would defeat it: an admin cannot check
// `j•••@x.com` against the handwriting in front of them, and on an ambiguous
// line the email is routinely the only thing distinguishing two guests with one
// name. A mask reaching this component is therefore a feature-level bug that
// nothing else in the suite can see — the server-side half asserts the VIEW is
// unmasked, and this asserts the component then renders it rather than masking
// on the way to the screen.
//
// The drop and resolve cases pin the other half of the page's contract: this
// component holds no state and decides nothing, so every interaction has to
// surface as an edit keyed by the entry's stable id. A drop keyed by ROW INDEX
// would look identical here until a line was dropped, which is exactly the bug
// `src/lib/guest-book-pending.ts` exists to prevent.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingEntry } from "#/lib/guest-book-pending";
import type {
	ConfirmBlockingItem,
	ConfirmLine,
} from "#/server/guest-book-pending-logic";
import { ConfirmEntriesTable } from "./confirm-entries-table";

afterEach(cleanup);

const ENTRIES: PendingEntry[] = [
	{
		id: "e1",
		name: "Vera Real",
		email: "vera@example.com",
		phone: "+15559876543",
	},
	{ id: "e2", name: "Priya Raman", phone: "+15551234567" },
];

const LINES: ConfirmLine[] = [
	{
		entryId: "e1",
		outcome: "new",
		guestId: null,
		via: null,
		matchedName: null,
		minutesRecipient: true,
	},
	{
		entryId: "e2",
		outcome: "ambiguous",
		guestId: null,
		via: null,
		matchedName: null,
		minutesRecipient: false,
	},
];

const BLOCKING: ConfirmBlockingItem[] = [
	{
		code: "AMBIGUOUS_GUEST",
		message: "Entry 1: that phone number is on file under a different name.",
		entryId: "e2",
		candidates: [
			{
				guestId: "g-1",
				name: "Samir Patel",
				email: "samir@example.com",
				phone: "+15551234567",
			},
			{
				guestId: "g-2",
				name: "Samir Patel",
				email: "s.patel@example.com",
				phone: null,
			},
		],
	},
];

function renderTable(overrides: Partial<{ onEdit: () => void }> = {}) {
	const onEdit = overrides.onEdit ?? vi.fn();
	render(
		<ConfirmEntriesTable
			entries={ENTRIES}
			lines={LINES}
			blocking={BLOCKING}
			busy={false}
			onEdit={onEdit}
			draft={() => undefined}
			onDraft={() => {}}
		/>,
	);
	return { onEdit };
}

describe("the confirm table shows the real values (#806)", () => {
	it("renders every transcribed contact field unmasked", () => {
		renderTable();
		expect(screen.getByDisplayValue("vera@example.com")).toBeTruthy();
		expect(screen.getByDisplayValue("+15559876543")).toBeTruthy();
		expect(document.body.textContent).not.toContain("•••");
	});

	it("renders an ambiguity's candidates unmasked, so they can be told apart", () => {
		// TWO guests with the SAME name. The email is the only thing that
		// distinguishes them, so a masked option list would make this question
		// unanswerable while still looking like it had been asked.
		renderTable();
		const options = [...document.querySelectorAll("option")].map(
			(o) => o.textContent ?? "",
		);
		expect(options.some((t) => t.includes("samir@example.com"))).toBe(true);
		expect(options.some((t) => t.includes("s.patel@example.com"))).toBe(true);
		expect(options.join(" ")).not.toContain("•••");
	});

	it("reports a resolution as an edit keyed by the entry's stable id", () => {
		const { onEdit } = renderTable();
		const select = screen.getByLabelText("Resolve Priya Raman");
		fireEvent.change(select, { target: { value: "g-2" } });
		expect(onEdit).toHaveBeenCalledWith({
			kind: "resolve",
			// `e2`, not `1`: dropping a line renumbers positions and would silently
			// re-point this at another row.
			id: "e2",
			resolve: { kind: "existing", guestId: "g-2" },
		});
	});

	it("reports a drop as an edit keyed by the entry's stable id", () => {
		const { onEdit } = renderTable();
		const [drop] = screen.getAllByRole("button", { name: "Drop" });
		fireEvent.click(drop as HTMLElement);
		expect(onEdit).toHaveBeenCalledWith({
			kind: "dropped",
			id: "e1",
			dropped: true,
		});
	});

	it("keeps a dropped line visible, restorable, and out of the plan", () => {
		render(
			<ConfirmEntriesTable
				entries={[{ ...ENTRIES[0], dropped: true } as PendingEntry]}
				lines={[{ ...LINES[0], outcome: null } as ConfirmLine]}
				blocking={[]}
				busy={false}
				onEdit={() => {}}
				draft={() => undefined}
				onDraft={() => {}}
			/>,
		);
		// Still on screen — a drop is reversible, so the row stays where it was
		// rather than vanishing and taking the transcription with it.
		expect(screen.getByDisplayValue("Vera Real")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
		expect(document.body.textContent).toContain("will not be recorded");
	});

	it("restores the stored name rather than sending a blank one", () => {
		// A name has no empty form and the server's validator refuses one, so
		// blanking the box must put the stored value back rather than fire an
		// edit the server will reject and the page will toast about.
		const onEdit = vi.fn();
		const onDraft = vi.fn();
		render(
			<ConfirmEntriesTable
				entries={ENTRIES}
				lines={LINES}
				blocking={BLOCKING}
				busy={false}
				onEdit={onEdit}
				draft={() => undefined}
				onDraft={onDraft}
			/>,
		);
		fireEvent.blur(screen.getByDisplayValue("Vera Real"), {
			target: { value: "   " },
		});
		expect(onEdit).not.toHaveBeenCalled();
		expect(onDraft).toHaveBeenCalledWith("e1", "name", "Vera Real");
	});

	it("shows an emptied draft instead of refilling from the stored value", () => {
		// `draft()` returns `undefined` for "no draft" and `""` for "the reader
		// just cleared this box". Collapsing the two with `||` would make the
		// field refill itself from storage the moment it was emptied.
		render(
			<ConfirmEntriesTable
				entries={ENTRIES}
				lines={LINES}
				blocking={BLOCKING}
				busy={false}
				onEdit={() => {}}
				draft={(id, field) =>
					id === "e1" && field === "email" ? "" : undefined
				}
				onDraft={() => {}}
			/>,
		);
		expect(screen.queryByDisplayValue("vera@example.com")).toBeNull();
	});

	it("disables every control while a save is in flight", () => {
		// Two PATCHes racing on one row would have the second overwrite the
		// first's re-plan, so the table goes inert until the server answers.
		render(
			<ConfirmEntriesTable
				entries={ENTRIES}
				lines={LINES}
				blocking={BLOCKING}
				busy={true}
				onEdit={() => {}}
				draft={() => undefined}
				onDraft={() => {}}
			/>,
		);
		for (const el of screen.getAllByRole("textbox")) {
			expect((el as HTMLInputElement).disabled).toBe(true);
		}
		expect(
			(screen.getByLabelText("Resolve Priya Raman") as HTMLSelectElement)
				.disabled,
		).toBe(true);
		for (const b of screen.getAllByRole("button", { name: "Drop" })) {
			expect((b as HTMLButtonElement).disabled).toBe(true);
		}
	});

	it("does not send an edit when a field is left unchanged", () => {
		// Blur fires on every tab-through. Sending a PATCH for each one would
		// re-plan the page — and hand back a new planHash — for nothing.
		const { onEdit } = renderTable();
		const email = screen.getByDisplayValue("vera@example.com");
		fireEvent.blur(email, { target: { value: "vera@example.com" } });
		expect(onEdit).not.toHaveBeenCalled();
	});
});
