import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	createClubRole,
	deleteClubRole,
	listClubRoles,
	reorderClubRoles,
	syncTemplateToUpcomingMeetings,
	updateClubRole,
} from "#/server/role-definitions";
import type { RoleDefinitionRow } from "#/server/role-definitions-logic";

export const Route = createFileRoute("/_authed/admin/roles")({
	beforeLoad: ({ context }) => {
		const adminClub = context.clubs.find((c) => c.clubRole === "admin");
		if (!adminClub) {
			throw redirect({ to: "/" });
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
	const { adminClub, currentMemberId } = Route.useRouteContext();
	const { roles } = Route.useLoaderData();
	const router = useRouter();
	const clubId = adminClub.clubId;

	async function reorder(index: number, dir: -1 | 1) {
		const next = [...roles];
		const target = index + dir;
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
			const res = await syncTemplateToUpcomingMeetings({
				data: { clubId, actorMemberId: currentMemberId },
			});
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
					<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
						Meeting roles
					</h1>
					<p className="text-sm text-muted-foreground">
						The role template for {adminClub.name}. Descriptions show on the
						sign-up sheet and the public shared agenda. Changing a role's
						default count only affects meetings created afterwards — existing
						meetings keep their slots.
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

			<div className="space-y-3">
				{roles.map((role, i) => (
					<RoleCard
						key={role.id}
						clubId={clubId}
						role={role}
						isFirst={i === 0}
						isLast={i === roles.length - 1}
						onMoveUp={() => reorder(i, -1)}
						onMoveDown={() => reorder(i, 1)}
						onChanged={() => router.invalidate()}
					/>
				))}
			</div>

			<AddRoleForm
				clubId={clubId}
				onAdded={() => router.invalidate()}
				onSync={syncUpcoming}
			/>
		</PageContainer>
	);
}

function RoleCard({
	clubId,
	role,
	isFirst,
	isLast,
	onMoveUp,
	onMoveDown,
	onChanged,
}: {
	clubId: string;
	role: RoleDefinitionRow;
	isFirst: boolean;
	isLast: boolean;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onChanged: () => Promise<void> | void;
}) {
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);

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
						form.get("category") ?? "functionary",
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

	const referenced = role.slotCount > 0;

	return (
		<form
			onSubmit={onSave}
			className="rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4"
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
							<Label htmlFor={`name-${role.id}`}>Name</Label>
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
								disabled={deleting || referenced}
								onClick={onDelete}
								title={
									referenced
										? "Used by existing meetings — set default count to 0 instead"
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
							Used by {role.slotCount} existing meeting slot
							{role.slotCount === 1 ? "" : "s"} — can't be deleted. Set the
							default count to 0 to stop adding it to new meetings.
						</p>
					) : null}
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
						form.get("category") ?? "functionary",
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
					<select
						id="new-category"
						name="category"
						defaultValue="functionary"
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
