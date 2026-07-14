import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	generateSyncToken,
	getSyncTokens,
	revokeSyncTokenFn,
} from "#/server/sync-tokens";

export const Route = createFileRoute("/_authed/admin/sync-tokens")({
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) throw redirect({ to: "/" });
		return { adminClub };
	},
	component: SyncTokens,
});

function SyncTokens() {
	const { adminClub } = Route.useRouteContext();
	const clubId = adminClub.clubId;
	const qc = useQueryClient();

	const [name, setName] = useState("");
	const [freshToken, setFreshToken] = useState<string | null>(null);

	const tokensQuery = useQuery({
		queryKey: ["sync-tokens", clubId],
		queryFn: () => getSyncTokens({ data: { clubId } }),
	});

	const generate = useMutation({
		mutationFn: () =>
			generateSyncToken({ data: { clubId, name: name || undefined } }),
		onSuccess: (created) => {
			setFreshToken(created.token);
			setName("");
			qc.invalidateQueries({ queryKey: ["sync-tokens", clubId] });
		},
		onError: (e) =>
			toast.error(e instanceof Error ? e.message : "Failed to create token."),
	});

	const revoke = useMutation({
		mutationFn: (tokenId: string) =>
			revokeSyncTokenFn({ data: { clubId, tokenId } }),
		onSuccess: () =>
			qc.invalidateQueries({ queryKey: ["sync-tokens", clubId] }),
		onError: (e) =>
			toast.error(e instanceof Error ? e.message : "Failed to revoke token."),
	});

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Base Camp sync tokens
				</h1>
				<p className="text-sm text-muted-foreground">
					Tokens let the Pathways sync browser extension push {adminClub.name}'s
					Base Camp progress into GavelUp. Treat a token like a password.
				</p>
			</div>

			<div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
				<Label htmlFor="token-name">New token label (optional)</Label>
				<div className="flex gap-2">
					<Input
						id="token-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. VPE laptop"
						maxLength={100}
					/>
					<Button
						onClick={() => generate.mutate()}
						disabled={generate.isPending}
					>
						{generate.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Generate token"
						)}
					</Button>
				</div>
				{freshToken ? (
					<div className="space-y-1 rounded-md border border-warning/60 bg-warning-soft p-3 text-sm">
						<p className="font-bold">Copy this now — you won't see it again:</p>
						<code className="block break-all font-mono text-xs">
							{freshToken}
						</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(freshToken);
								toast.success("Token copied.");
							}}
						>
							Copy
						</Button>
					</div>
				) : null}
			</div>

			<div className="space-y-2">
				<h2 className="text-sm font-bold">Existing tokens</h2>
				{tokensQuery.isLoading ? (
					<Loader2 className="size-4 animate-spin" />
				) : tokensQuery.data && tokensQuery.data.length > 0 ? (
					<ul className="space-y-2">
						{tokensQuery.data.map((t) => (
							<li
								key={t.id}
								className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] p-3 text-sm"
							>
								<div>
									<span className="font-medium">{t.name ?? "(unnamed)"}</span>{" "}
									<span className="text-muted-foreground">
										{t.revokedAt
											? "· revoked"
											: t.lastUsedAt
												? `· last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
												: "· never used"}
									</span>
								</div>
								{!t.revokedAt ? (
									<Button
										variant="destructive"
										size="sm"
										disabled={revoke.isPending}
										onClick={() => revoke.mutate(t.id)}
									>
										Revoke
									</Button>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">No tokens yet.</p>
				)}
			</div>
		</PageContainer>
	);
}
