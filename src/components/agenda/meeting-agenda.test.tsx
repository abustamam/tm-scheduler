// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingAttendancePanel } from "#/components/club/meeting-attendance-panel";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { buildPanelRoleMap, type PlanStatus } from "#/lib/attendance-panel";
import { lockedViewer } from "#/lib/meeting-lifecycle";
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
	const meeting = extra?.meeting ?? meetingFixture();
	const timezone = extra?.timezone ?? "UTC";
	// Mirrors the route's own lift (#396 PR 2): derived from the same slots the
	// test renders, so a fixture's assignee actually shows up under a role.
	const roleCounts = buildRoleCounts(slots);
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}
	return render(
		<MeetingAgenda
			slots={slots}
			viewer={viewer}
			actions={actions}
			roster={[]}
			roleRecency={{}}
			roleByMemberId={roleByMemberId}
			unavailableMemberIds={[]}
			pairedRoleIds={pairedRoleIds}
			shareUrl="https://gavelup.app/club/test/meeting/m1"
			meetingDate="Jan 1, 2026"
			meeting={meeting}
			templateKey={extra?.templateKey ?? null}
			timezone={timezone}
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

describe("MeetingAgenda evaluator reorder arrows", () => {
	afterEach(() => cleanup());
	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});
	const evaluatorSlots = () => [
		slot({
			id: "ev1",
			roleName: "Evaluator",
			roleDefinitionId: "rdE",
			category: "evaluator",
			slotIndex: 0,
			status: "open",
		}),
		slot({
			id: "ev2",
			roleName: "Evaluator",
			roleDefinitionId: "rdE",
			category: "evaluator",
			slotIndex: 1,
			status: "open",
		}),
	];
	const paired = () => new Set(["rdS", "rdE"]);

	it("renders ↑↓ on paired evaluator cards for a manager, ends disabled", () => {
		renderAgenda(manager(), evaluatorSlots(), paired());
		const ups = screen.getAllByRole("button", {
			name: /Move Evaluator .* up/,
		}) as HTMLButtonElement[];
		const downs = screen.getAllByRole("button", {
			name: /Move Evaluator .* down/,
		}) as HTMLButtonElement[];
		expect(ups).toHaveLength(2);
		expect(downs).toHaveLength(2);
		// First card can't move up; last can't move down.
		expect(ups[0].disabled).toBe(true);
		expect(ups[1].disabled).toBe(false);
		expect(downs[0].disabled).toBe(false);
		expect(downs[1].disabled).toBe(true);
	});

	/**
	 * The accessible name must identify the ROW, not just the lineup: two cards
	 * render identical-looking arrows, and a screen-reader user browsing by
	 * control hears only the label. A regression to a bare "Move evaluator up"
	 * fails here (both names would collide) while every other test in this
	 * describe keeps passing.
	 */
	it("gives each evaluator card's arrows a row-identifying name", () => {
		renderAgenda(manager(), evaluatorSlots(), paired());
		expect(
			screen.getByRole("button", { name: "Move Evaluator 1 up" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Move Evaluator 2 up" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Move Evaluator 1 down" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Move Evaluator 2 down" }),
		).toBeTruthy();
	});

	it("names the SPEAKER arrows by row too", () => {
		const speakers = [
			slot({
				id: "sp1",
				roleName: "Speaker",
				roleDefinitionId: "rdS",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 0,
			}),
			slot({
				id: "sp2",
				roleName: "Speaker",
				roleDefinitionId: "rdS",
				category: "speaker",
				isSpeakerRole: true,
				slotIndex: 1,
			}),
		];
		renderAgenda(manager(), speakers, paired());
		expect(
			screen.getByRole("button", { name: "Move Speaker 1 up" }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Move Speaker 2 down" }),
		).toBeTruthy();
	});

	it("clicking ↑ calls moveEvaluator with the slot and direction", async () => {
		const moveEvaluator = vi.fn(
			async (_slot: AgendaSlot, _direction: "up" | "down") => {},
		);
		renderAgenda(manager(), evaluatorSlots(), paired(), undefined, {
			actions: { ...actions, moveEvaluator },
		});
		const ups = screen.getAllByRole("button", { name: /Move Evaluator .* up/ });
		await userEvent.click(ups[1]);
		expect(moveEvaluator).toHaveBeenCalledTimes(1);
		expect(moveEvaluator.mock.calls[0][0]).toMatchObject({ id: "ev2" });
		expect(moveEvaluator.mock.calls[0][1]).toBe("up");
	});

	/** The ↓ button is a near-copy of the ↑ one; without this a transposed
	 *  direction argument passes every other assertion in this describe. */
	it("clicking ↓ calls moveEvaluator with direction down", async () => {
		const moveEvaluator = vi.fn(
			async (_slot: AgendaSlot, _direction: "up" | "down") => {},
		);
		renderAgenda(manager(), evaluatorSlots(), paired(), undefined, {
			actions: { ...actions, moveEvaluator },
		});
		const downs = screen.getAllByRole("button", {
			name: /Move Evaluator .* down/,
		});
		await userEvent.click(downs[0]);
		expect(moveEvaluator).toHaveBeenCalledTimes(1);
		expect(moveEvaluator.mock.calls[0][0]).toMatchObject({ id: "ev1" });
		expect(moveEvaluator.mock.calls[0][1]).toBe("down");
	});

	it("renders no evaluator arrows for a non-manager", () => {
		renderAgenda(
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			evaluatorSlots(),
			paired(),
		);
		expect(
			screen.queryByRole("button", { name: /Move Evaluator .* up/ }),
		).toBeNull();
	});

	it("renders no arrows on a non-paired evaluator role (General Evaluator)", () => {
		renderAgenda(
			manager(),
			[
				slot({
					id: "ge1",
					roleName: "General Evaluator",
					roleDefinitionId: "rdGE",
					category: "evaluator",
					status: "open",
				}),
			],
			paired(),
		);
		expect(
			screen.queryByRole("button", { name: /Move Evaluator .* up/ }),
		).toBeNull();
	});
});

/**
 * #662 — the agenda's confirm nudge records outreach.
 *
 * What the bug actually was: an officer chased the person who already HOLDS a
 * role, from the slot card they were looking at, and the attendance rail beside
 * it still read "Ask". The identical `mode="confirm"` draft in the rail recorded
 * it, so whether an ask counted depended on which of two surfaces they used.
 *
 * So the assertion is that LABEL, not the callback. A spy-only test
 * (`expect(onContacted).toHaveBeenCalledWith("m1", "nudge")`) is green for a
 * wiring that reaches a seam writing nothing, and it is the recorded trap for
 * this shape — CODING_STANDARDS.md, "Test coverage": a component tested through
 * its props cannot see a wrong prop, and a handler assertion IS the prop.
 *
 * Both surfaces are therefore mounted over ONE plan array, wired the way
 * `club.$clubId.meeting.$meetingId.tsx` wires them: `contactedMemberIds` is
 * derived from the plan by that route's own filter, the rail's role map comes
 * from the real `buildPanelRoleMap`, and `recordOutreach` stands in for
 * `setContacted` + `router.invalidate()`. The stand-in keeps that server fn's
 * `demoteFrom: ["reached_out"]` floor so the harness cannot claim a write
 * production would refuse; the floor itself belongs to the server and is
 * asserted in `outreach.integration.test.ts`.
 */
describe("MeetingAgenda confirm nudge records outreach (#662)", () => {
	afterEach(() => cleanup());

	const HOLDER = {
		id: "m-holder",
		name: "Priya Raman",
		preferredName: null,
		phone: "+15551230000",
		email: "priya@club.example",
	};
	const GUEST_SLOT_ID = "g-visitor";

	const manager = () =>
		meetingViewer({
			currentMemberId: "me",
			canManage: true,
			isTmod: false,
			isGrammarian: false,
			isEditableWindow: true,
		});

	/** One filled leadership slot. `status: "claimed"`, deliberately NOT
	 *  "confirmed": a confirmed slot makes the rail INFER "Coming · assumed" for
	 *  its holder, and that row never reads "Ask" whether outreach was recorded or
	 *  not — the fixture would then pass with the fix reverted. */
	function heldSlot(over: Partial<AgendaSlot> = {}): AgendaSlot[] {
		return [
			slot({
				id: "s-tmod",
				roleName: "Toastmaster",
				roleDefinitionId: "rd-tmod",
				category: "leadership",
				status: "claimed",
				assigneeId: HOLDER.id,
				assigneeName: HOLDER.name,
				assigneeIsGuest: false,
				assigneeGuestId: null,
				holderPhone: HOLDER.phone,
				holderEmail: HOLDER.email,
				holderPreferredName: HOLDER.preferredName,
				...over,
			}),
		];
	}

	/** The same slot held by a GUEST: `assigneeName` is populated exactly as it is
	 *  for a member — which is why `assigneeName` cannot be the gate — while
	 *  `assigneeId` is null and the id lives on `assigneeGuestId` instead. */
	const guestHeldSlot = () =>
		heldSlot({
			assigneeId: null,
			assigneeGuestId: GUEST_SLOT_ID,
			assigneeName: "Visiting Vera",
			assigneeIsGuest: true,
		});

	function Surfaces({ slots }: { slots: AgendaSlot[] }) {
		const [plan, setPlan] = useState<
			{ memberId: string; status: PlanStatus }[]
		>([]);
		// `setContacted` + `router.invalidate()`, compressed. Floor-only: a row that
		// already carries a rung is left alone, so this can never report a write the
		// server would have refused.
		const recordOutreach = (memberId: string) =>
			setPlan((rows) =>
				rows.some((r) => r.memberId === memberId)
					? rows
					: [...rows, { memberId, status: "reached_out" }],
			);
		// The route's own derivation, verbatim.
		const contactedMemberIds = plan
			.filter((p) => p.status === "reached_out")
			.map((p) => p.memberId);
		const roleCounts = buildRoleCounts(slots);
		const roleByMemberId: Record<string, string> = {};
		for (const s of slots) {
			if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
		}
		return (
			<>
				<div data-testid="agenda">
					<MeetingAgenda
						slots={slots}
						viewer={manager()}
						actions={actions}
						roster={[HOLDER]}
						roleRecency={{}}
						roleByMemberId={roleByMemberId}
						unavailableMemberIds={[]}
						shareUrl="https://gavelup.app/club/test/meeting/m1"
						meetingDate="Jan 1, 2026"
						meeting={meetingFixture()}
						templateKey={null}
						timezone="UTC"
						selfMemberId="me"
						onMetaSaved={() => {}}
						contactedMemberIds={contactedMemberIds}
						onContacted={(memberId) => recordOutreach(memberId)}
					/>
				</div>
				<div data-testid="rail">
					<MeetingAttendancePanel
						mode="plan"
						roster={[HOLDER]}
						plan={plan}
						rungOverride={{}}
						roleByMemberId={buildPanelRoleMap(slots)}
						meetingDate="Jan 1, 2026"
						shareUrl="https://gavelup.app/club/test/meeting/m1"
						locked={false}
						onWriteRung={() => {}}
						onContacted={recordOutreach}
					/>
				</div>
				{/* The SHARED state both surfaces are driven by, rendered so the
				    guest case below can assert that no write was attempted at all —
				    a guest has no rail row of their own to read it off. */}
				<output data-testid="plan">{JSON.stringify(plan)}</output>
			</>
		);
	}

	const agenda = () => within(screen.getByTestId("agenda"));
	const rail = () => within(screen.getByTestId("rail"));
	const planState = () => screen.getByTestId("plan").textContent;

	// BOTH channels, because `NudgeButtons` wires `onClick={onContacted}` on each
	// anchor separately — covering one leaves the other severable in silence. The
	// rail renders the same two links `iconOnly`, so their accessible names are
	// the long "Message … on WhatsApp, opens in a new tab" form and cannot collide
	// with these exact-string queries; the `within(agenda())` scope is belt and
	// braces on top of that.
	it.each([
		"WhatsApp",
		"Email",
	])('the %s draft takes the role holder off "Ask"', async (channel) => {
		render(<Surfaces slots={heldSlot()} />);

		// The bug, before the click: the holder of a role, unasked.
		expect(
			rail().getByRole("button", { name: "Priya Raman status: Ask" }),
		).toBeTruthy();

		await userEvent.click(agenda().getByRole("link", { name: channel }));

		// The fix, stated as the user sees it.
		expect(
			rail().getByRole("button", { name: "Priya Raman status: Asked" }),
		).toBeTruthy();
		expect(
			rail().queryByRole("button", { name: "Priya Raman status: Ask" }),
		).toBeNull();
		// And the rung that produced it, so a label that changed for some other
		// reason cannot stand in for the write.
		expect(planState()).toBe(
			JSON.stringify([{ memberId: HOLDER.id, status: "reached_out" }]),
		);
	});

	it("writes nothing for a GUEST-held slot, and keeps the drafts", async () => {
		render(<Surfaces slots={guestHeldSlot()} />);

		// The affordance is unchanged — an absent `onContacted` must not take the
		// draft links with it.
		const link = agenda().getByRole("link", { name: "WhatsApp" });
		expect(link.getAttribute("href")).toContain("15551230000");

		await userEvent.click(link);

		// A guest has no `members` row, so the plan write has no foreign key to land
		// on. Nothing is attempted. Asserted on the shared state rather than on a
		// spy: the failure this prevents is a throw at the seam, and the seam is
		// only reached if something was written.
		expect(planState()).toBe("[]");
	});
});
