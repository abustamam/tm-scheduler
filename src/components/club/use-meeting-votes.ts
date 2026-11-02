import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { setMeetingDigitalVoting } from "#/server/meetings";
import {
	addTableTopics,
	clearMinutesAward,
	type getMinutes,
	moveTableTopics,
	removeTableTopics,
	setMinutesAward,
} from "#/server/minutes";
import type { AwardCategory } from "#/server/minutes-logic";
import { getVoteTally } from "#/server/voting";

/**
 * Plain error text, used by the five Ballot Counter console handlers and the
 * digital-voting switch.
 *
 * Everything else on the meeting page went through `showWriteError` in #761,
 * which adds a "Sign in" action to the two write-proof refusals and is otherwise
 * identical to this. The vote surfaces are deliberately NOT converted: the
 * ballots child issue owns their error display, and doing it here would have it
 * land twice.
 */
function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

type MinutesPayload = Awaited<ReturnType<typeof getMinutes>>;

/**
 * The meeting page's table topics and voting domain (#1476): the Ballot Counter
 * console's writes, the digital-voting switch, and the vote-tally read that
 * feeds the console's speaker list.
 *
 * Takes everything it reads from another domain as a parameter and never calls
 * another `use-meeting-*` hook.
 */
export function useMeetingVotes(args: {
	meetingId: string;
	/** The viewer's resolved member id (session or localStorage pick). */
	myId: string | null;
	isVoteCounter: boolean;
	effectiveCanManage: boolean;
	minutes: MinutesPayload;
}) {
	const { meetingId, myId, isVoteCounter, effectiveCanManage, minutes } = args;
	const router = useRouter();
	// Ballot Counter console (#510 Task 10) — its own Table Topics edits, kept
	// separate from `MeetingMinutes`'s offline queue: the console is reachable
	// even when `minutes.visible` is false (a non-admin Vote Counter on a
	// not-yet-completed meeting), so it cannot ride that component's queue.
	const [voteConsoleBusy, setVoteConsoleBusy] = useState(false);
	const [digitalVotingBusy, setDigitalVotingBusy] = useState(false);

	// The Ballot Counter console's Table Topics list (#510). `getMinutes`'
	// visibility gate is `canEdit || completed`, so it hands back `data: null` —
	// and this list along with it — to a non-admin Vote Counter on any meeting
	// that has not been completed yet. `getVoteTally` is already gated to
	// admin-or-Vote-Counter and now carries the same speaker list (names only,
	// no topic), so that is the source for anyone who cannot read the full
	// minutes. Shares its query key with `VoteCounterPanel`'s own poll — mounting
	// both costs one request, not two.
	const { data: voteTally } = useQuery({
		queryKey: ["vote-tally", meetingId],
		queryFn: () => getVoteTally({ data: { meetingId, selfMemberId: myId } }),
		enabled: isVoteCounter || effectiveCanManage,
		refetchInterval: 5000,
	});
	// Same predicate `<MeetingMinutes>` uses for its own `canEdit` prop — true
	// exactly when `minutes.data` is populated and carries the full,
	// topic-included row (including while an admin is "previewing as member",
	// so the preview reflects what a non-admin Vote Counter would actually see).
	const canReadFullMinutesSpeakers = effectiveCanManage && minutes.canEdit;
	const consoleSpeakers = canReadFullMinutesSpeakers
		? (minutes.data?.tableTopicsSpeakers ?? [])
		: (voteTally?.tableTopicsSpeakers ?? []).map((s) => ({
				id: s.id,
				name: s.name,
				isGuest: s.kind === "guest",
				topic: null,
			}));

	// Ballot Counter console handlers (#510 Task 10). These call the SAME
	// server fns the minutes-edit UI uses (`addTableTopics` / `removeTableTopics`
	// / `moveTableTopics` / `setMinutesAward` / `clearMinutesAward`) — there is
	// no separate voting-aware write path for Table Topics speakers or award
	// winners; only the vote open/close/tally calls (inside `VoteCounterPanel`)
	// go through `voting.ts`. Each carries `selfMemberId: myId` so a non-admin
	// Vote Counter — who may not even be signed in, per the design's "pick your
	// name" self-assert — reaches `requireVoteCounterCapability`'s self-assert
	// path instead of the admin-only `gateAdmin`. Harmless for an admin: their
	// session grants first, before `selfMemberId` is even consulted.
	async function handleAddTableTopicsSpeaker(payload: {
		memberId?: string;
		guestId?: string;
		newGuest?: { name: string };
		topic?: string;
	}) {
		setVoteConsoleBusy(true);
		try {
			await addTableTopics({
				data: { meetingId, selfMemberId: myId, ...payload },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	async function handleRemoveTableTopicsSpeaker(id: string) {
		setVoteConsoleBusy(true);
		try {
			await removeTableTopics({
				data: { meetingId, id, selfMemberId: myId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	async function handleMoveTableTopicsSpeaker(
		id: string,
		direction: "up" | "down",
	) {
		setVoteConsoleBusy(true);
		try {
			await moveTableTopics({
				data: { meetingId, id, direction, selfMemberId: myId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	/** #770. Invalidates rather than patching local state: the switch changes
	 *  what the whole page renders (the vote panel, the deck's vote slides) and
	 *  the loader is what computes `digitalVoting`. */
	async function handleSetDigitalVotingDisabled(disabled: boolean) {
		setDigitalVotingBusy(true);
		try {
			await setMeetingDigitalVoting({
				data: { meetingId, disabled },
			});
			await router.invalidate();
			toast.success(
				disabled
					? "Digital voting is off for this meeting."
					: "Digital voting is back on for this meeting.",
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save that.");
		} finally {
			setDigitalVotingBusy(false);
		}
	}

	async function handleSetVoteWinner(
		category: AwardCategory,
		winner:
			| { kind: "member" | "guest"; id: string }
			| { kind: "writeIn"; name: string },
	) {
		try {
			await setMinutesAward({
				data: {
					meetingId,
					category,
					memberId: winner.kind === "member" ? winner.id : undefined,
					guestId: winner.kind === "guest" ? winner.id : undefined,
					writeInName: winner.kind === "writeIn" ? winner.name : undefined,
					selfMemberId: myId,
				},
			});
			toast.success("Winner set.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		}
	}

	async function handleClearVoteWinner(category: AwardCategory) {
		try {
			await clearMinutesAward({
				data: { meetingId, category, selfMemberId: myId },
			});
			toast.success("Winner cleared.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		}
	}

	return {
		consoleSpeakers,
		voteConsoleBusy,
		digitalVotingBusy,
		handleAddTableTopicsSpeaker,
		handleRemoveTableTopicsSpeaker,
		handleMoveTableTopicsSpeaker,
		handleSetDigitalVotingDisabled,
		handleSetVoteWinner,
		handleClearVoteWinner,
	};
}
