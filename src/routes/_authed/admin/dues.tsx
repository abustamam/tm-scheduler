import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { CalendarPlus, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import {
	centsToInput,
	dollarsToCents,
	formatCents,
	nextRenewalDate,
	renewalLabel,
	TI_RENEWAL_PRESETS,
	toDateInputValue,
} from "#/lib/dues";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatShortDate } from "#/lib/format";
import { cn } from "#/lib/utils";
import {
	createDuesPeriod,
	deleteDuesPeriod,
	getDuesForPeriod,
	getDuesOverview,
	recordDuesPayment,
	undoDues,
	waiveDues,
} from "#/server/dues";
import type {
	DuesPeriod,
	DuesTotals,
	MemberDuesRow,
	OverdueDuesRow,
} from "#/server/dues-logic";

export const Route = createFileRoute("/_authed/admin/dues")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) {
			return {
				clubId: null as string | null,
				periods: [] as DuesPeriod[],
				activePeriodId: null as string | null,
				overdue: [] as OverdueDuesRow[],
				initial: null as { rows: MemberDuesRow[]; totals: DuesTotals } | null,
			};
		}
		const overview = await getDuesOverview({ data: { clubId: club.clubId } });
		const initial = overview.activePeriodId
			? await getDuesForPeriod({
					data: { clubId: club.clubId, periodId: overview.activePeriodId },
				})
			: null;
		return { clubId: club.clubId, ...overview, initial };
	},
	component: DuesTracker,
});

function DuesTracker() {
	const { clubId, periods, activePeriodId, overdue, initial } =
		Route.useLoaderData();
	const router = useRouter();

	const [selectedId, setSelectedId] = useState<string | null>(activePeriodId);
	const [periodData, setPeriodData] = useState<{
		rows: MemberDuesRow[];
		totals: DuesTotals;
	} | null>(initial);
	const [loading, setLoading] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [recordFor, setRecordFor] = useState<MemberDuesRow | null>(null);
	// Tracks which period `periodData` currently reflects, so the initial (loader-
	// provided) period isn't re-fetched and selection changes are.
	const loadedRef = useRef<string | null>(activePeriodId);

	const selectedPeriod = periods.find((p) => p.id === selectedId) ?? null;

	const reloadSelected = useCallback(async () => {
		if (!clubId || !selectedId) {
			setPeriodData(null);
			return;
		}
		setLoading(true);
		try {
			const data = await getDuesForPeriod({
				data: { clubId, periodId: selectedId },
			});
			setPeriodData(data);
			loadedRef.current = selectedId;
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't load that period.",
			);
		} finally {
			setLoading(false);
		}
	}, [clubId, selectedId]);

	// Fetch the roster/totals when the user picks a different period (the initial
	// one is already loaded by the route loader).
	useEffect(() => {
		if (!clubId || !selectedId) {
			setPeriodData(null);
			return;
		}
		if (loadedRef.current === selectedId) return;
		let cancelled = false;
		setLoading(true);
		getDuesForPeriod({ data: { clubId, periodId: selectedId } })
			.then((data) => {
				if (cancelled) return;
				setPeriodData(data);
				loadedRef.current = selectedId;
			})
			.catch((err) => {
				if (cancelled) return;
				toast.error(
					err instanceof Error ? err.message : "Couldn't load that period.",
				);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [clubId, selectedId]);

	// Keep the selection valid after a period is deleted.
	useEffect(() => {
		if (selectedId && !periods.some((p) => p.id === selectedId)) {
			setSelectedId(activePeriodId);
		}
	}, [periods, selectedId, activePeriodId]);

	async function afterMutation() {
		await reloadSelected();
		await router.invalidate();
	}

	async function handleWaive(row: MemberDuesRow) {
		if (!clubId || !selectedId) return;
		try {
			await waiveDues({
				data: { clubId, periodId: selectedId, membershipId: row.membershipId },
			});
			toast.success(`Waived dues for ${row.name}.`);
			await afterMutation();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	async function handleUndo(row: MemberDuesRow) {
		if (!clubId || !selectedId) return;
		try {
			await undoDues({
				data: { clubId, periodId: selectedId, membershipId: row.membershipId },
			});
			toast.success(`Reset ${row.name} to unpaid.`);
			await afterMutation();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	async function handleDeletePeriod() {
		if (!clubId || !selectedPeriod) return;
		if (
			!window.confirm(
				`Delete the "${selectedPeriod.label}" period? This removes its payment records.`,
			)
		) {
			return;
		}
		try {
			await deleteDuesPeriod({
				data: { clubId, periodId: selectedPeriod.id },
			});
			toast.success("Dues period deleted.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	const totals = periodData?.totals;
	const rows = periodData?.rows ?? [];

	return (
		<PageContainer className="space-y-6">
			{/* Header */}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Dues
					</h1>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Track who has paid membership dues each period. Status only — no
						money moves here, and paying (or not) never changes a member's
						roster status.
					</p>
				</div>
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="size-4" /> New period
				</Button>
			</div>

			{periods.length === 0 ? (
				<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-12 text-center">
					<CalendarPlus
						className="mx-auto size-8 text-[var(--sea-ink-soft)] opacity-50"
						aria-hidden
					/>
					<p className="mt-3 text-sm font-semibold">No dues periods yet</p>
					<p className="mx-auto mt-1 max-w-md text-xs text-[var(--sea-ink-soft)]">
						Create a period to start tracking dues. Toastmasters renews
						semi-annually — the Apr 1 / Oct 1 presets are one click.
					</p>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						<Plus className="size-4" /> New period
					</Button>
				</div>
			) : (
				<>
					{/* Period selector */}
					<div className="flex flex-wrap items-center gap-3">
						<Label
							htmlFor="dues-period"
							className="text-xs font-bold uppercase tracking-[0.04em] text-[var(--sea-ink-soft)]"
						>
							Period
						</Label>
						<select
							id="dues-period"
							value={selectedId ?? ""}
							onChange={(e) => setSelectedId(e.target.value || null)}
							className="h-9 rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium outline-none focus-visible:border-[var(--lagoon-deep)]"
						>
							{periods.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label} · due {formatShortDate(p.dueDate)}
								</option>
							))}
						</select>
						{selectedPeriod ? (
							<Button
								variant="ghost"
								size="sm"
								className="text-[var(--sea-ink-soft)]"
								onClick={handleDeletePeriod}
							>
								Delete period
							</Button>
						) : null}
					</div>

					{/* Totals */}
					{totals ? (
						<div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
							<StatCard label="Paid" value={String(totals.paid)} />
							<StatCard label="Waived" value={String(totals.waived)} />
							<StatCard
								label="Unpaid"
								value={String(totals.unpaid)}
								amber={totals.unpaid > 0}
							/>
							<StatCard
								label="Collected"
								value={formatCents(totals.collectedCents)}
								note="from entered amounts"
							/>
						</div>
					) : null}

					{/* Roster */}
					<Section
						title="Members"
						subtitle="Active members and their status for the selected period."
					>
						{loading && rows.length === 0 ? (
							<EmptyRow>Loading…</EmptyRow>
						) : rows.length === 0 ? (
							<EmptyRow>No active members.</EmptyRow>
						) : (
							rows.map((row) => (
								<MemberRow
									key={row.membershipId}
									row={row}
									onRecord={() => setRecordFor(row)}
									onWaive={() => handleWaive(row)}
									onUndo={() => handleUndo(row)}
								/>
							))
						)}
					</Section>
				</>
			)}

			{/* Overdue */}
			<Section
				title="Overdue"
				subtitle="Active members with no paid or waived record for a period whose due date has passed."
			>
				{overdue.length === 0 ? (
					<EmptyRow>Nobody is overdue. 🎉</EmptyRow>
				) : (
					overdue.map((row) => <OverdueRow key={row.membershipId} row={row} />)
				)}
			</Section>

			{clubId ? (
				<CreatePeriodDialog
					open={createOpen}
					onOpenChange={setCreateOpen}
					clubId={clubId}
					onCreated={async (id) => {
						setSelectedId(id);
						loadedRef.current = null;
						await router.invalidate();
					}}
				/>
			) : null}

			{clubId && selectedId && recordFor ? (
				<RecordPaymentDialog
					clubId={clubId}
					periodId={selectedId}
					member={recordFor}
					defaultAmountCents={selectedPeriod?.defaultAmountCents ?? null}
					hasNextPeriod={
						!!selectedPeriod &&
						periods.some(
							(p) =>
								new Date(p.dueDate).getTime() >
								new Date(selectedPeriod.dueDate).getTime(),
						)
					}
					onClose={() => setRecordFor(null)}
					onDone={async () => {
						setRecordFor(null);
						await afterMutation();
					}}
				/>
			) : null}
		</PageContainer>
	);
}

// ---------------------------------------------------------------------------
// Rows & cards
// ---------------------------------------------------------------------------

function StatCard({
	label,
	value,
	note,
	amber,
}: {
	label: string;
	value: string;
	note?: string;
	amber?: boolean;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border bg-[var(--surface-strong)] px-4 py-4 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)]",
				amber ? "border-[var(--warning)]" : "border-[var(--line)]",
			)}
		>
			<div className="text-xs font-bold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
				{label}
			</div>
			<div className="mt-2 flex items-baseline gap-2">
				<span
					className={cn(
						"font-display text-3xl leading-none font-semibold",
						amber && "text-[var(--warning-strong)]",
					)}
				>
					{value}
				</span>
				{note ? (
					<span className="text-xs text-[var(--sea-ink-soft)]">{note}</span>
				) : null}
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

function EmptyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-5 py-10 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</p>
	);
}

function StatusBadge({ status }: { status: MemberDuesRow["status"] }) {
	if (status === "paid") {
		return (
			<Badge className="bg-[var(--success,#0f766e)] text-white">Paid</Badge>
		);
	}
	if (status === "waived") {
		return <Badge variant="secondary">Waived</Badge>;
	}
	return <Badge variant="outline">Unpaid</Badge>;
}

function MemberRow({
	row,
	onRecord,
	onWaive,
	onUndo,
}: {
	row: MemberDuesRow;
	onRecord: () => void;
	onWaive: () => void;
	onUndo: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-3 last:border-b-0">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<MemberAvatar
					tone={toneFromSeed(row.membershipId)}
					initials={initialsOf(row.name)}
					size={36}
				/>
				<div className="min-w-0 leading-[1.25]">
					<div className="truncate text-sm font-bold">{row.name}</div>
					<div className="text-xs text-[var(--sea-ink-soft)]">
						{row.status === "paid"
							? `${formatCents(row.amountCents)}${
									row.paidAt ? ` · ${formatShortDate(row.paidAt)}` : ""
								}`
							: row.status === "waived"
								? "Waived"
								: "No payment recorded"}
					</div>
				</div>
			</div>
			<StatusBadge status={row.status} />
			<div className="flex shrink-0 items-center gap-2">
				{row.status === null ? (
					<>
						<Button size="sm" onClick={onRecord}>
							Record
						</Button>
						<Button size="sm" variant="outline" onClick={onWaive}>
							Waive
						</Button>
					</>
				) : (
					<Button size="sm" variant="ghost" onClick={onUndo}>
						Undo
					</Button>
				)}
			</div>
		</div>
	);
}

function OverdueRow({ row }: { row: OverdueDuesRow }) {
	return (
		<Link
			to="/members/$id"
			params={{ id: row.membershipId }}
			className="group flex items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--foam)]"
		>
			<MemberAvatar
				tone={toneFromSeed(row.membershipId)}
				initials={initialsOf(row.name)}
				size={36}
			/>
			<div className="min-w-0 flex-1 leading-[1.25]">
				<div className="truncate text-sm font-bold">{row.name}</div>
				<div className="truncate text-xs text-[var(--warning-strong)]">
					Owes: {row.owedPeriods.map((p) => p.label).join(", ")}
				</div>
			</div>
			<ChevronRight
				className="size-4 shrink-0 text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
				aria-hidden
			/>
		</Link>
	);
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function CreatePeriodDialog({
	open,
	onOpenChange,
	clubId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clubId: string;
	onCreated: (id: string) => void | Promise<void>;
}) {
	const [label, setLabel] = useState("");
	const [dueDate, setDueDate] = useState("");
	const [amount, setAmount] = useState("");
	const [busy, setBusy] = useState(false);

	function reset() {
		setLabel("");
		setDueDate("");
		setAmount("");
	}

	function applyPreset(key: "apr" | "oct") {
		const preset = TI_RENEWAL_PRESETS.find((p) => p.key === key);
		if (!preset) return;
		const date = nextRenewalDate(preset);
		setDueDate(toDateInputValue(date));
		setLabel(renewalLabel(preset, date));
	}

	async function handleSubmit() {
		if (!label.trim() || !dueDate) {
			toast.error("A label and due date are required.");
			return;
		}
		let amountCents: number | null;
		try {
			amountCents = dollarsToCents(amount);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Invalid amount.");
			return;
		}
		setBusy(true);
		try {
			const res = await createDuesPeriod({
				data: {
					clubId,
					label: label.trim(),
					dueDate,
					defaultAmountCents: amountCents,
				},
			});
			toast.success("Dues period created.");
			reset();
			onOpenChange(false);
			await onCreated(res.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[460px]">
				<DialogHeader>
					<DialogTitle>New dues period</DialogTitle>
					<DialogDescription>
						Periods are yours to define — annual, semi-annual, or custom. Use a
						preset for the Toastmasters renewal dates.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="flex gap-2">
						{TI_RENEWAL_PRESETS.map((p) => (
							<Button
								key={p.key}
								type="button"
								variant="outline"
								size="sm"
								onClick={() => applyPreset(p.key)}
							>
								{p.short} renewal
							</Button>
						))}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="period-label">Label</Label>
						<Input
							id="period-label"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="2026 Apr 1 renewal"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="period-due">Due date</Label>
						<Input
							id="period-due"
							type="date"
							value={dueDate}
							onChange={(e) => setDueDate(e.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="period-amount">Default amount (optional)</Label>
						<Input
							id="period-amount"
							inputMode="decimal"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							placeholder="e.g. 45.00"
						/>
					</div>
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button onClick={handleSubmit} disabled={busy}>
						{busy ? "Creating…" : "Create period"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function RecordPaymentDialog({
	clubId,
	periodId,
	member,
	defaultAmountCents,
	hasNextPeriod,
	onClose,
	onDone,
}: {
	clubId: string;
	periodId: string;
	member: MemberDuesRow;
	defaultAmountCents: number | null;
	hasNextPeriod: boolean;
	onClose: () => void;
	onDone: () => void | Promise<void>;
}) {
	const [amount, setAmount] = useState(centsToInput(defaultAmountCents));
	const [fullYear, setFullYear] = useState(false);
	const [busy, setBusy] = useState(false);

	async function handleSubmit() {
		let amountCents: number | null;
		try {
			amountCents = dollarsToCents(amount);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Invalid amount.");
			return;
		}
		if (fullYear && !hasNextPeriod) {
			toast.error(
				"There's no next period to pre-pay. Create the following period first.",
			);
			return;
		}
		setBusy(true);
		try {
			await recordDuesPayment({
				data: {
					clubId,
					periodId,
					membershipId: member.membershipId,
					amountCents,
					fullYear,
					// Split the same amount onto the next period's row; leave blank to
					// record status only.
					nextAmountCents: fullYear ? amountCents : null,
				},
			});
			toast.success(
				fullYear
					? `Recorded a full-year payment for ${member.name}.`
					: `Recorded payment for ${member.name}.`,
			);
			await onDone();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>Record payment</DialogTitle>
					<DialogDescription>
						{member.name} — mark this period paid. Amount is optional.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="pay-amount">Amount (optional)</Label>
						<Input
							id="pay-amount"
							inputMode="decimal"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
							placeholder="e.g. 45.00"
						/>
					</div>
					<label className="flex items-center gap-2.5 text-sm">
						<input
							type="checkbox"
							checked={fullYear}
							onChange={(e) => setFullYear(e.target.checked)}
							disabled={!hasNextPeriod}
							className="size-4 rounded border-[var(--line)]"
						/>
						<span>
							Pay full year (this period + the next)
							{!hasNextPeriod ? (
								<span className="block text-xs text-[var(--sea-ink-soft)]">
									Create the following period to enable full-year.
								</span>
							) : null}
						</span>
					</label>
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="ghost" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button onClick={handleSubmit} disabled={busy}>
						{busy ? "Recording…" : "Record payment"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
