// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
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

	it("offers a WhatsApp draft when a phone is on file, and says so when not", () => {
		const { getByText, getAllByRole } = renderPanel();
		expect(getAllByRole("link").length).toBeGreaterThan(0);
		expect(getByText(/No contact on file/i)).toBeTruthy();
	});

	it("shows the sign-up sheet's short code, with the full role as its tooltip", () => {
		// This test passes `roleByMemberId` as a literal and never calls
		// `buildShortCodes`, so it can only see that the panel RENDERS the code it
		// is handed and hangs the full role off it as `title` — the code alone is
		// not readable to someone who has not learnt the vocabulary. Where that
		// code comes from is the route's business (Task 4), and it is NOT a
		// guarantee of agreement with the season grid: the grid feeds
		// `buildShortCodes` a user-selectable window of meetings while the route
		// feeds one meeting's slots, so a numeric suffix can legitimately differ.
		const { getByText } = renderPanel({
			roleByMemberId: {
				m2: { code: "TMR", roleName: "Timer", confirmed: false },
			},
		});
		const badge = getByText("TMR");
		expect(badge.getAttribute("title")).toBe("Timer");
	});

	it("renders the optimistic override, not the server value", () => {
		// The whole point of the optimistic path: the chip changes on tap, before
		// any server round trip. Rendering `plan` here would show the stale rung
		// and the officer would tap twice.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "not_coming" as const }],
			rungOverride: { m1: "coming" as const },
		});
		// The ACCESSIBLE NAME, exact. The status value is composed into the name
		// from content rather than overridden by an `aria-label`, so this asserts
		// the officer and a screen-reader user get the same answer — and exact
		// equality means "Not coming" (the value being overridden here) fails.
		expect(
			getByRole("button", { name: "Ayesha Khan status: Coming" }),
		).toBeTruthy();
	});

	it("treats an override of null as cleared, not as absent", () => {
		// `null` and "no key" are different states and `??` cannot tell them
		// apart — an optimistic CLEAR would fall through to the server's old rung
		// and the chip would appear not to have changed.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
			rungOverride: { m1: null },
		});
		// EXACT name, not `toContain("Ask")`: "Asked" — the adjacent rung's label —
		// also contains "Ask", so the substring form stayed green with the unset
		// state rendering "Asked" (verified). That is the likeliest wrong value and
		// the worst one, since it claims outreach that never happened. An exact
		// name still rules it out, because "Asked" yields "…status: Asked".
		expect(
			getByRole("button", { name: "Ayesha Khan status: Ask" }),
		).toBeTruthy();
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

	it("invites a first answer instead of rendering what looks like a deletion", () => {
		const { getByRole } = renderPanel();
		// EXACT for the same reason as above: `toContain("Ask")` passes for "Asked",
		// which turns an invitation to make the first ask into a false claim that
		// the officer already did.
		const btn = getByRole("button", { name: "Ayesha Khan status: Ask" });
		// And what a SIGHTED officer reads — scoped WITHIN the row, because every
		// unanswered row renders "Ask" and an unscoped query matches them all.
		expect(within(btn).getByText("Ask").className).not.toContain("sr-only");
	});

	it("drafts a ROLE confirmation for a member who holds a slot", () => {
		// `mode` is COMPUTED at this call site, which is the #319 trap: a component
		// tested through its props cannot see a WRONG prop, and asserting that a
		// WhatsApp button merely EXISTS passes for either mode. So assert the text
		// the officer would actually send.
		const { getByRole } = renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: false },
			},
		});
		const href =
			getByRole("link", {
				name: /Message Ayesha Khan on WhatsApp/i,
			}).getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).toContain(
			"just confirming you're our Toastmaster",
		);
	});

	it("does not draft a confirmation to someone who has DECLINED their slot", () => {
		// The third axis. Both other `nudgeMode` tests vary role present/absent and
		// hold the answer at null, so keying the draft on `m.role` alone passed
		// both — while this row visibly reads "Not coming" and handed the officer
		// "just confirming you're our Toastmaster". A declined member still HOLDS
		// the slot until it is reassigned, so the role is present here.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "not_coming" as const }],
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		expect(
			getByRole("button", { name: "Ayesha Khan status: Not coming" }),
		).toBeTruthy();
		const href =
			getByRole("link", {
				name: /Message Ayesha Khan on WhatsApp/i,
			}).getAttribute("href") ?? "";
		const message = decodeURIComponent(href);
		expect(message).not.toContain("just confirming");
		expect(message).toContain("are you able to make our");
	});

	it("falls back to the attendance draft for a member with no slot", () => {
		const { getByRole } = renderPanel();
		const href =
			getByRole("link", {
				name: /Message Ayesha Khan on WhatsApp/i,
			}).getAttribute("href") ?? "";
		expect(decodeURIComponent(href)).toContain("are you able to make our");
	});

	it("marks the member contacted when the officer opens a draft", () => {
		// Tapping a draft is a real WRITE (no answer → reached_out) and it is the
		// only rung the officer never sets by hand. Severing the wiring
		// (`onContacted={() => {}}`) kept 17/17 green — `renderPanel` supplies the
		// spy on every render and nothing ever asserted against it.
		const { props, getByRole } = renderPanel();
		fireEvent.click(
			getByRole("link", { name: /Message Ayesha Khan on WhatsApp/i }),
		);
		expect(props.onContacted).toHaveBeenCalledWith("m1");
	});

	it("reads an ASSUMED Coming differently from an answered one", () => {
		// Same word, different accessible name. An officer must be able to tell
		// "she said yes" from "her role is confirmed", or the rail is claiming
		// replies nobody made.
		// BOTH DIRECTIONS in one render, the way the badge test below does it.
		// Asserting only the assumed arm passes for a row that announces "assumed"
		// unconditionally — verified: collapsing the conditional so every row got
		// the assumed string kept 17/17 green, which would tell an officer that a
		// roster where nobody answered and nobody holds a role is entirely
		// "Coming — assumed, role confirmed". m1 holds a confirmed role; m2 holds
		// none and has not answered.
		// `getByRole` with an EXACT `name` is the accessible-name assertion here —
		// jest-dom is not installed, so there is no `toHaveAccessibleName`, and
		// `getByRole` throws when nothing matches.
		const { getByRole, queryByRole, getByText } = renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		expect(
			getByRole("button", {
				name: "Ayesha Khan status: Coming — assumed, role confirmed",
			}),
		).toBeTruthy();
		// Same visible word as a real answer — the distinction is non-visual.
		expect(getByText("Coming").className).not.toContain("sr-only");

		// The NEGATIVE arm: no role, no answer, so nothing may claim an inference.
		expect(getByRole("button", { name: "Bo Lin status: Ask" })).toBeTruthy();
		expect(
			queryByRole("button", { name: /Bo Lin status.*assumed/i }),
		).toBeNull();
	});

	it("announces the full role, not the short code", () => {
		// The code is learnable vocabulary for a sighted officer scanning a column;
		// read aloud, "TD" is noise. The sr-only span is what makes the accessible
		// name the real role — and it is the reason the badge does NOT carry an
		// `aria-label`, which ARIA 1.2 prohibits on the bare <span> a Badge renders.
		const { getByText } = renderPanel({
			roleByMemberId: {
				m2: { code: "TMR", roleName: "Timer", confirmed: false },
			},
		});
		expect(getByText("TMR").getAttribute("aria-hidden")).toBe("true");
		// `classList.contains`, not `className.toContain`: `not-sr-only` is a real
		// Tailwind class that CONTAINS the substring "sr-only", so the substring
		// form stayed green while the full role name rendered VISIBLY beside the
		// code — defeating the short code this whole task is about.
		expect(getByText("Timer").classList.contains("sr-only")).toBe(true);
	});

	it("marks an assumed role badge apart from a merely-assigned one", () => {
		// ADDED beyond the plan, on the strength of its own mutation check:
		// flattening `variant` to a constant and deleting the tick left all 15
		// other tests green, so the VISUAL half of the assumed/answered
		// distinction was pinned by nothing. The status button's `aria-label`
		// carries that distinction for a screen reader; nothing carried it for
		// the eye. Both directions in one render, because a one-sided assertion
		// passes just as well for a badge that is always `default`.
		//
		// `data-variant` is Badge's own attribute rather than a Tailwind class,
		// so this survives a restyle and fails on an actual variant change. The
		// tick is asserted as "an svg is present", not as a specific lucide
		// class — the decision is that a glyph marks the row, not which glyph.
		const { getByText } = renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
				m2: { code: "TMR", roleName: "Timer", confirmed: false },
			},
		});
		// `getByText(code)` lands on the INNER code span — the badge's text is split
		// across the tick, the aria-hidden code and the sr-only role name — so walk
		// up to the Badge itself. `data-slot="badge"` is Badge's own attribute, and
		// `closest` survives another wrapper appearing in between.
		const badgeFor = (code: string) => {
			const badge = getByText(code).closest('[data-slot="badge"]');
			if (!badge) throw new Error(`no badge wrapping ${code}`);
			return badge;
		};

		const assumed = badgeFor("TD");
		expect(assumed.getAttribute("data-variant")).toBe("default");
		expect(assumed.querySelector("svg")).toBeTruthy();

		const assigned = badgeFor("TMR");
		expect(assigned.getAttribute("data-variant")).toBe("secondary");
		expect(assigned.querySelector("svg")).toBeNull();
	});

	it("renders a long name in full rather than cutting it off", () => {
		const { getByText } = renderPanel({
			roster: [
				{
					id: "m1",
					name: "Bartholomew Featherstonehaugh-Cholmondeley",
					preferredName: null,
					phone: null,
					email: null,
				},
			],
		});
		const el = getByText("Bartholomew Featherstonehaugh-Cholmondeley");
		// HONEST LIMIT: jsdom performs no layout, so the WRAP itself is not
		// assertable in process, and this diff is not worth standing up the
		// headless-Chrome harness for. What IS assertable is the mechanism — the
		// class that caused the cutoff is gone. Do not read a green run here as
		// proof of the rendered geometry.
		// BOTH halves, with word-boundary semantics. `not.toContain("truncate")`
		// alone passes for `line-clamp-1`, which reintroduces the very cutoff this
		// test exists to prevent — verified, it kept all 17 green. Removing the bad
		// class is only half the requirement; naming the class we DO want is what
		// closes it.
		expect(el.classList.contains("truncate")).toBe(false);
		expect(el.classList.contains("break-words")).toBe(true);
	});
});
