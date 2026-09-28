// @vitest-environment jsdom
//
// The Charter section of club settings (#944): which form a club sees in each
// status, what "Mark as chartered" sends, and that it refuses a missing date or
// number before the round trip. The server fns are mocked (they reach `#/db`).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/clubs", () => ({
	markChartered: vi.fn(),
	updateCharterDate: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { CLUB_NUMBER_REQUIRED_MESSAGE } from "#/lib/club-charter";
import { markChartered, updateCharterDate } from "#/server/clubs";
import { CHARTER_COPY, CharterSettings } from "./charter-settings";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderCharter(
	over: Partial<React.ComponentProps<typeof CharterSettings>> = {},
) {
	const onSaved = vi.fn();
	render(
		<CharterSettings
			clubId={CLUB_ID}
			charterStatus="chartering"
			charteredAt={null}
			clubNumber={null}
			onSaved={onSaved}
			{...over}
		/>,
	);
	return { onSaved };
}

const dateInput = () =>
	screen.getByLabelText(CHARTER_COPY.charterDateLabel) as HTMLInputElement;
const numberInput = () =>
	screen.getByLabelText(CHARTER_COPY.clubNumberLabel) as HTMLInputElement;

describe("Charter settings — chartering club", () => {
	it("offers Mark as chartered, pre-filling the number the club already has", () => {
		renderCharter({ clubNumber: "7654321" });
		expect(screen.getByTestId("charter-status").textContent).toBe("Chartering");
		expect(screen.getByTestId("mark-chartered")).toBeTruthy();
		expect(numberInput().value).toBe("7654321");
		expect(screen.queryByTestId("save-charter-date")).toBeNull();
	});

	it("sends the date and number, then refreshes", async () => {
		vi.mocked(markChartered).mockResolvedValue({ ok: true });
		const { onSaved } = renderCharter();
		const user = userEvent.setup();
		await user.type(dateInput(), "2026-09-01");
		await user.type(numberInput(), "1234567");
		await user.click(screen.getByTestId("mark-chartered"));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(markChartered).toHaveBeenCalledWith({
			data: {
				clubId: CLUB_ID,
				charteredAt: "2026-09-01",
				clubNumber: "1234567",
			},
		});
		expect(toast.success).toHaveBeenCalledWith(CHARTER_COPY.markSuccess);
	});

	it("refuses a missing number before the round trip", async () => {
		renderCharter();
		const user = userEvent.setup();
		await user.type(dateInput(), "2026-09-01");
		// `required` would stop a real browser; submit the form directly to reach
		// the check a browser without constraint validation relies on.
		numberInput().required = false;
		dateInput().form?.requestSubmit();
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(CLUB_NUMBER_REQUIRED_MESSAGE),
		);
		expect(markChartered).not.toHaveBeenCalled();
	});

	it("refuses a missing date before the round trip", async () => {
		renderCharter({ clubNumber: "1" });
		dateInput().required = false;
		dateInput().form?.requestSubmit();
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(CHARTER_COPY.dateRequired),
		);
		expect(markChartered).not.toHaveBeenCalled();
	});

	it("shows the server's refusal", async () => {
		vi.mocked(markChartered).mockRejectedValue(
			new Error("A club with number 1 already exists."),
		);
		const { onSaved } = renderCharter({ clubNumber: "1" });
		const user = userEvent.setup();
		await user.type(dateInput(), "2026-09-01");
		await user.click(screen.getByTestId("mark-chartered"));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"A club with number 1 already exists.",
			),
		);
		expect(onSaved).not.toHaveBeenCalled();
	});
});

describe("Charter settings — chartered club", () => {
	it("edits the charter date and offers no way back to chartering", async () => {
		vi.mocked(updateCharterDate).mockResolvedValue({ ok: true });
		const { onSaved } = renderCharter({
			charterStatus: "chartered",
			charteredAt: "2010-03-04",
			clubNumber: "1",
		});
		expect(screen.getByTestId("charter-status").textContent).toBe("Chartered");
		expect(screen.queryByTestId("mark-chartered")).toBeNull();
		expect(screen.queryByLabelText(CHARTER_COPY.clubNumberLabel)).toBeNull();
		expect(dateInput().value).toBe("2010-03-04");

		const user = userEvent.setup();
		await user.clear(dateInput());
		await user.type(dateInput(), "2011-03-04");
		await user.click(screen.getByTestId("save-charter-date"));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		expect(updateCharterDate).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, charteredAt: "2011-03-04" },
		});
	});

	it("starts empty for a backfilled club with no recorded date", () => {
		renderCharter({ charterStatus: "chartered", clubNumber: "1" });
		expect(dateInput().value).toBe("");
	});
});
