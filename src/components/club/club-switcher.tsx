import { useRouter } from "@tanstack/react-router";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { setActiveClub } from "#/server/auth-context";

export interface SwitcherClub {
	clubId: string;
	name: string;
	clubNumber: string | null;
	clubRole: string;
}

/**
 * Header control (issue #10) that lets a member who belongs to several clubs
 * pick which one the workspace acts in. Renders nothing when the user has a
 * single club — the common case needs no chrome. Selecting a club persists the
 * choice server-side, then invalidates the router so every loader re-runs with
 * the new active club (no client-side wrong-club flash on reload).
 */
export function ClubSwitcher({
	clubs,
	activeClubId,
}: {
	clubs: readonly SwitcherClub[];
	activeClubId: string | null;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	const active = clubs.find((c) => c.clubId === activeClubId) ?? clubs[0];
	if (clubs.length <= 1 || !active) return null;

	async function choose(clubId: string) {
		if (clubId === active?.clubId) {
			setOpen(false);
			return;
		}
		setBusy(true);
		try {
			await setActiveClub({ data: { clubId } });
			setOpen(false);
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={busy}
					className="flex max-w-[220px] items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-left text-sm font-semibold text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)] disabled:opacity-60"
				>
					<span className="truncate">{active.name}</span>
					<ChevronsUpDown
						className="size-4 shrink-0 text-[var(--sea-ink-soft)]"
						aria-hidden
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[248px] p-1.5">
				<div className="px-2 pt-1 pb-1.5 text-xs font-extrabold tracking-[0.08em] text-[var(--sea-ink-soft)] uppercase">
					Switch club
				</div>
				{clubs.map((c) => {
					const isActive = c.clubId === active.clubId;
					return (
						<button
							key={c.clubId}
							type="button"
							disabled={busy}
							onClick={() => choose(c.clubId)}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-[var(--foam)] disabled:opacity-60",
								isActive && "bg-[var(--sand)]",
							)}
						>
							<div className="min-w-0 flex-1">
								<div className="truncate font-semibold">{c.name}</div>
								{c.clubNumber ? (
									<div className="text-xs text-[var(--sea-ink-soft)]">
										Club {c.clubNumber}
									</div>
								) : null}
							</div>
							{isActive ? (
								<Check
									className="size-4 shrink-0 text-[var(--lagoon-deep)]"
									aria-hidden
								/>
							) : null}
						</button>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}
