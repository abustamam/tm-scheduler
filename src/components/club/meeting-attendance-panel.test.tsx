// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	within,
} from "@testing-library/react";
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
	// The THIRD axis of the contact wiring, and the reason it is in the shared
	// fixture rather than one test's override: every other member here has
	// `preferredName: null` and NO member had an email at all, so `email={m.email}`
	// and `preferredName={m.preferredName}` could both be severed to `null` at the
	// `NudgeButtons` call site with the whole suite green (verified) — the
	// two-icon row never rendered and #486's goes-by-name feature was unprotected
	// on this surface. This name is the worked example from `person-name.ts`: the
	// first token is "Abdul-Rasheed", so a greeting reading "Rasheed" can ONLY
	// come from the recorded `preferredName` being wired through.
	{
		id: "m3",
		name: "Abdul-Rasheed Bustamam",
		preferredName: "Rasheed",
		phone: "+15559876543",
		email: "rasheed@club.example",
	},
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
		const { getByText, getAllByRole, container } = renderPanel({
			plan: [{ memberId: "m1", status: "coming" as const }],
		});
		expect(getByText("Ayesha Khan")).toBeTruthy();
		expect(getByText("Bo Lin")).toBeTruthy();
		expect(getByText("1 coming · 2 no answer")).toBeTruthy();
		// A real LIST, so an AT user gets a set size and a position in it. Asserted
		// by ROLE rather than by tag: reverting the `<ul>`/`<li>` to sibling divs
		// otherwise leaves the whole suite green, and the role is also what the
		// explicit `role="list"` on the wrapper exists to preserve on WebKit.
		expect(getAllByRole("listitem")).toHaveLength(3);
		// The wrapper's EXPLICIT `role="list"`, asserted at the ATTRIBUTE. Neither
		// `getAllByRole("listitem")` above nor a `getByRole("list")` can see it:
		// the `<li>`s carry their own implicit role, and jsdom gives the `<ul>` its
		// implicit one whether the attribute is there or not — so deleting the
		// attribute (and its two biome-ignore lines) left the whole suite green
		// AND the lint gate clean. The attribute exists because WebKit drops the
		// implicit role once preflight's `list-style: none` applies, which is a
		// property no jsdom query can reach.
		expect(container.querySelector("ul")?.getAttribute("role")).toBe("list");
	});

	// Every one of the four items, with the exact (label, status) pair each must
	// produce. Only "Coming" and "No answer" were ever clicked, so swapping
	// "Asked"→`not_coming` and "Not coming"→`reached_out` in `MENU` left the whole
	// suite green (verified): picking "Not coming" would have recorded the member
	// CONTACTED and picking "Asked" would have marked them ABSENT. The PAIR is the
	// assertion — a label-only or status-only check cannot see a swap, because both
	// values still exist, just against each other.
	//
	// Radix's DropdownMenuTrigger opens on `pointerdown`/`onKeyDown`, not `click`
	// (verified against @radix-ui/react-dropdown-menu's source) — a bare
	// `fireEvent.click` dispatches only a "click" MouseEvent and never opens it.
	// `userEvent.click` replays the real pointer sequence, matching how every other
	// Radix-trigger test in this repo opens one (e.g. meeting-export-menu.test.tsx,
	// meeting-toolbar.test.tsx). The menu ITEM click stays `fireEvent.click`:
	// Radix's MenuItem selects on a plain `onClick`, so the simpler event suffices.
	//
	// `null` for "No answer" is not a fourth status: clearing is a DELETE, and the
	// row's ABSENCE is the only encoding of "no answer". `null` is how the single
	// writer says so.
	it.each([
		{ label: "No answer", status: null },
		{ label: "Asked", status: "reached_out" as const },
		{ label: "Coming", status: "coming" as const },
		{ label: "Not coming", status: "not_coming" as const },
	])("records $label as the $status rung", async ({ label, status }) => {
		const { props, getByRole, findByRole } = renderPanel();
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: label }));
		expect(props.onWriteRung).toHaveBeenCalledWith("m1", status);
		// Exactly ONE write. Without this a second call carrying a different status
		// would still satisfy the assertion above.
		expect(props.onWriteRung).toHaveBeenCalledTimes(1);
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
		expect(getByText("1 coming · 2 no answer")).toBeTruthy();
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
			expect(getByText("3 no answer")).toBeTruthy();
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

	it("never renders the sync indicator in plan mode", () => {
		// Plan writes go straight to `setPlannedAttendance` and never touch the
		// offline queue, so a queue count here would describe someone else's work.
		const { queryByText } = renderPanel({
			sync: {
				online: false,
				queueCount: 2,
				draining: false,
				syncError: null,
				justSynced: false,
				onRetry: () => {},
			},
		});
		expect(queryByText(/saved on this device/)).toBeNull();
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

	it("marks the member contacted when a draft is opened, unless locked", () => {
		// Tapping a draft is a real WRITE (no answer → reached_out) and it is the
		// only rung the officer never sets by hand. Severing the wiring
		// (`onContacted={() => {}}`) kept 17/17 green — `renderPanel` supplies the
		// spy on every render and nothing ever asserted against it.
		const unlocked = renderPanel();
		fireEvent.click(
			unlocked.getByRole("link", { name: /Message Ayesha Khan on WhatsApp/i }),
		);
		expect(unlocked.props.onContacted).toHaveBeenCalledWith("m1");
		cleanup();

		// BOTH arms. Deleting the guard's `if (locked) return;` left the suite
		// green too, so the nine-line comment defending it described behaviour
		// nothing observed. The draft still OPENS on a locked meeting — the link is
		// never disabled — a locked meeting simply records nothing against it.
		const locked = renderPanel({ locked: true });
		fireEvent.click(
			locked.getByRole("link", { name: /Message Ayesha Khan on WhatsApp/i }),
		);
		expect(locked.props.onContacted).not.toHaveBeenCalled();
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
		// And the same distinction VISIBLY, which it did not carry before Fix 1:
		// the word was identical to a real answer and the only visible signal was
		// the muting — a grey control says "less important", never "nobody said
		// this". Now the control spells it out.
		expect(getByText("Coming · assumed").className).not.toContain("sr-only");

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

	it("shows a stored Asked ON TOP of an assumed Coming, so the pick is visible", () => {
		// The rung an officer picks to record "I chased them" cannot outrank a
		// confirmed role, so without surfacing `storedStatus` the control came back
		// from its disabled round trip reading exactly what it read before — which
		// reads as "it didn't save", so they tap again. Both the visible label and
		// the announced name have to carry it.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "reached_out" as const }],
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		const btn = getByRole("button", {
			name: "Ayesha Khan status: Coming — assumed, role confirmed, already asked",
		});
		// EXACT, which is also what pins "one qualifier, never two": "asked"
		// already carries "nobody answered", so "Coming · assumed · asked" would
		// say it twice — and would fail here.
		expect(within(btn).getByText("Coming · asked")).toBeTruthy();
	});

	it("drops the stored Asked when the officer clears it back to no answer", () => {
		// The other half of the same transition, driven through the optimistic
		// path the route actually uses: clearing DELETES a real row and logs it,
		// so it must be visible even though the effective status cannot move.
		// An assumed row with no stored rung reads exactly as it did before.
		const { getByRole, getByText, queryByText } = renderPanel({
			plan: [{ memberId: "m1", status: "reached_out" as const }],
			rungOverride: { m1: null },
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		expect(
			getByRole("button", {
				name: "Ayesha Khan status: Coming — assumed, role confirmed",
			}),
		).toBeTruthy();
		expect(queryByText("Coming · asked")).toBeNull();
		// It reads as a plain assumed row again — the qualifier falls BACK to
		// "assumed" rather than disappearing, which is what makes the clear
		// visible at all now that the badge no longer carries assumed-ness.
		expect(getByText("Coming · assumed")).toBeTruthy();
	});

	it("mutes the control on an assumed row but not on an answered one", () => {
		// The spec states the assumed/answered distinction as one sentence with
		// three parts — badge tick, MUTED CONTROL, accessible name. The badge test
		// below closed the tick and the variant; deleting the whole `className`
		// muting prop still left the suite green. Two-sided in one render, for the
		// same reason that test gives: a one-sided assertion passes for a control
		// that is always muted. `classList`, not `className.toContain`, because
		// "text-muted-foreground" is a SUBSTRING of "hover:text-muted-foreground"
		// and the hover class alone would satisfy the substring form.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m2", status: "coming" as const }],
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
			},
		});
		const assumed = getByRole("button", { name: /Ayesha Khan status/i });
		expect(assumed.classList.contains("text-muted-foreground")).toBe(true);
		// The hover arm is a SEPARATE selector: the `outline` variant's
		// `hover:text-accent-foreground` outranks a bare `text-muted-foreground`
		// on hover, so muting without it un-mutes under the cursor.
		expect(assumed.classList.contains("hover:text-muted-foreground")).toBe(
			true,
		);

		const answered = getByRole("button", { name: /Bo Lin status/i });
		expect(answered.classList.contains("text-muted-foreground")).toBe(false);
		expect(answered.classList.contains("hover:text-muted-foreground")).toBe(
			false,
		);
	});

	it("keeps the role badge on one axis and puts assumed-ness on the control", () => {
		// The two emphasis signals on this row used to point OPPOSITE WAYS. The
		// badge went filled-`default` plus a Check when `assumed` — which fires only
		// when NOBODY REPLIED — making the rail's highest-contrast element, wearing
		// the universal glyph for VERIFIED, the marker of the one status nobody
		// verified; meanwhile the control beside it was muted to say "trust this
		// least". A member who explicitly answered "Coming" while holding the same
		// confirmed slot got the quieter treatment of the two.
		//
		// So each element gets ONE job, and this test asserts both halves of that in
		// one render: the badge must NOT move with `assumed`, and the control MUST.
		// Both directions each, because a one-sided assertion passes just as well
		// for a badge that is always `default` or a control that is always
		// qualified. `data-variant` is Badge's own attribute rather than a Tailwind
		// class, so it survives a restyle and fails on an actual variant change.
		//
		// m1 is assumed (confirmed role, no answer); m2 ANSWERED coming while also
		// holding a role. Same rung word on both controls, so the qualifier is the
		// only difference between them — and both carry a badge, so the badge
		// comparison is like-for-like too.
		const { getByText, getByRole } = renderPanel({
			plan: [{ memberId: "m2", status: "coming" as const }],
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: true },
				m2: { code: "TMR", roleName: "Timer", confirmed: false },
			},
		});
		// `getByText(code)` lands on the INNER code span — the badge's text is split
		// across the aria-hidden code and the sr-only role name — so walk up to the
		// Badge itself. `data-slot="badge"` is Badge's own attribute, and `closest`
		// survives another wrapper appearing in between.
		const badgeFor = (code: string) => {
			const badge = getByText(code).closest('[data-slot="badge"]');
			if (!badge) throw new Error(`no badge wrapping ${code}`);
			return badge;
		};

		// ONE AXIS: "holds a role", answered identically for everyone who does.
		expect(badgeFor("TD").getAttribute("data-variant")).toBe("secondary");
		expect(badgeFor("TMR").getAttribute("data-variant")).toBe("secondary");
		// And no glyph on either. Asserted as "no svg at all" rather than as a
		// specific lucide class: the decision is that NOTHING marks the badge, not
		// that one particular icon is gone.
		expect(badgeFor("TD").querySelector("svg")).toBeNull();
		expect(badgeFor("TMR").querySelector("svg")).toBeNull();

		// The CONTROL is where the distinction lives now, and it does move.
		const assumed = getByRole("button", { name: /Ayesha Khan status/i });
		const answered = getByRole("button", { name: /Bo Lin status/i });
		expect(within(assumed).getByText("Coming · assumed")).toBeTruthy();
		// EXACT "Coming", so a qualifier leaking onto an ANSWERED row fails here.
		expect(within(answered).getByText("Coming")).toBeTruthy();
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
		// And the CAP, which the two assertions above permitted but never
		// required. Design doc §3 says "capped at 2 lines"; the element had
		// `break-words` and no clamp at all, so `name` — unbounded user data —
		// grew the row without limit and `line-clamp-2` was satisfied by nothing.
		// This is the assertion that distinguishes the spec's reading from the
		// merely-not-truncated one.
		expect(el.classList.contains("line-clamp-2")).toBe(true);
	});

	it("greets by the recorded preferred name, in both drafts", () => {
		// #486 wired end to end on THIS surface. Severing either prop at the
		// `NudgeButtons` call site — `email={null}` or `preferredName={null}` — left
		// the suite green (both verified), because no fixture had an email at all
		// and every fixture had a null preferred name. The mail draft is the half
		// that could not render at all.
		const { getByRole } = renderPanel();
		const wa = decodeURIComponent(
			getByRole("link", {
				name: /Message Abdul-Rasheed Bustamam on WhatsApp/i,
			}).getAttribute("href") ?? "",
		);
		// The mail draft exists at all only because `email` is wired.
		const mailHref =
			getByRole("link", { name: "Email Abdul-Rasheed Bustamam" }).getAttribute(
				"href",
			) ?? "";
		expect(mailHref.startsWith("mailto:rasheed@club.example")).toBe(true);
		const mail = decodeURIComponent(mailHref);

		expect(wa).toContain("Hi Rasheed,");
		expect(mail).toContain("Hi Rasheed,");
		// The fallback this OVERRIDES, asserted explicitly: with `preferredName`
		// unwired, `greetingName` falls back to the first token of the stored name
		// and drafts "Hi Abdul-Rasheed,". Naming the wrong value is what makes the
		// positive assertions above about the WIRING rather than about the greeting
		// happening to contain a substring.
		expect(wa).not.toContain("Hi Abdul-Rasheed,");
		expect(mail).not.toContain("Hi Abdul-Rasheed,");
	});

	it("names a plain Asked row by its rung", () => {
		// `RUNG_LABELS.reached_out` was pinned by nothing: no test rendered a plain
		// `reached_out` row with no role, so renaming it to "Contacted" left the
		// suite green (verified). The two tests that touch this rung elsewhere read
		// the "· asked" QUALIFIER, which is a different string entirely, and the
		// "Ask"/"Asked" pair is asserted only in the direction that rules "Asked"
		// OUT. m1 holds no role here, so nothing can outrank the stored rung.
		const { getByRole } = renderPanel({
			plan: [{ memberId: "m1", status: "reached_out" as const }],
		});
		expect(
			getByRole("button", { name: "Ayesha Khan status: Asked" }),
		).toBeTruthy();
	});

	it("disables only the in-flight row's control while a write is pending", async () => {
		// `disabled={locked || pending}` could be reduced to `disabled={locked}`
		// with the suite green (verified) — nothing ever observed a write mid-flight,
		// because every `onWriteRung` spy resolved instantly. The route's own guard
		// file cites this per-row `pendingId` as the precedent justifying a strip
		// guard, so the cited precedent was protected by nothing.
		//
		// Resolved from a DEFERRED promise so the assertions land between the write
		// starting and finishing, which is the only window the guard exists for.
		let release!: () => void;
		const onWriteRung = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const { getByRole, findByRole } = renderPanel({ onWriteRung });
		await userEvent.click(getByRole("button", { name: /Ayesha Khan status/i }));
		fireEvent.click(await findByRole("menuitem", { name: "Coming" }));

		// Mid-flight: the row that is writing is busy …
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(true);
		// … and ONLY that row. `pendingId` is per-member on purpose; a blanket busy
		// flag would freeze all forty controls on one tap, which is the failure this
		// half rules out.
		expect(
			getByRole("button", { name: /Bo Lin status/i }).hasAttribute("disabled"),
		).toBe(false);

		// And it releases. A guard that never clears is a locked rail.
		await act(async () => {
			release();
		});
		expect(
			getByRole("button", { name: /Ayesha Khan status/i }).hasAttribute(
				"disabled",
			),
		).toBe(false);
	});

	it("absorbs a fat-finger on the message drafts, not only on the status control", async () => {
		// `pending` is computed per row and threaded into `AttendanceRow`, but it
		// reached ONLY the dropdown trigger's `disabled`. The two draft links are
		// bare anchors and `disabled` does not exist on an `<a>`, so during one
		// in-flight write the status control read `disabled = true` while the
		// WhatsApp anchor read `disabled = false` / `aria-disabled = null`, and four
		// taps fired four writes. Verified against the fix: reverting `contacted` to
		// `if (locked) return;` fails this with 4 calls.
		//
		// The guard has to live in the panel because neither layer below absorbs
		// it. The route's `markAsked` resolves `current` from the `rungOverride`
		// captured at render, so same-tick taps all see `null`; and the server's
		// `setPlanStatus` MATCHES an existing `reached_out` row, so `returning()` is
		// non-empty and every duplicate lands another `plan_set` in `activity_log`.
		// Not corruption — `demoteFrom` still stops a late nudge overwriting a real
		// answer — but N requests, N router invalidates, N duplicate feed rows.
		//
		// Deferred promise, the same shape as the trigger test above and for the
		// same reason: the extra taps must land between the write starting and
		// finishing, which is the only window the guard exists for. Re-queried each
		// time rather than held, so this cannot pass by tapping a detached node.
		let release!: () => void;
		const onContacted = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const { getByRole } = renderPanel({ onContacted });
		const wa = () =>
			getByRole("link", { name: /Message Ayesha Khan on WhatsApp/i });
		fireEvent.click(wa());
		fireEvent.click(wa());
		fireEvent.click(wa());
		fireEvent.click(wa());
		expect(onContacted).toHaveBeenCalledTimes(1);

		// And it RELEASES. A guard that never clears records the first ask and
		// silently drops every one after it for the life of the mount — worse than
		// the bug it closes, and invisible without this half.
		await act(async () => {
			release();
		});
		fireEvent.click(wa());
		expect(onContacted).toHaveBeenCalledTimes(2);
	});

	it("gives the action line two hard edges and a legible chevron", () => {
		// HONEST LIMIT, the same one the long-name test states: jsdom performs no
		// layout and loads no stylesheet, so none of this is the rendered GEOMETRY or
		// the computed CONTRAST. What is assertable is the mechanism that produces
		// them, and without these three the fixes below are pinned by nothing.
		const { getByRole } = renderPanel();
		const trigger = getByRole("button", { name: /Ayesha Khan status/i });

		// A FIXED TRACK plus `justify-between` = two hard vertical edges. `justify-end`
		// alone flushes only the right one, and this trigger is `whitespace-nowrap`
		// with a label running ~66px ("Ask") to ~172px ("Coming · assumed"), so the
		// two icon buttons to its left jittered by that delta down the column — a
		// crooked action column traded for a crooked status column. `w-44` (176px) is
		// measured against the widest label plus the sm button's 42px of chrome.
		expect(trigger.classList.contains("w-44")).toBe(true);
		expect(trigger.classList.contains("justify-between")).toBe(true);

		// WCAG 1.4.11. The chevron inherits `currentColor`, so on a muted row
		// `opacity-60` composited it to 2.66:1 against `--foam` — under the 3:1 a
		// non-text indicator needs. The muting is already the de-emphasis.
		const chevron = trigger.querySelector("svg");
		expect(chevron).toBeTruthy();
		expect(chevron?.classList.contains("opacity-60")).toBe(false);

		// 6px between the status control and Email put two DIFFERENT actions inside
		// one fat-finger: a slip writes `reached_out` and throws the tablet into a
		// mail client mid-meeting. WhatsApp and Email keep their 6px — same member,
		// same handler — so both halves are asserted, or "widen everything" passes.
		const actionLine = trigger.parentElement;
		expect(actionLine?.classList.contains("gap-3")).toBe(true);
		expect(actionLine?.classList.contains("gap-1.5")).toBe(false);
		const nudges = getByRole("link", {
			name: /Message Ayesha Khan on WhatsApp/i,
		}).closest("div");
		expect(nudges?.classList.contains("gap-1.5")).toBe(true);
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

	it("F1: marks a suggestion row ABSENT in one menu interaction, with no false `present` first", async () => {
		// THE reason this round exists, and an assertion that was previously
		// unrepresentable — which is why four review rounds passed over the bug.
		//
		// Roll call exists to record the EXCEPTIONS: a member who answered "coming"
		// and is not in the room. That was the WORST-supported path here. Abe's row
		// is the dashed one-tap suggestion, and it was the row's only control, so
		// the only route to `absent` was tap "Present?" (a false row in
		// `meeting_attendance`, the table the PDF and the emailed minutes print),
		// wait out the round trip, then open the now-solid chip and pick the truth.
		const onSetAttendance = vi.fn();
		const { getByRole, findByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				onSetAttendance={onSetAttendance}
			/>,
		);
		// Radix opens on pointerdown, not a bare click — see the notes above.
		await userEvent.click(
			getByRole("button", {
				name: /Record a different attendance for Abe Nkemelu/i,
			}),
		);
		fireEvent.click(await findByRole("menuitem", { name: "Absent" }));
		// EXACTLY ONCE is the load-bearing half. `toHaveBeenCalledWith` alone passes
		// for the two-write path this test exists to forbid — a `present` followed
		// by an `absent` satisfies it, and that is precisely what shipped.
		expect(onSetAttendance).toHaveBeenCalledTimes(1);
		expect(onSetAttendance).toHaveBeenCalledWith("m-abe", "absent");
	});

	it("F1: keeps the one-tap commit, rather than replacing it with the menu", () => {
		// The other half of the fix, and the direction a later "simplification"
		// would break: the menu is ADDED beside the dashed commit, not substituted
		// for it. One tap for the common case is what makes 40 names workable in a
		// room, so the commit must still fire on the FIRST tap and must not open
		// anything. The sibling test above asserts the write; this one asserts no
		// menu appeared, which is the part a menu-only rewrite would fail.
		const onSetAttendance = vi.fn();
		const { getByRole, queryByRole } = render(
			<MeetingAttendancePanel
				{...rollProps}
				onSetAttendance={onSetAttendance}
			/>,
		);
		fireEvent.click(getByRole("button", { name: /Abe Nkemelu status/i }));
		expect(onSetAttendance).toHaveBeenCalledTimes(1);
		expect(onSetAttendance).toHaveBeenCalledWith("m-abe", "present");
		expect(queryByRole("menu")).toBeNull();
	});

	it("F1: gates the suggestion row's new menu trigger on the same in-flight signal", () => {
		// The suggestion row is now TWO controls, and the C1 test below enumerates
		// the ones that existed when it was written. A new control that is not on
		// `busy` hands its tap to `mutate()`'s silent refusal — the exact hole C1
		// was written to close, reopened by the fix beside it. Both directions, so a
		// permanently-disabled trigger cannot pass.
		const trigger = (q: ReturnType<typeof render>) =>
			q.getByRole("button", {
				name: /Record a different attendance for Abe Nkemelu/i,
			});
		const busy = render(<MeetingAttendancePanel {...rollProps} busy={true} />);
		expect(trigger(busy).hasAttribute("disabled")).toBe(true);
		busy.unmount();
		const idle = render(<MeetingAttendancePanel {...rollProps} busy={false} />);
		expect(trigger(idle).hasAttribute("disabled")).toBe(false);
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
		// Four controls here, because they are four separate `disabled` expressions:
		// the dashed one-tap suggestion, the recorded chip's menu trigger, and the
		// guests group's add and remove — that group was the worst of them, since
		// roll mode forces its lifecycle lock to `false`, so nothing disabled it
		// during a write at all AND it closes its popover unconditionally after
		// `onAddGuest`, making a discarded guest add look like a success.
		//
		// A FIFTH control is covered by its own test below rather than here: the
		// items INSIDE the recorded chip's menu. Disabling a Radix trigger does not
		// close content that is already open, so a menu opened before a drain began
		// stayed live — and that case needs one render held open across a prop flip,
		// which does not fit this test's two-renders-with-an-unmount shape.
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
	it("skips the contact affordance for a DEPARTED row while keeping it for an active member with none", () => {
		// Two fixes from the same round contradicted each other here.
		// `deriveRollRoster` appends a member who holds a recorded row but has left
		// the club, with phone and email null — and `NudgeButtons` renders "No
		// contact on file" when both are null, which is precisely the copy
		// `hideContact` omits the whole component to avoid. Fixed by TAGGING the
		// appended row, not by skipping whenever contact is missing: for an active
		// member that message is true and actionable ("go add a number"), and only
		// a departed member has nothing to add and nobody to chase.
		const { getByText, queryAllByText } = render(
			<MeetingAttendancePanel
				{...rollProps}
				roster={[
					{ id: "m-here", name: "Cy Active", phone: null, email: null },
					{
						id: "m-gone",
						name: "Dee Gone",
						phone: null,
						email: null,
						departed: true,
					},
				]}
				attendance={[{ memberId: "m-gone", status: "present" }]}
			/>,
		);
		// Both rows are on screen...
		getByText("Cy Active");
		getByText("Dee Gone");
		// ...and exactly ONE of them says it: the active member with nothing stored.
		expect(queryAllByText("No contact on file")).toHaveLength(1);
	});

	const syncIdle = {
		online: true,
		queueCount: 0,
		draining: false,
		syncError: null,
		justSynced: false,
		onRetry: () => {},
	};

	it("says so when roll writes are queued on this device", () => {
		// Roll mode is the ONLY surface that records attendance now, and the
		// projection is faithful — every chip moves offline exactly as it would
		// online. So without this the officer has no way to tell the difference,
		// and the drain only ever runs if someone reopens THAT meeting in THAT
		// browser; the PDF and the emailed minutes go out with the roll missing.
		const { getByText } = render(
			<MeetingAttendancePanel
				{...rollProps}
				sync={{ ...syncIdle, online: false, queueCount: 2 }}
			/>,
		);
		getByText(/2 changes saved on this device/);
	});

	it("shows the drain in flight and offers Retry on a sync error", async () => {
		const draining = render(
			<MeetingAttendancePanel
				{...rollProps}
				sync={{ ...syncIdle, draining: true, queueCount: 3 }}
			/>,
		);
		draining.getByText(/Syncing 3 changes/);
		draining.unmount();

		const onRetry = vi.fn();
		const failed = render(
			<MeetingAttendancePanel
				{...rollProps}
				sync={{ ...syncIdle, syncError: "nope", onRetry }}
			/>,
		);
		failed.getByText(/Couldn't sync changes/);
		await userEvent.click(failed.getByRole("button", { name: "Retry" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("shows nothing in the steady state, so the header does not grow a blank row", () => {
		const { queryByText } = render(
			<MeetingAttendancePanel {...rollProps} sync={syncIdle} />,
		);
		expect(queryByText(/saved on this device/)).toBeNull();
		expect(queryByText(/Syncing/)).toBeNull();
		expect(queryByText(/Couldn't sync/)).toBeNull();
	});

	it("keeps the indicator visible on a completed meeting, where corrections are made", () => {
		// `phaseCompleted` drops the contact drafts; it must not drop the one thing
		// that says an unsynced correction is still sitting on this device.
		const { getByText } = render(
			<MeetingAttendancePanel
				{...rollProps}
				locked={true}
				phaseCompleted={true}
				sync={{ ...syncIdle, online: false, queueCount: 1 }}
			/>,
		);
		getByText(/1 change saved on this device/);
	});
});
