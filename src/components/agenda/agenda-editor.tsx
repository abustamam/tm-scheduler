import {
	ArrowDown,
	ArrowUp,
	Loader2,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import type {
	AgendaDraft,
	AgendaDraftRole,
	AgendaDraftRow,
	ReleasedHolder,
} from "#/server/meeting-agenda-edit";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/** "Ada Lovelace and Grace Hopper" — same join `MeetingTemplateDialog` uses. */
function joinNames(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}

/** The one message `removeAgendaRole` throws for a key its own template no
 *  longer declares — reachable a second time from a double-clicked confirm,
 *  or from a role another tab already removed. The role is gone either way,
 *  so this is treated as success rather than surfaced as a raw server error
 *  to an officer who did nothing wrong. */
function isRoleAlreadyGone(err: unknown): boolean {
	return (
		err instanceof Error &&
		/is not a role this template declares/.test(err.message)
	);
}

const KIND_LABELS: Record<AgendaDraftRow["kind"], string> = {
	section: "Section",
	role: "Role",
	event: "Event",
};

const CATEGORY_LABELS: Record<AgendaDraftRole["category"], string> = {
	leadership: "Leadership",
	speaker: "Speaker",
	evaluator: "Evaluator",
	functionary: "Functionary",
};

export type RowPatch = Partial<
	Pick<
		AgendaDraftRow,
		| "label"
		| "detail"
		| "minutes"
		| "roleKey"
		| "repeatsRoleKey"
		| "markGreen"
		| "markYellow"
		| "markRed"
	>
>;

export interface NewAgendaRole {
	name: string;
	category: AgendaDraftRole["category"];
	defaultCount: number;
	isSpeakerRole: boolean;
}

export interface AgendaEditorProps {
	draft: AgendaDraft;
	onAddRow: (
		afterRowId: string | null,
		kind: AgendaDraftRow["kind"],
	) => Promise<unknown>;
	onUpdateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
	onRemoveRow: (rowId: string) => Promise<unknown>;
	onMoveRow: (rowId: string, direction: "up" | "down") => Promise<unknown>;
	onAddRole: (role: NewAgendaRole) => Promise<unknown>;
	planRoleRemoval: (roleKey: string) => Promise<ReleasedHolder[]>;
	onRemoveRole: (roleKey: string) => Promise<unknown>;
}

/** Runs a mutation and toasts on failure — the shared shape every button below
 *  uses so a rejected server fn never becomes an unhandled promise. */
async function runAction(action: () => Promise<unknown>): Promise<void> {
	try {
		await action();
	} catch (err) {
		toast.error(errMessage(err));
	}
}

/**
 * The per-meeting agenda editor. Presentational: every mutation is a prop, so
 * the whole component is reachable from vitest without the Start runtime —
 * the same shape `MeetingTemplateDialog` uses. The route wires the props to
 * the Task 6-8 server fns and calls `router.invalidate()` after each.
 */
export function AgendaEditor({
	draft,
	onAddRow,
	onUpdateRow,
	onRemoveRow,
	onMoveRow,
	onAddRole,
	planRoleRemoval,
	onRemoveRole,
}: AgendaEditorProps) {
	const { editable, rows, roles } = draft;

	return (
		<div className="flex flex-col gap-6">
			{!editable ? (
				<p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
					This meeting's agenda is read-only now — it already happened, or was
					cancelled.
				</p>
			) : null}

			<div className="flex flex-col gap-3">
				{rows.map((row, index) => (
					<RowCard
						key={row.id}
						row={row}
						roles={roles}
						editable={editable}
						isFirst={index === 0}
						isLast={index === rows.length - 1}
						onUpdateRow={onUpdateRow}
						onRemoveRow={onRemoveRow}
						onMoveRow={onMoveRow}
					/>
				))}
			</div>

			{editable ? (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "section"))}
					>
						Add row: Section
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "role"))}
					>
						Add row: Role
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "event"))}
					>
						Add row: Event
					</Button>
				</div>
			) : null}

			<RolesPanel
				roles={roles}
				editable={editable}
				onAddRole={onAddRole}
				planRoleRemoval={planRoleRemoval}
				onRemoveRole={onRemoveRole}
			/>
		</div>
	);
}

function parseIntOrNull(value: string): number | null {
	if (value.trim() === "") return null;
	const n = Number.parseInt(value, 10);
	return Number.isNaN(n) ? null : n;
}

function RowCard({
	row,
	roles,
	editable,
	isFirst,
	isLast,
	onUpdateRow,
	onRemoveRow,
	onMoveRow,
}: {
	row: AgendaDraftRow;
	roles: AgendaDraftRole[];
	editable: boolean;
	isFirst: boolean;
	isLast: boolean;
	onUpdateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
	onRemoveRow: (rowId: string) => Promise<unknown>;
	onMoveRow: (rowId: string, direction: "up" | "down") => Promise<unknown>;
}) {
	const [label, setLabel] = useState(row.label);
	const [detail, setDetail] = useState(row.detail ?? "");
	const [minutes, setMinutes] = useState(String(row.minutes));
	const [markGreen, setMarkGreen] = useState(
		row.markGreen == null ? "" : String(row.markGreen),
	);
	const [markYellow, setMarkYellow] = useState(
		row.markYellow == null ? "" : String(row.markYellow),
	);
	const [markRed, setMarkRed] = useState(
		row.markRed == null ? "" : String(row.markRed),
	);
	const [pending, setPending] = useState(false);

	function commitLabel() {
		if (label !== row.label)
			void runAction(() => onUpdateRow(row.id, { label }));
	}
	function commitDetail() {
		const next = detail === "" ? null : detail;
		if (next !== row.detail)
			void runAction(() => onUpdateRow(row.id, { detail: next }));
	}
	function commitMinutes() {
		const parsed = Number.parseInt(minutes, 10);
		if (Number.isNaN(parsed)) {
			setMinutes(String(row.minutes));
			return;
		}
		if (parsed !== row.minutes)
			void runAction(() => onUpdateRow(row.id, { minutes: parsed }));
	}
	function commitMarks() {
		const green = parseIntOrNull(markGreen);
		const yellow = parseIntOrNull(markYellow);
		const red = parseIntOrNull(markRed);
		if (
			green !== row.markGreen ||
			yellow !== row.markYellow ||
			red !== row.markRed
		) {
			void runAction(() =>
				onUpdateRow(row.id, {
					markGreen: green,
					markYellow: yellow,
					markRed: red,
				}),
			);
		}
	}

	async function move(direction: "up" | "down") {
		setPending(true);
		await runAction(() => onMoveRow(row.id, direction));
		setPending(false);
	}

	async function remove() {
		setPending(true);
		await runAction(() => onRemoveRow(row.id));
		setPending(false);
	}

	const isRoleRow = row.kind === "role";
	const perHolder =
		isRoleRow && row.roleKey != null && row.repeatsRoleKey === row.roleKey;

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<div className="flex items-center justify-between gap-2">
				<Badge variant={row.kind === "section" ? "secondary" : "outline"}>
					{KIND_LABELS[row.kind]}
				</Badge>
				{editable ? (
					<div className="flex items-center gap-1">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isFirst || pending}
							aria-label="Move up"
							onClick={() => move("up")}
						>
							<ArrowUp className="size-4" aria-hidden="true" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isLast || pending}
							aria-label="Move down"
							onClick={() => move("down")}
						>
							<ArrowDown className="size-4" aria-hidden="true" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={pending}
							aria-label="Remove row"
							onClick={remove}
						>
							<Trash2 className="size-4" aria-hidden="true" />
						</Button>
					</div>
				) : null}
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-label`}>Label</Label>
					<Input
						id={`${row.id}-label`}
						aria-label="Row label"
						value={label}
						disabled={!editable}
						maxLength={MAX_TEMPLATE_LABEL_CHARS}
						onChange={(e) => setLabel(e.target.value)}
						onBlur={commitLabel}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-detail`}>Note</Label>
					<Input
						id={`${row.id}-detail`}
						aria-label="Row note"
						value={detail}
						disabled={!editable}
						maxLength={MAX_TEMPLATE_DETAIL_CHARS}
						onChange={(e) => setDetail(e.target.value)}
						onBlur={commitDetail}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-minutes`}>Minutes</Label>
					<Input
						id={`${row.id}-minutes`}
						aria-label="Row minutes"
						type="number"
						min={0}
						max={600}
						value={minutes}
						disabled={!editable}
						onChange={(e) => setMinutes(e.target.value)}
						onBlur={commitMinutes}
					/>
				</div>

				{isRoleRow ? (
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${row.id}-role`}>Role</Label>
						<select
							id={`${row.id}-role`}
							aria-label="Row role"
							className="h-9 rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
							value={row.roleKey ?? ""}
							disabled={!editable}
							onChange={(e) =>
								void runAction(() =>
									onUpdateRow(row.id, {
										roleKey: e.target.value === "" ? null : e.target.value,
									}),
								)
							}
						>
							<option value="">Nobody</option>
							{roles.map((r) => (
								<option key={r.key} value={r.key}>
									{r.name}
								</option>
							))}
						</select>
					</div>
				) : null}
			</div>

			{isRoleRow && row.roleKey != null ? (
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={perHolder}
						disabled={!editable}
						onChange={(e) => {
							const checked = e.target.checked;
							void runAction(() =>
								onUpdateRow(row.id, {
									repeatsRoleKey: checked ? row.roleKey : null,
								}),
							);
						}}
					/>
					{perHolder ? "One row per person holding this role" : "One row"}
				</label>
			) : null}

			<div className="grid grid-cols-3 gap-3">
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-green`}>Green at</Label>
					<Input
						id={`${row.id}-green`}
						aria-label="Green mark minute"
						type="number"
						min={0}
						value={markGreen}
						disabled={!editable}
						onChange={(e) => setMarkGreen(e.target.value)}
						onBlur={commitMarks}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-yellow`}>Yellow at</Label>
					<Input
						id={`${row.id}-yellow`}
						aria-label="Yellow mark minute"
						type="number"
						min={0}
						value={markYellow}
						disabled={!editable}
						onChange={(e) => setMarkYellow(e.target.value)}
						onBlur={commitMarks}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor={`${row.id}-red`}>Red at</Label>
					<Input
						id={`${row.id}-red`}
						aria-label="Red mark minute"
						type="number"
						min={0}
						value={markRed}
						disabled={!editable}
						onChange={(e) => setMarkRed(e.target.value)}
						onBlur={commitMarks}
					/>
				</div>
			</div>
		</div>
	);
}

/** What a role-removal confirmation is currently doing. `idle` renders no
 *  dialog at all. */
type RolePhase =
	| { kind: "idle" }
	| { kind: "checking"; role: AgendaDraftRole }
	| { kind: "confirming"; role: AgendaDraftRole; holders: ReleasedHolder[] }
	| { kind: "failed"; role: AgendaDraftRole; message: string };

function RolesPanel({
	roles,
	editable,
	onAddRole,
	planRoleRemoval,
	onRemoveRole,
}: {
	roles: AgendaDraftRole[];
	editable: boolean;
	onAddRole: (role: NewAgendaRole) => Promise<unknown>;
	planRoleRemoval: (roleKey: string) => Promise<ReleasedHolder[]>;
	onRemoveRole: (roleKey: string) => Promise<unknown>;
}) {
	const [phase, setPhase] = useState<RolePhase>({ kind: "idle" });
	const [confirmBusy, setConfirmBusy] = useState(false);
	const [name, setName] = useState("");
	const [category, setCategory] =
		useState<AgendaDraftRole["category"]>("functionary");
	const [defaultCount, setDefaultCount] = useState("1");
	const [isSpeakerRole, setIsSpeakerRole] = useState(false);
	const [addBusy, setAddBusy] = useState(false);

	/**
	 * Removing a role releases its slots, and a released holder cannot be
	 * notified afterwards (`notifications.slot_id` cascades away with the slot
	 * before the poller can see it) — so this leads with names, exactly like
	 * `MeetingTemplateDialog`, and only asks for a SECOND confirm when someone
	 * is actually affected. Nothing claimed → one click removes it.
	 */
	async function startRemove(role: AgendaDraftRole) {
		setPhase({ kind: "checking", role });
		try {
			const holders = await planRoleRemoval(role.key);
			if (holders.length === 0) {
				await onRemoveRole(role.key);
				setPhase({ kind: "idle" });
			} else {
				setPhase({ kind: "confirming", role, holders });
			}
		} catch (err) {
			setPhase({ kind: "failed", role, message: errMessage(err) });
		}
	}

	async function confirmRemove() {
		if (phase.kind !== "confirming") return;
		setConfirmBusy(true);
		try {
			await onRemoveRole(phase.role.key);
			setPhase({ kind: "idle" });
		} catch (err) {
			if (isRoleAlreadyGone(err)) {
				// A double-clicked confirm, or another tab already removed it —
				// the role is gone either way, so this reads as success rather
				// than surfacing the raw server message.
				toast.message(`"${phase.role.name}" was already removed.`);
				setPhase({ kind: "idle" });
			} else {
				setPhase({
					kind: "failed",
					role: phase.role,
					message: errMessage(err),
				});
			}
		} finally {
			setConfirmBusy(false);
		}
	}

	async function submitAddRole(e: React.FormEvent) {
		e.preventDefault();
		if (name.trim() === "") return;
		setAddBusy(true);
		try {
			await onAddRole({
				name: name.trim(),
				category,
				defaultCount: parseIntOrNull(defaultCount) ?? 0,
				isSpeakerRole,
			});
			setName("");
			setCategory("functionary");
			setDefaultCount("1");
			setIsSpeakerRole(false);
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAddBusy(false);
		}
	}

	const activeRole = phase.kind === "idle" ? null : phase.role;

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<h2 className="font-semibold text-sm">Roles</h2>
			<ul className="flex flex-col gap-1">
				{roles.map((role) => (
					<li
						key={role.key}
						className="flex items-center justify-between gap-2 text-sm"
					>
						<span>
							{role.name}{" "}
							<span className="text-muted-foreground text-xs">
								({CATEGORY_LABELS[role.category]}, {role.defaultCount}{" "}
								{role.defaultCount === 1 ? "slot" : "slots"})
							</span>
						</span>
						{editable ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								// One removal flow at a time: without this, a fast double
								// click fires `planRoleRemoval` twice, and on an unclaimed
								// role (the one-click path) that races two `onRemoveRole`
								// calls for the same key.
								disabled={phase.kind !== "idle"}
								onClick={() => startRemove(role)}
							>
								Remove {role.name}
							</Button>
						) : null}
					</li>
				))}
			</ul>

			{editable ? (
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={submitAddRole}
				>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-name">New role name</Label>
						<Input
							id="new-role-name"
							value={name}
							maxLength={MAX_TEMPLATE_LABEL_CHARS}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-category">Category</Label>
						<select
							id="new-role-category"
							className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
							value={category}
							onChange={(e) =>
								setCategory(e.target.value as AgendaDraftRole["category"])
							}
						>
							{Object.entries(CATEGORY_LABELS).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-count">Places</Label>
						<Input
							id="new-role-count"
							type="number"
							min={0}
							max={MAX_ROLE_REPEAT_SLOTS}
							value={defaultCount}
							onChange={(e) => setDefaultCount(e.target.value)}
							className="w-20"
						/>
					</div>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isSpeakerRole}
							onChange={(e) => setIsSpeakerRole(e.target.checked)}
						/>
						Speaking role
					</label>
					<Button
						type="submit"
						size="sm"
						disabled={addBusy || name.trim() === ""}
					>
						{addBusy ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : null}
						Add role
					</Button>
				</form>
			) : null}

			<Dialog
				open={phase.kind !== "idle"}
				onOpenChange={(open) => {
					if (!open) setPhase({ kind: "idle" });
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Remove {activeRole?.name ?? "role"}?</DialogTitle>
					</DialogHeader>

					{phase.kind === "checking" ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							Checking who holds this role…
						</p>
					) : null}

					{phase.kind === "failed" ? (
						<p className="text-destructive text-sm">{phase.message}</p>
					) : null}

					{phase.kind === "confirming" ? (
						// Named once, in one sentence — every holder here loses the SAME
						// role (the one being removed), so a second per-holder list would
						// just repeat the role name back at them. Plain text, never a
						// link: the unlayered `a` rule in src/styles.css beats any
						// layered utility here.
						<div className="flex gap-2 text-sm">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-destructive"
								aria-hidden="true"
							/>
							<div>
								<p className="font-medium">
									{joinNames(phase.holders.map((h) => h.name))} will lose{" "}
									{phase.role.name}.
								</p>
								<p className="text-muted-foreground">
									They won't be told automatically — message them after you
									remove it.
								</p>
							</div>
						</div>
					) : null}

					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={confirmBusy}
							onClick={() => setPhase({ kind: "idle" })}
						>
							Cancel
						</Button>
						{phase.kind === "confirming" ? (
							<Button
								type="button"
								variant="destructive"
								disabled={confirmBusy}
								onClick={confirmRemove}
							>
								{confirmBusy ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : null}
								Remove anyway
							</Button>
						) : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
