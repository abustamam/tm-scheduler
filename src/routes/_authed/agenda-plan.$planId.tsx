/**
 * The agenda confirm page (#808) — where a proposed run of agendas is checked
 * and saved.
 *
 * `upsert_agendas` writes nothing. It stores the dates an LLM was asked to set
 * and returns a link to here. This page re-plans against live data on every
 * render, shows the per-date diff, and saves once.
 *
 * Under `_authed`, which is what makes the creator-only rule free to state: a
 * signed-out visitor is redirected to sign-in with `redirect=` pointing back
 * here, so the link survives the round trip.
 *
 * Every decision — creator-only, the archive gate, expiry, the double-apply
 * guard, what a blocked plan renders as — lives in
 * `agenda-plan-pending-logic.ts`, because a server-fn handler body and a route
 * component are both places a vitest assertion cannot reach. This file renders
 * what it is handed; the only thing it decides is which page state to draw.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AgendaDiffTable } from "#/components/agenda-plan/agenda-diff-table";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { formatMeetingDate } from "#/lib/format";
import {
	type AgendaPendingView,
	applyAgendaPendingPlan,
	getAgendaPendingPlan,
} from "#/server/agenda-plan-pending";

export const Route = createFileRoute("/_authed/agenda-plan/$planId")({
	loader: ({ params }) =>
		getAgendaPendingPlan({ data: { pendingId: params.planId } }),
	component: AgendaPlanConfirm,
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

function AgendaPlanConfirm() {
	const initial = Route.useLoaderData();
	const [view, setView] = useState<AgendaPendingView>(initial);
	const [busy, setBusy] = useState(false);

	async function runApply() {
		if (view.status !== "editable") return;
		setBusy(true);
		try {
			const result = await applyAgendaPendingPlan({
				data: { pendingId: view.pendingId, planHash: view.planHash },
			});
			setView(result.view);
			if (result.ok && result.applied) {
				const { created, updated, unchanged } = result.applied;
				toast.success(
					`Saved — ${created} meeting${created === 1 ? "" : "s"} created, ` +
						`${updated} updated${unchanged > 0 ? `, ${unchanged} already matched` : ""}.`,
				);
			} else if (result.message) {
				// A refusal comes back as data with a fresh plan beside it, never as
				// a thrown error — see `applyPendingPlan`.
				toast.error(result.message);
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't save these agendas.",
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
					whoever proposed these agendas to send you a fresh one.
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
					Nothing was saved — ask for the dates again to get a new link.
				</p>
			</Shell>
		);
	}

	if (view.status === "applied") {
		return (
			<Shell title="Already saved">
				<p className="text-sm text-[var(--sea-ink-soft)]">
					These agendas were saved on {formatMeetingDate(view.appliedAt)} in{" "}
					{view.clubName}.
					{view.applied
						? ` ${view.applied.created} meeting${
								view.applied.created === 1 ? "" : "s"
							} created, ${view.applied.updated} updated.`
						: ""}
				</p>
			</Shell>
		);
	}

	if (view.status === "unreadable") {
		return (
			<Shell title="Can't read this plan">
				<p className="text-sm font-semibold text-[var(--sea-ink)]">
					{view.message}
				</p>
				<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
					{view.clubName} · nothing has been saved.
				</p>
			</Shell>
		);
	}

	const problems = view.blocking.length;

	return (
		<PageContainer className="space-y-5">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Confirm these agendas
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					{/* The dates ASKED, not the dates planned — a blocked date is still
					    a row in the table below, and a count that skipped it would
					    read as one the page had dropped. */}
					{view.clubName} · {view.entryCount} date
					{view.entryCount === 1 ? "" : "s"}
				</p>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Check every date before saving. Nothing is written until you press
					Save.
				</p>
			</div>

			{/* Phrased so the number can be 1 without the sentence going wrong.
			    "1 new meetings" and "1 already match" are what the obvious
			    wording gives, and a plan of one date is the common case. */}
			<div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
				<span>
					<strong>{view.summary.created}</strong> to create
				</span>
				<span>
					<strong>{view.summary.updated}</strong> to update
				</span>
				<span>
					<strong>{view.summary.unchanged}</strong> unchanged
				</span>
			</div>

			{/* Blocking items that belong to the call rather than to a date. */}
			{view.blocking
				.filter((b) => b.entryIndex === null)
				.map((b) => (
					<p
						key={b.code}
						className="text-sm font-semibold text-[var(--ember,#a33)]"
					>
						{b.message}
					</p>
				))}

			<AgendaDiffTable
				lines={view.lines}
				blocking={view.blocking}
				meetingNumbers={view.meetingNumbers}
			/>

			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					disabled={busy || problems > 0}
					onClick={runApply}
				>
					{busy ? "Working…" : "Save these agendas"}
				</Button>
				{problems > 0 ? (
					<span className="text-sm text-[var(--sea-ink-soft)]">
						{problems === 1
							? "1 date still needs attention."
							: `${problems} dates still need attention.`}
					</span>
				) : null}
			</div>
		</PageContainer>
	);
}
