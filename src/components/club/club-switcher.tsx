import { useRouter } from "@tanstack/react-router";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
 * choice server-side, then leaves the page you were on for the club home (#378):
 * most pages are identified by the OLD club (`/club/$clubId/*` has it in the
 * url, `/meetings/$id` and `/members/$id` belong to it, admin routes resolve it
 * through `effectiveAdminClub`), so re-rendering them under a new active club
 * is the "weird things" the issue reports.
 *
 * Hidden entirely while impersonating (#246): `getAuthContext` resolves the
 * active club as `impersonating?.clubId ?? <cookie>`, so the cookie this
 * control writes is ignored for the whole session — picking a club could only
 * ever mislead. Before #378 that was an invisible no-op; now that selecting
 * also navigates, leaving it rendered would throw a superadmin off the page
 * they were working on and still not switch anything.
 */
export function ClubSwitcher({
	clubs,
	activeClubId,
	impersonating = false,
}: {
	clubs: readonly SwitcherClub[];
	activeClubId: string | null;
	impersonating?: boolean;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	const active = clubs.find((c) => c.clubId === activeClubId) ?? clubs[0];
	if (impersonating || clubs.length <= 1 || !active) return null;

	async function choose(clubId: string) {
		if (clubId === active?.clubId) {
			setOpen(false);
			return;
		}
		setBusy(true);
		try {
			await setActiveClub({ data: { clubId } });
			setOpen(false);
			// `/` owns the role-aware landing decision (officer → /officers, else
			// → /roster, #255) — don't duplicate it here. `replace` keeps Back from
			// bouncing the user onto the previous club's page with the new club
			// active, which is the same bug via history.
			await router.navigate({ to: "/", replace: true });
			// Belt-and-braces, and only AFTER the navigation. Invalidating first
			// would re-run the OLD url's loaders under the NEW active club —
			// exactly the bug this fixes.
			//
			// The navigation alone does appear to reload the destination even when
			// the club home IS the page you were already on, via the router's
			// `forceStaleReload` (same-href) branch. But that branch depends on
			// `resolvedLocation`, which a React layout effect advances only once a
			// load settles — timing we neither control nor test. So this is kept
			// deliberately as insurance against a heuristic, not because the
			// reload is known to be missing. Cost is one redundant destination
			// load per switch, on an explicit user action.
			await router.invalidate();
		} catch (err) {
			// #392: without this the rejection escaped into an unhandled promise —
			// `busy` cleared, the popover stayed open, and NOTHING told the user the
			// switch had failed. Since #378 a silent failure reads as "I clicked my
			// other club and stayed exactly where I was", i.e. a dead button. The
			// popover is deliberately left open (the `setOpen(false)` above never
			// ran when the persist is what rejected): the user is still where they
			// were, with the choice still in front of them. Same shape as the other
			// write paths in this app (admin roles, the guest pipeline) — surface
			// the server's own message, fall back to a plain one.
			toast.error(
				err instanceof Error ? err.message : "Couldn't switch clubs.",
			);
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
							// `void`: the handler must not return the promise (#392) —
							// `choose` now owns its own failure, and an unhandled
							// rejection escaping here is what made the dropped test
							// impossible to write.
							onClick={() => {
								void choose(c.clubId);
							}}
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
