// @vitest-environment jsdom
//
// #1658: a near-name MEMBER on the confirm page is a hint, never an answer.
// Picking one used to replan the line to "not a guest of this club" and wipe
// the real guest candidates.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingEntry } from "#/lib/guest-book-pending";
import type {
	ConfirmBlockingItem,
	ConfirmLine,
} from "#/server/guest-book-pending-logic";
import type { GuestBookCandidate } from "#/server/guest-book-plan";
import {
	ConfirmEntriesTable,
	guestOptionsOf,
	selectValue,
} from "./confirm-entries-table";

afterEach(cleanup);

const CANDIDATES: GuestBookCandidate[] = [
	{
		kind: "member",
		memberId: "m-1",
		name: "Admin User",
		email: "admin@example.com",
		phone: null,
	},
	{
		kind: "guest",
		guestId: "g-1",
		name: "Admin Usher",
		email: null,
		phone: null,
	},
];

const line = (entryId: string): ConfirmLine => ({
	entryId,
	outcome: "ambiguous",
	guestId: null,
	via: null,
	matchedName: null,
	minutesRecipient: false,
});
const item = (
	entryId: string,
	candidates: GuestBookCandidate[],
): ConfirmBlockingItem => ({
	code: "AMBIGUOUS_GUEST",
	message: "close to someone on file",
	entryId,
	candidates,
});

function mount(entries: PendingEntry[], blocking: ConfirmBlockingItem[]) {
	render(
		<ConfirmEntriesTable
			entries={entries}
			lines={entries.map((e) => line(e.id))}
			blocking={blocking}
			busy={false}
			onEdit={() => {}}
			draft={() => undefined}
			onDraft={() => {}}
		/>,
	);
}

describe("near-name member candidates on the confirm page (#1658)", () => {
	it("offers only the guest as an option and shows the member as a hint", () => {
		mount([{ id: "e1", name: "Admin Usr" }], [item("e1", CANDIDATES)]);
		const options = [...document.querySelectorAll("option")].map(
			(o) => o.textContent ?? "",
		);
		expect(options).toHaveLength(3); // prompt, the guest, "Someone new"
		expect(options.some((t) => t.includes("Admin Usher"))).toBe(true);
		expect(options.some((t) => t.includes("Admin User ·"))).toBe(false);
		expect(document.body.textContent).toContain(
			"Possibly member Admin User · admin@example.com",
		);
	});

	it("a member-only ambiguity still lets the officer say someone new", () => {
		mount(
			[{ id: "e1", name: "Admin Usr" }],
			[item("e1", [CANDIDATES[0] as GuestBookCandidate])],
		);
		const options = [...document.querySelectorAll("option")].map(
			(o) => o.value,
		);
		expect(options).toEqual(["", "new"]);
	});

	it("keeps the guest candidates in the view-model split", () => {
		expect(guestOptionsOf(CANDIDATES).map((c) => c.guestId)).toEqual(["g-1"]);
	});

	it("shows the prompt, not a blank, when the stored answer matches no option", () => {
		const opts = guestOptionsOf(CANDIDATES);
		expect(selectValue({ kind: "existing", guestId: "m-1" }, opts)).toBe("");
		expect(selectValue({ kind: "existing", guestId: "g-1" }, opts)).toBe("g-1");
		expect(selectValue({ kind: "new" }, opts)).toBe("new");
		expect(selectValue(undefined, opts)).toBe("");
	});

	it("renders several near-name lines on one page, each with its own list", () => {
		mount(
			[
				{ id: "e1", name: "Admin Usr" },
				{ id: "e2", name: "Memb Usr" },
			],
			[
				item("e1", CANDIDATES),
				item("e2", [
					{
						kind: "member",
						memberId: "m-2",
						name: "Member User",
						email: null,
						phone: null,
					},
				]),
			],
		);
		expect(screen.getAllByRole("combobox")).toHaveLength(2);
		expect(document.body.textContent).toContain("Possibly member Member User");
		expect(document.body.textContent).toContain("Possibly member Admin User");
	});
});
