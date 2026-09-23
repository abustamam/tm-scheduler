import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { relativeTime } from "#/lib/offline-status";
import {
	type ConnectedApp,
	disconnectConnectedApp,
	getConnectedApps,
} from "#/server/oauth-grants";

/** What a row calls its app: the client's name, or a stand-in when it has none. */
function appLabel(app: ConnectedApp): string {
	return app.name ?? "Unnamed app";
}

/**
 * The "Connected apps" section of `/me` (#851): the OAuth grants the signed-in
 * person has given, each with a Disconnect.
 *
 * Shown to EVERYONE signed in, unlike the token section above it. Minting a
 * token is an officer's tool; removing a grant is not a privilege but the only
 * way a person can cut an app off, so a non-officer who somehow holds one must
 * still see it.
 *
 * Disconnect confirms first and says what it cannot do: access tokens are
 * verified locally with no revocation lookup (ADR-0027), so one already issued
 * keeps working until it expires. The copy states the hour rather than
 * promising "immediately", which is what the token section can say and this one
 * cannot.
 */
export function ConnectedAppsSection() {
	const qc = useQueryClient();
	const [pending, setPending] = useState<ConnectedApp | null>(null);
	// Held separately so the dialog's copy survives its closing animation.
	const [shown, setShown] = useState<ConnectedApp | null>(null);
	useEffect(() => {
		if (pending) setShown(pending);
	}, [pending]);

	const apps = useQuery({
		queryKey: ["connected-apps"],
		queryFn: () => getConnectedApps(),
	});

	const disconnect = useMutation({
		mutationFn: (app: ConnectedApp) =>
			disconnectConnectedApp({ data: { clientId: app.clientId } }),
		onSuccess: (_result, app) => {
			toast.success(`Disconnected ${appLabel(app)}.`);
			setPending(null);
			qc.invalidateQueries({ queryKey: ["connected-apps"] });
		},
		onError: (e) =>
			toast.error(
				e instanceof Error ? e.message : "Failed to disconnect the app.",
			),
	});

	const rows = apps.data ?? [];
	const now = Date.now();

	return (
		<div className="space-y-3 rounded-xl border bg-card p-4">
			<div className="min-w-0">
				<h2 className="flex items-center gap-2 font-medium">
					<Plug className="size-4 text-primary" aria-hidden />
					Connected apps
				</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					Apps you've allowed to use GavelUp as you, such as Claude.
				</p>
			</div>

			{apps.isLoading ? (
				<Loader2 className="size-4 animate-spin" />
			) : rows.length > 0 ? (
				<ul className="space-y-2">
					{rows.map((app) => (
						<li
							key={app.clientId}
							className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
						>
							<div className="min-w-0">
								<div className="font-medium">
									{appLabel(app)}
									{app.name ? null : (
										<>
											{" "}
											<code className="break-all font-mono text-xs text-muted-foreground">
												{app.clientId}
											</code>
										</>
									)}
								</div>
								<div className="text-muted-foreground">
									{app.approvedAt
										? `Approved ${new Date(app.approvedAt).toLocaleDateString()}`
										: "Approved"}
									{" · "}
									{app.lastActiveAt
										? `Last active ${relativeTime(new Date(app.lastActiveAt).getTime(), now)}`
										: "Not used yet"}
								</div>
							</div>
							<Button
								variant="destructive"
								size="sm"
								disabled={disconnect.isPending}
								onClick={() => setPending(app)}
							>
								Disconnect
							</Button>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">
					No apps are connected to your account.
				</p>
			)}

			<Dialog
				open={pending !== null}
				onOpenChange={(o) => {
					// Held open while the write is in flight, so dismissing cannot
					// leave the person unsure whether it landed.
					if (!o && !disconnect.isPending) setPending(null);
				}}
			>
				{/* No `max-h` and no `overflow-*` here: a dialog's height belongs to
				 *  the `DialogContent` primitive (CODING_STANDARDS.md, #619). */}
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Disconnect {shown ? appLabel(shown) : ""}?
						</DialogTitle>
						<DialogDescription>
							It won't be able to renew its access. Anything it already has
							stops working within an hour.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							disabled={disconnect.isPending}
							onClick={() => setPending(null)}
						>
							Keep connected
						</Button>
						<Button
							variant="destructive"
							disabled={disconnect.isPending}
							onClick={() => pending && disconnect.mutate(pending)}
						>
							{disconnect.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Disconnect"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
