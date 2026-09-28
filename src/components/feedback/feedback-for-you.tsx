import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatMeetingDate } from "#/lib/format";
import type {
	DeleteFeedbackResult,
	FeedbackForUser,
} from "#/server/role-feedback";

/**
 * "Feedback for you" on the dashboard (#986): the anonymous notes left for the
 * viewer (#984), grouped by meeting and then role, with a "N new" badge and a
 * delete on each note.
 *
 * Props-driven, with no server fn imported, so the card renders in vitest and
 * the route supplies the effects. The route module itself cannot be rendered
 * there (it reaches `#/db` through its server fns).
 */

export const FEEDBACK_EMPTY_TEXT =
	"No feedback yet. After your next meeting, anyone in the room can leave you a note.";
export const FEEDBACK_DELETE_CONFIRM = "Delete this note? It can't be undone.";
export const FEEDBACK_LOAD_FAILED_TEXT =
	"Couldn't load your feedback right now. Refresh the page to try again.";
export const FEEDBACK_ALREADY_GONE_TEXT =
	"That note was already deleted, so it has been removed from the list.";

/** The card's data: the read's result, or the read's failure, told apart. */
export type FeedbackCardData = FeedbackForUser & { loadFailed?: boolean };

/** What the card shows when the read fails: a "couldn't load" line, never
 *  "No feedback yet", which would be false, and never a blank dashboard. */
export const FEEDBACK_LOAD_FAILED: FeedbackCardData = {
	meetings: [],
	unseenCount: 0,
	loadFailed: true,
};

/**
 * The dashboard loader's read, with its failure turned into
 * {@link FEEDBACK_LOAD_FAILED}. `listMyFeedback` logs the cause on the server.
 * A love-note read going wrong must never take the rest of the dashboard with
 * it, and a loader that rejects is a blank page. Here rather than inline so it
 * can be exercised: the route cannot be.
 */
export function feedbackOrEmpty(
	read: () => Promise<FeedbackForUser>,
): Promise<FeedbackCardData> {
	try {
		return read().catch(() => FEEDBACK_LOAD_FAILED);
	} catch {
		return Promise.resolve(FEEDBACK_LOAD_FAILED);
	}
}

export interface FeedbackForYouProps {
	feedback: FeedbackCardData;
	/** Delete one note. Resolves with the server's answer; a rejection leaves
	 *  the note on screen. */
	onDelete: (noteId: string) => Promise<DeleteFeedbackResult>;
	/** Called ONCE, after the first render, with the ids of the notes that
	 *  rendered as new. */
	onSeen: (noteIds: string[]) => void;
	/** Reported when a delete fails. */
	onError?: (err: unknown) => void;
	/** Told when a delete found nothing to delete. */
	onNotice?: (message: string) => void;
}

export function FeedbackForYou({
	feedback,
	onDelete,
	onSeen,
	onError,
	onNotice,
}: FeedbackForYouProps) {
	// Which notes were NEW when the card first rendered, frozen for the visit.
	// The loader can re-run mid-visit (any Pathways mark invalidates it), and by
	// then `onSeen` has cleared `seen` on the server — reading the badge from
	// fresh props would make it vanish the moment the person ticks a project.
	// The initializer runs identically on the SSR and hydration passes.
	const [newIds] = useState(
		() =>
			new Set(
				feedback.meetings.flatMap((m) =>
					m.roles.flatMap((r) =>
						r.notes.filter((n) => !n.seen).map((n) => n.id),
					),
				),
			),
	);
	const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
	const [busyId, setBusyId] = useState<string | null>(null);

	const markedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per mount, by design
	useEffect(() => {
		if (markedRef.current) return;
		markedRef.current = true;
		if (newIds.size > 0) onSeen([...newIds]);
	}, []);

	const meetings = feedback.meetings
		.map((m) => ({
			...m,
			roles: m.roles
				.map((r) => ({
					...r,
					notes: r.notes.filter((n) => !deleted.has(n.id)),
				}))
				.filter((r) => r.notes.length > 0),
		}))
		.filter((m) => m.roles.length > 0);
	const newCount = meetings.reduce(
		(sum, m) =>
			sum +
			m.roles.reduce(
				(s, r) => s + r.notes.filter((n) => newIds.has(n.id)).length,
				0,
			),
		0,
	);

	async function remove(noteId: string) {
		if (!window.confirm(FEEDBACK_DELETE_CONFIRM)) return;
		setBusyId(noteId);
		try {
			const { deleted: didDelete } = await onDelete(noteId);
			// `deleted: false` from the server means there was no such note of
			// the caller's to delete. The card only ever lists the caller's own
			// readable notes, so in practice it was already deleted (another tab
			// or device). The honest outcome is the same list the server now
			// holds — the note goes — but SAID, not passed off as this click's
			// doing: a note silently vanishing on a delete that did nothing would
			// read as success whatever had happened.
			setDeleted((prev) => new Set(prev).add(noteId));
			if (!didDelete) onNotice?.(FEEDBACK_ALREADY_GONE_TEXT);
		} catch (err) {
			onError?.(err);
		} finally {
			setBusyId(null);
		}
	}

	return (
		<section
			aria-labelledby="feedback-for-you-heading"
			className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-center justify-between px-5 pt-4 pb-2.5">
				<h2 id="feedback-for-you-heading" className="text-sm font-bold">
					Feedback for you
				</h2>
				{newCount > 0 ? (
					<span
						data-testid="feedback-new-badge"
						className="shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2.5 py-1 text-xs font-bold text-[var(--lagoon-deep)]"
					>
						{newCount} new
					</span>
				) : null}
			</div>
			{feedback.loadFailed ? (
				<p
					data-testid="feedback-load-failed"
					className="border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]"
				>
					{FEEDBACK_LOAD_FAILED_TEXT}
				</p>
			) : meetings.length === 0 ? (
				<p className="border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
					{FEEDBACK_EMPTY_TEXT}
				</p>
			) : (
				meetings.map((m) => (
					<div
						key={m.meetingId}
						data-testid="feedback-meeting"
						className="border-t border-[var(--line)] px-5 py-3"
					>
						<h3 className="text-xs font-bold text-[var(--sea-ink-soft)]">
							{formatMeetingDate(m.meetingDate, m.timezone)} · {m.clubName}
						</h3>
						{m.roles.map((r) => (
							<div key={r.roleLabel} className="mt-2.5">
								<h4 className="text-sm font-bold">
									{r.roleLabel} · {r.notes.length}{" "}
									{r.notes.length === 1 ? "note" : "notes"}
								</h4>
								<ul className="mt-1.5 flex flex-col gap-2">
									{r.notes.map((n) => (
										<li
											key={n.id}
											className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--foam)] px-3.5 py-2.5"
										>
											<div className="min-w-0 flex-1 text-sm">
												{newIds.has(n.id) ? (
													<span className="mb-1 inline-block rounded-full bg-[rgba(79,184,178,.16)] px-2 py-0.5 text-[11px] font-bold text-[var(--lagoon-deep)]">
														New
													</span>
												) : null}
												{n.wentWell ? (
													<p className="break-words">
														<span className="font-semibold">
															What went well:
														</span>{" "}
														{n.wentWell}
													</p>
												) : null}
												{n.tryNext ? (
													<p className="mt-1 break-words">
														<span className="font-semibold">
															One thing to try:
														</span>{" "}
														{n.tryNext}
													</p>
												) : null}
											</div>
											<button
												type="button"
												onClick={() => remove(n.id)}
												disabled={busyId === n.id}
												aria-label="Delete this note"
												className="shrink-0 rounded-lg p-1.5 text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--surface-strong)] hover:text-[var(--sea-ink)] disabled:opacity-50"
											>
												<Trash2 className="size-4" aria-hidden />
											</button>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				))
			)}
		</section>
	);
}
