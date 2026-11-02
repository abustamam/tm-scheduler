import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { APP_LOCALE } from "#/lib/format";
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
/**
 * How to connect from Claude or ChatGPT, where nothing is pasted: the app
 * signs in to GavelUp and the person approves it (`docs/claude-connector.md`).
 *
 * ChatGPT's plan limit is stated here because the failure is silent on
 * OpenAI's side — on Free, Plus or Pro the "add a custom MCP server" option
 * is missing or read-only, and GavelUp never sees a request to explain.
 * OpenAI's help article "Connecting custom MCP servers in ChatGPT" is the
 * source; re-check it when this copy changes.
 */
function ConnectorSetup() {
	const mcpUrl = `${typeof window === "undefined" ? "https://<host>" : window.location.origin}/api/mcp`;
	return (
		<div className="min-w-0 space-y-2 text-sm">
			<div className="font-semibold">From Claude or ChatGPT</div>
			<p className="text-muted-foreground">
				Add a custom connector with this URL, then sign in to GavelUp and
				approve it:
			</p>
			<code className="block break-all font-mono text-xs">{mcpUrl}</code>
			<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
				<li>
					<span className="font-semibold text-foreground">Claude:</span>{" "}
					Settings → Connectors → Add custom connector. Works on the web,
					desktop and phone apps.
				</li>
				<li>
					<span className="font-semibold text-foreground">ChatGPT:</span> needs
					a Business or Enterprise workspace, and a workspace admin adds it, on
					the web. Free, Plus and Pro plans can't use GavelUp yet — that's a
					ChatGPT plan limit, not a problem with your account.
				</li>
			</ul>
		</div>
	);
}

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
		<details className="group rounded-xl border bg-card p-4">
			<summary className="flex cursor-pointer items-center gap-2 font-semibold">
				<KeyRound className="size-4 text-primary" aria-hidden />
				Connect an AI assistant
			</summary>
			<div className="mt-3 space-y-3">
				<ConnectorSetup />

				<div className="min-w-0">
					<div className="font-semibold">Personal access tokens</div>
					<p className="mt-1 text-sm text-muted-foreground">
						For Claude Code and other assistants that take a token instead of
						signing in.
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Let an AI assistant read your schedule and feedback on your behalf;
						where you're an admin or officer it can also work on your club's
						meetings. A token acts as you. Treat it like a password.
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
							<p className="font-bold">
								Copy this now — you won't see it again:
							</p>
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
										<span className="font-semibold">
											{t.name ?? "(unnamed)"}
										</span>{" "}
										<span className="text-muted-foreground">
											{t.revokedAt
												? "· revoked"
												: t.lastUsedAt
													? `· last used ${new Date(t.lastUsedAt).toLocaleDateString(APP_LOCALE)}`
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
		</details>
	);
}
