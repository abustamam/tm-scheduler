// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonPicker, type PickerPerson } from "./person-picker";

class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

function setup(people: PickerPerson[], extra: { disabled?: boolean } = {}) {
	const onPick = vi.fn();
	const user = userEvent.setup();
	render(
		<PersonPicker
			people={people}
			onPick={onPick}
			placeholder="Search"
			emptyText="Nobody"
			{...extra}
		/>,
	);
	return { onPick, user };
}

const optionNames = () =>
	screen.queryAllByRole("option").map((o) => o.textContent ?? "");

describe("PersonPicker (#1332)", () => {
	it("lists Members before Guests, and a guest exact match never outranks a member", async () => {
		// protects: groups come first; order inside a group only (shared decision).
		// fails_when: rows are merged into one list sorted by tier.
		// no_claim: the visual styling of the headings.
		const { user } = setup([
			{ kind: "guest", id: "g", name: "Sam" },
			{ kind: "member", id: "m", name: "Samuel Long" },
		]);
		expect(optionNames()[0]).toContain("Samuel Long");
		await user.type(screen.getByPlaceholderText("Search"), "sam");
		expect(optionNames()[0]).toContain("Samuel Long");
		expect(optionNames()[1]).toContain("Sam");
	});

	it("shows group headings only when both kinds are present", () => {
		// protects: a members-only list has no needless "Members" heading.
		// fails_when: headings render unconditionally, or never.
		// no_claim: heading order (the grouping test covers it).
		setup([{ kind: "member", id: "m", name: "Ann" }]);
		expect(screen.queryByText("Members")).toBeNull();
		cleanup();
		setup([
			{ kind: "member", id: "m", name: "Ann" },
			{ kind: "guest", id: "g", name: "Gus" },
		]);
		expect(screen.getByText("Members")).toBeTruthy();
		expect(screen.getByText("Guests")).toBeTruthy();
	});

	it("hides a lost guest until the query is non-blank, then finds them", async () => {
		// protects: AC5, lost guests stay out of the default list but are findable.
		// fails_when: the stage filter is dropped, or applied even with a query.
		// no_claim: whitespace-only queries (isBlankQuery's own tests).
		const { user } = setup([
			{ kind: "guest", id: "l", name: "Lost Visitor", stage: "lost" },
			{ kind: "guest", id: "a", name: "Active Visitor", stage: "prospect" },
		]);
		expect(optionNames().join("|")).not.toContain("Lost Visitor");
		await user.type(screen.getByPlaceholderText("Search"), "lost");
		expect(optionNames().join("|")).toContain("Lost Visitor");
	});

	it("ranks by the caller's rank before match tier, and keeps the low-ranked row selectable", async () => {
		// protects: AC4, an exact match on a rank-2 row sorts below a rank-0 substring match.
		// fails_when: tier is applied before rank (the exact match jumps to the top).
		// no_claim: the meaning of the rank (callers own it).
		const { user, onPick } = setup([
			{ kind: "member", id: "x", name: "Ann", rank: 2 },
			{ kind: "member", id: "y", name: "Joanne", rank: 0 },
		]);
		await user.type(screen.getByPlaceholderText("Search"), "ann");
		const names = optionNames();
		expect(names[0]).toContain("Joanne");
		expect(names[1]).toContain("Ann");
		await user.click(screen.getAllByRole("option")[1]!);
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "x" }));
	});

	it("shows 'goes by' for a preferred name and finds the person by it", async () => {
		// protects: AC1, "Robert Smith · goes by Bob" and a match on "bob".
		// fails_when: preferredName is not passed to the matcher or not rendered.
		// no_claim: accent folding (person-search.test.ts).
		const { user } = setup([
			{ kind: "member", id: "r", name: "Robert Smith", preferredName: "Bob" },
			{ kind: "member", id: "o", name: "Olive Other" },
		]);
		await user.type(screen.getByPlaceholderText("Search"), "bob");
		expect(optionNames()).toHaveLength(1);
		expect(screen.getByRole("option").textContent).toContain(
			"Robert Smith · goes by Bob",
		);
	});

	it("lists two people with the same name and picks each by its own id", async () => {
		// protects: AC9, item value is kind:id so duplicates stay distinct.
		// fails_when: the cmdk value is the name, merging or mis-picking rows.
		// no_claim: telling the two apart visually (callers add meta).
		const { user, onPick } = setup([
			{ kind: "member", id: "one", name: "Pat Twin" },
			{ kind: "member", id: "two", name: "Pat Twin" },
		]);
		const opts = screen.getAllByRole("option");
		expect(opts).toHaveLength(2);
		await user.click(opts[1]!);
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "two" }));
		await user.click(screen.getAllByRole("option")[0]!);
		expect(onPick).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: "one" }),
		);
	});

	it("Enter picks the highlighted row", async () => {
		// protects: keyboard selection works with shouldFilter off.
		// fails_when: items lack a value or onSelect, so Enter does nothing.
		// no_claim: arrow-key navigation across groups.
		const { user, onPick } = setup([
			{ kind: "member", id: "a", name: "Ann" },
			{ kind: "member", id: "b", name: "Bea" },
		]);
		await user.type(screen.getByPlaceholderText("Search"), "bea{Enter}");
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
	});

	it("does not pick while disabled", async () => {
		// protects: a busy sheet cannot double-submit through the list.
		// fails_when: disabled is not forwarded to the items.
		// no_claim: the visual disabled styling.
		const { user, onPick } = setup([{ kind: "member", id: "a", name: "Ann" }], {
			disabled: true,
		});
		await user.click(screen.getByRole("option"));
		expect(onPick).not.toHaveBeenCalled();
	});
});
