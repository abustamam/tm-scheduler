import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
	type GuestLinkCandidate,
	type GuestLinkPreview,
	linkGuestAcrossClubs,
	listGuestLinkCandidates,
	previewGuestLink,
} from "#/server/guest-pipeline";

/** One of the viewer's OTHER clubs where they are an admin or an officer. */
export interface OtherAdminClub {
	clubId: string;
	name: string;
}

const SEARCH_DEBOUNCE_MS = 250;

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

/**
 * "Same person as…" (#1175): say that this club's guest and a guest of another
 * club the officer runs are one human.
 *
 * Three steps in one dialog. PICK a guest of the other club (name, email and
 * phone only, never its stage or history: clubs stay blind); CONFIRM against what
 * `previewGuestLink` says the link leaves, or the reason it cannot (no Link
 * button then); then LINK, which sends the preview's `expected` back so the
 * server refuses if either record changed in between.
 */
export function GuestLinkDialog({
	guestId,
	guestName,
	clubId,
	otherClubs,
	open,
	onOpenChange,
}: {
	guestId: string;
	guestName: string;
	clubId: string;
	otherClubs: OtherAdminClub[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const [otherClubId, setOtherClubId] = useState(otherClubs[0]?.clubId ?? "");
	const [query, setQuery] = useState("");
	const [candidates, setCandidates] = useState<GuestLinkCandidate[] | null>(
		null,
	);
	const [picked, setPicked] = useState<GuestLinkCandidate | null>(null);
	const [preview, setPreview] = useState<GuestLinkPreview | null>(null);
	const [busy, setBusy] = useState(false);

	// The chosen club follows the list, which loads after the first render.
	useEffect(() => {
		if (!otherClubs.some((c) => c.clubId === otherClubId)) {
			setOtherClubId(otherClubs[0]?.clubId ?? "");
		}
	}, [otherClubs, otherClubId]);

	function setOpen(next: boolean) {
		onOpenChange(next);
		if (!next) {
			setQuery("");
			setCandidates(null);
			setPicked(null);
			setPreview(null);
		}
	}

	// Loaded when the dialog is open, for the chosen club and the search text:
	// one query per search rather than one per card on the board.
	useEffect(() => {
		if (!open || !otherClubId || picked) return;
		let cancelled = false;
		setCandidates(null);
		const timer = setTimeout(() => {
			listGuestLinkCandidates({
				data: { clubId, guestId, otherClubId, q: query.trim() },
			})
				.then((rows) => {
					if (!cancelled) setCandidates(rows);
				})
				.catch((err: unknown) => {
					if (cancelled) return;
					setCandidates([]);
					toast.error(errorMessage(err, "Couldn't load that club's guests."));
				});
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [open, clubId, guestId, otherClubId, query, picked]);

	async function onPick(candidate: GuestLinkCandidate) {
		setBusy(true);
		try {
			const shown = await previewGuestLink({
				data: {
					clubId,
					guestId,
					otherClubId,
					otherGuestId: candidate.guestId,
				},
			});
			setPicked(candidate);
			setPreview(shown);
		} catch (err) {
			toast.error(errorMessage(err, "Couldn't preview that link."));
		} finally {
			setBusy(false);
		}
	}

	async function onLink() {
		if (!picked || !preview?.ok) return;
		setBusy(true);
		try {
			await linkGuestAcrossClubs({
				data: {
					clubId,
					guestId,
					otherClubId,
					otherGuestId: picked.guestId,
					expected: preview.expected,
				},
			});
			toast.success("Linked.");
			setOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(errorMessage(err, "Couldn't link them."));
			// A stale preview or a changed record: back to the list, not stuck here.
			setPicked(null);
			setPreview(null);
		} finally {
			setBusy(false);
		}
	}

	const otherClubName =
		otherClubs.find((c) => c.clubId === otherClubId)?.name ?? "the other club";

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Same person as…</DialogTitle>
					<DialogDescription>
						Pick who {guestName} is among another club's guests. They become one
						person; each club keeps its own records of them.
					</DialogDescription>
				</DialogHeader>

				{picked && preview ? (
					<div className="space-y-3 text-sm" data-slot="guest-link-confirm">
						{preview.ok ? (
							<p>
								<span className="font-semibold">{guestName}</span> and{" "}
								<span className="font-semibold">{picked.name}</span> become one
								person. Email: {preview.email ?? "none"}. Phone:{" "}
								{preview.phone ?? "none"}. {otherClubName}'s officers will see
								and can edit this email and phone.
							</p>
						) : (
							<p role="alert">{preview.message}</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() => {
									setPicked(null);
									setPreview(null);
								}}
							>
								Back
							</Button>
							{preview.ok ? (
								<Button
									type="button"
									disabled={busy}
									onClick={() => void onLink()}
								>
									{busy ? "Linking…" : "Link"}
								</Button>
							) : null}
						</DialogFooter>
					</div>
				) : (
					<div className="space-y-3">
						{otherClubs.length > 1 ? (
							<select
								aria-label="Club to search"
								value={otherClubId}
								onChange={(e) => setOtherClubId(e.target.value)}
								className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
							>
								{otherClubs.map((c) => (
									<option key={c.clubId} value={c.clubId}>
										{c.name}
									</option>
								))}
							</select>
						) : (
							<p className="text-sm text-muted-foreground">
								From {otherClubName}
							</p>
						)}
						<Input
							placeholder="Search by name or email…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							autoComplete="off"
						/>
						{candidates === null ? (
							<p className="text-muted-foreground flex items-center gap-2 text-sm">
								<Loader2 className="size-4 animate-spin" aria-hidden />
								Loading…
							</p>
						) : candidates.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No guests match in {otherClubName}.
							</p>
						) : (
							<ul className="flex max-h-[40svh] flex-col gap-2 overflow-y-auto">
								{candidates.map((c) => (
									<li key={c.guestId}>
										<button
											type="button"
											disabled={busy}
											onClick={() => void onPick(c)}
											className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:opacity-60"
										>
											<span className="min-w-0">
												<span className="block truncate font-semibold">
													{c.name}
												</span>
												<span className="block truncate text-xs text-muted-foreground">
													{[c.email, c.phone].filter(Boolean).join(" · ") ||
														"No contact"}
												</span>
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
