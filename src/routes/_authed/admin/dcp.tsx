import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Award, Check, Trophy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	currentProgramYear,
	DCP_GOALS,
	type DcpGoal,
	type DcpGoalCategory,
	programYearLabel,
	tierLabel,
} from "#/lib/dcp";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { cn } from "#/lib/utils";
import {
	getScoreboard,
	getScoreboardYears,
	startScoreboard,
	updateBaseMemberCount,
	updateGoal,
} from "#/server/dcp";
import type { DcpScoreboardView } from "#/server/dcp-logic";

const CATEGORY_LABEL: Record<DcpGoalCategory, string> = {
	education: "Education",
	membership: "Membership",
	training: "Training",
	administration: "Administration",
};
const CATEGORY_ORDER: DcpGoalCategory[] = [
	"education",
	"membership",
	"training",
	"administration",
];

export const Route = createFileRoute("/_authed/admin/dcp")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/roster" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) {
			return {
				clubId: null as string | null,
				year: currentProgramYear(),
				view: null as DcpScoreboardView | null,
				years: [] as number[],
			};
		}
		const year = currentProgramYear();
		const [view, years] = await Promise.all([
			getScoreboard({ data: { clubId: club.clubId, programYear: year } }),
			getScoreboardYears({ data: { clubId: club.clubId } }),
		]);
		return { clubId: club.clubId, year, view, years };
	},
	component: DcpTracker,
});

function DcpTracker() {
	const loaded = Route.useLoaderData();
	const router = useRouter();
	const clubId = loaded.clubId;

	const [year, setYear] = useState(loaded.year);
	const [view, setView] = useState<DcpScoreboardView | null>(loaded.view);
	const [loading, setLoading] = useState(false);
	const loadedYearRef = useRef(loaded.year);

	// Year options: every started year plus the current one, newest first.
	const yearOptions = Array.from(
		new Set([currentProgramYear(), ...loaded.years, year]),
	).sort((a, b) => b - a);

	const reload = useCallback(async () => {
		if (!clubId) return;
		setLoading(true);
		try {
			const v = await getScoreboard({ data: { clubId, programYear: year } });
			setView(v);
			loadedYearRef.current = year;
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't load the year.",
			);
		} finally {
			setLoading(false);
		}
	}, [clubId, year]);

	// Refetch when the admin picks a different program year.
	useEffect(() => {
		if (!clubId || loadedYearRef.current === year) return;
		reload();
	}, [clubId, year, reload]);

	async function handleStart() {
		if (!clubId) return;
		setLoading(true);
		try {
			const v = await startScoreboard({ data: { clubId, programYear: year } });
			setView(v);
			loadedYearRef.current = year;
			toast.success(`Started the ${programYearLabel(year)} scoreboard.`);
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't start the year.",
			);
		} finally {
			setLoading(false);
		}
	}

	async function handleGoal(goal: DcpGoal, achieved: number) {
		if (!clubId) return;
		try {
			await updateGoal({
				data: { clubId, programYear: year, goalKey: goal.key, achieved },
			});
			await reload();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't save that goal.",
			);
		}
	}

	async function handleBase(baseMemberCount: number | null) {
		if (!clubId) return;
		try {
			await updateBaseMemberCount({
				data: { clubId, programYear: year, baseMemberCount },
			});
			await reload();
			toast.success("Baseline updated.");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't update the base.",
			);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Distinguished Club Program
					</h1>
					<p className="mt-1 max-w-2xl text-sm text-[var(--sea-ink-soft)]">
						Track the club's 10 DCP goals for the program year. Enter progress
						by hand — the two new-member goals are pre-filled from the roster.
						The recognition tier and membership base update as you go.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Label
						htmlFor="dcp-year"
						className="text-xs font-bold uppercase tracking-[0.04em] text-[var(--sea-ink-soft)]"
					>
						Year
					</Label>
					<select
						id="dcp-year"
						value={year}
						onChange={(e) => setYear(Number(e.target.value))}
						className="h-9 rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium outline-none focus-visible:border-[var(--lagoon-deep)]"
					>
						{yearOptions.map((y) => (
							<option key={y} value={y}>
								{programYearLabel(y)}
							</option>
						))}
					</select>
				</div>
			</div>

			{!clubId ? (
				<EmptyCard>Select a club to track its DCP goals.</EmptyCard>
			) : !view || !view.exists ? (
				<StartCard
					year={year}
					view={view}
					loading={loading}
					onStart={handleStart}
				/>
			) : (
				<>
					<SummaryHeadline view={view} />
					<BaseCard view={view} onSave={handleBase} />
					{CATEGORY_ORDER.map((cat) => (
						<GoalGroup
							key={cat}
							category={cat}
							view={view}
							onGoal={handleGoal}
						/>
					))}
				</>
			)}
		</PageContainer>
	);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function EmptyCard({ children }: { children: React.ReactNode }) {
	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-12 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</div>
	);
}

function StartCard({
	year,
	view,
	loading,
	onStart,
}: {
	year: number;
	view: DcpScoreboardView | null;
	loading: boolean;
	onStart: () => void;
}) {
	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-12 text-center">
			<Trophy
				className="mx-auto size-8 text-[var(--sea-ink-soft)] opacity-50"
				aria-hidden
			/>
			<p className="mt-3 text-sm font-semibold">
				No {programYearLabel(year)} scoreboard yet
			</p>
			<p className="mx-auto mt-1 max-w-md text-xs text-[var(--sea-ink-soft)]">
				Start the scoreboard to seed the 10 goals. We'll snapshot the current
				active-member count as this year's baseline
				{view ? ` (${view.currentActive} active)` : ""} and pre-fill the
				new-member goals
				{view ? ` (${view.newMemberCount} joined so far)` : ""}.
			</p>
			<Button className="mt-4" onClick={onStart} disabled={loading}>
				{loading ? "Starting…" : `Start ${programYearLabel(year)} scoreboard`}
			</Button>
		</div>
	);
}

function SummaryHeadline({ view }: { view: DcpScoreboardView }) {
	const { summary } = view;
	const tier = summary.tier ? tierLabel(summary.tier) : null;
	return (
		<div
			className={cn(
				"rounded-2xl border bg-[var(--surface-strong)] px-6 py-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]",
				tier ? "border-[var(--lagoon-deep)]" : "border-[var(--line)]",
			)}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-baseline gap-3">
					<span className="font-display text-4xl font-semibold leading-none">
						{summary.goalsMet}
						<span className="text-2xl text-[var(--sea-ink-soft)]">/10</span>
					</span>
					<span className="text-sm font-semibold text-[var(--sea-ink-soft)]">
						goals met
					</span>
				</div>
				{tier ? (
					<Badge className="gap-1 bg-[var(--lagoon-deep)] text-white">
						<Award className="size-3.5" /> {tier}
					</Badge>
				) : (
					<span className="text-sm text-[var(--sea-ink-soft)]">
						{summary.goalsToDistinguished > 0
							? `${summary.goalsToDistinguished} more for Distinguished`
							: "Goals met — needs the membership base"}
					</span>
				)}
			</div>
			{!summary.baseMet ? (
				<p className="mt-2 text-xs text-[var(--warning-strong)]">
					Membership base not yet met — a tier needs 20+ active members or net
					growth of +5.
				</p>
			) : null}
		</div>
	);
}

function BaseCard({
	view,
	onSave,
}: {
	view: DcpScoreboardView;
	onSave: (value: number | null) => void;
}) {
	const [value, setValue] = useState(
		view.baseMemberCount == null ? "" : String(view.baseMemberCount),
	);
	useEffect(() => {
		setValue(view.baseMemberCount == null ? "" : String(view.baseMemberCount));
	}, [view.baseMemberCount]);

	const net =
		view.baseMemberCount == null
			? null
			: view.currentActive - view.baseMemberCount;

	function save() {
		const trimmed = value.trim();
		if (trimmed === "") {
			onSave(null);
			return;
		}
		const n = Number(trimmed);
		if (!Number.isInteger(n) || n < 0) {
			toast.error("Enter a whole number of members.");
			return;
		}
		onSave(n);
	}

	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-4">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="flex flex-wrap items-center gap-6">
					<Stat label="Active now" value={String(view.currentActive)} />
					<div className="space-y-1.5">
						<Label
							htmlFor="dcp-base"
							className="text-xs font-bold uppercase tracking-[0.04em] text-[var(--sea-ink-soft)]"
						>
							Baseline (Jul 1)
						</Label>
						<Input
							id="dcp-base"
							inputMode="numeric"
							className="h-9 w-28"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							onBlur={save}
							placeholder="—"
						/>
					</div>
					<Stat
						label="Net growth"
						value={net == null ? "—" : net >= 0 ? `+${net}` : String(net)}
					/>
				</div>
				<Badge variant={view.summary.baseMet ? "default" : "outline"}>
					{view.summary.baseMet ? "Base met" : "Base not met"}
				</Badge>
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs font-bold uppercase tracking-[0.04em] text-[var(--sea-ink-soft)]">
				{label}
			</div>
			<div className="mt-1 font-display text-2xl font-semibold leading-none">
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function GoalGroup({
	category,
	view,
	onGoal,
}: {
	category: DcpGoalCategory;
	view: DcpScoreboardView;
	onGoal: (goal: DcpGoal, achieved: number) => void;
}) {
	const goals = DCP_GOALS.filter((g) => g.category === category);
	return (
		<div>
			<h2 className="mb-2 text-sm font-bold tracking-[-0.01em]">
				{CATEGORY_LABEL[category]}
			</h2>
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]">
				{goals.map((g) => (
					<GoalRow
						key={g.key}
						goal={g}
						achieved={view.progress[g.key] ?? 0}
						onGoal={onGoal}
					/>
				))}
			</div>
		</div>
	);
}

function GoalRow({
	goal,
	achieved,
	onGoal,
}: {
	goal: DcpGoal;
	achieved: number;
	onGoal: (goal: DcpGoal, achieved: number) => void;
}) {
	const met = achieved >= goal.target;
	const [draft, setDraft] = useState(String(achieved));
	useEffect(() => setDraft(String(achieved)), [achieved]);

	function saveCount() {
		const n = Number(draft.trim());
		if (!Number.isInteger(n) || n < 0) {
			setDraft(String(achieved));
			toast.error("Enter a whole number.");
			return;
		}
		if (n !== achieved) onGoal(goal, n);
	}

	return (
		<div className="flex flex-wrap items-center gap-3 border-b border-[var(--line)] px-5 py-3 last:border-b-0">
			<div
				className={cn(
					"flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
					met
						? "border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white"
						: "border-[var(--line)] text-[var(--sea-ink-soft)]",
				)}
				aria-hidden
			>
				{met ? <Check className="size-3.5" /> : null}
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-semibold">{goal.label}</div>
				{!goal.composite ? (
					<div className="text-xs text-[var(--sea-ink-soft)]">
						Target {goal.target}
					</div>
				) : null}
			</div>
			{goal.composite ? (
				<Button
					size="sm"
					variant={met ? "default" : "outline"}
					onClick={() => onGoal(goal, met ? 0 : 1)}
				>
					{met ? "Met" : "Mark met"}
				</Button>
			) : (
				<div className="flex items-center gap-2">
					<Input
						inputMode="numeric"
						aria-label={`${goal.label} achieved`}
						className="h-9 w-20 text-center"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={saveCount}
					/>
					<Badge variant={met ? "default" : "outline"}>
						{met ? "Met" : "Open"}
					</Badge>
				</div>
			)}
		</div>
	);
}
