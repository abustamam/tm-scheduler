/**
 * The confirm page's pure half (#806).
 *
 * Two of these are worth more than they look. The INDEX MAP is the whole reason
 * `PendingEntry.id` exists: `plan()` numbers the lines it is handed and answers
 * ambiguities by position, so dropping a line silently renumbers every line
 * after it — and a blocking item saying "entry 1" would then be pinned to the
 * wrong row on screen. And the two SPELLINGS of an empty optional field
 * (absent vs `""`) matter because the stored entries are hashed: two pages with
 * the same content must hash the same however they were edited.
 */
import { describe, expect, it } from "vitest";
import {
	applyPendingEntryEdit,
	entryIdForBlockingIndex,
	guestBookConfirmPath,
	guestBookConfirmUrl,
	isPendingPlanExpired,
	livePendingEntries,
	PENDING_PLAN_GRACE_MS,
	PENDING_PLAN_TTL_MS,
	type PendingEntry,
	pendingPlanArgs,
	pendingPlanExpiresAt,
	pendingPlanSweepCutoff,
} from "./guest-book-pending";

const A: PendingEntry = { id: "a", name: "Ada Lovelace", email: "ada@x.com" };
const B: PendingEntry = { id: "b", name: "Bea Bright", phone: "+15551234567" };
const C: PendingEntry = { id: "c", name: "Cy Clone" };

describe("expiry and the grace window", () => {
	const created = new Date("2026-09-19T10:00:00Z");

	it("expires a day after it was created", () => {
		expect(pendingPlanExpiresAt(created).getTime()).toBe(
			created.getTime() + PENDING_PLAN_TTL_MS,
		);
	});

	it("is live up to the instant it expires, and not after", () => {
		const expiresAt = pendingPlanExpiresAt(created);
		expect(isPendingPlanExpired({ expiresAt }, new Date(created))).toBe(false);
		expect(
			isPendingPlanExpired({ expiresAt }, new Date(expiresAt.getTime() - 1)),
		).toBe(false);
		// The boundary itself is expired: a link that is exactly at its deadline
		// should explain itself, not apply.
		expect(isPendingPlanExpired({ expiresAt }, expiresAt)).toBe(true);
	});

	it("sweeps only past the grace window, so expired rows still explain themselves", () => {
		const now = new Date("2026-09-21T10:00:00Z");
		const cutoff = pendingPlanSweepCutoff(now);
		expect(now.getTime() - cutoff.getTime()).toBe(PENDING_PLAN_GRACE_MS);

		// A row that expired a minute ago is INSIDE the window — this is what
		// stops "expired" and "swept" racing, so the link renders an explanation
		// for a day before it vanishes.
		const justExpired = new Date(now.getTime() - 60_000);
		expect(justExpired.getTime() < cutoff.getTime()).toBe(false);

		const longGone = new Date(now.getTime() - PENDING_PLAN_GRACE_MS - 1);
		expect(longGone.getTime() < cutoff.getTime()).toBe(true);
	});
});

describe("the two index spaces", () => {
	it("plans only the live lines", () => {
		const entries = [A, { ...B, dropped: true }, C];
		expect(livePendingEntries(entries).map((e) => e.id)).toEqual(["a", "c"]);
		expect(pendingPlanArgs(entries).entries.map((e) => e.name)).toEqual([
			"Ada Lovelace",
			"Cy Clone",
		]);
	});

	it("maps a blocking index back to the row it is about, AFTER a drop", () => {
		// THE case. Drop the first of three and the planner's index 0 is now the
		// SECOND stored line. A page that assumed the two lists lined up would
		// pin Bea's problem to Ada's row.
		const entries = [{ ...A, dropped: true }, B, C];
		expect(entryIdForBlockingIndex(entries, 0)).toBe("b");
		expect(entryIdForBlockingIndex(entries, 1)).toBe("c");
		// An index past the end names nothing rather than the last row.
		expect(entryIdForBlockingIndex(entries, 2)).toBeNull();
		// No index at all means the item belongs to the CALL, not a line.
		expect(entryIdForBlockingIndex(entries, undefined)).toBeNull();
	});

	it("assembles the positional resolve map from per-entry answers", () => {
		const entries: PendingEntry[] = [
			{ ...A, dropped: true },
			{ ...B, resolve: { kind: "new" } },
			{ ...C, resolve: { kind: "existing", guestId: "g-9" } },
		];
		// Keyed by position in the LIVE list, which is what `plan()` reads.
		expect(pendingPlanArgs(entries).resolve).toEqual({
			"0": "new",
			"1": "g-9",
		});
	});

	it("omits an empty optional field rather than sending an empty string", () => {
		const [only] = pendingPlanArgs([C]).entries;
		expect(only).toEqual({ name: "Cy Clone" });
		expect("email" in (only ?? {})).toBe(false);
	});
});

describe("the editing reducer", () => {
	const entries = [A, B, C];

	it("edits one field of one row and leaves the rest identical", () => {
		const next = applyPendingEntryEdit(entries, {
			kind: "field",
			id: "b",
			field: "email",
			value: "  bea@x.com  ",
		});
		expect(next[1]).toMatchObject({ id: "b", email: "bea@x.com" });
		// Untouched rows are the SAME objects: a reducer that rebuilt everything
		// would defeat React's identity checks on a 60-line page.
		expect(next[0]).toBe(A);
		expect(next[2]).toBe(C);
	});

	it('DELETES an optional field cleared to empty, rather than storing ""', () => {
		// The hashed shape has one spelling for "this line carries no email".
		// `canonicalize` drops `undefined` and keeps `null`/`""`, so two pages
		// with the same content would otherwise hash differently depending on
		// whether a field had ever been typed in and cleared.
		const next = applyPendingEntryEdit(entries, {
			kind: "field",
			id: "a",
			field: "email",
			value: "   ",
		});
		expect(next[0]).toEqual({ id: "a", name: "Ada Lovelace" });
		expect("email" in (next[0] ?? {})).toBe(false);
	});

	it("records an answer to an ambiguity, and unsets it again", () => {
		const answered = applyPendingEntryEdit(entries, {
			kind: "resolve",
			id: "c",
			resolve: { kind: "existing", guestId: "g-1" },
		});
		expect(answered[2]?.resolve).toEqual({ kind: "existing", guestId: "g-1" });

		const cleared = applyPendingEntryEdit(answered, {
			kind: "resolve",
			id: "c",
			resolve: null,
		});
		expect("resolve" in (cleared[2] ?? {})).toBe(false);
	});

	it("drops a line and restores it, keeping it in the stored list either way", () => {
		const dropped = applyPendingEntryEdit(entries, {
			kind: "dropped",
			id: "b",
			dropped: true,
		});
		// Still THREE stored rows — a drop is reversible, so the row stays.
		expect(dropped).toHaveLength(3);
		expect(livePendingEntries(dropped).map((e) => e.id)).toEqual(["a", "c"]);

		const restored = applyPendingEntryEdit(dropped, {
			kind: "dropped",
			id: "b",
			dropped: false,
		});
		expect("dropped" in (restored[1] ?? {})).toBe(false);
		expect(livePendingEntries(restored)).toHaveLength(3);
	});

	it("does nothing for an id that is not on the page", () => {
		expect(
			applyPendingEntryEdit(entries, {
				kind: "dropped",
				id: "nope",
				dropped: true,
			}),
		).toEqual(entries);
	});
});

describe("the confirm link", () => {
	it("is absolute, and normalises a trailing slash on the origin", () => {
		expect(guestBookConfirmUrl("https://gavelup.app", "p-1")).toBe(
			"https://gavelup.app/guest-book/p-1",
		);
		expect(guestBookConfirmUrl("https://gavelup.app///", "p-1")).toBe(
			"https://gavelup.app/guest-book/p-1",
		);
	});

	it("shares its path with the route", () => {
		// The link and the route must name one path. This is the half a unit test
		// can hold; `guest-book.$planId.tsx` is the other.
		expect(guestBookConfirmPath("p-1")).toBe("/guest-book/p-1");
	});
});
