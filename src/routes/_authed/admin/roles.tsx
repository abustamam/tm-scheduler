import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
	ChevronDown,
	ChevronUp,
	Loader2,
	Plus,
	Power,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { pairedRoleIds } from "#/lib/meeting-roles";
import {
	createClubRole,
	deleteClubRole,
	listClubRoles,
	reorderClubRoles,
	setClubRoleEnabled,
	syncTemplateToUpcomingMeetings,
	updateClubRole,
} from "#/server/role-definitions";
import type { RoleDefinitionRow } from "#/server/role-definitions-logic";

export const Route = createFileRoute("/_authed/admin/roles")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/dashboard" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const roles = await listClubRoles({ data: context.adminClub.clubId });
		return { roles };
	},
	component: RolesManager,
});

const CATEGORIES = [
	{ value: "leadership", label: "Leadership" },
	{ value: "speaker", label: "Speaker" },
	{ value: "evaluator", label: "Evaluator" },
	{ value: "functionary", label: "Functionary" },
] as const;

const textareaClass =
	"flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const selectClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function RolesManager() {
	const { adminClub } = Route.useRouteContext();
	const { roles } = Route.useLoaderData();
	// Speaker + its paired Evaluator can't be turned off (#512) — the server
	// refuses it, so don't render a button that only errors. Same helper the
	// +/- speaker controls use, so "paired" means one thing across the app.
	//
	// Over the STANDING roles only, matching `applyRoleDefinitionSetEnabled`'s
	// own guard (#801). This list is the whole bank now, and a role that arrived
	// from a contest is `isSpeakerRole` with the template's sort order — over the
	// union the heuristic could name IT as the club's speaker, hiding Disable on
	// a contest role and offering it on the real Speaker, which the server then
	// refuses.
	const paired = pairedRoleIds(roles.filter((r) => r.standing));
	const router = useRouter();
	const clubId = adminClub.clubId;

	/**
	 * The two sections this page renders since #802, each holding the role's
	 * index in the WHOLE `roles` array.
	 *
	 * The index is carried rather than recomputed because `reorder` below sends
	 * `orderedIds` for the entire bank — one `sort_order` sequence, shared by
	 * both sections — so a position within a section is not a position the
	 * server can be told about. Splitting the array and reordering by the split
	 * index would have written a club's roles back in an order nobody asked for.
	 */
	const sections = [
		{
			key: "standing" as const,
			entries: roles.flatMap((role, i) => (role.standing ? [{ role, i }] : [])),
		},
		{
			key: "non-standing" as const,
			entries: roles.flatMap((role, i) => (role.standing ? [] : [{ role, i }])),
		},
	];

	/**
	 * Swap two roles' places in the club's single ordering.
	 *
	 * Takes both WHOLE-ARRAY indices rather than an index and a direction: with
	 * the list split into two sections, a role's visual neighbour is its
	 * neighbour WITHIN its section, which need not be adjacent in `roles`. The
	 * caller reads it off the section it is rendering; everything else is
	 * unchanged, and the roles between the two swapped positions keep theirs.
	 */
	async function reorder(index: number, target: number) {
		const next = [...roles];
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		try {
			await reorderClubRoles({
				data: { clubId, orderedIds: next.map((r) => r.id) },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't reorder.");
		}
	}

	const [syncing, setSyncing] = useState(false);
	async function syncUpcoming() {
		setSyncing(true);
		try {
			const res = await syncTemplateToUpcomingMeetings({ data: { clubId } });
			if (res.meetingsChanged === 0) {
				toast.success("Upcoming meetings already match the standard set.");
			} else {
				const plural = res.meetingsChanged === 1 ? "" : "s";
				toast.success(
					`Added ${res.rolesAdded.join(", ")} to ${res.meetingsChanged} upcoming meeting${plural}.`,
				);
			}
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't update meetings.",
			);
		} finally {
			setSyncing(false);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Meeting roles
					</h1>
					<p className="text-sm text-muted-foreground">
						The role template for {adminClub.name}. Descriptions show on the
						sign-up sheet and the public shared agenda. Changing a role's
						default count only affects meetings created afterwards — existing
						meetings keep their slots. Not running a role yet? Disable it
						instead of deleting it — it stays here, ready to turn back on, and
						stops being offered elsewhere in the meantime.
					</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					onClick={syncUpcoming}
					disabled={syncing}
				>
					{syncing ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Update upcoming meetings to match"
					)}
				</Button>
			</div>

			{sections.map(({ key, entries }) =>
				entries.length === 0 ? null : (
					<section key={key} className="space-y-3">
						{/* #802. #801 marked a non-standing role with an inline badge on
						    its own card, deliberately, so nothing was invisible while this
						    issue was pending. A badge says what a role is NOT; it cannot
						    say what the officer actually needs to decide, which is whether
						    a role that is off the standard shape is off it and unused or
						    off it and carrying three nights' agendas. The section plus the
						    count below replace the badge. */}
						{key === "non-standing" ? (
							<div className="space-y-1 border-t border-[var(--line)] pt-6">
								<h2 className="font-display text-xl font-semibold tracking-[-0.02em]">
									Not on standard meetings
								</h2>
								<p className="text-sm text-muted-foreground">
									Your club's roles that a new meeting generates no slot for — a
									contest's roles, and anything added straight to one night's
									agenda. They are fillable and editable exactly like the rest,
									and any agenda can pick them up from its Roles panel.
								</p>
							</div>
						) : null}
						{entries.map(({ role, i }, position) => (
							<RoleCard
								key={role.id}
								clubId={clubId}
								role={role}
								isPaired={paired.has(role.id)}
								isFirst={position === 0}
								isLast={position === entries.length - 1}
								// The neighbour WITHIN this section, by whole-array index —
								// see `reorder`. Guarded by `isFirst`/`isLast`, so the reads
								// below are never out of range.
								onMoveUp={() => reorder(i, entries[position - 1]?.i ?? i)}
								onMoveDown={() => reorder(i, entries[position + 1]?.i ?? i)}
								onChanged={() => router.invalidate()}
							/>
						))}
					</section>
				),
			)}

			<AddRoleForm
				clubId={clubId}
				onAdded={() => router.invalidate()}
				onSync={syncUpcoming}
			/>
		</PageContainer>
	);
}

/** Toast copy for an enable/disable toggle result. Surfaces the counts
 *  `applyRoleDefinitionSetEnabled` (#368) already computed — "kept claimed
 *  slots" on disable, so an admin knows their disable didn't silently
 *  un-assign anyone, and how many meetings got the role back on enable — so
 *  neither the sync-style result nor the toggle re-does work the server
 *  already did just to throw it away. */
function toggleToastMessage(
	roleName: string,
	nextEnabled: boolean,
	result: { keptClaimedMeetings: number; meetingsChanged: number },
): string {
	if (nextEnabled) {
		if (result.meetingsChanged === 0) {
			return `${roleName} is back on. No upcoming meetings needed it added back.`;
		}
		const plural = result.meetingsChanged === 1 ? "" : "s";
		return `${roleName} is back on — added to ${result.meetingsChanged} upcoming meeting${plural}.`;
	}
	if (result.keptClaimedMeetings > 0) {
		const plural = result.keptClaimedMeetings === 1 ? "" : "s";
		return (
			`${roleName} is off for future meetings; ${result.keptClaimedMeetings} upcoming ` +
			`meeting${plural} still has it assigned.`
		);
	}
	return `${roleName} is off — future meetings won't offer it.`;
}

function RoleCard({
	clubId,
	role,
	isPaired,
	isFirst,
	isLast,
	onMoveUp,
	onMoveDown,
	onChanged,
}: {
	clubId: string;
	role: RoleDefinitionRow;
	/** Speaker or its paired Evaluator — cannot be disabled (#512). */
	isPaired: boolean;
	isFirst: boolean;
	isLast: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onChanged: () => Promise<void> | void;
}) {
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [toggling, setToggling] = useState(false);

	async function onSave(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSaving(true);
		try {
			await updateClubRole({
				data: {
					clubId,
					roleId: role.id,
					name: String(form.get("name") ?? "").trim(),
					category: String(
						// Fall back to the role's CURRENT category, never a literal: since
						// #371 the category decides whether a role is introduced with the
						// functionaries and called on for a report by the General
						// Evaluator, so a missing field must not silently recategorise the
						// role.
						form.get("category") ?? role.category,
					) as RoleDefinitionRow["category"],
					defaultCount: Number(form.get("defaultCount") ?? 1),
					isSpeakerRole: form.get("isSpeakerRole") === "on",
					description: String(form.get("description") ?? ""),
				},
			});
			toast.success(`Saved ${role.name}.`);
			await onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't save.");
		} finally {
			setSaving(false);
		}
	}

	async function onDelete() {
		setDeleting(true);
		try {
			await deleteClubRole({ data: { clubId, roleId: role.id } });
			toast.success(`Removed ${role.name}.`);
			await onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't delete.");
		} finally {
			setDeleting(false);
		}
	}

	async function onToggleEnabled() {
		const nextEnabled = !role.enabled;
		setToggling(true);
		try {
			const res = await setClubRoleEnabled({
				data: { clubId, roleId: role.id, enabled: nextEnabled },
			});
			toast.success(toggleToastMessage(role.name, nextEnabled, res));
			await onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update role.");
		} finally {
			setToggling(false);
		}
	}

	// `slotCount` is only computed for callers that ask (this page's
	// `listClubRoles` does); treat an unasked count as "not referenced".
	const slotCount = role.slotCount ?? 0;
	const referenced = slotCount > 0;
	// Same rule for `agendaCount` (#802): opt-in, so an unasked count says
	// nothing rather than claiming zero. Two DIFFERENT numbers — `slotCount` is
	// how many slots exist (what blocks a delete), this is how many of the club's
	// own per-meeting agendas DECLARE the role, which is what says whether a role
	// off the standard shape is actually in use.
	const agendaCount = role.agendaCount;

	return (
		<form
			onSubmit={onSave}
			className={`rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4 ${
				role.enabled ? "" : "opacity-70"
			}`}
		>
			<div className="flex items-start gap-3">
				<div className="flex flex-col gap-1 pt-6">
					<button
						type="button"
						onClick={onMoveUp}
						disabled={isFirst}
						title="Move up"
						className="flex size-6 items-center justify-center rounded-md text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)] disabled:opacity-30"
					>
						<ChevronUp className="size-4" />
						<span className="sr-only">Move up</span>
					</button>
					<button
						type="button"
						onClick={onMoveDown}
						disabled={isLast}
						title="Move down"
						className="flex size-6 items-center justify-center rounded-md text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)] disabled:opacity-30"
					>
						<ChevronDown className="size-4" />
						<span className="sr-only">Move down</span>
					</button>
				</div>

				<div className="grid flex-1 gap-3">
					<div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto]">
						<div className="space-y-1.5">
							<Label
								htmlFor={`name-${role.id}`}
								className="flex items-center gap-2"
							>
								Name
								{role.enabled ? null : (
									<Badge variant="secondary" className="font-normal">
										Disabled
									</Badge>
								)}
								{/* #801's inline "Not on standard meetings" badge was here.
								    #802 moved that fact to the section heading, where it is
								    stated once for the group instead of repeated on every
								    card, and spent the room on the agenda count below — the
								    half a badge cannot carry, because "not standing" does
								    not distinguish a role nobody uses from one carrying
								    three nights' agendas. */}
							</Label>
							<Input
								id={`name-${role.id}`}
								name="name"
								defaultValue={role.name}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`category-${role.id}`}>Category</Label>
							<select
								id={`category-${role.id}`}
								name="category"
								defaultValue={role.category}
								className={selectClass}
							>
								{CATEGORIES.map((c) => (
									<option key={c.value} value={c.value}>
										{c.label}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`count-${role.id}`}>Default count</Label>
							<Input
								id={`count-${role.id}`}
								name="defaultCount"
								type="number"
								min={0}
								max={20}
								defaultValue={role.defaultCount}
								className="w-24"
							/>
						</div>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor={`desc-${role.id}`}>Description</Label>
						<textarea
							id={`desc-${role.id}`}
							name="description"
							rows={2}
							defaultValue={role.description ?? ""}
							className={textareaClass}
							placeholder="What this role does — shown on the sign-up sheet and shared agenda."
						/>
					</div>

					<div className="flex flex-wrap items-center gap-4">
						<label
							htmlFor={`speaker-${role.id}`}
							className="flex items-center gap-2 text-sm"
						>
							<input
								id={`speaker-${role.id}`}
								name="isSpeakerRole"
								type="checkbox"
								defaultChecked={role.isSpeakerRole}
								className="size-4"
							/>
							Speaker role (prompts for speech details)
						</label>
						<div className="ml-auto flex items-center gap-2">
							<Button type="submit" size="sm" disabled={saving}>
								{saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={toggling || (isPaired && role.enabled)}
								onClick={onToggleEnabled}
								title={
									isPaired && role.enabled
										? "Every meeting needs speakers and their evaluators. Set the count to 0 on a meeting instead."
										: role.enabled
											? "Stop offering this role on future meetings, without deleting it"
											: "Start offering this role on future meetings again"
								}
							>
								{toggling ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<>
										<Power className="size-4" />
										{role.enabled ? "Disable" : "Enable"}
									</>
								)}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={deleting || referenced}
								onClick={onDelete}
								title={
									referenced
										? "Used by existing meetings — disable it instead"
										: "Delete role"
								}
							>
								{deleting ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<Trash2 className="size-4" />
								)}
							</Button>
						</div>
					</div>
					{referenced ? (
						<p className="text-xs text-muted-foreground">
							Used by {slotCount} existing meeting slot
							{slotCount === 1 ? "" : "s"} — can't be deleted. Disable it
							instead to stop offering it on future meetings; its history stays
							intact.
						</p>
					) : null}
					{agendaCount === undefined ? null : (
						<p className="text-xs text-muted-foreground">
							{agendaCount === 0
								? "No meeting agenda lists this role right now."
								: `Listed on ${agendaCount} meeting agenda${agendaCount === 1 ? "" : "s"}.`}
						</p>
					)}
				</div>
			</div>
		</form>
	);
}

function AddRoleForm({
	clubId,
	onAdded,
	onSync,
}: {
	clubId: string;
	onAdded: () => Promise<void> | void;
	onSync: () => Promise<void> | void;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const el = e.currentTarget;
		const form = new FormData(el);
		setSubmitting(true);
		try {
			await createClubRole({
				data: {
					clubId,
					name: String(form.get("name") ?? "").trim(),
					category: String(
						// Matches the form's default — see the Category select below
						// for why it is not "functionary" (#371).
						form.get("category") ?? "leadership",
					) as RoleDefinitionRow["category"],
					defaultCount: Number(form.get("defaultCount") ?? 1),
					isSpeakerRole: form.get("isSpeakerRole") === "on",
					description: String(form.get("description") ?? ""),
				},
			});
			toast.success("Role added.", {
				action: {
					label: "Update upcoming meetings",
					onClick: () => {
						void onSync();
					},
				},
			});
			el.reset();
			await onAdded();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't add role.");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form
			onSubmit={onSubmit}
			className="space-y-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--foam)] p-4"
		>
			<h2 className="text-sm font-bold">Add a custom role</h2>
			<div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto]">
				<div className="space-y-1.5">
					<Label htmlFor="new-name">Name</Label>
					<Input
						id="new-name"
						name="name"
						required
						placeholder="e.g. Toastmaster"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="new-category">Category</Label>
					{/* Defaults to Leadership, not Functionary (#371). Since #371 the
					    category is load-bearing: a functionary-category role is
					    introduced with the functionaries and called on for a report by
					    the General Evaluator, on the printed agenda AND the projected
					    deck. That rule is defensible only if "functionary" is something
					    a club CHOSE — as a default it would be the value they never
					    touched. A club adding Sergeant-at-Arms (who calls the meeting to
					    order, and not in ROLE_TEMPLATE, so it can only be added here) or
					    a Zoom Host would otherwise find them listed among the
					    functionaries the General Evaluator calls on for a report. */}
					<select
						id="new-category"
						name="category"
						defaultValue="leadership"
						className={selectClass}
					>
						{CATEGORIES.map((c) => (
							<option key={c.value} value={c.value}>
								{c.label}
							</option>
						))}
					</select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="new-count">Default count</Label>
					<Input
						id="new-count"
						name="defaultCount"
						type="number"
						min={0}
						max={20}
						defaultValue={1}
						className="w-24"
					/>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="new-desc">Description</Label>
				<textarea
					id="new-desc"
					name="description"
					rows={2}
					className={textareaClass}
					placeholder="What this role does — shown on the sign-up sheet and shared agenda."
				/>
			</div>
			<div className="flex items-center gap-4">
				<label
					htmlFor="new-speaker"
					className="flex items-center gap-2 text-sm"
				>
					<input
						id="new-speaker"
						name="isSpeakerRole"
						type="checkbox"
						className="size-4"
					/>
					Speaker role (prompts for speech details)
				</label>
				<Button
					type="submit"
					size="sm"
					disabled={submitting}
					className="ml-auto"
				>
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<>
							<Plus className="size-4" /> Add role
						</>
					)}
				</Button>
			</div>
		</form>
	);
}
