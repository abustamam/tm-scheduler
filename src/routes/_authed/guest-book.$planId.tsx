/**
 * The guest-book confirm page (#806) — where a transcribed page is checked and
 * recorded.
 *
 * `record_guest_book` writes nothing any more. It stores what an LLM read off a
 * photo of the paper guest book and returns a link to here. This page re-plans
 * against live data on every render and every edit, shows the values UNMASKED
 * so they can be checked against the paper, and applies once.
 *
 * Under `_authed`, which is what makes AC6 free: a signed-out visitor is
 * redirected to sign-in with `redirect=` pointing back here, so the link
 * survives the round trip.
 *
 * Every decision — creator-only, the archive gate, expiry, the double-apply
 * guard, what an `McpError` out of the planner renders as — lives in
 * `guest-book-pending-logic.ts`, because a `createServerFn` handler body and a
 * route component are both places a vitest assertion cannot reach. This file
 * renders what it is handed and sends edits back; the only thing it decides is
 * which of the six page states to draw.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmEntriesTable } from "#/components/guest-book/confirm-entries-table";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { formatMeetingDate } from "#/lib/format";
import type {
	PendingEntryEdit,
	PendingEntryField,
} from "#/lib/guest-book-pending";
import {
	applyGuestBookPendingPlan,
	getGuestBookPendingPlan,
	type PendingPlanView,
	patchGuestBookPendingPlan,
} from "#/server/guest-book-pending";

export const Route = createFileRoute("/_authed/guest-book/$planId")({
	loader: ({ params }) =>
		getGuestBookPendingPlan({ data: { pendingId: params.planId } }),
	component: GuestBookConfirm,
});

const CARD =
	"rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-6";

function Shell({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<PageContainer>
			<h1 className="mb-4 font-display text-3xl font-semibold tracking-[-0.02em]">
				{title}
			</h1>
			<div className={CARD}>{children}</div>
		</PageContainer>
	);
}

function GuestBookConfirm() {
	const initial = Route.useLoaderData();
	const [view, setView] = useState<PendingPlanView>(initial);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);

	const draftKey = (id: string, field: PendingEntryField) => `${id}:${field}`;

	async function runEdit(edit: PendingEntryEdit) {
		if (view.status !== "editable") return;
		setBusy(true);
		try {
			const next = await patchGuestBookPendingPlan({
				data: { pendingId: view.pendingId, edit },
			});
			setView(next);
			// The server is the authority on what is stored, so any local draft for
			// the field just saved is discarded rather than reconciled.
			if (edit.kind === "field") {
				setDrafts((d) => {
					const { [draftKey(edit.id, edit.field)]: _gone, ...rest } = d;
					return rest;
				});
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't save that change.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function runApply() {
		if (view.status !== "editable") return;
		setBusy(true);
		try {
			const result = await applyGuestBookPendingPlan({
				data: { pendingId: view.pendingId, planHash: view.planHash },
			});
			setView(result.view);
			if (result.ok && result.applied) {
				const { newGuestIds, matchedGuestIds, attendanceRecorded } =
					result.applied;
				toast.success(
					`Recorded ${attendanceRecorded} visitor${
						attendanceRecorded === 1 ? "" : "s"
					} — ${newGuestIds.length} new, ${matchedGuestIds.length} already on file.`,
				);
			} else if (result.message) {
				// A refusal comes back as data with a fresh plan beside it, never as
				// a thrown error — see `applyPendingPlan`.
				toast.error(result.message);
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't record that page.",
			);
		} finally {
			setBusy(false);
		}
	}

	if (view.status === "not_found") {
		return (
			<Shell title="Not found">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					That confirmation link doesn't point at anything you can open. Ask
					whoever transcribed the page to send you a fresh one.
				</p>
			</Shell>
		);
	}

	if (view.status === "archived") {
		return (
			<Shell title="Club archived">
				<p className="text-sm text-[var(--sea-ink-soft)]">{view.message}</p>
			</Shell>
		);
	}

	if (view.status === "expired") {
		return (
			<Shell title="Link expired">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					This confirmation link expired on {formatMeetingDate(view.expiresAt)}.
					Nothing was recorded — transcribe the page again to get a new link.
				</p>
			</Shell>
		);
	}

	if (view.status === "applied") {
		return (
			<Shell title="Already recorded">
				{/* Carries no visitor data: `entries` was nulled when the write
				    landed, and this state never had any to render. */}
				<p className="text-sm text-[var(--sea-ink-soft)]">
					This page was recorded on {formatMeetingDate(view.appliedAt)}. The
					visitors are on the meeting of {view.meetingDate} in {view.clubName}.
				</p>
			</Shell>
		);
	}

	if (view.status === "unplannable") {
		return (
			<Shell title="Can't record this page yet">
				<p className="text-sm font-semibold text-[var(--sea-ink)]">
					{view.message}
				</p>
				<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
					{view.clubName} · {view.meetingDate} · {view.entries.length} line
					{view.entries.length === 1 ? "" : "s"} transcribed. Nothing has been
					recorded.
				</p>
			</Shell>
		);
	}

	const problems = view.blocking.length;

	return (
		<PageContainer className="space-y-5">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Confirm the guest book
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					{/* The club-LOCAL date, rendered as stored. Running it through
					    `formatMeetingDate` would parse `YYYY-MM-DD` as UTC midnight and
					    re-render it in the reader's own zone, which shows the previous
					    day west of Greenwich — on the one field a transcriber is
					    checking against the paper. */}
					{view.clubName} · meeting of {view.meeting.date}
					{view.meetingNumber ? ` · #${view.meetingNumber}` : ""}
					{view.meeting.theme ? ` · ${view.meeting.theme}` : ""}
				</p>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Check every line against the paper page. Nothing is recorded until you
					press Record.
				</p>
			</div>

			<div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
				<span>
					<strong>{view.summary.new}</strong> new
				</span>
				<span>
					<strong>{view.summary.matched}</strong> already on file
				</span>
				<span>
					<strong>{view.summary.already_present}</strong> already recorded
				</span>
				<span>
					<strong>{view.summary.minutesRecipients}</strong> added to the minutes
					email
				</span>
			</div>

			{view.summary.probablyAlreadyTranscribed ? (
				<p className="text-sm font-semibold text-[var(--sea-ink)]">
					Every line here is already recorded against this meeting — this page
					looks like it was transcribed before.
				</p>
			) : null}

			{/* Blocking items that belong to the call rather than to a line. */}
			{view.blocking
				.filter((b) => !b.entryId)
				.map((b) => (
					<p
						key={b.code}
						className="text-sm font-semibold text-[var(--ember,#a33)]"
					>
						{b.message}
					</p>
				))}

			<ConfirmEntriesTable
				entries={view.entries}
				lines={view.lines}
				blocking={view.blocking}
				busy={busy}
				onEdit={runEdit}
				draft={(id, field) => drafts[draftKey(id, field)]}
				onDraft={(id, field, value) =>
					setDrafts((d) => ({ ...d, [draftKey(id, field)]: value }))
				}
			/>

			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					disabled={busy || problems > 0}
					onClick={runApply}
				>
					{busy ? "Working…" : "Record this page"}
				</Button>
				{problems > 0 ? (
					// "Needs attention", not "needs an answer": a blocking item is as
					// often a misread address to correct as an ambiguity to answer,
					// and only one of the two is a question.
					<span className="text-sm text-[var(--sea-ink-soft)]">
						{problems === 1
							? "1 line still needs attention."
							: `${problems} lines still need attention.`}
					</span>
				) : null}
			</div>
		</PageContainer>
	);
}
