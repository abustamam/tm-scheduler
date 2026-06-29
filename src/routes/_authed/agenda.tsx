import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarPlus, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
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
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { formatMeetingDate, formatMeetingTime } from "#/lib/format";
import { getNextMeeting } from "#/server/meetings";
import { claimSlot, releaseSlot } from "#/server/slots";

export const Route = createFileRoute("/_authed/agenda")({
	loader: async ({ context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) {
			return {
				meeting: null,
				slots: [] as Slot[],
				canManage: false,
				timezone: "UTC",
			};
		}
		return getNextMeeting({ data: clubId });
	},
	component: Agenda,
});

type Slot = Awaited<ReturnType<typeof getNextMeeting>>["slots"][number];

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function Agenda() {
	const { meeting, slots, canManage, timezone } = Route.useLoaderData();
	const { authUser } = Route.useRouteContext();
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);
	const [speakerSlot, setSpeakerSlot] = useState<Slot | null>(null);

	if (!meeting) {
		return (
			<div className="max-w-[1180px] px-7 pt-[26px] pb-10">
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Next meeting agenda
				</h1>
				<div className="mt-7 rounded-2xl border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-16 text-center">
					<p className="text-sm text-[var(--sea-ink-soft)]">
						No upcoming meeting is scheduled yet.
					</p>
					{canManage ? (
						<Button asChild size="sm" className="mt-4">
							<Link to="/admin/meetings/new">
								<CalendarPlus className="size-4" aria-hidden />
								Schedule a meeting
							</Link>
						</Button>
					) : null}
				</div>
			</div>
		);
	}

	const roleCounts = buildRoleCounts(slots);
	const total = slots.length;
	const filled = slots.filter((s) => s.assigneeId).length;
	const open = total - filled;
	const pct = total === 0 ? 0 : Math.round((filled / total) * 100);
	const confirmed = slots.filter((s) => s.status === "confirmed").length;
	const speakerSlots = slots.filter((s) => s.isSpeakerRole);
	const speakerFilled = speakerSlots.filter((s) => s.assigneeId).length;

	const subtitle = [
		`${formatMeetingDate(meeting.scheduledAt, timezone)} · ${formatMeetingTime(meeting.scheduledAt, timezone)}`,
		meeting.location,
	]
		.filter(Boolean)
		.join(" · ");

	const facts = [
		{ label: "Word of the day", value: meeting.wordOfTheDay ?? "Not set" },
		{
			label: "Prepared speeches",
			value: `${speakerFilled} of ${speakerSlots.length} slots`,
		},
		{ label: "Open roles", value: open === 0 ? "All filled" : String(open) },
		{ label: "Confirmed", value: `${confirmed} of ${total}` },
	];

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

	function subline(slot: Slot): string | null {
		if (slot.isSpeakerRole) {
			if (slot.assigneeId) {
				const ctx = [slot.projectName, slot.pathwayPath, slot.projectLevel]
					.filter(Boolean)
					.join(" · ");
				return ctx || (slot.speechTitle ? `"${slot.speechTitle}"` : null);
			}
			return "Open speaking slot — any project";
		}
		if (slot.evaluates) {
			const who = slot.evaluates.speechTitle
				? `"${slot.evaluates.speechTitle}"`
				: (slot.evaluates.speakerName ?? "a speaker");
			return `Evaluates ${who}`;
		}
		return null;
	}

	return (
		<div className="max-w-[1180px] px-7 pt-[26px] pb-10">
			{/* Header */}
			<div className="mb-[22px] flex flex-wrap items-end gap-[18px]">
				<div className="min-w-[240px] flex-1">
					<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
						{meeting.theme ?? "Next meeting agenda"}
					</h1>
					<p className="mt-[5px] text-sm text-[var(--sea-ink-soft)]">
						{subtitle}
					</p>
				</div>
				<div className="flex gap-[9px]">
					<Button variant="outline" size="sm" onClick={() => window.print()}>
						Print agenda
					</Button>
					{canManage ? (
						<Button
							size="sm"
							onClick={() => toast.info("Reminder sending isn't wired up yet.")}
						>
							Remind unfilled
						</Button>
					) : null}
				</div>
			</div>

			<div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1.7fr_1fr]">
				{/* Sign-up card */}
				<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_12px_26px_rgba(23,58,64,.06)]">
					<div className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--foam)] px-5 py-3.5">
						<span className="text-[11px] font-extrabold tracking-[0.08em] text-[var(--sea-ink-soft)] uppercase">
							Role & speech sign-up
						</span>
						<span className="text-xs font-bold text-[var(--sea-ink)]">
							{filled} of {total} filled
						</span>
					</div>

					{slots.map((slot, i) => {
						const isMine = slot.assigneeId === authUser.id;
						const busy = busySlotId === slot.id;
						const sub = subline(slot);
						return (
							<div
								key={slot.id}
								className="grid grid-cols-[26px_1fr_auto] items-center gap-[13px] border-b border-[var(--line)] px-5 py-[13px] transition-colors last:border-b-0 hover:bg-[var(--foam)]"
							>
								<span className="text-xs font-bold text-[var(--sea-ink-soft)]">
									{String(i + 1).padStart(2, "0")}
								</span>
								<div className="min-w-0">
									<div className="text-[13.5px] font-bold">
										{slotLabel(slot, roleCounts)}
									</div>
									{sub ? (
										<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
											{sub}
										</div>
									) : null}
								</div>

								{slot.assigneeId ? (
									<div className="flex items-center gap-[9px]">
										<MemberAvatar
											tone={toneFromSeed(slot.assigneeId)}
											initials={initialsOf(slot.assigneeName ?? "?")}
											size={30}
										/>
										<span className="text-[13px] font-semibold">
											{slot.assigneeName}
											{isMine ? (
												<span className="text-[var(--lagoon-deep)]">
													{" "}
													· you
												</span>
											) : null}
										</span>
										{isMine || canManage ? (
											<button
												type="button"
												onClick={() => doRelease(slot)}
												disabled={busy}
												className="ml-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--sand)] hover:text-[var(--sea-ink)] disabled:opacity-50"
											>
												{busy ? (
													<Loader2 className="size-3.5 animate-spin" />
												) : (
													"Release"
												)}
											</button>
										) : null}
									</div>
								) : (
									<button
										type="button"
										onClick={() => doClaim(slot)}
										disabled={busy}
										className="inline-flex items-center gap-[7px] rounded-full border border-dashed border-[var(--warning)] bg-[var(--warning)]/10 px-[13px] py-1.5 text-[12.5px] font-bold text-[var(--warning-foreground)] transition-colors hover:bg-[var(--warning)]/20 disabled:opacity-50"
									>
										{busy ? (
											<Loader2 className="size-3.5 animate-spin" />
										) : (
											"+ Sign up"
										)}
									</button>
								)}
							</div>
						);
					})}
				</div>

				{/* Right column */}
				<div className="flex min-w-0 flex-col gap-[18px]">
					{/* Theme card */}
					<div className="rounded-2xl border border-[var(--line)] bg-[linear-gradient(150deg,var(--surface-strong),var(--surface))] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<div className="text-[11.5px] font-extrabold tracking-[0.08em] text-[var(--lagoon-deep)] uppercase">
							Meeting theme
						</div>
						<div className="mt-1 mb-3.5 font-display text-[22px] font-semibold">
							{meeting.theme ?? "Theme TBD"}
						</div>
						<div className="grid grid-cols-2 gap-3">
							{facts.map((f) => (
								<div key={f.label}>
									<div className="text-[11px] font-semibold text-[var(--sea-ink-soft)]">
										{f.label}
									</div>
									<div className="mt-0.5 text-sm font-bold">{f.value}</div>
								</div>
							))}
						</div>
					</div>

					{/* Roles filled card */}
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-5 py-[18px] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<div className="mb-2.5 flex items-center justify-between">
							<span className="text-sm font-bold">Roles filled</span>
							<span className="text-[13px] font-bold text-[var(--lagoon-deep)]">
								{pct}%
							</span>
						</div>
						<div className="mb-3.5 h-[9px] overflow-hidden rounded-full bg-[var(--sand)]">
							<div
								className="h-full rounded-full transition-[width] duration-[350ms]"
								style={{
									width: `${pct}%`,
									background:
										"linear-gradient(90deg, var(--lagoon), var(--lagoon-deep))",
								}}
							/>
						</div>
						<p className="text-[12.5px] leading-relaxed text-[var(--sea-ink-soft)]">
							{open === 0 ? (
								"Every role is filled. Nice work."
							) : (
								<>
									{open} role{open === 1 ? "" : "s"} still need a volunteer. Tap{" "}
									<strong className="text-[var(--sea-ink)]">+ Sign up</strong>{" "}
									next to any open slot to claim it — it's instantly yours.
								</>
							)}
						</p>
					</div>
				</div>
			</div>

			<ClaimSpeakerSheet
				slot={speakerSlot}
				onOpenChange={(o) => {
					if (!o) setSpeakerSlot(null);
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
			<SheetContent side="right" className="overflow-y-auto sm:max-w-md">
				<SheetHeader>
					<SheetTitle>Claim a speaking slot</SheetTitle>
					<SheetDescription>
						Tell the club what you'll be presenting.
					</SheetDescription>
				</SheetHeader>
				<form onSubmit={onSubmit} className="space-y-4 px-4 pb-4">
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
								placeholder="5"
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
								placeholder="7"
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
