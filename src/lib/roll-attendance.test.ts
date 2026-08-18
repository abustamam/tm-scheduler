import { describe, expect, it } from "vitest";
import { buildRollPanel } from "#/lib/roll-panel";
import type { MinutesData } from "#/server/minutes-logic";
import type { MinutesOp } from "./offline-minutes-queue";
import {
	deriveRollAttendance,
	deriveRollGuests,
	deriveRollRoster,
} from "./roll-attendance";

// The op ids/timestamps are irrelevant to the projection but required by the type.
let seq = 0;
function meta() {
	seq += 1;
	return { opId: `op-${seq}`, queuedAt: 1000 + seq };
}

/** A minimal but complete `MinutesData`. `status` is the only field this seam reads. */
function makeMinutes(
	members: MinutesData["members"] = [
		{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
		{ memberId: "m-bea", name: "Bea", status: "present", hasRole: false },
		{ memberId: "m-cy", name: "Cy", status: "excused", hasRole: false },
	],
): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "meeting-1",
		clubId: "club-1",
		members,
		guests: [{ guestId: "g-rose", name: "Rose", fromRole: false }],
		tableTopicsSpeakers: [],
		awards: [
			{
				category: "best_speaker",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
			{
				category: "best_evaluator",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
			{
				category: "best_table_topics",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
		],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: { present: 1, absent: 0, excused: 1, unmarked: 1, guests: 1 },
	};
}

const setAbsent = (memberId: string): MinutesOp => ({
	type: "setAttendance",
	...meta(),
	memberId,
	status: "absent",
});

const addGuest = (guestId: string, name: string): MinutesOp => ({
	type: "addGuest",
	...meta(),
	guestId,
	name,
});

const removeGuest = (guestId: string): MinutesOp => ({
	type: "removeGuest",
	...meta(),
	guestId,
});

describe("deriveRollAttendance", () => {
	it("returns only the RECORDED rows, dropping the unmarked ones", () => {
		// `status: null` must not be flattened into a value: `buildRollPanel` reads
		// the ABSENCE of a row as "nobody has marked this member yet" and renders
		// the plan's answer as a one-tap dashed suggestion. Emitting Abe here with
		// any status at all deletes that affordance for the whole roster.
		expect(
			deriveRollAttendance({
				online: true,
				minutes: makeMinutes(),
				snapshot: null,
				queue: [],
			}),
		).toEqual([
			{ memberId: "m-bea", status: "present" },
			{ memberId: "m-cy", status: "excused" },
		]);
	});

	it("reflects a queued setAttendance op while OFFLINE", () => {
		// The whole point (#176 on the surface the queue exists for): offline the
		// write is queued and no refetch will ever land, so without replaying the
		// queue an officer taps "Present" at a meeting on dead club wifi, nothing
		// moves, and they tap again.
		const rows = deriveRollAttendance({
			online: false,
			minutes: makeMinutes(),
			snapshot: null,
			queue: [setAbsent("m-bea")],
		});
		expect(rows).toContainEqual({ memberId: "m-bea", status: "absent" });
		expect(rows).not.toContainEqual({ memberId: "m-bea", status: "present" });
	});

	it("makes a previously-unmarked member APPEAR once their tap is queued", () => {
		// The other half of the same observable, and the one the dashed suggestion
		// depends on: Abe has no recorded row, so the offline tap has to ADD one
		// rather than update one — a projection that only rewrote existing rows
		// would pass the test above and still leave the chip dashed.
		expect(
			deriveRollAttendance({
				online: false,
				minutes: makeMinutes(),
				snapshot: null,
				queue: [setAbsent("m-abe")],
			}),
		).toContainEqual({ memberId: "m-abe", status: "absent" });
	});

	it("IGNORES the queue while online, leaving the server as the source of truth", () => {
		// Matches `meeting-minutes.tsx`'s `displayMinutes` exactly. Online the
		// loader refetch that `offlineMinutes.mutate` triggers is what moves the
		// chip; replaying a not-yet-drained queue on top of fresh rows would show a
		// stale status over a newer one, with no error and nothing to notice.
		expect(
			deriveRollAttendance({
				online: true,
				minutes: makeMinutes(),
				snapshot: null,
				queue: [setAbsent("m-bea")],
			}),
		).toEqual([
			{ memberId: "m-bea", status: "present" },
			{ memberId: "m-cy", status: "excused" },
		]);
	});

	it("replays over the offline SNAPSHOT in preference to the loader rows", () => {
		// The snapshot is the last state the server confirmed; the loader payload
		// of an offline render can be older (a cached document, a reload with no
		// network). Preferring `minutes` here would silently discard whatever the
		// snapshot captured — Cy's excusal below.
		const stale = makeMinutes([
			{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
			{ memberId: "m-bea", name: "Bea", status: null, hasRole: false },
			{ memberId: "m-cy", name: "Cy", status: null, hasRole: false },
		]);
		expect(
			deriveRollAttendance({
				online: false,
				minutes: stale,
				snapshot: makeMinutes(),
				queue: [setAbsent("m-bea")],
			}),
		).toEqual([
			{ memberId: "m-bea", status: "absent" },
			{ memberId: "m-cy", status: "excused" },
		]);
	});

	it("falls back to the loader rows when there is no snapshot yet", () => {
		// First offline render of a fresh tab: nothing persisted, so the loader's
		// rows are all there is. Returning `[]` here would blank a roll panel that
		// has perfectly good server data on screen.
		expect(
			deriveRollAttendance({
				online: false,
				minutes: makeMinutes(),
				snapshot: null,
				queue: [],
			}),
		).toEqual([
			{ memberId: "m-bea", status: "present" },
			{ memberId: "m-cy", status: "excused" },
		]);
	});

	it("returns [] when the viewer may not read the minutes at all", () => {
		// `minutes.data` is `null` for such a viewer. Both branches, since the
		// online one short-circuits before `deriveMinutes` and the offline one does
		// not — and `deriveMinutes(null, …)` would throw inside a render.
		expect(
			deriveRollAttendance({
				online: true,
				minutes: null,
				snapshot: null,
				queue: [],
			}),
		).toEqual([]);
		expect(
			deriveRollAttendance({
				online: false,
				minutes: null,
				snapshot: null,
				queue: [setAbsent("m-bea")],
			}),
		).toEqual([]);
	});

	it("does not mutate the snapshot it projects", () => {
		// The snapshot is React state owned by `useOfflineMinutes`; mutating it in
		// place would make the hook's next render read a value it never set.
		const snapshot = makeMinutes();
		const before = structuredClone(snapshot);
		deriveRollAttendance({
			online: false,
			minutes: null,
			snapshot,
			queue: [setAbsent("m-bea")],
		});
		expect(snapshot).toEqual(before);
	});
});

describe("deriveRollGuests", () => {
	it("reflects a queued addGuest while OFFLINE", () => {
		// Fix round 2 (F3). `AttendanceGuestsGroup` holds no optimism of its own, so
		// without this an officer taps "+ Add guest" offline, the op queues, and the
		// guest simply does not appear.
		const guests = deriveRollGuests({
			online: false,
			minutes: makeMinutes(),
			snapshot: null,
			queue: [addGuest("g-nadia", "Nadia Farouk")],
		});
		expect(guests?.map((g) => g.name)).toContain("Nadia Farouk");
	});

	it("removes the guest the picker must stop offering, so the second tap is not invited", () => {
		// The worse half of F3: the picker's already-present filter (`presentIds` in
		// `attendance-guests-group.tsx`) is built from THIS list, so a raw list keeps
		// offering a guest who has already been added — the exact "tap again" this
		// round exists to kill. Asserting the removal proves the list is the derived
		// one, not the snapshot: only a projection can drop a row the server still
		// has.
		const guests = deriveRollGuests({
			online: false,
			minutes: makeMinutes(),
			snapshot: null,
			queue: [removeGuest("g-rose")],
		});
		expect(guests?.map((g) => g.guestId)).not.toContain("g-rose");
	});

	it("IGNORES the queue while online, leaving the server as the source of truth", () => {
		// Same branch as the members. Replaying a not-yet-drained queue over fresh
		// rows would show a stale guest list with no error and nothing to notice.
		expect(
			deriveRollGuests({
				online: true,
				minutes: makeMinutes(),
				snapshot: null,
				queue: [addGuest("g-nadia", "Nadia Farouk")],
			}),
		).toEqual([{ guestId: "g-rose", name: "Rose", fromRole: false }]);
	});

	it("returns UNDEFINED, not [], when there is nothing to read", () => {
		// Deliberately unlike `deriveRollAttendance`, which returns `[]`. The panel's
		// `guests` prop is optional so a caller with no guests wired renders NOTHING;
		// an `[]` here would quietly render an empty "Guests" group instead — the
		// difference the panel's own "omits the Guests group entirely" test pins from
		// the other side.
		expect(
			deriveRollGuests({
				online: true,
				minutes: null,
				snapshot: null,
				queue: [],
			}),
		).toBeUndefined();
		expect(
			deriveRollGuests({
				online: false,
				minutes: null,
				snapshot: null,
				queue: [addGuest("g-nadia", "Nadia Farouk")],
			}),
		).toBeUndefined();
	});
});

// Whole-branch review I2. Roll mode also serves COMPLETED meetings, where the
// active roster is no longer the right list: `loadMinutes` builds "active roster
// ∪ any member with a saved attendance row" and computes `counts` over that
// union, so a roster-only panel silently disagreed with the Minutes card, the
// PDF and the emailed minutes for the same meeting — and a departed member's row
// could not be seen or corrected anywhere in the app.
describe("deriveRollRoster", () => {
	/** The active roster: `m-dee` below is NOT on it — they left the club. */
	const roster = [
		{ id: "m-abe", name: "Abe", phone: "+15550000001", email: null },
		{ id: "m-bea", name: "Bea", phone: null, email: "bea@example.com" },
		{ id: "m-cy", name: "Cy", phone: null, email: null },
	];
	/** The default fixture plus a member who was marked present and has since left. */
	const withDeparted = () => {
		const m = makeMinutes([
			{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
			{ memberId: "m-bea", name: "Bea", status: "present", hasRole: false },
			{ memberId: "m-cy", name: "Cy", status: "excused", hasRole: false },
			{
				memberId: "m-dee",
				name: "Dee Gone",
				status: "present",
				hasRole: false,
			},
		]);
		m.counts = { present: 2, absent: 0, excused: 1, unmarked: 1, guests: 1 };
		return m;
	};

	it("appends a member with a recorded row who has left the roster", () => {
		const rows = deriveRollRoster({
			roster,
			online: true,
			minutes: withDeparted(),
			snapshot: null,
			queue: [],
		});
		expect(rows.map((r) => r.id)).toEqual(["m-abe", "m-bea", "m-cy", "m-dee"]);
		// Contact-less — a departed member is not on the officer's roster payload —
		// and TAGGED, which is the part that makes it honest. Nulling contact alone
		// lands on `NudgeButtons`' "No contact on file" copy, the very message the
		// panel omits the affordance to avoid; the tag is what lets the row skip it
		// without also silencing that message for an ACTIVE member who really has
		// nothing on file.
		expect(rows.find((r) => r.id === "m-dee")).toEqual({
			id: "m-dee",
			name: "Dee Gone",
			preferredName: null,
			phone: null,
			email: null,
			departed: true,
		});
	});

	it("tags ONLY the appended rows, never a member who is still on the roster", () => {
		// The other half of the tag, and the one that keeps it honest: `m-cy` is an
		// ACTIVE member with no phone and no email, which looks identical to a
		// departed row if you go by contact fields. Tagging them would take "No
		// contact on file" away from the officer who needs to go add a number.
		const rows = deriveRollRoster({
			roster,
			online: true,
			minutes: withDeparted(),
			snapshot: null,
			queue: [],
		});
		expect(rows.filter((r) => r.departed).map((r) => r.id)).toEqual(["m-dee"]);
		const cy = rows.find((r) => r.id === "m-cy");
		expect(cy?.phone).toBeNull();
		expect(cy?.email).toBeNull();
		expect(cy?.departed).toBeFalsy();
	});

	it("makes the panel's counts agree with the minutes' own counts", () => {
		// The user-visible half of I2, and the reason this is not just a missing
		// row: `loadMinutes` counted the departed member and `buildRollPanel` did
		// not, so ONE meeting showed two different attendance numbers depending on
		// which surface you looked at. Asserted through `buildRollPanel` — the
		// consumer — rather than on the roster length, because the roster is only
		// the mechanism.
		const minutes = withDeparted();
		const { counts } = buildRollPanel({
			roster: deriveRollRoster({
				roster,
				online: true,
				minutes,
				snapshot: null,
				queue: [],
			}),
			attendance: deriveRollAttendance({
				online: true,
				minutes,
				snapshot: null,
				queue: [],
			}),
			plan: [],
			roleByMemberId: {},
		});
		expect(counts).toEqual({
			present: minutes.counts.present,
			absent: minutes.counts.absent,
			excused: minutes.counts.excused,
			unmarked: minutes.counts.unmarked,
		});
		// Spelled out too, so this cannot pass by both sides being wrong together —
		// a parity assertion cannot see a defect present on both sides.
		expect(counts).toEqual({ present: 2, absent: 0, excused: 1, unmarked: 1 });
	});

	it("never resurrects a member with no recorded status", () => {
		// The property `buildRollPanel` guarantees for an UPCOMING meeting, kept
		// here: absence of a row is exactly what "off the roster" looks like. Only a
		// RECORD earns a row back.
		const minutes = makeMinutes([
			{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
			{ memberId: "m-ghost", name: "Ghost", status: null, hasRole: false },
		]);
		const rows = deriveRollRoster({
			roster,
			online: true,
			minutes,
			snapshot: null,
			queue: [],
		});
		expect(rows.map((r) => r.id)).not.toContain("m-ghost");
	});

	it("returns the roster untouched — same identity — when nobody has left", () => {
		// Identity, not just equality: this feeds the panel's `roster` prop on every
		// render of a page that re-renders on every tap.
		const rows = deriveRollRoster({
			roster,
			online: true,
			minutes: makeMinutes(),
			snapshot: null,
			queue: [],
		});
		expect(rows).toBe(roster);
	});

	it("returns the roster when the viewer may not read the minutes at all", () => {
		// `minutes.data` is null for such a viewer — the union has nothing to add
		// and must not empty the roster on its way to finding that out.
		expect(
			deriveRollRoster({
				roster,
				online: true,
				minutes: null,
				snapshot: null,
				queue: [],
			}),
		).toBe(roster);
	});

	it("appends a member whose only record is a QUEUED offline tap", () => {
		// Same projection as the other two derivations, so an officer correcting a
		// past meeting on dead wifi sees the row they just created rather than
		// tapping again. `m-dee` is absent from the roster AND unmarked in the
		// snapshot, so only the replayed queue can put them on screen.
		const snapshot = makeMinutes([
			{ memberId: "m-abe", name: "Abe", status: null, hasRole: false },
			{ memberId: "m-dee", name: "Dee Gone", status: null, hasRole: false },
		]);
		const rows = deriveRollRoster({
			roster,
			online: false,
			minutes: null,
			snapshot,
			queue: [setAbsent("m-dee")],
		});
		expect(rows.map((r) => r.id)).toContain("m-dee");
	});
});
