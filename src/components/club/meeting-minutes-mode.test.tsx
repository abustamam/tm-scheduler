// @vitest-environment jsdom

/**
 * The Minutes card's read-only attendance record shows in person / online
 * (#1049) only where it was recorded.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinutesResult } from "#/server/minutes";
import { MeetingMinutes } from "./meeting-minutes";

// The component imports the minutes server-fn module, which reaches `#/db`.
vi.mock("#/db", () => ({ db: {} }));

type MinutesData = NonNullable<MinutesResult["data"]>;

function minutes(
	members: MinutesData["members"],
	guests: MinutesData["guests"],
): MinutesData {
	const present = members.filter((m) => m.status === "present").length;
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "m1",
		clubId: "c1",
		members,
		guests,
		tableTopicsSpeakers: [],
		awards: [],
		awardEligible: {
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: {
			present,
			absent: members.filter((m) => m.status === "absent").length,
			excused: 0,
			unmarked: 0,
			guests: guests.length,
		},
	};
}

function renderRecord(data: MinutesData) {
	return render(
		<MeetingMinutes
			meetingId="m1"
			minutes={data}
			program={[]}
			meetingPast={true}
			meetingDayReached={true}
			canEdit={false}
			clubGuests={[]}
			onMutated={() => {}}
		/>,
	);
}

describe("MeetingMinutes attendance record — mode (#1049)", () => {
	afterEach(() => cleanup());

	it("shows the split and each recorded mode for a mixed meeting", () => {
		renderRecord(
			minutes(
				[
					{
						memberId: "a",
						name: "Ana",
						status: "present",
						mode: "online",
						hasRole: false,
					},
					// Present, no mode recorded.
					{ memberId: "b", name: "Ben", status: "present", hasRole: false },
					{ memberId: "c", name: "Cam", status: "absent", hasRole: false },
				],
				[
					{ guestId: "g1", name: "Gia", fromRole: false, mode: "in_person" },
					{ guestId: "g2", name: "Hal", fromRole: true },
				],
			),
		);
		screen.getByText("1 + 1 online, 2 not recorded");
		screen.getByText("Present · Online");
		// Ben's badge names no mode — nothing was recorded, nothing is guessed.
		expect(screen.getAllByText("Present")).toHaveLength(1);
		screen.getByText("Gia · In person");
		screen.getByText("Hal");
	});

	it("shows no split and no mode on a meeting with none recorded", () => {
		const { container } = renderRecord(
			minutes(
				[{ memberId: "a", name: "Ana", status: "present", hasRole: false }],
				[{ guestId: "g1", name: "Gia", fromRole: false }],
			),
		);
		expect(container.textContent).not.toMatch(/online|in person|not recorded/i);
		screen.getByText("1 present");
	});
});
