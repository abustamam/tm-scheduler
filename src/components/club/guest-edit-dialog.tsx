import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	GUEST_CONTACT_REFUSAL_MESSAGES,
	type GuestContactRefusal,
} from "#/lib/guest-contact";
import { isStrandedConvertedGuest } from "#/lib/guest-convert";
import {
	GUEST_KIND_LABELS,
	GUEST_KINDS,
	GUEST_TEXT_MAX,
	type GuestKind,
	profileFieldsChanged,
} from "#/lib/guest-profile";
import { firstNameOf } from "#/lib/person-name";
import { updateGuest } from "#/server/guest-pipeline";
import {
	type GuestProfile,
	getGuestProfile,
	updateGuestProfile,
} from "#/server/guests";

/**
 * The toast when the name and contact saved but the profile write was refused;
 * the refusal's own message follows it.
 */
export const PROFILE_NOT_SAVED_PREFIX =
	"Name and contact saved. Kind, home club and introducer were NOT saved:";

/** The native `<select>`s' look, matching `Input`. */
const SELECT_CLASS =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs md:text-sm dark:bg-input/30";

/**
 * Where the kind / home club / introducer fields stand (#1050). They are read
 * when the dialog OPENS rather than handed in by the caller: the meeting rail
 * has no pipeline row to hand in, and a caller-supplied copy is exactly the
 * stale-field hazard `onSaved` describes — reopen on a stale copy and save,
 * and the previous edit is reverted. A save made while `loading` or after
 * `failed` saves the name and contact and leaves these three alone; it never
 * writes defaults over what is stored, and a slow read never blocks the
 * name/contact edit that worked before these fields existed.
 */
type ProfileState =
	| { status: "loading" }
	| { status: "failed" }
	| { status: "ready"; profile: GuestProfile };

/**
 * Exactly what this form writes, and nothing else (#727).
 *
 * `PipelineGuestRow` is a superset — stage, conversion pointers, derived visit
 * and slot counts — and structurally assignable to this, so VP Membership hands
 * its own row straight in. The meeting rail does NOT have a pipeline row (the
 * meeting payload deliberately carries guests as `{ id, name }`, see
 * `meetings.ts`'s `clubGuests` comment), so narrowing the prop to the five
 * fields the form actually touches is what lets a second caller supply one
 * without inheriting the board's whole shape.
 */
export interface GuestEditFields {
	id: string;
	name: string;
	/** What they're called, when it isn't the first token of `name` (#486). */
	preferredName: string | null;
	email: string | null;
	/**
	 * The stored phone verbatim (the Person's, #1125) — never the display value.
	 *
	 * `PipelineGuestRow` carries the number twice: `phone` is coalesced to E.164
	 * for the card's WhatsApp link, `phoneRaw` is what is stored. Coalescing is a
	 * country-code GUESS, so a guest stored as `"415-555-2671 x12"` displays as
	 * `"+1415555267112"` — a number nobody typed, prefilled into the dialog they
	 * opened to fix a NAME. The field is named `phoneRaw` here so a caller
	 * handing over the coalesced value has to say so.
	 */
	phoneRaw: string | null;
	/**
	 * The pipeline stage and the conversion pointer — NOT written by this form,
	 * carried so the dialog can work out for itself whether this guest has
	 * already joined the roster (see `joined` below).
	 *
	 * They are here rather than as a `joined` PROP because the prop was
	 * droppable and got dropped: VP Membership passed `joined={joined}` and the
	 * meeting rail's call site did not, so a guest who joined at tonight's
	 * meeting — still on tonight's rail, because `applyConvertGuestToMember`
	 * re-points role slots and sets `stage: "joined"` but never touches
	 * `meeting_attendance` — opened a dialog that said "Fix X's name and contact
	 * details" instead of telling the officer they were editing a dead guest row.
	 * A field the type REQUIRES cannot be forgotten at one of two call sites;
	 * a boolean prop with a default can. `PipelineGuestRow` carries both, so VP
	 * Membership's row still assigns straight in.
	 */
	stage: string;
	convertedMembershipId: string | null;
	/**
	 * Why this club may NOT change the contact (#1125), when the caller already
	 * knows: VP Membership's pipeline row carries it, so its fields are read-only
	 * from the first paint. OPTIONAL because the meeting rail has no pipeline row;
	 * the dialog reads the reason fresh when it opens either way
	 * (`GuestProfile.contactRefusal`), and that read wins over this copy.
	 */
	contactRefusal?: GuestContactRefusal | null;
}

/**
 * Fix a guest's name and contact details (#364, lifted to a shared component in
 * #727), and since #1050 their kind, home club and who introduced them. ONE dialog, two call sites: VP Membership's per-guest Edit button and
 * the meeting page's attendance rail.
 *
 * Lifted rather than copied. The form wires four fields across three places that
 * nothing type-checks against each other — the input's `name`, the
 * `form.get(…)` that reads it back, and the `defaultValue` that seeds it — and a
 * mismatch is SILENT and destructive: `form.get` returns null, the handler sends
 * null, and the save wipes the stored value while the form still looks like it
 * works. `goes-by-field.guard.test.ts` guards that wiring in ONE file; a second
 * copy of this form would be a second place for it to rot, unguarded.
 *
 * CONTROLLED (`open` / `onOpenChange`) and trigger-less on purpose. The two call
 * sites open it from completely different affordances — an Edit button in a row
 * of buttons, and a guest's own name in a badge — and a `trigger` prop would be
 * this component growing a flag for each.
 *
 * ## Who may open it
 *
 * The gate is the CALLER's, and it must be a server-resolved capability rather
 * than a local boolean: the meeting page is not under `_authed`. The write
 * itself re-checks — `updateGuest` runs `requireUser()` + `requireClubRole(…,
 * ["admin"])` on every call (`guest-pipeline.ts`) — so a hidden button is not
 * the permission and never was. See the meeting rail's own gate comment for the
 * deliberate gap between the two.
 */
export function GuestEditDialog({
	guest,
	clubId,
	open,
	onOpenChange,
	onSaved,
}: {
	guest: GuestEditFields;
	clubId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Refresh whatever holds this guest's fields OUTSIDE the router's loaders,
	 * awaited before the dialog closes.
	 *
	 * `router.invalidate()` below re-runs route LOADERS and nothing else. VP
	 * Membership's row is loader-fetched, so it needs no more than that. The
	 * meeting rail's is not: its fields come from a TanStack Query cache entry
	 * (`["guest-pipeline", clubId]`), which `router.invalidate()` never touches —
	 * so without this the rail's badge NAME updated (that comes from the meeting
	 * payload) while the dialog kept prefilling the PRE-EDIT email, phone and
	 * goes-by. Reopen and save again and the first edit is silently reverted:
	 * a blank-field save writes `null`, and a stale-field save writes the old
	 * value, which is the same data loss one step further on. That is the exact
	 * hazard `GuestEditCapability` exists to make unrepresentable, and stale rows
	 * do it as surely as absent ones.
	 *
	 * Optional HERE (VP Membership has nothing extra to refresh) and REQUIRED on
	 * `GuestEditCapability`, so a caller that feeds the dialog from a query has
	 * to say how that query gets refreshed. The compiler is the reminder.
	 */
	onSaved?: () => void | Promise<void>;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [profileState, setProfileState] = useState<ProfileState>({
		status: "loading",
	});
	const [kind, setKind] = useState<GuestKind>("visitor");
	const [homeClub, setHomeClub] = useState("");
	const [introducerId, setIntroducerId] = useState("");

	// Fresh on every open, so a second edit starts from what the first saved.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setProfileState({ status: "loading" });
		getGuestProfile({ data: { clubId, guestId: guest.id } })
			.then((profile) => {
				if (cancelled) return;
				if (!profile) {
					setProfileState({ status: "failed" });
					return;
				}
				setKind(profile.kind);
				setHomeClub(profile.homeClub ?? "");
				setIntroducerId(profile.introducedByMemberId ?? "");
				setProfileState({ status: "ready", profile });
			})
			.catch(() => {
				if (!cancelled) setProfileState({ status: "failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [open, clubId, guest.id]);

	// DERIVED here, not passed in — see `GuestEditFields.stage`. This guest has
	// already been converted onto the roster, so the description says which
	// record is being edited: the guest row is still the record of the VISITOR
	// and is always safe to correct (`applyUpdateGuest` allows every stage), but
	// their ROSTER details live on the roster, and someone who opened this to fix
	// a member's email needs telling.
	//
	// STRANDED is not joined (#618): converted once, then the membership was
	// removed from the roster, which nulls `converted_membership_id` and leaves
	// the stage saying `joined` forever. Same predicate VP Membership uses to
	// decide whether to offer Delete, from the same helper, so the two cannot
	// disagree about what "joined" means.
	const joined = guest.stage === "joined" && !isStrandedConvertedGuest(guest);

	// A guest's email and phone are their Person's, and a club may correct them only
	// while the Person is guest-only and has not signed in (#1125). Otherwise the
	// fields show read-only with the reason, so the refusal `updateGuest` throws is
	// normally never reached. The fresh read wins over the caller's copy; until it
	// arrives, the caller's copy (when it has one) holds the fields shut.
	const contactRefusal: GuestContactRefusal | null =
		profileState.status === "ready"
			? (profileState.profile.contactRefusal ?? null)
			: (guest.contactRefusal ?? null);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("name") ?? "").trim();
		if (!name) {
			toast.error("Name is required.");
			return;
		}
		const current = {
			kind,
			homeClub: kind === "visitor" ? null : homeClub.trim() || null,
			introducedByMemberId: introducerId || null,
		};
		setBusy(true);
		try {
			// SEPARATE failure handling per phase, because they fail in different
			// worlds. Wrapping them in one `try` — which this did — fires
			// `toast.success` and then `toast.error` for a single action whenever the
			// refresh rejects, over a write that has already COMMITTED, and leaves
			// the dialog open with no indication which half went wrong.
			try {
				// A contact field is sent ONLY when the officer changed it (#1125). A
				// locked card sends neither, and an untouched field is left out, so the
				// server leaves the stored value alone: a name fix cannot trip the format
				// or clash check on a stored address it never touched, and a stale copy
				// of the card cannot overwrite a value somebody changed since it loaded.
				const emailNow = String(form.get("email") ?? "").trim() || null;
				const phoneNow = String(form.get("phone") ?? "").trim() || null;
				const emailChanged =
					!contactRefusal && emailNow !== ((guest.email ?? "").trim() || null);
				const phoneChanged =
					!contactRefusal &&
					phoneNow !== ((guest.phoneRaw ?? "").trim() || null);
				await updateGuest({
					data: {
						clubId,
						guestId: guest.id,
						name,
						preferredName:
							String(form.get("preferredName") ?? "").trim() || null,
						...(emailChanged ? { email: emailNow } : {}),
						...(phoneChanged ? { phone: phoneNow } : {}),
					},
				});
			} catch (err) {
				// The write itself. This is the user's error to see and act on —
				// `applyUpdateGuest` refuses a phone/email that already belongs to
				// another club guest, and that message names the clash. Stay open so
				// they can fix the field they just typed.
				toast.error(
					err instanceof Error ? err.message : "Something went wrong.",
				);
				return;
			}
			// The kind / home club / introducer: a SECOND write, only when they
			// were read AND the officer changed one of them. Unchanged, it is
			// skipped, so fixing a name typo cannot overwrite a kind or introducer
			// another officer set since this dialog opened. A separate server fn
			// because it has its own validation (the introducer must be on THIS
			// club's roster); both writes are idempotent, so a retry resends both
			// harmlessly.
			let profileError: string | null = null;
			if (
				profileState.status === "ready" &&
				profileFieldsChanged(profileState.profile, current)
			) {
				try {
					await updateGuestProfile({
						data: { clubId, guestId: guest.id, ...current },
					});
				} catch (err) {
					profileError =
						err instanceof Error ? err.message : "Something went wrong.";
				}
			}
			// REFRESH FIRST, CLOSE LAST — both halves matter, and the refresh runs
			// even when the profile write failed: the name and contact COMMITTED,
			// and a view left stale here prefills the old values on the next open,
			// where saving writes them back over the edit that landed.
			//
			// Refresh: `onSaved` covers a caller whose fields live outside the
			// loaders (see its doc), `router.invalidate()` covers the loader-backed
			// ones. Both call sites need the second; only the rail needs the first.
			//
			// Close last, rather than the other way round, because this dialog is
			// MODAL: while it is up nothing behind it is tappable, which is the only
			// in-flight guard the surface has. Closing first re-arms VP Membership's
			// Edit and Delete buttons for the length of the refetch — the window the
			// pre-#727 `busy` flag covered, and the same reasoning
			// `DeclineReleaseDialog` carries on the meeting route ("stays OPEN until
			// the write resolves, with both controls disabled").
			try {
				await onSaved?.();
				await router.invalidate();
			} catch {
				// The write LANDED; this is a stale view, not a failed save, and
				// saying "something went wrong" about a change that is in the database
				// is the more damaging error of the two. Swallowed deliberately: the
				// toast below already tells the truth, and the next navigation or
				// refetch repairs the display.
			}
			if (profileError !== null) {
				// Half saved, and the toast says which half. Stay OPEN on the profile
				// fields so the officer can correct the one that was refused.
				toast.error(`${PROFILE_NOT_SAVED_PREFIX} ${profileError}`);
				return;
			}
			toast.success("Guest updated.");
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit guest</DialogTitle>
					<DialogDescription>
						{joined
							? `Fix ${guest.name}'s guest record. They are already a member — their roster details are edited on the roster.`
							: `Fix ${guest.name}'s name and contact details.`}
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`guest-name-${guest.id}`}>Name</Label>
						<Input
							id={`guest-name-${guest.id}`}
							name="name"
							required
							defaultValue={guest.name}
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-preferred-${guest.id}`}>Goes by</Label>
						<Input
							id={`guest-preferred-${guest.id}`}
							name="preferredName"
							defaultValue={guest.preferredName ?? ""}
							placeholder={firstNameOf(guest.name)}
							aria-describedby={`guest-preferred-hint-${guest.id}`}
						/>
						<p
							id={`guest-preferred-hint-${guest.id}`}
							className="text-xs text-[var(--sea-ink-soft)]"
						>
							Used to greet them in WhatsApp and email drafts. Leave blank to
							use their first name.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-email-${guest.id}`}>Email</Label>
						<Input
							id={`guest-email-${guest.id}`}
							name="email"
							type="email"
							defaultValue={guest.email ?? ""}
							placeholder="name@example.com"
							readOnly={contactRefusal !== null}
							aria-describedby={
								contactRefusal ? `guest-contact-locked-${guest.id}` : undefined
							}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-phone-${guest.id}`}>Phone</Label>
						{/* `phoneRaw`, NOT a coalesced display value — see the field's own
						    doc on `GuestEditFields`. */}
						<Input
							id={`guest-phone-${guest.id}`}
							name="phone"
							type="tel"
							defaultValue={guest.phoneRaw ?? ""}
							readOnly={contactRefusal !== null}
							aria-describedby={
								contactRefusal ? `guest-contact-locked-${guest.id}` : undefined
							}
						/>
						{/* `readOnly`, never `disabled`: a disabled input is left out of the
						    FormData, so `form.get` would send null and the save would CLEAR
						    the contact. A read-only one resends exactly what it shows, which
						    the server treats as "unchanged" and writes nothing. */}
						{contactRefusal ? (
							<p
								id={`guest-contact-locked-${guest.id}`}
								data-slot="guest-contact-locked"
								className="text-xs text-[var(--sea-ink-soft)]"
							>
								{GUEST_CONTACT_REFUSAL_MESSAGES[contactRefusal]}
							</p>
						) : null}
					</div>
					{profileState.status === "ready" ? (
						<>
							<div className="space-y-2">
								<Label htmlFor={`guest-kind-${guest.id}`}>Kind</Label>
								<select
									id={`guest-kind-${guest.id}`}
									className={SELECT_CLASS}
									value={kind}
									onChange={(e) => setKind(e.target.value as GuestKind)}
								>
									{GUEST_KINDS.map((k) => (
										<option key={k} value={k}>
											{GUEST_KIND_LABELS[k]}
										</option>
									))}
								</select>
							</div>
							{/* Only for a Toastmaster from elsewhere: a Visitor has no home
							    club, and the server clears one if it is sent. */}
							{kind === "visitor" ? null : (
								<div className="space-y-2">
									<Label htmlFor={`guest-home-club-${guest.id}`}>
										Home club
									</Label>
									<Input
										id={`guest-home-club-${guest.id}`}
										value={homeClub}
										onChange={(e) => setHomeClub(e.target.value)}
										maxLength={GUEST_TEXT_MAX}
										placeholder="e.g. Laguna Speakers #1234"
									/>
								</div>
							)}
							<div className="space-y-2">
								<Label htmlFor={`guest-introducer-${guest.id}`}>
									Introduced by
								</Label>
								<select
									id={`guest-introducer-${guest.id}`}
									className={SELECT_CLASS}
									value={introducerId}
									onChange={(e) => setIntroducerId(e.target.value)}
								>
									<option value="">Nobody recorded</option>
									{profileState.profile.roster.map((m) => (
										<option key={m.id} value={m.id}>
											{m.status === "inactive"
												? `${m.name} (inactive)`
												: m.name}
										</option>
									))}
								</select>
							</div>
						</>
					) : profileState.status === "loading" ? (
						<p
							data-slot="guest-profile-loading"
							className="text-xs text-[var(--sea-ink-soft)]"
						>
							Loading kind and introducer…
						</p>
					) : (
						<p
							data-slot="guest-profile-failed"
							className="text-xs text-[var(--sea-ink-soft)]"
						>
							Couldn't load this guest's kind and introducer. Saving keeps them
							as they are.
						</p>
					)}
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{busy ? "Saving…" : "Save changes"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
