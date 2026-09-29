import { Link } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { MemberContactLinks } from "#/components/members/member-contact-links";
import { Button } from "#/components/ui/button";
import {
	BASE_CAMP_SECTION_HASH,
	type OrientationItem,
	type OrientationMentor,
	type OrientationView,
	PATHWAYS_EXPLAINER_SLUG,
} from "#/lib/orientation";

/** The anchor the "Choose a path" item scrolls to: the dashboard's Pathways
 *  panel, where the path picker lives. */
export const MY_PATHWAYS_ANCHOR = "my-pathways";

export const ORIENTATION_HEADING = "Your first weeks";
export const ORIENTATION_DISMISS_LABEL = "I'm all set";
export const ORIENTATION_LEARN_LABEL = "Learn how Pathways works";

/**
 * New-member orientation (#940): the first-weeks checklist on the member's
 * dashboard.
 *
 * Presentational and controlled: the route owns the server calls and passes
 * the view `orientationView` derived. Renders nothing unless the view says it
 * is visible (in orientation, not dismissed, not complete), so the call site
 * cannot show a finished or dismissed checklist by forgetting a condition.
 *
 * Only the Base Camp item has a checkbox. The others are derived from the
 * club's own records (a path, a speaker slot, another slot, an active
 * new-member mentorship) and carry a link to the place that does the thing
 * instead: ticking them by hand would be the unverifiable self-report the
 * checklist is built to avoid. "Get a mentor" (#939) has no link — an admin
 * makes the pairing — and once done it names the mentor and how to reach them.
 */
export function OrientationChecklist({
	view,
	onToggleBaseCamp,
	onDismiss,
}: {
	view: OrientationView | null;
	onToggleBaseCamp: (done: boolean) => Promise<void>;
	onDismiss: () => Promise<void>;
}) {
	const [busy, setBusy] = useState<"base-camp" | "dismiss" | null>(null);

	if (!view?.visible) return null;

	async function run(which: "base-camp" | "dismiss", fn: () => Promise<void>) {
		setBusy(which);
		try {
			await fn();
		} finally {
			setBusy(null);
		}
	}

	return (
		<section
			aria-labelledby="orientation-heading"
			className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]"
		>
			<div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2.5">
				<h2 id="orientation-heading" className="text-sm font-bold">
					{ORIENTATION_HEADING}
				</h2>
				<span className="text-xs text-[var(--sea-ink-soft)]">
					{view.doneCount} of {view.total} done
				</span>
			</div>
			<ul className="m-0 list-none p-0">
				{view.items.map((item) => (
					<li
						key={item.key}
						data-item={item.key}
						data-done={item.done ? "true" : "false"}
						className="flex items-start gap-3 border-t border-[var(--line)] px-5 py-3"
					>
						{item.selfTick ? (
							<input
								type="checkbox"
								id={`orientation-${item.key}`}
								checked={item.done}
								disabled={busy !== null}
								onChange={(e) => {
									const next = e.currentTarget.checked;
									void run("base-camp", () => onToggleBaseCamp(next));
								}}
								className="mt-0.5 size-4 shrink-0 accent-[var(--lagoon-deep)]"
							/>
						) : (
							<DerivedMark done={item.done} />
						)}
						<div className="min-w-0 flex-1 leading-[1.3]">
							{item.selfTick ? (
								<label
									htmlFor={`orientation-${item.key}`}
									className={itemLabelClass(item.done)}
								>
									{item.label}
								</label>
							) : (
								<span className={itemLabelClass(item.done)}>{item.label}</span>
							)}
							<div className="text-xs text-[var(--sea-ink-soft)]">
								{item.hint}
							</div>
							{item.key === "get-a-mentor" && item.done ? (
								<MentorContacts mentors={view.mentors} />
							) : null}
						</div>
						{item.done ? null : <ItemAction item={item} />}
					</li>
				))}
			</ul>
			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
				<Link
					to="/resources/$slug"
					params={{ slug: PATHWAYS_EXPLAINER_SLUG }}
					className="text-sm font-semibold"
				>
					{ORIENTATION_LEARN_LABEL}
				</Link>
				<Button
					variant="outline"
					size="sm"
					disabled={busy !== null}
					onClick={() => run("dismiss", onDismiss)}
				>
					{busy === "dismiss" ? (
						<Loader2 className="animate-spin" aria-hidden />
					) : null}
					{ORIENTATION_DISMISS_LABEL}
				</Button>
			</div>
		</section>
	);
}

function itemLabelClass(done: boolean): string {
	return done
		? "text-sm font-bold text-[var(--sea-ink-soft)] line-through"
		: "text-sm font-bold text-[var(--sea-ink)]";
}

/** Who the member's new-member mentor is, and how to reach them (#939). */
function MentorContacts({ mentors }: { mentors: OrientationMentor[] }) {
	return (
		<ul
			className="m-0 mt-1.5 list-none space-y-1 p-0"
			data-slot="mentor-contacts"
		>
			{mentors.map((m) => (
				<li
					key={`${m.name}|${m.email ?? ""}|${m.phone ?? ""}`}
					className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs"
				>
					<span className="font-semibold text-[var(--sea-ink)]">
						Your mentor: {m.name}
					</span>
					<MemberContactLinks name={m.name} email={m.email} phone={m.phone} />
				</li>
			))}
		</ul>
	);
}

/** A read-only done mark for a derived item: not a control. */
function DerivedMark({ done }: { done: boolean }) {
	return (
		<span
			role="img"
			aria-label={done ? "Done" : "Not done yet"}
			className={
				done
					? "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--palm)] text-white"
					: "mt-0.5 size-4 shrink-0 rounded-full border border-[var(--line)]"
			}
		>
			{done ? <Check className="size-3" aria-hidden /> : null}
		</span>
	);
}

const ACTION_CLASS = "shrink-0 text-xs font-semibold";

/** Where each unfinished item sends the member. */
function ItemAction({ item }: { item: OrientationItem }) {
	switch (item.key) {
		case "choose-path":
			// The picker is the dashboard's own Pathways panel.
			return (
				<a href={`#${MY_PATHWAYS_ANCHOR}`} className={ACTION_CLASS}>
					Pick a path
				</a>
			);
		case "ice-breaker":
		case "supporting-role":
			return (
				<Link to="/next" className={ACTION_CLASS}>
					Sign up
				</Link>
			);
		case "base-camp":
			return (
				<Link
					to="/resources/$slug"
					params={{ slug: PATHWAYS_EXPLAINER_SLUG }}
					hash={BASE_CAMP_SECTION_HASH}
					className={ACTION_CLASS}
				>
					How to
				</Link>
			);
		case "get-a-mentor":
			// An admin makes the pairing; there is nothing for the member to open.
			return null;
	}
}
