import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import { ingestPathwaysProgress } from "#/server/pathways-sync";
import type { SyncResult } from "#/server/pathways-sync-logic";

export const Route = createFileRoute("/_authed/admin/pathways-sync")({
	beforeLoad: ({ context }) => {
		const adminClub = context.clubs.find((c) => c.clubRole === "admin");
		if (!adminClub) {
			throw redirect({ to: "/" });
		}
		return { adminClub };
	},
	component: PathwaysSync,
});

const textareaClass =
	"flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function PathwaysSync() {
	const { adminClub } = Route.useRouteContext();
	const clubId = adminClub.clubId;

	const [json, setJson] = useState("");
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<SyncResult | null>(null);

	async function onSync() {
		if (!json.trim()) {
			toast.error("Paste the Base Camp progress JSON first.");
			return;
		}
		setBusy(true);
		try {
			const result = await ingestPathwaysProgress({ data: { clubId, json } });
			setResult(result);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Sync failed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Sync Pathways progress
				</h1>
				<p className="text-sm text-muted-foreground">
					Pull the latest Pathways level progress for {adminClub.name} from Base
					Camp Manager.
				</p>
			</div>

			<div className="space-y-2 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4 text-sm">
				<h2 className="text-sm font-bold">How to get the JSON</h2>
				<ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
					<li>
						In Base Camp, open{" "}
						<strong>Base Camp Manager → your club → Paths Progress</strong>.
					</li>
					<li>
						With DevTools' Network tab open, copy the JSON response of each{" "}
						<code>.../api/bcm/progress/?club=…&amp;page=N</code> request.
					</li>
					<li>
						Paste all pages below — either one page's JSON object, or a JSON
						array of multiple pages.
					</li>
				</ol>
				<p className="text-xs text-muted-foreground">
					A browser extension to automate this copy step is planned — for now
					this manual paste keeps it simple.
				</p>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="progress-json">Base Camp progress JSON</Label>
				<textarea
					id="progress-json"
					value={json}
					onChange={(e) => setJson(e.target.value)}
					className={`${textareaClass} min-h-[240px] font-mono text-xs`}
					placeholder='{"...": "..."} or [{"...": "..."}, {"...": "..."}]'
				/>
			</div>

			<Button onClick={onSync} disabled={busy}>
				{busy ? <Loader2 className="size-4 animate-spin" /> : "Sync progress"}
			</Button>

			{result ? (
				<div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
					<p className="text-sm font-bold">
						Matched {result.matched} member-path row
						{result.matched === 1 ? "" : "s"} · {result.pathsUpserted} path
						{result.pathsUpserted === 1 ? "" : "s"} updated
					</p>

					{result.unmatched.length > 0 ? (
						<div className="space-y-2">
							<h3 className="text-sm font-bold">
								Unmatched ({result.unmatched.length})
							</h3>
							<p className="text-xs text-muted-foreground">
								These people aren't on the roster (or their email doesn't
								match). Add them to the roster and re-sync.
							</p>
							<ul className="space-y-1 text-sm">
								{result.unmatched.map((u) => (
									<li
										key={`${u.basecampUserId}-${u.name}`}
										className="flex items-center gap-2"
									>
										<span>{u.name}</span>
										<span className="text-muted-foreground">
											{u.email ?? "—"}
										</span>
									</li>
								))}
							</ul>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Everyone in this sync matched a roster member.
						</p>
					)}
				</div>
			) : null}
		</PageContainer>
	);
}
