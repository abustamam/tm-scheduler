import { describe, expect, it, vi } from "vitest";
import { ACTION_ITEM_RENDER_CAPS } from "#/lib/action-item-limits";
import type { MinutesData } from "#/server/minutes-logic";

// This module imports `#/db` transitively; nothing here touches it.
vi.mock("#/db", () => ({ db: {} }));

const { buildActionItemsSection } = await import("#/server/minutes-pdf-logic");

type ActionItems = MinutesData["actionItems"];
type Row = ActionItems["open"][number];

function row(over: Partial<Row>): Row {
	return {
		id: "a1",
		text: "Book the venue",
		ownerMemberId: null,
		ownerName: null,
		dueDate: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		resolvedAt: null,
		resolution: null,
		...over,
	};
}

function items(over: Partial<ActionItems>): ActionItems {
	return { open: [], resolved: [], openTotal: 0, resolvedTotal: 0, ...over };
}

describe("minutes PDF action-item section (#529)", () => {
	it("prints an UNOWNED item with no owner run at all", () => {
		// The acceptance criterion. In a permanent record a placeholder does not
		// read as "unowned", it reads as an owner named "The club" — and it would
		// quietly reassign a departed owner's commitment to the whole club.
		const section = buildActionItemsSection(
			items({ open: [row({ text: "Everyone bring a guest" })], openTotal: 1 }),
			"members",
		);
		expect(section?.openRows).toEqual(["Everyone bring a guest"]);
		expect(section?.openRows[0]).not.toContain("—");
		expect(section?.openRows.join(" ")).not.toContain("The club");
	});

	it("names the owner when there is one", () => {
		const section = buildActionItemsSection(
			items({ open: [row({ ownerName: "Jane Doe" })], openTotal: 1 }),
			"members",
		);
		expect(section?.openRows).toEqual(["Book the venue — Jane Doe"]);
	});

	it("says how many rows it cut, rather than reading as a complete record", () => {
		// Deleting the tail used to leave the whole suite green even though the
		// hostile fixture feeds 2,000 rows against a 40-row cap.
		const section = buildActionItemsSection(
			items({
				open: Array.from({ length: 60 }, (_, i) => row({ id: `a${i}` })),
				openTotal: 60,
				resolved: Array.from({ length: 50 }, (_, i) =>
					row({ id: `c${i}`, resolution: "done" }),
				),
				resolvedTotal: 50,
			}),
			"members",
		);
		// ABSOLUTE ceilings. Stated relative to the cap constant these would pass
		// for every value of it, including one that reintroduces the unbounded
		// render the cap exists to prevent.
		expect(section?.openRows.length).toBeLessThanOrEqual(50);
		expect(section?.resolvedRows.length).toBeLessThanOrEqual(50);
		expect(section?.openTail).toBe("+20 more not shown");
		expect(section?.resolvedTail).toBe("+10 more not shown");
	});

	it("adds no tail when nothing was cut", () => {
		const section = buildActionItemsSection(
			items({ open: [row({})], openTotal: 1 }),
			"members",
		);
		expect(section?.openTail).toBeNull();
		expect(section?.resolvedTail).toBeNull();
	});

	it("caps the render even when handed an UNCAPPED list", () => {
		// Defence in depth against the caller. react-pdf lays out synchronously in
		// the single Node process and its cost is super-linear in row count, so a
		// caller that forgets the upstream cap must not be able to block the event
		// loop for everyone else.
		const section = buildActionItemsSection(
			items({
				open: Array.from({ length: 5_000 }, (_, i) => row({ id: `a${i}` })),
				openTotal: 5_000,
			}),
			"members",
		);
		expect(section?.openRows.length).toBe(ACTION_ITEM_RENDER_CAPS.rows);
		expect(section?.openRows.length).toBeLessThanOrEqual(50);
	});

	it("omits the whole block for the GUEST audience", () => {
		// The minutes email attaches this PDF to every guest marked present, and a
		// guest can add themselves through the public guest book with no session.
		const section = buildActionItemsSection(
			items({
				open: [row({ text: "Chase the lapsed members" })],
				openTotal: 1,
			}),
			"guests",
		);
		expect(section).toBeNull();
	});

	it("survives a minutes payload with no action items at all", () => {
		// An offline snapshot written by a previous deploy has no `actionItems`.
		expect(buildActionItemsSection(undefined, "members")).toBeNull();
	});
});
