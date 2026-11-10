import { Button } from "#/components/ui/button";
import { GUEST_KIND_LABELS, type GuestKind } from "#/lib/guest-profile";
import type { previewEasySpeakImport } from "#/server/history-import";

/**
 * Everyone an Easy-Speak import touches, by name (#1589), in place of a count
 * sentence: who it creates, who it links and how, the guests and the skipped.
 * A new member whose name is likely a roster member's is highlighted with a
 * one-click link. Nothing here gates Apply: the people to decide do, above.
 */

export type PreviewPerson = NonNullable<
	Awaited<ReturnType<typeof previewEasySpeakImport>>
>["people"][number];

type RosterMember = { memberId: string; name: string };

/** How a linked person was matched, in the admin's words. */
export const MATCH_LABELS: Record<string, string> = {
	email: "by email",
	exact: "same name",
	folded: "same name, ignoring accents",
	chosen: "your choice",
	ref: "earlier import",
};

const selectClass =
	"h-8 rounded-md border border-border bg-background px-2 text-sm";

/** The select value that means "make them a new member". */
const NEW_MEMBER = "__new";

type GroupId = "active" | "former" | "linked" | "guests" | "skipped";

const GROUPS: Array<{ id: GroupId; title: string; open: boolean }> = [
	{ id: "active", title: "New members, active", open: true },
	{ id: "former", title: "New members, former", open: false },
	{ id: "linked", title: "Linked to existing members", open: false },
	{ id: "guests", title: "Guests", open: false },
	{ id: "skipped", title: "Skipped", open: false },
];

/**
 * The group a person shows in, or null for one another section holds: a
 * person to decide (`needsDecision`) or a list-only person nobody matched.
 */
export function groupOf(p: PreviewPerson): GroupId | null {
	if (p.needsDecision) return null;
	if (p.listOnly && p.status === "unmatched") return null;
	switch (p.status) {
		case "create":
			return p.membership === "former" ? "former" : "active";
		case "member":
			return "linked";
		case "guest":
			return "guests";
		default:
			// skipped, deleted, and a meeting-named person left unmatched.
			return "skipped";
	}
}

function skipReason(p: PreviewPerson): string {
	if (p.status === "deleted") {
		return "Deleted in GavelUp after an earlier import: not created again.";
	}
	if (p.status === "unmatched") return "Not on the roster: left out.";
	return p.reason ?? "";
}

export function PeopleList({
	people,
	roster,
	changed,
	onLink,
	onCreate,
	onUndo,
}: {
	people: PreviewPerson[];
	roster: RosterMember[];
	/** Person keys the admin answered in this session. */
	changed: ReadonlySet<string>;
	onLink: (key: string, memberId: string) => void;
	onCreate: (key: string) => void;
	onUndo: (key: string) => void;
}) {
	const byGroup = new Map<GroupId, PreviewPerson[]>();
	for (const p of people) {
		const g = groupOf(p);
		if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), p]);
	}
	if (byGroup.size === 0) return null;
	const nameOf = (memberId: string | null) =>
		roster.find((m) => m.memberId === memberId)?.name ?? "";
	return (
		<div className="space-y-2" data-testid="import-people-list">
			<h3 className="text-sm font-bold">People in this import</h3>
			{GROUPS.map((group) => {
				const rows = byGroup.get(group.id) ?? [];
				if (rows.length === 0) return null;
				return (
					<details
						key={group.id}
						open={group.open}
						className="rounded-md border border-border p-2 text-sm"
						data-testid={`people-group-${group.id}`}
					>
						<summary className="cursor-pointer font-semibold">
							{group.title}{" "}
							<span
								className="tabular-nums text-muted-foreground"
								data-testid={`people-group-${group.id}-count`}
							>
								({rows.length})
							</span>
						</summary>
						<ul className="mt-2 space-y-1">
							{rows.map((p) => (
								<PersonRow
									key={p.key}
									p={p}
									group={group.id}
									roster={roster}
									linkedName={nameOf(p.memberId)}
									changed={changed.has(p.key)}
									onLink={onLink}
									onCreate={onCreate}
									onUndo={onUndo}
								/>
							))}
						</ul>
					</details>
				);
			})}
		</div>
	);
}

function PersonRow({
	p,
	group,
	roster,
	linkedName,
	changed,
	onLink,
	onCreate,
	onUndo,
}: {
	p: PreviewPerson;
	group: GroupId;
	roster: RosterMember[];
	linkedName: string;
	changed: boolean;
	onLink: (key: string, memberId: string) => void;
	onCreate: (key: string) => void;
	onUndo: (key: string) => void;
}) {
	const suggestions = p.suggestions ?? [];
	const likely =
		(group === "active" || group === "former") && suggestions.length > 0;
	const a = p.appearances;
	return (
		<li
			className={
				likely
					? "space-y-1 rounded-md border border-warning bg-warning/10 p-2"
					: "space-y-1 p-1"
			}
			data-testid={`person-${p.key}`}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				{group === "linked" ? (
					<span>
						<span className="font-semibold">{p.name}</span> → {linkedName}{" "}
						<span className="text-muted-foreground">
							({MATCH_LABELS[p.via ?? ""] ?? p.via})
						</span>
					</span>
				) : (
					<span>
						<span className="font-semibold">{p.name}</span>
						{(group === "active" || group === "former") && p.officer ? (
							<span className="text-muted-foreground">
								, officer: {p.officer}
							</span>
						) : null}
						{group === "active" || group === "former" ? (
							<span className="text-muted-foreground">
								{" "}
								· {a.roles} roles, {p.speeches ?? 0} speeches, {a.attendance}{" "}
								attended
							</span>
						) : null}
						{group === "guests" && p.kind ? (
							<span className="text-muted-foreground">
								{" "}
								· {GUEST_KIND_LABELS[p.kind as GuestKind] ?? p.kind}
							</span>
						) : null}
						{group === "skipped" ? (
							<span className="text-muted-foreground"> · {skipReason(p)}</span>
						) : null}
					</span>
				)}
				{changed ? (
					<>
						<span className="text-xs font-semibold text-warning-foreground">
							changed
						</span>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => onUndo(p.key)}
						>
							Undo
						</Button>
					</>
				) : null}
			</div>
			{likely
				? suggestions.map((s) => (
						<div key={s.memberId} className="flex items-center gap-2">
							<span>Same person as {s.name}?</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => onLink(p.key, s.memberId)}
							>
								Yes, link
							</Button>
						</div>
					))
				: null}
			{group === "active" || group === "former" ? (
				<select
					className={selectClass}
					aria-label={`Who ${p.name} is`}
					value=""
					onChange={(e) => {
						if (e.target.value !== "") onLink(p.key, e.target.value);
					}}
				>
					<option value="">New member</option>
					<optgroup label="Same person as…">
						{roster.map((m) => (
							<option key={m.memberId} value={m.memberId}>
								{m.name}
							</option>
						))}
					</optgroup>
				</select>
			) : null}
			{group === "linked" && p.via !== "ref" ? (
				<select
					className={selectClass}
					aria-label={`Wrong person: ${p.name}`}
					value=""
					onChange={(e) => {
						const v = e.target.value;
						if (v === NEW_MEMBER) onCreate(p.key);
						else if (v !== "") onLink(p.key, v);
					}}
				>
					<option value="">Wrong person?</option>
					{p.listOnly ? null : <option value={NEW_MEMBER}>New member</option>}
					<optgroup label="Same person as…">
						{roster
							.filter((m) => m.memberId !== p.memberId)
							.map((m) => (
								<option key={m.memberId} value={m.memberId}>
									{m.name}
								</option>
							))}
					</optgroup>
				</select>
			) : null}
		</li>
	);
}
