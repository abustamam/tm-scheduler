// @vitest-environment jsdom

// The cover link's landing card and the three slot chips (#1440).

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverChip } from "#/components/club/cover-chip";
import {
	CoverLandingCard,
	resolveCoverLanding,
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
			container.querySelector('[data-cover-chip="finding_cover"]')?.className,
		).toContain("border-dashed");
	});

	it("dropped: names who dropped it and when, in the club's zone", () => {
		render(<CoverChip {...props} request={request} status="dropped" />);
		expect(screen.getByText(/Open: Sam dropped it Wed 2:14am/)).toBeTruthy();
	});

	const covered: MeetingCoverRequest = {
		...request,
		kind: "finding_cover" as MeetingCoverRequest["kind"],
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
