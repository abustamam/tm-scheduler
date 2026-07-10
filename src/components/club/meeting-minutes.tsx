import { ChevronDown, ChevronUp, Download, X } from "lucide-react";
import { useState } from "react";
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
	canEdit,
	clubGuests,
	onMutated,
	email,
}: {
	meetingId: string;
	minutes: MinutesData;
	program: MinutesResult["program"];
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

	async function run(fn: () => Promise<unknown>) {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
			await onMutated();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusy(false);
		}
	}

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
				<AttendanceSection
					minutes={minutes}
					canEdit={canEdit}
					busy={busy}
					clubGuests={clubGuests}
					onSetStatus={(memberId, status) =>
						run(() => setAttendance({ data: { meetingId, memberId, status } }))
					}
					onAddGuest={(payload) =>
						run(() => addMinutesGuest({ data: { meetingId, ...payload } }))
					}
					onRemoveGuest={(guestId) =>
						run(() => removeMinutesGuest({ data: { meetingId, guestId } }))
					}
				/>

				<TableTopicsSection
					minutes={minutes}
					canEdit={canEdit}
					busy={busy}
					roster={minutes.members}
					clubGuests={clubGuests}
					onAdd={(payload) =>
						run(() => addTableTopics({ data: { meetingId, ...payload } }))
					}
					onRemove={(id) =>
						run(() => removeTableTopics({ data: { meetingId, id } }))
					}
					onMove={(id, direction) =>
						run(() => moveTableTopics({ data: { meetingId, id, direction } }))
					}
				/>

				<AwardsSection
					minutes={minutes}
					canEdit={canEdit}
					busy={busy}
					roster={minutes.members}
					clubGuests={clubGuests}
					onSet={(category, payload) =>
						run(() =>
							setMinutesAward({ data: { meetingId, category, ...payload } }),
						)
					}
					onClear={(category) =>
						run(() => clearMinutesAward({ data: { meetingId, category } }))
					}
				/>

				<ProgramSection program={program} />
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
	const { present, absent, excused, guests } = minutes.counts;
	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="font-semibold text-sm">Attendance</h3>
				<Badge variant="secondary">{present} present</Badge>
				<Badge variant="outline">{excused} excused</Badge>
				<Badge variant="outline">{absent} absent</Badge>
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
								{STATUS_LABELS[m.status]}
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
									roster={roster}
									clubGuests={clubGuests}
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

function ProgramSection({ program }: { program: MinutesResult["program"] }) {
	if (program.length === 0) return null;
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
