import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	generateApiToken,
	getApiTokenState,
	revokeApiTokenFn,
} from "#/server/api-tokens";

/**
 * The "Personal access tokens" section of `/me` (#773).
 *
 * Its own component with its own query rather than part of the route loader,
 * for two reasons: the section is HIDDEN for a user who is an admin nowhere, so
 * the page must not pay for its query on every load; and it mirrors
 * `admin/sync-tokens.tsx`, which is the token UI this repo already has and the
 * shape a reader will compare it against.
 *
 * Eligibility is decided SERVER-side (`getApiTokenState`). The client cannot
 * answer it: the route context carries `officerPositions` for the ACTIVE club
 * only, so a client-side check would hide this from an officer whose office is
 * in a different club than the one they happen to be looking at.
 */
export function ApiTokensSection() {
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [freshToken, setFreshToken] = useState<string | null>(null);

	const state = useQuery({
		queryKey: ["api-tokens"],
		queryFn: () => getApiTokenState(),
	});

	const generate = useMutation({
		mutationFn: () => generateApiToken({ data: { name: name || undefined } }),
		onSuccess: (created) => {
			setFreshToken(created.token);
			setName("");
			qc.invalidateQueries({ queryKey: ["api-tokens"] });
		},
		onError: (e) =>
			toast.error(e instanceof Error ? e.message : "Failed to create token."),
	});

	const revoke = useMutation({
		mutationFn: (tokenId: string) => revokeApiTokenFn({ data: { tokenId } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["api-tokens"] }),
		onError: (e) =>
			toast.error(e instanceof Error ? e.message : "Failed to revoke token."),
	});

	// Render nothing at all until we know — a section that appears and then
	// vanishes is worse than one that arrives a moment late.
	if (!state.data?.eligible) return null;

	const tokens = state.data.tokens;

	return (
		<div className="space-y-3 rounded-xl border bg-card p-4">
			<div className="min-w-0">
				<div className="flex items-center gap-2 font-medium">
					<KeyRound className="size-4 text-primary" aria-hidden />
					Personal access tokens
				</div>
				<p className="mt-1 text-sm text-muted-foreground">
					Let an AI assistant read and update your club's meetings on your
					behalf. A token acts as you, in the clubs where you're an admin or
					officer. Treat it like a password.
				</p>
			</div>

			<div className="space-y-3">
				<Label htmlFor="api-token-name">New token label (optional)</Label>
				<div className="flex gap-2">
					<Input
						id="api-token-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. Claude on my laptop"
						maxLength={100}
					/>
					<Button
						onClick={() => generate.mutate()}
						disabled={generate.isPending}
					>
						{generate.isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							"Create token"
						)}
					</Button>
				</div>
				{freshToken ? (
					<div className="space-y-2 rounded-md border border-warning/60 bg-warning-soft p-3 text-sm">
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
						<p className="text-muted-foreground">
							Connect it with:{" "}
							<code className="break-all font-mono text-xs">
								claude mcp add --transport http gavelup{" "}
								{typeof window === "undefined"
									? "https://<host>"
									: window.location.origin}
								/api/mcp --header "Authorization: Bearer &lt;token&gt;"
							</code>
						</p>
					</div>
				) : null}
			</div>

			<div className="space-y-2">
				<h2 className="text-sm font-bold">Your tokens</h2>
				{state.isLoading ? (
					<Loader2 className="size-4 animate-spin" />
				) : tokens.length > 0 ? (
					<ul className="space-y-2">
						{tokens.map((t) => (
							<li
								key={t.id}
								className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
							>
								<div className="min-w-0">
									<span className="font-medium">{t.name ?? "(unnamed)"}</span>{" "}
									<span className="text-muted-foreground">
										{t.revokedAt
											? "· revoked"
											: t.lastUsedAt
												? `· last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
												: "· never used"}
									</span>
								</div>
								{t.revokedAt ? null : (
									<Button
										variant="destructive"
										size="sm"
										disabled={revoke.isPending}
										onClick={() => {
											// Revoking breaks whatever is using it, and there is no
											// undo — the token cannot be shown again.
											if (
												!window.confirm(
													`Revoke ${t.name ?? "this token"}? Anything signed in with it stops working immediately.`,
												)
											) {
												return;
											}
											revoke.mutate(t.id);
										}}
									>
										Revoke
									</Button>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">No tokens yet.</p>
				)}
			</div>
		</div>
	);
}
