// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
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
vi.mock("#/server/voting", () => ({
	getVoteTally: vi.fn(async () => ({ tableTopicsSpeakers: [] })),
}));

// #1580. protects=the console's winner box refreshes right after a set or
// clear instead of waiting for the 5s poll; fails_when=a success does not
// invalidate the ["vote-tally", meetingId] key, or a refused write does;
// no_claim=that the refetch returns the new award (server read test).
describe("useMeetingVotes winner refetch (#1580)", () => {
	let spy: ReturnType<typeof vi.spyOn>;
	function setup() {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		spy = vi.spyOn(qc, "invalidateQueries");
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
				}),
			{ wrapper },
		);
	}
	beforeEach(() => vi.clearAllMocks());
	afterEach(cleanup);

	it("invalidates the tally after a successful set and clear", async () => {
		const { result } = setup();
		await act(() =>
			result.current.handleSetVoteWinner("best_speaker", {
				kind: "member",
				id: "p1",
			}),
		);
		expect(spy).toHaveBeenCalledWith({ queryKey: ["vote-tally", "m1"] });
		spy.mockClear();
		await act(() => result.current.handleClearVoteWinner("best_speaker"));
		expect(spy).toHaveBeenCalledWith({ queryKey: ["vote-tally", "m1"] });
	});

	it("does not invalidate when the write is refused", async () => {
		setMinutesAward.mockRejectedValueOnce(new Error("no"));
		const { result } = setup();
		await act(() =>
			result.current.handleSetVoteWinner("best_speaker", {
				kind: "member",
				id: "p1",
			}),
		);
		expect(spy).not.toHaveBeenCalled();
	});
});
