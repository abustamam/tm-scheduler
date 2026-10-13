// @vitest-environment jsdom
/**
 * The member's own speech requests on /me (#1052): create with up to three
 * dates, edit an open request, withdraw one, the back-in-queue notice, and that
 * a live scheduled request offers neither edit nor withdraw. The server fns are
 * mocked (no #/db under jsdom); what they refuse is held by
 * `speech-requests.integration.test.ts`.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	submitSpeechRequest,
	editSpeechRequest,
	withdrawMySpeechRequest,
	invalidate,
	toastSuccess,
	toastError,
} = vi.hoisted(() => ({
	submitSpeechRequest: vi.fn(),
	editSpeechRequest: vi.fn(),
	withdrawMySpeechRequest: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/speech-requests", () => ({
	submitSpeechRequest,
	editSpeechRequest,
	withdrawMySpeechRequest,
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

import { BACK_IN_QUEUE_NOTICE } from "#/lib/speech-requests";
import type { MySpeechRequest } from "#/server/speech-requests";
import { MySpeechRequests } from "./my-speech-requests";

const CLUB = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

function req(over: Partial<MySpeechRequest> = {}): MySpeechRequest {
	return {
		id: "r1",
		clubId: CLUB,
		membershipId: "m1",
		title: "My Ice Breaker",
		path: "Presentation Mastery",
		projectName: "Ice Breaker",
		introduction: null,
		preferredDates: ["2026-11-05"],
		status: "open",
		scheduledSlotId: null,
		createdAt: new Date("2026-10-01T12:00:00Z"),
		scheduledFor: null,
		backInQueue: false,
		timezone: "UTC",
		...over,
	};
}

const renderIt = (requests: MySpeechRequest[]) =>
	render(<MySpeechRequests clubId={CLUB} requests={requests} />);

const dateInput = (n: number) =>
	screen.getByLabelText(`Preferred date ${n}`) as HTMLInputElement;

beforeEach(() => {
	submitSpeechRequest.mockResolvedValue({});
	editSpeechRequest.mockResolvedValue({});
	withdrawMySpeechRequest.mockResolvedValue(undefined);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("MySpeechRequests", () => {
	it("says there is nothing open when the member has no requests", () => {
		renderIt([]);
		expect(screen.getByText("You have no open speech requests.")).toBeTruthy();
	});

	it("creates a request with three preferred dates and refreshes the page", async () => {
		renderIt([]);
		fireEvent.click(screen.getByRole("button", { name: "Request a speech" }));
		fireEvent.change(screen.getByLabelText("Speech title"), {
			target: { value: "Finding my voice" },
		});
		fireEvent.change(dateInput(1), { target: { value: "2026-11-05" } });
		fireEvent.change(dateInput(2), { target: { value: "2026-11-12" } });
		fireEvent.change(dateInput(3), { target: { value: "2026-11-19" } });
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));

		await waitFor(() => expect(submitSpeechRequest).toHaveBeenCalledTimes(1));
		expect(submitSpeechRequest).toHaveBeenCalledWith({
			data: {
				clubId: CLUB,
				title: "Finding my voice",
				path: "",
				projectName: "",
				introduction: "",
				preferredDates: ["2026-11-05", "2026-11-12", "2026-11-19"],
			},
		});
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Request sent.");
		// The form closes once it is sent.
		expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
	});

	it("sends only the dates the member filled in", async () => {
		renderIt([]);
		fireEvent.click(screen.getByRole("button", { name: "Request a speech" }));
		fireEvent.change(dateInput(2), { target: { value: "2026-11-12" } });
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		await waitFor(() => expect(submitSpeechRequest).toHaveBeenCalledTimes(1));
		expect(submitSpeechRequest.mock.calls[0]?.[0].data.preferredDates).toEqual([
			"2026-11-12",
		]);
	});

	it("offers exactly three date fields", () => {
		renderIt([]);
		fireEvent.click(screen.getByRole("button", { name: "Request a speech" }));
		expect(screen.getAllByLabelText(/^Preferred date \d$/)).toHaveLength(3);
	});

	it("reports a refused create and keeps the form open with what was typed", async () => {
		submitSpeechRequest.mockRejectedValue(new Error("Not a member."));
		renderIt([]);
		fireEvent.click(screen.getByRole("button", { name: "Request a speech" }));
		fireEvent.change(screen.getByLabelText("Speech title"), {
			target: { value: "Kept" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("Not a member."),
		);
		expect(invalidate).not.toHaveBeenCalled();
		expect(
			(screen.getByLabelText("Speech title") as HTMLInputElement).value,
		).toBe("Kept");
	});

	it("Cancel closes the new-request form without sending anything", () => {
		renderIt([]);
		fireEvent.click(screen.getByRole("button", { name: "Request a speech" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByLabelText("Speech title")).toBeNull();
		expect(submitSpeechRequest).not.toHaveBeenCalled();
	});

	it("edits an open request: the form starts from its words and saves the changes", async () => {
		renderIt([req({ preferredDates: ["2026-11-05", "2026-11-12"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		expect(
			(screen.getByLabelText("Speech title") as HTMLInputElement).value,
		).toBe("My Ice Breaker");
		expect(dateInput(1).value).toBe("2026-11-05");
		expect(dateInput(2).value).toBe("2026-11-12");
		expect(dateInput(3).value).toBe("");

		fireEvent.change(screen.getByLabelText("Speech title"), {
			target: { value: "Renamed" },
		});
		fireEvent.change(dateInput(2), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(editSpeechRequest).toHaveBeenCalledTimes(1));
		expect(editSpeechRequest).toHaveBeenCalledWith({
			data: {
				requestId: "r1",
				title: "Renamed",
				path: "Presentation Mastery",
				projectName: "Ice Breaker",
				introduction: "",
				preferredDates: ["2026-11-05"],
			},
		});
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Request updated.");
	});

	it("reports a refused edit and leaves the form open", async () => {
		editSpeechRequest.mockRejectedValue(new Error("No longer open."));
		renderIt([req()]);
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith("No longer open."),
		);
		expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
	});

	it("withdraws an open request by its id and refreshes the page", async () => {
		renderIt([req({ id: "r9" })]);
		fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
		await waitFor(() =>
			expect(withdrawMySpeechRequest).toHaveBeenCalledWith({
				data: { requestId: "r9" },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Request withdrawn.");
	});

	it("reports a refused withdraw and does not refresh", async () => {
		withdrawMySpeechRequest.mockRejectedValue(new Error("Not yours."));
		renderIt([req()]);
		fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith("Not yours."));
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("shows the back-in-queue notice on a request whose slot is gone, and still lets it be edited or withdrawn", () => {
		renderIt([req({ backInQueue: true })]);
		const notice = screen.getByTestId("request-back-in-queue");
		expect(notice.textContent).toBe(BACK_IN_QUEUE_NOTICE);
		expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
	});

	it("shows no notice on an ordinary open request", () => {
		renderIt([req()]);
		expect(screen.queryByTestId("request-back-in-queue")).toBeNull();
		expect(screen.getByText("Prefers Nov 5")).toBeTruthy();
	});

	it("a live scheduled request shows where it went and offers no edit or withdraw", () => {
		renderIt([
			req({
				status: "scheduled",
				scheduledSlotId: "s1",
				scheduledFor: new Date("2026-11-12T19:00:00Z"),
			}),
		]);
		const card = screen.getByRole("listitem");
		expect(within(card).getByText("Scheduled for Thu, Nov 12")).toBeTruthy();
		expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
		expect(within(card).queryByRole("button", { name: "Withdraw" })).toBeNull();
		expect(screen.queryByTestId("request-back-in-queue")).toBeNull();
	});

	it("labels an untitled request", () => {
		renderIt([req({ title: null })]);
		expect(screen.getByText("Untitled")).toBeTruthy();
	});
});
