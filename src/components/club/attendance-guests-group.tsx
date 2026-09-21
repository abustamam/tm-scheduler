import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	GuestEditDialog,
	type GuestEditFields,
} from "#/components/club/guest-edit-dialog";
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
 * What a viewer needs in order to fix a guest's record from the rail (#727).
 *
 * PRESENT ⇒ the server has already resolved this viewer as able to manage the
 * club. ABSENT ⇒ the names stay plain text; there is deliberately no disabled
 * control hinting at what a viewer cannot do.
 *
 * It carries the DATA as well as the permission, and it has to: the meeting
 * payload projects guests to `{ id, name, stage }` (see `meetings.ts`'s `clubGuests`
 * comment — guest contact has never ridden on this page) and `MinutesGuestRow`
 * carries no contact either. A dialog opened over blank fields does not merely
 * look wrong: the form's handler turns an empty field into `null`, so the first
 * save would WIPE the guest's stored email, phone and goes-by name. Requiring
 * the stored fields to come in with the capability is what makes that
 * unrepresentable rather than a thing to remember.
 */
export interface GuestEditCapability {
	clubId: string;
	/**
	 * The stored, editable fields, keyed by `guestId`. A guest missing from this
	 * map renders as plain text — the same as having no capability at all, and
	 * for the same reason: no row, nothing safe to prefill.
	 *
	 * `Partial<Record<…>>`, not a bare `Record`. `noUncheckedIndexedAccess` is
	 * NOT set in this repo's tsconfig (only `strict`), so a bare `Record` types
	 * every lookup as a present `GuestEditFields` — which makes the absence check
	 * below one the COMPILER believes can never be false, on the guard the whole
	 * design rests on. A later reader is then entitled to delete it as dead code.
	 * `Partial` makes the absence the compiler's business rather than a comment's.
	 */
	fields: Readonly<Partial<Record<string, GuestEditFields>>>;
	/**
	 * Refresh `fields` after a save, awaited before the dialog closes.
	 *
	 * REQUIRED, unlike the dialog's own optional prop. A caller that supplies
	 * this capability is by definition holding the rows somewhere of its own —
	 * `router.invalidate()` cannot reach a TanStack Query cache — so without a
	 * refresher the second save on one guest silently reverts the first. Making
	 * it required means that cannot be forgotten quietly.
	 */
	onSaved: () => void | Promise<void>;
}

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
	guestEdit,
	onAddGuest,
	onRemoveGuest,
}: {
	guests: MinutesGuestRow[];
	clubGuests: { id: string; name: string; stage?: string }[];
	locked: boolean;
	/**
	 * #727. Omitted ⇒ guest names are plain text, which is what every viewer
	 * without the capability sees. The route resolves this; see its own gate
	 * comment for why it is `canManage` and not something computed here.
	 */
	guestEdit?: GuestEditCapability;
	onAddGuest: (payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) => void;
	onRemoveGuest: (guestId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	// The guest whose edit dialog is up, by id — never the row itself. `fields` is
	// refreshed after every save (`guestEdit.onSaved`), so an id re-reads the NEW
	// row on the next open while a captured object would keep rendering the values
	// as they were before the save that closed it.
	const [editingId, setEditingId] = useState<string | null>(null);
	const presentIds = new Set(guests.map((g) => g.guestId));
	const addableClubGuests = clubGuests.filter((g) => !presentIds.has(g.id));
	const editing = editingId ? guestEdit?.fields[editingId] : undefined;

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
						{guestEdit?.fields[g.guestId] ? (
							/* The name IS the control (#727) — a VPM standing in front of a
							 * guest whose name is spelled wrong has nowhere else to click on
							 * this page, and the admin board is three navigations away.
							 *
							 * Deliberately NOT gated on `locked`. That prop is this group's
							 * channel for the offline queue's refuse-while-busy signal (the
							 * panel passes `writesLocked || busy`), and the queue is not on
							 * this write's path at all: `updateGuest` is a direct server fn,
							 * so disabling the name during an unrelated attendance drain
							 * would withhold a control the write side has no objection to.
							 *
							 * The accessible name is COMPOSED FROM CONTENT — an `sr-only`
							 * span, with the visible name `aria-hidden` beside it — never an
							 * `aria-label`, for the reason spelled out at length on the
							 * panel's status trigger: `aria-label` OVERRIDES content, so
							 * labelling this "Edit guest" would take the guest's NAME away
							 * from a screen reader, on a control whose whole job is picking
							 * one person out of several. ONE span carries the whole string,
							 * so nothing depends on how a sibling's `display` computes —
							 * jsdom loads no stylesheet and a real browser does.
							 *
							 * `inline-flex min-h-6`, for the reason the remove control beside
							 * it is `size-6`: WCAG 2.5.8 wants 24px on a control tapped on a
							 * phone mid-meeting, and a bare inline `<button>` is only as tall
							 * as its `text-xs` line box (~16px). `min-h-` alone does nothing
							 * to an inline box, so the display type is half the fix. It costs
							 * no layout — the badge is already 24px tall for its sibling. */
							<button
								type="button"
								onClick={() => setEditingId(g.guestId)}
								className="inline-flex min-h-6 items-center rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid"
							>
								<span className="sr-only">Edit {g.name}'s details</span>
								<span aria-hidden>{g.name}</span>
							</button>
						) : (
							g.name
						)}
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
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					setSearch("");
				}}
			>
				<PopoverTrigger asChild>
					<Button type="button" size="sm" variant="outline" disabled={locked}>
						+ Add guest
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-72 space-y-3">
					{addableClubGuests.length > 0 ? (
						<Command>
							<CommandInput
								placeholder="Search guests…"
								value={search}
								onValueChange={setSearch}
							/>
							<CommandList>
								<CommandEmpty>No matching guests.</CommandEmpty>
								<CommandGroup heading="Existing guests">
									{addableClubGuests
										.filter(
											(g) => g.stage !== "lost" || search.trim().length > 0,
										)
										.map((g) => (
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
			{/* ONE dialog for the whole group — the SAME component VP Membership
			    renders (#727), never a copy. Mounted only while a guest is actually
			    being edited, so a rail nobody has clicked carries no visitor's
			    contact details in the DOM at all.
			    Deliberately NO delete arm: the rail's job is fixing a typo while the
			    person is in the room, and removing someone from THIS meeting is the
			    separate control above. Deleting their record is a VP Membership
			    action and stays there. */}
			{guestEdit && editing ? (
				<GuestEditDialog
					guest={editing}
					clubId={guestEdit.clubId}
					open={true}
					onSaved={guestEdit.onSaved}
					onOpenChange={(next) => {
						if (!next) setEditingId(null);
					}}
				/>
			) : null}
		</section>
	);
}
