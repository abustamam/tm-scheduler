import { ChevronDown, ChevronUp, Download, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SendMinutesDialog } from "#/components/minutes/send-minutes-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
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
import { useOnlineStatus } from "#/hooks/use-online-status";
import { deriveMinutes } from "#/lib/derive-minutes";
import {
	dispatchOp,
	drainMinutesQueue,
	type MinutesServerFns,
} from "#/lib/drain-minutes";
import {
	enqueue,
	type MinutesOp,
	readQueue,
	readSnapshot,
	removeOp,
	saveSnapshot,
} from "#/lib/offline-minutes-queue";
import {
	addMinutesGuest,
	addTableTopics,
	clearMinutesAward,
	type MinutesResult,
	moveTableTopics,
	removeMinutesGuest,
	removeTableTopics,
	setAttendance,
	setMinutesAward,
} from "#/server/minutes";

type MinutesData = NonNullable<MinutesResult["data"]>;
type AttendanceStatus = "present" | "absent" | "excused";
type AwardCategory = MinutesData["awards"][number]["category"];

const AWARD_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};

const STATUS_LABELS: Record<AttendanceStatus, string> = {
	present: "Present",
	absent: "Absent",
	excused: "Excused",
};

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

export function MeetingMinutes({
	meetingId,
	minutes,
	program,
	meetingPast,
	canEdit,
	clubGuests,
	onMutated,
	email,
}: {
	meetingId: string;
	minutes: MinutesData;
	program: MinutesResult["program"];
	/**
	 * True once the meeting is completed or its date has passed. The Program
	 * section then renders even with zero assignees (the record shows, even if
	 * empty); while false, an all-placeholder Program on a future meeting is
	 * hidden — it would only duplicate the role cards above (#225).
	 */
	meetingPast: boolean;
	canEdit: boolean;
	clubGuests: { id: string; name: string }[];
	onMutated: () => void | Promise<void>;
	/**
	 * Email-the-minutes context (#165), present only for admins on a completed
	 * meeting. Null hides the "Send minutes" control (the PDF still downloads).
	 */
	email?: {
		clubId: string;
		clubName: string;
		meetingDate: Date | string;
		recipients: { name: string; email: string }[];
		skipped: { name: string }[];
	} | null;
}) {
	const [busy, setBusy] = useState(false);

	// #176 slice 3: offline write queue. ONLINE the behaviour below is unchanged
	// (server-fn + onMutated). OFFLINE, edits are captured to a durable IndexedDB
	// queue and the view is derived from the last online snapshot + that queue.
	const online = useOnlineStatus();
	const [queue, setQueue] = useState<MinutesOp[]>([]);
	const [snapshot, setSnapshot] = useState<MinutesData | null>(null);

	// #176 slice 4: reconnect drain. When back online with a pending queue, the
	// queued ops are replayed to the server in order (see `runDrain` below).
	const [draining, setDraining] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	// `draining` state lags a tick, so the drain effect can re-fire before it
	// flips — a synchronous ref blocks a second concurrent drain.
	const drainingRef = useRef(false);
	// `onMutated` is a fresh arrow every render (router.invalidate); stash it in a
	// ref so `runDrain`'s identity stays stable and the drain effect isn't
	// re-triggered on every parent re-render.
	const onMutatedRef = useRef(onMutated);
	onMutatedRef.current = onMutated;

	// Load any persisted snapshot + queue once per meeting (survives reloads).
	useEffect(() => {
		let alive = true;
		void (async () => {
			const [savedQueue, savedSnapshot] = await Promise.all([
				readQueue(meetingId),
				readSnapshot(meetingId),
			]);
			if (!alive) return;
			setQueue(savedQueue);
			setSnapshot(savedSnapshot);
		})();
		return () => {
			alive = false;
		};
	}, [meetingId]);

	// Keep the offline snapshot fresh from every ONLINE render of the loader data.
	useEffect(() => {
		if (!online) return;
		setSnapshot(minutes);
		void saveSnapshot(meetingId, minutes);
	}, [online, minutes, meetingId]);

	// Displayed state: the live loader data online; the optimistic projection off.
	const displayMinutes = useMemo(
		() => (online ? minutes : deriveMinutes(snapshot ?? minutes, queue)),
		[online, minutes, snapshot, queue],
	);

	// #176 slice 4: replay the queued ops to the server IN ORDER, removing each as
	// it lands, then re-fetch authoritative state. Stops at the first failure and
	// keeps the failed op + successors queued for the next reconnect / Retry.
	const runDrain = useCallback(
		async (ops: MinutesOp[]) => {
			if (drainingRef.current || ops.length === 0) return;
			drainingRef.current = true;
			setDraining(true);
			setSyncError(null);
			// Map the component's server-fn imports to the by-op names dispatchOp uses.
			const fns: MinutesServerFns = {
				setAttendance,
				addGuest: addMinutesGuest,
				removeGuest: removeMinutesGuest,
				addTableTopics,
				removeTableTopics,
				moveTableTopics,
				setAward: setMinutesAward,
				clearAward: clearMinutesAward,
			};
			try {
				const result = await drainMinutesQueue({
					meetingId,
					ops,
					dispatch: (op) => dispatchOp(op, meetingId, fns),
					onOpDrained: async (opId) => {
						await removeOp(meetingId, opId);
						setQueue((q) => q.filter((o) => o.opId !== opId));
					},
				});
				if (result.error) {
					// Stop-on-failure: the failed op + successors stay queued.
					setSyncError(errMessage(result.error));
				} else {
					// Everything replayed — re-fetch authoritative state (the online
					// snapshot-save effect then refreshes the offline snapshot).
					await onMutatedRef.current();
				}
			} catch (err) {
				setSyncError(errMessage(err));
			} finally {
				drainingRef.current = false;
				setDraining(false);
			}
		},
		[meetingId],
	);

	// Auto-drain when back online with a pending queue: covers the offline→online
	// transition and an online mount with a leftover queue (e.g. after a reload).
	// Skipped while a drain is in flight (ref guard) or a sync error is showing —
	// a persistent failure would otherwise tight-loop; the user retries explicitly.
	useEffect(() => {
		if (!online || queue.length === 0 || syncError) return;
		void runDrain(queue);
	}, [online, queue, syncError, runDrain]);

	// Going offline clears a stale sync error so the next genuine reconnect
	// auto-retries; while online, a persistent error stays set (see above).
	useEffect(() => {
		if (!online) setSyncError(null);
	}, [online]);

	// ONLINE: run the server-fn and re-fetch (unchanged). OFFLINE: enqueue the op
	// and reflect it optimistically; never hit the server or onMutated.
	async function mutate(
		onlineFn: () => Promise<unknown>,
		makeOp: () => MinutesOp,
	) {
		// `draining` joins the guard so a reconnect drain isn't interleaved with a
		// fresh edit (which could reorder ops). A queue only ever exists after an
		// actual offline session, so `draining` is ALWAYS false for a normal
		// online-only user — their online path (below) is byte-for-byte unchanged.
		if (busy || draining) return;
		if (!online) {
			const op = makeOp();
			setQueue((q) => [...q, op]);
			try {
				await enqueue(meetingId, op);
			} catch (err) {
				toast.error(errMessage(err));
			}
			return;
		}
		setBusy(true);
		try {
			await onlineFn();
			await onMutated();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusy(false);
		}
	}

	const opMeta = () => ({
		opId: crypto.randomUUID(),
		queuedAt: Date.now(),
	});

	const guestName = (guestId: string) =>
		clubGuests.find((g) => g.id === guestId)?.name ?? "Guest";
	const memberName = (memberId: string) =>
		displayMinutes.members.find((m) => m.memberId === memberId)?.name ??
		"Member";

	const pendingCount = online ? 0 : queue.length;

	return (
		<Card>
			<CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
				<div className="space-y-1">
					<CardTitle>Minutes</CardTitle>
					<CardDescription>
						Attendance, Table Topics speakers, and awards — the record of what
						happened.
					</CardDescription>
				</div>
				<div className="flex items-center gap-2">
					<Button asChild variant="outline" size="sm">
						<a
							href={`/api/meetings/${meetingId}/minutes/pdf`}
							target="_blank"
							rel="noopener noreferrer"
						>
							<Download />
							Download PDF
						</a>
					</Button>
					{email ? (
						<SendMinutesDialog
							clubId={email.clubId}
							meetingId={meetingId}
							clubName={email.clubName}
							meetingDate={email.meetingDate}
							initialRecipients={email.recipients}
							skipped={email.skipped}
						/>
					) : null}
				</div>
			</CardHeader>
			<CardContent className="space-y-8">
				{pendingCount > 0 ? (
					<p className="text-muted-foreground text-sm">
						{pendingCount} change{pendingCount === 1 ? "" : "s"} pending locally
						— they'll sync when you're back online.
					</p>
				) : null}
				{draining ? (
					<p className="text-muted-foreground text-sm">
						Syncing {queue.length} change{queue.length === 1 ? "" : "s"}…
					</p>
				) : null}
				{syncError && !draining ? (
					<p className="text-muted-foreground text-sm">
						Couldn't sync changes —{" "}
						<Button
							type="button"
							variant="link"
							size="sm"
							className="h-auto p-0 align-baseline"
							onClick={() => runDrain(queue)}
						>
							Retry
						</Button>
					</p>
				) : null}
				<AttendanceSection
					minutes={displayMinutes}
					canEdit={canEdit}
					busy={busy}
					clubGuests={clubGuests}
					onSetStatus={(memberId, status) =>
						mutate(
							() => setAttendance({ data: { meetingId, memberId, status } }),
							() => ({ type: "setAttendance", ...opMeta(), memberId, status }),
						)
					}
					onAddGuest={(payload) =>
						mutate(
							() => addMinutesGuest({ data: { meetingId, ...payload } }),
							() =>
								payload.newGuest
									? {
											type: "addGuest",
											...opMeta(),
											guestId: crypto.randomUUID(),
											name: payload.newGuest.name,
											newGuest: payload.newGuest,
										}
									: {
											type: "addGuest",
											...opMeta(),
											guestId: payload.guestId as string,
											name: guestName(payload.guestId as string),
										},
						)
					}
					onRemoveGuest={(guestId) =>
						mutate(
							() => removeMinutesGuest({ data: { meetingId, guestId } }),
							() => ({ type: "removeGuest", ...opMeta(), guestId }),
						)
					}
				/>

				<TableTopicsSection
					minutes={displayMinutes}
					canEdit={canEdit}
					busy={busy}
					// Only present members can be added as Table Topics speakers (#170);
					// guests are handled separately by the picker's guest section.
					// Present or unmarked members can be added as Table Topics speakers:
					// unmarked means "not recorded", never absent (#218), so only members
					// explicitly marked absent/excused are filtered out.
					roster={displayMinutes.members.filter(
						(m) => m.status === "present" || m.status === null,
					)}
					clubGuests={clubGuests}
					onAdd={(payload) =>
						mutate(
							() => addTableTopics({ data: { meetingId, ...payload } }),
							() => {
								const isGuest = !payload.memberId;
								const name = payload.memberId
									? memberName(payload.memberId)
									: payload.guestId
										? guestName(payload.guestId)
										: (payload.newGuest?.name ?? "Guest");
								return {
									type: "addTableTopics",
									...opMeta(),
									id: crypto.randomUUID(),
									name,
									isGuest,
									memberId: payload.memberId,
									guestId: payload.guestId,
									newGuest: payload.newGuest,
									topic: payload.topic,
								};
							},
						)
					}
					onRemove={(id) =>
						mutate(
							() => removeTableTopics({ data: { meetingId, id } }),
							() => ({ type: "removeTableTopics", ...opMeta(), id }),
						)
					}
					onMove={(id, direction) =>
						mutate(
							() => moveTableTopics({ data: { meetingId, id, direction } }),
							() => ({ type: "moveTableTopics", ...opMeta(), id, direction }),
						)
					}
				/>

				<AwardsSection
					minutes={displayMinutes}
					canEdit={canEdit}
					busy={busy}
					roster={displayMinutes.members}
					clubGuests={clubGuests}
					onSet={(category, payload) =>
						mutate(
							() =>
								setMinutesAward({ data: { meetingId, category, ...payload } }),
							() => {
								const isGuest = !payload.memberId;
								const name = payload.memberId
									? memberName(payload.memberId)
									: payload.guestId
										? guestName(payload.guestId)
										: (payload.newGuest?.name ?? "Guest");
								return {
									type: "setAward",
									...opMeta(),
									category,
									name,
									isGuest,
									memberId: payload.memberId,
									guestId: payload.guestId,
									newGuest: payload.newGuest,
								};
							},
						)
					}
					onClear={(category) =>
						mutate(
							() => clearMinutesAward({ data: { meetingId, category } }),
							() => ({ type: "clearAward", ...opMeta(), category }),
						)
					}
				/>

				<ProgramSection program={program} meetingPast={meetingPast} />
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

function AttendanceSection({
	minutes,
	canEdit,
	busy,
	clubGuests,
	onSetStatus,
	onAddGuest,
	onRemoveGuest,
}: {
	minutes: MinutesData;
	canEdit: boolean;
	busy: boolean;
	clubGuests: { id: string; name: string }[];
	onSetStatus: (memberId: string, status: AttendanceStatus) => void;
	onAddGuest: (payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) => void;
	onRemoveGuest: (guestId: string) => void;
}) {
	const { present, absent, excused, unmarked, guests } = minutes.counts;
	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="font-semibold text-sm">Attendance</h3>
				<Badge variant="secondary">{present} present</Badge>
				<Badge variant="outline">{excused} excused</Badge>
				<Badge variant="outline">{absent} absent</Badge>
				<Badge variant="outline">{unmarked} unmarked</Badge>
				<Badge variant="secondary">{guests} guests</Badge>
			</div>

			<ul className="divide-y rounded-md border">
				{minutes.members.map((m) => (
					<li
						key={m.memberId}
						className="flex items-center justify-between gap-3 px-3 py-2"
					>
						<span className="text-sm">{m.name}</span>
						{canEdit ? (
							<div className="flex gap-1">
								{(["present", "excused", "absent"] as const).map((s) => (
									<Button
										key={s}
										type="button"
										size="sm"
										variant={m.status === s ? "default" : "outline"}
										disabled={busy}
										onClick={() => onSetStatus(m.memberId, s)}
									>
										{STATUS_LABELS[s]}
									</Button>
								))}
							</div>
						) : (
							<Badge variant={m.status === "present" ? "secondary" : "outline"}>
								{m.status ? STATUS_LABELS[m.status] : "Unmarked"}
							</Badge>
						)}
					</li>
				))}
				{minutes.members.length === 0 ? (
					<li className="px-3 py-2 text-muted-foreground text-sm">
						No active members.
					</li>
				) : null}
			</ul>

			<div className="space-y-2">
				<h4 className="font-medium text-sm">Guests present</h4>
				<div className="flex flex-wrap gap-2">
					{minutes.guests.map((g) => (
						<Badge
							key={g.guestId}
							variant="secondary"
							className="gap-1 py-1 pr-1 pl-2"
						>
							{g.name}
							{canEdit && !g.fromRole ? (
								<button
									type="button"
									aria-label={`Remove ${g.name}`}
									disabled={busy}
									onClick={() => onRemoveGuest(g.guestId)}
									className="rounded-sm hover:bg-muted"
								>
									<X className="size-3" />
								</button>
							) : null}
						</Badge>
					))}
					{minutes.guests.length === 0 ? (
						<span className="text-muted-foreground text-sm">
							No guests recorded.
						</span>
					) : null}
				</div>
				{canEdit ? (
					<GuestAdder clubGuests={clubGuests} busy={busy} onAdd={onAddGuest} />
				) : null}
			</div>
		</section>
	);
}

/** Add a present guest: pick an existing club guest or type a new one. */
function GuestAdder({
	clubGuests,
	busy,
	onAdd,
}: {
	clubGuests: { id: string; name: string }[];
	busy: boolean;
	onAdd: (payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="outline" disabled={busy}>
					+ Add guest
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 space-y-3">
				{clubGuests.length > 0 ? (
					<Command>
						<CommandInput placeholder="Search guests…" />
						<CommandList>
							<CommandEmpty>No matching guests.</CommandEmpty>
							<CommandGroup heading="Existing guests">
								{clubGuests.map((g) => (
									<CommandItem
										key={g.id}
										value={`${g.name} ${g.id}`}
										disabled={busy}
										onSelect={() => {
											onAdd({ guestId: g.id });
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
						const form = new FormData(e.currentTarget);
						const name = String(form.get("guestName") ?? "").trim();
						if (!name) {
							toast.error("A guest name is required.");
							return;
						}
						onAdd({
							newGuest: {
								name,
								email: String(form.get("guestEmail") ?? "").trim() || undefined,
								phone: String(form.get("guestPhone") ?? "").trim() || undefined,
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
					<Button type="submit" size="sm" variant="secondary" disabled={busy}>
						Add guest
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}

// ---------------------------------------------------------------------------
// Table Topics
// ---------------------------------------------------------------------------

function TableTopicsSection({
	minutes,
	canEdit,
	busy,
	roster,
	clubGuests,
	onAdd,
	onRemove,
	onMove,
}: {
	minutes: MinutesData;
	canEdit: boolean;
	busy: boolean;
	roster: { memberId: string; name: string }[];
	clubGuests: { id: string; name: string }[];
	onAdd: (payload: {
		memberId?: string;
		guestId?: string;
		newGuest?: { name: string };
		topic?: string;
	}) => void;
	onRemove: (id: string) => void;
	onMove: (id: string, direction: "up" | "down") => void;
}) {
	const [topic, setTopic] = useState("");
	const speakers = minutes.tableTopicsSpeakers;
	return (
		<section className="space-y-3">
			<h3 className="font-semibold text-sm">Table Topics speakers</h3>
			<ol className="space-y-1">
				{speakers.map((s, i) => (
					<li
						key={s.id}
						className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
					>
						<span className="text-sm">
							<span className="text-muted-foreground">{i + 1}.</span> {s.name}
							{s.isGuest ? (
								<Badge variant="outline" className="ml-2">
									Guest
								</Badge>
							) : null}
							{s.topic ? (
								<span className="text-muted-foreground"> — {s.topic}</span>
							) : null}
						</span>
						{canEdit ? (
							<div className="flex items-center gap-1">
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-7"
									aria-label="Move up"
									disabled={busy || i === 0}
									onClick={() => onMove(s.id, "up")}
								>
									<ChevronUp className="size-4" />
								</Button>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-7"
									aria-label="Move down"
									disabled={busy || i === speakers.length - 1}
									onClick={() => onMove(s.id, "down")}
								>
									<ChevronDown className="size-4" />
								</Button>
								<Button
									type="button"
									size="icon"
									variant="ghost"
									className="size-7"
									aria-label="Remove speaker"
									disabled={busy}
									onClick={() => onRemove(s.id)}
								>
									<X className="size-4" />
								</Button>
							</div>
						) : null}
					</li>
				))}
				{speakers.length === 0 ? (
					<li className="text-muted-foreground text-sm">
						No Table Topics speakers recorded.
					</li>
				) : null}
			</ol>
			{canEdit ? (
				<div className="flex flex-wrap items-center gap-2">
					<Input
						value={topic}
						onChange={(e) => setTopic(e.target.value)}
						placeholder="Topic (optional)"
						aria-label="Table Topics topic"
						className="max-w-xs"
					/>
					<AssigneePicker
						label="+ Add speaker"
						roster={roster}
						clubGuests={clubGuests}
						busy={busy}
						onPick={(payload) => {
							onAdd({ ...payload, topic: topic.trim() || undefined });
							setTopic("");
						}}
					/>
				</div>
			) : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

function AwardsSection({
	minutes,
	canEdit,
	busy,
	roster,
	clubGuests,
	onSet,
	onClear,
}: {
	minutes: MinutesData;
	canEdit: boolean;
	busy: boolean;
	roster: { memberId: string; name: string }[];
	clubGuests: { id: string; name: string }[];
	onSet: (
		category: AwardCategory,
		payload: {
			memberId?: string;
			guestId?: string;
			newGuest?: { name: string };
		},
	) => void;
	onClear: (category: AwardCategory) => void;
}) {
	// Scope each award's picker to the people who took that role this meeting
	// (#170): Best Speaker → speaker-slot holders, Best Evaluator → evaluator-slot
	// holders, Best Table Topics → the recorded Table Topics speakers. Falls back
	// to the full roster when nobody was recorded so an award can always be set.
	function eligibleFor(category: AwardCategory): {
		roster: { memberId: string; name: string }[];
		clubGuests: { id: string; name: string }[];
	} {
		const elig = minutes.awardEligible[category];
		const memberIds = new Set(elig.memberIds);
		const scopedRoster = roster.filter((m) => memberIds.has(m.memberId));

		if (category === "best_table_topics") {
			const guestIds = new Set(elig.guestIds);
			const scopedGuests = clubGuests.filter((g) => guestIds.has(g.id));
			// No Table Topics participants recorded → fall back to everyone.
			if (scopedRoster.length === 0 && scopedGuests.length === 0) {
				return { roster, clubGuests };
			}
			return { roster: scopedRoster, clubGuests: scopedGuests };
		}

		// Speaker / Evaluator: filter members, keep all club guests (guest role
		// data may be incomplete). Fall back to the full roster only if empty.
		return {
			roster: scopedRoster.length > 0 ? scopedRoster : roster,
			clubGuests,
		};
	}

	return (
		<section className="space-y-3">
			<h3 className="font-semibold text-sm">Awards</h3>
			<ul className="space-y-2">
				{minutes.awards.map((a) => (
					<li
						key={a.category}
						className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
					>
						<span className="text-sm">
							<span className="font-medium">{AWARD_LABELS[a.category]}</span>
							{": "}
							{a.name ? (
								<>
									{a.name}
									{a.isGuest ? (
										<Badge variant="outline" className="ml-2">
											Guest
										</Badge>
									) : null}
								</>
							) : (
								<span className="text-muted-foreground">Not set</span>
							)}
						</span>
						{canEdit ? (
							<div className="flex items-center gap-1">
								<AssigneePicker
									label={a.name ? "Change" : "Set"}
									roster={eligibleFor(a.category).roster}
									clubGuests={eligibleFor(a.category).clubGuests}
									busy={busy}
									onPick={(payload) => onSet(a.category, payload)}
								/>
								{a.name ? (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => onClear(a.category)}
									>
										Clear
									</Button>
								) : null}
							</div>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Program (read-only)
// ---------------------------------------------------------------------------

function ProgramSection({
	program,
	meetingPast,
}: {
	program: MinutesResult["program"];
	meetingPast: boolean;
}) {
	// #225: only render once the Program has something to say — someone is on
	// the program, or the meeting is past/completed (the record shows even if
	// empty). A future meeting's all-"—" list duplicates the role cards above.
	const hasAssignee = program.some((p) => p.assigneeName !== null);
	if (program.length === 0 || (!hasAssignee && !meetingPast)) return null;
	return (
		<section className="space-y-2">
			<h3 className="font-semibold text-sm">Program</h3>
			<ul className="space-y-1 text-sm">
				{program.map((p) => (
					<li key={p.slotId} className="flex flex-wrap gap-x-2">
						<span className="font-medium">{p.roleName}:</span>
						<span className="text-muted-foreground">
							{p.assigneeName ?? "—"}
							{p.isGuest ? " (Guest)" : ""}
							{p.speechTitle ? ` — “${p.speechTitle}”` : ""}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Shared member-or-guest picker (a Popover with a searchable member list + a
// guest section, mirroring the assign-slot sheet).
// ---------------------------------------------------------------------------

function AssigneePicker({
	label,
	roster,
	clubGuests,
	busy,
	onPick,
}: {
	label: string;
	roster: { memberId: string; name: string }[];
	clubGuests: { id: string; name: string }[];
	busy: boolean;
	onPick: (payload: {
		memberId?: string;
		guestId?: string;
		newGuest?: { name: string };
	}) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="outline" disabled={busy}>
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 space-y-3">
				<Command>
					<CommandInput placeholder="Search members…" />
					<CommandList>
						<CommandEmpty>No matching people.</CommandEmpty>
						<CommandGroup heading="Members">
							{roster.map((m) => (
								<CommandItem
									key={m.memberId}
									value={`m ${m.name} ${m.memberId}`}
									disabled={busy}
									onSelect={() => {
										onPick({ memberId: m.memberId });
										setOpen(false);
									}}
								>
									{m.name}
								</CommandItem>
							))}
						</CommandGroup>
						{clubGuests.length > 0 ? (
							<CommandGroup heading="Guests">
								{clubGuests.map((g) => (
									<CommandItem
										key={g.id}
										value={`g ${g.name} ${g.id}`}
										disabled={busy}
										onSelect={() => {
											onPick({ guestId: g.id });
											setOpen(false);
										}}
									>
										{g.name}
										<Badge variant="outline" className="ml-auto">
											Guest
										</Badge>
									</CommandItem>
								))}
							</CommandGroup>
						) : null}
					</CommandList>
				</Command>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						const name = String(
							new FormData(e.currentTarget).get("newGuestName") ?? "",
						).trim();
						if (!name) {
							toast.error("A guest name is required.");
							return;
						}
						onPick({ newGuest: { name } });
						setOpen(false);
						e.currentTarget.reset();
					}}
					className="flex gap-2 border-t pt-2"
				>
					<Input
						name="newGuestName"
						placeholder="New guest name"
						aria-label="New guest name"
						className="h-8"
					/>
					<Button type="submit" size="sm" variant="secondary" disabled={busy}>
						Add
					</Button>
				</form>
			</PopoverContent>
		</Popover>
	);
}
