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
import { Label } from "#/components/ui/label";
import { summarizeMergePreview } from "#/lib/guest-merge-preview";
import {
	listMergeGuestCandidates,
	type MergeGuestCandidate,
	type MergeGuestsPreview,
	mergeGuests,
	previewMergeGuests,
} from "#/server/guest-merge";

const SELECT_CLASS =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs md:text-sm dark:bg-input/30";

function errorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

/**
 * "Merge with another guest…" (#1609): fold one guest record of this club into
 * another. PICK the other record and which of the two to KEEP (the record whose
 * edit dialog was opened is the default); read the PREVIEW, which is the merge
 * itself run inside a transaction that rolls back; then CONFIRM. Irreversible,
 * and the dialog says so. The server asks admin standing and the archive gate
 * again at every call.
 *
 * Not the superadmin's Person merge: two Persons that differ are refused by the
 * server with the reason the preview shows (no confirm button then).
 */
export function GuestMergeDialog({
	guestId,
	guestName,
	clubId,
	open,
	onOpenChange,
	onMerged,
}: {
	guestId: string;
	guestName: string;
	clubId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The merge committed: the caller closes whatever is showing the absorbed record. */
	onMerged: () => void | Promise<void>;
}) {
	const router = useRouter();
	const [candidates, setCandidates] = useState<MergeGuestCandidate[] | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [otherId, setOtherId] = useState("");
	const [keepThis, setKeepThis] = useState(true);
	const [preview, setPreview] = useState<MergeGuestsPreview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [busy, setBusy] = useState(false);

	const other = candidates?.find((c) => c.id === otherId) ?? null;
	const keeperName = keepThis ? guestName : (other?.name ?? "");
	const keepGuestId = keepThis ? guestId : otherId;
	const absorbGuestId = keepThis ? otherId : guestId;

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setCandidates(null);
		setLoadError(null);
		setOtherId("");
		setKeepThis(true);
		setPreview(null);
		listMergeGuestCandidates({ data: { clubId, guestId } })
			.then((rows) => {
				if (!cancelled) setCandidates(rows);
			})
			.catch((err) => {
				if (!cancelled)
					setLoadError(errorMessage(err, "Couldn't load the club's guests."));
			});
		return () => {
			cancelled = true;
		};
	}, [open, clubId, guestId]);

	// The preview is asked again whenever either choice changes.
	useEffect(() => {
		if (!open || !otherId) {
			setPreview(null);
			return;
		}
		let cancelled = false;
		setPreview(null);
		setPreviewing(true);
		previewMergeGuests({
			data: { clubId, keepGuestId, absorbGuestId },
		})
			.then((p) => {
				if (!cancelled) setPreview(p);
			})
			.catch((err) => {
				if (!cancelled) {
					setPreview({
						moved: {},
						droppedAsDuplicate: {},
						absorbedPersonDeleted: false,
						refusal: errorMessage(err, "Couldn't preview this merge."),
					});
				}
			})
			.finally(() => {
				if (!cancelled) setPreviewing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, clubId, otherId, keepGuestId, absorbGuestId]);

	async function confirm() {
		setBusy(true);
		try {
			await mergeGuests({ data: { clubId, keepGuestId, absorbGuestId } });
		} catch (err) {
			toast.error(errorMessage(err, "Something went wrong."));
			setBusy(false);
			return;
		}
		try {
			await router.invalidate();
			await onMerged();
		} catch {
			// The merge LANDED; a stale view is not a failed merge.
		}
		toast.success(`Merged into ${keeperName}.`);
		setBusy(false);
		onOpenChange(false);
	}

	const summary =
		preview && !preview.refusal ? summarizeMergePreview(preview) : null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Merge with another guest</DialogTitle>
					<DialogDescription>
						Fold two records of the same person into one. Everything one record
						holds moves to the one you keep. This cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`guest-merge-other-${guestId}`}>Other record</Label>
						{loadError ? (
							<p data-slot="guest-merge-load-error" className="text-sm">
								{loadError}
							</p>
						) : candidates === null ? (
							<p className="text-xs text-muted-foreground">Loading guests…</p>
						) : (
							<select
								id={`guest-merge-other-${guestId}`}
								className={SELECT_CLASS}
								value={otherId}
								onChange={(e) => setOtherId(e.target.value)}
							>
								<option value="">Choose a guest…</option>
								{candidates.map((c) => (
									<option key={c.id} value={c.id}>
										{c.name}
									</option>
								))}
							</select>
						)}
					</div>
					{other ? (
						<fieldset className="space-y-2">
							<legend className="text-sm font-semibold">
								Keep which record?
							</legend>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name={`guest-merge-keep-${guestId}`}
									checked={keepThis}
									onChange={() => setKeepThis(true)}
								/>
								{guestName}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="radio"
									name={`guest-merge-keep-${guestId}`}
									checked={!keepThis}
									onChange={() => setKeepThis(false)}
								/>
								{other.name}
							</label>
							<p className="text-xs text-muted-foreground">
								The kept record keeps its own name, kind and stage. Blank
								goes-by, home club and introducer are filled from the other.
							</p>
						</fieldset>
					) : null}
					{previewing ? (
						<p
							data-slot="guest-merge-previewing"
							className="flex items-center gap-2 text-xs text-muted-foreground"
						>
							<Loader2 className="size-3 animate-spin" aria-hidden /> Checking
							what would move…
						</p>
					) : null}
					{preview?.refusal ? (
						<p data-slot="guest-merge-refusal" role="alert" className="text-sm">
							{preview.refusal}
						</p>
					) : null}
					{summary ? (
						<div data-slot="guest-merge-preview" className="space-y-1 text-sm">
							{summary.moved.length > 0 ? (
								<>
									<p>Moves to {keeperName}:</p>
									<ul className="list-disc pl-5">
										{summary.moved.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								</>
							) : (
								<p>Nothing else is recorded for the other record.</p>
							)}
							{summary.duplicatesDropped > 0 ? (
								<p className="text-xs text-muted-foreground">
									{summary.duplicatesDropped} same-meeting{" "}
									{summary.duplicatesDropped === 1
										? "duplicate is"
										: "duplicates are"}{" "}
									dropped; {keeperName}'s own record is kept.
								</p>
							) : null}
						</div>
					) : null}
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={
							busy || previewing || !preview || preview.refusal !== null
						}
						onClick={confirm}
					>
						{busy ? "Merging…" : `Merge into ${keeperName || "…"}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
