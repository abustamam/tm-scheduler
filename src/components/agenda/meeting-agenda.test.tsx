// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isMeetingOver,
	lockedViewer,
	resolveMeetingViewer,
} from "#/lib/meeting-lifecycle";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";

// The component imports the AssignSlot/EditSpeech sheets, which pull in the
// server-fn modules and their `#/db` import. Those handlers never run in this
// render-only test, so stub the db client to avoid the eager "DATABASE_URL is
// not set" throw at import time. `vi.mock` is hoisted above the imports.
vi.mock("#/db", () => ({ db: {} }));

const noop = async () => {};
const actions: MeetingAgendaActions = {
	claim: noop,
	release: noop,
	addSpeaker: noop,
	removeSpeaker: noop,
	confirm: noop,
	unconfirm: noop,
	moveSpeaker: noop,
	removeRole: noop,
	takeover: noop,
	onMutated: noop,
};

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s1",
		roleName: "Timer",
		roleDefinitionId: "rd1",
		category: "functionary",
		isSpeakerRole: false,
		slotIndex: 0,
		status: "open",
		assigneeId: null,
		assigneeName: null,
		speechTitle: null,
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		description: null,
		evaluates: null,
		...over,
	} as unknown as AgendaSlot;
}

const DAY_MS = 86_400_000;
/** Relative so the fixtures never rot: 30 days clears any tz day boundary. */
const daysFromNow = (n: number) =>
	new Date(Date.now() + n * DAY_MS).toISOString();

function meetingFixture(
	over: Partial<{ scheduledAt: string; status: string }> = {},
): MeetingAgendaProps["meeting"] {
	return {
		id: "m1",
		scheduledAt: daysFromNow(30),
		status: "scheduled",
		lengthMinutes: 90,
		theme: null,
		location: null,
		wordOfTheDay: null,
		wodDefinition: null,
		wodExample: null,
		notes: null,
		...over,
	} as unknown as MeetingAgendaProps["meeting"];
}

function renderAgenda(
	viewer: ReturnType<typeof meetingViewer>,
	slots: AgendaSlot[],
	pairedRoleIds?: Set<string>,
	requireIdentity?: () => Promise<{ id: string; name: string } | null>,
	extra?: Partial<MeetingAgendaProps>,
) {
	// Production-faithful: the route computes `meetingOver` once with
	// `isMeetingOver` and hands it down, so derive it from whatever meeting the
	// caller actually renders (#393). An `extra.meetingOver` still wins, for the
	// tests that pin an injected clock.
	const meeting = extra?.meeting ?? meetingFixture();
	const timezone = extra?.timezone ?? "UTC";
	return render(
		<MeetingAgenda
			slots={slots}
			viewer={viewer}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			unavailableMemberIds={[]}
			pairedRoleIds={pairedRoleIds}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
			meeting={meeting}
			timezone={timezone}
			meetingOver={isMeetingOver({
				status: meeting.status,
				scheduledAt: meeting.scheduledAt,
				timezone,
			})}
			selfMemberId="me"
			onMetaSaved={() => {}}
			requireIdentity={requireIdentity}
			contactedMemberIds={[]}
			{...extra}
		/>,
	);
}

describe("MeetingAgenda capability gating", () => {
	afterEach(() => cleanup());

	it("shows admin controls (stats, confirm) for a manager", () => {
		const filled = slot({
			id: "s1",
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
			category: "leadership",
			roleName: "Toastmaster",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[filled],
		);
		expect(screen.getByText("Open roles:")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Reassign/ })).toBeTruthy();
	});

	it("keeps the manager stats strip free of the removed 'Remind unfilled' placeholder (#542, F-010)", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({})],
		);
		// Anchor first: the SECTION the placeholder lived in is rendered — an
		// absence assertion against an unrendered section passes vacuously.
		expect(screen.getByText("Roles filled")).toBeTruthy();
		// The disabled "(soon)" button (#7) was removed by #542/F-010; this fails
		// if it — or any premature "Remind" control — comes back before reminder
		// sending actually exists.
		expect(screen.queryByRole("button", { name: /remind/i })).toBeNull();
		expect(screen.queryByText(/remind unfilled/i)).toBeNull();
	});

	it("shows a guest speaker's name (not 'Open') on a claimed slot", () => {
		// A guest (e.g. a club mentor) is assigned to a speaker slot: the slot
		// carries assigneeGuestId/assigneeName but no member id. Regression:
		// the name gate keyed off the MEMBER id, so the slot rendered "Open".
		const guestSlot = slot({
			id: "s1",
			status: "claimed",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			assigneeId: null,
			assigneeGuestId: "g1",
			assigneeName: "Mentor Mike",
			assigneeIsGuest: true,
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[guestSlot],
		);
		expect(screen.getByText("Mentor Mike")).toBeTruthy();
		// The "Guest" badge should render alongside the name.
		expect(screen.getByText("Guest")).toBeTruthy();
	});

	it("hides manager-only controls for a signed-in non-manager", () => {
		const filled = slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
				isSignedIn: true,
			}),
			[filled],
		);
		expect(screen.queryByText("Open roles:")).toBeNull();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Reassign/ })).toBeNull();
		// A signed-in non-manager keeps self-serve take-over; only the
		// manager-only controls above stay hidden. (Take-over is now
		// signed-in-only — see the self-asserted-member case below.)
		expect(screen.getByText("take over")).toBeTruthy();
		expect(screen.getByText("Filled")).toBeTruthy();
	});

	it("hides takeover for a self-asserted (name-pick) member", () => {
		const filled = slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[filled],
		);
		expect(screen.queryByText("take over")).toBeNull();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		expect(screen.queryByText("Open roles:")).toBeNull();
		// Not TMOD → no assign picker.
		expect(screen.queryByRole("button", { name: /Reassign/ })).toBeNull();
	});

	it("gives a visitor with no name an enabled Claim that resolves identity on click", async () => {
		const requireIdentity = vi.fn(async () => null); // dismissed → aborts
		renderAgenda(
			meetingViewer({
				currentMemberId: null,
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
			undefined,
			requireIdentity,
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(false);
		await userEvent.click(claim);
		expect(requireIdentity).toHaveBeenCalled();
		// Still no manager assign picker for an anonymous visitor.
		expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull();
	});

	it("keeps Claim disabled for a memberless viewer with no requireIdentity (authed impersonation)", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: null,
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(true);
	});

	it("is read-only under a locked viewer: no release on your own slot", () => {
		const mine = slot({
			status: "claimed",
			assigneeId: "me",
			assigneeName: "Me",
		});
		renderAgenda(
			lockedViewer(
				meetingViewer({
					currentMemberId: "me",
					canManage: false,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
				}),
			),
			[mine],
		);
		// Own filled slot renders read-only — "Filled", no Release button.
		expect(screen.getByText("Filled")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
		expect(screen.queryByText("take over")).toBeNull();
	});

	it("is read-only under a locked viewer: open slots can't be claimed", () => {
		renderAgenda(
			lockedViewer(
				meetingViewer({
					currentMemberId: "me",
					canManage: false,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
				}),
			),
			[slot({ status: "open" })],
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(true);
	});

	it("grants the TMOD assign + speaker management on the public surface", () => {
		const openSpeaker = slot({
			id: "sp1",
			roleName: "Speaker",
			category: "speaker",
			isSpeakerRole: true,
			status: "open",
		});
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[openSpeaker],
		);
		expect(screen.getByRole("button", { name: /Assign/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "+ Add speaker" })).toBeTruthy();
	});

	it("shows the WOD editor to a pure grammarian, hides it from a plain member", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: true,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		expect(
			screen.getByRole("button", { name: /edit word of the day/i }),
		).toBeTruthy();
		cleanup();
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		expect(
			screen.queryByRole("button", { name: /edit word of the day/i }),
		).toBeNull();
	});

	it("shows 'Edit meeting' to a TMOD and an admin, hides it from a plain member", () => {
		for (const v of [
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: true,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
		]) {
			renderAgenda(v, [slot({ status: "open" })]);
			expect(
				screen.getByRole("button", { name: /edit meeting/i }),
			).toBeTruthy();
			cleanup();
		}
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		expect(screen.queryByRole("button", { name: /edit meeting/i })).toBeNull();
	});
});

describe("MeetingAgenda remove-role control (#225)", () => {
	afterEach(() => cleanup());
	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});

	it("keeps the enabled trash on an open, unassigned, non-paired slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		const trash = screen.getByRole("button", {
			name: "Remove Timer",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(false);
	});

	it("shows a disabled trash with 'Unassign first' on an assigned slot", () => {
		renderAgenda(manager(), [
			slot({ status: "claimed", assigneeId: "other", assigneeName: "Other" }),
		]);
		const trash = screen.getByRole("button", {
			name: "Remove Timer — unavailable: Unassign first",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(true);
		// Pointer users get the same reason as a tooltip.
		expect(trash.title).toBe("Unassign first");
	});

	it("shows a disabled trash with the pairing reason on a paired evaluator slot", () => {
		renderAgenda(
			manager(),
			[
				slot({
					id: "ev1",
					roleName: "Evaluator",
					roleDefinitionId: "rdE",
					category: "evaluator",
					status: "open",
				}),
			],
			new Set(["rdE"]),
		);
		const trash = screen.getByRole("button", {
			name: "Remove Evaluator — unavailable: Remove the paired speaker role instead",
		}) as HTMLButtonElement;
		expect(trash.disabled).toBe(true);
		expect(trash.title).toBe("Remove the paired speaker role instead");
	});

	it("omits the trash on speaker cards — '− Remove speaker' is the affordance", () => {
		renderAgenda(
			manager(),
			[
				slot({
					id: "sp1",
					roleName: "Speaker",
					roleDefinitionId: "rdS",
					category: "speaker",
					isSpeakerRole: true,
					status: "open",
				}),
			],
			new Set(["rdS"]),
		);
		expect(
			screen.queryByRole("button", { name: /^Remove Speaker/ }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "− Remove speaker" }),
		).toBeTruthy();
	});

	it("renders no trash at all for a non-manager", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
		);
		expect(screen.queryByRole("button", { name: /^Remove Timer/ })).toBeNull();
	});
});

describe("tap-to-nudge confirm gate (#37)", () => {
	afterEach(() => cleanup());
	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});
	const member = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: false,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});
	const filled = () =>
		slot({
			status: "claimed",
			assigneeId: "other",
			assigneeName: "Other Person",
		});

	it("renders the confirm nudge for a manager on a filled slot", () => {
		renderAgenda(manager(), [filled()]);
		// The factory leaves holderPhone/holderEmail unset, so NudgeButtons
		// renders its no-contact fallback — proof the component rendered at all
		// under a manager viewer on a filled slot.
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
	});

	it("does not render the confirm nudge for a manager on an open slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
		expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
	});

	it("does not render the confirm nudge for a non-manager on a filled slot", () => {
		renderAgenda(member(), [filled()]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
		expect(screen.queryByRole("link", { name: /email/i })).toBeNull();
	});

	it("renders a real Email nudge link when the holder has contact info", () => {
		renderAgenda(manager(), [
			slot({
				status: "claimed",
				assigneeId: "other",
				assigneeName: "Other Person",
				holderEmail: "other@example.com",
			}),
		]);
		expect(screen.queryByText(/no contact on file/i)).toBeNull();
		const emailLink = screen.getByRole("link", {
			name: /email/i,
		}) as HTMLAnchorElement;
		expect(emailLink.href.startsWith("mailto:other@example.com")).toBe(true);
	});

	it("passes the holder's goes-by name into the nudge draft", () => {
		// Guards the agenda→NudgeButtons wiring (#486): without this, dropping
		// `preferredName={slot.holderPreferredName}` leaves every other test green.
		renderAgenda(manager(), [
			slot({
				status: "claimed",
				assigneeId: "other",
				assigneeName: "Abdul-Rasheed Bustamam",
				holderPreferredName: "Rasheed",
				holderEmail: "r@example.com",
			}),
		]);
		const emailLink = screen.getByRole("link", {
			name: /email/i,
		}) as HTMLAnchorElement;
		const body = decodeURIComponent(emailLink.href.split("&body=")[1] ?? "");
		expect(body).toContain("Hi Rasheed,");
		expect(body).not.toContain("Abdul-Rasheed");
	});

	it("renders the recruit picker for a manager on an open slot", () => {
		renderAgenda(manager(), [slot({ status: "open" })]);
		expect(screen.getByRole("button", { name: /nudge someone/i })).toBeTruthy();
	});

	it("does not render the recruit picker on a filled slot", () => {
		renderAgenda(manager(), [filled()]);
		expect(screen.queryByRole("button", { name: /nudge someone/i })).toBeNull();
	});

	it("does not render the recruit picker for a non-manager", () => {
		renderAgenda(member(), [slot({ status: "open" })]);
		expect(screen.queryByRole("button", { name: /nudge someone/i })).toBeNull();
	});
});

describe("planning panels hide once the meeting is over (#376)", () => {
	afterEach(() => cleanup());

	// Production-faithful: both meeting surfaces build their viewer through
	// `resolveMeetingViewer`, so the test exercises the real canManage outcome
	// for each lifecycle state rather than hand-rolling one.
	const adminViewer = (meeting: MeetingAgendaProps["meeting"]) =>
		resolveMeetingViewer({
			status: meeting.status,
			scheduledAt: meeting.scheduledAt,
			timezone: "UTC",
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isSignedIn: true,
		});

	const withRoster = (meeting: MeetingAgendaProps["meeting"]) => ({
		meeting,
		roster: [
			{ id: "r1", name: "Rita Roster" },
			{ id: "r2", name: "Otto Out" },
		],
		unavailableMemberIds: ["r2"],
		unavailableMembers: [{ id: "r2", name: "Otto Out" }],
	});

	it("shows Outreach and 'Not available this week' on an upcoming meeting", () => {
		const meeting = meetingFixture({ scheduledAt: daysFromNow(7) });
		renderAgenda(
			adminViewer(meeting),
			[slot({ status: "open" })],
			undefined,
			undefined,
			withRoster(meeting),
		);
		expect(screen.getByText("Outreach")).toBeTruthy();
		expect(screen.getByText("Not available this week")).toBeTruthy();
	});

	it("hides both on a PAST but never-completed meeting (canManage is still true)", () => {
		const meeting = meetingFixture({
			scheduledAt: daysFromNow(-7),
			status: "scheduled",
		});
		const viewer = adminViewer(meeting);
		// The case that bit us: an admin keeps full management on a past-but-open
		// meeting, so `lockedViewer` never strips the panel — the date must.
		expect(viewer.canManage).toBe(true);
		renderAgenda(viewer, [slot({ status: "open" })], undefined, undefined, {
			...withRoster(meeting),
		});
		expect(screen.queryByText("Outreach")).toBeNull();
		expect(screen.queryByText("Not available this week")).toBeNull();
	});

	it("hides both on a COMPLETED meeting", () => {
		const meeting = meetingFixture({
			scheduledAt: daysFromNow(-7),
			status: "completed",
		});
		const viewer = adminViewer(meeting);
		// Completed already strips management (`lockedViewer`) — belt to the
		// date's braces.
		expect(viewer.canManage).toBe(false);
		renderAgenda(viewer, [slot({ status: "open" })], undefined, undefined, {
			...withRoster(meeting),
		});
		expect(screen.queryByText("Outreach")).toBeNull();
		expect(screen.queryByText("Not available this week")).toBeNull();
	});

	it("hides both when completed EARLY, before the meeting date", () => {
		// Isolates the lock branch from the date branch: a future meeting marked
		// completed must hide them on `status` alone.
		const meeting = meetingFixture({
			scheduledAt: daysFromNow(7),
			status: "completed",
		});
		renderAgenda(
			// Forced canManage so the assertion can only be satisfied by the new
			// lifecycle gate, not by `lockedViewer` zeroing the capability.
			meetingViewer({
				currentMemberId: "me",
				canManage: true,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
			undefined,
			undefined,
			withRoster(meeting),
		);
		expect(screen.queryByText("Outreach")).toBeNull();
		expect(screen.queryByText("Not available this week")).toBeNull();
	});
});

describe("viewer and panels agree on one injected clock (#393)", () => {
	afterEach(() => cleanup());

	// The regression the shared `isMeetingOver` exists to prevent: before it, the
	// viewer took an injectable `now` and the component read the wall clock, so a
	// pinned clock moved one and not the other. Both sides here are fed the SAME
	// `now`, which is only possible because they call the same function.
	const TZ = "America/Los_Angeles";
	// 6pm Pacific on 2026-07-10.
	const SCHEDULED = "2026-07-11T01:00:00Z";

	function renderAtClock(now: Date) {
		const meeting = meetingFixture({
			scheduledAt: SCHEDULED,
			status: "scheduled",
		});
		const viewer = resolveMeetingViewer({
			status: meeting.status,
			scheduledAt: meeting.scheduledAt,
			timezone: TZ,
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isSignedIn: true,
			now,
		});
		renderAgenda(viewer, [slot({ status: "open" })], undefined, undefined, {
			meeting,
			timezone: TZ,
			meetingOver: isMeetingOver({
				status: meeting.status,
				scheduledAt: meeting.scheduledAt,
				timezone: TZ,
				now,
			}),
			roster: [
				{ id: "r1", name: "Rita Roster" },
				{ id: "r2", name: "Otto Out" },
			],
			unavailableMemberIds: ["r2"],
			unavailableMembers: [{ id: "r2", name: "Otto Out" }],
		});
		return viewer;
	}

	it("shows the panels at a clock pinned before the meeting day", () => {
		const viewer = renderAtClock(new Date("2026-07-09T12:00:00Z"));
		expect(viewer.canManage).toBe(true);
		expect(screen.getByText("Outreach")).toBeTruthy();
		expect(screen.getByText("Not available this week")).toBeTruthy();
	});

	it("still shows them late on the meeting's own club-local day", () => {
		// 9pm Pacific, three hours after the meeting started: the instant has
		// passed but the club-local DAY has not, so nothing is over yet.
		const viewer = renderAtClock(new Date("2026-07-11T04:00:00Z"));
		expect(viewer.canManage).toBe(true);
		expect(screen.getByText("Outreach")).toBeTruthy();
		expect(screen.getByText("Not available this week")).toBeTruthy();
	});

	it("hides them once the pinned clock reaches the next club-local day", () => {
		// 12:30am Pacific on 2026-07-11 — the same UTC day as the assertion
		// above, which is exactly why the club timezone has to be the one
		// consulted.
		const viewer = renderAtClock(new Date("2026-07-11T07:30:00Z"));
		// An admin keeps management on a past-but-never-completed meeting, so only
		// the shared date rule can have hidden the panels.
		expect(viewer.canManage).toBe(true);
		expect(screen.queryByText("Outreach")).toBeNull();
		expect(screen.queryByText("Not available this week")).toBeNull();
	});
});
