// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackForUser } from "#/server/role-feedback";
import {
	FEEDBACK_DELETE_CONFIRM,
	FEEDBACK_EMPTY_TEXT,
	FeedbackForYou,
	feedbackOrEmpty,
	NO_FEEDBACK,
} from "./feedback-for-you";

const ID = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const FEEDBACK: FeedbackForUser = {
	unseenCount: 2,
	meetings: [
		{
			meetingId: ID(100),
			clubName: "THR Speaking Club",
			// 2026-10-02 16:00Z is already Saturday Oct 3 in Tokyo and still
			// Friday in UTC and in the Americas: the club's zone decides the day,
			// not the runtime's.
			meetingDate: "2026-10-02T16:00:00.000Z",
			timezone: "Asia/Tokyo",
			roles: [
				{
					roleLabel: "Speaker 2",
					notes: [
						{
							id: ID(1),
							wentWell: "Great opener",
							tryNext: "Slow down at the end",
							createdAt: "2026-10-03T00:00:00.000Z",
							seen: false,
						},
						{
							id: ID(2),
							wentWell: null,
							tryNext: "More eye contact",
							createdAt: "2026-10-03T00:00:00.000Z",
							seen: true,
						},
					],
				},
				{
					roleLabel: "Timer",
					notes: [
						{
							id: ID(3),
							wentWell: "Clear signals",
							tryNext: null,
							createdAt: "2026-10-03T00:00:00.000Z",
							seen: false,
						},
					],
				},
			],
		},
		{
			meetingId: ID(200),
			clubName: "Other Club",
			meetingDate: "2026-09-19T17:00:00.000Z",
			timezone: "UTC",
			roles: [
				{
					roleLabel: "Grammarian",
					notes: [
						{
							id: ID(4),
							wentWell: "Nice word",
							tryNext: null,
							createdAt: "2026-09-19T00:00:00.000Z",
							seen: true,
						},
					],
				},
			],
		},
	],
};

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderCard(
	feedback: FeedbackForUser = FEEDBACK,
	onDelete: (id: string) => Promise<unknown> = vi.fn(async () => ({
		deleted: true,
	})),
) {
	const onSeen = vi.fn();
	const onError = vi.fn();
	const utils = render(
		<FeedbackForYou
			feedback={feedback}
			onDelete={onDelete}
			onSeen={onSeen}
			onError={onError}
		/>,
	);
	return { ...utils, onSeen, onError, onDelete };
}

describe("FeedbackForYou (#986)", () => {
	it("groups by meeting (date in the club's zone · club), then role with its count, and shows whichever prompts were written", () => {
		renderCard();
		const groups = screen.getAllByTestId("feedback-meeting");
		expect(groups).toHaveLength(2);
		const [first, second] = groups as [HTMLElement, HTMLElement];
		expect(within(first).getByRole("heading", { level: 3 }).textContent).toBe(
			"Sat, Oct 3 · THR Speaking Club",
		);
		expect(
			within(first)
				.getAllByRole("heading", { level: 4 })
				.map((h) => h.textContent),
		).toEqual(["Speaker 2 · 2 notes", "Timer · 1 note"]);
		expect(within(first).getByText("Great opener")).toBeTruthy();
		expect(within(first).getByText("More eye contact")).toBeTruthy();
		// A note with no "went well" shows no "What went well" line.
		expect(within(first).getAllByText("What went well:")).toHaveLength(2);
		expect(within(second).getByRole("heading", { level: 3 }).textContent).toBe(
			"Sat, Sep 19 · Other Club",
		);
	});

	it("shows the N new badge, and reports the new notes seen once after the first render", () => {
		const { onSeen, rerender } = renderCard();
		expect(screen.getByTestId("feedback-new-badge").textContent).toBe("2 new");
		expect(onSeen).toHaveBeenCalledTimes(1);
		expect(onSeen.mock.calls[0]?.[0]).toEqual([ID(1), ID(3)]);

		// The loader re-runs mid-visit and now reads every note seen: the badge
		// holds for this visit, and nothing is reported again.
		const allSeen: FeedbackForUser = {
			unseenCount: 0,
			meetings: FEEDBACK.meetings.map((m) => ({
				...m,
				roles: m.roles.map((r) => ({
					...r,
					notes: r.notes.map((n) => ({ ...n, seen: true })),
				})),
			})),
		};
		rerender(
			<FeedbackForYou feedback={allSeen} onDelete={vi.fn()} onSeen={onSeen} />,
		);
		expect(screen.getByTestId("feedback-new-badge").textContent).toBe("2 new");
		expect(onSeen).toHaveBeenCalledTimes(1);
	});

	it("has no badge and reports nothing when every note is already seen", () => {
		const seenOnly: FeedbackForUser = {
			unseenCount: 0,
			meetings: [FEEDBACK.meetings[1] as FeedbackForUser["meetings"][number]],
		};
		const { onSeen } = renderCard(seenOnly);
		expect(screen.queryByTestId("feedback-new-badge")).toBeNull();
		expect(onSeen).not.toHaveBeenCalled();
	});

	it("deletes a note only after the confirm, and removes it from the card", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
		const { onDelete } = renderCard();
		const buttons = screen.getAllByRole("button", { name: "Delete this note" });
		expect(buttons).toHaveLength(4);

		// Cancelled: nothing is deleted.
		await user.click(buttons[2] as HTMLElement);
		expect(confirm).toHaveBeenCalledWith(FEEDBACK_DELETE_CONFIRM);
		expect(onDelete).not.toHaveBeenCalled();

		// Confirmed: the Timer's only note goes, and its role heading with it.
		confirm.mockReturnValueOnce(true);
		await user.click(buttons[2] as HTMLElement);
		expect(onDelete).toHaveBeenCalledWith(ID(3));
		expect(screen.queryByText("Clear signals")).toBeNull();
		expect(screen.queryByText("Timer · 1 note")).toBeNull();
		// It was new, so the badge counts one fewer.
		expect(screen.getByTestId("feedback-new-badge").textContent).toBe("1 new");
	});

	it("keeps a note on screen and reports the error when the delete fails", async () => {
		const user = userEvent.setup();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const boom = new Error("nope");
		const { onError } = renderCard(
			FEEDBACK,
			vi.fn(async () => {
				throw boom;
			}),
		);
		await user.click(
			screen.getAllByRole("button", {
				name: "Delete this note",
			})[0] as HTMLElement,
		);
		expect(onError).toHaveBeenCalledWith(boom);
		expect(screen.getByText("Great opener")).toBeTruthy();
	});

	it("shows the empty state, and once every note is deleted", async () => {
		renderCard(NO_FEEDBACK);
		expect(screen.getByText(FEEDBACK_EMPTY_TEXT)).toBeTruthy();
		cleanup();

		const user = userEvent.setup();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const one: FeedbackForUser = {
			unseenCount: 0,
			meetings: [FEEDBACK.meetings[1] as FeedbackForUser["meetings"][number]],
		};
		renderCard(one);
		await user.click(screen.getByRole("button", { name: "Delete this note" }));
		expect(screen.getByText(FEEDBACK_EMPTY_TEXT)).toBeTruthy();
	});
});

describe("the dashboard's feedback read never blanks the page (#986)", () => {
	it("a rejected read becomes the empty card", async () => {
		await expect(
			feedbackOrEmpty(() => Promise.reject(new Error("db down"))),
		).resolves.toEqual(NO_FEEDBACK);
	});

	it("a read that throws synchronously becomes the empty card", async () => {
		await expect(
			feedbackOrEmpty(() => {
				throw new Error("boom");
			}),
		).resolves.toEqual(NO_FEEDBACK);
	});

	it("a successful read passes through untouched", async () => {
		await expect(feedbackOrEmpty(async () => FEEDBACK)).resolves.toBe(FEEDBACK);
	});

	it("the dashboard loader reads through it, and renders the card", () => {
		// The route module reaches `#/db` and cannot be rendered in vitest, so
		// its wiring is held by source (comments stripped, so a comment cannot
		// satisfy it).
		const src = readFileSync(
			resolve(__dirname, "../../routes/_authed/dashboard.tsx"),
			"utf8",
		).replace(/\/\/.*$|\{?\/\*[\s\S]*?\*\/\}?/gm, "");
		expect(src).toContain("feedbackOrEmpty(() => listMyFeedback())");
		expect(src).not.toMatch(/[^(]\blistMyFeedback\(\)(?!\))/);
		expect(src).toMatch(/<FeedbackForYou\b/);
	});
});
