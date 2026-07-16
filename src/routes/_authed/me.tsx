import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { CalendarDays, Loader2, Mic } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { formatMeetingDate, formatMeetingTimeRange } from "#/lib/format";
import { listMyCommitments } from "#/server/meetings";
import { releaseSlot } from "#/server/slots";

export const Route = createFileRoute("/_authed/me")({
	loader: () => listMyCommitments(),
	component: MyCommitments,
});

function MyCommitments() {
	const commitments = Route.useLoaderData();
	const { currentMemberId } = Route.useRouteContext();
	const router = useRouter();
	const [busySlotId, setBusySlotId] = useState<string | null>(null);

	async function doRelease(slotId: string) {
		if (!currentMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusySlotId(slotId);
		try {
			await releaseSlot({ data: { slotId, actorMemberId: currentMemberId } });
			toast.success("Role released.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusySlotId(null);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
				My roles
			</h1>

			{commitments.length === 0 ? (
				<p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
					You haven't claimed any roles yet.{" "}
					<Link to="/roster" className="font-medium text-primary underline">
						Browse the schedule
					</Link>
					.
				</p>
			) : (
				<ul className="space-y-3">
					{commitments.map((c) => (
						<li
							key={c.slotId}
							className="rounded-xl border bg-card p-4 shadow-sm"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="font-semibold">{c.roleName}</p>
										{c.isSpeakerRole ? (
											<Mic className="size-4 text-primary" aria-hidden />
										) : null}
									</div>
									{c.isSpeakerRole && c.speechTitle ? (
										<p className="text-sm text-muted-foreground">
											“{c.speechTitle}”
										</p>
									) : null}
									<Link
										to="/meetings/$id"
										params={{ id: c.meetingId }}
										className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
									>
										<CalendarDays className="size-4" aria-hidden />
										{formatMeetingDate(c.scheduledAt, c.timezone)} ·{" "}
										{formatMeetingTimeRange(
											c.scheduledAt,
											c.lengthMinutes,
											c.timezone,
										)}
										{c.theme ? (
											<span className="truncate"> · {c.theme}</span>
										) : null}
									</Link>
								</div>
								<div className="flex shrink-0 flex-col items-end gap-2">
									<Badge
										variant={c.status === "confirmed" ? "default" : "secondary"}
									>
										{c.status}
									</Badge>
									<Button
										size="sm"
										variant="outline"
										onClick={() => doRelease(c.slotId)}
										disabled={busySlotId === c.slotId}
									>
										{busySlotId === c.slotId ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											"Release"
										)}
									</Button>
								</div>
							</div>
						</li>
					))}
				</ul>
			)}
		</PageContainer>
	);
}
