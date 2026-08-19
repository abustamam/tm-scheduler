// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversionPlan } from "#/server/meeting-templates";
import { MeetingTemplateDialog } from "./meeting-template-dialog";

afterEach(cleanup);

const TEMPLATES = [
	{
		id: "t1",
		key: "speech_contest",
		name: "Speech Contest",
		description: "A club contest",
		defaultLengthMinutes: 180,
	},
];

const CLAIMED: ConversionPlan = {
	openSlotsRemoved: 7,
	claimedSlotsReleased: 2,
	slotsWithSpeeches: 1,
	slotsAdded: 17,
	releasedHolders: [
		{
			memberId: "m1",
			guestId: null,
			name: "Ada Lovelace",
			roleName: "Speaker",
		},
		{
			memberId: "m2",
			guestId: null,
			name: "Grace Hopper",
			roleName: "Evaluator",
		},
	],
};

const UNCLAIMED: ConversionPlan = {
	openSlotsRemoved: 9,
	claimedSlotsReleased: 0,
	slotsWithSpeeches: 0,
	slotsAdded: 17,
	releasedHolders: [],
};

function setup(
	over: Partial<Parameters<typeof MeetingTemplateDialog>[0]> = {},
) {
	const loadPreview = vi.fn().mockResolvedValue(CLAIMED);
	const onApply = vi.fn().mockResolvedValue(CLAIMED);
	const props = {
		open: true,
		onOpenChange: vi.fn(),
		currentTemplateId: null,
		templates: TEMPLATES,
		loadPreview,
		onApply,
		...over,
	};
	render(<MeetingTemplateDialog {...props} />);
	return props;
}

const pick = () =>
	userEvent.click(screen.getByRole("button", { name: /Speech Contest/i }));

describe("MeetingTemplateDialog", () => {
	it("lists the standard meeting and every template", () => {
		setup();
		expect(screen.getByText("Standard meeting")).toBeTruthy();
		expect(screen.getByText("Speech Contest")).toBeTruthy();
	});

	it("marks the current template as current", () => {
		setup({ currentTemplateId: "t1" });
		expect(screen.getByText(/current/i)).toBeTruthy();
	});

	it("previews before anything is applied", async () => {
		const { onApply } = setup();
		await pick();
		await waitFor(() => screen.getByText(/will lose the roles/i));
		expect(onApply).not.toHaveBeenCalled();
	});

	/**
	 * The whole reason this dialog is worded the way it is: a released member
	 * cannot be notified by the app, so the officer has to be told to do it.
	 */
	it("names the members losing a role, and says to message them", async () => {
		setup();
		await pick();
		await waitFor(() =>
			expect(
				screen.getByText(/Ada Lovelace and Grace Hopper will lose the roles/i),
			).toBeTruthy(),
		);
		expect(
			screen.getByText(/won't be told automatically — message them/i),
		).toBeTruthy();
	});

	it("reassures that speeches survive", async () => {
		setup();
		await pick();
		await waitFor(() =>
			expect(
				screen.getByText(/Speeches stay attached to their speakers/i),
			).toBeTruthy(),
		);
	});

	it("says how many roles it will add", async () => {
		setup();
		await pick();
		await waitFor(() =>
			expect(screen.getByText(/adds 17 roles/i)).toBeTruthy(),
		);
	});

	it("requires a SECOND confirm when claimed roles will be lost", async () => {
		const { onApply } = setup();
		await pick();
		await waitFor(() =>
			screen.getByRole("button", { name: /Release 2 roles/i }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: /Release 2 roles/i }),
		);
		// Not applied yet — the confirm step stands between.
		expect(onApply).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: /Yes, switch/i }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith("t1"));
	});

	it("applies in ONE tap when nothing is claimed", async () => {
		const { onApply } = setup({
			loadPreview: vi.fn().mockResolvedValue(UNCLAIMED),
		});
		await pick();
		await waitFor(() => screen.getByRole("button", { name: /Switch to/i }));
		await userEvent.click(screen.getByRole("button", { name: /Switch to/i }));
		await waitFor(() => expect(onApply).toHaveBeenCalledWith("t1"));
	});

	it("shows an error and keeps Apply disabled when the preview fails", async () => {
		setup({ loadPreview: vi.fn().mockRejectedValue(new Error("network")) });
		await pick();
		await waitFor(() =>
			expect(screen.getByText(/Couldn't load what this change/i)).toBeTruthy(),
		);
		expect(
			(screen.getByRole("button", { name: /Switch to/i }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("recovers when Retry succeeds", async () => {
		setup({
			loadPreview: vi
				.fn()
				.mockRejectedValueOnce(new Error("network"))
				.mockResolvedValueOnce(CLAIMED),
		});
		await pick();
		await waitFor(() => screen.getByRole("button", { name: /Retry/i }));
		await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
		await waitFor(() =>
			expect(screen.getByText("Ada Lovelace — Speaker")).toBeTruthy(),
		);
	});

	it("does not fire a second conversion on a double-click", async () => {
		let release: (v: unknown) => void = () => {};
		const onApply = vi.fn(
			() =>
				new Promise((r) => {
					release = r;
				}),
		);
		setup({ loadPreview: vi.fn().mockResolvedValue(UNCLAIMED), onApply });
		await pick();
		await waitFor(() => screen.getByRole("button", { name: /Switch to/i }));
		const button = screen.getByRole("button", { name: /Switch to/i });
		await userEvent.click(button);
		await userEvent.click(button);
		expect(onApply).toHaveBeenCalledTimes(1);
		release(UNCLAIMED);
	});

	it("explains itself when the club has no templates", () => {
		setup({ templates: [] });
		expect(
			screen.getByText(/Only the standard meeting is set up for this club/i),
		).toBeTruthy();
	});

	it("renders released members as plain text, never links", async () => {
		// The unlayered `a` rule in src/styles.css beats layered utilities and
		// would repaint any anchor here link-teal.
		setup();
		await pick();
		await waitFor(() => screen.getByText("Ada Lovelace — Speaker"));
		expect(screen.getByText("Ada Lovelace — Speaker").closest("a")).toBeNull();
	});
});
