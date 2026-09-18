// The route→surface wiring for duty-aware nudge drafts (#667).
//
// `nudge.test.ts` proves the builder, `nudge-duty-wiring.test.tsx` proves each
// component passes what it is given. Neither can see this route: mounting it
// needs a QueryClientProvider, the identity gate, the minutes query and the
// whole agenda, which is why every derivation it holds is guarded by a source
// grep here — the same reason, and the same shape, as the two
// `attendance-*-wiring.guard.test.ts` files beside it.
//
// The gap this closes is specific and wide: `dutiesByMemberId`,
// `personalNudgeBase` and the agenda's `personalNudgeBase` are all OPTIONAL
// props with silent defaults, so deleting any one of them from the route
// typechecks, renders, and ships the pre-#667 draft with every component suite
// green. There is nothing to throw and nobody to notice except the member who
// gets the message.
//
// COMMENT-BLIND (`readSource`): every assertion is of the "this pattern must BE
// present" form, and this file quotes the patterns it looks for — a raw read
// would pass on a commented-out wiring. See `src/test/guard-source.ts`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"./club.$clubId.meeting.$meetingId.tsx",
);

describe("duty-aware nudge route wiring (#667)", () => {
	const src = readSource(ROUTE);

	// Both call sites are windowed, for the reason the sibling guard measured:
	// <MeetingAgenda> and <MeetingAttendancePanel> take same-named props, so a
	// whole-file `toContain` stays green when a prop is cleanly SWAPPED between
	// them — matched at the other component's tag.
	const panelAt = src.indexOf("<MeetingAttendancePanel");
	const panelProps = src.slice(panelAt, src.indexOf("/>", panelAt));
	const agendaAt = src.indexOf("<MeetingAgenda");
	const agendaProps = src.slice(agendaAt, src.indexOf("/>", agendaAt));

	it("finds both call sites at all", () => {
		// Without this, a renamed or deleted element makes a window the empty
		// string and turns every `toContain` below into a failure whose message
		// says nothing about the cause.
		expect(
			panelAt,
			"expected a <MeetingAttendancePanel … /> call site",
		).toBeGreaterThan(-1);
		expect(
			agendaAt,
			"expected a <MeetingAgenda … /> call site",
		).toBeGreaterThan(-1);
	});

	it("builds the rail's duty map with the extracted, unit-tested function", () => {
		// The WHOLE statement, not just the function name. Two arguments are
		// load-bearing and both are silent when wrong:
		//
		//  - `slots` UNFILTERED, like `buildPanelRoleMap(slots)` beneath it. A
		//    filtered argument still produces a plausible map, missing exactly
		//    the members whose rows the filter dropped.
		//  - `meeting`, which carries `theme` and `wordOfTheDay`. Passing `{}`
		//    typechecks (every `DutyContext` field is optional) and makes every
		//    duty outstanding forever — the draft then chases a Toastmaster about
		//    a theme the club set a week ago, which is the exact failure #667
		//    calls "suppression is the requirement, not a nicety".
		expect(src).toContain(
			"const nudgeDutiesByMemberId = outstandingDutiesByMember(slots, meeting);",
		);
	});

	it("keeps the personal link's three parts pointing at THIS club and meeting", () => {
		// `clubId` is the club's URL segment and `urlKey` the meeting's; the
		// route also holds `meeting.clubId` (a uuid) and `meeting.id`, either of
		// which builds a URL that resolves to nothing the reader can use.
		// Whitespace-collapsed because the formatter owns the line breaks.
		expect(src.replace(/\s+/g, " ")).toContain(
			"const nudgePersonalBase = { origin: nudgeOrigin, clubId, meetingKey: urlKey, };",
		);
	});

	it("leaves the public share link pointing at the public meeting page", () => {
		// The role-less `attendance` / `arriving` drafts ask about the MEETING, so
		// they keep this link — #667 changes what the ROLE arms link to and
		// nothing else. Repointing `nudgeShareUrl` at `/me` would silently give
		// every "are you coming?" draft a personal page with no `?as=` on it.
		expect(src).toContain(
			"const nudgeShareUrl = `${nudgeOrigin}/club/${clubId}/meeting/${urlKey}`;",
		);
	});

	it("hands the rail its duty map and its link base", () => {
		// BARE names, not the agenda's `effectiveCanManage ? … : null` form: the
		// panel only ever mounts for someone who runs the meeting, and copying
		// the guarded expression here would strip the clause and the link out of
		// every draft the rail sends.
		expect(panelProps).toContain("dutiesByMemberId={nudgeDutiesByMemberId}");
		expect(panelProps).toContain("personalNudgeBase={nudgePersonalBase}");
	});

	it("hands the agenda the link base, gated like its share link", () => {
		// <MeetingAgenda> renders for plain members too, so this follows
		// `shareUrl` rather than the rail's bare form.
		expect(agendaProps).toContain(
			"personalNudgeBase={effectiveCanManage ? nudgePersonalBase : null}",
		);
	});
});
