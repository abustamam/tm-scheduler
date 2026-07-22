import { useMemo, useState } from "react";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";

export interface RecruitTarget {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
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
		phone?: string | null;
		email?: string | null;
	}[],
	unavailableIds: ReadonlySet<string>,
	roleByMemberId: Readonly<Record<string, string>>,
	contactedIds: ReadonlySet<string> = new Set(),
): RecruitTarget[] {
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		phone: m.phone ?? null,
		email: m.email ?? null,
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
	meetingDate,
	shareUrl,
	targets,
	onContacted,
	onUncontacted,
}: {
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	targets: RecruitTarget[];
	/** Mark a member contacted (auto-fired on nudge tap, or manual toggle). */
	onContacted?: (memberId: string) => void;
	/** Manual toggle only — clear the contacted flag. */
	onUncontacted?: (memberId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<RecruitTarget | null>(null);
	const sorted = useMemo(
		() => [...targets].sort((a, b) => a.name.localeCompare(b.name)),
		[targets],
	);
	// `picked` is a point-in-time snapshot from the moment it was selected; once
	// Task 7 wires onContacted/onUncontacted to flip `contacted` upstream (via
	// optimistic update or refetch), `targets` changes but the frozen `picked`
	// object doesn't. Re-derive the live record each render so the open detail
	// panel (in particular the "Contacted" checkbox) reflects the current state
	// instead of going stale until closed and reopened.
	const livePicked = picked
		? (sorted.find((t) => t.id === picked.id) ?? picked)
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
							phone={livePicked.phone}
							email={livePicked.email}
							roleName={roleName}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							mode="recruit"
							onContacted={() => onContacted?.(livePicked.id)}
						/>
						<label className="flex items-center gap-2 text-xs">
							<input
								type="checkbox"
								checked={livePicked.contacted}
								onChange={(e) =>
									e.target.checked
										? onContacted?.(livePicked.id)
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
					<Command>
						<CommandInput placeholder="Search members…" />
						<CommandList>
							<CommandEmpty>No members found.</CommandEmpty>
							<CommandGroup>
								{sorted.map((t) => (
									<CommandItem
										key={t.id}
										// Suffix the id so two members with the same name are
										// distinct cmdk values (keyboard selection targets the
										// right one); search still matches on the name.
										value={`${t.name} ${t.id}`}
										onSelect={() => setPicked(t)}
									>
										<span className="flex-1 truncate">{t.name}</span>
										{t.notAvailable ? (
											<span className="ml-2 text-xs text-[var(--warning-strong)]">
												Not available
											</span>
										) : null}
										{t.alreadyRole ? (
											<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
												Already: {t.alreadyRole}
											</span>
										) : null}
										{t.contacted ? (
											<span className="ml-2 text-xs text-[var(--success-strong)]">
												Contacted
											</span>
										) : null}
										{!t.phone && !t.email ? (
											<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
												no contact
											</span>
										) : null}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}
