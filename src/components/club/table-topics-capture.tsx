import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	PersonPicker,
	type PickerPerson,
} from "#/components/club/person-picker";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";

/**
 * The Table Topics speaker list, the add-picker, and the remove/reorder
 * controls — lifted out of `meeting-minutes.tsx` as a pure move (#510 Task 10)
 * so the Ballot Counter console can mount a second, standalone instance
 * directly on the meeting route without going through the full minutes-edit
 * UI (which stays hidden from a non-admin Vote Counter until the meeting is
 * `completed` — see `getMinutes`'s `visible = canEdit || completed` gate).
 *
 * Takes the speaker list as a plain array (not the whole `MinutesData`) so
 * this component carries no dependency on `#/server/minutes` — either
 * mounting site can hand it the same array by different routes.
 */
export function TableTopicsCapture({
	speakers,
	canEdit,
	busy,
	roster,
	unavailableMemberIds,
	clubGuests,
	onAdd,
	onRemove,
	onMove,
}: {
	speakers: {
		id: string;
		name: string;
		isGuest: boolean;
		topic: string | null;
	}[];
	canEdit: boolean;
	busy: boolean;
	roster: { memberId: string; name: string; preferredName?: string | null }[];
	/**
	 * Members `isMemberUnavailable` says cannot take part at this meeting (#1319,
	 * the #1257 rule). REQUIRED, and applied HERE rather than in each mounting
	 * site, so the two pickers cannot drift. They are hidden, not greyed out.
	 */
	unavailableMemberIds: readonly string[];
	clubGuests: {
		id: string;
		name: string;
		preferredName?: string | null;
		stage?: string;
	}[];
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
	const unavailableIds = new Set(unavailableMemberIds);
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
						roster={roster.filter((m) => !unavailableIds.has(m.memberId))}
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

/**
 * Generic member/guest picker popover, moved here alongside `TableTopicsCapture`
 * (its only user until #510) but exported so `meeting-minutes.tsx`'s
 * `AwardsSection` — which stays in that file — can still use it. Not
 * table-topics-specific: it just needs a home, and this is where the first
 * extraction landed it.
 */
export function AssigneePicker({
	label,
	roster,
	clubGuests,
	busy,
	onPick,
}: {
	label: string;
	roster: { memberId: string; name: string; preferredName?: string | null }[];
	clubGuests: {
		id: string;
		name: string;
		preferredName?: string | null;
		stage?: string;
	}[];
	busy: boolean;
	onPick: (payload: {
		memberId?: string;
		guestId?: string;
		newGuest?: { name: string };
	}) => void;
}) {
	const [open, setOpen] = useState(false);
	const people: PickerPerson[] = [
		...roster.map(
			(m): PickerPerson => ({
				kind: "member",
				id: m.memberId,
				name: m.name,
				preferredName: m.preferredName,
			}),
		),
		...clubGuests.map(
			(g): PickerPerson => ({
				kind: "guest",
				id: g.id,
				name: g.name,
				preferredName: g.preferredName,
				stage: g.stage,
			}),
		),
	];
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" size="sm" variant="outline" disabled={busy}>
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 space-y-3">
				<PersonPicker
					people={people}
					disabled={busy}
					placeholder="Search members and guests…"
					emptyText="No matching people."
					onPick={(person) => {
						onPick(
							person.kind === "guest"
								? { guestId: person.id }
								: { memberId: person.id },
						);
						setOpen(false);
					}}
					renderMeta={(person) =>
						person.kind === "guest" ? (
							<Badge variant="outline">Guest</Badge>
						) : null
					}
				/>
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
