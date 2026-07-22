import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Search } from "lucide-react";
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
	DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";
import {
	listDuplicatePeopleFn,
	mergePeopleFn,
	previewMerge,
	searchPeople,
} from "#/server/people";
import type {
	DuplicateGroup,
	DuplicatePerson,
	MergePreview,
} from "#/server/people-logic";

// Superadmin "one human = one Person" merge console (person-identity spec,
// Task 9 — the UI on top of Task 8's server fns). Auto-detected groups
// (`DuplicateGroupCard`) resolve N-person groups via repeated pairwise merges
// against a chosen keeper; the manual search section is the escape hatch for
// duplicates that don't share an email. Both flows share one confirm dialog
// (`MergeConfirm`) that previews the merge (and hard-disables on a block)
// before writing.

export const Route = createFileRoute("/_authed/superadmin/duplicate-people")({
	loader: () => listDuplicatePeopleFn(),
	component: DuplicatePeopleConsole,
});

function DuplicatePeopleConsole() {
	const groups = Route.useLoaderData();
	const router = useRouter();

	function onMerged() {
		router.invalidate();
	}

	return (
		<PageContainer className="space-y-6">
			<div className="space-y-1">
				<Link
					to="/superadmin"
					className="inline-flex items-center gap-1 text-sm text-[var(--sea-ink-soft)] hover:text-[var(--sea-ink)]"
				>
					<ArrowLeft className="size-4" /> All clubs
				</Link>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Duplicate people
				</h1>
				<p className="text-sm text-muted-foreground">
					One human should be one Person across every club. Merging is
					irreversible: pick a keeper, everything else (memberships, speeches,
					Pathways enrollments) moves onto it.
				</p>
			</div>

			<div className="space-y-3">
				<h2 className="text-sm font-bold">
					Auto-detected groups ({groups.length})
				</h2>
				{groups.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No Persons share an email right now.
					</p>
				) : (
					<div className="space-y-4">
						{groups.map((group) => (
							<DuplicateGroupCard
								key={group.email}
								group={group}
								onMerged={onMerged}
							/>
						))}
					</div>
				)}
			</div>

			<ManualSearchSection onMerged={onMerged} />
		</PageContainer>
	);
}

function LinkBadge({ linked }: { linked: boolean }) {
	return (
		<span
			className={
				linked
					? "inline-block rounded-full bg-[var(--foam)] px-2 py-0.5 text-xs font-semibold text-[var(--palm)]"
					: "inline-block rounded-full bg-[var(--sand)] px-2 py-0.5 text-xs font-semibold text-[var(--sea-ink-soft)]"
			}
		>
			{linked ? "Linked" : "Unclaimed"}
		</span>
	);
}

function DuplicateGroupCard({
	group,
	onMerged,
}: {
	group: DuplicateGroup;
	onMerged: () => void;
}) {
	// Keeper-default: linked accounts first, then more history — mirrors the
	// server's own `pickKeeper` heuristic so the pre-selected radio matches
	// what an admin would choose anyway.
	const sorted = [...group.people].sort(
		(a, b) =>
			Number(b.linked) - Number(a.linked) || b.historyCount - a.historyCount,
	);
	const [keeperId, setKeeperId] = useState(sorted[0]?.id ?? "");
	const keeper = sorted.find((p) => p.id === keeperId) ?? sorted[0];

	return (
		<div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-bold">{group.email}</h3>
				<span className="text-xs text-[var(--sea-ink-soft)]">
					{group.people.length} people
				</span>
			</div>
			<div className="space-y-2">
				{sorted.map((person) => (
					<div
						key={person.id}
						className={cn(
							"flex flex-wrap items-start gap-3 rounded-lg border p-3 text-sm",
							person.id === keeperId
								? "border-[var(--palm)] bg-[var(--foam)]"
								: "border-[var(--line)]",
						)}
					>
						<input
							type="radio"
							id={`keeper-${group.email}-${person.id}`}
							name={`keeper-${group.email}`}
							checked={person.id === keeperId}
							onChange={() => setKeeperId(person.id)}
							className="mt-1"
						/>
						<label
							htmlFor={`keeper-${group.email}-${person.id}`}
							className="flex-1 cursor-pointer space-y-0.5"
						>
							<span className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{person.name}</span>
								<LinkBadge linked={person.linked} />
							</span>
							<span className="block text-[var(--sea-ink-soft)]">
								{person.email ?? "no email"} ·{" "}
								{person.clubs.length > 0 ? person.clubs.join(", ") : "no club"}{" "}
								· {person.historyCount} in history
							</span>
						</label>
						{person.id === keeperId ? (
							<span className="shrink-0 self-center rounded-full bg-[var(--sand)] px-2.5 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] uppercase tracking-[0.04em]">
								Keeper
							</span>
						) : (
							<MergeConfirm
								keeperId={keeperId}
								keeperLabel={keeper?.name ?? "the keeper"}
								absorbedId={person.id}
								absorbedLabel={person.name}
								onMerged={onMerged}
							/>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

function ManualSearchSection({ onMerged }: { onMerged: () => void }) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<DuplicatePerson[]>([]);
	const [searching, setSearching] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const [keeperId, setKeeperId] = useState<string | null>(null);
	const trimmed = query.trim();

	async function runSearch() {
		if (trimmed.length < 2) return;
		setSearching(true);
		try {
			const found = await searchPeople({ data: trimmed });
			setResults(found);
			setHasSearched(true);
			setKeeperId((prev) =>
				prev != null && found.some((p) => p.id === prev)
					? prev
					: (found[0]?.id ?? null),
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Search failed.");
		} finally {
			setSearching(false);
		}
	}

	const keeper = results.find((p) => p.id === keeperId);

	return (
		<div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
			<h2 className="text-sm font-bold">Search for a merge candidate</h2>
			<p className="text-sm text-muted-foreground">
				The escape hatch for duplicates that don't share an email — a typo'd
				address, or a name entered two different ways.
			</p>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void runSearch();
				}}
			>
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search by name or email…"
					aria-label="Search for a merge candidate"
				/>
				<Button
					type="submit"
					size="sm"
					disabled={searching || trimmed.length < 2}
				>
					{searching ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Search className="size-4" />
					)}
					Search
				</Button>
			</form>
			{trimmed.length > 0 && trimmed.length < 2 ? (
				<p className="text-xs text-[var(--sea-ink-soft)]">
					Keep typing — 2+ characters to search.
				</p>
			) : null}

			{results.length > 0 ? (
				<div className="space-y-2">
					{results.map((person) => (
						<div
							key={person.id}
							className={cn(
								"flex flex-wrap items-start gap-3 rounded-lg border p-3 text-sm",
								person.id === keeperId
									? "border-[var(--palm)] bg-[var(--foam)]"
									: "border-[var(--line)]",
							)}
						>
							<input
								type="radio"
								id={`search-keeper-${person.id}`}
								name="search-keeper"
								checked={person.id === keeperId}
								onChange={() => setKeeperId(person.id)}
								className="mt-1"
							/>
							<label
								htmlFor={`search-keeper-${person.id}`}
								className="flex-1 cursor-pointer space-y-0.5"
							>
								<span className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{person.name}</span>
									<LinkBadge linked={person.linked} />
								</span>
								<span className="block text-[var(--sea-ink-soft)]">
									{person.email ?? "no email"} ·{" "}
									{person.clubs.length > 0
										? person.clubs.join(", ")
										: "no club"}{" "}
									· {person.historyCount} in history
								</span>
							</label>
							{person.id === keeperId ? (
								<span className="shrink-0 self-center rounded-full bg-[var(--sand)] px-2.5 py-1 text-xs font-semibold text-[var(--sea-ink-soft)] uppercase tracking-[0.04em]">
									Keeper
								</span>
							) : keeperId != null ? (
								<MergeConfirm
									keeperId={keeperId}
									keeperLabel={keeper?.name ?? "the keeper"}
									absorbedId={person.id}
									absorbedLabel={person.name}
									onMerged={() => {
										onMerged();
										void runSearch();
									}}
								/>
							) : null}
						</div>
					))}
				</div>
			) : hasSearched && !searching ? (
				<p className="text-sm text-muted-foreground">No matches.</p>
			) : null}
		</div>
	);
}

/**
 * Reusable merge confirm dialog: loads a `previewMerge` read on open, shows a
 * human sentence built from `movedCounts` (or the block reason, hard-disabling
 * Merge), and on confirm calls `mergePeopleFn` + `onMerged` (the caller's
 * `router.invalidate()`). Shared by the auto-detected groups and the manual
 * search results — both just supply the (keeper, absorbed) pair.
 */
function MergeConfirm({
	keeperId,
	keeperLabel,
	absorbedId,
	absorbedLabel,
	onMerged,
}: {
	keeperId: string;
	keeperLabel: string;
	absorbedId: string;
	absorbedLabel: string;
	onMerged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState<MergePreview | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function onOpenChange(next: boolean) {
		setOpen(next);
		if (!next) return;
		setPreview(null);
		setError(null);
		setLoading(true);
		try {
			const result = await previewMerge({ data: { keeperId, absorbedId } });
			setPreview(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load preview.");
		} finally {
			setLoading(false);
		}
	}

	async function onConfirm() {
		setBusy(true);
		try {
			await mergePeopleFn({
				data: { keeperPersonId: keeperId, absorbedPersonId: absorbedId },
			});
			toast.success(`Merged ${absorbedLabel} into ${keeperLabel}.`);
			setOpen(false);
			onMerged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Merge failed.");
		} finally {
			setBusy(false);
		}
	}

	const totalMemberships =
		(preview?.movedCounts.memberships ?? 0) +
		(preview?.movedCounts.collapsed ?? 0);

	return (
		<Dialog open={open} onOpenChange={(next) => void onOpenChange(next)}>
			<DialogTrigger asChild>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="shrink-0 self-center"
				>
					Merge into keeper
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						Merge {absorbedLabel} into {keeperLabel}?
					</DialogTitle>
					<DialogDescription>
						{keeperLabel} keeps their sign-in and history. {absorbedLabel} is
						removed.
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading preview…
					</p>
				) : error ? (
					<p className="text-sm text-[var(--danger-strong,#b91c1c)]">{error}</p>
				) : preview?.block ? (
					<p className="rounded-lg bg-[var(--danger,#dc2626)]/10 p-3 text-sm text-[var(--danger-strong,#b91c1c)]">
						{preview.block}
					</p>
				) : preview ? (
					<p className="text-sm text-muted-foreground">
						Moves {totalMemberships} membership
						{totalMemberships === 1 ? "" : "s"}, {preview.movedCounts.speeches}{" "}
						speech
						{preview.movedCounts.speeches === 1 ? "" : "es"}, and{" "}
						{preview.movedCounts.enrollments} enrollment
						{preview.movedCounts.enrollments === 1 ? "" : "s"} to the keeper.
						This can't be undone.
					</p>
				) : null}

				<DialogFooter showCloseButton>
					<Button
						type="button"
						onClick={() => void onConfirm()}
						disabled={busy || loading || !preview || Boolean(preview?.block)}
					>
						{busy ? <Loader2 className="size-4 animate-spin" /> : "Merge"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
