import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	generateOccurrences,
	MAX_BATCH,
	type Occurrence,
	ORDINAL_OPTIONS,
	type Ordinal,
	type RecurrenceInput,
	WEEKDAY_LABELS,
	type Weekday,
} from "#/lib/meeting-recurrence";
import {
	batchCreateMeetings,
	getClubMeetingDates,
} from "#/server/batch-meetings";

export const Route = createFileRoute("/_authed/admin/meetings/batch")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const existingDates = await getClubMeetingDates({
			data: context.adminClub.clubId,
		});
		return { existingDates };
	},
	component: BatchMeetings,
});

const selectClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Mode = "interval" | "monthly";
type BoundKind = "count" | "until";

function BatchMeetings() {
	const { adminClub } = Route.useRouteContext();
	const { existingDates } = Route.useLoaderData();
	const router = useRouter();
	const existing = useMemo(() => new Set(existingDates), [existingDates]);

	const [mode, setMode] = useState<Mode>("interval");
	const [weekday, setWeekday] = useState<Weekday>(2);
	const [intervalWeeks, setIntervalWeeks] = useState(1);
	const [ordinals, setOrdinals] = useState<Ordinal[]>([2, 4]);
	const [startDate, setStartDate] = useState("");
	const [timeOfDay, setTimeOfDay] = useState("19:00");
	const [boundKind, setBoundKind] = useState<BoundKind>("count");
	const [count, setCount] = useState(12);
	const [until, setUntil] = useState("");
	const [location, setLocation] = useState("");

	const [preview, setPreview] = useState<Occurrence[] | null>(null);
	const [clamped, setClamped] = useState(false);
	const [removed, setRemoved] = useState<Set<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);

	function onGenerate() {
		if (!startDate) {
			toast.error("Pick a start date.");
			return;
		}
		if (!timeOfDay) {
			toast.error("Pick a time of day.");
			return;
		}
		if (mode === "monthly" && ordinals.length === 0) {
			toast.error("Pick at least one monthly ordinal (e.g. 1st, 3rd).");
			return;
		}
		if (boundKind === "until" && !until) {
			toast.error("Pick an until-date.");
			return;
		}

		const bound =
			boundKind === "count"
				? ({ kind: "count", count } as const)
				: ({ kind: "until", until } as const);
		const input: RecurrenceInput =
			mode === "interval"
				? {
						mode: "interval",
						weekday,
						intervalWeeks,
						startDate,
						timeOfDay,
						bound,
					}
				: {
						mode: "monthly",
						weekday,
						ordinals,
						startDate,
						timeOfDay,
						bound,
					};

		const { occurrences, clamped: didClamp } = generateOccurrences(input);
		setPreview(occurrences);
		setClamped(didClamp);
		setRemoved(new Set());
	}

	function toggleOrdinal(o: Ordinal) {
		setOrdinals((prev) =>
			prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o],
		);
	}

	function removeRow(date: string) {
		setRemoved((prev) => new Set(prev).add(date));
	}

	// Rows still in play (not user-removed); each flagged if it duplicates an
	// existing meeting on the same calendar date.
	const visible = (preview ?? []).filter((o) => !removed.has(o.date));
	const toCreate = visible.filter((o) => !existing.has(o.date));
	const skippedCount = visible.filter((o) => existing.has(o.date)).length;

	async function onCreate() {
		if (toCreate.length === 0) {
			toast.error("Nothing to create.");
			return;
		}
		setSubmitting(true);
		try {
			const result = await batchCreateMeetings({
				data: {
					clubId: adminClub.clubId,
					wallTimes: toCreate.map((o) => o.wallTime),
					location: location.trim() || undefined,
				},
			});
			const skipMsg = result.skippedDates.length
				? `, skipped ${result.skippedDates.length} already scheduled`
				: "";
			toast.success(`Created ${result.createdCount} meetings${skipMsg}.`);
			await router.navigate({ to: "/" });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
			setSubmitting(false);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Batch-create meetings
				</h1>
				<p className="text-sm text-muted-foreground">
					Generate a season of meetings for {adminClub.name} from a recurrence,
					then review before creating. Up to {MAX_BATCH} at a time.
				</p>
			</div>

			<div className="grid gap-6 md:grid-cols-2">
				<div className="max-w-xl space-y-4">
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="startDate">Start date</Label>
							<Input
								id="startDate"
								type="date"
								value={startDate}
								onChange={(e) => setStartDate(e.target.value)}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="timeOfDay">Time of day</Label>
							<Input
								id="timeOfDay"
								type="time"
								value={timeOfDay}
								onChange={(e) => setTimeOfDay(e.target.value)}
								required
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label>Cadence</Label>
						<div className="flex gap-4 text-sm">
							<label className="flex items-center gap-2">
								<input
									type="radio"
									name="mode"
									checked={mode === "interval"}
									onChange={() => setMode("interval")}
								/>
								Every N weeks
							</label>
							<label className="flex items-center gap-2">
								<input
									type="radio"
									name="mode"
									checked={mode === "monthly"}
									onChange={() => setMode("monthly")}
								/>
								Monthly ordinals
							</label>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="weekday">Weekday</Label>
						<select
							id="weekday"
							className={selectClass}
							value={weekday}
							onChange={(e) => setWeekday(Number(e.target.value) as Weekday)}
						>
							{WEEKDAY_LABELS.map((label, i) => (
								<option key={label} value={i}>
									{label}
								</option>
							))}
						</select>
					</div>

					{mode === "interval" ? (
						<div className="space-y-2">
							<Label htmlFor="intervalWeeks">Every N weeks</Label>
							<Input
								id="intervalWeeks"
								type="number"
								min={1}
								value={intervalWeeks}
								onChange={(e) =>
									setIntervalWeeks(Math.max(1, Number(e.target.value) || 1))
								}
							/>
							<p className="text-xs text-muted-foreground">
								1 = weekly, 2 = biweekly, …
							</p>
						</div>
					) : (
						<div className="space-y-2">
							<Label>Which weeks of the month</Label>
							<div className="flex flex-wrap gap-3 text-sm">
								{ORDINAL_OPTIONS.map((opt) => (
									<label
										key={String(opt.value)}
										className="flex items-center gap-2"
									>
										<input
											type="checkbox"
											checked={ordinals.includes(opt.value)}
											onChange={() => toggleOrdinal(opt.value)}
										/>
										{opt.label}
									</label>
								))}
							</div>
						</div>
					)}

					<div className="space-y-2">
						<Label>How many</Label>
						<div className="flex items-center gap-3 text-sm">
							<label className="flex items-center gap-2">
								<input
									type="radio"
									name="bound"
									checked={boundKind === "count"}
									onChange={() => setBoundKind("count")}
								/>
								Next
							</label>
							<Input
								type="number"
								min={1}
								max={MAX_BATCH}
								className="w-24"
								value={count}
								disabled={boundKind !== "count"}
								onChange={(e) =>
									setCount(Math.max(1, Number(e.target.value) || 1))
								}
							/>
							<span className="text-muted-foreground">meetings</span>
						</div>
						<div className="flex items-center gap-3 text-sm">
							<label className="flex items-center gap-2">
								<input
									type="radio"
									name="bound"
									checked={boundKind === "until"}
									onChange={() => setBoundKind("until")}
								/>
								Until
							</label>
							<Input
								type="date"
								className="w-44"
								value={until}
								disabled={boundKind !== "until"}
								onChange={(e) => setUntil(e.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="location">Location (optional)</Label>
						<Input
							id="location"
							value={location}
							onChange={(e) => setLocation(e.target.value)}
							placeholder="Community Hall, Room B"
						/>
					</div>

					<Button type="button" variant="secondary" onClick={onGenerate}>
						Generate preview
					</Button>
				</div>

				<div className="space-y-3">
					<h2 className="text-sm font-medium">Preview</h2>
					{preview == null ? (
						<p className="text-sm text-muted-foreground">
							Set a cadence and generate to preview the dates.
						</p>
					) : visible.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No dates generated. Adjust the inputs and try again.
						</p>
					) : (
						<>
							{clamped && (
								<p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
									Capped at {MAX_BATCH} meetings — narrow the range to generate
									the rest in a later batch.
								</p>
							)}
							<p className="text-sm text-muted-foreground">
								{toCreate.length} meeting{toCreate.length === 1 ? "" : "s"} will
								be created
								{skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}
							</p>
							<ul className="divide-y rounded-md border">
								{visible.map((o) => {
									const isDup = existing.has(o.date);
									return (
										<li
											key={o.date}
											className={`flex items-center justify-between gap-2 px-3 py-2 text-sm ${
												isDup ? "text-muted-foreground" : ""
											}`}
										>
											<span>
												{WEEKDAY_LABELS[o.weekday]}, {o.date}
												{isDup && (
													<span className="ml-2 text-xs italic">
														already scheduled — will skip
													</span>
												)}
											</span>
											<button
												type="button"
												aria-label={`Remove ${o.date}`}
												className="text-muted-foreground hover:text-foreground"
												onClick={() => removeRow(o.date)}
											>
												<X className="size-4" />
											</button>
										</li>
									);
								})}
							</ul>
							<Button
								type="button"
								disabled={submitting || toCreate.length === 0}
								onClick={onCreate}
								className="w-full"
							>
								{submitting ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									`Create ${toCreate.length} meeting${toCreate.length === 1 ? "" : "s"}`
								)}
							</Button>
						</>
					)}
				</div>
			</div>
		</PageContainer>
	);
}
