import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, MapPin, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";
import { getMeeting } from "#/server/meetings";
import { claimSlot, releaseSlot } from "#/server/slots";

export const Route = createFileRoute("/_authed/meetings/$id")({
	loader: ({ params }) => getMeeting({ data: params.id }),
	component: MeetingDetail,
});

const CATEGORY_LABELS: Record<string, string> = {
	leadership: "Leadership",
	speaker: "Speakers",
	evaluator: "Evaluation",
	functionary: "Functionaries",
};

type Slot = Awaited<ReturnType<typeof getMeeting>>["slots"][number];

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function MeetingDetail() {
	const { meeting, slots, canManage } = Route.useLoaderData();
	const { authUser } = Route.useRouteContext();
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [speakerSlot, setSpeakerSlot] = useState<Slot | null>(null);

	// Number repeated roles ("Speaker 1", "Speaker 2", …).
	const roleCounts = buildRoleCounts(slots);

	// Preserve category order as it appears (slots arrive pre-sorted).
	const categories: string[] = [];
	for (const s of slots) {
		if (!categories.includes(s.category)) categories.push(s.category);
	}

	async function doClaim(slot: Slot) {
		if (slot.isSpeakerRole) {
			setSpeakerSlot(slot);
			return;
		}
		setBusySlotId(slot.id);
		try {
			await claimSlot({ data: { slotId: slot.id } });
			toast.success(`You're on as ${slot.roleName}.`);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	async function doRelease(slot: Slot) {
		setBusySlotId(slot.id);
		try {
			await releaseSlot({ data: { slotId: slot.id } });
			toast.success("Role released.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<div className="space-y-5">
			<header className="space-y-2">
				<h1 className="text-2xl font-bold tracking-tight">
					{meeting.theme ?? "Meeting"}
				</h1>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<CalendarDays className="size-4" aria-hidden />
						{formatMeetingDate(meeting.scheduledAt)} ·{" "}
						{formatMeetingTime(meeting.scheduledAt)}
					</span>
					{meeting.location ? (
						<span className="flex items-center gap-1.5">
							<MapPin className="size-4" aria-hidden />
							{meeting.location}
						</span>
					) : null}
				</div>
				{meeting.wordOfTheDay ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-medium">{meeting.wordOfTheDay}</span>
					</p>
				) : null}
			</header>

			{categories.map((category) => (
				<section key={category} className="space-y-2">
					<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						{CATEGORY_LABELS[category] ?? category}
					</h2>
					<ul className="space-y-2">
						{slots
							.filter((s) => s.category === category)
							.map((slot) => {
								const isMine = slot.assigneeId === authUser.id;
								const busy = busySlotId === slot.id;
								return (
									<li
										key={slot.id}
										className="rounded-xl border bg-card p-4 shadow-sm"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0 flex-1">
												<p className="font-medium">
													{slotLabel(slot, roleCounts)}
												</p>

												{slot.assigneeId ? (
													<p className="text-sm text-muted-foreground">
														{slot.assigneeName}
														{isMine ? (
															<span className="text-primary"> (you)</span>
														) : null}
													</p>
												) : (
													<p className="text-sm text-muted-foreground">Open</p>
												)}

												{slot.isSpeakerRole && slot.speechTitle ? (
													<div className="mt-1 text-sm">
														<p className="font-medium">“{slot.speechTitle}”</p>
														<p className="text-xs text-muted-foreground">
															{[
																slot.pathwayPath,
																slot.projectName,
																slot.projectLevel,
															]
																.filter(Boolean)
																.join(" · ")}
															{slot.minMinutes && slot.maxMinutes
																? ` · ${slot.minMinutes}–${slot.maxMinutes} min`
																: ""}
														</p>
													</div>
												) : null}

												{slot.evaluates ? (
													<p className="mt-1 text-xs text-muted-foreground">
														Evaluates{" "}
														<span className="font-medium text-foreground">
															{slot.evaluates.speechTitle
																? `“${slot.evaluates.speechTitle}”`
																: (slot.evaluates.speakerName ?? "a speaker")}
														</span>
													</p>
												) : null}
											</div>

											<div className="shrink-0">
												{slot.status === "open" ? (
													<Button
														size="sm"
														onClick={() => doClaim(slot)}
														disabled={busy}
													>
														{busy ? (
															<Loader2 className="size-4 animate-spin" />
														) : (
															"Claim"
														)}
													</Button>
												) : isMine || canManage ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => doRelease(slot)}
														disabled={busy}
													>
														{busy ? (
															<Loader2 className="size-4 animate-spin" />
														) : (
															"Release"
														)}
													</Button>
												) : (
													<Badge variant="secondary">Filled</Badge>
												)}
											</div>
										</div>
									</li>
								);
							})}
					</ul>
				</section>
			))}

			<ClaimSpeakerSheet
				slot={speakerSlot}
				onOpenChange={(open) => {
					if (!open) setSpeakerSlot(null);
				}}
				onClaimed={async () => {
					setSpeakerSlot(null);
					await router.invalidate();
				}}
			/>
		</div>
	);
}

function ClaimSpeakerSheet({
	slot,
	onOpenChange,
	onClaimed,
}: {
	slot: Slot | null;
	onOpenChange: (open: boolean) => void;
	onClaimed: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (!slot) return;
		const form = new FormData(e.currentTarget);
		const speechTitle = String(form.get("speechTitle") ?? "").trim();
		if (!speechTitle) {
			toast.error("A speech title is required.");
			return;
		}
		const minRaw = form.get("minMinutes");
		const maxRaw = form.get("maxMinutes");
		setSubmitting(true);
		try {
			await claimSlot({
				data: {
					slotId: slot.id,
					speakerDetails: {
						speechTitle,
						pathwayPath:
							String(form.get("pathwayPath") ?? "").trim() || undefined,
						projectName:
							String(form.get("projectName") ?? "").trim() || undefined,
						projectLevel:
							String(form.get("projectLevel") ?? "").trim() || undefined,
						minMinutes: minRaw ? Number(minRaw) : undefined,
						maxMinutes: maxRaw ? Number(maxRaw) : undefined,
					},
				},
			});
			toast.success("You're booked to speak!");
			await onClaimed();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Claim a speaking slot</SheetTitle>
					<SheetDescription>
						Tell the club what you'll be presenting.
					</SheetDescription>
				</SheetHeader>
				<form onSubmit={onSubmit} className="space-y-4 px-4">
					<div className="space-y-2">
						<Label htmlFor="speechTitle">Speech title</Label>
						<Input id="speechTitle" name="speechTitle" required autoFocus />
					</div>
					<div className="space-y-2">
						<Label htmlFor="pathwayPath">Pathways path</Label>
						<Input
							id="pathwayPath"
							name="pathwayPath"
							placeholder="e.g. Presentation Mastery"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label htmlFor="projectName">Project</Label>
							<Input
								id="projectName"
								name="projectName"
								placeholder="Ice Breaker"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="projectLevel">Level</Label>
							<Input
								id="projectLevel"
								name="projectLevel"
								placeholder="Level 1"
							/>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label htmlFor="minMinutes">Min minutes</Label>
							<Input
								id="minMinutes"
								name="minMinutes"
								type="number"
								inputMode="numeric"
								min={1}
								placeholder="4"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="maxMinutes">Max minutes</Label>
							<Input
								id="maxMinutes"
								name="maxMinutes"
								type="number"
								inputMode="numeric"
								min={1}
								placeholder="6"
							/>
						</div>
					</div>
					<SheetFooter className="px-0">
						<Button type="submit" disabled={submitting} className="w-full">
							{submitting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Claim speaking slot"
							)}
						</Button>
						<SheetClose asChild>
							<Button type="button" variant="ghost" className="w-full">
								Cancel
							</Button>
						</SheetClose>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
