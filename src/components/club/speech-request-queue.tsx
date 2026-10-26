import { useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	formatCalendarDay,
	formatMeetingDate,
	formatShortDate,
} from "#/lib/format";
import { isPreferredDay, UNTITLED_REQUEST_LABEL } from "#/lib/speech-requests";
import {
	getSchedulableSpeakerSlots,
	type SpeechQueueRow,
	scheduleRequestedSpeech,
} from "#/server/speech-requests";

/**
 * The VPE's speech-request queue (#1052): open requests, longest-waiting speaker
 * first, then the oldest request. Schedule opens a picker of the club's open
 * speaker slots (a meeting on one of the member's preferred days is marked) and
 * copies the request into the chosen slot's speech. Every action is a server fn
 * behind a club-admin gate; this only shows what they return.
 */
export function SpeechRequestQueue({
	clubId,
	rows,
	timezone,
}: {
	clubId: string;
	rows: SpeechQueueRow[];
	timezone?: string;
}) {
	const [openId, setOpenId] = useState<string | null>(null);
	return (
		<ul data-testid="speech-request-queue">
			{rows.map((row) => (
				<li
					key={row.id}
					className="space-y-2 border-b border-border px-5 py-3 last:border-b-0"
				>
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0 space-y-0.5">
							<div className="text-sm font-bold">{row.memberName}</div>
							<div className="text-sm">
								{row.title ?? (
									<span className="text-muted-foreground">
										{UNTITLED_REQUEST_LABEL}
									</span>
								)}
							</div>
							{row.path || row.projectName ? (
								<div className="text-xs text-muted-foreground">
									{[row.path, row.projectName].filter(Boolean).join(" · ")}
								</div>
							) : null}
							<div className="text-xs text-muted-foreground">
								{row.preferredDates.length > 0
									? `Prefers ${row.preferredDates.map((d) => formatCalendarDay(d)).join(", ")}`
									: "No preferred dates"}
								{" · "}
								{row.lastSpokeAt
									? `last spoke ${formatShortDate(row.lastSpokeAt, timezone)}`
									: "never spoken"}
								{" · "}
								asked {formatShortDate(row.createdAt, timezone)}
							</div>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setOpenId(openId === row.id ? null : row.id)}
						>
							{openId === row.id ? "Close" : "Schedule"}
						</Button>
					</div>
					{openId === row.id ? (
						<SchedulePanel
							clubId={clubId}
							row={row}
							timezone={timezone}
							onDone={() => setOpenId(null)}
						/>
					) : null}
				</li>
			))}
		</ul>
	);
}

type Slot = Awaited<ReturnType<typeof getSchedulableSpeakerSlots>>[number];

function SchedulePanel({
	clubId,
	row,
	timezone,
	onDone,
}: {
	clubId: string;
	row: SpeechQueueRow;
	timezone?: string;
	onDone: () => void;
}) {
	const router = useRouter();
	const [slots, setSlots] = useState<Slot[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [slotId, setSlotId] = useState("");
	const [busy, setBusy] = useState(false);
	const zone = timezone ?? "UTC";

	useEffect(() => {
		let cancelled = false;
		getSchedulableSpeakerSlots({ data: { clubId } })
			.then((found) => {
				if (cancelled) return;
				setSlots(found);
				const preferred = found.find((s) =>
					isPreferredDay(s.scheduledAt, zone, row.preferredDates),
				);
				setSlotId((preferred ?? found[0])?.slotId ?? "");
			})
			.catch((err) => {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Could not load the slots.",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [clubId, row.preferredDates, zone]);

	async function schedule() {
		setBusy(true);
		try {
			await scheduleRequestedSpeech({ data: { requestId: row.id, slotId } });
			toast.success(`Scheduled ${row.memberName}.`);
			onDone();
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	if (error) {
		return (
			<p className="text-sm text-destructive" role="alert">
				{error}
			</p>
		);
	}
	if (slots === null) {
		return <p className="text-sm text-muted-foreground">Loading slots...</p>;
	}
	if (slots.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No open speaker slot on an upcoming meeting.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-2">
			<select
				className="h-8 rounded-md border border-border bg-background px-2 text-sm"
				aria-label={`Slot for ${row.memberName}`}
				value={slotId}
				onChange={(e) => setSlotId(e.target.value)}
			>
				{slots.map((s) => (
					<option key={s.slotId} value={s.slotId}>
						{formatMeetingDate(s.scheduledAt, zone)} · {s.roleName}
						{isPreferredDay(s.scheduledAt, zone, row.preferredDates)
							? " (preferred)"
							: ""}
					</option>
				))}
			</select>
			<Button
				type="button"
				size="sm"
				disabled={busy || !slotId}
				onClick={schedule}
			>
				{busy ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					"Put in this slot"
				)}
			</Button>
		</div>
	);
}
