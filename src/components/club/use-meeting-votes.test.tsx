// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingVotes } from "./use-meeting-votes";

const invalidate = vi.fn(async () => {});
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));
const addTableTopics = vi.fn(async (_a: unknown) => ({}));
const removeTableTopics = vi.fn(async (_a: unknown) => ({}));
const moveTableTopics = vi.fn(async (_a: unknown) => ({}));
const setMinutesAward = vi.fn(async (_a: unknown) => ({}));
const clearMinutesAward = vi.fn(async (_a: unknown) => ({}));
vi.mock("#/server/minutes", () => ({
	addTableTopics: (a: unknown) => addTableTopics(a),
	removeTableTopics: (a: unknown) => removeTableTopics(a),
	moveTableTopics: (a: unknown) => moveTableTopics(a),
	setMinutesAward: (a: unknown) => setMinutesAward(a),
	clearMinutesAward: (a: unknown) => clearMinutesAward(a),
}));
const setMeetingDigitalVoting = vi.fn(async (_a: unknown) => ({}));
vi.mock("#/server/meetings", () => ({
	setMeetingDigitalVoting: (a: unknown) => setMeetingDigitalVoting(a),
}));
const getVoteTally = vi.fn(async (_a: unknown) => ({
	tableTopicsSpeakers: [{ id: "s1", name: "Sam", kind: "guest" }],
}));
vi.mock("#/server/voting", () => ({
	getVoteTally: (a: unknown) => getVoteTally(a),
}));

function setup(over: Partial<Parameters<typeof useMeetingVotes>[0]> = {}) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return renderHook(
		() =>
			useMeetingVotes({
				meetingId: "m1",
				myId: "me",
				isVoteCounter: false,
				effectiveCanManage: false,
				minutes: { canEdit: false, data: null } as never,
				...over,
			}),
		{ wrapper },
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("useMeetingVotes", () => {
	it("adds a speaker with the meeting, the viewer's self-assert and the payload, then refreshes", async () => {
		const { result } = setup();
		await act(() =>
			result.current.handleAddTableTopicsSpeaker({ memberId: "p1" }),
		);
		expect(addTableTopics).toHaveBeenCalledWith({
			data: { meetingId: "m1", selfMemberId: "me", memberId: "p1" },
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(result.current.voteConsoleBusy).toBe(false);
	});

	it("removes and moves a speaker with the viewer's self-assert", async () => {
		const { result } = setup();
		await act(() => result.current.handleRemoveTableTopicsSpeaker("t1"));
		expect(removeTableTopics).toHaveBeenCalledWith({
			data: { meetingId: "m1", id: "t1", selfMemberId: "me" },
		});
		await act(() => result.current.handleMoveTableTopicsSpeaker("t1", "up"));
		expect(moveTableTopics).toHaveBeenCalledWith({
			data: { meetingId: "m1", id: "t1", direction: "up", selfMemberId: "me" },
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("toasts the server's message and does not refresh when a write fails", async () => {
		addTableTopics.mockRejectedValueOnce(new Error("nope"));
		const { result } = setup();
		await act(() =>
			result.current.handleAddTableTopicsSpeaker({ memberId: "p1" }),
		);
		expect(toastError).toHaveBeenCalledWith("nope");
		expect(invalidate).not.toHaveBeenCalled();
		expect(result.current.voteConsoleBusy).toBe(false);
	});

	it("flips digital voting for the meeting", async () => {
		const { result } = setup();
		await act(() => result.current.handleSetDigitalVotingDisabled(true));
		expect(setMeetingDigitalVoting).toHaveBeenCalledWith({
			data: { meetingId: "m1", disabled: true },
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(result.current.digitalVotingBusy).toBe(false);
	});

	it("maps each winner kind to the one matching field", async () => {
		const { result } = setup();
		await act(() =>
			result.current.handleSetVoteWinner("best_speaker" as never, {
				kind: "guest",
				id: "g1",
			}),
		);
		expect(setMinutesAward).toHaveBeenCalledWith({
			data: {
				meetingId: "m1",
				category: "best_speaker",
				memberId: undefined,
				guestId: "g1",
				writeInName: undefined,
				selfMemberId: "me",
			},
		});
		await act(() =>
			result.current.handleSetVoteWinner("best_speaker" as never, {
				kind: "writeIn",
				name: "Zed",
			}),
		);
		expect(setMinutesAward).toHaveBeenLastCalledWith({
			data: expect.objectContaining({
				memberId: undefined,
				guestId: undefined,
				writeInName: "Zed",
			}),
		});
		expect(toastSuccess).toHaveBeenCalledWith("Winner set.");
	});

	it("clears a winner and refreshes", async () => {
		const { result } = setup();
		await act(() =>
			result.current.handleClearVoteWinner("best_speaker" as never),
		);
		expect(clearMinutesAward).toHaveBeenCalledWith({
			data: { meetingId: "m1", category: "best_speaker", selfMemberId: "me" },
		});
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("reads the console's speakers from the vote tally unless the full minutes are readable", async () => {
		const { result, rerender } = setup({ isVoteCounter: true });
		await vi.waitFor(() =>
			expect(result.current.consoleSpeakers).toHaveLength(1),
		);
		expect(getVoteTally).toHaveBeenCalledWith({
			data: { meetingId: "m1", selfMemberId: "me" },
		});
		expect(result.current.consoleSpeakers[0]).toEqual({
			id: "s1",
			name: "Sam",
			isGuest: true,
			topic: null,
		});
		rerender();
		const full = setup({
			effectiveCanManage: true,
			minutes: {
				canEdit: true,
				data: { tableTopicsSpeakers: [{ id: "x", name: "Full", topic: "t" }] },
			} as never,
		});
		expect(full.result.current.consoleSpeakers[0]?.name).toBe("Full");
	});
});
