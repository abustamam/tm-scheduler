// @vitest-environment jsdom
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { SpeechLogEditButton } from "#/components/speech-log-edit";
import { readSource } from "#/test/guard-source";

/**
 * The speech log's edit sheet (#1159): the same sheet as the agenda's, choosing
 * its writer by the `writer` prop. A wrong pick is silent in the UI (both fns
 * take one payload) and only shows on a completed meeting, so it is pinned here.
 */

const server = vi.hoisted(() => ({
	editSpeechFromLog: vi.fn(async () => ({ ok: true as const })),
	updateSpeakerDetails: vi.fn(async () => ({ ok: true as const })),
	invalidate: vi.fn(async () => {}),
	getProjectOptions: vi.fn(async () => [] as unknown[]),
}));
vi.mock("#/server/speeches", () => ({
	editSpeechFromLog: server.editSpeechFromLog,
}));
vi.mock("#/server/slots", () => ({
	updateSpeakerDetails: server.updateSpeakerDetails,
}));
vi.mock("#/server/project-picker", () => ({
	getProjectOptions: server.getProjectOptions,
}));
vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: server.invalidate }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const slot = {
	id: "slot-1",
	label: "Ice Breaker · Sat, Aug 29",
	speechTitle: "My first speech",
	pathwayPath: null,
	projectName: null,
	projectLevel: null,
	projectId: null,
	assigneeId: "member-1",
	minMinutes: null,
	maxMinutes: null,
	presentationUrl: null,
};

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(cleanup);

describe("EditSpeechSheet writer", () => {
	it('writer="speech-log" saves through editSpeechFromLog', async () => {
		render(
			<EditSpeechSheet
				writer="speech-log"
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Save speech" }));
		await waitFor(() =>
			expect(server.editSpeechFromLog).toHaveBeenCalledTimes(1),
		);
		expect(server.updateSpeakerDetails).not.toHaveBeenCalled();
		expect(server.editSpeechFromLog).toHaveBeenCalledWith({
			data: {
				slotId: "slot-1",
				speakerDetails: expect.objectContaining({
					speechTitle: "My first speech",
				}),
			},
		});
	});

	it("the default writer is the agenda's updateSpeakerDetails", async () => {
		render(
			<EditSpeechSheet
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Save speech" }));
		await waitFor(() =>
			expect(server.updateSpeakerDetails).toHaveBeenCalledTimes(1),
		);
		expect(server.editSpeechFromLog).not.toHaveBeenCalled();
	});
});

describe("EditSpeechSheet free text the form did not show", () => {
	const enrolled = [
		{
			pathId: "path-1",
			courseCode: "8701",
			name: "Presentation Mastery",
			status: "current",
			defaultLevel: 1,
			projects: [],
		},
	];

	it('speech-log writer leaves hidden path, project and level out of the payload, and sends shown-but-empty ones as ""', async () => {
		// With a path the picker hides the three free-text inputs: nothing to send.
		server.getProjectOptions.mockResolvedValueOnce(enrolled);
		const { unmount } = render(
			<EditSpeechSheet
				writer="speech-log"
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await screen.findByText("Choose a project");
		await userEvent.click(screen.getByRole("button", { name: "Save speech" }));
		await waitFor(() =>
			expect(server.editSpeechFromLog).toHaveBeenCalledTimes(1),
		);
		const hidden = (
			server.editSpeechFromLog.mock.calls[0] as unknown as [
				{ data: { speakerDetails: Record<string, unknown> } },
			]
		)[0].data.speakerDetails;
		expect(hidden.pathwayPath).toBeUndefined();
		expect(hidden.projectName).toBeUndefined();
		expect(hidden.projectLevel).toBeUndefined();
		unmount();

		// No path: the inputs are on the form, and an empty one is a clear.
		server.editSpeechFromLog.mockClear();
		render(
			<EditSpeechSheet
				writer="speech-log"
				slot={slot}
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Save speech" }));
		await waitFor(() =>
			expect(server.editSpeechFromLog).toHaveBeenCalledTimes(1),
		);
		expect(server.editSpeechFromLog).toHaveBeenCalledWith({
			data: {
				slotId: "slot-1",
				speakerDetails: expect.objectContaining({
					pathwayPath: "",
					projectName: "",
					projectLevel: "",
				}),
			},
		});
	});
});

describe("SpeechLogEditButton", () => {
	it("opens the sheet for the row, saves through the speech-log writer, then refreshes", async () => {
		render(
			<SpeechLogEditButton
				timezone="UTC"
				row={{
					slotId: "slot-9",
					memberId: "member-9",
					scheduledAt: new Date("2026-08-29T18:00:00Z"),
					roleName: "Speaker",
					speechTitle: "TBA",
					pathwayPath: null,
					projectName: null,
					projectLevel: null,
					projectId: null,
					minMinutes: null,
					maxMinutes: null,
					presentationUrl: null,
				}}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: "Edit speech details" }),
		);
		// "<headline> · <date>": a TBA title reads as the role name.
		expect(
			await screen.findByText(/Edit speech — Speaker · Sat, Aug 29/),
		).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Save speech" }));
		await waitFor(() => expect(server.invalidate).toHaveBeenCalledTimes(1));
		expect(server.editSpeechFromLog).toHaveBeenCalledWith({
			data: expect.objectContaining({ slotId: "slot-9" }),
		});
	});
});

describe("the profile route's wiring", () => {
	// The button is a PREDICTION of the server's gate, and swapping what feeds
	// it (the member's id for the viewer's, say) survives every other test.
	// Comment-blind: a comment that names the call must not satisfy the pin.
	const source = readSource(
		resolve(__dirname, "../routes/_authed/members.$id.tsx"),
	);

	it("feeds mayShowSpeechLogEdit the viewer's admin standing, the session user and the member's account", () => {
		const call = source.match(/mayShowSpeechLogEdit\(\{([^}]*)\}\)/)?.[1] ?? "";
		expect(call).toMatch(/viewerIsAdmin,/);
		expect(call).toMatch(/viewerUserId:\s*authUser\.id/);
		expect(call).toMatch(/memberUserId:\s*member\?\.userId\s*\?\?\s*null/);
	});

	it("renders the button only under showSpeechEdit, and showSpeechEdit is the prediction's result", () => {
		expect(source).toMatch(
			/\{showSpeechEdit\s*\?\s*\(\s*<SpeechLogEditButton\b/,
		);
		expect(source).toMatch(/const showSpeechEdit\s*=\s*mayShowSpeechLogEdit\(/);
	});
});
