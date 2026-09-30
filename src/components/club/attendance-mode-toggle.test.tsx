// @vitest-environment jsdom

/**
 * In person / online in roll mode (#1049): the toggle itself, where the panel
 * and the Guests group render it, and what each fires.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same stub the panel's own suite needs: the Guests group reaches the shared
// `GuestEditDialog`, whose server-fn import pulls `#/db` at import time.
vi.mock("#/server/guest-pipeline", () => ({ updateGuest: vi.fn() }));
vi.mock("#/server/guests", () => ({
	getGuestProfile: vi.fn().mockResolvedValue(null),
	updateGuestProfile: vi.fn(),
}));

import { AttendanceGuestsGroup } from "./attendance-guests-group";
import { AttendanceModeToggle } from "./attendance-mode-toggle";
import { MeetingAttendancePanel } from "./meeting-attendance-panel";

afterEach(() => cleanup());

describe("AttendanceModeToggle", () => {
	it("presses neither segment when the mode was not recorded", () => {
		render(
			<AttendanceModeToggle
				name="Ayesha Khan"
				mode={null}
				disabled={false}
				onChange={vi.fn()}
			/>,
		);
		for (const name of [
			"Ayesha Khan attended in person",
			"Ayesha Khan attended online",
		]) {
			expect(
				screen.getByRole("button", { name }).getAttribute("aria-pressed"),
			).toBe("false");
		}
	});

	it("presses the recorded one and fires the other on tap", async () => {
		const onChange = vi.fn();
		render(
			<AttendanceModeToggle
				name="Ayesha Khan"
				mode="in_person"
				disabled={false}
				onChange={onChange}
			/>,
		);
		const inPerson = screen.getByRole("button", {
			name: "Ayesha Khan attended in person",
		});
		expect(inPerson.getAttribute("aria-pressed")).toBe("true");
		// Re-pressing the record writes nothing.
		await userEvent.click(inPerson);
		expect(onChange).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: "Ayesha Khan attended online" }),
		);
		expect(onChange).toHaveBeenCalledExactlyOnceWith("online");
	});

	it("fires nothing while disabled", async () => {
		const onChange = vi.fn();
		render(
			<AttendanceModeToggle
				name="Bo Lin"
				mode={null}
				disabled={true}
				onChange={onChange}
			/>,
		);
		const online = screen.getByRole("button", {
			name: "Bo Lin attended online",
		});
		expect((online as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(online);
		expect(onChange).not.toHaveBeenCalled();
	});
});

const roster = [
	{
		id: "m1",
		name: "Ayesha Khan",
		preferredName: null,
		phone: null,
		email: null,
	},
	{ id: "m2", name: "Bo Lin", preferredName: null, phone: null, email: null },
	{ id: "m3", name: "Cy Moss", preferredName: null, phone: null, email: null },
];

function renderRoll(
	over: Partial<Parameters<typeof MeetingAttendancePanel>[0]> = {},
) {
	return render(
		<MeetingAttendancePanel
			mode="roll"
			roster={roster}
			plan={[]}
			rungOverride={{}}
			roleByMemberId={{}}
			meetingDate="Tue 19 Aug"
			shareUrl="https://club.example/m"
			locked={false}
			phaseCompleted={true}
			onWriteRung={vi.fn()}
			onContacted={vi.fn()}
			onSetAttendance={vi.fn()}
			attendance={[
				{ memberId: "m1", status: "present", mode: "online" },
				// Present from before #1049 — no mode.
				{ memberId: "m2", status: "present" },
				{ memberId: "m3", status: "absent" },
			]}
			{...over}
		/>,
	);
}

describe("MeetingAttendancePanel roll mode — mode toggle (#1049)", () => {
	it("offers the toggle on PRESENT rows only, showing what was recorded", () => {
		renderRoll({ onSetMode: vi.fn() });
		expect(
			screen
				.getByRole("button", { name: "Ayesha Khan attended online" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		// A NULL mode is shown as nothing chosen, never as in person.
		expect(
			screen
				.getByRole("button", { name: "Bo Lin attended in person" })
				.getAttribute("aria-pressed"),
		).toBe("false");
		expect(
			screen.queryByRole("button", { name: /Cy Moss attended/ }),
		).toBeNull();
	});

	it("fires onSetMode with the member and the chosen mode", async () => {
		const onSetMode = vi.fn();
		renderRoll({ onSetMode });
		await userEvent.click(
			screen.getByRole("button", { name: "Bo Lin attended online" }),
		);
		expect(onSetMode).toHaveBeenCalledExactlyOnceWith("m2", "online");
	});

	it("renders no toggle when the caller wired none", () => {
		renderRoll();
		expect(screen.queryByRole("button", { name: /attended/ })).toBeNull();
	});

	it("disables the toggle while any write is in flight", () => {
		renderRoll({ onSetMode: vi.fn(), busy: true });
		expect(
			(
				screen.getByRole("button", {
					name: "Ayesha Khan attended in person",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("puts the split into the counts line", () => {
		renderRoll({ onSetMode: vi.fn() });
		screen.getByText("2 present (1 online, 1 not recorded) · 1 absent");
	});

	it("passes the guest toggle down to the Guests group", async () => {
		const onSetGuestMode = vi.fn();
		renderRoll({
			guests: [{ guestId: "g1", name: "Nadia Farouk", fromRole: true }],
			clubGuests: [],
			onSetGuestMode,
		});
		await userEvent.click(
			screen.getByRole("button", { name: "Nadia Farouk attended in person" }),
		);
		expect(onSetGuestMode).toHaveBeenCalledExactlyOnceWith("g1", "in_person");
	});
});

describe("AttendanceGuestsGroup — mode toggle (#1049)", () => {
	const base = {
		clubGuests: [],
		locked: false,
		onAddGuest: vi.fn(),
		onRemoveGuest: vi.fn(),
	};

	it("shows each guest's recorded mode, including a role-only guest's", () => {
		render(
			<AttendanceGuestsGroup
				{...base}
				guests={[
					{
						guestId: "g1",
						name: "Nadia Farouk",
						fromRole: false,
						mode: "online",
					},
					{ guestId: "g2", name: "Tom Reyes", fromRole: true },
				]}
				onSetGuestMode={vi.fn()}
			/>,
		);
		expect(
			screen
				.getByRole("button", { name: "Nadia Farouk attended online" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		const tom = screen.getByRole("group", { name: "How Tom Reyes attended" });
		for (const b of within(tom).getAllByRole("button")) {
			expect(b.getAttribute("aria-pressed")).toBe("false");
		}
	});

	it("disables the guest toggle when the group is locked", async () => {
		const onSetGuestMode = vi.fn();
		render(
			<AttendanceGuestsGroup
				{...base}
				locked={true}
				guests={[{ guestId: "g1", name: "Nadia Farouk", fromRole: false }]}
				onSetGuestMode={onSetGuestMode}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Nadia Farouk attended online" }),
		);
		expect(onSetGuestMode).not.toHaveBeenCalled();
	});

	it("renders no toggle without onSetGuestMode", () => {
		render(
			<AttendanceGuestsGroup
				{...base}
				guests={[{ guestId: "g1", name: "Nadia Farouk", fromRole: false }]}
			/>,
		);
		expect(screen.queryByRole("button", { name: /attended/ })).toBeNull();
	});
});
