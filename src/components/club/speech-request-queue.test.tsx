// @vitest-environment jsdom
/**
 * The VPE's speech-request queue (#1052): rows in the order the server gave,
 * the Schedule picker listing the open slots and marking and preselecting a
 * meeting on a preferred day, and Schedule sending the chosen slot (and
 * reporting a refusal). The server fns are mocked (no #/db under jsdom); the
 * ordering and the refusals are held by the integration tests.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	getSchedulableSpeakerSlots,
	scheduleRequestedSpeech,
	invalidate,
	toastSuccess,
	toastError,
} = vi.hoisted(() => ({
	getSchedulableSpeakerSlots: vi.fn(),
	scheduleRequestedSpeech: vi.fn(),
	invalidate: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("#/server/speech-requests", () => ({
	getSchedulableSpeakerSlots,
	scheduleRequestedSpeech,
}));
vi.mock("sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useRouter: () => ({ invalidate }),
}));

import type { SpeechQueueRow } from "#/server/speech-requests";
import { SpeechRequestQueue } from "./speech-request-queue";

const CLUB = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

function row(over: Partial<SpeechQueueRow> = {}): SpeechQueueRow {
	return {
		id: "r1",
		memberId: "m1",
		memberName: "Ada Lovelace",
		title: "Ice Breaker",
		path: null,
		projectName: null,
		introduction: null,
		preferredDates: [],
		lastSpokeAt: null,
		createdAt: new Date("2026-10-01T12:00:00Z"),
		...over,
	};
}

const SLOTS = [
	{
		slotId: "slot-nov5",
		meetingId: "mt1",
		scheduledAt: new Date("2026-11-05T19:00:00Z"),
		roleName: "Speaker 1",
	},
	{
		slotId: "slot-nov12",
		meetingId: "mt2",
		scheduledAt: new Date("2026-11-12T19:00:00Z"),
		roleName: "Speaker 2",
	},
];

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const renderQueue = (rows: SpeechQueueRow[]) =>
	render(<SpeechRequestQueue clubId={CLUB} rows={rows} timezone="UTC" />);

const picker = (name: string) =>
	screen.findByLabelText(`Slot for ${name}`) as Promise<HTMLSelectElement>;

describe("SpeechRequestQueue", () => {
	it("renders the rows in the order given, not re-sorted", () => {
		renderQueue([
			row({ id: "a", memberName: "Zed Zimmer" }),
			row({ id: "b", memberName: "Amy Adams" }),
			row({ id: "c", memberName: "Mia Moss" }),
		]);
		const names = within(screen.getByTestId("speech-request-queue"))
			.getAllByRole("listitem")
			.map((li) => li.querySelector(".font-bold")?.textContent);
		expect(names).toEqual(["Zed Zimmer", "Amy Adams", "Mia Moss"]);
	});

	it("says never spoken or when the member last spoke, with preferred dates", () => {
		renderQueue([
			row({
				id: "a",
				memberName: "Never Spoke",
				preferredDates: ["2026-11-05", "2026-11-12"],
			}),
			row({
				id: "b",
				memberName: "Spoke Before",
				lastSpokeAt: new Date("2026-03-04T19:00:00Z"),
			}),
		]);
		const [first, second] = screen.getAllByRole("listitem");
		expect(first?.textContent).toContain("Prefers Nov 5, Nov 12");
		expect(first?.textContent).toContain("never spoken");
		expect(second?.textContent).toContain("No preferred dates");
		expect(second?.textContent).toContain("last spoke");
		expect(second?.textContent).not.toContain("never spoken");
	});

	it("labels an untitled request", () => {
		renderQueue([row({ title: null })]);
		expect(screen.getByText("Untitled")).toBeTruthy();
	});

	it("lists the open slots in the picker and marks the preferred day", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		renderQueue([row({ preferredDates: ["2026-11-12"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		const select = await picker("Ada Lovelace");
		expect(getSchedulableSpeakerSlots).toHaveBeenCalledWith({
			data: { clubId: CLUB },
		});
		const options = Array.from(select.options).map((o) => o.textContent);
		expect(options).toEqual([
			"Thu, Nov 5 · Speaker 1",
			"Thu, Nov 12 · Speaker 2 (preferred)",
		]);
	});

	it("preselects the slot on a preferred day", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		renderQueue([row({ preferredDates: ["2026-11-12"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		expect((await picker("Ada Lovelace")).value).toBe("slot-nov12");
	});

	it("preselects the first slot when no day is preferred, and marks none", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		renderQueue([row({ preferredDates: ["2026-12-25"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		const select = await picker("Ada Lovelace");
		expect(select.value).toBe("slot-nov5");
		expect(
			Array.from(select.options).some((o) =>
				o.textContent?.includes("(preferred)"),
			),
		).toBe(false);
	});

	it("Schedule sends the request and the slot the VPE chose, then closes and refreshes", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		scheduleRequestedSpeech.mockResolvedValue({
			speechId: "sp1",
			slotId: "slot-nov5",
		});
		renderQueue([row({ id: "req-7", preferredDates: ["2026-11-12"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		const select = await picker("Ada Lovelace");
		// The preselected preferred slot is overridden by the VPE's own pick.
		fireEvent.change(select, { target: { value: "slot-nov5" } });
		fireEvent.click(screen.getByRole("button", { name: "Put in this slot" }));

		await waitFor(() =>
			expect(scheduleRequestedSpeech).toHaveBeenCalledWith({
				data: { requestId: "req-7", slotId: "slot-nov5" },
			}),
		);
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(toastSuccess).toHaveBeenCalledWith("Scheduled Ada Lovelace.");
		expect(screen.queryByLabelText("Slot for Ada Lovelace")).toBeNull();
	});

	it("Schedule with the preselected slot sends that slot", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		scheduleRequestedSpeech.mockResolvedValue({});
		renderQueue([row({ preferredDates: ["2026-11-12"] })]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		await picker("Ada Lovelace");
		fireEvent.click(screen.getByRole("button", { name: "Put in this slot" }));
		await waitFor(() =>
			expect(scheduleRequestedSpeech).toHaveBeenCalledTimes(1),
		);
		expect(scheduleRequestedSpeech.mock.calls[0]?.[0].data.slotId).toBe(
			"slot-nov12",
		);
	});

	it("reports a refusal, keeps the picker open and does not refresh", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		scheduleRequestedSpeech.mockRejectedValue(
			new Error("That speaker slot was just taken."),
		);
		renderQueue([row()]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		await picker("Ada Lovelace");
		fireEvent.click(screen.getByRole("button", { name: "Put in this slot" }));
		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"That speaker slot was just taken.",
			),
		);
		expect(invalidate).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Slot for Ada Lovelace")).toBeTruthy();
	});

	it("says so when there is no open speaker slot", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue([]);
		renderQueue([row()]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		expect(
			await screen.findByText("No open speaker slot on an upcoming meeting."),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Put in this slot" }),
		).toBeNull();
	});

	it("shows the refusal when the slots cannot be loaded", async () => {
		getSchedulableSpeakerSlots.mockRejectedValue(new Error("Forbidden."));
		renderQueue([row()]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		expect((await screen.findByRole("alert")).textContent).toBe("Forbidden.");
	});

	it("the Close button hides the picker again", async () => {
		getSchedulableSpeakerSlots.mockResolvedValue(SLOTS);
		renderQueue([row()]);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		await picker("Ada Lovelace");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByLabelText("Slot for Ada Lovelace")).toBeNull();
	});
});
