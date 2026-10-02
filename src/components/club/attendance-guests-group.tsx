import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AttendanceModeToggle } from "#/components/club/attendance-mode-toggle";
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
import type { AttendanceMode } from "#/lib/attendance-mode";
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
	onSetGuestMode,
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
	/** #1049. The in person / online toggle on each guest. Adding a guest is
	 *  recording them present, and the ROUTE records that add with the meeting's
	 *  default mode, so this group never picks one. Omitted ⇒ no toggle.
	 *  A `fromRole` guest has no attendance row, and pressing theirs creates
	 *  one (maintainer's decision 3 on #1049). */
	onSetGuestMode?: (guestId: string, mode: AttendanceMode) => void;
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
						/* `max-w-full` (#1080 review): the badge is `w-fit shrink-0
						 * whitespace-nowrap`, so without a ceiling it grows to its
						 * content and, as one unwrappable item of the `flex-wrap` row,
						 * overflows the attendance rail whole — measured at 436px in a
						 * 290px rail with a 120-character home club, 399px for a long
						 * name alone, and the card body grows a sideways scrollbar. The
						 * ceiling is what lets the two `truncate` children below give
						 * way; `attendance-guests-group-geometry.test.ts` measures it. */
						className="max-w-full gap-1 py-1 pr-1 pl-2"
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
							 * no layout — the badge is already 24px tall for its sibling.
							 *
							 * `min-w-0` on the button and `truncate` on the visible span
							 * (#1080 review): the badge is now capped at the rail's width,
							 * so a name that does not fit must GIVE WAY rather than push the
							 * toggle and the remove control past the badge's clipped edge
							 * (measured: 28px and 44px over, unreachable). The span's
							 * `truncate` alone is not enough — Chrome sizes a `<button>` to
							 * its content whatever its child's overflow says, so without
							 * `min-w-0` the button never shrinks and the same two controls
							 * clip. The plain-text branch below needs only `truncate`. A
							 * name only truncates once the caption beside it has given up
							 * all of its own room (see the caption's `flex-1`). */
							<button
								type="button"
								onClick={() => setEditingId(g.guestId)}
								className="inline-flex min-h-6 min-w-0 items-center rounded-sm underline decoration-dotted underline-offset-2 hover:decoration-solid"
							>
								<span className="sr-only">Edit {g.name}'s details</span>
								<span aria-hidden className="truncate">
									{g.name}
								</span>
							</button>
						) : (
							<span className="truncate" title={g.name}>
								{g.name}
							</span>
						)}
						{g.caption ? (
							/* The guest's kind caption (#1080) — "Guest speaker, Downtown
							 * Toastmasters" — beside the name, so the rail describes a guest
							 * the way the agenda does (#1059). The string is `loadMinutes`'s,
							 * already one line; nothing is formatted here. OUTSIDE the name
							 * control above: that control's accessible name is the PERSON,
							 * and a club's name is not part of who to tap. Absent for a
							 * Visitor, and for a row from an offline snapshot saved before the
							 * field existed, so both read exactly as before.
							 *
							 * THE ITEM THAT GIVES WAY. A home club runs to GUEST_TEXT_MAX
							 * (120) characters, this badge is `whitespace-nowrap` by design and
							 * its width is capped at the rail's (`max-w-full` above), so
							 * something inside has to yield, and it is this: `flex-1` is
							 * `flex: 1 1 0%`, a basis of ZERO, so the caption contributes
							 * nothing to the shrink phase and takes only what is left after
							 * the name, the toggle and the remove control are content-sized —
							 * 46px of a 797px caption on the 290px desktop rail with the
							 * toggle present, 81px on a phone, the whole caption when it fits.
							 * `truncate` ends it in an ellipsis; without it the text paints on
							 * under the toggle (measured 622px of content in a 288px badge).
							 * Not `shrink`-based: with a basis of `auto` the NAME shrinks in
							 * proportion too, and measured 11px for a 72px name while this
							 * caption kept 119. No `min-w-0`: `truncate` is `overflow: hidden`,
							 * which already makes a flex item's `min-width: auto` zero, and
							 * the class measured byte-identical with and without it. No
							 * `max-w-48`: a cap on a `flex-1` child leaves dead space inside a
							 * wide badge. The separator lives INSIDE the span so a caption cut
							 * to nothing (a long name takes all the room) leaves no orphan dot.
							 * `title` carries the full string for the hover. */
							<span
								className="flex-1 truncate font-normal text-muted-foreground"
								title={g.caption}
							>
								<span aria-hidden>· </span>
								{g.caption}
							</span>
						) : null}
						{onSetGuestMode ? (
							<AttendanceModeToggle
								name={g.name}
								mode={g.mode ?? null}
								disabled={locked}
								onChange={(mode) => onSetGuestMode(g.guestId, mode)}
								className="bg-background"
							/>
						) : null}
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
