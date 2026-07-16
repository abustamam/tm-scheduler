import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	ORDINAL_OPTIONS,
	type Ordinal,
	WEEKDAY_LABELS,
	type Weekday,
} from "#/lib/meeting-recurrence";
import {
	getClubRecurrenceRule,
	saveClubRecurrenceRule,
} from "#/server/recurrence-rule";

export const Route = createFileRoute("/_authed/admin/schedule")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/roster" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const rule = await getClubRecurrenceRule({
			data: context.adminClub.clubId,
		});
		return { rule };
	},
	component: RecurringSchedule,
});

const selectClass =
	"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Mode = "interval" | "monthly";

function todayYmd(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseOrdinal(s: string): Ordinal {
	return s === "last" ? "last" : (Number(s) as Ordinal);
}

function RecurringSchedule() {
	const { adminClub } = Route.useRouteContext();
	const { rule } = Route.useLoaderData();
	const router = useRouter();

	const [mode, setMode] = useState<Mode>(rule?.mode ?? "interval");
	const [weekday, setWeekday] = useState<Weekday>(
		(rule?.weekday ?? 2) as Weekday,
	);
	const [intervalWeeks, setIntervalWeeks] = useState(rule?.intervalWeeks ?? 1);
	const [anchorDate, setAnchorDate] = useState(rule?.anchorDate ?? todayYmd());
	const [ordinals, setOrdinals] = useState<Ordinal[]>(
		rule?.ordinals?.map(parseOrdinal) ?? [2, 4],
	);
	const [timeOfDay, setTimeOfDay] = useState(rule?.timeOfDay ?? "19:00");
	const [location, setLocation] = useState(rule?.location ?? "");
	const [keepAhead, setKeepAhead] = useState(rule?.keepAhead ?? 4);
	const [enabled, setEnabled] = useState(rule?.enabled ?? true);
	const [submitting, setSubmitting] = useState(false);

	function toggleOrdinal(o: Ordinal) {
		setOrdinals((cur) =>
			cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o],
		);
	}

	async function onSave() {
		if (mode === "monthly" && ordinals.length === 0) {
			toast.error("Pick at least one week of the month.");
			return;
		}
		setSubmitting(true);
		try {
			const result = await saveClubRecurrenceRule({
				data: {
					clubId: adminClub.clubId,
					mode,
					weekday,
					intervalWeeks: mode === "interval" ? intervalWeeks : null,
					anchorDate: mode === "interval" ? anchorDate : null,
					ordinals: mode === "monthly" ? ordinals.map(String) : null,
					timeOfDay,
					location: location.trim() || null,
					keepAhead,
					enabled,
				},
			});
			toast.success(
				enabled
					? `Saved — ${result.created} meeting${result.created === 1 ? "" : "s"} scheduled ahead.`
					: "Saved — auto-scheduling paused.",
			);
			await router.invalidate();
			setSubmitting(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
			setSubmitting(false);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Recurring schedule
				</h1>
				<p className="text-sm text-muted-foreground">
					Keep {adminClub.name}'s calendar automatically topped up. New meetings
					appear as the schedule runs low — no need to batch-create each season.
				</p>
			</div>

			<div className="max-w-xl space-y-4">
				<label className="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					Auto-schedule enabled
				</label>

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

				<div className="grid grid-cols-2 gap-4">
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

				{mode === "interval" ? (
					<div className="grid grid-cols-2 gap-4">
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
						<div className="space-y-2">
							<Label htmlFor="anchorDate">Anchor date</Label>
							<Input
								id="anchorDate"
								type="date"
								value={anchorDate}
								onChange={(e) => setAnchorDate(e.target.value)}
								required
							/>
							<p className="text-xs text-muted-foreground">
								Fixes which weeks are "on" for biweekly+ cadences.
							</p>
						</div>
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

				<div className="grid grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label htmlFor="keepAhead">Keep meetings ahead</Label>
						<Input
							id="keepAhead"
							type="number"
							min={1}
							max={12}
							value={keepAhead}
							onChange={(e) =>
								setKeepAhead(
									Math.min(12, Math.max(1, Number(e.target.value) || 1)),
								)
							}
						/>
						<p className="text-xs text-muted-foreground">
							Always keep this many future meetings on the calendar.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="location">Location (optional)</Label>
						<Input
							id="location"
							value={location}
							onChange={(e) => setLocation(e.target.value)}
							placeholder="e.g. Community Center, Room 2"
						/>
					</div>
				</div>

				<Button onClick={onSave} disabled={submitting}>
					{submitting ? (
						<>
							<Loader2 className="mr-2 size-4 animate-spin" />
							Saving…
						</>
					) : (
						"Save schedule"
					)}
				</Button>
			</div>
		</PageContainer>
	);
}
