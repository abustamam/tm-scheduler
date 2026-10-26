// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

function open(unavailableMemberIds: string[]) {
	render(
		<TableTopicsCapture
			speakers={[]}
			canEdit={true}
			busy={false}
			roster={[
				{ memberId: "a", name: "Ada Here" },
				{ memberId: "b", name: "Bo Absent" },
			]}
			unavailableMemberIds={unavailableMemberIds}
			clubGuests={[]}
			onAdd={() => {}}
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
