// @vitest-environment jsdom
/**
 * `answerThenReload` (#1209): a failed reload after a landed answer must not
 * read as a failed answer, or the mentor loses the welcome draft.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMentorRequest } from "#/server/mentorship";
import { answerThenReload } from "./mentor-request-shared";
import { MentorRequestsCard } from "./mentor-requests-card";

afterEach(cleanup);

const sam: IncomingMentorRequest = {
	id: "r1",
	focus: "contest",
	focusOther: null,
	createdAt: new Date("2026-10-10T12:00:00Z"),
	mentee: {
		id: "m1",
		name: "Sam Smith",
		email: "sam@example.org",
		phone: "+15555550122",
		preferredContact: null,
	},
};

describe("answerThenReload (#1209)", () => {
	// protects=a reload that throws AFTER the answer landed resolves, so the
	// card shows "Now mentoring ... Say hi:" with its draft; a failed ANSWER still
	// rejects and never reloads;
	// fails_when=a reload failure rejects (the card hides the draft and keeps
	// Accept), or a failed answer swallows its error or reloads anyway;
	// no_claim=that the dashboard wires its reload through this (wiring guard)
	it("shows the welcome draft when the reload fails after Accept", async () => {
		const user = userEvent.setup();
		const answer = vi.fn().mockResolvedValue({ status: "accepted" });
		const reload = vi.fn().mockRejectedValue(new Error("network"));
		render(
			<MentorRequestsCard
				requests={[sam]}
				onDecide={() => answerThenReload(answer, reload)}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Accept" }));
		expect(
			await screen.findByText("Now mentoring Sam Smith. Say hi:"),
		).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("rejects without reloading when the answer itself fails", async () => {
		const reload = vi.fn();
		await expect(
			answerThenReload(() => Promise.reject(new Error("refused")), reload),
		).rejects.toThrow("refused");
		expect(reload).not.toHaveBeenCalled();
	});
});
