import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Bell, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiTokensSection } from "#/components/api-tokens-section";
import { ConnectedAppsSection } from "#/components/connected-apps-section";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { navLabel } from "#/lib/nav-destinations";
import {
	getMyReminderOptOut,
	setMyReminderOptOut,
} from "#/server/notification-prefs";

/**
 * Account settings (#912): the controls that belong to the signed-in PERSON
 * rather than to their meeting jobs. They lived on `/me` ("My roles") until
 * then, which is where a member looks for what they're doing next week — not
 * where anyone expects to mint a credential or cut off an app.
 */
export const Route = createFileRoute("/_authed/account")({
	loader: async () => {
		const reminderPref = await getMyReminderOptOut();
		return { reminderOptOut: reminderPref.optedOut };
	},
	component: AccountSettings,
});

function AccountSettings() {
	const { reminderOptOut } = Route.useLoaderData();
	const router = useRouter();
	const [savingPref, setSavingPref] = useState(false);

	async function toggleReminders(nextEnabled: boolean) {
		setSavingPref(true);
		try {
			await setMyReminderOptOut({ data: { optedOut: !nextEnabled } });
			toast.success(
				nextEnabled
					? "Reminder emails turned on."
					: "Reminder emails turned off.",
			);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setSavingPref(false);
		}
	}

	return (
		<PageContainer className="space-y-4">
			<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
				{navLabel("/account")}
			</h1>

			<div className="flex items-start justify-between gap-4 rounded-xl border bg-card p-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2 font-medium">
						<Bell className="size-4 text-primary" aria-hidden />
						Reminder emails
					</div>
					<p className="mt-1 text-sm text-muted-foreground">
						Get an email before a meeting when you're signed up for a role.
					</p>
				</div>
				<Button
					size="sm"
					variant={reminderOptOut ? "default" : "outline"}
					onClick={() => toggleReminders(reminderOptOut)}
					disabled={savingPref}
					aria-pressed={!reminderOptOut}
				>
					{savingPref ? (
						<Loader2 className="size-4 animate-spin" />
					) : reminderOptOut ? (
						"Turn on"
					) : (
						"Turn off"
					)}
				</Button>
			</div>

			{/* Renders nothing unless the user is an admin or officer somewhere
			    (#773). That check is server-side — see `ApiTokensSection`. */}
			<ApiTokensSection />

			{/* Shown to everyone signed in (#851): removing an app is not a
			    privilege, it is the only way to cut one off. */}
			<ConnectedAppsSection />
		</PageContainer>
	);
}
