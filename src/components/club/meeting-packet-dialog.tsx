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
	AGENDA_LAYOUT_HINTS,
	AGENDA_LAYOUT_LABELS,
	AGENDA_LAYOUTS,
	type AgendaLayout,
} from "#/lib/agenda-layouts";
import {
	AGENDA_COPIES,
	clampAgendaCopies,
	DEFAULT_AGENDA_COPIES,
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
 *
 * AGENDAS (#1166). The agenda is the biggest stack of paper on the night and
 * exists only as an HTML print page, which the production image has no Chrome
 * to turn into a PDF, so it is NOT in the PDF: the dialog asks for the copies
 * and opens the print page with the count set. That is two print jobs, and no
 * second copy of any layout to keep in step with the first.
 */
export function MeetingPacketDialog({
	open,
	onOpenChange,
	dbMeetingId,
	clubSlug,
	meetingId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The meeting's UUID — the packet endpoint is keyed by it, not by the
	 *  club-local date the route uses. */
	dbMeetingId: string;
	/** The club's URL key, for the agenda print page's address. */
	clubSlug: string;
	/** The meeting's URL key (date or uuid), likewise. */
	meetingId: string;
}) {
	const ctx = useQuery({
		queryKey: ["packet-context", dbMeetingId],
		queryFn: () => getPacketContext({ data: { meetingId: dbMeetingId } }),
		enabled: open,
	});

	const [selection, setSelection] = useState<PacketPieceKey[] | null>(null);
	const [posterCopies, setPosterCopies] = useState(DEFAULT_WORD_POSTER_COPIES);
	// NaN while the field is empty, which `clampAgendaCopies` reads as the
	// default rather than as 0: clearing the box to retype must not switch the
	// agendas off.
	const [agendaInput, setAgendaInput] = useState(DEFAULT_AGENDA_COPIES);
	const [layoutChoice, setLayoutChoice] = useState<AgendaLayout | null>(null);
	// Ticked by default: the people who open this are mostly printing duplex.
	const [duplex, setDuplex] = useState(true);

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
		if (!open) {
			setSelection(null);
			setLayoutChoice(null);
		}
	}, [open]);

	const chosen = selection ?? [];
	const toggle = (key: PacketPieceKey) =>
		setSelection((prev) => {
			const cur = prev ?? [];
			return cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
		});

	const params = new URLSearchParams();
	for (const key of chosen) params.append("piece", key);
	if (chosen.includes("word-poster"))
		params.set("copies", String(posterCopies));
	if (duplex) params.set("duplex", "1");
	const href = `/api/meetings/${dbMeetingId}/packet/pdf?${params.toString()}`;

	const agendaCopies = clampAgendaCopies(agendaInput);
	const layout: AgendaLayout =
		layoutChoice ?? ctx.data?.defaultPrintLayout ?? "grid";
	const agendaParams = new URLSearchParams({
		layout,
		copies: String(agendaCopies),
	});
	if (duplex) agendaParams.set("duplex", "1");
	const agendaHref = `/club/${encodeURIComponent(clubSlug)}/meeting/${encodeURIComponent(meetingId)}/print?${agendaParams.toString()}`;

	const wantsAgendas = agendaCopies > 0;
	// What one click does, and so what the button says.
	const mode: "both" | "pdf" | "agendas" | "none" =
		chosen.length > 0
			? wantsAgendas
				? "both"
				: "pdf"
			: wantsAgendas
				? "agendas"
				: "none";
	const LABELS = {
		both: "Download packet + open agendas",
		pdf: "Download packet",
		agendas: "Open agendas",
		none: "Nothing selected",
	} as const;
	const label = LABELS[mode];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Print meeting packet</DialogTitle>
				</DialogHeader>
				<DialogDescription className="px-1 text-xs">
					One PDF of role sheets and posters, and the agendas to print beside
					it. Ticked from what this meeting runs — change anything you like.
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
									value={posterCopies}
									onChange={(e) => setPosterCopies(Number(e.target.value))}
									className="h-9 w-20"
								/>
								<span className="text-xs text-muted-foreground">
									for around the room
								</span>
							</div>
						) : null}

						<div className="mt-2 flex flex-col gap-2 border-t px-2 pt-3">
							<div className="flex items-center gap-3">
								<Label
									htmlFor="packet-agenda-copies"
									className="text-sm font-normal"
								>
									Agenda copies
								</Label>
								<Input
									id="packet-agenda-copies"
									type="number"
									min={AGENDA_COPIES.min}
									max={AGENDA_COPIES.max}
									value={Number.isNaN(agendaInput) ? "" : agendaInput}
									onChange={(e) => setAgendaInput(e.target.valueAsNumber)}
									className="h-9 w-20"
								/>
								<span className="text-xs text-muted-foreground">
									0 for none
								</span>
							</div>
							{wantsAgendas ? (
								<fieldset className="flex flex-col gap-1">
									<legend className="sr-only">Agenda layout</legend>
									{AGENDA_LAYOUTS.map((id) => (
										<label
											key={id}
											className="flex cursor-pointer items-center gap-3 rounded px-1 py-1 text-sm hover:bg-muted"
										>
											<input
												type="radio"
												name="packet-agenda-layout"
												className="size-4"
												checked={layout === id}
												onChange={() => setLayoutChoice(id)}
											/>
											<span>
												{AGENDA_LAYOUT_LABELS[id]}
												<span className="ml-2 text-xs text-muted-foreground">
													{AGENDA_LAYOUT_HINTS[id]}
												</span>
											</span>
										</label>
									))}
								</fieldset>
							) : null}
						</div>

						<label className="mt-2 flex cursor-pointer items-start gap-3 rounded px-2 py-2 text-sm hover:bg-muted">
							<input
								type="checkbox"
								className="mt-0.5 size-4"
								checked={duplex}
								onChange={(e) => setDuplex(e.target.checked)}
							/>
							<span>
								Printing double-sided
								<span className="block text-xs text-muted-foreground">
									Adds blank backs so sheets don't share a page. Turn on
									double-sided in your print dialog too.
								</span>
							</span>
						</label>
					</div>
				)}

				{ctx.isPending || mode === "none" ? (
					<Button disabled className="mt-2">
						<FileDown />
						{ctx.isPending ? "Working it out…" : label}
					</Button>
				) : mode !== "agendas" ? (
					<Button asChild className="mt-2">
						{/* A plain anchor, not a fetch: the browser owns the download, so a
						    slow render shows browser progress rather than a dead dialog.
						    The agenda tab opens from this same click, a user gesture, so it
						    is not taken for a popup. */}
						<a
							href={href}
							download
							onClick={() => {
								if (mode === "both")
									window.open(agendaHref, "_blank", "noopener,noreferrer");
							}}
						>
							<FileDown />
							{label}
						</a>
					</Button>
				) : (
					<Button asChild className="mt-2">
						<a href={agendaHref} target="_blank" rel="noopener noreferrer">
							<FileDown />
							{label}
						</a>
					</Button>
				)}
			</DialogContent>
		</Dialog>
	);
}
