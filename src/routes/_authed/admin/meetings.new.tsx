import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { createMeeting } from "#/server/meetings";

export const Route = createFileRoute("/_authed/admin/meetings/new")({
	beforeLoad: ({ context }) => {
		const adminClub = context.clubs.find((c) => c.clubRole === "admin");
		if (!adminClub) {
			throw redirect({ to: "/" });
		}
		return { adminClub };
	},
	component: NewMeeting,
});

function NewMeeting() {
	const { adminClub } = Route.useRouteContext();
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const scheduledAt = String(form.get("scheduledAt") ?? "");
		if (!scheduledAt) {
			toast.error("Pick a date and time.");
			return;
		}
		setSubmitting(true);
		try {
			const { meetingId } = await createMeeting({
				data: {
					clubId: adminClub.clubId,
					scheduledAt,
					location: String(form.get("location") ?? "").trim() || undefined,
					theme: String(form.get("theme") ?? "").trim() || undefined,
					wordOfTheDay:
						String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					notes: String(form.get("notes") ?? "").trim() || undefined,
				},
			});
			toast.success("Meeting created — roles generated.");
			await router.navigate({ to: "/meetings/$id", params: { id: meetingId } });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
			setSubmitting(false);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					New meeting
				</h1>
				<p className="text-sm text-muted-foreground">
					Roles are generated automatically from {adminClub.name}'s template.
				</p>
			</div>

			<form onSubmit={onSubmit} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<Label htmlFor="scheduledAt">Date &amp; time</Label>
					<Input
						id="scheduledAt"
						name="scheduledAt"
						type="datetime-local"
						required
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="theme">Theme</Label>
					<Input id="theme" name="theme" placeholder="e.g. New Beginnings" />
				</div>
				<div className="space-y-2">
					<Label htmlFor="location">Location</Label>
					<Input
						id="location"
						name="location"
						placeholder="Community Hall, Room B"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="wordOfTheDay">Word of the day</Label>
					<Input
						id="wordOfTheDay"
						name="wordOfTheDay"
						placeholder="Resilient"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="notes">Notes</Label>
					<textarea
						id="notes"
						name="notes"
						rows={3}
						className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
						placeholder="Anything members should know"
					/>
				</div>
				<Button type="submit" disabled={submitting} className="w-full">
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Create meeting"
					)}
				</Button>
			</form>
		</PageContainer>
	);
}
