// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MinutesResult } from "#/server/minutes";
import type { MinutesProgramRow } from "#/server/minutes-logic";
import { MeetingMinutes } from "./meeting-minutes";

// The component imports the minutes server-fn module, which pulls in `#/db`
// transitively. Those handlers never run in this render-only test, so stub the
// db client to avoid the eager "DATABASE_URL is not set" throw at import time.
vi.mock("#/db", () => ({ db: {} }));

type MinutesData = NonNullable<MinutesResult["data"]>;

const emptyMinutes: MinutesData = {
	meetingId: "m1",
	clubId: "c1",
	members: [],
	guests: [],
	tableTopicsSpeakers: [],
	awards: [],
	awardEligible: {
		best_speaker: { memberIds: [], guestIds: [] },
		best_evaluator: { memberIds: [], guestIds: [] },
		best_table_topics: { memberIds: [], guestIds: [] },
	},
	counts: { present: 0, absent: 0, excused: 0, unmarked: 0, guests: 0 },
};

function programRow(over: Partial<MinutesProgramRow>): MinutesProgramRow {
	return {
		slotId: "s1",
		roleName: "Timer",
		category: "functionary",
		assigneeName: null,
		isGuest: false,
		speechTitle: null,
		...over,
	};
}

function renderMinutes(program: MinutesProgramRow[], meetingPast: boolean) {
	return render(
		<MeetingMinutes
			meetingId="m1"
			minutes={emptyMinutes}
			program={program}
			meetingPast={meetingPast}
			canEdit={false}
			clubGuests={[]}
			onMutated={() => {}}
		/>,
	);
}

describe("MeetingMinutes Program render condition (#225)", () => {
	afterEach(() => cleanup());

	it("hides the Program block on a future meeting with zero assignees", () => {
		renderMinutes(
			[
				programRow({ slotId: "s1", roleName: "Timer" }),
				programRow({ slotId: "s2", roleName: "Grammarian" }),
			],
			false,
		);
		expect(screen.queryByText("Program")).toBeNull();
	});

	it("shows the Program block once at least one role is assigned", () => {
		renderMinutes(
			[
				programRow({ slotId: "s1", roleName: "Timer", assigneeName: "Ana" }),
				programRow({ slotId: "s2", roleName: "Grammarian" }),
			],
			false,
		);
		expect(screen.getByText("Program")).toBeTruthy();
		expect(screen.getByText(/Ana/)).toBeTruthy();
		// Unassigned rows still show their placeholder inside a visible block.
		expect(screen.getByText("Grammarian:")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("shows the Program block on a past/completed meeting even with zero assignees", () => {
		renderMinutes([programRow({ slotId: "s1", roleName: "Timer" })], true);
		expect(screen.getByText("Program")).toBeTruthy();
	});

	it("renders no Program block when the meeting has no program rows at all", () => {
		renderMinutes([], true);
		expect(screen.queryByText("Program")).toBeNull();
	});
});
