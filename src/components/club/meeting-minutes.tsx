import {
	AlertTriangle,
	CheckCircle2,
	Download,
	Loader2,
	WifiOff,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AssigneePicker,
	TableTopicsCapture,
} from "#/components/club/table-topics-capture";
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
import { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { deriveMinutes } from "#/lib/derive-minutes";
import { formatCalendarDay } from "#/lib/format";
import type { MinutesActionItems } from "#/server/action-items-logic";
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

type MeetingMinutesProps = {
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
	/**
	 * True once the meeting's club-local DAY has arrived — a LOOSER rule than
	 * `meetingPast`, and the two must not be conflated here. Attendance is taken
	 * AT the meeting, and `meetingPast` (`isMeetingOver`) stays false all through
	 * meeting day, so gating roll call on it would hide the recorder exactly when
	 * it is needed. Same predicate that decides whether a meeting can be
	 * completed at all, and the same one `assertAttendanceRecordable` enforces
	 * server-side — the UI hides what the server would reject.
	 */
	meetingDayReached: boolean;
	canEdit: boolean;
	clubGuests: { id: string; name: string }[];
	/**
	 * The shared offline-write-queue handle (#176). Instantiated ONCE per
	 * meeting by the route (`useOfflineMinutes`) so a second future consumer —
	 * the attendance panel absorbing roll call — shares the same queue/drain
	 * instead of racing a second one (two `draining` flags would replay a
	 * stale status over a newer one, silently). Optional ONLY so this
	 * component's existing unit tests, which render it standalone with no
	 * route-level instance to share, keep working unmodified: omitting it
	 * falls back to a private hook instance scoped to this render (below),
	 * reproducing the pre-extraction behaviour exactly. A real caller (the
	 * route) always supplies it.
	 */
	offline?: ReturnType<typeof useOfflineMinutes>;
	/** Used only by the `offline`-less fallback below. */
	onMutated?: () => void | Promise<void>;
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
};

export function MeetingMinutes(props: MeetingMinutesProps) {
	if (props.offline) {
		return <MeetingMinutesView {...props} offline={props.offline} />;
	}
	return <MeetingMinutesSelfContained {...props} />;
}

/**
 * Standalone fallback for a caller with no shared route-level instance to pass
 * (every existing test in `meeting-minutes.test.tsx`). Instantiates its own
 * private `useOfflineMinutes`, matching this component's behaviour before the
 * hook was extracted — never reachable from the real route, which always
 * supplies `offline` and hits the branch above instead.
 */
function MeetingMinutesSelfContained(
	props: Omit<MeetingMinutesProps, "offline">,
) {
	const offline = useOfflineMinutes({
		meetingId: props.meetingId,
		onMutated: async () => {
			await props.onMutated?.();
		},
		minutes: props.minutes,
	});
	return <MeetingMinutesView {...props} offline={offline} />;
}

function MeetingMinutesView({
	meetingId,
	minutes,
	program,
	meetingPast,
	meetingDayReached,
	canEdit,
	clubGuests,
	offline,
	email,
}: MeetingMinutesProps & { offline: ReturnType<typeof useOfflineMinutes> }) {
	// #176 slice 3-5: the offline write queue, reconnect drain and `mutate`/
	// `opMeta` all live in the shared hook now (`#/hooks/use-offline-minutes`) —
	// see its doc comment for the guards this component used to own directly.
	const {
		mutate,
		opMeta,
		busy,
		queue,
		snapshot,
		draining,
		syncError,
		justSynced,
	} = offline;
	const online = useOnlineStatus();

	// Displayed state: the live loader data online; the optimistic projection off.
	const displayMinutes = useMemo(
		() => (online ? minutes : deriveMinutes(snapshot ?? minutes, queue)),
		[online, minutes, snapshot, queue],
	);

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
						{meetingDayReached
							? "Attendance, Table Topics speakers, and awards — the record of what happened."
							: "Table Topics speakers and awards. Attendance opens on the day."}
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
				<SyncStatus
					online={online}
					pendingCount={pendingCount}
					queueCount={queue.length}
					draining={draining}
					syncError={syncError}
					justSynced={justSynced}
					onRetry={() => offline.retryDrain()}
				/>
				<ActionItemsSection items={displayMinutes.actionItems} />
				{/* Attendance is the RECORD of who was in the room, so it does not
				    exist before the meeting day — `assertAttendanceRecordable` rejects
				    the write, and rendering the recorder anyway would offer buttons
				    that only error. Who is EXPECTED is the separate planned-attendance
				    question (CONTEXT.md), which has no surface here yet.

				    Deliberately `meetingDayReached`, not `meetingPast`: roll call is
				    taken AT the meeting, and `meetingPast` (`isMeetingOver`) is false
				    all through meeting day. */}
				{meetingDayReached ? (
					<AttendanceSection
						minutes={displayMinutes}
						canEdit={canEdit}
						busy={busy}
						clubGuests={clubGuests}
						onSetStatus={(memberId, status) =>
							mutate(
								() => setAttendance({ data: { meetingId, memberId, status } }),
								() => ({
									type: "setAttendance",
									...opMeta(),
									memberId,
									status,
								}),
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
				) : (
					// Say WHY it is missing. A section that silently disappears reads as
					// a bug to the officer who used it last week.
					<section className="space-y-1">
						<h3 className="font-semibold text-sm">Attendance</h3>
						<p className="text-[var(--sea-ink-soft)] text-xs">
							Opens on the day of the meeting — attendance records who was
							actually there.
						</p>
					</section>
				)}

				<TableTopicsCapture
					speakers={displayMinutes.tableTopicsSpeakers}
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
									// Inline new guest: mint its client PK so a drain replay is
									// idempotent (no orphan guest). #176 slice 5.
									newGuestId: payload.newGuest
										? crypto.randomUUID()
										: undefined,
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
									// Inline new guest: mint its client PK so a drain replay is
									// idempotent (no orphan guest). #176 slice 5.
									newGuestId: payload.newGuest
										? crypto.randomUUID()
										: undefined,
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
// Offline sync status (#176 slice 5)
// ---------------------------------------------------------------------------

/**
 * One cohesive indicator for the offline write-queue's sync lifecycle. Purely
 * presentational — it reads the component's `online`/queue/`draining`/`syncError`
 * state and never drives a mutation. States, in priority order:
 *   • syncing  → a spinner + "Syncing N change(s)…"      (a drain is in flight)
 *   • error    → a warning + "Couldn't sync changes" + Retry
 *   • offline  → WifiOff + "N change(s) saved on this device…"
 *   • synced   → a brief "All changes synced" confirmation (auto-dismissed)
 * Online with an empty queue and none of the above → renders nothing (the steady
 * state is invisible).
 */
function SyncStatus({
	online,
	pendingCount,
	queueCount,
	draining,
	syncError,
	justSynced,
	onRetry,
}: {
	online: boolean;
	pendingCount: number;
	queueCount: number;
	draining: boolean;
	syncError: string | null;
	justSynced: boolean;
	onRetry: () => void;
}) {
	if (draining) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
				Syncing {queueCount} change{queueCount === 1 ? "" : "s"}…
			</p>
		);
	}
	if (syncError) {
		return (
			<p className="flex items-center gap-2 text-warning-foreground text-sm">
				<AlertTriangle className="size-4 shrink-0" aria-hidden />
				<span>
					Couldn't sync changes —{" "}
					<Button
						type="button"
						variant="link"
						size="sm"
						className="h-auto p-0 align-baseline text-warning-foreground"
						onClick={onRetry}
					>
						Retry
					</Button>
				</span>
			</p>
		);
	}
	if (!online && pendingCount > 0) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<WifiOff className="size-4 shrink-0" aria-hidden />
				{pendingCount} change{pendingCount === 1 ? "" : "s"} saved on this
				device — will sync when you're back online.
			</p>
		);
	}
	if (justSynced) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
				All changes synced.
			</p>
		);
	}
	return null;
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

/**
 * Club action items as of THIS meeting (#529) — read-only here.
 *
 * Read-only is load-bearing rather than a shortcut: writes live only on the
 * admin route, which keeps action items OUT of the offline minutes queue. That
 * is what lets their write validator REJECT over-long input, where a rejecting
 * cap on a queued op would freeze every later write for the meeting (#525/#526).
 *
 * The lists are reconstructed from timestamps upstream, so this renders the
 * same thing for a past meeting no matter when it is viewed.
 */
function ActionItemsSection({ items }: { items?: MinutesActionItems }) {
	// `items` is typed required on `MinutesData`, but the offline snapshot in
	// IndexedDB is an unversioned `MinutesData` that a PREVIOUS deploy wrote, and
	// `readSnapshot` hands it back without a shape check. Without this guard, the
	// first offline load after this release dereferences `items.open` and
	// white-screens the whole minutes page — for the secretary who just lost
	// signal mid-meeting, which is the one case the offline queue exists for.
	if (!items) return null;
	if (items.open.length === 0 && items.resolved.length === 0) return null;
	return (
		<section className="space-y-3">
			<div>
				<h3 className="font-semibold text-sm">Action items</h3>
				<p className="text-xs text-[var(--sea-ink-soft)]">
					What the club had outstanding at this meeting. Managed under Manage
					&rsaquo; Action items.
				</p>
			</div>
			{items.open.length > 0 ? (
				<ul className="space-y-1.5">
					{items.open.map((i) => (
						<li key={i.id} className="text-sm">
							<span className="font-medium">{i.text}</span>
							{/* An unowned item shows NO owner run. Substituting a name here
							    would read as an owner, and would quietly reassign a departed
							    owner's commitment to the whole club. */}
							{i.ownerName || i.dueDate ? (
								<span className="text-xs text-[var(--sea-ink-soft)]">
									{i.ownerName ? ` · ${i.ownerName}` : ""}
									{i.dueDate ? ` · due ${formatCalendarDay(i.dueDate)}` : ""}
								</span>
							) : null}
						</li>
					))}
					<ElidedNote total={items.openTotal} shown={items.open.length} />
				</ul>
			) : (
				<p className="text-sm text-[var(--sea-ink-soft)]">
					Nothing was outstanding.
				</p>
			)}
			{items.resolved.length > 0 ? (
				<div className="space-y-1.5">
					<h4 className="font-medium text-sm">Closed since the last meeting</h4>
					<ul className="space-y-1">
						{items.resolved.map((i) => (
							<li key={i.id} className="text-sm text-[var(--sea-ink-soft)]">
								<span className="line-through">{i.text}</span>
								{" · "}
								{i.resolution === "dropped" ? "Dropped" : "Done"}
							</li>
						))}
						<ElidedNote
							total={items.resolvedTotal}
							shown={items.resolved.length}
						/>
					</ul>
				</div>
			) : null}
		</section>
	);
}

/**
 * "+N more not shown" when a list was cut, mirroring the minutes PDF.
 *
 * The lists arrive already capped from `loadActionItemsForMinutes`, so this is
 * what stops a bounded render from reading as a complete record.
 */
function ElidedNote({ total, shown }: { total: number; shown: number }) {
	if (total <= shown) return null;
	return (
		<li className="text-xs text-[var(--sea-ink-soft)]">
			+{total - shown} more not shown
		</li>
	);
}
