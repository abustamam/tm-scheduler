import { useQuery } from "@tanstack/react-query";
import { FileDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	DEFAULT_WORD_POSTER_COPIES,
	defaultPacketSelection,
	PACKET_PIECES,
	type PacketPieceKey,
	WORD_POSTER_COPIES,
} from "#/lib/meeting-packet";
import { getPacketContext } from "#/server/packet";

/**
 * Pick what goes in the printed meeting packet (#589).
 *
 * The list is CHOSEN rather than fixed because a fixed one prints paper nobody
 * wants — the Ballot Counter tally at a club using digital voting, the General
 * Evaluator notes at a club with no GE — while both are wanted by some other
 * club, so neither can be dropped outright.
 *
 * But the defaults matter more than the picker: a default nobody edits is the
 * default everybody prints. So the boxes start ticked from what the MEETING
 * says (`defaultPacketSelection`), and the user only touches it to disagree.
 * Fetching that context is what the loading state below is for — the dialog
 * deliberately does not render an all-ticked list first and correct itself,
 * which would train people to ignore it.
 */
export function MeetingPacketDialog({
	open,
	onOpenChange,
	dbMeetingId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The meeting's UUID — the packet endpoint is keyed by it, not by the
	 *  club-local date the route uses. */
	dbMeetingId: string;
}) {
	const ctx = useQuery({
		queryKey: ["packet-context", dbMeetingId],
		queryFn: () => getPacketContext({ data: { meetingId: dbMeetingId } }),
		enabled: open,
	});

	const [selection, setSelection] = useState<PacketPieceKey[] | null>(null);
	const [copies, setCopies] = useState(DEFAULT_WORD_POSTER_COPIES);

	// Seed from the derivation once it lands, and only once: re-deriving on every
	// render would undo the user's ticks under them.
	useEffect(() => {
		if (ctx.data && selection == null) {
			setSelection(defaultPacketSelection(ctx.data));
		}
	}, [ctx.data, selection]);

	// Re-derive next time it opens, so a meeting edited in between gets fresh
	// defaults rather than the last session's choices.
	useEffect(() => {
		if (!open) setSelection(null);
	}, [open]);

	const chosen = selection ?? [];
	const toggle = (key: PacketPieceKey) =>
		setSelection((prev) => {
			const cur = prev ?? [];
			return cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
		});

	const params = new URLSearchParams();
	for (const key of chosen) params.append("piece", key);
	if (chosen.includes("word-poster")) params.set("copies", String(copies));
	const href = `/api/meetings/${dbMeetingId}/packet/pdf?${params.toString()}`;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Print meeting packet</DialogTitle>
				</DialogHeader>
				<DialogDescription className="px-1 text-xs">
					One PDF with everything for the night. Ticked from what this meeting
					runs — change anything you like.
				</DialogDescription>

				{ctx.isPending ? (
					<p className="px-1 py-4 text-sm text-muted-foreground">
						Working out what this meeting needs…
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{PACKET_PIECES.map((piece) => (
							<label
								key={piece.key}
								className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm hover:bg-muted"
							>
								<input
									type="checkbox"
									className="size-4"
									checked={chosen.includes(piece.key)}
									onChange={() => toggle(piece.key)}
								/>
								{piece.title}
							</label>
						))}

						{chosen.includes("word-poster") ? (
							<div className="mt-1 flex items-center gap-3 px-2">
								<Label htmlFor="packet-copies" className="text-sm font-normal">
									Poster copies
								</Label>
								<Input
									id="packet-copies"
									type="number"
									min={WORD_POSTER_COPIES.min}
									max={WORD_POSTER_COPIES.max}
									value={copies}
									onChange={(e) => setCopies(Number(e.target.value))}
									className="h-9 w-20"
								/>
								<span className="text-xs text-muted-foreground">
									for around the room
								</span>
							</div>
						) : null}
					</div>
				)}

				<Button asChild disabled={chosen.length === 0} className="mt-2">
					{/* A plain anchor, not a fetch: the browser owns the download, so a
					    slow render shows browser progress rather than a dead dialog. */}
					<a href={href} download>
						<FileDown />
						{chosen.length === 0 ? "Nothing selected" : "Download packet"}
					</a>
				</Button>
			</DialogContent>
		</Dialog>
	);
}
