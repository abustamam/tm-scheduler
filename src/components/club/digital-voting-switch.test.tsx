// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));

import { DigitalVotingSwitch } from "./digital-voting-switch";

afterEach(cleanup);

describe("DigitalVotingSwitch (#770)", () => {
	it("asks before turning off, and only turns off on confirm", async () => {
		const onSetDisabled = vi.fn().mockResolvedValue(undefined);
		render(
			<DigitalVotingSwitch
				digitalVoting
				clubDigitalVotingEnabled
				busy={false}
				onSetDisabled={onSetDisabled}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", {
				name: "Turn off digital voting for this meeting",
			}),
		);
		expect(onSetDisabled).not.toHaveBeenCalled();
		expect(screen.getByText(/Any vote that's open closes now/)).toBeTruthy();

		await userEvent.click(
			screen.getByRole("button", { name: "Keep digital voting" }),
		);
		expect(onSetDisabled).not.toHaveBeenCalled();

		await userEvent.click(
			screen.getByRole("button", {
				name: "Turn off digital voting for this meeting",
			}),
		);
		await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
		expect(onSetDisabled).toHaveBeenCalledWith(true);
	});

	it("turns back on in one tap when only the meeting has it off", async () => {
		const onSetDisabled = vi.fn().mockResolvedValue(undefined);
		render(
			<DigitalVotingSwitch
				digitalVoting={false}
				clubDigitalVotingEnabled
				busy={false}
				onSetDisabled={onSetDisabled}
			/>,
		);
		expect(
			screen.getByText("Digital voting is off for this meeting."),
		).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
		expect(onSetDisabled).toHaveBeenCalledWith(false);
	});

	it("offers no Turn on when the CLUB has it off, and points at Club settings", () => {
		render(
			<DigitalVotingSwitch
				digitalVoting={false}
				clubDigitalVotingEnabled={false}
				busy={false}
				onSetDisabled={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
		expect(
			screen.getByText(/Digital voting is off for this club/),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Club settings" }).getAttribute("href"),
		).toBe("/admin/club-settings");
	});
});
