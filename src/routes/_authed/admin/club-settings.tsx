import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { getClubProfileSettings, updateClubProfile } from "#/server/clubs";
import {
	loadClubReminderSettings,
	updateClubReminderSettings,
} from "#/server/notification-prefs";

export const Route = createFileRoute("/_authed/admin/club-settings")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/roster" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const [profile, reminders] = await Promise.all([
			getClubProfileSettings({ data: context.adminClub.clubId }),
			loadClubReminderSettings({ data: context.adminClub.clubId }),
		]);
		return { profile, reminders };
	},
	component: ClubSettings,
});

const textareaClass =
	"flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

function ClubSettings() {
	const { adminClub } = Route.useRouteContext();
	const { profile, reminders } = Route.useLoaderData();
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);
	const [remindersEnabled, setRemindersEnabled] = useState(reminders.enabled);
	const [leadTimeDays, setLeadTimeDays] = useState(
		String(reminders.leadTimeDays),
	);
	const [savingReminders, setSavingReminders] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSubmitting(true);
		try {
			await updateClubProfile({
				data: {
					clubId: adminClub.clubId,
					district: String(form.get("district") ?? ""),
					mission: String(form.get("mission") ?? ""),
					meetingSchedule: String(form.get("meetingSchedule") ?? ""),
				},
			});
			toast.success("Club profile saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSubmitting(false);
		}
	}

	async function onSaveReminders(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const days = Number.parseInt(leadTimeDays, 10);
		if (!Number.isFinite(days) || days < 0 || days > 60) {
			toast.error("Lead time must be a whole number of days (0–60).");
			return;
		}
		setSavingReminders(true);
		try {
			await updateClubReminderSettings({
				data: {
					clubId: adminClub.clubId,
					enabled: remindersEnabled,
					leadTimeDays: days,
				},
			});
			toast.success("Reminder settings saved.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSavingReminders(false);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Club settings
				</h1>
				<p className="text-sm text-muted-foreground">
					District, mission, and meeting schedule for{" "}
					{profile?.name ?? adminClub.name}. These appear on the printable
					meeting agenda. Leave a field blank to omit it.
				</p>
			</div>

			<form onSubmit={onSubmit} className="max-w-xl space-y-4">
				<div className="space-y-2">
					<Label htmlFor="district">District</Label>
					<Input
						id="district"
						name="district"
						defaultValue={profile?.district ?? ""}
						placeholder="e.g. District 39"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="meetingSchedule">Meeting schedule</Label>
					<Input
						id="meetingSchedule"
						name="meetingSchedule"
						defaultValue={profile?.meetingSchedule ?? ""}
						placeholder="e.g. 2nd & 4th Thursday, 6:45–7:45 PM"
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="mission">Mission</Label>
					<textarea
						id="mission"
						name="mission"
						rows={4}
						defaultValue={profile?.mission ?? ""}
						className={textareaClass}
						placeholder="Your club's mission statement"
					/>
				</div>
				<Button type="submit" disabled={submitting} className="w-full">
					{submitting ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save club profile"
					)}
				</Button>
			</form>

			<div className="pt-2">
				<h2 className="font-display text-xl font-semibold tracking-[-0.01em]">
					Role reminders
				</h2>
				<p className="text-sm text-muted-foreground">
					Email members a reminder before a meeting when they're signed up for a
					role. Members can opt out individually. Off by club here disables role
					reminders entirely.
				</p>
			</div>

			<form onSubmit={onSaveReminders} className="max-w-xl space-y-4">
				<label className="flex items-center gap-2 text-sm font-medium">
					<input
						type="checkbox"
						checked={remindersEnabled}
						onChange={(e) => setRemindersEnabled(e.target.checked)}
					/>
					Send role reminders for this club
				</label>
				<div className="space-y-2">
					<Label htmlFor="leadTimeDays">
						Lead time (days before the meeting)
					</Label>
					<Input
						id="leadTimeDays"
						name="leadTimeDays"
						type="number"
						min={0}
						max={60}
						inputMode="numeric"
						value={leadTimeDays}
						onChange={(e) => setLeadTimeDays(e.target.value)}
						disabled={!remindersEnabled}
						className="max-w-[10rem]"
					/>
					<p className="text-xs text-muted-foreground">
						e.g. 3 = remind members three days before the meeting.
					</p>
				</div>
				<Button type="submit" disabled={savingReminders} className="w-full">
					{savingReminders ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						"Save reminder settings"
					)}
				</Button>
			</form>
		</PageContainer>
	);
}
