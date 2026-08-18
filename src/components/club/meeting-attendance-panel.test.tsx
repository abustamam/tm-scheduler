// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAttendancePanel } from "./meeting-attendance-panel";

const roster = [
	{
		id: "m1",
		name: "Ayesha Khan",
		preferredName: null,
		phone: "+15551234567",
		email: null,
	},
	{ id: "m2", name: "Bo Lin", preferredName: null, phone: null, email: null },
];

function renderPanel(
	over: Partial<Parameters<typeof MeetingAttendancePanel>[0]> = {},
) {
	const props = {
		mode: "plan" as const,
		roster,
		plan: [],
		rungOverride: {},
		roleByMemberId: {},
		meetingDate: "Tue 19 Aug",
		shareUrl: "https://club.example/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		...over,
	};
	return { props, ...render(<MeetingAttendancePanel {...props} />) };
}

describe("MeetingAttendancePanel (plan mode)", () => {
	afterEach(() => cleanup());

	it("lists the whole roster with its counts line", () => {
		const { getByText } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		expect(getByText("Ayesha Khan")).toBeTruthy();
		expect(getByText("Bo Lin")).toBeTruthy();
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("sets a rung through the row's dropdown", async () => {
		const { props, getByRole, findByRole } = renderPanel();
		// Radix's DropdownMenuTrigger opens on `pointerdown`/`onKeyDown`, not
		// `click` (verified against @radix-ui/react-dropdown-menu's source) — a
		// bare `fireEvent.click` dispatches only a "click" MouseEvent and never
		// opens it. `userEvent.click` replays the real pointer sequence, matching
		// how every other Radix-trigger test in this repo opens one (e.g.
		// meeting-export-menu.test.tsx, meeting-toolbar.test.tsx). The menu ITEM
		// click below stays `fireEvent.click`: Radix's MenuItem selects on a
		// plain `onClick`, so the simpler event suffices there.
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "Coming" }));
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", "coming");
	});

	it("clears back to no answer through the same menu", async () => {
		const { props, getByRole, findByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "No answer" }));
		// Clearing is a DELETE, not a fourth status — the row's absence is the
		// only encoding of "no answer". `null` is how the single writer says so.
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", null);
	});

	it("disables the chips on a locked meeting rather than hiding them", () => {
		// Spec, Error handling: a control that vanishes reads as a bug; a disabled
		// one reads as "not now".
		const { getByRole } = renderPanel({ locked: true });
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("keeps the rungs disabled on a COMPLETED meeting, unlike roll mode's chips", () => {
		// The other half of the mode-specific lock (see "keeps the chips live on a
		// completed meeting" in the roll block). `locked` is exactly
		// `status === "completed"`, and roll mode deliberately ignores it — but
		// changing PLANNED attendance for a meeting that has already happened is
		// meaningless, so plan mode keeps respecting it.
		//
		// Both directions are asserted, in both blocks, on purpose: with only the
		// roll one, the next reader "simplifies" `roll ? false : locked` down to a
		// bare `false` and the panel starts letting an officer rewrite the outreach
		// ladder of a closed-out meeting with the whole suite green. `phaseCompleted`
		// is inert in plan mode, and passed anyway so the fixture is the real
		// "completed meeting" shape rather than `locked` alone.
		const { getByRole } = renderPanel({ locked: true, phaseCompleted: true });
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
	});

	it("offers a WhatsApp draft when a phone is on file, and says so when not", () => {
		const { getByText, getAllByRole } = renderPanel();
		expect(getAllByRole("link").length).toBeGreaterThan(0);
		expect(getByText(/No contact on file/i)).toBeTruthy();
	});

	it("shows the role a member holds", () => {
		const { getByText } = renderPanel({ roleByMemberId: { m2: "Timer" } });
		expect(getByText("Timer")).toBeTruthy();
	});

	it("renders the optimistic override, not the server value", () => {
		// The whole point of the optimistic path: the chip changes on tap, before
		// any server round trip. Rendering `plan` here would show the stale rung
		// and the officer would tap twice.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "not_coming" as const }],
			rungOverride: { m1: "coming" as const },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("Coming");
	});

	it("treats an override of null as cleared, not as absent", () => {
		// `null` and "no key" are different states and `??` cannot tell them
		// apart — an optimistic CLEAR would fall through to the server's old rung
		// and the chip would appear not to have changed.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
			rungOverride: { m1: null },
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).textContent,
		).toContain("—");
	});

	it("counts and sorts on the optimistic state too", () => {
		// Otherwise the counts line disagrees with the chips for a beat, and the
		// row jumps to its new bucket only after the refetch.
		const { getByText } = renderPanel({
			plan: [],
			rungOverride: { m1: "coming" as const },
		});
		expect(getByText("1 coming · 1 no answer")).toBeTruthy();
	});

	it("collapses to the counts line below lg, and expands on tap", () => {
		// Spec D4: in plan mode on mobile the panel renders collapsed, so a
		// 15-person roster does not push the agenda off screen. The rows are
		// absent from the DOM when collapsed rather than merely hidden — a
		// `hidden` class is invisible to this assertion and to a screen reader.
		//
		// jsdom's default `window.innerWidth` (1024) IS the `lg` breakpoint, so
		// without setting it below that, this environment reads as desktop —
		// which is also why every other test in this file (none of which touch
		// `innerWidth`) can assert row content with no expand click: the panel is
		// correctly always-expanded at that width. This is the one test that is
		// actually about the mobile case, so it is the one that has to say so.
		const originalWidth = window.innerWidth;
		window.innerWidth = 500;
		try {
			const { getByRole, queryByText, getByText } = renderPanel();
			expect(getByText("2 no answer")).toBeTruthy();
			expect(queryByText("Ayesha Khan")).toBeNull();
			fireEvent.click(getByRole("button", { name: /show|expand/i }));
			expect(getByText("Ayesha Khan")).toBeTruthy();
		} finally {
			window.innerWidth = originalWidth;
		}
	});

	it("renders the mobile Show/Hide toggle, unlike roll mode", () => {
		const { getByRole } = renderPanel();
		expect(getByRole("button", { name: /show|hide/i })).toBeTruthy();
	});

	it("never renders the Guests group in plan mode", () => {
		// Guests are roll-mode only (spec: pre-meeting guest expectation is out of
		// scope) — even if a caller mistakenly passes `guests` through in plan
		// mode, the group must not appear.
		const { queryByText } = renderPanel({
			guests: [{ guestId: "g1", name: "Nadia Farouk", fromRole: false }],
			clubGuests: [{ id: "g1", name: "Nadia Farouk" }],
		});
		expect(queryByText("Guests")).toBeNull();
		expect(queryByText("Nadia Farouk")).toBeNull();
	});

	it("ignores the roll-mode `busy` signal — plan writes never touch the offline queue", () => {
		// `busy` is the offline queue's refuse-while-busy signal, and the route
		// passes it for BOTH modes from one call site. A plan rung goes straight to
		// `setPlannedAttendance`, so a Minutes-card write (or a reconnect drain)
		// holding that flag must not disable the outreach ladder — the panel's own
		// per-row `pending` is the only guard plan mode needs. Pinned because
		// folding `busy` into `AttendanceRow` "for symmetry" is a one-word edit that
		// no other test here can see.
		const { getByRole } = renderPanel({ busy: true });
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(false);
	});
});

describe("roll mode", () => {
	// The brief's snippet omitted this, unlike the plan-mode block above; without
	// it renders leak across `it`s (no global auto-cleanup is configured — see
	// vitest.config.ts), and the contact-visibility and mobile-expansion tests
	// below see EVERY prior test's rows too, not just their own.
	afterEach(() => cleanup());

	const rollProps = {
		mode: "roll" as const,
		roster: [
			{
				id: "m-abe",
				name: "Abe Nkemelu",
				phone: "+12025550101",
				email: "abe@example.com",
			},
			{ id: "m-bea", name: "Bea Osei", phone: null, email: "bea@example.com" },
		],
		plan: [{ memberId: "m-abe", status: "coming" as const }],
		attendance: [],
		rungOverride: {},
		roleByMemberId: {},
		meetingDate: "August 20, 2026",
		shareUrl: "https://example.test/m",
		locked: false,
		onWriteRung: vi.fn(),
		onContacted: vi.fn(),
		onSetAttendance: vi.fn(),
	};

	it("titles itself Attendance and counts real rows", () => {
		const { getByText } = render(<MeetingAttendancePanel {...rollProps} />);
		getByText("Attendance");
		// Abe's plan says `coming`, which is a SUGGESTION, not a record — so both
		// members are unmarked. A suggestion-counting bug reads "1 present".
		getByText("2 unmarked");
	});

	it("renders a dashed suggestion for a planned member and a solid chip for a recorded one", () => {
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				attendance={[{ memberId: "m-bea", status: "present" }]}
			/>,
		);
		// Abe: no row, plan says coming -> dashed "Present?"
		const abe = getByRole("button", { name: /Abe Nkemelu status/i });
		expect(abe.textContent).toContain("Present?");
		expect(abe.className).toContain("border-dashed");
		// Bea: real row -> solid, no question mark.
		const bea = getByRole("button", { name: /Bea Osei status/i });
		expect(bea.textContent).toContain("Present");
		expect(bea.textContent).not.toContain("?");
		expect(bea.className).not.toContain("border-dashed");
	});

	it("tapping a dashed suggestion writes the suggested status", async () => {
		const onSetAttendance = vi.fn();
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				onSetAttendance={onSetAttendance}
			/>,
		);
		fireEvent.click(getByRole("button", { name: /Abe Nkemelu status/i }));
		// One tap commits the suggestion — that is the affordance. It must NOT open
		// the menu, or roll call costs two taps per member.
		expect(onSetAttendance).toHaveBeenCalledWith("m-abe", "present");
	});

	it("offers the attendance statuses, not the plan rungs", async () => {
		const { getByRole, findByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				attendance={[{ memberId: "m-bea", status: "present" }]}
			/>,
		);
		// Radix's DropdownMenuTrigger opens on pointerdown, not a bare `click` — see
		// the plan-mode test above for the same note. `userEvent.click` replays the
		// real pointer sequence; the menu ITEM selection below stays `fireEvent.click`
		// since MenuItem selects on a plain `onClick`.
		await userEvent.click(getByRole("button", { name: /Bea Osei status/i }));
		await findByRole("menuitem", { name: "Present" });
		getByRole("menuitem", { name: "Absent" });
		getByRole("menuitem", { name: "Excused" });
		expect(() => getByRole("menuitem", { name: "Coming" })).toThrow();
	});

	it("keeps contact while the meeting is today and drops it once completed", () => {
		const today = render(<MeetingAttendancePanel {...rollProps} />);
		today.getByRole("link", { name: /WhatsApp/i });
		today.unmount();
		// `completed` rows are a historical record — nobody is being chased.
		const done = render(
			<MeetingAttendancePanel
				{...rollProps}
				locked={true}
				phaseCompleted={true}
			/>,
		);
		expect(() => done.getByRole("link", { name: /WhatsApp/i })).toThrow();
	});

	it("keeps contact on a locked meeting that is not yet completed", () => {
		// Isolates `locked` from `phaseCompleted`. The pair above flips both
		// together (today: both false; done: both true), so a future edit that
		// keys `hideContact` on `locked` instead of `phaseCompleted` would pass
		// both of those cases — a completed meeting is usually also locked.
		// `locked && !phaseCompleted` is the meeting-day case: the officer is
		// still chasing people, so contact must stay.
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				locked={true}
				phaseCompleted={false}
			/>,
		);
		getByRole("link", { name: /WhatsApp/i });
	});

	it("keeps the chips live on a COMPLETED meeting, unlike plan mode's rungs", () => {
		// Roll mode records what HAPPENED, and correcting a mis-marked attendance
		// after a meeting is closed out is a normal club task — minutes here are
		// often finished days later. Everything around this already allows it:
		// `setAttendance` gates only on `assertAttendanceRecordable` (has the day
		// arrived) and has no view of `status`, and the Minutes `AttendanceSection`
		// that roll mode replaces gated on `canEdit` alone, which never considered
		// `status` either. Left on `locked`, roll mode would be STRICTER than the
		// surface being deleted and the only correction route would be Reopen.
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				attendance={[{ memberId: "m-bea", status: "present" }]}
				locked={true}
				phaseCompleted={true}
			/>,
		);
		// BOTH chip shapes. Abe is a dashed one-tap suggestion and Bea a recorded
		// chip that opens the menu; those are two separate `disabled` expressions in
		// `RollChip`, so one can be re-gated without the other.
		expect(
			getByRole("button", { name: /Abe Nkemelu status/i }).hasAttribute(
				"disabled",
			),
		).toBe(false);
		expect(
			getByRole("button", { name: /Bea Osei status/i }).hasAttribute(
				"disabled",
			),
		).toBe(false);
	});

	it("keeps the Guests group editable on a completed meeting too", () => {
		// Same capability, same evidence: `addMinutesGuest` / `removeMinutesGuest`
		// gate only on `assertAttendanceRecordable`, and the section this group was
		// lifted from let an officer add a guest they had missed to a closed-out
		// meeting. Without this the member chips would be correctable and the guest
		// list beside them dead — a half-applied fix.
		const { getByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				guests={[{ guestId: "g1", name: "Nadia Farouk", fromRole: false }]}
				clubGuests={[{ id: "g1", name: "Nadia Farouk" }]}
				locked={true}
				phaseCompleted={true}
			/>,
		);
		expect(
			getByRole("button", { name: /\+ Add guest/ }).hasAttribute("disabled"),
		).toBe(false);
		expect(
			getByRole("button", { name: /Remove Nadia Farouk/i }).hasAttribute(
				"disabled",
			),
		).toBe(false);
	});

	it("disables EVERY control while a write is in flight, not just the row being written", () => {
		// Whole-branch review C1. The panel's disable was PER-ROW (`pendingId`)
		// while the write path's refusal is GLOBAL and SILENT:
		// `useOfflineMinutes.mutate()` returns immediately on `busy || draining`
		// with no toast and no throw, and `busy` is held across the whole online
		// write — server fn plus a full `router.invalidate()`. So an officer taking
		// roll on a phone tapped down the roster at conversational pace and a large
		// fraction of the taps did nothing, with nothing on screen to say so.
		//
		// All four controls, because they are four separate `disabled` expressions:
		// the dashed one-tap suggestion, the recorded chip's menu trigger, and the
		// guests group's add and remove — that group was the worst of them, since
		// roll mode forces its lifecycle lock to `false`, so nothing disabled it
		// during a write at all AND it closes its popover unconditionally after
		// `onAddGuest`, making a discarded guest add look like a success.
		const withGuests = {
			...rollProps,
			attendance: [{ memberId: "m-bea", status: "present" as const }],
			guests: [{ guestId: "g1", name: "Nadia Farouk", fromRole: false }],
			clubGuests: [{ id: "g1", name: "Nadia Farouk" }],
		};
		const controls = (q: ReturnType<typeof render>) => [
			// Abe has no row and a `coming` plan → the dashed one-tap suggestion.
			q.getByRole("button", { name: /Abe Nkemelu status/i }),
			// Bea has a real row → the solid chip that opens the menu.
			q.getByRole("button", { name: /Bea Osei status/i }),
			q.getByRole("button", { name: /\+ Add guest/ }),
			q.getByRole("button", { name: /Remove Nadia Farouk/i }),
		];

		const busy = render(<MeetingAttendancePanel {...withGuests} busy={true} />);
		for (const el of controls(busy)) {
			expect(
				el.hasAttribute("disabled"),
				el.getAttribute("aria-label") ?? el.textContent ?? "",
			).toBe(true);
		}
		busy.unmount();

		// The control, in the SAME test: without it a `disabled={true}` — or a
		// `locked` that swallowed the whole group — reads as a pass while the panel
		// is dead for everyone.
		const idle = render(
			<MeetingAttendancePanel {...withGuests} busy={false} />,
		);
		for (const el of controls(idle)) {
			expect(
				el.hasAttribute("disabled"),
				el.getAttribute("aria-label") ?? el.textContent ?? "",
			).toBe(false);
		}
	});

	it("disables the menu's ITEMS too — a disabled trigger does not close an open menu", async () => {
		// Round 2, F1: the fourth control of the C1 test above is really a fifth.
		// Gating the trigger stops the menu OPENING while busy; it does nothing about
		// a menu that is already open. Reachable in the drain window specifically:
		// the officer opens this menu while everything is idle, wifi returns, the
		// auto-drain effect flips `draining`, and their pick is swallowed by
		// `mutate()`'s silent refusal.
		//
		// MECHANISM. "Render with busy, click to open" cannot work — the trigger is
		// now correctly disabled, so the click is a no-op and every assertion after
		// it would pass against a menu that never opened, which is worse than no
		// test. So: open the menu while `busy={false}`, then `rerender` the same tree
		// with `busy={true}`. Radix keeps `open` in the DropdownMenu root's own
		// state, untouched by our props, so the menu survives the re-render and the
		// items are re-rendered with the new prop — the exact state the bug needs.
		// The idle assertion before the flip is what proves the menu is genuinely
		// open, and doubles as the control.
		const onSetAttendance = vi.fn();
		const props = {
			...rollProps,
			// Bea has a recorded row, so her chip is the menu shape rather than the
			// dashed one-tap suggestion (which has no items to gate).
			attendance: [{ memberId: "m-bea", status: "present" as const }],
			onSetAttendance,
		};
		const { getByRole, findByRole, rerender } = render(
			<MeetingAttendancePanel {...props} busy={false} />,
		);
		// Radix opens on pointerdown, not a bare click — see the notes above.
		await userEvent.click(getByRole("button", { name: /Bea Osei status/i }));
		const idleItem = await findByRole("menuitem", { name: "Absent" });
		expect(
			idleItem.getAttribute("aria-disabled"),
			"the menu must actually be OPEN and its items live before the flip",
		).toBeNull();

		rerender(<MeetingAttendancePanel {...props} busy={true} />);
		const busyItem = getByRole("menuitem", { name: "Absent" });
		expect(busyItem.getAttribute("aria-disabled")).toBe("true");

		// The attribute is not the protection — the protection is that Radix skips
		// `onSelect` for a disabled item. Assert the write, not the styling: an
		// `aria-disabled` that merely greyed the row out would pass the line above
		// and still hand the tap to a `mutate()` that throws it away.
		fireEvent.click(busyItem);
		expect(onSetAttendance).not.toHaveBeenCalled();
	});

	it("expands by default below lg, unlike plan mode", () => {
		// Plan mode collapses to its counts line so a big roster does not push the
		// agenda off screen. Roll mode IS the task on meeting day, so it opens.
		const originalWidth = window.innerWidth;
		window.innerWidth = 375;
		try {
			const { getAllByRole } = render(
				<MeetingAttendancePanel {...rollProps} />,
			);
			expect(getAllByRole("button", { name: / status/i })).toHaveLength(2);
		} finally {
			window.innerWidth = originalWidth;
		}
	});

	it("omits the mobile Show/Hide toggle entirely, unlike plan mode", () => {
		// A deliberate deviation from plan mode (which shows/hides the toggle
		// with CSS at `lg` rather than removing it): roll mode has nothing for
		// the toggle to do, since it is always expanded (see the test above).
		// Nothing else here asserts this, so a later reader could "restore" the
		// toggle as dead code without any test noticing.
		const { queryByRole } = render(<MeetingAttendancePanel {...rollProps} />);
		expect(queryByRole("button", { name: /show|hide/i })).toBeNull();
	});

	it("renders the Guests group when guests are supplied", () => {
		const { getByText } = render(
			<MeetingAttendancePanel
				{...rollProps}
				guests={[{ guestId: "g1", name: "Nadia Farouk", fromRole: false }]}
				clubGuests={[{ id: "g1", name: "Nadia Farouk" }]}
			/>,
		);
		getByText("Guests");
		getByText("Nadia Farouk");
	});

	it("omits the Guests group entirely when `guests` is not supplied", () => {
		// The panel is presentational; a route that has not wired guests yet
		// must render nothing rather than an empty group.
		const { queryByText } = render(<MeetingAttendancePanel {...rollProps} />);
		expect(queryByText("Guests")).toBeNull();
	});
});
