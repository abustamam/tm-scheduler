// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableTopicsCapture } from "./table-topics-capture";

afterEach(cleanup);

class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
// cmdk and Radix popovers need these in jsdom.
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

function open(
	unavailableMemberIds: string[],
	extra: {
		roster?: {
			memberId: string;
			name: string;
			preferredName?: string | null;
		}[];
		onAdd?: (p: unknown) => void;
	} = {},
) {
	render(
		<TableTopicsCapture
			speakers={[]}
			canEdit={true}
			busy={false}
			roster={
				extra.roster ?? [
					{ memberId: "a", name: "Ada Here" },
					{ memberId: "b", name: "Bo Absent" },
				]
			}
			unavailableMemberIds={unavailableMemberIds}
			clubGuests={[]}
			onAdd={extra.onAdd ?? (() => {})}
			onRemove={() => {}}
			onMove={() => {}}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "+ Add speaker" }));
}

describe("TableTopicsCapture unavailable members (#1319)", () => {
	it("does not list a member whose id is unavailable", () => {
		// protects: the shared rule, applied inside the component both mounting
		//   sites use, hides (not greys out) an unavailable member.
		// fails_when: the roster is handed to the picker unfiltered.
		// no_claim: how the ids are computed (server) or passed (route guard).
		open(["b"]);
		expect(screen.getByText("Ada Here")).toBeTruthy();
		expect(screen.queryByText("Bo Absent")).toBeNull();
	});

	it("lists everyone when nobody is unavailable", () => {
		// protects: the filter removes only the named ids.
		// fails_when: the filter drops the whole roster.
		// no_claim: nothing about awards pickers, which do not use this prop.
		open([]);
		expect(screen.getByText("Ada Here")).toBeTruthy();
		expect(screen.getByText("Bo Absent")).toBeTruthy();
	});
});

describe("TableTopicsCapture picker (#1332)", () => {
	it("finds a member by preferred name", async () => {
		// protects: AC7, "+ Add speaker" matches the name a member goes by.
		// fails_when: preferredName is not forwarded from the roster to the picker.
		// no_claim: the route/minutes plumbing that fills preferredName.
		open([], {
			roster: [
				{ memberId: "r", name: "Robert Smith", preferredName: "Bob" },
				{ memberId: "o", name: "Olive Other" },
			],
		});
		await userEvent.type(
			screen.getByPlaceholderText("Search members and guests…"),
			"bob",
		);
		expect(screen.getAllByRole("option")).toHaveLength(1);
		expect(screen.getByRole("option").textContent).toContain("goes by Bob");
	});

	it("never brings back a hidden member, whatever is typed", async () => {
		// protects: AC6, #1319's hidden members are removed before the picker sees them.
		// fails_when: the filter moves after the picker, or typing re-includes the row.
		// no_claim: how unavailableMemberIds is computed.
		open(["b"]);
		await userEvent.type(
			screen.getByPlaceholderText("Search members and guests…"),
			"Bo Absent",
		);
		expect(screen.queryByText("Bo Absent")).toBeNull();
	});

	it("still submits the new-guest form", async () => {
		// protects: the new-guest form survives the picker swap.
		// fails_when: the form is removed or its onPick payload changes shape.
		// no_claim: the server creating the guest.
		const onAdd = vi.fn();
		open([], { onAdd });
		await userEvent.type(screen.getByLabelText("New guest name"), "Gia");
		await userEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(onAdd).toHaveBeenCalledWith(
			expect.objectContaining({ newGuest: { name: "Gia" } }),
		);
	});
});
