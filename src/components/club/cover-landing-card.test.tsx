// @vitest-environment jsdom

// The cover link's landing card and the three slot chips (#1440).

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CoverChip,
	coverChipsFor,
	coverMeetingOver,
	hidesCoveredStory,
} from "#/components/club/cover-chip";
import {
	CoverLandingCard,
	coverLandingView,
	coverRoleOneLiner,
	resolveCoverLanding,
	takeCoveredSlot,
} from "#/components/club/cover-landing-card";
import type { MeetingCoverRequest } from "#/server/cover-logic";

afterEach(cleanup);

const SLOT = "11111111-1111-4111-8111-111111111111";
const open = {
	id: SLOT,
	assigneeId: null,
	assigneeGuestId: null,
	assigneeName: null,
};
const request: MeetingCoverRequest = {
	slotId: SLOT,
	kind: "dropped",
	releasedName: "Sam",
	releasedAt: new Date("2026-11-04T02:14:00Z"),
	coveredName: null,
	coveredAt: null,
};

describe("resolveCoverLanding", () => {
	const base = { slots: [open], coverRequests: [request], meetingOver: false };

	it("an open slot with an open request is the card", () => {
		expect(resolveCoverLanding({ ...base, cover: SLOT })).toMatchObject({
			kind: "open",
			slotId: SLOT,
		});
	});

	it("a filled slot is the thanks line, naming who took it", () => {
		const slots = [{ ...open, assigneeId: "m", assigneeName: "Priya" }];
		expect(resolveCoverLanding({ ...base, slots, cover: SLOT })).toEqual({
			kind: "filled",
			holderName: "Priya",
		});
	});

	it("a stale link never errors: unknown id, wrong type, no request, over", () => {
		expect(resolveCoverLanding({ ...base, cover: "nope" })).toBeNull();
		expect(resolveCoverLanding({ ...base, cover: 42 })).toBeNull();
		expect(resolveCoverLanding({ ...base, cover: undefined })).toBeNull();
		expect(
			resolveCoverLanding({ ...base, coverRequests: [], cover: SLOT }),
		).toBeNull();
		expect(
			resolveCoverLanding({ ...base, meetingOver: true, cover: SLOT }),
		).toBeNull();
	});
});

describe("CoverLandingCard", () => {
	const landing = { kind: "open" as const, slotId: SLOT, request };

	it("names the asker, role, when and one-liner; both buttons fire", async () => {
		const onTake = vi.fn();
		const onDecline = vi.fn();
		render(
			<CoverLandingCard
				landing={landing}
				roleLabel="Timer"
				whenLine="Wednesday · Meeting 12 · 7:00 PM"
				description="Keeps time."
				onTake={onTake}
				onDecline={onDecline}
			/>,
		);
		expect(screen.getByText("Sam asked if you can cover")).toBeTruthy();
		expect(screen.getByText("Timer")).toBeTruthy();
		expect(screen.getByText("Wednesday · Meeting 12 · 7:00 PM")).toBeTruthy();
		expect(screen.getByText("Keeps time.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "I'll take it" }));
		await userEvent.click(screen.getByRole("button", { name: "Can't, sorry" }));
		expect(onTake).toHaveBeenCalledTimes(1);
		expect(onDecline).toHaveBeenCalledTimes(1);
	});

	it("the role name is body font, not display (DESIGN.md: one display line, the meeting h1)", () => {
		render(
			<CoverLandingCard
				landing={landing}
				roleLabel="Timer"
				whenLine=""
				description={null}
				onTake={vi.fn()}
				onDecline={vi.fn()}
			/>,
		);
		const role = screen.getByText("Timer");
		expect(role.className).not.toContain("font-display");
		expect(role.className).toContain("text-2xl");
	});

	it("a filled slot says thanks and offers no buttons", () => {
		render(
			<CoverLandingCard
				landing={{ kind: "filled", holderName: "Priya" }}
				roleLabel=""
				whenLine=""
				description={null}
				onTake={vi.fn()}
				onDecline={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Thanks! Priya already took it\./)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("CoverChip", () => {
	const props = { roleLabel: "Timer", timeZone: "UTC", meetingOver: false };

	it("finding_cover: dashed amber chip", () => {
		const { container } = render(
			<CoverChip {...props} request={request} status="finding_cover" />,
		);
		expect(screen.getByText("Sam is finding cover")).toBeTruthy();
		expect(
			screen.getByLabelText("Timer: Sam is finding cover").textContent,
		).toBe("Sam is finding cover");
		expect(
			container.querySelector('[data-cover-chip="finding_cover"]')?.className,
		).toContain("border-dashed");
	});

	it("dropped: names who dropped it and when, in the club's zone", () => {
		render(<CoverChip {...props} request={request} status="dropped" />);
		expect(screen.getByText(/^Sam dropped it Wed 2:14am/)).toBeTruthy();
		expect(
			screen.getByLabelText(/^Timer open: Sam dropped it Wed 2:14am/),
		).toBeTruthy();
	});

	const covered: MeetingCoverRequest = {
		...request,
		kind: "finding_cover",
		coveredName: "Priya",
		coveredAt: new Date("2026-11-04T02:31:00Z"),
	};

	it("covered: the story line while the meeting is ahead", () => {
		render(<CoverChip {...props} request={covered} status="covered" />);
		expect(
			screen.getByText("Timer: Sam → Priya · covered in 17 min"),
		).toBeTruthy();
	});

	it("covered: hidden once the meeting is past", () => {
		const { container } = render(
			<CoverChip {...props} meetingOver request={covered} status="covered" />,
		);
		expect(container.textContent).toBe("");
	});
});

describe("dropped chip is the read-only treatment", () => {
	it("has no actionable amber fill", () => {
		const { container } = render(
			<CoverChip
				roleLabel="Timer"
				timeZone="UTC"
				meetingOver={false}
				request={request}
				status="dropped"
			/>,
		);
		const cls =
			container.querySelector('[data-cover-chip="dropped"]')?.className ?? "";
		expect(cls).toContain("border-dashed");
		expect(cls).not.toMatch(/bg-warning/);
	});
});

describe("one definition of over", () => {
	it("a cancelled meeting is over, for the card and the chips alike", () => {
		expect(coverMeetingOver({ over: false, status: "cancelled" })).toBe(true);
		expect(coverMeetingOver({ over: true, status: "scheduled" })).toBe(true);
		expect(coverMeetingOver({ over: false, status: "scheduled" })).toBe(false);
		expect(hidesCoveredStory("covered", true)).toBe(true);
		expect(hidesCoveredStory("covered", false)).toBe(false);
		expect(hidesCoveredStory("dropped", true)).toBe(false);
	});
});

describe("coverRoleOneLiner", () => {
	it("prefers the description, falls back to the guide text when blank", () => {
		const def = { name: "Timer", key: "timer", description: "Keeps time." };
		expect(coverRoleOneLiner(def)).toBe("Keeps time.");
		expect(
			coverRoleOneLiner({
				...def,
				description: "  ",
				beforeNotes: "Bring a stopwatch.\n\nMore.",
			}),
		).toBe("Bring a stopwatch.");
		expect(
			coverRoleOneLiner({
				...def,
				description: null,
				duringNotes: "Show cards.",
			}),
		).toBe("Show cards.");
		expect(coverRoleOneLiner({ ...def, description: null })).toBeNull();
		expect(coverRoleOneLiner(null)).toBeNull();
	});
});

describe("the route's computation (coverLandingView / coverChipsFor)", () => {
	const slot = { ...open, roleName: "Timer", slotIndex: 0 };
	const viewArgs = {
		cover: SLOT,
		dismissed: false,
		slots: [slot],
		coverRequests: [request],
		meetingOver: false,
		roleCounts: { Timer: 1 },
		roleDefs: [
			{ name: "Timer", key: "timer", description: "", beforeNotes: "Time it." },
		],
		scheduledAt: new Date("2026-11-04T19:00:00Z"),
		timezone: "UTC",
		meetingNumber: 12,
	};

	it("builds label, when line and the guide fallback", () => {
		const v = coverLandingView(viewArgs);
		expect(v.landing?.kind).toBe("open");
		expect(v.roleLabel).toBe("Timer");
		expect(v.whenLine).toBe("Wednesday · Meeting 12 · 7:00 PM");
		expect(v.description).toBe("Time it.");
	});

	it("a cancelled/over meeting and a dismissed card show no card", () => {
		expect(
			coverLandingView({ ...viewArgs, meetingOver: true }).landing,
		).toBeNull();
		expect(
			coverLandingView({ ...viewArgs, dismissed: true }).landing,
		).toBeNull();
	});

	it("chips: label by slotLabel, covered hidden when over, unknown slot skipped", () => {
		const covered = {
			...request,
			coveredName: "Priya",
			coveredAt: new Date("2026-11-04T02:31:00Z"),
		};
		const args = {
			coverRequests: [covered, { ...request, slotId: "gone" }],
			slots: [slot],
			roleCounts: { Timer: 2 },
			scheduledAt: viewArgs.scheduledAt,
			timezone: "UTC",
			now: new Date("2026-11-04T03:00:00Z"),
			meetingOver: false,
		};
		const chips = coverChipsFor(args);
		expect(chips).toHaveLength(1);
		expect(chips[0]).toMatchObject({ roleLabel: "Timer 1", status: "covered" });
		expect(coverChipsFor({ ...args, meetingOver: true })).toHaveLength(0);
	});
});

describe("takeCoveredSlot", () => {
	function run(over: Partial<Parameters<typeof takeCoveredSlot>[0]> = {}) {
		const calls: string[] = [];
		const args = {
			claim: vi.fn(async () => true),
			refresh: vi.fn(async () => {}),
			onTaken: vi.fn(),
			onError: vi.fn(),
			setBusy: vi.fn((b: boolean) => void calls.push(`busy:${b}`)),
			...over,
		};
		return { args, calls, done: takeCoveredSlot(args) };
	}

	it("claims, says so, refreshes, and clears busy", async () => {
		const r = run();
		await r.done;
		expect(r.args.onTaken).toHaveBeenCalledTimes(1);
		expect(r.args.refresh).toHaveBeenCalledTimes(1);
		expect(r.calls).toEqual(["busy:true", "busy:false"]);
	});

	it("no identity: nothing written, no toast, no refresh", async () => {
		const r = run({ claim: vi.fn(async () => false) });
		await r.done;
		expect(r.args.onTaken).not.toHaveBeenCalled();
		expect(r.args.refresh).not.toHaveBeenCalled();
		expect(r.calls).toEqual(["busy:true", "busy:false"]);
	});

	it("a refused claim reports the error and does not refresh", async () => {
		const boom = new Error("already taken");
		const r = run({
			claim: vi.fn(async () => {
				throw boom;
			}),
		});
		await r.done;
		expect(r.args.onError).toHaveBeenCalledWith(boom);
		expect(r.args.onTaken).not.toHaveBeenCalled();
		expect(r.args.refresh).not.toHaveBeenCalled();
		expect(r.calls).toEqual(["busy:true", "busy:false"]);
	});

	it("a failed refresh after a landed claim is not an error", async () => {
		const r = run({
			refresh: vi.fn(async () => {
				throw new Error("net");
			}),
		});
		await r.done;
		expect(r.args.onTaken).toHaveBeenCalledTimes(1);
		expect(r.args.onError).not.toHaveBeenCalled();
	});
});
