import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { CheckCircle2, Loader2, Plus, Trash2, Undo2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ACTION_ITEM_LIMITS } from "#/lib/action-item-limits";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatShortDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	addActionItem,
	closeActionItem,
	getActionItems,
	removeActionItem,
	restoreActionItem,
} from "#/server/action-items";
import type { ActionItemRow } from "#/server/action-items-logic";
import { listMembers } from "#/server/members";

export const Route = createFileRoute("/_authed/admin/action-items")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/roster" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) return { items: [], members: [], clubId: "" };
		const [items, members] = await Promise.all([
			getActionItems({ data: { clubId: club.clubId } }),
			listMembers({ data: club.clubId }),
		]);
		return { items, members, clubId: club.clubId };
	},
	component: ActionItems,
});

function ActionItems() {
	const { items, members, clubId } = Route.useLoaderData();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const [text, setText] = useState("");
	const [ownerMemberId, setOwnerMemberId] = useState("");
	const [dueDate, setDueDate] = useState("");

	const open = items.filter((i) => i.resolvedAt === null);
	const resolved = items.filter((i) => i.resolvedAt !== null);

	async function run(fn: () => Promise<unknown>, ok: string) {
		setBusy(true);
		try {
			await fn();
			await router.invalidate();
			toast.success(ok);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function submit() {
		await run(async () => {
			await addActionItem({
				data: {
					clubId,
					text,
					ownerMemberId: ownerMemberId || null,
					dueDate: dueDate ? new Date(dueDate).toISOString() : null,
				},
			});
			setText("");
			setOwnerMemberId("");
			setDueDate("");
			setAdding(false);
		}, "Action item added.");
	}

	return (
		<PageContainer className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Action items
					</h1>
					<p className="mt-1 max-w-prose text-sm text-[var(--sea-ink-soft)]">
						Things the club has agreed to do. They stay here until somebody
						closes them, and they appear on every meeting's minutes until then.
					</p>
				</div>
				<Button onClick={() => setAdding(true)} disabled={busy}>
					<Plus className="mr-1.5 size-4" aria-hidden />
					Add item
				</Button>
			</div>

			<Section
				title="Open"
				subtitle="Oldest first — the thing that has been outstanding longest leads."
			>
				{open.length === 0 ? (
					<EmptyRow>Nothing outstanding. 🎉</EmptyRow>
				) : (
					open.map((item) => (
						<Row key={item.id}>
							<ItemBody item={item} />
							<div className="flex shrink-0 gap-1.5">
								<Button
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() =>
										run(
											() =>
												closeActionItem({
													data: { clubId, id: item.id, resolution: "done" },
												}),
											"Marked done.",
										)
									}
								>
									<CheckCircle2 className="mr-1 size-3.5" aria-hidden />
									Done
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() =>
										run(
											() =>
												closeActionItem({
													data: { clubId, id: item.id, resolution: "dropped" },
												}),
											"Dropped.",
										)
									}
								>
									<XCircle className="mr-1 size-3.5" aria-hidden />
									Drop
								</Button>
							</div>
						</Row>
					))
				)}
			</Section>

			<Section
				title="Closed"
				subtitle="Kept as history — a dropped item is not the same as a done one."
			>
				{resolved.length === 0 ? (
					<EmptyRow>Nothing closed yet.</EmptyRow>
				) : (
					resolved.map((item) => (
						<Row key={item.id}>
							<ItemBody item={item} />
							<div className="flex shrink-0 gap-1.5">
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() =>
										run(
											() =>
												restoreActionItem({ data: { clubId, id: item.id } }),
											"Reopened.",
										)
									}
								>
									<Undo2 className="mr-1 size-3.5" aria-hidden />
									Reopen
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() =>
										run(
											() => removeActionItem({ data: { clubId, id: item.id } }),
											"Deleted.",
										)
									}
								>
									<Trash2 className="size-3.5" aria-hidden />
									<span className="sr-only">Delete</span>
								</Button>
							</div>
						</Row>
					))
				)}
			</Section>

			<Dialog open={adding} onOpenChange={setAdding}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add an action item</DialogTitle>
						<DialogDescription>
							Leave the owner blank if it's something the whole club does.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						<div className="space-y-1.5">
							<Label htmlFor="ai-text">What needs doing</Label>
							<Input
								id="ai-text"
								value={text}
								maxLength={ACTION_ITEM_LIMITS.text}
								placeholder="Book the venue for the contest"
								onChange={(e) => setText(e.target.value)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ai-owner">Owner (optional)</Label>
							<select
								id="ai-owner"
								className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent px-3 text-sm"
								value={ownerMemberId}
								onChange={(e) => setOwnerMemberId(e.target.value)}
							>
								<option value="">The club</option>
								{members.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ai-due">Due date (optional)</Label>
							<Input
								id="ai-due"
								type="date"
								value={dueDate}
								onChange={(e) => setDueDate(e.target.value)}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setAdding(false)}>
							Cancel
						</Button>
						<Button onClick={submit} disabled={busy || text.trim().length === 0}>
							{busy ? (
								<Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />
							) : null}
							Add
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageContainer>
	);
}

function ItemBody({ item }: { item: ActionItemRow }) {
	return (
		<div className="min-w-0">
			<div
				className={cn(
					"text-sm font-medium",
					item.resolution === "dropped" && "line-through opacity-60",
				)}
			>
				{item.text}
			</div>
			<div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
				{/* A null owner is the club collectively — never a placeholder name. */}
				{item.ownerName ?? "The club"}
				{item.dueDate ? ` · due ${formatShortDate(item.dueDate)}` : ""}
				{item.resolution ? ` · ${item.resolution}` : ""}
			</div>
		</div>
	);
}

function Section({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="mb-2.5">
				<h2 className="text-sm font-bold tracking-[-0.01em]">{title}</h2>
				<p className="text-xs text-[var(--sea-ink-soft)]">{subtitle}</p>
			</div>
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]">
				{children}
			</div>
		</div>
	);
}

function Row({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-3 last:border-b-0">
			{children}
		</div>
	);
}

function EmptyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-5 py-10 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</p>
	);
}
