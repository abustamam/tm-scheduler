import { Trophy } from "lucide-react";
import { useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { cn } from "#/lib/utils";
import type { PathViewModel } from "#/server/pathways-read-logic";

// Fixed locale (not the runtime default) so SSR and client render the same
// string for `deliveredAt` — avoids adding to the known hydration warning
// from locale-dependent date formatting on the member-detail route.
const WIN_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	month: "short",
	year: "numeric",
});

/** Format a win's `deliveredAt`, tolerating either a `Date` or an ISO string
 * (server-fn boundaries can serialize dates to strings). */
function formatWinDate(
	deliveredAt: PathViewModel["wins"][number]["deliveredAt"],
) {
	if (!deliveredAt) return null;
	const d = deliveredAt instanceof Date ? deliveredAt : new Date(deliveredAt);
	if (Number.isNaN(d.getTime())) return null;
	return WIN_DATE_FORMAT.format(d);
}

const RING_SIZE = 100;
const RING_STROKE = 8;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Circular progress ring with a centered `NN%` label. */
function ProgressRing({ percent }: { percent: number }) {
	const clamped = Math.max(0, Math.min(100, percent));
	const offset = RING_CIRCUMFERENCE * (1 - clamped / 100);
	return (
		<div
			className="relative shrink-0"
			style={{ width: RING_SIZE, height: RING_SIZE }}
		>
			<svg
				width={RING_SIZE}
				height={RING_SIZE}
				viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
				className="-rotate-90"
				role="img"
				aria-label={`${clamped}% complete`}
			>
				<circle
					cx={RING_SIZE / 2}
					cy={RING_SIZE / 2}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={RING_STROKE}
					className="stroke-muted"
				/>
				<circle
					cx={RING_SIZE / 2}
					cy={RING_SIZE / 2}
					r={RING_RADIUS}
					fill="none"
					strokeWidth={RING_STROKE}
					strokeLinecap="round"
					className="stroke-primary transition-[stroke-dashoffset]"
					strokeDasharray={RING_CIRCUMFERENCE}
					strokeDashoffset={offset}
				/>
			</svg>
			<div className="absolute inset-0 flex items-center justify-center font-semibold text-foreground text-lg">
				{clamped}%
			</div>
		</div>
	);
}

/** Small badges, one per level: filled (approved), outline-accent (current), muted (upcoming). */
function LevelChips({
	levels,
	currentLevel,
}: {
	levels: PathViewModel["levels"];
	currentLevel: number | null;
}) {
	return (
		<div className="flex flex-wrap gap-1.5">
			{levels.map((l) => {
				const isCurrent = l.level === currentLevel;
				return (
					<Badge
						key={l.level}
						variant={l.approved ? "default" : "outline"}
						className={cn(
							!l.approved && isCurrent && "border-primary text-foreground",
							!l.approved &&
								!isCurrent &&
								"border-transparent bg-muted text-muted-foreground",
						)}
					>
						L{l.level}
						{l.approved ? " ✓" : ""}
					</Badge>
				);
			})}
		</div>
	);
}

/** "Level N · X of Y" bar for the in-progress level. */
function CurrentLevelBar({
	currentLevel,
	levels,
}: {
	currentLevel: number;
	levels: PathViewModel["levels"];
}) {
	const entry = levels.find((l) => l.level === currentLevel);
	if (!entry) return null;
	const completed = Math.min(entry.completed, entry.total);
	const fraction = entry.total === 0 ? 0 : completed / entry.total;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-muted-foreground text-sm">
				Level {currentLevel} · {completed} of {entry.total}
			</div>
			<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-primary"
					style={{ width: `${Math.round(fraction * 100)}%` }}
				/>
			</div>
		</div>
	);
}

/** Named list of the person's delivered speeches matched to catalog projects. */
function YourWins({ wins }: { wins: PathViewModel["wins"] }) {
	if (wins.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			<div className="font-medium text-foreground text-sm">Your wins</div>
			<ul className="flex flex-col gap-2">
				{wins.map((w, i) => {
					const dateLabel = formatWinDate(w.deliveredAt);
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: wins have no stable id; name+level can repeat across levels in theory
							key={`${w.level}-${w.name}-${i}`}
							className="flex items-start gap-2 rounded-md bg-primary/10 px-3 py-2"
						>
							<Trophy className="mt-0.5 size-4 shrink-0 text-primary" />
							<div className="flex min-w-0 flex-col">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<span className="font-medium text-foreground text-sm">
										{w.name}
									</span>
									<span className="text-muted-foreground text-xs">
										Level {w.level}
									</span>
								</div>
								{(w.speechTitle || dateLabel) && (
									<span className="text-muted-foreground text-xs">
										{w.speechTitle}
										{w.speechTitle && dateLabel ? " · " : ""}
										{dateLabel}
									</span>
								)}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** Named current-level catalog projects not yet won — the specific layer
 * beneath the count bar. Never phrased as a deficiency. Electives (from the
 * /detail mirror) collapse into a "choose N more" group. */
function UpNext({
	upNext,
	electives,
}: {
	upNext: PathViewModel["upNext"];
	electives: PathViewModel["upNextElectives"];
}) {
	const hasElectives = electives != null && electives.options.length > 0;
	if (upNext.length === 0 && !hasElectives) return null;
	return (
		<div className="flex flex-col gap-2">
			<div className="font-medium text-foreground text-sm">Up next</div>
			{upNext.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{upNext.map((p) => (
						<Badge
							key={p.name}
							variant={p.isRequired ? "default" : "outline"}
							className={cn(
								!p.isRequired && "font-normal text-muted-foreground",
							)}
						>
							{p.name}
							{p.isRequired && (
								<span className="ml-1 opacity-80">Required</span>
							)}
						</Badge>
					))}
				</div>
			)}
			{hasElectives && (
				<div className="flex flex-col gap-1.5">
					<div className="text-muted-foreground text-xs">
						Choose {electives.chooseCount} more elective
						{electives.chooseCount === 1 ? "" : "s"}:
					</div>
					<div className="flex flex-wrap gap-1.5">
						{electives.options.map((name) => (
							<Badge
								key={name}
								variant="outline"
								className="font-normal text-muted-foreground"
							>
								{name}
							</Badge>
						))}
					</div>
				</div>
			)}
			<div className="text-muted-foreground text-xs">
				Do it in Base Camp — it'll sync here.
			</div>
		</div>
	);
}

/** One path's ring + chips + current-level (or complete) block, plus the
 * named wins and up-next layers. */
function PathBlock({ path }: { path: PathViewModel }) {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
				<ProgressRing percent={path.ringPercent} />
				<div className="flex min-w-0 flex-1 flex-col gap-3">
					<LevelChips levels={path.levels} currentLevel={path.currentLevel} />
					{path.complete ? (
						<div className="font-medium text-foreground text-sm">
							Path complete 🎉
						</div>
					) : path.currentLevel !== null ? (
						<CurrentLevelBar
							currentLevel={path.currentLevel}
							levels={path.levels}
						/>
					) : null}
				</div>
			</div>
			<YourWins wins={path.wins} />
			{!path.complete && (
				<UpNext upNext={path.upNext} electives={path.upNextElectives} />
			)}
		</div>
	);
}

/**
 * Renders a member's synced Pathways progress: a ring, level chips, and a
 * current-level progress bar per path. Pure presentational — takes view
 * models as a prop, does no data fetching. Zero paths render a muted empty
 * state; multiple paths get a tab switcher across path names.
 */
export function PathwaysProgress({ paths }: { paths: PathViewModel[] }) {
	const [active, setActive] = useState(paths[0]?.courseCode);

	if (paths.length === 0) {
		return (
			<Card>
				<CardContent className="text-muted-foreground text-sm">
					No Pathways synced yet.
				</CardContent>
			</Card>
		);
	}

	if (paths.length === 1) {
		return (
			<Card>
				<CardContent>
					<PathBlock path={paths[0]} />
				</CardContent>
			</Card>
		);
	}

	const selected = active ?? paths[0].courseCode;

	return (
		<Card>
			<CardContent>
				<Tabs value={selected} onValueChange={setActive}>
					<TabsList>
						{paths.map((p) => (
							<TabsTrigger key={p.courseCode} value={p.courseCode}>
								{p.pathName}
							</TabsTrigger>
						))}
					</TabsList>
					{paths.map((p) => (
						<TabsContent key={p.courseCode} value={p.courseCode}>
							<PathBlock path={p} />
						</TabsContent>
					))}
				</Tabs>
			</CardContent>
		</Card>
	);
}
