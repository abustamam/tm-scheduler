import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Input } from "#/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { MinutesGuestRow } from "#/server/minutes-logic";

/**
 * Roll mode's Guests group. Lifted from the Minutes `AttendanceSection`'s
 * guest half and `GuestAdder` (`src/components/club/meeting-minutes.tsx`) so
 * a later task can delete that section without losing behaviour: an existing
 * club guest is picked by id (no duplicate person created, ADR-0018), a new
 * one carries email/phone alongside the name, and a guest present because
 * they hold a role (`fromRole`) gets no remove control at all — `locked`
 * disables controls, `fromRole` omits one.
 */
export function AttendanceGuestsGroup({
	guests,
	clubGuests,
	locked,
	onAddGuest,
	onRemoveGuest,
}: {
	guests: MinutesGuestRow[];
	clubGuests: { id: string; name: string }[];
	locked: boolean;
	onAddGuest: (payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) => void;
	onRemoveGuest: (guestId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const presentIds = new Set(guests.map((g) => g.guestId));
	const addableClubGuests = clubGuests.filter((g) => !presentIds.has(g.id));

	return (
		<section className="space-y-2">
			<h3 className="font-semibold text-sm">Guests</h3>
			<div className="flex flex-wrap gap-2">
				{guests.map((g) => (
					<Badge
						key={g.guestId}
						variant="secondary"
						className="gap-1 py-1 pr-1 pl-2"
					>
						{g.name}
						{g.fromRole ? null : (
							<button
								type="button"
								aria-label={`Remove ${g.name}`}
								disabled={locked}
								onClick={() => onRemoveGuest(g.guestId)}
								// `disabled:` styling is NOT optional here, unlike on a shadcn
								// `Button` which gets it from `buttonVariants`. This is a bare
								// `<button>`, and its `locked` now folds in the panel's `busy`
								// signal — so without this it is genuinely un-tappable during a
								// write while rendering pixel-identical to tappable, which is a
								// silently swallowed tap in the one window every sibling control
								// dims for.
								//
								// SIZED, not padded. `p-1` around a `size-3` glyph gave a 20px box,
								// under WCAG 2.5.8's 24px minimum on a control tapped on a phone
								// mid-meeting; `size-6` IS that minimum and — unlike padding — stays
								// 24px if the glyph inside it is ever resized, which is how the box
								// came to be 20px in the first place. The flex centring is what keeps
								// the glyph in the middle of the larger box.
								className="inline-flex size-6 items-center justify-center rounded-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
							>
								<X className="size-3" />
							</button>
						)}
					</Badge>
				))}
				{guests.length === 0 ? (
					<span className="text-muted-foreground text-sm">
						No guests recorded.
					</span>
				) : null}
			</div>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button type="button" size="sm" variant="outline" disabled={locked}>
						+ Add guest
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-72 space-y-3">
					{addableClubGuests.length > 0 ? (
						<Command>
							<CommandInput placeholder="Search guests…" />
							<CommandList>
								<CommandEmpty>No matching guests.</CommandEmpty>
								<CommandGroup heading="Existing guests">
									{addableClubGuests.map((g) => (
										<CommandItem
											key={g.id}
											value={`${g.name} ${g.id}`}
											disabled={locked}
											onSelect={() => {
												// Belt as well as braces. `disabled` above is cmdk's,
												// which does remove the select listener rather than
												// merely styling the row — but the guarantee is stated
												// HERE, where the write actually leaves, rather than
												// inherited from a library's internals. Same reason the
												// form below carries one.
												if (locked) return;
												onAddGuest({ guestId: g.id });
												setOpen(false);
											}}
										>
											{g.name}
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</Command>
					) : null}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							// The submit BUTTON is disabled when locked, and browsers do
							// honour that for implicit Enter submission — so this is
							// hardening, not a live bug. It is here because the closure that
							// performs the write should state its own precondition instead of
							// depending on a sibling element's attribute and the HTML spec:
							// `locked` now also carries the offline queue's refuse-while-busy
							// signal (the panel passes `writesLocked || busy`), so "the button
							// is disabled" and "the write will be accepted" are no longer the
							// same question. `preventDefault` first, so a locked submit still
							// does not navigate.
							if (locked) return;
							const form = new FormData(e.currentTarget);
							const name = String(form.get("guestName") ?? "").trim();
							if (!name) {
								toast.error("A guest name is required.");
								return;
							}
							onAddGuest({
								newGuest: {
									name,
									email:
										String(form.get("guestEmail") ?? "").trim() || undefined,
									phone:
										String(form.get("guestPhone") ?? "").trim() || undefined,
								},
							});
							setOpen(false);
						}}
						className="space-y-2"
					>
						<Input
							name="guestName"
							placeholder="New guest name"
							aria-label="New guest name"
							required
						/>
						<div className="grid grid-cols-2 gap-2">
							<Input
								name="guestEmail"
								type="email"
								placeholder="Email"
								aria-label="Guest email"
							/>
							<Input
								name="guestPhone"
								placeholder="Phone"
								aria-label="Guest phone"
							/>
						</div>
						<Button
							type="submit"
							size="sm"
							variant="secondary"
							disabled={locked}
						>
							Add guest
						</Button>
					</form>
				</PopoverContent>
			</Popover>
		</section>
	);
}
