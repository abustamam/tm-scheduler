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
): RecruitTarget[] {
	return roster.map((m) => ({
		id: m.id,
		name: m.name,
		phone: m.phone ?? null,
		email: m.email ?? null,
		notAvailable: unavailableIds.has(m.id),
		alreadyRole: roleByMemberId[m.id] ?? null,
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
}: {
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	targets: RecruitTarget[];
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<RecruitTarget | null>(null);
	const sorted = useMemo(
		() => [...targets].sort((a, b) => a.name.localeCompare(b.name)),
		[targets],
	);

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
				{picked ? (
					<div className="space-y-2 p-3">
						<div className="text-sm font-semibold">{picked.name}</div>
						<NudgeButtons
							name={picked.name}
							phone={picked.phone}
							email={picked.email}
							roleName={roleName}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							mode="recruit"
						/>
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
										value={t.name}
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
