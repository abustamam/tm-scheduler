import { useMemo, useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { PersonPicker } from "#/components/club/person-picker";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { EvaluatorFormBrief } from "#/lib/evaluator-form";
import { type PersonalNudgeBase, personalNudgeUrl } from "#/lib/nudge";
import type { ContactMethod } from "#/lib/preferred-contact";
import type { RoleDuty } from "#/lib/role-duties";

export interface RecruitTarget {
	id: string;
	name: string;
	/** What to call them in a draft, when it isn't the first token of `name`
	 *  (#486). Null ⇒ fall back to that first token. */
	preferredName: string | null;
	phone: string | null;
	email: string | null;
	/** The EFFECTIVE preferred contact (#1093). */
	preferredContact?: ContactMethod | null;
	/** Member has marked themselves Not Available for this meeting. */
	notAvailable: boolean;
	/** Role this member already holds in this meeting, if any. */
	alreadyRole: string | null;
	/** VPE has recorded this member as contacted for this recruiting effort. */
	contacted: boolean;
}

/**
 * Pure annotation of the recruiting pool (#37, Q3): every active member is
 * INCLUDED (never filtered) and flagged — the VPE decides whom to personally
 * ask; the flags only inform. There is no positive "available" flag because the
 * data has no such signal (only "marked unavailable" or silence).
 */
export function buildRecruitTargets(
	roster: {
		id: string;
		name: string;
		preferredName?: string | null;
		phone?: string | null;
		email?: string | null;
		preferredContact?: ContactMethod | null;
	}[],
	unavailableIds: ReadonlySet<string>,
	roleByMemberId: Readonly<Record<string, string>>,
	contactedIds: ReadonlySet<string> = new Set(),
): RecruitTarget[] {
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		preferredName: m.preferredName ?? null,
		phone: m.phone ?? null,
		email: m.email ?? null,
		preferredContact: m.preferredContact ?? null,
		notAvailable: unavailableIds.has(m.id),
		alreadyRole: roleByMemberId[m.id] ?? null,
		contacted: contactedIds.has(m.id),
	}));
}

/**
 * Open-slot recruiting picker (#37). Searchable member list, annotated but never
 * filtered. On pick, shows that member's WhatsApp/Email RECRUIT draft (or the
 * no-contact state). The app drafts; the VPE sends.
 */
export function NudgeRecruitPicker({
	roleName,
	duties,
	evaluating,
	meetingDate,
	shareUrl,
	personalNudgeBase,
	targets,
	onContacted,
	onUncontacted,
}: {
	roleName: string;
	/** What this OPEN role still owes (#667) — already filtered by the registry's
	 *  `done`, so a Toastmaster ask stays quiet about a theme somebody has
	 *  already set. Per-ROLE rather than per-target: nobody holds the slot yet,
	 *  so the only completions that can suppress a clause are the meeting-wide
	 *  ones the caller already resolved. */
	duties?: readonly RoleDuty[];
	/** The speaker an open Evaluator slot evaluates and their form (#1163), from
	 *  `evaluatorFormBrief`. Threaded to the draft; null when no speaker is set. */
	evaluating?: EvaluatorFormBrief | null;
	meetingDate: string;
	shareUrl: string;
	/** Where the draft's personal link points (#667). The `?as=` seed is built
	 *  per PICKED member, which is why this is the base and not a finished URL. */
	personalNudgeBase?: PersonalNudgeBase | null;
	targets: RecruitTarget[];
	/** Mark a member contacted (auto-fired on nudge tap, or manual toggle). `via`
	 *  distinguishes the nudge-draft tap ("nudge") from the manual checkbox
	 *  ("manual") for the activity log. */
	onContacted?: (memberId: string, via: "nudge" | "manual") => void;
	/** Manual toggle only — clear the contacted flag. */
	onUncontacted?: (memberId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<RecruitTarget | null>(null);
	// Unavailable members sort last (rank 1); the matcher orders the rest.
	const people = useMemo(
		() =>
			targets.map((t) => ({
				kind: "member" as const,
				id: t.id,
				name: t.name,
				preferredName: t.preferredName,
				rank: t.notAvailable ? 1 : 0,
				target: t,
			})),
		[targets],
	);
	// `picked` is a point-in-time snapshot from the moment it was selected; once
	// Task 7 wires onContacted/onUncontacted to flip `contacted` upstream (via
	// optimistic update or refetch), `targets` changes but the frozen `picked`
	// object doesn't. Re-derive the live record each render so the open detail
	// panel (in particular the "Contacted" checkbox) reflects the current state
	// instead of going stale until closed and reopened.
	const livePicked = picked
		? (targets.find((t) => t.id === picked.id) ?? picked)
		: null;

	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) setPicked(null);
			}}
		>
			<PopoverTrigger asChild>
				<Button size="sm" variant="outline">
					Nudge someone
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="end">
				{livePicked ? (
					<div className="space-y-2 p-3">
						<div className="text-sm font-semibold">{livePicked.name}</div>
						<NudgeButtons
							name={livePicked.name}
							preferredName={livePicked.preferredName}
							phone={livePicked.phone}
							email={livePicked.email}
							preferredContact={livePicked.preferredContact}
							roleName={roleName}
							duties={duties}
							evaluating={evaluating}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							personalUrl={
								personalNudgeBase
									? personalNudgeUrl(personalNudgeBase, livePicked.id)
									: null
							}
							mode="recruit"
							onContacted={() => onContacted?.(livePicked.id, "nudge")}
						/>
						<label className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={livePicked.contacted}
								onChange={(e) =>
									e.target.checked
										? onContacted?.(livePicked.id, "manual")
										: onUncontacted?.(livePicked.id)
								}
							/>
							Contacted
						</label>
						<Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
							← Back to list
						</Button>
					</div>
				) : (
					<PersonPicker
						people={people}
						placeholder="Search members…"
						emptyText="No members found."
						onPick={(p) => setPicked(p.target)}
						renderMeta={(p) => {
							const t = p.target;
							return (
								<span className="flex items-center">
									{t.notAvailable ? (
										<span className="ml-2 text-xs text-warning-strong">
											Not available
										</span>
									) : null}
									{t.alreadyRole ? (
										<span className="ml-2 text-xs text-muted-foreground">
											Already: {t.alreadyRole}
										</span>
									) : null}
									{t.contacted ? (
										<span className="ml-2 text-xs text-success-strong">
											Contacted
										</span>
									) : null}
									{!t.phone && !t.email ? (
										<span className="ml-2 text-xs text-muted-foreground">
											no contact
										</span>
									) : null}
								</span>
							);
						}}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}
