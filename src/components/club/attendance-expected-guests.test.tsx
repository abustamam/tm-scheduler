// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttendanceExpectedGuests } from "./attendance-expected-guests";

afterEach(cleanup);

const GUESTS = [
	{ guestId: "g1", name: "Dana Reyes", visitNumber: 1 },
	{ guestId: "g2", name: "Sam Ortiz", visitNumber: 3 },
];

describe("AttendanceExpectedGuests", () => {
	/*
	 * protects: AC5 on the officer's list: the label per guest, no write control
	 *   before the meeting.
	 * fails_when: a first-time guest reads as a returning one (or the reverse), or
	 *   the pre-meeting list grows a Here button.
	 * no_claim: says nothing about the server-derived visit number.
	 */
	it("lists each guest with their visit label and no Here before the meeting", () => {
		render(<AttendanceExpectedGuests guests={GUESTS} />);
		expect(screen.getByText("Dana Reyes")).toBeTruthy();
		expect(screen.getByText("first visit")).toBeTruthy();
		expect(screen.getByText("3rd visit")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	/*
	 * protects: D7, a row's Here hands back THAT guest's id and nothing else.
	 * fails_when: the tap passes the wrong id, fires on render, or marks every row.
	 */
	it("calls onHere with the tapped guest only, and only on the tap", () => {
		const onHere = vi.fn();
		render(<AttendanceExpectedGuests guests={GUESTS} onHere={onHere} />);
		expect(onHere).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Mark Sam Ortiz here" }),
		);
		expect(onHere).toHaveBeenCalledTimes(1);
		expect(onHere).toHaveBeenCalledWith("g2");
	});

	// protects=locked disables every Here. fails_when=a locked roll still writes.
	it("disables Here while locked", () => {
		const onHere = vi.fn();
		render(<AttendanceExpectedGuests guests={GUESTS} onHere={onHere} locked />);
		const btn = screen.getByRole("button", { name: "Mark Dana Reyes here" });
		expect((btn as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(btn);
		expect(onHere).not.toHaveBeenCalled();
	});

	// protects=an empty list renders nothing, no empty heading.
	it("renders nothing for no guests", () => {
		const { container } = render(<AttendanceExpectedGuests guests={[]} />);
		expect(container.firstChild).toBeNull();
	});
});
