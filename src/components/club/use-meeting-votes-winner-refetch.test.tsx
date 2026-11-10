// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeetingVotes } from "./use-meeting-votes";

const setMinutesAward = vi.fn(async (_a: unknown) => ({}));
const clearMinutesAward = vi.fn(async (_a: unknown) => ({}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("#/server/meetings", () => ({ setMeetingDigitalVoting: vi.fn() }));
vi.mock("#/server/minutes", () => ({
	addTableTopics: vi.fn(),
	removeTableTopics: vi.fn(),
	moveTableTopics: vi.fn(),
	setMinutesAward: (a: unknown) => setMinutesAward(a),
	clearMinutesAward: (a: unknown) => clearMinutesAward(a),
}));
const getVoteTally = vi.fn(async (_a: unknown) => ({
	tableTopicsSpeakers: [],
}));
vi.mock("#/server/voting", () => ({
	getVoteTally: (a: unknown) => getVoteTally(a),
	closeVoteFn: vi.fn(),
	disqualifyCandidateFn: vi.fn(),
	openVoteFn: vi.fn(),
	undoDisqualificationFn: vi.fn(),
}));

// #1580. protects=the console's winner box refreshes right after a set or
// clear instead of waiting for the 5s poll; fails_when=a success does not
// refetch the tally, or a refused write does;
// no_claim=that the refetch returns the new award (server read test).
describe("useMeetingVotes winner refetch (#1580)", () => {
	function setup() {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		);
		return renderHook(
			() =>
				useMeetingVotes({
					meetingId: "m1",
					myId: "me",
					isVoteCounter: true,
					effectiveCanManage: false,
					minutes: { canEdit: false, data: null } as never,
				}),
			{ wrapper },
		);
	}
	beforeEach(() => vi.clearAllMocks());
	afterEach(cleanup);

	const member = { kind: "member" as const, id: "p1" };

	// The observable: with the tally query enabled, a refetch is a second
	// getVoteTally call. Settle the mount fetch first, then count.
	async function settled(result: { current: unknown }) {
		await waitFor(() => expect(getVoteTally).toHaveBeenCalledTimes(1));
		expect(result.current).toBeTruthy();
	}

	it("refetches the tally after a successful set", async () => {
		const { result } = setup();
		await settled(result);
		await act(() => result.current.handleSetVoteWinner("best_speaker", member));
		await waitFor(() => expect(getVoteTally).toHaveBeenCalledTimes(2));
	});

	it("refetches the tally after a successful clear", async () => {
		const { result } = setup();
		await settled(result);
		await act(() => result.current.handleClearVoteWinner("best_speaker"));
		await waitFor(() => expect(getVoteTally).toHaveBeenCalledTimes(2));
	});

	it("does not refetch when a set is refused", async () => {
		setMinutesAward.mockRejectedValueOnce(new Error("no"));
		const { result } = setup();
		await settled(result);
		await act(() => result.current.handleSetVoteWinner("best_speaker", member));
		expect(setMinutesAward).toHaveBeenCalledTimes(1);
		expect(getVoteTally).toHaveBeenCalledTimes(1);
	});

	it("does not refetch when a clear is refused", async () => {
		clearMinutesAward.mockRejectedValueOnce(new Error("no"));
		const { result } = setup();
		await settled(result);
		await act(() => result.current.handleClearVoteWinner("best_speaker"));
		expect(clearMinutesAward).toHaveBeenCalledTimes(1);
		expect(getVoteTally).toHaveBeenCalledTimes(1);
	});
});
